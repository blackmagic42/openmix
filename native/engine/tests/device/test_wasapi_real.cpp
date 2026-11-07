// Opt-in real-device smoke test of the WASAPI backend (owner: device): ONLY
// with OM_TEST_REAL_DEVICE=1. The default endpoint, SHARED and SHARED
// LOW-LATENCY (IAudioClient3) modes only, zeros, 1.5 s each, then 1 s
// through DeviceSupervisor (4 s of silent audio in all, < 5 s); NEVER
// exclusive mode (the owner games on this PC). Measures what the core gets:
// the period, the buffer, the stream latency, the output latency
// (presentTime - callbackTime), the presentTime jitter (p99, from the clocks
// handed to the render callback, and the raw IAudioClock noise), the
// glitches and the device layer's own CPU per callback; checks presentTime
// is monotonic and continuous with a jitter < 0.1 ms p99.
// SPEC.md §8.2, §8.3, §18.3.
#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstring>
#include <string>
#include <thread>
#include <vector>

#include "../om_test.h"
#include "om/device.h"

using namespace om;

namespace {

struct Rec {
  double cb, present;
  int frames;
  int64_t frame;
};

// Writes zeros (silent) and records the clocks it is given (no allocation).
struct ZeroProbe final : IRenderCallback {
  std::vector<Rec> recs = std::vector<Rec>(16384);
  std::atomic<size_t> n{0};
  void render(float* out, int frames, int channels, const BlockClock& clk) noexcept override {
    std::memset(out, 0, static_cast<size_t>(frames) * channels * sizeof(float));
    const size_t i = n.load(std::memory_order_relaxed);
    if (i < recs.size()) {
      recs[i] = {clk.callbackTime, clk.presentTime, frames, clk.frame};
      n.store(i + 1, std::memory_order_release);
    }
  }
};

struct Analysis {
  size_t callbacks = 0;
  int minFrames = 1 << 30, maxFrames = 0;
  double p99JitterMs = 0, maxJitterMs = 0;
  double latMeanMs = 0, latMinMs = 1e9, latMaxMs = 0;
  bool monotonic = true, framesContinuous = true;
};

Analysis analyze(const ZeroProbe& p, double rate) {
  Analysis a;
  const size_t n = p.n.load(std::memory_order_acquire);
  a.callbacks = n;
  const size_t warm = std::min<size_t>(10, n);
  std::vector<double> dev;
  double latSum = 0;
  size_t latN = 0;
  for (size_t k = warm; k < n; k++) {
    const Rec& r = p.recs[k];
    a.minFrames = std::min(a.minFrames, r.frames);
    a.maxFrames = std::max(a.maxFrames, r.frames);
    const double lat = (r.present - r.cb) * 1000.0;
    latSum += lat;
    latN++;
    a.latMinMs = std::min(a.latMinMs, lat);
    a.latMaxMs = std::max(a.latMaxMs, lat);
    if (k + 1 < n) {
      const Rec& q = p.recs[k + 1];
      if (q.present <= r.present) a.monotonic = false;
      if (q.frame != r.frame + r.frames) a.framesContinuous = false;
      dev.push_back(std::fabs(q.present - r.present - r.frames / rate) * 1000.0);
    }
  }
  a.latMeanMs = latN ? latSum / latN : 0;
  if (!dev.empty()) {
    std::sort(dev.begin(), dev.end());
    a.p99JitterMs = dev[std::min(dev.size() - 1, static_cast<size_t>(std::ceil(0.99 * dev.size())) - 1)];
    a.maxJitterMs = dev.back();
  }
  return a;
}

void printRun(const char* label, const DeviceStatus& st, const Analysis& a) {
  std::printf("[INFO] %s: \"%s\" mode %s%s%s, %d Hz, %d ch, %s, period %d frames (%.2f ms), buffer %d frames (%.2f ms), "
              "stream latency %.2f ms, output latency %.2f ms (min %.2f max %.2f), %zu callbacks of %d..%d frames, "
              "presentTime jitter p99 %.4f ms (max %.4f; status window %.4f), raw IAudioClock jitter p99 %.4f ms, "
              "glitches %llu, device-layer CPU %.1f us per callback (%.2f us per 128 frames)\n",
              label, st.name.c_str(), deviceModeName(st.mode), st.fellBack ? " (fell back: " : "",
              st.fellBack ? (st.fallbackReason + ")").c_str() : "", st.sampleRate, st.channels, st.sampleFormat.c_str(),
              st.periodFrames, st.sampleRate ? 1000.0 * st.periodFrames / st.sampleRate : 0.0, st.bufferFrames,
              st.sampleRate ? 1000.0 * st.bufferFrames / st.sampleRate : 0.0, st.streamLatencyMs, a.latMeanMs, a.latMinMs,
              a.latMaxMs, a.callbacks, a.minFrames, a.maxFrames, a.p99JitterMs, a.maxJitterMs, st.presentJitterMs,
              st.rawJitterMs, static_cast<unsigned long long>(st.glitches), st.cpuUs,
              a.maxFrames > 0 ? st.cpuUs * 128.0 / ((a.minFrames + a.maxFrames) / 2.0) : 0.0);
}

}  // namespace

OM_TEST(wasapi_real_device_shared_and_lowlatency) {
  if (!omtest::envFlag("OM_TEST_REAL_DEVICE"))
    OM_SKIP("opt-in: OM_TEST_REAL_DEVICE=1 (default endpoint, shared modes only, zeros, < 5 s)");
  std::string err;
  if (!deviceApiAvailable(&err)) OM_SKIP("no device API: " + err);
  for (OutputMode mode : {OutputMode::Shared, OutputMode::SharedLowLatency}) {
    OM_CHECK(mode != OutputMode::Exclusive);  // never exclusive in tests
    std::unique_ptr<AudioDevice> dev = createSystemDevice();
    OM_CHECK(dev != nullptr);
    ZeroProbe probe;
    DeviceConfig cfg;
    cfg.role = DeviceRole::Console;  // the default endpoint
    cfg.mode = mode;
    OM_CHECK(dev->open(cfg, &probe, &err));
    OM_CHECK(dev->status().mode != DeviceMode::Exclusive);
    OM_CHECK(dev->start(&err));
    std::this_thread::sleep_for(std::chrono::milliseconds(1500));
    const DeviceStatus st = dev->status();
    dev->stop();
    dev->close();
    const Analysis a = analyze(probe, st.sampleRate);
    printRun(mode == OutputMode::Shared ? "WASAPI shared" : "WASAPI lowlatency", st, a);
    OM_CHECK(st.callbacks > 20 && a.callbacks > 20);
    OM_CHECK(a.monotonic && a.framesContinuous);
    OM_CHECK(a.maxFrames <= kMaxBlockFrames);
    OM_CHECK(a.p99JitterMs < 0.1);  // SPEC.md §4.1 target
    OM_CHECK(a.latMinMs > 0);       // presentTime is in the future of the callback
    if (mode == OutputMode::SharedLowLatency && st.mode == DeviceMode::SharedLowLatency)
      OM_CHECK(1000.0 * st.periodFrames / st.sampleRate >= 5.0 - 1e-9);  // never below 5 ms by default
  }
  // The same endpoint through the supervisor (real enumeration, notifications, worker thread).
  ZeroProbe probe;
  DeviceSupervisor sup(&probe);
  int prepared = 0;
  sup.setPrepareHandler([&prepared](int, int) { prepared++; });
  DeviceConfig cfg;
  cfg.followDefault = true;
  cfg.mode = OutputMode::SharedLowLatency;
  OM_CHECK(sup.open(cfg, &err));
  std::this_thread::sleep_for(std::chrono::milliseconds(1000));
  const DeviceStatus st = sup.status();
  sup.close();
  OM_CHECK(st.running && !st.lost && st.mode != DeviceMode::Exclusive && prepared == 1);
  const Analysis a = analyze(probe, st.sampleRate);
  printRun("supervisor (follow default)", st, a);
  OM_CHECK(a.monotonic && a.p99JitterMs < 0.1);
}
