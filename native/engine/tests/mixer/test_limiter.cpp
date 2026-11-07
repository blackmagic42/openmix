// Tests of the master limiter (owner: mixer): the port of Chromium's
// DynamicsCompressorKernel against Chromium's renders of the
// DynamicsCompressorNode configured by engine.js itself (AudioEngine.limiter;
// golden suite limiter/*: sine bursts, noise level steps, kick-like
// transients, unbalanced channels; OM_GOLDEN_DIR), the static curve with the
// makeup gain, the 6 ms look-ahead (master chain latency), the gain
// reduction reading, block-size independence and recovery from a
// non-finite input. SPEC.md §10.7.
#include <algorithm>
#include <cmath>
#include <vector>

#include "mixer_test_util.h"
#include "om/dsp.h"
#include "om/limiter.h"
#include "om/rt.h"

using namespace om;

OM_TEST(mixer_limiter_null_vs_chromium_dynamics_compressor) {
  const char* cases[] = {"sine_bursts", "noise_steps", "kick_like", "stereo_unbalanced"};
  dsp::flushDenormals();  // as on the audio thread (Chromium renders with FTZ/DAZ too)
  double worst = -400.0;
  for (const char* name : cases) {
    const mixtest::Golden g = mixtest::loadGolden("limiter", name);
    MIXTEST_REQUIRE_GOLDEN(g);
    const double rate = g.meta["sampleRate"].asNumber(48000);
    std::vector<float> l = mixtest::channel(g.input, 0), r = mixtest::channel(g.input, 1);
    const int64_t frames = g.out.frames();
    l.resize(static_cast<size_t>(frames), 0.0f);
    r.resize(static_cast<size_t>(frames), 0.0f);
    Limiter lim;
    lim.prepare(rate);
    int64_t pos = 0;
    int k = 0;
    while (pos < frames) {
      int n = mixtest::blockSize(k++);
      if (pos + n > frames) n = static_cast<int>(frames - pos);
      {
        rt::Scope rts;
        lim.process(l.data() + pos, r.data() + pos, n);
      }
      pos += n;
    }
    const double res = mixtest::residualStereo(l, r, g.out);
    std::printf("    limiter/%s: residual %.1f dBFS\n", name, res);
    worst = std::fmax(worst, res);
  }
  OM_CHECK(worst < -80.0);
}

OM_TEST(mixer_limiter_settings_static_curve_and_makeup) {
  Limiter lim;
  lim.prepare(48000);
  const LimiterParams p;  // engine.js: -3 dB, knee 0, ratio 12, attack 2 ms, release 150 ms
  OM_CHECK(p.thresholdDb == -3.0f && p.kneeDb == 0.0f && p.ratio == 12.0f && p.attackSec == 0.002f &&
           p.releaseSec == 0.15f && p.preDelaySec == 0.006f);
  // makeup = (1 / Saturate(1)) ^ 0.6: Saturate(1) = -3 + 3/12 = -2.75 dB, so 0.6 x 2.75 = 1.65 dB
  OM_CHECK_NEAR(lim.makeupGainDb(), 1.65, 1e-3);
  for (double x : {-40.0, -20.0, -6.0, -3.5, -3.0, -1.0, 0.0, 3.0, 6.0, 12.0, 20.0}) {
    const double want = (x <= -3.0 ? x : -3.0 + (x + 3.0) / 12.0) + 1.65;
    OM_CHECK_NEAR(Limiter::staticCurveDb(x, p), want, 2e-3);
  }
  // look-ahead = Chromium's uniform pre-delay (truncated to frames): the master chain latency
  OM_CHECK(lim.latencyFrames() == 288);
  Limiter l44;
  l44.prepare(44100);
  OM_CHECK(l44.latencyFrames() == 264);
  Limiter l96;
  l96.prepare(96000);
  OM_CHECK(l96.latencyFrames() == 576);
}

OM_TEST(mixer_limiter_lookahead_linearity_and_gain_reduction) {
  const double rate = 48000;
  Limiter lim;
  lim.prepare(rate);
  // A fresh kernel starts with its detector at 0: like Chromium it "attacks"
  // on silence for a moment (the reading dips), then releases; the reading
  // releases with Chromium's 0.325 s metering time constant.
  std::vector<float> l(48000, 0.0f), r(48000, 0.0f);
  float dip = 0.0f;
  for (int s = 0; s < 4; s++) {
    for (int64_t pos = 0; pos < 48000; pos += 128) {
      rt::Scope rts;
      lim.process(l.data() + pos, r.data() + pos, 128);
      dip = std::fmin(dip, lim.gainReductionDb());
    }
  }
  std::printf("    start-up reading dip %.2f dB, after 4 s %.5f dB\n", dip, lim.gainReductionDb());
  OM_CHECK(dip < -1.0f);
  OM_CHECK(std::fabs(lim.gainReductionDb()) < 0.01f);
  // below the threshold the limiter is linear: an impulse comes out exactly
  // 288 frames later (the look-ahead), x the steady gain (makeup +1.65 dB), nothing else
  const double g = mixtest::steadyLimiterGain(rate);
  OM_CHECK_NEAR(20 * std::log10(g), 1.65, 1e-3);
  std::fill(l.begin(), l.end(), 0.0f);
  std::fill(r.begin(), r.end(), 0.0f);
  l[1000] = 0.5f;
  r[1000] = -0.25f;
  {
    rt::Scope rts;
    lim.process(l.data(), r.data(), 4096);
  }
  int at = -1, count = 0;
  for (int i = 0; i < 4096; i++)
    if (l[static_cast<size_t>(i)] != 0.0f) {
      at = i;
      count++;
    }
  OM_CHECK(count == 1 && at == 1000 + 288);
  OM_CHECK_NEAR(l[1288], 0.5 * g, 1e-6);
  OM_CHECK_NEAR(r[1288], -0.25 * g, 1e-6);
  // steady state of a +6 / +12 dBFS square wave (constant |x|): static curve and its gain reduction
  for (double db : {6.0, 12.0}) {
    Limiter q;
    q.prepare(rate);
    const float a = static_cast<float>(std::pow(10.0, db / 20.0));
    std::vector<float> sl(96000), sr(96000);
    for (size_t i = 0; i < sl.size(); i++) sl[i] = sr[i] = ((i / 120) & 1) ? a : -a;  // 200 Hz square
    {
      rt::Scope rts;
      q.process(sl.data(), sr.data(), 96000);
    }
    const double outDb = 20 * std::log10(std::fabs(sl[95000]));
    const double want = Limiter::staticCurveDb(db, LimiterParams());
    OM_CHECK_NEAR(outDb, want, 0.01);
    // metering = the compression alone; its instant attack holds the deepest
    // gain of the 32-frame envelope ripple (a hair below the static curve)
    OM_CHECK_NEAR(q.gainReductionDb(), want - db - q.makeupGainDb(), 0.05);
    std::printf("    %+.0f dBFS square: out %.3f dBFS (static %.3f), GR %.3f dB\n", db, outDb, want, q.gainReductionDb());
  }
}

OM_TEST(mixer_limiter_block_size_independent) {
  // the 32-frame divisions are carried over: any block sizes give the same samples
  const auto in = mixtest::noise(20000, 3.0f, 99);
  std::vector<float> a(in), b(in), ar(in), br(in);
  Limiter x, y;
  x.prepare(48000);
  y.prepare(48000);
  {
    rt::Scope rts;
    x.process(a.data(), ar.data(), 20000);
    int64_t pos = 0;
    int k = 0;
    while (pos < 20000) {
      int n = mixtest::blockSize(k++);
      if (pos + n > 20000) n = static_cast<int>(20000 - pos);
      y.process(b.data() + pos, br.data() + pos, n);
      pos += n;
    }
  }
  bool same = true;
  for (size_t i = 0; i < a.size(); i++) same &= a[i] == b[i] && ar[i] == br[i];
  OM_CHECK(same);
  OM_CHECK(x.gainReductionDb() == y.gainReductionDb());
}

OM_TEST(mixer_limiter_recovers_from_a_non_finite_input) {
  Limiter lim;
  lim.prepare(48000);
  std::vector<float> l = mixtest::sine(48000, 220, 0.3), r = l;
  l[5000] = std::nanf("");
  r[5001] = -INFINITY;
  l[6000] = 1e30f;
  {
    rt::Scope rts;
    for (int64_t pos = 0; pos < 48000; pos += 256)
      lim.process(l.data() + pos, r.data() + pos, static_cast<int>(std::min<int64_t>(256, 48000 - pos)));
  }
  bool finite = true;
  for (size_t i = 12000; i < l.size(); i++) finite &= std::isfinite(l[i]) && std::isfinite(r[i]);
  OM_CHECK(finite);
  OM_CHECK(std::isfinite(lim.gainReductionDb()));
  OM_CHECK(mixtest::rmsOf(l.data() + 40000, 8000) > 0.1);  // the music is back
}
