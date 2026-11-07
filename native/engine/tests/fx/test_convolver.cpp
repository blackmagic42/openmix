// Tests of the fx module's FFT and partitioned convolver (owner: fx): the
// real FFT against a direct DFT, the non-uniform partition layout, zero
// latency for every block size, accuracy against direct convolution
// (< -100 dB), the idle tail (exact zeros, no work), O(1) reset, the seeded
// and normalized impulses, and the CPU budget (< 1 % of a 256-frame block per
// instance at 48 kHz). SPEC.md §11.3.
#include <cstdio>
#include <memory>
#include <vector>

#include "../../src/fx/fft.h"
#include "../om_test.h"
#include "fx_test_util.h"
#include "om/convolver.h"
#include "om/dsp.h"
#include "om/fx.h"

using namespace om;
using fxtest::Stereo;

namespace {
std::shared_ptr<const ConvolverKernel> kernel22() {
  static std::shared_ptr<const ConvolverKernel> k = ConvolverKernel::build(makeImpulse(2.2, 2.5, 48000, 0x0F00D5EDu), 2048);
  return k;
}

// Runs a convolver over `in` with the block sizes given by `sizes` (cycled).
Stereo convolve(Convolver& c, const Stereo& in, const std::vector<int>& sizes) {
  Stereo out(in.size());
  size_t i = 0, s = 0;
  while (i < in.size()) {
    const int n = static_cast<int>(std::min<size_t>(static_cast<size_t>(sizes[s++ % sizes.size()]), in.size() - i));
    rt::Scope rts;
    c.process(in.l.data() + i, in.r.data() + i, out.l.data() + i, out.r.data() + i, n);
    i += static_cast<size_t>(n);
  }
  return out;
}
}  // namespace

OM_TEST(fft_matches_the_dft) {
  for (int M : {16, 128, 512, 4096}) {
    fx::RealFft f(M);
    std::vector<float> x(static_cast<size_t>(M)), re(static_cast<size_t>(M / 2)), im(static_cast<size_t>(M / 2));
    uint32_t s = 99;
    for (float& v : x) v = static_cast<float>(static_cast<int32_t>(fxtest::xorshift(s))) / 2147483648.0f;
    f.forward(x.data(), re.data(), im.data());
    double err = 0, peak = 0;
    for (int k = 0; k <= M / 2; k++) {
      double xr = 0, xi = 0;
      for (int n = 0; n < M; n++) {
        xr += x[static_cast<size_t>(n)] * std::cos(2 * kPi * k * n / M);
        xi -= x[static_cast<size_t>(n)] * std::sin(2 * kPi * k * n / M);
      }
      peak = std::max(peak, std::hypot(xr, xi));
      if (k == 0) err = std::max(err, std::fabs(re[0] - xr));
      else if (k == M / 2) err = std::max(err, std::fabs(im[0] - xr));
      else err = std::max({err, std::fabs(re[static_cast<size_t>(k)] - xr), std::fabs(im[static_cast<size_t>(k)] - xi)});
    }
    OM_CHECK(err / peak < 2e-6);
    std::vector<float> back(static_cast<size_t>(M));
    f.inverse(re.data(), im.data(), back.data());
    double rt = 0;
    for (int n = 0; n < M; n++)
      rt = std::max(rt, std::fabs(static_cast<double>(back[static_cast<size_t>(n)]) / (M / 2) - x[static_cast<size_t>(n)]));
    OM_CHECK(rt < 2e-6);
  }
}

OM_TEST(convolver_layout_is_non_uniform) {
  const auto k = kernel22();
  OM_CHECK(k->lengthFrames() == 105600 && k->sampleRate() == 48000);
  OM_CHECK(k->directTaps() == 64);
  const auto& L = k->layout();
  OM_CHECK(L.size() == 4);
  const int want[4][4] = {{64, 3, 64, 0}, {256, 3, 256, 0}, {1024, 3, 1024, 0}, {2048, 50, 4096, 1}};
  for (size_t i = 0; i < 4 && i < L.size(); i++) {
    OM_CHECK(L[i].blockFrames == want[i][0] && L[i].count == want[i][1] && L[i].offsetFrames == want[i][2]);
    OM_CHECK(L[i].spread == (want[i][3] != 0));
    OM_CHECK(L[i].offsetFrames >= (L[i].spread ? 2 : 1) * L[i].blockFrames);  // zero latency condition
  }
  const auto space = ConvolverKernel::build(makeImpulse(2.8, 2.2, 48000, 1), 2048);
  OM_CHECK(space->layout().back().count == 64 && space->layout().back().blockFrames == 2048);
  Convolver c;
  c.prepare(k, 2048);
  std::printf("    2.2 s kernel: %zu bytes shared; per instance %zu bytes\n", k->memoryBytes(), c.memoryBytes());
}

OM_TEST(convolver_has_zero_latency_for_any_block_size) {
  const Impulse ir = makeImpulse(2.2, 2.5, 48000, 0x0F00D5EDu);
  const auto k = kernel22();
  const double hpk = std::max(fxtest::maxAbs(ir.left), fxtest::maxAbs(ir.right));
  std::vector<std::vector<int>> plans = {{1}, {3}, {64}, {100}, {128}, {256}, {1000}, {2048}, {17, 2048, 5, 640, 1, 1999, 128}};
  for (const auto& plan : plans) {
    for (size_t at : {size_t(0), size_t(3333)}) {
      Convolver c;
      c.prepare(k, 2048);
      const Stereo out = convolve(c, fxtest::impulse(at + 12000, at), plan);
      double err = 0;
      for (size_t i = 0; i < at; i++) err = std::max(err, std::fabs(static_cast<double>(out.l[i])));
      for (size_t i = 0; i < 12000; i++) {
        err = std::max(err, std::fabs(static_cast<double>(out.l[at + i]) - ir.left[i]));
        err = std::max(err, std::fabs(static_cast<double>(out.r[at + i]) - ir.right[i]));
      }
      if (!(err < 1e-6 * hpk)) std::printf("    plan[0]=%d at=%zu: error %.3g\n", plan[0], at, err);
      OM_CHECK(err < 1e-6 * hpk);
      OM_CHECK(std::fabs(out.l[at] - ir.left[0]) < 1e-7 * hpk);  // the first output sample already carries h[0]
    }
  }
}

OM_TEST(convolver_matches_direct_convolution_below_minus_100_db) {
  const Impulse ir = makeImpulse(2.2, 2.5, 48000, 0x0F00D5EDu);
  const auto k = kernel22();
  const size_t n = 96000 + ir.left.size();
  const Stereo in = fxtest::noise(n, 4242, 0.5f, 0, 96000);
  Convolver c;
  c.prepare(k, 2048);
  std::vector<int> plan;
  uint32_t s = 7;
  for (int i = 0; i < 64; i++) plan.push_back(static_cast<int>(fxtest::xorshift(s) % 2048) + 1);
  const Stereo out = convolve(c, in, plan);
  double err = 0, peak = 0;
  for (size_t t = 0; t < n; t += 97) {
    for (int ch = 0; ch < 2; ch++) {
      const std::vector<float>& h = ch ? ir.right : ir.left;
      const std::vector<float>& x = ch ? in.r : in.l;
      double y = 0;
      const size_t kmax = std::min(h.size(), t + 1);
      for (size_t j = 0; j < kmax; j++) y += static_cast<double>(h[j]) * x[t - j];
      const double got = ch ? out.r[t] : out.l[t];
      err = std::max(err, std::fabs(got - y));
      peak = std::max(peak, std::fabs(y));
    }
  }
  std::printf("    error vs direct convolution: %.1f dB relative to the output peak (%.3g)\n", fxtest::db(err / peak), peak);
  OM_CHECK(err / peak < 1e-5);  // < -100 dB
}

OM_TEST(convolver_idle_tail_outputs_exact_zeros_without_work) {
  const auto k = kernel22();
  Convolver c;
  c.prepare(k, 2048);
  OM_CHECK(c.idle());  // nothing fed yet
  const size_t inputEnd = 9600, total = 9600 + 105600 + 3 * 2048 + 64 + 4096;
  const Stereo in = fxtest::noise(total, 17, 0.5f, 0, inputEnd);
  Stereo out(total);
  size_t idleAt = 0;
  for (size_t i = 0; i < total; i += 256) {
    const int n = static_cast<int>(std::min<size_t>(256, total - i));
    rt::Scope rts;
    c.process(in.l.data() + i, in.r.data() + i, out.l.data() + i, out.r.data() + i, n);
    if (!idleAt && c.idle()) idleAt = i + static_cast<size_t>(n);
  }
  OM_CHECK(idleAt > 0);
  std::printf("    input silent from %zu, idle from %zu (impulse %d frames)\n", inputEnd, idleAt, k->lengthFrames());
  OM_CHECK(idleAt <= inputEnd + 105600 + 3 * 2048 + 64 + 256);
  OM_CHECK(fxtest::maxAbs(out.l, inputEnd + 100000, inputEnd + 105000) > 0.0);  // the tail was rendered
  OM_CHECK(fxtest::maxAbs(out.l, idleAt) == 0.0 && fxtest::maxAbs(out.r, idleAt) == 0.0);
  // Waking up: same output as a fresh convolver for the same new input
  // (internal block phases differ: equal to float rounding).
  const Stereo in2 = fxtest::noise(30000, 23, 0.5f, 0, 2000);
  Convolver fresh;
  fresh.prepare(k, 2048);
  const Stereo a = convolve(c, in2, {256});
  const Stereo b = convolve(fresh, in2, {256});
  OM_CHECK(fxtest::maxDiff(a, b) < 1e-6 * fxtest::maxAbs(b.l));
  // A tail provably below -120 dBFS goes idle at once (and is cleared on wake-up).
  Convolver tiny;
  tiny.prepare(k, 2048);
  const Stereo whisper = fxtest::noise(4096, 3, 4e-9f, 0, 1024);
  convolve(tiny, whisper, {256});
  OM_CHECK(tiny.idle());
  const Stereo c2 = convolve(tiny, in2, {256});
  Convolver fresh2;
  fresh2.prepare(k, 2048);
  OM_CHECK(fxtest::maxDiff(c2, convolve(fresh2, in2, {256})) == 0.0);
}

OM_TEST(convolver_reset_forgets_the_history_in_o1) {
  const auto k = kernel22();
  Convolver c, fresh;
  c.prepare(k, 2048);
  fresh.prepare(k, 2048);
  convolve(c, fxtest::noise(48000, 5, 0.5f), {300});
  {
    rt::Scope rts;
    c.reset();
  }
  const Stereo in = fxtest::noise(20000, 6, 0.5f, 0, 5000);
  OM_CHECK(fxtest::maxDiff(convolve(c, in, {300}), convolve(fresh, in, {300})) == 0.0);
}

OM_TEST(make_impulse_is_seeded_and_normalized) {
  const Impulse a = makeImpulse(2.2, 2.5, 48000, 42), b = makeImpulse(2.2, 2.5, 48000, 42), c = makeImpulse(2.2, 2.5, 48000, 43);
  OM_CHECK(a.left.size() == 105600 && a.right.size() == 105600 && a.sampleRate == 48000);
  OM_CHECK(makeImpulse(2.2, 2.5, 44100, 1).left.size() == 97020);  // Math.floor(sr * seconds)
  OM_CHECK(a.left == b.left && a.right == b.right);
  OM_CHECK(a.left != c.left);
  // RMS after normalization = 10^(-58/20) * 44100 / rate (Chromium calibration)
  double p = 0;
  for (size_t i = 0; i < a.left.size(); i++) p += double(a.left[i]) * a.left[i] + double(a.right[i]) * a.right[i];
  p = std::sqrt(p / (2.0 * a.left.size()));
  OM_CHECK_NEAR(p, std::pow(10.0, -58.0 / 20.0) * 44100.0 / 48000.0, 1e-6);
  // The generator, for the golden script: xorshift32, uniform = x / 2^32,
  // sample = (u * 2 - 1) * (1 - i / len)^decay * scale, left then right.
  uint32_t s = 42;
  const double u0 = fxtest::xorshift(s) / 4294967296.0;
  OM_CHECK(a.left[0] == static_cast<float>(u0 * 2 - 1) * a.normalizationScale);
  const double u1 = fxtest::xorshift(s) / 4294967296.0;
  OM_CHECK(a.left[1] == static_cast<float>((u1 * 2 - 1) * std::pow(1.0 - 1.0 / 105600, 2.5)) * a.normalizationScale);
}

OM_TEST(convolver_cpu_budget_under_1_percent) {
  dsp::FpEnvGuard fpEnv;  // restored when the test ends
  dsp::flushDenormals();   // like the audio thread
  const double blockSec = 256.0 / 48000.0;
  const Stereo in = fxtest::noise(256 * 200, 77, 0.5f);
  Stereo out(256);
  double worst = 0;
  for (double seconds : {2.2, 2.8}) {
    const auto k = ConvolverKernel::build(makeImpulse(seconds, 2.5, 48000, 9), 2048);
    Convolver c;
    c.prepare(k, 2048);
    size_t pos = 0;
    double maxBlock = 0;
    auto block = [&]() {
      c.process(in.l.data() + pos, in.r.data() + pos, out.l.data(), out.r.data(), 256);
      pos = (pos + 256) % in.size();
    };
    for (int i = 0; i < 200; i++) block();
    for (int i = 0; i < 64; i++) {  // single blocks: the spread tail keeps every block alike
      const double t = fxtest::secondsPerCall(block, 1, 1);
      maxBlock = std::max(maxBlock, t);
    }
    const double sec = fxtest::secondsPerCall(block, 400);
    const double pct = 100.0 * sec / blockSec;
    worst = std::max(worst, pct);
    std::printf("    %.1f s impulse: %.2f us per 256-frame stereo block = %.3f %% (slowest of 64 single blocks %.2f us) (%s)\n",
                seconds, sec * 1e6, pct, maxBlock * 1e6, fxtest::kOptimized ? "optimized" : "debug");
  }
  if (fxtest::kOptimized) OM_CHECK(worst < 1.0);
}
