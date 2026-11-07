// Tests of DeviceSupervisor with fake devices and a fake notifier (owner:
// device): Lost -> the NULL real-time pacer stands in (silent, the render
// callback and its clocks keep going) -> the CONFIGURED endpoint is reopened
// when it is back (same id, or same label + nameIndex), never another one;
// DefaultChanged followed only when the configuration follows the default;
// FormatChanged reopens; a late Lost from a replaced stream is ignored;
// PeriodStep relayed; a substitute (configured endpoint missing at open) is
// replaced by the configured one when it appears; a failed open keeps the
// previous output; a rate change re-prepares before the device starts.
// Portable, silent (no sound card). SPEC.md §8.4.
#include <algorithm>
#include <atomic>
#include <chrono>
#include <map>
#include <memory>
#include <string>
#include <thread>
#include <vector>

#include "../om_test.h"
#include "om/device.h"

using namespace om;

namespace {

struct FakeDevice;

struct FakeWorld {
  std::vector<DeviceInfo> endpoints;
  std::vector<std::string> opened;  // ids opened, in order
  std::map<std::string, int> rates;
  std::string failOpen;             // open() fails for this id
  bool exclusiveNeedsSole = true;   // like WASAPI: exclusive refused while another stream is open on the endpoint
  FakeDevice* current = nullptr;    // the started device
  std::vector<FakeDevice*> all;

  void add(const std::string& id, const std::string& name, bool isDefault = false) {
    DeviceInfo d;
    d.id = id;
    d.name = name;
    d.isDefault = isDefault;
    d.channels = 2;
    d.sampleRate = 48000;
    endpoints.push_back(d);
    renumber();
  }
  void remove(const std::string& id) {
    endpoints.erase(std::remove_if(endpoints.begin(), endpoints.end(), [&](const DeviceInfo& d) { return d.id == id; }),
                    endpoints.end());
    renumber();
  }
  void setDefault(const std::string& id) {
    for (auto& d : endpoints) d.isDefault = d.id == id;
  }
  void renumber() {
    std::map<std::string, int> seen;
    for (auto& d : endpoints) d.nameIndex = seen[d.name]++;
  }
  const DeviceInfo* find(const std::string& id) const {
    for (const auto& d : endpoints)
      if (d.id == id) return &d;
    return nullptr;
  }
};

struct FakeDevice final : AudioDevice {
  FakeWorld& w;
  std::string id, name;
  IRenderCallback* cb = nullptr;
  bool isOpen = false, running = false;
  DeviceEventFn fn;
  OutputMode mode = OutputMode::Shared;
  int serial;  // a new device may reuse a freed one's address: compare serials, not pointers
  explicit FakeDevice(FakeWorld& world) : w(world) {
    static int next = 0;
    serial = ++next;
    w.all.push_back(this);
  }
  ~FakeDevice() override {
    if (w.current == this) w.current = nullptr;
    w.all.erase(std::remove(w.all.begin(), w.all.end(), this), w.all.end());
  }
  bool open(const DeviceConfig& cfg, IRenderCallback* c, std::string* err) override {
    const DeviceInfo* d = w.find(cfg.id);
    if (!d || cfg.id == w.failOpen) {
      if (err) *err = "fake: cannot open " + cfg.id;
      return false;
    }
    if (cfg.mode == OutputMode::Exclusive && w.exclusiveNeedsSole) {
      for (FakeDevice* o : w.all)
        if (o != this && o->isOpen && o->id == cfg.id) {
          if (err) *err = "fake: AUDCLNT_E_DEVICE_IN_USE";
          return false;
        }
    }
    mode = cfg.mode;
    id = cfg.id;
    name = d->name;
    cb = c;
    isOpen = true;
    w.opened.push_back(id);
    return true;
  }
  bool start(std::string*) override {
    running = true;
    w.current = this;
    return true;
  }
  void stop() override {
    running = false;
    if (w.current == this) w.current = nullptr;
  }
  void close() override {
    stop();
    isOpen = false;
  }
  DeviceStatus status() const override {
    DeviceStatus s;
    s.mode = !isOpen ? DeviceMode::Closed : (mode == OutputMode::Exclusive ? DeviceMode::Exclusive : DeviceMode::Shared);
    s.id = id;
    s.name = name;
    auto it = w.rates.find(id);
    s.sampleRate = it != w.rates.end() ? it->second : 48000;
    s.channels = 2;
    s.periodFrames = 480;
    s.bufferFrames = 960;
    s.outputLatencyMs = 20.0;
    s.running = running;
    return s;
  }
  void setEventHandler(DeviceEventFn f) override { fn = std::move(f); }
  void emit(DeviceEvent e, int period = 0) {
    DeviceEventInfo ev;
    ev.event = e;
    ev.id = id;
    ev.periodFrames = period;
    if (fn) fn(ev);
  }
};

struct FakeWatcher final : DeviceWatcher {};

// The render callback: counts calls and checks the clocks stay monotonic.
struct Probe final : IRenderCallback {
  std::atomic<uint64_t> calls{0};
  std::atomic<int64_t> frames{0};
  std::atomic<bool> nonMonotonic{false};
  std::atomic<bool> loud{false};
  double lastPresent = -1;
  void render(float* out, int n, int ch, const BlockClock& clk) noexcept override {
    for (int i = 0; i < n * ch; i++) {
      if (out[i] != 0.0f) loud = true;  // devices hand out silence
      out[i] = 0.0f;
    }
    if (lastPresent >= 0 && clk.presentTime <= lastPresent) nonMonotonic = true;
    lastPresent = clk.presentTime;
    frames += n;
    calls++;
  }
};

struct Rig {
  FakeWorld w;
  Probe probe;
  DeviceEventFn notifier;  // the fake IMMNotificationClient
  std::vector<DeviceChange> changes;
  std::vector<std::pair<int, int>> prepares;
  std::unique_ptr<DeviceSupervisor> sup;
  Rig() {
    SupervisorOptions o;
    o.manual = true;
    o.retrySec = 0;
    o.makeDevice = [this] { return std::make_unique<FakeDevice>(w); };
    o.enumerate = [this](std::string*) { return w.endpoints; };
    o.makeWatcher = [this](DeviceEventFn fn) {
      notifier = std::move(fn);
      return std::make_unique<FakeWatcher>();
    };
    sup = std::make_unique<DeviceSupervisor>(&probe, o);
    sup->setChangeHandler([this](DeviceChange c, const DeviceStatus&) { changes.push_back(c); });
    sup->setPrepareHandler([this](int rate, int ch) { prepares.emplace_back(rate, ch); });
  }
  void notify(DeviceEvent e, const std::string& id, uint32_t state = 0, DeviceRole role = DeviceRole::Console) {
    DeviceEventInfo ev;
    ev.event = e;
    ev.id = id;
    ev.state = state;
    ev.role = role;
    notifier(ev);
  }
  bool has(DeviceChange c) const { return std::find(changes.begin(), changes.end(), c) != changes.end(); }
};

void sleepMs(int ms) { std::this_thread::sleep_for(std::chrono::milliseconds(ms)); }

}  // namespace

OM_TEST(supervisor_lost_null_pacer_then_configured_endpoint_restored) {
  Rig r;
  r.w.add("{realtek}", "Speakers (Realtek(R) Audio)", true);
  r.w.add("{flx6}", "Master (DDJ-FLX6)");
  DeviceConfig cfg;
  cfg.name = "Master (DDJ-FLX6)";
  cfg.mode = OutputMode::SharedLowLatency;
  std::string err;
  OM_CHECK(r.sup->open(cfg, &err));
  OM_CHECK(r.notifier != nullptr);  // the endpoint watcher is up
  DeviceStatus st = r.sup->status();
  OM_CHECK(st.id == "{flx6}" && st.mode == DeviceMode::Shared && !st.lost);
  OM_CHECK(r.prepares.size() == 1 && r.prepares[0].first == 48000);

  // USB glitch: the stream is invalidated and the endpoint disappears.
  FakeDevice* flx = r.w.current;
  OM_CHECK(flx != nullptr);
  r.w.remove("{flx6}");
  flx->emit(DeviceEvent::Lost);
  r.notify(DeviceEvent::StateChanged, "{flx6}", kDeviceStateNotPresent);
  r.sup->handlePending();
  st = r.sup->status();
  OM_CHECK(st.lost && st.mode == DeviceMode::Null && st.running);
  OM_CHECK(st.name == "Master (DDJ-FLX6)");  // still the configured endpoint, waited for
  OM_CHECK(r.has(DeviceChange::Lost));
  // The NULL pacer keeps the transport running (silent, monotonic clocks).
  const uint64_t before = r.probe.calls.load();
  sleepMs(150);
  const uint64_t during = r.probe.calls.load();
  OM_CHECK(during >= before + 10);  // 480-frame blocks at 48 kHz: ~15 in 150 ms
  OM_CHECK(!r.probe.nonMonotonic.load());

  // Another endpoint appears: the master never moves to it.
  r.w.add("{headset}", "Headset (USB Audio)");
  r.notify(DeviceEvent::Added, "{headset}");
  r.sup->handlePending();
  OM_CHECK(r.sup->status().lost);
  OM_CHECK(std::find(r.w.opened.begin(), r.w.opened.end(), "{headset}") == r.w.opened.end());

  // The FLX6 comes back on another USB port (new id, same label): reopened.
  r.w.add("{flx6-port2}", "Master (DDJ-FLX6)");
  r.notify(DeviceEvent::Added, "{flx6-port2}");
  r.sup->handlePending();
  st = r.sup->status();
  OM_CHECK(!st.lost && st.id == "{flx6-port2}" && st.mode == DeviceMode::Shared);
  OM_CHECK(r.has(DeviceChange::Restored));
  OM_CHECK(r.w.current && r.w.current->id == "{flx6-port2}");
  // The stand-in stopped: no other thread renders any more.
  const uint64_t after = r.probe.calls.load();
  sleepMs(40);
  OM_CHECK(r.probe.calls.load() == after);
  OM_CHECK(!r.probe.loud.load());
}

OM_TEST(supervisor_retries_while_the_endpoint_is_present) {
  // Invalidated without being removed (format change, another app took it
  // exclusively): the NULL pacer runs and the same endpoint is retried.
  Rig r;
  r.w.add("{a}", "Speakers (Realtek(R) Audio)", true);
  DeviceConfig cfg;
  std::string err;
  OM_CHECK(r.sup->open(cfg, &err));
  r.w.failOpen = "{a}";  // still refused (in use)
  r.w.current->emit(DeviceEvent::Lost);
  r.sup->handlePending();  // Lost, then a retry that fails
  OM_CHECK(r.sup->status().lost && r.has(DeviceChange::Failed));
  r.w.failOpen.clear();
  r.sup->handlePending();  // retry: back
  OM_CHECK(!r.sup->status().lost && r.has(DeviceChange::Restored) && r.w.current && r.w.current->id == "{a}");
}

OM_TEST(supervisor_default_changed_only_when_following_the_default) {
  Rig r;
  r.w.add("{a}", "Speakers (Realtek(R) Audio)", true);
  r.w.add("{b}", "Master (DDJ-FLX6)");
  // The user picked a device by name: a new default does not move it.
  DeviceConfig named;
  named.name = "Speakers (Realtek(R) Audio)";
  std::string err;
  OM_CHECK(r.sup->open(named, &err) && r.sup->status().id == "{a}");
  r.w.setDefault("{b}");
  r.notify(DeviceEvent::DefaultChanged, "{b}", 0, DeviceRole::Console);
  r.sup->handlePending();
  OM_CHECK(r.sup->status().id == "{a}" && !r.has(DeviceChange::DefaultChanged));
  // The user picked "Default": followed.
  DeviceConfig def;
  def.followDefault = true;
  OM_CHECK(r.sup->open(def, &err) && r.sup->status().id == "{b}");
  r.w.setDefault("{a}");
  r.notify(DeviceEvent::DefaultChanged, "{a}", 0, DeviceRole::Communications);  // another role: ignored
  r.sup->handlePending();
  OM_CHECK(r.sup->status().id == "{b}");
  r.notify(DeviceEvent::DefaultChanged, "{a}", 0, DeviceRole::Console);
  r.sup->handlePending();
  OM_CHECK(r.sup->status().id == "{a}" && r.has(DeviceChange::DefaultChanged));
  // A default that cannot be opened: the current device keeps playing.
  r.w.setDefault("{b}");
  r.w.failOpen = "{b}";
  r.notify(DeviceEvent::DefaultChanged, "{b}", 0, DeviceRole::Console);
  r.sup->handlePending();
  OM_CHECK(r.sup->status().id == "{a}" && r.w.current && r.w.current->id == "{a}" && r.has(DeviceChange::Failed));
}

OM_TEST(supervisor_format_change_reopens_and_ignores_the_late_lost) {
  Rig r;
  r.w.add("{a}", "Speakers (Realtek(R) Audio)", true);
  std::string err;
  OM_CHECK(r.sup->open(DeviceConfig(), &err));
  const int oldSerial = r.w.current->serial;
  const DeviceEventFn oldHandler = r.w.current->fn;  // what the old stream would post with
  r.w.rates["{a}"] = 44100;  // the user changed the format in Sound settings
  r.notify(DeviceEvent::FormatChanged, "{a}");
  r.sup->handlePending();
  OM_CHECK(r.has(DeviceChange::Reopened) && r.sup->status().sampleRate == 44100);
  OM_CHECK(r.prepares.size() == 2 && r.prepares[1].first == 44100);  // re-prepared before the restart
  OM_CHECK(r.w.current != nullptr && r.w.current->serial != oldSerial);
  // The replaced stream reports its invalidation late: its generation is
  // over, the new stream keeps playing.
  DeviceEventInfo late;
  late.event = DeviceEvent::Lost;
  late.id = "{a}";
  oldHandler(late);
  const size_t n = r.changes.size();
  OM_CHECK(r.sup->handlePending() == 1);
  OM_CHECK(r.changes.size() == n && !r.sup->status().lost && r.w.current != nullptr);
  // The same event from the current stream is a real loss (the endpoint
  // refuses to reopen for now, so the stand-in stays).
  r.w.failOpen = "{a}";
  r.w.current->emit(DeviceEvent::Lost);
  r.sup->handlePending();
  OM_CHECK(r.sup->status().lost && r.has(DeviceChange::Lost));
}

OM_TEST(supervisor_relays_period_steps) {
  Rig r;
  r.w.add("{a}", "Speakers (Realtek(R) Audio)", true);
  std::string err;
  DeviceConfig cfg;
  cfg.mode = OutputMode::SharedLowLatency;
  OM_CHECK(r.sup->open(cfg, &err));
  r.w.current->emit(DeviceEvent::PeriodStep, 288);
  r.sup->handlePending();
  OM_CHECK(r.has(DeviceChange::PeriodStep) && !r.sup->status().lost);
}

OM_TEST(supervisor_substitute_replaced_by_the_configured_endpoint) {
  Rig r;
  r.w.add("{a}", "Speakers (Realtek(R) Audio)", true);
  DeviceConfig cfg;
  cfg.name = "Master (DDJ-FLX6)";  // not plugged in at startup
  std::string err;
  OM_CHECK(r.sup->open(cfg, &err) && r.sup->status().id == "{a}");  // the role's default meanwhile
  r.w.add("{flx6}", "Master (DDJ-FLX6)");
  r.notify(DeviceEvent::Added, "{flx6}");
  r.sup->handlePending();
  OM_CHECK(r.sup->status().id == "{flx6}" && r.has(DeviceChange::Restored));
  // From now on the FLX6 is the configured endpoint: its loss is waited for.
  r.w.remove("{flx6}");
  r.notify(DeviceEvent::StateChanged, "{flx6}", kDeviceStateNotPresent);
  r.sup->handlePending();
  OM_CHECK(r.sup->status().lost && r.sup->status().mode == DeviceMode::Null);
}

OM_TEST(supervisor_failed_open_keeps_the_previous_output) {
  Rig r;
  r.w.add("{a}", "Speakers (Realtek(R) Audio)", true);
  NullDeviceConfig nc;
  nc.realtime = true;
  nc.channels = 2;
  std::string err;
  OM_CHECK(r.sup->openNull(nc, &err));
  OM_CHECK(r.sup->status().mode == DeviceMode::Null);
  r.w.failOpen = "{a}";
  OM_CHECK(!r.sup->open(DeviceConfig(), &err) && !err.empty());
  OM_CHECK(r.sup->status().mode == DeviceMode::Null && r.sup->status().running && !r.sup->lost());
  const uint64_t c0 = r.probe.calls.load();
  sleepMs(60);
  OM_CHECK(r.probe.calls.load() > c0);  // the NULL output still renders
  r.sup->close();
  OM_CHECK(r.sup->status().mode == DeviceMode::Closed);
}

OM_TEST(supervisor_restore_at_another_rate_prepares_first) {
  Rig r;
  r.w.add("{a}", "Speakers (Realtek(R) Audio)", true);
  std::string err;
  OM_CHECK(r.sup->open(DeviceConfig(), &err));
  r.w.remove("{a}");
  r.notify(DeviceEvent::StateChanged, "{a}", kDeviceStateNotPresent);
  r.sup->handlePending();
  OM_CHECK(r.sup->status().lost && r.sup->status().sampleRate == 48000);  // the stand-in keeps the rate
  r.w.add("{a}", "Speakers (Realtek(R) Audio)", true);
  r.w.rates["{a}"] = 96000;
  r.notify(DeviceEvent::StateChanged, "{a}", kDeviceStateActive);
  r.sup->handlePending();
  OM_CHECK(!r.sup->status().lost && r.sup->status().sampleRate == 96000);
  OM_CHECK(r.prepares.back().first == 96000);
}

OM_TEST(supervisor_mode_change_on_the_same_endpoint_closes_first) {
  Rig r;
  r.w.add("{flx6}", "Master (DDJ-FLX6)", true);
  DeviceConfig cfg;
  cfg.name = "Master (DDJ-FLX6)";
  std::string err;
  OM_CHECK(r.sup->open(cfg, &err) && r.sup->status().mode == DeviceMode::Shared);
  // Shared -> exclusive on the same endpoint: our own shared stream must be
  // closed first, or the exclusive Initialize is refused (DEVICE_IN_USE).
  cfg.mode = OutputMode::Exclusive;
  OM_CHECK(r.sup->open(cfg, &err));
  OM_CHECK(r.sup->status().mode == DeviceMode::Exclusive && r.sup->status().id == "{flx6}");
  // A reopen that fails after the old stream was closed: the previous
  // configuration is kept (stand-in, then retried) instead of going silent.
  DeviceConfig bad = cfg;
  r.w.failOpen = "{flx6}";
  OM_CHECK(!r.sup->open(bad, &err));
  OM_CHECK(r.sup->status().lost && r.sup->status().mode == DeviceMode::Null);
  r.w.failOpen.clear();
  r.sup->handlePending();  // the retry
  OM_CHECK(!r.sup->status().lost && r.sup->status().mode == DeviceMode::Exclusive);
}
