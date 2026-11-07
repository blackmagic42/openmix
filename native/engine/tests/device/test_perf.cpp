// CPU cost per 128-frame block of the device layer's real-time pieces
// (owner: device): float -> s16 / s24 packed / s24-in-32 / s32 with TPDF,
// the presentTime DLL + jitter statistics of one callback, the NULL
// device's pump overhead, and the headphones path (ring push + time stamp +
// continuous fill + PI controller + cubic resampler). The recorder's push
// is measured in test_recorder.cpp. Every measured loop runs inside an
// rt::Scope (no allocation, no free). Prints the numbers; the bounds are
// generous (the shared PC may be busy, and tests are Debug builds). Silent,
// portable.
#include <chrono>
#include <cmath>
#include <cstring>
#include <vector>

#include "../../src/device/drift.h"
#include "../../src/device/formats.h"
#include "../../src/device/ring.h"
#include "../../src/device/timing.h"
#include "../om_test.h"
#include "om/device.h"
#include "om/rt.h"

using namespace om;

namespace {

template <class F>
double nsPer(int iterations, F&& f) {
  rt::Scope rts;  // audio-thread code
  const auto t0 = std::chrono::steady_clock::now();
  for (int i = 0; i < iterations; i++) f(i);
  return std::chrono::duration<double, std::nano>(std::chrono::steady_clock::now() - t0).count() / iterations;
}

struct Silence final : IRenderCallback {
  void render(float*, int, int, const BlockClock&) noexcept override {}
};

}  // namespace

OM_TEST(perf_device_layer_per_128_frame_block) {
  constexpr int N = 128, CH = 2;
  std::vector<float> in(N * CH);
  for (int i = 0; i < N * CH; i++) in[static_cast<size_t>(i)] = static_cast<float>(0.7 * std::sin(i * 0.01));
  std::vector<uint8_t> out(N * CH * 4);
  dev::Tpdf d;
  const dev::SampleFormat fmts[] = {dev::SampleFormat::S16, dev::SampleFormat::S24, dev::SampleFormat::S24in32,
                                    dev::SampleFormat::S32, dev::SampleFormat::F32};
  for (dev::SampleFormat f : fmts) {
    const double ns = nsPer(20000, [&](int) { dev::convertFromFloat(in.data(), out.data(), N * CH, f, d); });
    std::printf("[INFO] convert float -> %s: %.0f ns per 128 stereo frames\n", dev::sampleFormatName(f), ns);
    OM_CHECK(ns < 50000);
  }
  auto pc = std::make_unique<dev::PresentClock>();
  auto jw = std::make_unique<dev::JitterWindow>();
  auto raw = std::make_unique<dev::JitterWindow>();
  pc->reset(48000, 1.0, 0.002);
  jw->reset(1.0);
  raw->reset(1.0);
  int64_t frame = 0;
  double last = 0;
  const double nsClock = nsPer(100000, [&](int i) {
    const double t = frame / 48000.0 + 1e-5 * std::sin(i * 0.7);  // 10 us of measurement noise
    const double p = pc->update(frame, t);
    if (i) jw->add(p - (last + 480 / 48000.0), t);
    raw->add(t - p, t);
    last = p;
    frame += 480;
  });
  std::printf("[INFO] presentTime DLL + jitter statistics: %.0f ns per callback (filtered jitter p99 %.4f ms for a raw "
              "noise of p99 %.4f ms)\n",
              nsClock, jw->totalP99Ms(), raw->totalP99Ms());
  OM_CHECK(jw->totalP99Ms() < 0.005);  // the DLL removes the measurement noise
  // NULL device pump: the device layer's own share of a block.
  NullDeviceConfig nc;
  nc.blockFrames = N;
  nc.channels = CH;
  NullDevice nd(nc);
  Silence s;
  std::string err;
  OM_CHECK(nd.open(DeviceConfig(), &s, &err) && nd.start(&err));
  const double nsPump = nsPer(20000, [&](int) { nd.pump(1); });
  std::printf("[INFO] NULL device pump: %.0f ns per 128-frame block (callback excluded)\n", nsPump);
  // Headphones path: 128 frames pushed at 48 kHz, 118 read at 44.1 kHz.
  dev::StereoRing ring;
  OM_CHECK(ring.allocate(32768));
  dev::PushStamp stamp;
  dev::DriftController ctl;
  dev::CubicReader rd;
  ctl.reset(48000.0 / 44100.0, 600, 48000);
  std::vector<float> l(N, 0.25f), r(N, -0.25f), po(N * 4);
  for (int i = 0; i < 8; i++) ring.push(l.data(), r.data(), N);
  double t = 0, fillAcc = 0;
  const double nsPhones = nsPer(20000, [&](int) {
    ring.push(l.data(), r.data(), N);
    stamp.publish(ring.producerWriteIndex(), N, t);
    t += N / 48000.0;
    const double fill = dev::continuousFill(ring, rd, stamp, t, 48000);
    fillAcc += fill;
    const double ratio = ctl.update(fill, 118 / 44100.0);
    if (!rd.read(ring, ratio, po.data(), 118, 4, 2, 3)) rd.skipTo(ring, 600);
  });
  std::printf("[INFO] phones path (push + stamp + PI + cubic resampler): %.0f ns per 128-frame block\n", nsPhones);
  OM_CHECK(nsPhones < 50000 && fillAcc > 0);
}
