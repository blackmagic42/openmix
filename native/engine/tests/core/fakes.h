// Fakes of the core's backend seams for the core tests (owner: host): a
// scriptable endpoint list, output devices that render on demand (manual
// mode) or on their own thread (threaded tests, can freeze to simulate a
// stalled driver), a headphones output, a recorder and a VST host that
// record what the core asks and can raise the events the real modules
// raise. Silent by construction: nothing touches a sound card, the disk or
// a plugin. SPEC.md §8, §13, §14, §18.3.
#pragma once

#include <atomic>
#include <chrono>
#include <cmath>
#include <cstring>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "om/common.h"
#include "om/device.h"
#include "om/engine.h"
#include "om/protocol.h"

namespace omtest {

class FakeOutput;

// Shared state between a test and its fakes.
struct FakeWorld {
  std::mutex m;
  std::vector<om::DeviceInfo> devices;
  std::vector<FakeOutput*> outputs;  // alive fake outputs (creation order)
  std::vector<om::DeviceConfig> opened;  // every successful open (config as received)
  int enumerations = 0;
  bool refuseExclusive = false;      // exclusive opens fall back to shared ("in-use")
  std::atomic<int> failOpens{0};     // the next N opens fail ("busy")
  bool threaded = false;             // new outputs render on their own thread
  std::atomic<bool> freezeNew{false};  // new outputs start frozen (stalled driver)
  std::atomic<int> created{0};

  static om::DeviceInfo info(const char* id, const char* name, int nameIndex, int ch, int rate, bool def = false,
                             bool comms = false) {
    om::DeviceInfo d;
    d.id = id;
    d.name = name;
    d.nameIndex = nameIndex;
    d.channels = ch;
    d.sampleRate = rate;
    d.isDefault = def;
    d.isDefaultComms = comms;
    d.sharedFundamentalFrames = 128;
    d.sharedMinPeriodFrames = 128;
    d.sharedDefaultPeriodFrames = 480;
    return d;
  }
  bool find(const std::string& id, om::DeviceInfo& out) {
    std::lock_guard<std::mutex> lk(m);
    for (const auto& d : devices)
      if (d.id == id) {
        out = d;
        return true;
      }
    return false;
  }
  void remove(const std::string& id) {
    std::lock_guard<std::mutex> lk(m);
    for (size_t i = 0; i < devices.size(); i++)
      if (devices[i].id == id) {
        devices.erase(devices.begin() + static_cast<std::ptrdiff_t>(i));
        return;
      }
  }
  void add(const om::DeviceInfo& d) {
    std::lock_guard<std::mutex> lk(m);
    devices.push_back(d);
  }
  void setDefault(const std::string& id) {
    std::lock_guard<std::mutex> lk(m);
    for (auto& d : devices) d.isDefault = d.id == id;
  }
  // The process-wide watcher installed by the engine (fire endpoint notifications).
  om::DeviceEventFn watcherFn;
  int watchers = 0;
  void notify(const om::DeviceEventInfo& ev) {
    om::DeviceEventFn fn;
    {
      std::lock_guard<std::mutex> lk(m);
      fn = watcherFn;
    }
    if (fn) fn(ev);
  }
  FakeOutput* current() {
    std::lock_guard<std::mutex> lk(m);
    return outputs.empty() ? nullptr : outputs.back();
  }
  size_t openedCount() {
    std::lock_guard<std::mutex> lk(m);
    return opened.size();
  }
  om::DeviceConfig lastOpened() {
    std::lock_guard<std::mutex> lk(m);
    return opened.empty() ? om::DeviceConfig() : opened.back();
  }
};

class FakeOutput final : public om::AudioDevice {
 public:
  explicit FakeOutput(FakeWorld* w) : w_(w) {
    std::lock_guard<std::mutex> lk(w_->m);
    w_->outputs.push_back(this);
    freeze_ = w_->freezeNew.load();
    threaded_ = w_->threaded;
    w_->created++;
  }
  ~FakeOutput() override {
    stop();
    std::lock_guard<std::mutex> lk(w_->m);
    for (size_t i = 0; i < w_->outputs.size(); i++)
      if (w_->outputs[i] == this) {
        w_->outputs.erase(w_->outputs.begin() + static_cast<std::ptrdiff_t>(i));
        break;
      }
  }
  bool open(const om::DeviceConfig& cfg, om::IRenderCallback* cb, std::string* err) override {
    om::DeviceInfo info;
    if (!w_->find(cfg.id, info)) {
      if (err) *err = "fake: no endpoint " + cfg.id;
      return false;
    }
    if (w_->failOpens.load() > 0) {
      w_->failOpens--;
      if (err) *err = "fake: busy";
      return false;
    }
    std::lock_guard<std::mutex> lk(m_);
    cfg_ = cfg;
    cb_ = cb;
    st_ = om::DeviceStatus();
    st_.id = info.id;
    st_.name = info.name;
    st_.sampleRate = cfg.mode == om::OutputMode::Exclusive && cfg.sampleRate > 0 ? cfg.sampleRate : info.sampleRate;
    st_.channels = info.channels;
    st_.sampleFormat = "f32";
    switch (cfg.mode) {
      case om::OutputMode::Shared: st_.mode = om::DeviceMode::Shared; break;
      case om::OutputMode::SharedLowLatency: st_.mode = om::DeviceMode::SharedLowLatency; break;
      case om::OutputMode::Exclusive:
        if (w_->refuseExclusive) {
          st_.mode = om::DeviceMode::SharedLowLatency;
          st_.fellBack = true;
          st_.fallbackReason = "in-use";
        } else {
          st_.mode = om::DeviceMode::Exclusive;
        }
        break;
    }
    // the fake period policy: requested period, else 240 (low latency, >= 5 ms at 48 kHz) or 480
    st_.periodFrames = cfg.periodFrames > 0 ? cfg.periodFrames : (st_.mode == om::DeviceMode::Shared ? 480 : 240);
    st_.bufferFrames = st_.periodFrames * 2;
    st_.outputLatencyMs = 1000.0 * st_.bufferFrames / st_.sampleRate;
    st_.raw = cfg.raw;
    {
      std::lock_guard<std::mutex> lw(w_->m);
      w_->opened.push_back(cfg);
    }
    open_ = true;
    return true;
  }
  bool start(std::string* err) override {
    if (!open_) {
      if (err) *err = "fake: not open";
      return false;
    }
    {
      std::lock_guard<std::mutex> lk(m_);
      st_.running = true;
    }
    if (threaded_) {
      run_ = true;
      thread_ = std::thread([this] { loop(); });
    }
    return true;
  }
  void stop() override {
    run_ = false;
    if (thread_.joinable()) thread_.join();
    std::lock_guard<std::mutex> lk(m_);
    st_.running = false;
  }
  void close() override {
    stop();
    open_ = false;
  }
  om::DeviceStatus status() const override {
    std::lock_guard<std::mutex> lk(m_);
    return st_;
  }
  void setEventHandler(om::DeviceEventFn fn) override {
    std::lock_guard<std::mutex> lk(m_);
    handler_ = std::move(fn);
  }

  // ---- test controls ----
  // Renders `blocks` periods synchronously (manual-mode tests).
  int pump(int blocks, std::vector<float>* out = nullptr) {
    int done = 0;
    for (int b = 0; b < blocks; b++) {
      if (!renderOne(out)) break;
      done++;
    }
    return done;
  }
  void fire(const om::DeviceEventInfo& ev) {
    om::DeviceEventFn h;
    {
      std::lock_guard<std::mutex> lk(m_);
      h = handler_;
    }
    if (h) h(ev);
  }
  void setFreeze(bool f) { freeze_ = f; }
  void bumpPeriodSteps() {
    std::lock_guard<std::mutex> lk(m_);
    st_.periodSteps++;
    st_.periodFrames += 240;
  }
  om::DeviceConfig config() const {
    std::lock_guard<std::mutex> lk(m_);
    return cfg_;
  }
  int64_t framesRendered() const { return frame_.load(); }

 private:
  bool renderOne(std::vector<float>* out) {
    om::IRenderCallback* cb;
    int period, ch, rate;
    {
      std::lock_guard<std::mutex> lk(m_);
      if (!st_.running || !cb_) return false;
      cb = cb_;
      period = st_.periodFrames;
      ch = st_.channels;
      rate = st_.sampleRate;
    }
    std::vector<float> local;
    std::vector<float>& buf = out ? *out : local;
    buf.assign(static_cast<size_t>(period) * static_cast<size_t>(ch), 0.0f);
    om::BlockClock clk;
    clk.frame = frame_.load();
    clk.frames = period;
    clk.sampleRate = rate;
    if (threaded_) {
      clk.callbackTime = om::EngineClock::now();
    } else {
      clk.callbackTime = static_cast<double>(clk.frame) / rate;
    }
    clk.presentTime = clk.callbackTime + static_cast<double>(period) * 2 / rate;
    cb->render(buf.data(), period, ch, clk);
    frame_ += period;
    return true;
  }
  void loop() {
    using clock = std::chrono::steady_clock;
    std::vector<float> buf;
    auto next = clock::now();
    while (run_.load()) {
      if (!freeze_.load()) renderOne(&buf);
      int period = 240, rate = 48000;
      {
        std::lock_guard<std::mutex> lk(m_);
        period = st_.periodFrames;
        rate = st_.sampleRate;
      }
      next += std::chrono::microseconds(static_cast<int64_t>(1e6 * period / rate));
      const auto now = clock::now();
      if (now - next > std::chrono::milliseconds(100)) next = now;
      std::this_thread::sleep_until(next);
    }
  }

  FakeWorld* w_;
  mutable std::mutex m_;
  om::DeviceConfig cfg_;
  om::IRenderCallback* cb_ = nullptr;
  om::DeviceStatus st_;
  om::DeviceEventFn handler_;
  bool open_ = false;
  bool threaded_ = false;
  std::atomic<bool> run_{false};
  std::atomic<bool> freeze_{false};
  std::atomic<int64_t> frame_{0};
  std::thread thread_;
};

class FakePhones final : public om::IPhonesOutput {
 public:
  struct Shared {
    std::mutex m;
    om::DeviceConfig cfg;
    int mainRate = 0, mainPeriod = 0, opens = 0;
    std::atomic<bool> active{false};
    std::atomic<int64_t> pushed{0};
    // Stamps of the pushes: in manual mode the block's callbackTime is
    // frame / rate, so a stamp from the core is a whole frame index and
    // grows; EngineClock::now() would not be.
    std::atomic<int> stampRate{0};
    std::atomic<double> lastStamp{-1.0};
    std::atomic<int64_t> stampErrors{0};
    om::DeviceEventFn handler;
  };
  explicit FakePhones(std::shared_ptr<Shared> s) : s_(std::move(s)) {}
  bool open(const om::DeviceConfig& cfg, int mainSampleRate, int mainPeriodFrames, std::string* err) override {
    if (cfg.id.empty()) {
      if (err) *err = "fake phones: no endpoint";
      return false;
    }
    std::lock_guard<std::mutex> lk(s_->m);
    s_->cfg = cfg;
    s_->mainRate = mainSampleRate;
    s_->mainPeriod = mainPeriodFrames;
    s_->stampRate = mainSampleRate;
    s_->opens++;
    s_->active = true;
    return true;
  }
  void close() override { s_->active = false; }
  void push(const float*, const float*, int frames, om::EngineTime t) noexcept override {
    if (!s_->active.load()) return;
    s_->pushed += frames;
    const double f = t * s_->stampRate.load();
    if (std::fabs(f - std::round(f)) > 1e-6 || !(t > s_->lastStamp.load())) s_->stampErrors++;
    s_->lastStamp = t;
  }
  bool active() const noexcept override { return s_->active.load(); }
  om::DeviceStatus status() const override {
    om::DeviceStatus st;
    std::lock_guard<std::mutex> lk(s_->m);
    st.name = s_->cfg.name;
    st.id = s_->cfg.id;
    st.sampleRate = s_->mainRate;
    st.channels = 2;
    st.running = s_->active.load();
    st.mode = s_->active.load() ? om::DeviceMode::Shared : om::DeviceMode::Closed;
    return st;
  }
  void setEventHandler(om::DeviceEventFn fn) override {
    std::lock_guard<std::mutex> lk(s_->m);
    s_->handler = std::move(fn);
  }

 private:
  std::shared_ptr<Shared> s_;
};

class FakeRecorder final : public om::IRecorder {
 public:
  struct Shared {
    std::mutex m;
    std::string dir, name, path;
    om::RecFormat fmt = om::RecFormat::S16;
    int rate = 0, starts = 0, stops = 0, part = 1;
    std::vector<int> continuedAt;
    std::atomic<bool> active{false};
    std::atomic<bool> failNow{false};
    std::atomic<int64_t> pushed{0};
    std::atomic<int64_t> lastStopNs{0};  // steady_clock time of the last stop() (quit-order test)
    std::string error;
  };
  explicit FakeRecorder(std::shared_ptr<Shared> s) : s_(std::move(s)) {}
  bool start(const std::string& dir, const std::string& name, om::RecFormat fmt, int sampleRate, std::string* pathOut,
             std::string*) override {
    std::lock_guard<std::mutex> lk(s_->m);
    s_->dir = dir;
    s_->name = name;
    s_->fmt = fmt;
    s_->rate = sampleRate;
    s_->starts++;
    s_->part = 1;
    s_->error.clear();
    s_->path = dir + "/" + name + ".wav";
    s_->active = true;
    if (pathOut) *pathOut = s_->path;
    return true;
  }
  void push(const float*, const float*, int frames) noexcept override {
    if (s_->active.load()) s_->pushed += frames;
  }
  // The real recorder's contract: the same file goes on (resampled to its
  // own rate on the writer thread), part stays 1, the path does not change.
  bool continueAtRate(int sampleRate, std::string*) override {
    std::lock_guard<std::mutex> lk(s_->m);
    s_->continuedAt.push_back(sampleRate);
    return true;
  }
  om::RecStatus stop() override {
    std::lock_guard<std::mutex> lk(s_->m);
    s_->stops++;
    s_->active = false;
    s_->lastStopNs = std::chrono::steady_clock::now().time_since_epoch().count();
    return statusLocked();
  }
  om::RecStatus status() const override {
    std::lock_guard<std::mutex> lk(s_->m);
    return statusLocked();
  }
  bool active() const noexcept override { return s_->active.load(); }
  bool takeError() noexcept override {
    if (!s_->failNow.exchange(false)) return false;
    std::lock_guard<std::mutex> lk(s_->m);
    s_->active = false;
    s_->error = "fake: disk full";
    return true;
  }
  std::vector<om::RecFileInfo> list(const std::string& dir, bool repair) override {
    om::RecFileInfo f;
    f.path = dir + "/OpenMix 2026-10-20 01h00.wav";
    f.bytes = 1234;
    f.seconds = 1.5;
    f.repaired = repair;
    return {f};
  }

 private:
  om::RecStatus statusLocked() const {
    om::RecStatus st;
    st.active = s_->active.load();
    st.path = s_->path;
    st.part = s_->part;
    st.seconds = s_->rate > 0 ? static_cast<double>(s_->pushed.load()) / s_->rate : 0.0;
    st.bytes = static_cast<uint64_t>(s_->pushed.load()) * 6;
    st.error = s_->error;
    return st;
  }
  std::shared_ptr<Shared> s_;
};

class FakeVst final : public om::IVstHost {
 public:
  struct Shared {
    std::mutex m;
    std::atomic<bool> running{false};
    int starts = 0, stops = 0, reconfigures = 0, unloads = 0;
    double rate = 0;
    std::string lastPath, lastState;
    uintptr_t lastOwner = 0, ownerSet = 0;
    std::atomic<int> latency[om::kNumDecks] = {};
    std::atomic<uint8_t> events[om::kNumDecks] = {};
    std::atomic<float> mix[om::kNumDecks] = {};
    std::atomic<int64_t> transports{0};
    std::atomic<double> lastBeatPos{0};
    std::atomic<int> loadLatency{0};
    std::atomic<int> loadSleepMs{0};      // a slow plugin load (quit-order test): load() takes this long
    std::atomic<int> loads{0};
    std::atomic<int64_t> lastLoadEndNs{0};  // steady_clock time the last load() returned
    std::atomic<uint8_t> insert[om::kNumDecks] = {};  // insertState() answers (OM_INSERT_*)
    std::atomic<uint64_t> insertLate[om::kNumDecks] = {};
    std::string blob = "VlNUMwBzdGF0Zf8B";  // base64 text, as VstHost::getState returns it
  };
  explicit FakeVst(std::shared_ptr<Shared> s) : s_(std::move(s)) {}
  bool start(double sampleRate, int, std::string*) override {
    std::lock_guard<std::mutex> lk(s_->m);
    s_->starts++;
    s_->rate = sampleRate;
    s_->running = true;
    return true;
  }
  void stop() override {
    std::lock_guard<std::mutex> lk(s_->m);
    if (s_->running) s_->stops++;
    s_->running = false;
  }
  bool running() const noexcept override { return s_->running.load(); }
  void reconfigure(double sampleRate, int) override {
    std::lock_guard<std::mutex> lk(s_->m);
    s_->reconfigures++;
    s_->rate = sampleRate;
  }
  void setOwnerWindow(uintptr_t hwnd) override {
    std::lock_guard<std::mutex> lk(s_->m);
    s_->ownerSet = hwnd;
  }
  om::VstLoadResult load(int deck, const std::string& path, const std::string&, const std::string& state) override {
    s_->loads++;
    if (const int ms = s_->loadSleepMs.load()) std::this_thread::sleep_for(std::chrono::milliseconds(ms));
    struct EndStamp {
      Shared* s;
      ~EndStamp() { s->lastLoadEndNs = std::chrono::steady_clock::now().time_since_epoch().count(); }
    } stamp{s_.get()};
    std::lock_guard<std::mutex> lk(s_->m);
    s_->lastPath = path;
    s_->latency[deck] = s_->loadLatency.load();
    om::VstLoadResult r;
    r.ok = true;
    r.name = "Fake Plugin";
    r.latency = s_->loadLatency.load();
    r.inputs = r.outputs = 2;
    if (!state.empty()) {
      s_->lastState = state;
      r.stateRestored = state != "bad";
    }
    return r;
  }
  void unload(int deck) override {
    std::lock_guard<std::mutex> lk(s_->m);
    s_->unloads++;
    s_->latency[deck] = 0;
  }
  bool setState(int, const std::string& state) override {
    std::lock_guard<std::mutex> lk(s_->m);
    s_->lastState = state;
    return state != "bad";  // the host validates the base64 blob
  }
  std::string getState(int) override {
    std::lock_guard<std::mutex> lk(s_->m);
    return s_->blob;
  }
  std::string openEditor(int, uintptr_t owner) override {
    std::lock_guard<std::mutex> lk(s_->m);
    s_->lastOwner = owner;
    return {};
  }
  void closeEditor(int) override {}
  om::VstSlotStatus status(int deck) const override {
    om::VstSlotStatus st;
    st.loaded = s_->running.load();
    st.latency = s_->latency[deck].load();
    st.mix = s_->mix[deck].load();
    return st;
  }
  uint8_t insertState(int deck, uint64_t* lateBlocks) const noexcept override {
    if (lateBlocks) *lateBlocks = s_->insertLate[deck].load();
    return s_->insert[deck].load();
  }
  void startCallback(double) noexcept override {}
  void setDeadline(float) noexcept override {}
  void setMix(int deck, float mix) noexcept override { s_->mix[deck] = mix; }
  void setTransport(int, const om::VstTransport& t) noexcept override {
    s_->transports++;
    s_->lastBeatPos = t.beatPos;
  }
  uint8_t takeEvents(int deck) noexcept override { return s_->events[deck].exchange(0); }
  bool begin(int, const float*, const float*, int) noexcept override { return false; }
  void end(int, float*, float*, int) noexcept override {}
  int latencyFrames(int deck) const noexcept override { return s_->latency[deck].load(); }

 private:
  std::shared_ptr<Shared> s_;
};

// Everything a core test needs to run an engine on fakes.
struct FakeBackends {
  FakeWorld world;
  std::shared_ptr<FakePhones::Shared> phones = std::make_shared<FakePhones::Shared>();
  std::shared_ptr<FakeRecorder::Shared> rec = std::make_shared<FakeRecorder::Shared>();
  std::shared_ptr<FakeVst::Shared> vst = std::make_shared<FakeVst::Shared>();

  om::EngineBackends make() {
    om::EngineBackends b;
    FakeWorld* w = &world;
    b.enumerateOutputs = [w](std::string*) {
      std::lock_guard<std::mutex> lk(w->m);
      w->enumerations++;
      return w->devices;
    };
    b.createOutput = [w]() -> std::unique_ptr<om::AudioDevice> { return std::make_unique<FakeOutput>(w); };
    b.createWatcher = [w](om::DeviceEventFn fn) -> std::unique_ptr<om::DeviceWatcher> {
      std::lock_guard<std::mutex> lk(w->m);
      w->watcherFn = std::move(fn);
      w->watchers++;
      return std::make_unique<om::DeviceWatcher>();
    };
    auto ph = phones;
    b.createPhones = [ph]() -> std::unique_ptr<om::IPhonesOutput> { return std::make_unique<FakePhones>(ph); };
    auto rc = rec;
    b.createRecorder = [rc]() -> std::unique_ptr<om::IRecorder> { return std::make_unique<FakeRecorder>(rc); };
    auto vs = vst;
    b.createVstHost = [vs]() -> std::unique_ptr<om::IVstHost> { return std::make_unique<FakeVst>(vs); };
    return b;
  }
};

// Collects the engine's events (thread-safe).
struct EventLog {
  std::mutex m;
  std::vector<std::string> all;
  void add(std::string_view json) {
    std::lock_guard<std::mutex> lk(m);
    all.emplace_back(json);
  }
  std::vector<std::string> snapshot() {
    std::lock_guard<std::mutex> lk(m);
    return all;
  }
  int count(const char* needle) {
    std::lock_guard<std::mutex> lk(m);
    int n = 0;
    for (const auto& e : all)
      if (e.find(needle) != std::string::npos) n++;
    return n;
  }
  bool has(const char* needle) { return count(needle) > 0; }
  // Last event containing every needle ("" when none).
  std::string last(std::initializer_list<const char*> needles) {
    std::lock_guard<std::mutex> lk(m);
    for (auto it = all.rbegin(); it != all.rend(); ++it) {
      bool ok = true;
      for (const char* n : needles)
        if (it->find(n) == std::string::npos) ok = false;
      if (ok) return *it;
    }
    return {};
  }
  void clear() {
    std::lock_guard<std::mutex> lk(m);
    all.clear();
  }
};

}  // namespace omtest
