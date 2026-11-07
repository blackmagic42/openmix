// DeviceSupervisor (owner: device): the output the core renders into. Opens
// the configured endpoint (resolution rules, mode fallbacks done by the
// backend), and keeps it: on Lost the NULL device's real-time pacer stands
// in at the same rate (silent; transport, sample clock and recording keep
// going), the SAME endpoint (id, or label + nameIndex) is reopened when it
// is back (Added / StateChanged active / periodic retry); DefaultChanged is
// followed only when the configuration follows the default; FormatChanged
// of the open endpoint reopens it (a rate change re-prepares the modules
// first); PeriodStep is relayed. Only one device renders at a time. Events
// carry the generation of the device that sent them, so a late Lost from a
// stream that was already replaced is ignored. Portable: the system device,
// the enumeration and the notifications come through SupervisorOptions
// (fakes in the tests). SPEC.md §8.2, §8.4.
#include <algorithm>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <deque>
#include <mutex>
#include <thread>

#include "endpoints.h"
#include "om/device.h"

namespace om {

namespace {
struct Note {
  DeviceChange change;
  DeviceStatus status;
};
}  // namespace

struct DeviceSupervisor::Impl {
  IRenderCallback* cb = nullptr;
  SupervisorOptions opt;
  ChangeFn onChange;
  PrepareFn onPrepare;

  // ---- operations (worker / owner threads), guarded by m ----
  std::mutex m;
  std::unique_ptr<AudioDevice> sys;
  std::unique_ptr<NullDevice> nul;
  bool configured = false;     // open(cfg) succeeded: a configuration to keep
  DeviceConfig cfg;
  dev::OpenedEndpoint opened;
  bool isLost = false;
  int preparedRate = 0, preparedChannels = 0;
  DeviceStatus lastSys;        // last status of the system device (for the stand-in)
  EngineTime nextRetry = 0;
  bool failureNoted = false;   // a failed reopen is reported once per loss
  std::unique_ptr<DeviceWatcher> watcher;
  uint64_t gen = 0;            // generation of the current system device

  // ---- status (any thread), guarded by sm ----
  mutable std::mutex sm;
  AudioDevice* statusDev = nullptr;
  std::string statusId, statusName;
  std::atomic<bool> lostFlag{false};

  // ---- events ----
  struct Queued {
    DeviceEventInfo ev;
    uint64_t gen;  // 0 = watcher (always relevant)
  };
  std::mutex qm;
  std::condition_variable qcv;
  std::deque<Queued> q;
  bool quit = false;
  std::thread worker;

  // ------------------------------------------------------------------------
  void post(const DeviceEventInfo& ev, uint64_t fromGen) {
    {
      std::lock_guard<std::mutex> lk(qm);
      q.push_back({ev, fromGen});
    }
    qcv.notify_all();
    if (opt.manual && opt.wake) opt.wake();
  }

  void setStatusDev(AudioDevice* d) {
    std::lock_guard<std::mutex> lk(sm);
    statusDev = d;
    statusId = opened.id;
    statusName = opened.name;
  }

  DeviceStatus statusLocked() const {  // under m (or sm free): a consistent snapshot
    std::lock_guard<std::mutex> lk(sm);
    DeviceStatus s;
    if (statusDev) s = statusDev->status();
    if (lostFlag.load()) {
      s.lost = true;
      s.id = statusId;
      s.name = statusName;
      if (!statusDev) s.mode = DeviceMode::Closed;
    }
    return s;
  }

  void stopActive() {
    setStatusDev(nullptr);
    if (sys) {
      sys->stop();
      sys->close();
      sys.reset();
    }
    if (nul) {
      nul->stop();
      nul->close();
      nul.reset();
    }
  }

  void prepareIfNeeded(int rate, int channels) {
    if (rate <= 0 || channels <= 0) return;
    if (rate == preparedRate && channels == preparedChannels) return;
    preparedRate = rate;
    preparedChannels = channels;
    if (onPrepare) onPrepare(rate, channels);
  }

  std::unique_ptr<AudioDevice> makeDevice() {
    std::unique_ptr<AudioDevice> d = opt.makeDevice ? opt.makeDevice() : createSystemDevice();
    if (d) {
      const uint64_t g = ++gen;
      d->setEventHandler([this, g](const DeviceEventInfo& ev) { post(ev, g); });
    }
    return d;
  }

  std::vector<DeviceInfo> enumerate(std::string* err) {
    return opt.enumerate ? opt.enumerate(err) : enumerateOutputDevices(err);
  }

  void ensureWatcher() {
    if (watcher) return;
    auto fn = [this](const DeviceEventInfo& ev) { post(ev, 0); };
    if (opt.makeWatcher) {
      watcher = opt.makeWatcher(fn);
    } else {
      std::string e;
      watcher = createDeviceWatcher(fn, &e);
    }
  }

  // Starts the NULL stand-in at the lost device's rate / channels / period.
  void startStandIn() {
    if (!opt.standIn) return;
    NullDeviceConfig nc;
    nc.sampleRate = lastSys.sampleRate > 0 ? lastSys.sampleRate : (preparedRate > 0 ? preparedRate : 48000);
    nc.channels = lastSys.channels > 0 ? lastSys.channels : (preparedChannels > 0 ? preparedChannels : 2);
    nc.channels = std::min(nc.channels, kMaxOutputChannels);
    nc.blockFrames = lastSys.periodFrames > 0 ? std::clamp(lastSys.periodFrames, 32, kMaxBlockFrames) : 256;
    nc.latencyFrames = static_cast<int>(std::lround(lastSys.outputLatencyMs * nc.sampleRate / 1000.0));
    nc.realtime = true;
    auto n = std::make_unique<NullDevice>(nc);
    std::string e;
    if (!n->open(DeviceConfig(), cb, &e)) return;
    prepareIfNeeded(nc.sampleRate, nc.channels);
    if (!n->start(&e)) return;
    nul = std::move(n);
    setStatusDev(nul.get());
  }

  // Opens `c` (resolved to an endpoint id) WITHOUT starting it.
  std::unique_ptr<AudioDevice> openResolved(const DeviceConfig& c, const std::vector<DeviceInfo>& list, const std::string& id,
                                            dev::OpenedEndpoint* ep, std::string* err) {
    std::unique_ptr<AudioDevice> d = makeDevice();
    if (!d) {
      if (err) *err = "no audio backend in this build";
      return nullptr;
    }
    DeviceConfig dc = c;
    dc.id = id;
    if (!d->open(dc, cb, err)) return nullptr;
    if (ep) {
      ep->id = id;
      const DeviceInfo* info = dev::findEndpoint(list, id);
      ep->name = info ? info->name : d->status().name;
      ep->nameIndex = info ? info->nameIndex : 0;
    }
    return d;
  }

  // Makes `d` the output: the current one stops first, then prepare, start.
  bool switchTo(std::unique_ptr<AudioDevice> d, std::string* err) {
    const DeviceStatus ns = d->status();
    stopActive();
    prepareIfNeeded(ns.sampleRate, ns.channels);
    if (!d->start(err)) {
      d->close();
      return false;
    }
    lastSys = d->status();
    sys = std::move(d);
    setStatusDev(sys.get());
    return true;
  }

  void goLost(std::vector<Note>& notes) {
    if (sys) {
      const DeviceStatus st = sys->status();
      if (st.sampleRate > 0) lastSys = st;
    }
    isLost = true;
    lostFlag = true;
    failureNoted = false;
    stopActive();
    startStandIn();
    nextRetry = EngineClock::now() + std::min(0.2, opt.retrySec);  // a quick first retry (format change, exclusive grab)
    notes.push_back({DeviceChange::Lost, statusLocked()});
  }

  // Reopens the configured endpoint if it is present.
  void tryRestore(std::vector<Note>& notes) {
    if (!configured) return;
    std::string err;
    const std::vector<DeviceInfo> list = enumerate(&err);
    const std::string target = dev::matchConfiguredEndpoint(cfg, opened, list);
    if (target.empty()) return;
    if (!isLost && target == opened.id) return;  // already there
    dev::OpenedEndpoint ep;
    std::unique_ptr<AudioDevice> d = openResolved(cfg, list, target, &ep, &err);
    if (!d || !switchTo(std::move(d), &err)) {
      if (!sys && !nul) startStandIn();
      if (!failureNoted) notes.push_back({DeviceChange::Failed, statusLocked()});
      failureNoted = true;
      return;
    }
    // The configured endpoint itself (not a substitute) when it matches the configuration.
    dev::ResolveRule rule = dev::ResolveRule::None;
    const std::string want = dev::resolveOutputDeviceRule(cfg, list, &rule);
    ep.substitute = opened.substitute && !(want == target && rule != dev::ResolveRule::RoleDefault);
    opened = ep;
    isLost = false;
    lostFlag = false;
    setStatusDev(sys.get());
    notes.push_back({DeviceChange::Restored, statusLocked()});
  }

  bool openConfigured(const DeviceConfig& c, std::string* err, std::vector<Note>& notes, DeviceChange kind) {
    std::string e;
    const std::vector<DeviceInfo> list = enumerate(&e);
    DeviceConfig rc = c;
    if (c.followDefault) {  // "Default": only the role decides
      rc.id.clear();
      rc.name.clear();
    }
    dev::ResolveRule rule = dev::ResolveRule::None;
    const std::string id = dev::resolveOutputDeviceRule(rc, list, &rule);
    if (id.empty()) {
      if (err) *err = e.empty() ? "no output device" : e;
      return false;
    }
    if (sys && id == opened.id) {
      // Same endpoint (a mode or period change): WASAPI refuses an exclusive
      // stream while ours is still open on it, so close ours first.
      lastSys = sys->status();
      stopActive();
    }
    dev::OpenedEndpoint ep;
    std::unique_ptr<AudioDevice> d = openResolved(c, list, id, &ep, err);
    if (!d) return false;
    ep.substitute = !c.followDefault && rule == dev::ResolveRule::RoleDefault && (!c.id.empty() || !c.name.empty());
    if (!switchTo(std::move(d), err)) return false;
    cfg = c;
    configured = true;
    opened = ep;
    isLost = false;
    lostFlag = false;
    setStatusDev(sys.get());
    notes.push_back({kind, statusLocked()});
    return true;
  }

  void handleEvent(const Queued& qe, std::vector<Note>& notes) {
    const DeviceEventInfo& ev = qe.ev;
    const bool fromCurrent = qe.gen == 0 || qe.gen == gen;
    switch (ev.event) {
      case DeviceEvent::Lost:
        if (fromCurrent && sys && !isLost && (ev.id.empty() || ev.id == opened.id)) goLost(notes);
        break;
      case DeviceEvent::StateChanged:
        if (sys && !isLost && ev.id == opened.id && !(ev.state & kDeviceStateActive)) {
          goLost(notes);
        } else if ((ev.state & kDeviceStateActive) && (isLost || opened.substitute)) {
          tryRestore(notes);
        }
        break;
      case DeviceEvent::Added:
        if (isLost || opened.substitute) tryRestore(notes);
        break;
      case DeviceEvent::DefaultChanged:
        if (!configured || !cfg.followDefault || ev.role != cfg.role) break;  // the engine never moves by itself
        if (isLost) {
          tryRestore(notes);
        } else if (ev.id != opened.id) {
          // Open the new default first; on failure the current device keeps playing.
          std::string err;
          std::vector<Note> tmp;
          const DeviceConfig keep = cfg;
          if (!openConfigured(keep, &err, tmp, DeviceChange::DefaultChanged)) {
            if (!sys && !nul) {
              goLost(notes);  // the old device was stopped before the new one failed to start
            } else {
              notes.push_back({DeviceChange::Failed, statusLocked()});
            }
          } else {
            notes.insert(notes.end(), tmp.begin(), tmp.end());
          }
        }
        break;
      case DeviceEvent::FormatChanged:
        if (sys && !isLost && ev.id == opened.id) {
          // The stream is (or will be) invalidated: reopen the same configuration.
          if (sys) lastSys = sys->status();
          stopActive();
          std::string err;
          std::vector<Note> tmp;
          if (openConfigured(cfg, &err, tmp, DeviceChange::Reopened)) {
            notes.insert(notes.end(), tmp.begin(), tmp.end());
          } else {
            goLost(notes);
          }
        }
        break;
      case DeviceEvent::PeriodStep:
        if (fromCurrent && sys && !isLost) {
          lastSys = sys->status();
          notes.push_back({DeviceChange::PeriodStep, statusLocked()});
        }
        break;
    }
  }

  int processQueue(std::vector<Note>& notes) {
    int handled = 0;
    for (;;) {
      Queued qe;
      {
        std::lock_guard<std::mutex> lk(qm);
        if (q.empty()) break;
        qe = q.front();
        q.pop_front();
      }
      handleEvent(qe, notes);
      handled++;
    }
    if (isLost && configured && EngineClock::now() >= nextRetry) {
      tryRestore(notes);
      nextRetry = EngineClock::now() + opt.retrySec;
    }
    return handled;
  }

  void deliver(std::vector<Note>& notes) {
    if (!onChange) return;
    for (const Note& n : notes) onChange(n.change, n.status);
  }

  int handlePendingNow() {
    std::vector<Note> notes;
    int handled;
    {
      std::lock_guard<std::mutex> lk(m);
      handled = processQueue(notes);
    }
    deliver(notes);
    return handled;
  }

  void workerLoop() {
    for (;;) {
      {
        std::unique_lock<std::mutex> lk(qm);
        qcv.wait_for(lk, std::chrono::milliseconds(100), [&] { return quit || !q.empty(); });
        if (quit) return;
      }
      handlePendingNow();
    }
  }
};

DeviceSupervisor::DeviceSupervisor(IRenderCallback* cb, SupervisorOptions opt) : impl_(std::make_unique<Impl>()) {
  impl_->cb = cb;
  impl_->opt = std::move(opt);
  if (impl_->opt.retrySec < 0) impl_->opt.retrySec = 0;
  if (!impl_->opt.manual) impl_->worker = std::thread([this] { impl_->workerLoop(); });
}

DeviceSupervisor::~DeviceSupervisor() {
  {
    std::lock_guard<std::mutex> lk(impl_->qm);
    impl_->quit = true;
  }
  impl_->qcv.notify_all();
  if (impl_->worker.joinable()) impl_->worker.join();
  {
    std::lock_guard<std::mutex> lk(impl_->m);
    impl_->stopActive();
    impl_->watcher.reset();
  }
}

void DeviceSupervisor::setChangeHandler(ChangeFn fn) {
  std::lock_guard<std::mutex> lk(impl_->m);
  impl_->onChange = std::move(fn);
}

void DeviceSupervisor::setPrepareHandler(PrepareFn fn) {
  std::lock_guard<std::mutex> lk(impl_->m);
  impl_->onPrepare = std::move(fn);
}

bool DeviceSupervisor::openNull(const NullDeviceConfig& nc, std::string* err) {
  std::vector<Note> notes;
  {
    std::lock_guard<std::mutex> lk(impl_->m);
    Impl& m = *impl_;
    auto n = std::make_unique<NullDevice>(nc);
    if (!n->open(DeviceConfig(), m.cb, err)) return false;
    m.stopActive();
    m.prepareIfNeeded(nc.sampleRate, nc.channels);
    if (!n->start(err)) return false;
    m.nul = std::move(n);
    m.configured = false;
    m.isLost = false;
    m.lostFlag = false;
    m.opened = dev::OpenedEndpoint();
    m.setStatusDev(m.nul.get());
    notes.push_back({DeviceChange::Opened, m.statusLocked()});
  }
  impl_->deliver(notes);
  return true;
}

bool DeviceSupervisor::open(const DeviceConfig& cfg, std::string* err) {
  std::vector<Note> notes;
  bool ok;
  {
    std::lock_guard<std::mutex> lk(impl_->m);
    impl_->ensureWatcher();
    ok = impl_->openConfigured(cfg, err, notes, DeviceChange::Opened);
    if (!ok && !impl_->sys && !impl_->nul && impl_->preparedRate > 0) {
      // The previous output was already stopped (the new one failed to
      // start): keep the transport running on the NULL device, and get the
      // previous configuration back when it can be reopened.
      if (impl_->configured) {
        impl_->goLost(notes);
      } else {
        impl_->lastSys = DeviceStatus();
        impl_->startStandIn();
      }
    }
  }
  impl_->deliver(notes);
  return ok;
}

bool DeviceSupervisor::restart(std::string* err) {
  std::vector<Note> notes;
  bool ok = true;
  {
    std::lock_guard<std::mutex> lk(impl_->m);
    Impl& m = *impl_;
    if (!m.configured) {
      if (m.nul) {  // the NULL output: restart its pacer
        m.nul->stop();
        ok = m.nul->start(err);
      }
    } else {
      if (m.sys) m.lastSys = m.sys->status();
      m.stopActive();
      ok = m.openConfigured(m.cfg, err, notes, DeviceChange::Reopened);
      if (!ok) m.goLost(notes);
    }
  }
  impl_->deliver(notes);
  return ok;
}

void DeviceSupervisor::close() {
  std::lock_guard<std::mutex> lk(impl_->m);
  impl_->stopActive();
  impl_->configured = false;
  impl_->isLost = false;
  impl_->lostFlag = false;
  impl_->opened = dev::OpenedEndpoint();
  impl_->watcher.reset();
}

void DeviceSupervisor::post(const DeviceEventInfo& ev) { impl_->post(ev, 0); }

int DeviceSupervisor::handlePending() { return impl_->handlePendingNow(); }

DeviceStatus DeviceSupervisor::status() const { return impl_->statusLocked(); }

bool DeviceSupervisor::lost() const noexcept { return impl_->lostFlag.load(); }

DeviceConfig DeviceSupervisor::config() const {
  std::lock_guard<std::mutex> lk(impl_->m);
  return impl_->cfg;
}

}  // namespace om
