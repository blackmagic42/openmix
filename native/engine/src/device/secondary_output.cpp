// Headphones on a second sound card (owner: device): lock-free ring fed by
// the main audio thread (each push time-stamped), 4-point cubic resampler
// whose ratio follows the CONTINUOUS ring fill (PI controller, target 2
// periods) so the two cards' clock drift never under/overflows, cue on
// channels 3/4 of a >= 4-channel card (1/2 of a stereo one), and the same
// loss / restore rules as the main output through a DeviceSupervisor
// without a stand-in (the ring overflows while the card is gone; the stale
// audio is dropped on return). The ring, the controller and the resampler
// are portable; the stream is the system device (WASAPI shared mode,
// src/device/win/). simulateDrift() runs the very same consumer step
// against simulated clocks. SPEC.md §8.7.
#include <algorithm>
#include <cmath>
#include <cstring>
#include <mutex>
#include <vector>

#include "drift.h"
#include "om/device.h"
#include "ring.h"
#include "timing.h"

namespace om {

namespace {
constexpr size_t kPhonesRingFrames = 32768;  // 0.68 s at 48 kHz

double targetFillFor(int producerBlock, int consumerBlock, double nominal) {
  const double consumerIn = std::ceil(consumerBlock * nominal);
  return 2.0 * std::max(static_cast<double>(producerBlock), consumerIn) + 16.0;
}

// The rate a card claims: the nearest standard rate (a 48000.5 Hz crystal is a 48 kHz card).
double nominalRate(double trueRate) {
  static const double kRates[] = {8000, 11025, 16000, 22050, 24000, 32000, 44100, 48000, 88200, 96000, 176400, 192000, 352800, 384000};
  double best = trueRate, dist = 1e300;
  for (double r : kRates) {
    if (std::fabs(r - trueRate) < dist) {
      dist = std::fabs(r - trueRate);
      best = r;
    }
  }
  return dist <= trueRate * 0.01 ? best : std::round(trueRate);
}

// One consumer callback, shared by the real card thread and the simulation.
// Both timelines are smoothed by a DLL (the producer's push stamps, the
// consumer's callback times), so scheduling jitter on either side does not
// reach the fill measurement.
struct Consumer {
  dev::DriftController ctl;
  dev::CubicReader reader;
  dev::PresentClock prodClock, consClock;
  bool primed = false, clocksReady = false, haveStamp = false;
  double target = 0, nominal = 1.0, inRate = 48000;
  uint64_t stampW = 0;
  int stampN = 0;
  double stampT = 0;
  int64_t consFrames = 0;

  void reset(double nominalRatio, double targetFill, double inputRate, dev::StereoRing& ring, bool dropAll) {
    nominal = nominalRatio;
    target = targetFill;
    inRate = inputRate;
    if (dropAll) reader.skipTo(ring, 0.0);
    ctl.reset(nominal, target, inRate);
    primed = false;
    clocksReady = false;
    haveStamp = false;
    consFrames = 0;
  }

  // Input frames ahead of the read position as if the producer wrote
  // continuously (see drift.h), on the smoothed timelines.
  double fillNow(const dev::StereoRing& ring, const dev::PushStamp& stamp, double now, double outRate, int frames) {
    if (!clocksReady) {
      prodClock.reset(inRate, 0.5, 0.05);
      consClock.reset(outRate > 0 ? outRate : 48000.0, 0.5, 0.05);
      clocksReady = true;
    }
    const double tc = consClock.update(consFrames, now);
    consFrames += frames;
    uint64_t w = 0;
    int n = 0;
    double t = 0;
    if (stamp.read(w, n, t) && n > 0 && (!haveStamp || w != stampW)) {
      stampT = prodClock.update(static_cast<int64_t>(w), t);
      stampW = w;
      stampN = n;
      haveStamp = true;
    }
    if (!haveStamp) return reader.fill(ring);
    // Linear model on the smoothed timelines; bounded only against a
    // stalled producer (clamping at one block would bias the fill whenever
    // a push is late, with a probability that follows the clocks' phase).
    double elapsed = (tc - stampT) * inRate;
    if (elapsed < -stampN) elapsed = -stampN;
    if (elapsed > 3.0 * stampN) elapsed = 3.0 * stampN;
    const double ahead = static_cast<double>(stampW) - reader.position(ring) - stampN + elapsed;
    return ahead > 0 ? ahead : 0.0;
  }

  // Returns false when nothing was written (priming, underrun, overflow recovery).
  bool step(dev::StereoRing& ring, const dev::PushStamp& stamp, double now, float* out, int frames, int channels, int chL,
            int chR, double outRate, bool* underrun) {
    if (underrun) *underrun = false;
    double fill = fillNow(ring, stamp, now, outRate, frames);  // what the controller regulates
    const double actual = reader.fill(ring);                     // what the ring really holds
    if (actual > 4.0 * target + 2.0 * frames * nominal) {
      // The card was away (stalled, restarted): stale audio, start again fresh.
      reader.skipTo(ring, 0.0);
      ctl.reset(nominal, target, inRate);
      primed = false;
      return false;
    }
    if (!primed) {
      if (actual < target) return false;  // silence until the target fill is reached
      // Start exactly at the target: drop the excess whole frames.
      const double excess = std::floor(actual - target);
      if (excess >= 1.0) {
        reader.drop(ring, static_cast<uint64_t>(excess));
        fill -= excess;
      }
      primed = true;
      ctl.reset(nominal, target, inRate);
    }
    const double r = ctl.update(fill, outRate > 0 ? frames / outRate : 0.0);
    if (!reader.read(ring, r, out, frames, channels, chL, chR)) {
      primed = false;
      if (underrun) *underrun = true;
      return false;
    }
    return true;
  }
};
}  // namespace

struct SecondaryOutput::Impl final : IRenderCallback {
  SupervisorOptions sopt;
  // `sup` is replaced by open() / close() (ops thread) and read by status()
  // (any thread, never blocking: a try-lock, else the cached status).
  // Recursive: the change handler (inside open / handlePending) may call status().
  std::recursive_mutex supM;
  std::unique_ptr<DeviceSupervisor> sup;
  mutable std::mutex cacheM;
  DeviceStatus cached;
  dev::StereoRing ring;
  dev::PushStamp stamp;
  std::atomic<bool> activeFlag{false};
  int mainRate = 48000, mainPeriod = 256;
  // ---- phones thread ----
  Consumer consumer;
  std::atomic<bool> resetPending{true};
  std::atomic<int> devRate{0};
  std::atomic<double> correction{1.0};
  std::atomic<uint64_t> dropped{0}, underruns{0};
  // ---- events ----
  std::mutex evM;
  DeviceEventFn onEvent;

  void render(float* out, int frames, int channels, const BlockClock& clk) noexcept override {
    std::memset(out, 0, static_cast<size_t>(frames) * channels * sizeof(float));
    const int stored = devRate.load(std::memory_order_acquire);
    const double rate = stored > 0 ? stored : clk.sampleRate;
    if (resetPending.exchange(false, std::memory_order_acq_rel)) {
      const double nominal = rate > 0 ? static_cast<double>(mainRate) / rate : 1.0;
      // A full ring holds the OLDEST audio (the newest pushes were dropped):
      // drop it all and prime on fresh audio.
      consumer.reset(nominal, targetFillFor(mainPeriod, frames, nominal), mainRate, ring, true);
    }
    const int cueL = channels >= 4 ? 2 : 0;
    const int cueR = channels >= 4 ? 3 : (channels >= 2 ? 1 : -1);
    bool under = false;
    const EngineTime now = clk.callbackTime > 0 ? clk.callbackTime : EngineClock::now();
    if (consumer.step(ring, stamp, now, out, frames, channels, cueL, cueR, rate, &under))
      correction.store(consumer.ctl.correction(), std::memory_order_relaxed);
    if (under) underruns.fetch_add(1, std::memory_order_relaxed);
  }

  void emit(const DeviceEventInfo& ev) {
    std::lock_guard<std::mutex> lk(evM);
    if (onEvent) onEvent(ev);
  }
};

SecondaryOutput::SecondaryOutput() : impl_(std::make_unique<Impl>()) {}

SecondaryOutput::SecondaryOutput(const SupervisorOptions& opt) : impl_(std::make_unique<Impl>()) { impl_->sopt = opt; }

SecondaryOutput::~SecondaryOutput() { close(); }

bool SecondaryOutput::open(const DeviceConfig& cfg, int mainSampleRate, int mainPeriodFrames, std::string* err) {
  close();
  Impl& m = *impl_;
  std::lock_guard<std::recursive_mutex> lk(m.supM);
  if (mainSampleRate <= 0 || mainPeriodFrames <= 0) {
    if (err) *err = "invalid main device rate / period";
    return false;
  }
  if (!m.ring.allocated() && !m.ring.allocate(kPhonesRingFrames)) {
    if (err) *err = "out of memory (phones ring)";
    return false;
  }
  m.mainRate = mainSampleRate;
  m.mainPeriod = std::min(mainPeriodFrames, kMaxBlockFrames);
  SupervisorOptions so = m.sopt;
  so.standIn = false;  // nothing to keep running: the main output drives the engine
  m.sup = std::make_unique<DeviceSupervisor>(&m, so);
  m.sup->setPrepareHandler([&m](int rate, int) {
    m.devRate.store(rate, std::memory_order_release);
    m.resetPending.store(true, std::memory_order_release);
  });
  m.sup->setChangeHandler([&m](DeviceChange c, const DeviceStatus& st) {
    DeviceEventInfo ev;
    ev.id = st.id;
    switch (c) {
      case DeviceChange::Lost:
        ev.event = DeviceEvent::Lost;
        break;
      case DeviceChange::PeriodStep:
        ev.event = DeviceEvent::PeriodStep;
        ev.periodFrames = st.periodFrames;
        break;
      case DeviceChange::Failed:
        return;
      default:  // opened, restored, reopened, default changed: the card plays again
        m.resetPending.store(true, std::memory_order_release);
        ev.event = DeviceEvent::StateChanged;
        ev.state = kDeviceStateActive;
        break;
    }
    m.emit(ev);
  });
  DeviceConfig c = cfg;
  c.mode = OutputMode::Shared;  // shared mode only (SPEC.md §8.7)
  c.periodFrames = 0;
  m.resetPending = true;
  if (!m.sup->open(c, err)) {
    m.sup.reset();
    return false;
  }
  {
    std::lock_guard<std::mutex> cl(m.cacheM);
    m.cached = m.sup->status();
  }
  m.activeFlag.store(true, std::memory_order_release);
  return true;
}

void SecondaryOutput::close() {
  Impl& m = *impl_;
  m.activeFlag.store(false, std::memory_order_release);
  std::lock_guard<std::recursive_mutex> lk(m.supM);
  m.sup.reset();  // stops the stream (joins its thread)
  std::lock_guard<std::mutex> cl(m.cacheM);
  m.cached = DeviceStatus();
}

void SecondaryOutput::push(const float* l, const float* r, int frames) noexcept {
  push(l, r, frames, EngineClock::now());
}

void SecondaryOutput::push(const float* l, const float* r, int frames, EngineTime t) noexcept {
  Impl& m = *impl_;
  if (frames <= 0 || !m.activeFlag.load(std::memory_order_acquire)) return;
  if (!m.ring.push(l, r, static_cast<size_t>(frames))) {
    m.dropped.fetch_add(static_cast<uint64_t>(frames), std::memory_order_relaxed);
    return;
  }
  m.stamp.publish(m.ring.producerWriteIndex(), frames, t);
}

bool SecondaryOutput::active() const noexcept { return impl_->activeFlag.load(std::memory_order_acquire); }

DeviceStatus SecondaryOutput::status() const {
  Impl& m = *impl_;
  std::unique_lock<std::recursive_mutex> lk(m.supM, std::try_to_lock);
  if (lk.owns_lock()) {
    const DeviceStatus st = m.sup ? m.sup->status() : DeviceStatus();
    std::lock_guard<std::mutex> cl(m.cacheM);
    m.cached = st;
    return st;
  }
  std::lock_guard<std::mutex> cl(m.cacheM);  // open / close in progress
  return m.cached;
}

double SecondaryOutput::driftRatio() const noexcept { return impl_->correction.load(std::memory_order_relaxed); }

void SecondaryOutput::setEventHandler(DeviceEventFn fn) {
  std::lock_guard<std::mutex> lk(impl_->evM);
  impl_->onEvent = std::move(fn);
}

uint64_t SecondaryOutput::droppedFrames() const noexcept { return impl_->dropped.load(std::memory_order_relaxed); }

uint64_t SecondaryOutput::underruns() const noexcept { return impl_->underruns.load(std::memory_order_relaxed); }

int SecondaryOutput::handlePending() {
  std::lock_guard<std::recursive_mutex> lk(impl_->supM);
  return impl_->sup ? impl_->sup->handlePending() : 0;
}

// ---------------------------------------------------------------------------
// Offline drift simulation: a producer pushing blocks at its true clock, a
// consumer pulling blocks at another true clock, both believing in their
// nominal rates; the real ring, stamps, controller and resampler between.
// ---------------------------------------------------------------------------
bool SecondaryOutput::simulateDrift(DriftSim& sim) {
  if (sim.producerRate <= 0 || sim.consumerRate <= 0 || sim.seconds <= 0 || sim.producerBlock <= 0 ||
      sim.consumerBlock <= 0 || sim.producerBlock > kMaxBlockFrames || sim.consumerBlock > kMaxBlockFrames)
    return false;
  const double nomP = sim.nominalProducerRate > 0 ? sim.nominalProducerRate : nominalRate(sim.producerRate);
  const double nomC = sim.nominalConsumerRate > 0 ? sim.nominalConsumerRate : nominalRate(sim.consumerRate);
  const double nominal = nomP / nomC;
  const int P = sim.producerBlock, Q = sim.consumerBlock;
  const double target = targetFillFor(P, Q, nominal);

  dev::StereoRing ring;
  if (!ring.allocate(65536)) return false;
  dev::PushStamp stamp;
  Consumer cons;
  cons.reset(nominal, target, nomP, ring, false);
  std::vector<float> inL(static_cast<size_t>(P)), inR(static_cast<size_t>(P));
  std::vector<float> out(static_cast<size_t>(Q) * 2);

  uint32_t rng = 0x9E3779B9u;
  auto jitter = [&]() {
    if (sim.jitterMs <= 0) return 0.0;
    rng ^= rng << 13;
    rng ^= rng >> 17;
    rng ^= rng << 5;
    return (static_cast<double>(rng) / 4294967296.0 * 2.0 - 1.0) * sim.jitterMs / 1000.0;
  };

  const double f = 997.0;  // test tone (Hz at the producer's nominal rate)
  uint64_t produced = 0;
  double schedP = 0, schedC = 0;
  double tP = 0, tC = 0;
  double maxFill = 0, settledFill = 0, sumCorr = 0, maxStep = 0;
  uint64_t nCorr = 0, under = 0, over = 0;
  float prevL = 0;
  bool havePrev = false;
  const double tEnd = sim.seconds;
  while (std::min(tP, tC) < tEnd) {
    if (tP <= tC) {
      for (int i = 0; i < P; i++) {
        const double ph = 2.0 * 3.14159265358979323846 * f * static_cast<double>(produced + i) / nomP;
        inL[static_cast<size_t>(i)] = static_cast<float>(0.5 * std::sin(ph));
        inR[static_cast<size_t>(i)] = static_cast<float>(0.5 * std::cos(ph));
      }
      if (ring.push(inL.data(), inR.data(), static_cast<size_t>(P))) {
        stamp.publish(ring.producerWriteIndex(), P, tP);
      } else {
        over++;
      }
      produced += static_cast<uint64_t>(P);
      schedP += P / sim.producerRate;
      tP = schedP + jitter();
      continue;
    }
    std::fill(out.begin(), out.end(), 0.0f);
    bool u = false;
    const bool wasPrimed = cons.primed;
    if (cons.step(ring, stamp, tC, out.data(), Q, 2, 0, 1, nomC, &u)) {
      for (int i = 0; i < Q; i++) {
        const float y = out[static_cast<size_t>(i) * 2];
        if (havePrev) maxStep = std::max(maxStep, static_cast<double>(std::fabs(y - prevL)));
        prevL = y;
        havePrev = true;
      }
      const double fe = std::fabs(cons.ctl.filteredFill() - target);
      maxFill = std::max(maxFill, fe);
      if (tC >= tEnd / 2) settledFill = std::max(settledFill, fe);
      if (tC >= std::min(tEnd / 2, tEnd - 10.0)) {  // the second half (at least the last 10 s)
        sumCorr += cons.ctl.correction();
        nCorr++;
      }
    } else if (u || wasPrimed) {
      under += u ? 1 : 0;
      havePrev = false;
    }
    schedC += Q / sim.consumerRate;
    tC = schedC + jitter();
  }
  sim.targetFill = target;
  sim.trueRatio = (sim.producerRate / sim.consumerRate) / nominal;
  sim.finalRatio = nCorr ? sumCorr / static_cast<double>(nCorr) : cons.ctl.correction();
  sim.ratioErrorPpm = std::fabs(sim.finalRatio - sim.trueRatio) / sim.trueRatio * 1e6;
  sim.maxFillError = maxFill;
  sim.settledFillError = settledFill;
  sim.underruns = under;
  sim.overflows = over;
  sim.maxGlitch = maxStep;
  return true;
}

}  // namespace om
