// Tests of the headphones output on a second card (owner: device): the PI
// drift controller and the cubic resampler offline (simulateDrift: 48000 vs
// 48000.5 Hz for 60 s -> ratio within 20 ppm of the true one, fill error
// < 1 period; harder cases: 1000 ppm, 44.1 -> 48 kHz, scheduling jitter),
// push() allocation-free, and end to end with a fake card: cue on 3/4 of a
// 4-channel card, 1/2 silent, steady fill, and the same loss / restore rules
// as the main output (no stand-in; stale audio skipped on return).
// Portable, silent. SPEC.md §8.7.
#include <algorithm>
#include <chrono>
#include <cmath>
#include <map>
#include <memory>
#include <string>
#include <vector>

#include "../om_test.h"
#include "om/device.h"
#include "om/rt.h"

using namespace om;

namespace {

void report(const char* what, const SecondaryOutput::DriftSim& s) {
  std::printf("[INFO] phones drift %s: true ratio %.9f, final %.9f (%.3f ppm off), fill error max %.1f / settled %.1f frames "
              "(target %.0f), underruns %llu, overflows %llu, max output step %.4f\n",
              what, s.trueRatio, s.finalRatio, s.ratioErrorPpm, s.maxFillError, s.settledFillError, s.targetFill,
              static_cast<unsigned long long>(s.underruns), static_cast<unsigned long long>(s.overflows), s.maxGlitch);
}

// A 997 Hz sine at amplitude 0.5 moves at most 0.5 * 2 pi * 997 / rate per sample.
double maxSineStep(double rate) { return 0.5 * 2 * 3.14159265358979 * 997.0 / rate * 1.05; }

}  // namespace

OM_TEST(phones_drift_48000_vs_48000_5_for_60_s) {
  SecondaryOutput::DriftSim sim;  // defaults: 48000 vs 48000.5 Hz, 60 s, 256-frame blocks
  OM_CHECK(SecondaryOutput::simulateDrift(sim));
  report("48000 vs 48000.5", sim);
  OM_CHECK(sim.ratioErrorPpm < 20.0);
  OM_CHECK(sim.maxFillError < sim.consumerBlock);  // < 1 period
  OM_CHECK(sim.ratioErrorPpm < 1.0);               // in fact well below
  OM_CHECK(sim.underruns == 0 && sim.overflows == 0);
  OM_CHECK(sim.maxGlitch < maxSineStep(48000));    // continuous output
}

OM_TEST(phones_drift_harder_cases) {
  {
    SecondaryOutput::DriftSim sim;  // a bad crystal: 1000 ppm, different block sizes
    sim.producerRate = 48000;
    sim.consumerRate = 48048;
    sim.nominalConsumerRate = 48000;
    sim.producerBlock = 480;
    sim.consumerBlock = 441;
    OM_CHECK(SecondaryOutput::simulateDrift(sim));
    report("1000 ppm", sim);
    OM_CHECK(sim.ratioErrorPpm < 20.0 && sim.maxFillError < sim.consumerBlock);
    OM_CHECK(sim.underruns == 0 && sim.overflows == 0 && sim.maxGlitch < maxSineStep(48048));
  }
  {
    SecondaryOutput::DriftSim sim;  // master card at 44.1 kHz, headphones card at 48 kHz (+ 6 ppm)
    sim.producerRate = 44100;
    sim.consumerRate = 48000.3;
    sim.nominalConsumerRate = 48000;
    sim.producerBlock = 441;
    sim.consumerBlock = 480;
    OM_CHECK(SecondaryOutput::simulateDrift(sim));
    report("44.1 -> 48 kHz", sim);
    OM_CHECK(sim.ratioErrorPpm < 20.0 && sim.maxFillError < sim.consumerBlock);
    OM_CHECK(sim.underruns == 0 && sim.overflows == 0 && sim.maxGlitch < maxSineStep(48000));
  }
  {
    // Both callbacks jitter by +-1 ms (busy PC): the instantaneous ratio
    // wanders by a few tens of ppm (0.03 cent), unbiased; the fill stays
    // within a few frames, never runs dry.
    SecondaryOutput::DriftSim sim;
    sim.producerBlock = 480;
    sim.consumerBlock = 480;
    sim.jitterMs = 1.0;
    OM_CHECK(SecondaryOutput::simulateDrift(sim));
    report("jitter 1 ms", sim);
    OM_CHECK(sim.ratioErrorPpm < 20.0 && sim.maxFillError < 0.1 * sim.consumerBlock);
    OM_CHECK(sim.underruns == 0 && sim.overflows == 0 && sim.maxGlitch < maxSineStep(48000));
  }
}

namespace {

struct FakeCard;

struct CardWorld {
  std::vector<DeviceInfo> endpoints;
  FakeCard* current = nullptr;
  int channels = 4;
  int rate = 44100;
  void add(const std::string& id, const std::string& name) {
    DeviceInfo d;
    d.id = id;
    d.name = name;
    d.channels = channels;
    d.sampleRate = rate;
    endpoints.push_back(d);
  }
  void remove(const std::string& id) {
    endpoints.erase(std::remove_if(endpoints.begin(), endpoints.end(), [&](const DeviceInfo& d) { return d.id == id; }),
                    endpoints.end());
  }
};

// A headphones card the test pulls by hand (deterministic).
struct FakeCard final : AudioDevice {
  CardWorld& w;
  std::string id;
  IRenderCallback* cb = nullptr;
  bool open_ = false;
  DeviceConfig cfg;
  explicit FakeCard(CardWorld& world) : w(world) {}
  ~FakeCard() override {
    if (w.current == this) w.current = nullptr;
  }
  bool open(const DeviceConfig& c, IRenderCallback* r, std::string* err) override {
    bool found = false;
    for (const auto& d : w.endpoints) found = found || d.id == c.id;
    if (!found) {
      if (err) *err = "fake card missing";
      return false;
    }
    cfg = c;
    id = c.id;
    cb = r;
    open_ = true;
    return true;
  }
  bool start(std::string*) override {
    w.current = this;
    return true;
  }
  void stop() override {
    if (w.current == this) w.current = nullptr;
  }
  void close() override {
    stop();
    open_ = false;
  }
  DeviceStatus status() const override {
    DeviceStatus s;
    s.mode = open_ ? DeviceMode::Shared : DeviceMode::Closed;
    s.id = id;
    s.sampleRate = w.rate;
    s.channels = w.channels;
    s.periodFrames = 441;
    return s;
  }
  void setEventHandler(DeviceEventFn) override {}
  // t: the card's callback time (0 = the engine clock now).
  void pull(float* out, int frames, double t = 0) {
    BlockClock clk;
    clk.frames = frames;
    clk.sampleRate = w.rate;
    clk.callbackTime = t;
    cb->render(out, frames, w.channels, clk);
  }
};

struct PhonesRig {
  CardWorld w;
  std::unique_ptr<SecondaryOutput> phones;
  std::vector<DeviceEvent> events;
  PhonesRig() {
    SupervisorOptions o;
    o.manual = true;
    o.retrySec = 0;
    o.makeDevice = [this] { return std::make_unique<FakeCard>(w); };
    o.enumerate = [this](std::string*) { return w.endpoints; };
    o.makeWatcher = [](DeviceEventFn) { return std::unique_ptr<DeviceWatcher>(); };
    phones = std::make_unique<SecondaryOutput>(o);
    phones->setEventHandler([this](const DeviceEventInfo& ev) { events.push_back(ev.event); });
  }
};

// Main side at 48 kHz (256-frame blocks of a sine on L, its negative on R),
// card side at 44.1 kHz (441-frame pulls), interleaved on a simulated clock
// that both sides' time stamps use.
struct Feeder {
  int64_t produced = 0;
  double tMain = 1.0, tCard = 1.0;
  std::vector<float> l = std::vector<float>(256), r = std::vector<float>(256);
  void run(PhonesRig& g, double seconds, std::vector<float>& lastOut, double& rmsCue, double& rmsMaster) {
    const double end = tCard + seconds;
    std::vector<float> out(441 * 4);
    double sumCue = 0, sumMaster = 0;
    uint64_t n = 0;
    while (tCard < end) {
      if (tMain <= tCard) {
        for (int i = 0; i < 256; i++) {
          l[static_cast<size_t>(i)] = static_cast<float>(0.5 * std::sin(2 * 3.14159265358979 * 997.0 * (produced + i) / 48000.0));
          r[static_cast<size_t>(i)] = -l[static_cast<size_t>(i)];
        }
        g.phones->push(l.data(), r.data(), 256, tMain);
        produced += 256;
        tMain += 256 / 48000.0;
      } else {
        if (g.w.current) {
          g.w.current->pull(out.data(), 441, tCard);
          for (int i = 0; i < 441; i++) {
            sumCue += out[static_cast<size_t>(i) * 4 + 2] * out[static_cast<size_t>(i) * 4 + 2];
            sumMaster += out[static_cast<size_t>(i) * 4] * out[static_cast<size_t>(i) * 4];
            n++;
          }
          lastOut = out;
        }
        tCard += 441 / 44100.0;
      }
    }
    rmsCue = n ? std::sqrt(sumCue / n) : 0;
    rmsMaster = n ? std::sqrt(sumMaster / n) : 0;
  }
};

}  // namespace

OM_TEST(phones_push_is_realtime_safe) {
  PhonesRig g;
  g.w.add("{phones}", "Headphones (USB Audio)");
  std::vector<float> l(128, 0.2f), r(128, -0.2f);
  {
    rt::Scope rts;  // not open yet: nothing to do
    g.phones->push(l.data(), r.data(), 128);
  }
  DeviceConfig cfg;
  cfg.name = "Headphones (USB Audio)";
  std::string err;
  OM_CHECK(g.phones->open(cfg, 48000, 256, &err));
  const auto t0 = std::chrono::steady_clock::now();
  {
    rt::Scope rts;
    for (int i = 0; i < 200; i++) g.phones->push(l.data(), r.data(), 128);
  }
  const double ns = std::chrono::duration<double, std::nano>(std::chrono::steady_clock::now() - t0).count() / 200;
  std::printf("[INFO] phones push: %.0f ns per 128-frame block (audio thread)\n", ns);
  // The card's render (resampler + controller) on its thread: no allocation either.
  std::vector<float> out(441 * 4);
  {
    rt::Scope rts;
    g.w.current->pull(out.data(), 441);
  }
}

OM_TEST(phones_end_to_end_cue_on_3_4) {
  PhonesRig g;
  g.w.add("{flx6}", "Master (DDJ-FLX6)");  // 4 channels: cue on 3/4
  DeviceConfig cfg;
  cfg.name = "Master (DDJ-FLX6)";
  cfg.mode = OutputMode::Exclusive;  // the phones path forces shared mode
  std::string err;
  OM_CHECK(g.phones->open(cfg, 48000, 256, &err));
  OM_CHECK(g.phones->active() && g.w.current != nullptr);
  OM_CHECK(g.w.current->cfg.mode == OutputMode::Shared);
  Feeder f;
  std::vector<float> last;
  double rmsCue = 0, rmsMaster = 0;
  f.run(g, 3.0, last, rmsCue, rmsMaster);
  OM_CHECK(rmsCue > 0.3 && rmsMaster == 0.0);  // 0.5 sine: rms 0.354 on 3/4, nothing on 1/2
  OM_CHECK(g.phones->underruns() == 0 && g.phones->droppedFrames() == 0);
  OM_CHECK_NEAR(g.phones->driftRatio(), 1.0, 0.001);  // 48000 -> 44100 nominal, no drift here
  OM_CHECK(last.size() == 441 * 4 && last[2] == -last[3]);  // R = -L survives the resampler exactly
  // A stereo card gets the cue on 1/2.
  PhonesRig s;
  s.w.channels = 2;
  s.w.add("{usb}", "Headphones (USB Audio)");
  cfg.name = "Headphones (USB Audio)";
  OM_CHECK(s.phones->open(cfg, 48000, 256, &err));
  std::vector<float> l(256, 0.5f), r(256, -0.5f), out(441 * 2);
  s.w.current->pull(out.data(), 441);  // the first callback starts on fresh audio (silence until primed)
  for (int i = 0; i < 8; i++) s.phones->push(l.data(), r.data(), 256);
  s.w.current->pull(out.data(), 441);
  OM_CHECK(std::fabs(out[0] - 0.5f) < 1e-4 && std::fabs(out[1] + 0.5f) < 1e-4);
}

OM_TEST(phones_loss_and_restore_follow_the_main_rules) {
  // Same rig, the loss reported by the watcher (fake notifier).
  CardWorld w;
  DeviceEventFn notifier;
  SupervisorOptions o;
  o.manual = true;
  o.retrySec = 0;
  o.makeDevice = [&w] { return std::make_unique<FakeCard>(w); };
  o.enumerate = [&w](std::string*) { return w.endpoints; };
  o.makeWatcher = [&notifier](DeviceEventFn fn) {
    notifier = std::move(fn);
    struct Nothing final : DeviceWatcher {};
    return std::unique_ptr<DeviceWatcher>(new Nothing());
  };
  SecondaryOutput phones(o);
  std::vector<DeviceEvent> events;
  phones.setEventHandler([&events](const DeviceEventInfo& ev) { events.push_back(ev.event); });
  w.add("{flx6}", "Master (DDJ-FLX6)");
  DeviceConfig cfg;
  cfg.name = "Master (DDJ-FLX6)";
  std::string err;
  OM_CHECK(phones.open(cfg, 48000, 256, &err));
  OM_CHECK(notifier != nullptr);
  std::vector<float> l(256, 0.25f), r(256, -0.25f), out(441 * 4);
  for (int i = 0; i < 20; i++) phones.push(l.data(), r.data(), 256);
  w.current->pull(out.data(), 441);
  // Unplugged.
  w.remove("{flx6}");
  DeviceEventInfo ev;
  ev.event = DeviceEvent::StateChanged;
  ev.id = "{flx6}";
  ev.state = kDeviceStateNotPresent;
  notifier(ev);
  phones.handlePending();
  DeviceStatus st = phones.status();
  OM_CHECK(st.lost && st.mode == DeviceMode::Closed);  // no stand-in for the phones
  OM_CHECK(!events.empty() && events.back() == DeviceEvent::Lost);
  OM_CHECK(phones.active());  // still configured: the cue keeps being pushed
  for (int i = 0; i < 400; i++) phones.push(l.data(), r.data(), 256);  // 2.1 s: the ring overflows
  OM_CHECK(phones.droppedFrames() > 0);
  // Another card appears: not ours.
  w.add("{realtek}", "Speakers (Realtek(R) Audio)");
  ev.event = DeviceEvent::Added;
  ev.id = "{realtek}";
  notifier(ev);
  phones.handlePending();
  OM_CHECK(phones.status().lost);
  // The FLX6 is back: reopened, and the stale audio is skipped (fresh cue).
  w.add("{flx6}", "Master (DDJ-FLX6)");
  ev.event = DeviceEvent::Added;
  ev.id = "{flx6}";
  notifier(ev);
  phones.handlePending();
  st = phones.status();
  OM_CHECK(!st.lost && st.id == "{flx6}" && w.current != nullptr);
  OM_CHECK(events.back() == DeviceEvent::StateChanged);  // "the card plays again"
  // The first callback drops what piled up while the card was away (the
  // OLDEST audio: a full ring refuses the newest pushes), then the cue
  // resumes on fresh audio once the target fill is reached.
  w.current->pull(out.data(), 441);
  bool silent = true;
  for (float v : out) silent = silent && v == 0.0f;
  OM_CHECK(silent);
  std::vector<float> fresh(256, 0.75f);
  for (int i = 0; i < 8; i++) phones.push(fresh.data(), fresh.data(), 256);
  w.current->pull(out.data(), 441);
  bool allFresh = true;
  for (int i = 0; i < 441; i++) allFresh = allFresh && std::fabs(out[static_cast<size_t>(i) * 4 + 2] - 0.75f) < 1e-3;
  OM_CHECK(allFresh);
}
