// Tests of the FX module (owner: fx): engine.js FxUnit defaults and pure
// formulas, type names, dry-cut table, the lazy-chain protocol, the shared
// convolver kernel and ConvolverNode normalization; the delay family (drift-
// free repeats on the beat, loops against an ideal reference, ping-pong
// pans, multi-tap taps, feedback taus), the modulation family (LFO rates,
// beat-clock phase lock, TRANS gate on the grid, the flanger's one-quantum
// feedback, pan law, filter depth, ring modulation, crush curve), unit
// semantics (wet tau, disabled = silent and frozen, type switches cut the old
// output and keep frozen tails, roll, 0.05 % rule, delay glide, silence until
// a lazy chain is attached, startup memory), real-time safety of every type
// and the CPU budget. Golden null tests: test_fx_golden.cpp; convolver:
// test_convolver.cpp. SPEC.md §11, §18.
#include <cstdio>
#include <memory>
#include <vector>

#include "../om_test.h"
#include "fx_test_util.h"
#include "om/color_fx.h"
#include "om/convolver.h"
#include "om/dsp.h"
#include "om/fx.h"
#include "om/rt.h"

using namespace om;
using fxtest::Stereo;

namespace {
constexpr double kSr = 48000.0;

// A unit prepared at `sr`, with every lazy chain attached when `attachAll`.
std::unique_ptr<FxUnit> makeUnit(double sr, std::shared_ptr<const ConvolverKernel> k = nullptr, bool attachAll = true) {
  auto u = std::make_unique<FxUnit>();
  u->prepare(sr, kMaxBlockFrames, std::move(k));
  if (attachAll) {
    for (int t = 0; t < kNumFxTypes; t++) {
      const FxType ft = static_cast<FxType>(t);
      if (!FxUnit::isLazy(ft)) continue;
      FxChainPtr c = u->makeChain(ft);
      OM_CHECK(c != nullptr);
      {
        rt::Scope rts;
        OM_CHECK(u->attachChain(ft, c.get()) == nullptr);
      }
      (void)c.release();
    }
  }
  return u;
}

BeatClock freeClock(double beatDur) {
  BeatClock bc;
  bc.valid = false;
  bc.playing = false;
  bc.beatDur = beatDur;
  return bc;
}

double fbFor(double base, double level) { return std::min(0.97, base * (0.55 + 0.45 * level)); }

const FxType kAllTypes[] = {FxType::Delay, FxType::Echo, FxType::Spiral, FxType::MtDelay, FxType::UpEcho,
                            FxType::DownEcho, FxType::LowCut, FxType::PingPong, FxType::Reverb, FxType::Flanger,
                            FxType::Phaser, FxType::Pan, FxType::Trans, FxType::Filter, FxType::Roll,
                            FxType::Robot, FxType::Helix, FxType::Crush};
}  // namespace

// ===========================================================================
// Defaults, names, lazy protocol, kernel (kept from the skeleton)
// ===========================================================================
OM_TEST(fx_unit_defaults_and_formulas) {
  FxUnit u;
  u.prepare(48000, kMaxBlockFrames, nullptr);
  OM_CHECK(u.type() == FxType::Echo && !u.enabled() && u.level() == 0.0f && u.beatsMult() == 0.5f);
  u.setType(FxType::Flanger);
  u.setBeatsMult(2.0f);
  OM_CHECK_NEAR(u.modPeriodBeats(), 16.0, 0);  // engine.js modPeriodBeats: flanger 8 * m
  u.setType(FxType::Echo);
  OM_CHECK_NEAR(u.modPeriodBeats(), 0.0, 0);
  BeatClock bc;
  bc.valid = true;
  bc.beatDur = 0.5;
  u.setBeatClock(bc);
  u.setBeatsMult(32.0f);
  OM_CHECK_NEAR(u.delayTimeSec(), 3.9, 1e-12);  // engine.js _timeNow clamp
  u.setBeatsMult(0.01f);
  OM_CHECK_NEAR(u.delayTimeSec(), 0.02, 1e-12);
}

OM_TEST(fx_type_names_and_dry_cut) {
  for (int i = 0; i < kNumFxTypes; i++) {
    FxType t;
    OM_CHECK(fxTypeFromName(fxTypeName(static_cast<FxType>(i)), t) && static_cast<int>(t) == i);
  }
  OM_CHECK(fxDryCut(FxType::Trans) == 1.0 && fxDryCut(FxType::Roll) == 0.0 && fxDryCut(FxType::Reverb) == 0.3);
  OM_CHECK(fxDryCut(FxType::Echo) == 0.45 && fxDryCut(FxType::Phaser) == 0.5);
  for (int i = 0; i < kNumColorTypes; i++) {
    ColorType t;
    OM_CHECK(colorTypeFromName(colorTypeName(static_cast<ColorType>(i)), t) && static_cast<int>(t) == i);
  }
}

OM_TEST(fx_lazy_chain_protocol) {
  // engine.js builds these on first use (engine.js:1151-1154); the others come with the unit
  for (FxType t : {FxType::Delay, FxType::PingPong, FxType::LowCut, FxType::Spiral, FxType::UpEcho, FxType::DownEcho,
                   FxType::Helix, FxType::MtDelay, FxType::Reverb})
    OM_CHECK(FxUnit::isLazy(t));
  for (FxType t : {FxType::Echo, FxType::Flanger, FxType::Phaser, FxType::Trans, FxType::Pan, FxType::Filter,
                   FxType::Robot, FxType::Crush, FxType::Roll})
    OM_CHECK(!FxUnit::isLazy(t));
  FxUnit u;
  u.prepare(48000, kMaxBlockFrames, nullptr);
  OM_CHECK(u.makeChain(FxType::Echo) == nullptr);
  OM_CHECK(!u.hasChain(FxType::Delay) && u.hasChain(FxType::Echo));
  FxChainPtr a = u.makeChain(FxType::Delay);  // control thread
  FxChainPtr b = u.makeChain(FxType::Delay);
  OM_CHECK(a && b);
  {
    rt::Scope rts;  // attaching is an audio-thread operation: no allocation, no free
    OM_CHECK(u.attachChain(FxType::Delay, a.get()) == nullptr);   // taken: the unit owns it now
    OM_CHECK(u.attachChain(FxType::Delay, b.get()) == b.get());   // slot filled: refused, caller retires it
  }
  (void)a.release();
  OM_CHECK(u.hasChain(FxType::Delay));
  ColorFx c;
  c.prepare(48000, kMaxBlockFrames, nullptr);
  OM_CHECK(ColorFx::isLazy(ColorType::DubEcho) && ColorFx::isLazy(ColorType::Reverb) && !ColorFx::isLazy(ColorType::Crush));
  FxChainPtr ce = c.makeChain(ColorType::HpfEcho);
  OM_CHECK(ce && c.attachChain(ColorType::HpfEcho, ce.get()) == nullptr);
  (void)ce.release();
  OM_CHECK(c.hasChain(ColorType::HpfEcho) && !c.hasChain(ColorType::LpfEcho));
  // A chain of the wrong type, or a color chain, is refused.
  FxChainPtr wrong = u.makeChain(FxType::Helix);
  OM_CHECK(u.attachChain(FxType::LowCut, wrong.get()) == wrong.get());
  FxChainPtr colorChain = c.makeChain(ColorType::DubEcho);
  OM_CHECK(u.attachChain(FxType::Delay, colorChain.get()) == colorChain.get());
}

OM_TEST(convolver_kernel_is_shared_and_normalization_is_chromium) {
  // constant impulse of power p: scale = (1 / p) * 10^(-58/20) * 44100 / rate
  std::vector<float> l(1000, 0.5f), r(1000, 0.5f);
  const float s = convolverNormalizationScale(l, r, 48000);
  OM_CHECK_NEAR(s, (1.0 / 0.5) * std::pow(10.0, -58.0 / 20.0) * 44100.0 / 48000.0, 1e-7);
  std::vector<float> z(1000, 0.0f);
  OM_CHECK_NEAR(convolverNormalizationScale(z, z, 44100), (1.0 / 0.000125) * std::pow(10.0, -58.0 / 20.0), 1e-3);
  std::shared_ptr<const ConvolverKernel> k = ConvolverKernel::build(makeImpulse(2.2, 2.5, 48000, 1), kMaxBlockFrames);
  Convolver a, b;
  a.prepare(k, kMaxBlockFrames);
  b.prepare(k, kMaxBlockFrames);
  OM_CHECK(k.use_count() >= 3);  // one kernel, two instances
  OM_CHECK(a.latencyFrames() == 0);
}

// ===========================================================================
// Delay family
// ===========================================================================
OM_TEST(fx_delay_family_repeats_land_on_the_beat) {
  // 124 BPM, 1/4 beat = 5806.45 frames (fractional). Chromium would put
  // repeat k at k * D + (k - 1) * 128 (2.67 ms of drift per repeat): the
  // native loops put it at k * D (SPEC.md §20).
  const double beatDur = 60.0 / 124.0;
  const double D = static_cast<double>(static_cast<float>(beatDur * 0.25)) * kSr;
  struct Case { FxType t; int repeats; double fb; };
  for (const Case& cs : {Case{FxType::Delay, 7, 0.22}, Case{FxType::Helix, 24, 0.97}}) {
    auto u = makeUnit(kSr);
    u->setBeatClock(freeClock(beatDur));  // the core sets the clock every block: the chain is born on time
    u->setType(cs.t);
    u->setBeatsMult(0.25f);
    u->setLevel(1.0f);
    u->setEnabled(true);
    const size_t at = 24000;
    const size_t frames = at + static_cast<size_t>((cs.repeats + 1) * D) + 2000;
    const Stereo in = fxtest::impulse(frames, at);
    const Stereo out = fxtest::run(*u, in, 256, [&](size_t, int) { u->setBeatClock(freeClock(beatDur)); });
    double prevSum = 0;
    double worstPeak = 0, worstCentroid = 0;
    for (int k = 1; k <= cs.repeats; k++) {
      const double expected = static_cast<double>(at) + k * D;
      const size_t a = static_cast<size_t>(expected) - 60, b = static_cast<size_t>(expected) + 60;
      const double c = fxtest::centroid(out.l, a, b);
      const size_t p = fxtest::argMaxAbs(out.l, a, b);
      worstCentroid = std::max(worstCentroid, std::fabs(c - expected));
      worstPeak = std::max(worstPeak, std::fabs(static_cast<double>(p) - expected));
      double sum = 0;
      for (size_t i = a; i < b; i++) sum += out.l[i];
      if (k >= 3) OM_CHECK_NEAR(sum / prevSum, cs.fb, 1e-4);  // one feedback gain per repeat
      prevSum = sum;
    }
    std::printf("    %s: %d repeats, worst centroid error %.2e frames, worst peak offset %.2f frames\n",
                fxTypeName(cs.t), cs.repeats, worstCentroid, worstPeak);
    // Chromium reads delays at single-precision positions (<= 1/64 frame per trip, fx_dsp.h): far below a sample.
    OM_CHECK(worstCentroid < 0.25);
    OM_CHECK(worstPeak <= 1.0);
  }
}

OM_TEST(fx_delay_family_matches_ideal_loops) {
  // Integer delay (0.25 s = 12000 frames): every loop type against the ideal
  // drift-free loop with the same filter, feedback fbFor(base) and tap.
  struct Case { FxType t; double base; bool filter; dsp::BiquadType bt; float f, q; bool outFilter; };
  using BT = dsp::BiquadType;
  const Case cases[] = {
      {FxType::Echo, 0.45, true, BT::Highpass, 120.0f, 1.0f, false},
      {FxType::Delay, 0.22, false, BT::Highpass, 0, 0, false},
      {FxType::LowCut, 0.5, true, BT::Highpass, 700.0f, 1.0f, false},
      {FxType::Spiral, 0.72, true, BT::Bandpass, 900.0f, 0.9f, true},
      {FxType::UpEcho, 0.5, true, BT::Highpass, 500.0f, 1.0f, true},
      {FxType::DownEcho, 0.5, true, BT::Lowpass, 1200.0f, 1.0f, true},
      {FxType::Helix, 0.97, false, BT::Highpass, 0, 0, false},
  };
  const float level = 0.8f;
  const size_t start = 72000, frames = 240000;
  const Stereo in = fxtest::noise(frames, 77, 0.5f, start, start + 14400);
  for (const Case& cs : cases) {
    auto u = makeUnit(kSr);
    u->setType(cs.t);
    u->setBeatsMult(0.5f);
    u->setLevel(level);
    u->setEnabled(true);
    const Stereo out = fxtest::run(*u, in, 128, [&](size_t, int) { u->setBeatClock(freeClock(0.5)); });
    fxtest::RefLoop ref;
    ref.frames = 12000;
    ref.g = static_cast<float>(fbFor(cs.base, level));
    ref.hasFilter = cs.filter;
    ref.outFilter = cs.outFilter;
    if (cs.filter) ref.c = dsp::webAudioBiquad(cs.bt, kSr, cs.f, cs.q, 0.0);
    std::vector<float> rl = ref.run(in.l), rr = ref.run(in.r);
    Stereo expect(frames);
    for (size_t i = 0; i < frames; i++) {
      expect.l[i] = rl[i] * level;
      expect.r[i] = rr[i] * level;
    }
    const double err = fxtest::maxDiff(out, expect, start);
    std::printf("    %s: max |native - ideal| = %.3g (%.1f dB), feedback %.4f\n", fxTypeName(cs.t), err, fxtest::db(err),
                ref.g);
    OM_CHECK(err < 1e-6);
    OM_CHECK(fxtest::maxAbs(out.l, start + 12000, start + 14000) > 0.01);  // the first repeat is there
  }
}

OM_TEST(fx_pingpong_alternates_with_the_engine_js_pans) {
  auto u = makeUnit(kSr);
  u->setType(FxType::PingPong);
  u->setBeatsMult(0.5f);
  u->setLevel(0.8f);
  u->setEnabled(true);
  const size_t at = 48000;
  const Stereo in = fxtest::impulse(at + 5 * 12000 + 100, at);
  const Stereo out = fxtest::run(*u, in, 256, [&](size_t, int) { u->setBeatClock(freeClock(0.5)); });
  const double g = static_cast<float>(fbFor(0.42, 0.8));
  const double wet = 0.8f;
  // StereoPanner(-0.85) and (+0.85) on a centred impulse (L = R = 1)
  const double cL = std::cos(0.15 * kPi / 2), sL = std::sin(0.15 * kPi / 2);
  const double cR = std::cos(0.85 * kPi / 2), sR = std::sin(0.85 * kPi / 2);
  for (int k = 1; k <= 4; k++) {
    const size_t p = at + static_cast<size_t>(k) * 12000;
    const double gain = wet * std::pow(g, (k - 1) / 2);
    if (k % 2 == 1) {  // left line tap, panned -0.85
      OM_CHECK_NEAR(out.l[p], gain * (1 + cL), 1e-5);
      OM_CHECK_NEAR(out.r[p], gain * sL, 1e-5);
    } else {  // right line tap (left delayed once more), panned +0.85
      OM_CHECK_NEAR(out.l[p], gain * cR, 1e-5);
      OM_CHECK_NEAR(out.r[p], gain * (1 + sR), 1e-5);
    }
    OM_CHECK(std::fabs(out.l[p - 1]) < 1e-9 && std::fabs(out.l[p + 1]) < 1e-9);
  }
}

OM_TEST(fx_mtdelay_has_three_taps_and_no_feedback) {
  auto u = makeUnit(kSr);
  u->setType(FxType::MtDelay);
  u->setBeatsMult(0.5f);
  u->setLevel(1.0f);
  u->setEnabled(true);
  const size_t at = 48000;
  const Stereo in = fxtest::impulse(at + 5 * 12000, at);
  const Stereo out = fxtest::run(*u, in, 128, [&](size_t, int) { u->setBeatClock(freeClock(0.5)); });
  const double taps[] = {0.8, 0.55, 0.35};
  for (int k = 1; k <= 3; k++) OM_CHECK_NEAR(out.l[at + static_cast<size_t>(k) * 12000], taps[k - 1], 1e-6);
  OM_CHECK(fxtest::maxAbs(out.l, at + 3 * 12000 + 10) == 0.0);  // no 4th repeat
}

OM_TEST(fx_feedback_and_depth_follow_level_with_tau_50ms) {
  auto u = makeUnit(kSr);
  u->setType(FxType::Echo);
  u->setEnabled(true);
  OM_CHECK_NEAR(u->feedbackGain(), 0.45, 1e-7);  // echoFb.gain.value = 0.45 until the first setLevel
  u->setLevel(0.0f);                              // fbFor(0.45) at level 0 = 0.2475
  const Stereo in(2400);                          // 50 ms
  fxtest::run(*u, in, 128);
  // (the probe reports the value at the last processed frame: 2399 steps after the event)
  OM_CHECK_NEAR(u->feedbackGain(), 0.2475 + (0.45 - 0.2475) * std::exp(-2399.0 / 2400.0), 2e-6);
  u->setType(FxType::Flanger);  // flFb: 0.4 -> 0.15 + 0.5 * level
  fxtest::run(*u, in, 128);
  // not routed while the echo ran: like Chromium, the event starts when the
  // flanger is first processed (value 0.4 there), 2399 steps later here
  OM_CHECK_NEAR(u->feedbackGain(), 0.15 + (0.4 - 0.15) * std::exp(-2399.0 / 2400.0), 2e-6);
  // A lazily built chain is born with fbFor(base) at the current level (no glide).
  u->setLevel(1.0f);
  u->setType(FxType::Spiral);
  fxtest::run(*u, Stereo(16), 16);
  OM_CHECK_NEAR(u->feedbackGain(), 0.72, 1e-6);
}

OM_TEST(fx_delay_time_glides_tau_80ms_and_lazy_chains_are_born_in_time) {
  auto u = makeUnit(kSr);
  u->setType(FxType::Echo);
  u->setEnabled(true);
  u->setBeatClock(freeClock(0.5));
  OM_CHECK_NEAR(u->lineDelaySec(), 0.25, 1e-12);  // echoDelay.delayTime.value = 0.25
  u->setBeatsMult(1.0f);                          // _applyTime: target 0.5, tau 80 ms
  fxtest::run(*u, Stereo(3840), 128);             // 80 ms
  // Chromium's stereo DelayNode computes the automation once per channel
  // kernel: the recursion advances 256 steps per 128-frame quantum (left:
  // the first 128, right: the next; at the event's start quantum both start
  // from the initial value): the left channel's value at frame 3839
  // (quantum 29, offset 127) is step 256 x 29 - 128 + 127 = 7423
  // (fx::Param::atKernel; pinned by goldens/fxunit echo_l1_b0.25).
  OM_CHECK_NEAR(u->lineDelaySec(), 0.5 + (0.25 - 0.5) * std::exp(-7423.0 / 3840.0), 2e-6);
  // engine.js _timeNow: a chain built later starts at the current time (no slide)
  u->setType(FxType::Delay);
  fxtest::run(*u, Stereo(1), 1);
  OM_CHECK_NEAR(u->lineDelaySec(), 0.5, 1e-12);
}

OM_TEST(fx_beat_duration_follows_the_005_percent_rule) {
  auto u = makeUnit(kSr, nullptr, false);
  u->setBeatClock(freeClock(0.5 * 1.0004));
  OM_CHECK(u->beatDuration() == 0.5);  // < 0.05 %: ignored
  u->setBeatClock(freeClock(0.5 * 1.0006));
  OM_CHECK_NEAR(u->beatDuration(), 0.5 * 1.0006, 1e-15);
  u->setBeatsMult(2.0f);
  OM_CHECK_NEAR(u->delayTimeSec(), 0.5 * 1.0006 * 2, 1e-12);
  u->setBeatClock(freeClock(0.0));  // invalid durations are ignored
  OM_CHECK_NEAR(u->beatDuration(), 0.5 * 1.0006, 1e-15);
}

// ===========================================================================
// Modulation family
// ===========================================================================
OM_TEST(fx_lfo_rates_follow_engine_js_clamps_and_taus) {
  struct Case { FxType t; double k, lo, hi, tau; };
  const Case cases[] = {{FxType::Trans, 1.0, 0.25, 24, 0.05},
                        {FxType::Flanger, 0.125, 0.05, 4, 0.1},
                        {FxType::Phaser, 0.25, 0.05, 6, 0.1},
                        {FxType::Pan, 0.5, 0.05, 8, 0.1},
                        {FxType::Filter, 0.5, 0.05, 8, 0.1}};
  for (const Case& cs : cases) {
    for (float m : {0.25f, 1.0f, 8.0f, 32.0f}) {
      auto u = makeUnit(kSr, nullptr, false);
      u->setType(cs.t);
      u->setEnabled(true);
      u->setLevel(1.0f);
      u->setBeatsMult(m);
      fxtest::run(*u, Stereo(96000), 512, [&](size_t, int) { u->setBeatClock(freeClock(0.5)); });
      const double t = std::min(std::max(0.5 * m, 0.02), 3.9);
      const double want = std::min(std::max(cs.k / t, cs.lo), cs.hi);
      OM_CHECK_NEAR(u->lfoRateHz(), want, 1e-7 * want);  // converged (10 time constants): the float target
      // a beat change glides with the engine.js tau
      const double from = u->lfoRateHz();
      u->setBeatsMult(m * 2);
      const double t2 = std::min(std::max(0.5 * m * 2, 0.02), 3.9);
      const double want2 = std::min(std::max(cs.k / t2, cs.lo), cs.hi);
      const int n = static_cast<int>(cs.tau * kSr);
      fxtest::run(*u, Stereo(static_cast<size_t>(n)), 128, [&](size_t, int) { u->setBeatClock(freeClock(0.5)); });
      OM_CHECK_NEAR(u->lfoRateHz(), want2 + (from - want2) * std::exp(-(n - 1.0) / n), 1e-5 * std::max(1.0, want2));
    }
  }
}

OM_TEST(fx_lfo_phase_is_locked_to_the_beat_clock) {
  struct Case { FxType t; double P; };
  // beatsMult 0.5: trans m, flanger 8m, phaser 4m, pan/filter 2m
  for (const Case& cs : {Case{FxType::Trans, 0.5}, Case{FxType::Flanger, 4.0}, Case{FxType::Phaser, 2.0},
                         Case{FxType::Pan, 1.0}, Case{FxType::Filter, 1.0}}) {
    auto u = makeUnit(kSr, nullptr, false);
    u->setType(cs.t);
    u->setEnabled(true);
    u->setLevel(1.0f);
    u->setBeatsMult(0.5f);
    BeatClock bc;
    bc.valid = true;
    bc.playing = true;
    bc.beatDur = 60.0 / 126.0;
    bc.beatsPerSec = 126.0 / 60.0;
    bc.beatPos = 3.3;
    const double G = cs.P < 1 ? cs.P : std::min(cs.P, 4.0);
    const double boundary = std::ceil(3.3 / G + 1e-6) * G;  // engine.js nextBoundaryAt
    double lockedAt = -1;
    double worst = 0;
    for (int b = 0; b < 1000; b++) {
      const int n = 256;
      u->setBeatClock(bc);
      const bool was = u->lfoLocked();
      fxtest::run(*u, Stereo(static_cast<size_t>(n)), n);
      const double next = bc.beatPos + bc.beatsPerSec * n / kSr;
      if (!was && u->lfoLocked()) lockedAt = bc.beatPos;
      if (u->lfoLocked()) {
        double want = next / cs.P;
        want -= std::floor(want);
        double d = std::fabs(u->lfoPhase() - want);
        d = std::min(d, 1.0 - d);
        worst = std::max(worst, d);
      }
      bc.beatPos = next;
      if (b == 600) bc.beatPos += 7.37;  // a jump (hot cue): the phase follows at once
    }
    OM_CHECK(lockedAt >= 0);
    OM_CHECK(lockedAt <= boundary && boundary < lockedAt + bc.beatsPerSec * 256 / kSr + 1e-9);
    std::printf("    %s: locked at beat %.4f (boundary %.4f), worst phase error %.2e cycle\n", fxTypeName(cs.t), lockedAt,
                boundary, worst);
    OM_CHECK(worst < 1e-6);
    // Reference deck stopped: free-running; playing again: re-locked at the next boundary.
    bc.playing = false;
    u->setBeatClock(bc);
    fxtest::run(*u, Stereo(256), 256);
    OM_CHECK(!u->lfoLocked());
  }
}

OM_TEST(fx_trans_gate_opens_on_the_beat_grid) {
  auto u = makeUnit(kSr, nullptr, false);
  u->setType(FxType::Trans);
  u->setEnabled(true);
  u->setLevel(1.0f);
  u->setBeatsMult(0.5f);
  BeatClock bc;
  bc.valid = true;
  bc.playing = true;
  bc.beatDur = 60.0 / 124.0;
  bc.beatsPerSec = 124.0 / 60.0;
  bc.beatPos = 0.1;
  const size_t frames = 4 * 48000;
  const Stereo in = fxtest::constant(frames, 1.0f);
  std::vector<double> beatAt(frames);
  Stereo out = fxtest::run(*u, in, 256, [&](size_t i, int n) {
    BeatClock c = bc;
    c.beatPos = bc.beatPos + bc.beatsPerSec * static_cast<double>(i) / kSr;
    for (int k = 0; k < n; k++) beatAt[i + static_cast<size_t>(k)] = c.beatPos + bc.beatsPerSec * k / kSr;
    u->setBeatClock(c);
  });
  // gate = 0.5 + 0.5 * square: crosses 0.5 where the square crosses zero,
  // i.e. on every half period (P = 0.5 beat -> every 0.25 beat).
  int edges = 0;
  double worst = 0;
  for (size_t i = 48000; i + 1 < frames; i++) {
    const double a = out.l[i] - 0.5, b = out.l[i + 1] - 0.5;
    if ((a < 0) != (b < 0)) {  // the Gibbs ripples of the plateaus never reach 0.5
      const double frac = a / (a - b);
      const double beat = beatAt[i] + frac * (beatAt[i + 1] - beatAt[i]);
      const double grid = std::round(beat / 0.25) * 0.25;
      worst = std::max(worst, std::fabs(beat - grid) / bc.beatsPerSec * kSr);
      edges++;
    }
  }
  std::printf("    %d gate edges, worst offset from the 1/4-beat grid %.3f frames\n", edges, worst);
  OM_CHECK(edges >= 20);
  OM_CHECK(worst < 1.0);
  // Chromium's square is band-limited and normalized to its Gibbs peak:
  // open ~0.92, closed ~0.08, never a hard 1 / 0 (trans is a gain, not a gate).
  double open = 0, closed = 1;
  for (size_t i = 96000; i < frames; i++) {
    open = std::max(open, static_cast<double>(out.l[i]));
    closed = std::min(closed, static_cast<double>(out.l[i]));
  }
  OM_CHECK(open > 0.95 && open <= 1.0 + 1e-6);
  OM_CHECK(closed < 0.05 && closed >= -1e-6);
}

OM_TEST(fx_flanger_feedback_keeps_one_render_quantum) {
  // Chromium processes the flanger's DelayNode cycle one render quantum late:
  // the feedback copy of an impulse comes 128 frames + one delay after the
  // first copy. That quantum is part of the flanger's sound and is kept.
  auto u = makeUnit(kSr, nullptr, false);
  u->setType(FxType::Flanger);
  u->setEnabled(true);
  u->setLevel(1.0f);
  u->setBeatsMult(32.0f);  // LFO 0.05 Hz: the delay hardly moves over 20 ms
  const size_t at = 48000;
  const Stereo in = fxtest::impulse(at + 2000, at);
  const Stereo out = fxtest::run(*u, in, 128, [&](size_t, int) { u->setBeatClock(freeClock(0.5)); });
  const double c1 = fxtest::centroid(out.l, at + 80, at + 320);
  const double d1 = c1 - at;  // first copy: one delay (4 ms +- 2.2 ms)
  OM_CHECK(d1 > 0.0018 * kSr - 1 && d1 < 0.0062 * kSr + 1);
  const size_t from = static_cast<size_t>(c1) + 128 + 60;
  const double c2 = fxtest::centroid(out.l, from, from + 320);
  const double extra = (c2 - c1) - d1;
  std::printf("    first copy %.2f frames, second copy +%.2f frames, extra %.2f frames\n", d1, c2 - c1, extra);
  OM_CHECK_NEAR(extra, 128.0, 1.5);
  double s1 = 0, s2 = 0;
  for (size_t i = at + 80; i < at + 320; i++) s1 += out.l[i];
  for (size_t i = from; i < from + 320; i++) s2 += out.l[i];
  OM_CHECK_NEAR(s2 / s1, 0.65, 1e-3);  // flanger feedback 0.15 + 0.5 * level
}

OM_TEST(fx_pan_follows_the_stereo_panner_law) {
  auto u = makeUnit(kSr, nullptr, false);
  u->setType(FxType::Pan);
  u->setEnabled(true);
  u->setLevel(1.0f);
  u->setBeatsMult(1.0f);  // LFO 1 Hz
  const size_t frames = 3 * 48000;
  const Stereo out = fxtest::run(*u, fxtest::constant(frames, 0.5f), 256, [&](size_t, int) { u->setBeatClock(freeClock(0.5)); });
  double maxL = 0, minL = 1, maxR = 0, minR = 1;
  for (size_t i = 48000; i < frames; i++) {
    maxL = std::max(maxL, static_cast<double>(out.l[i]));
    minL = std::min(minL, static_cast<double>(out.l[i]));
    maxR = std::max(maxR, static_cast<double>(out.r[i]));
    minR = std::min(minR, static_cast<double>(out.r[i]));
  }
  const double hi = 0.5 * (1 + std::sin(0.45 * kPi)), lo = 0.5 * std::cos(0.45 * kPi);  // pan +-0.9
  OM_CHECK_NEAR(maxL, hi, 2e-4);
  OM_CHECK_NEAR(maxR, hi, 2e-4);
  OM_CHECK_NEAR(minL, lo, 2e-4);
  OM_CHECK_NEAR(minR, lo, 2e-4);
}

OM_TEST(fx_filter_sweep_depth_follows_level) {
  // 800 Hz through the BPF (Q 1.4) whose centre sweeps 800 +- depth: the
  // lowest gain of the sweep tells the depth 650 * (0.35 + 0.65 * level).
  for (float level : {1.0f, 0.5f}) {
    auto u = makeUnit(kSr, nullptr, false);
    u->setType(FxType::Filter);
    u->setEnabled(true);
    u->setLevel(level);
    u->setBeatsMult(4.0f);  // 0.25 Hz
    const size_t frames = 6 * 48000;
    Stereo in(frames);
    for (size_t i = 0; i < frames; i++) in.l[i] = in.r[i] = static_cast<float>(std::sin(2 * kPi * 800.0 * i / kSr));
    const Stereo out = fxtest::run(*u, in, 256, [&](size_t, int) { u->setBeatClock(freeClock(0.5)); });
    double minEnv = 1e9;
    for (size_t w = 48000; w + 960 <= frames; w += 480) minEnv = std::min(minEnv, fxtest::maxAbs(out.l, w, w + 960));
    const double depth = 650.0 * (0.35 + 0.65 * level);
    auto gainAt = [](double fc) {
      const double x = 1.4 * (800.0 / fc - fc / 800.0);
      return 1.0 / std::sqrt(1 + x * x);
    };
    const double want = level * std::min(gainAt(800 - depth), gainAt(800 + depth));
    std::printf("    level %.2f: lowest gain %.4f, expected %.4f\n", level, minEnv, want);
    OM_CHECK_NEAR(minEnv, want, 0.02 * want);
  }
}

OM_TEST(fx_robot_is_a_35hz_ring_modulator_and_crush_follows_crushcurve8) {
  auto u = makeUnit(kSr, nullptr, false);
  u->setType(FxType::Robot);
  u->setEnabled(true);
  u->setLevel(1.0f);
  const size_t frames = 48000;
  const Stereo out = fxtest::run(*u, fxtest::constant(frames, 0.5f), 256);
  std::vector<double> ups;
  for (size_t i = 24000; i + 1 < frames; i++)
    if (out.l[i] < 0 && out.l[i + 1] >= 0) ups.push_back(i + out.l[i] / (out.l[i] - out.l[i + 1]));
  OM_CHECK(ups.size() >= 10);
  const double period = (ups.back() - ups.front()) / static_cast<double>(ups.size() - 1);
  OM_CHECK_NEAR(period, kSr / 35.0, 0.01);
  OM_CHECK_NEAR(fxtest::maxAbs(out.l, 24000), 0.5, 1e-4);
  // crush: WaveShaper(crushCurve(8)), input clamped to [-1, 1]
  u->setType(FxType::Crush);
  const float xs[] = {0.3f, -0.07f, 0.5f, 1.5f, -1.5f, 0.0f, 0.0624f, 0.0626f};
  Stereo in(8);
  for (int i = 0; i < 8; i++) in.l[static_cast<size_t>(i)] = in.r[static_cast<size_t>(i)] = xs[i];
  const Stereo o = fxtest::run(*u, in, 8);
  const double want[] = {0.25, -0.125, 0.5, 1.0, -1.0, 0.0, 0.0, 0.0};
  for (int i = 0; i < 6; i++) OM_CHECK_NEAR(o.l[static_cast<size_t>(i)], want[i], 1e-7);
  OM_CHECK(o.l[7] > 0.0f && o.l[7] < 0.125f);  // between two curve points: interpolated
}

// ===========================================================================
// Unit semantics
// ===========================================================================
OM_TEST(fx_wet_gain_follows_level_with_tau_20ms) {
  auto u = makeUnit(kSr, nullptr, false);
  u->setType(FxType::Crush);  // crush(0.5) == 0.5: the output is 0.5 * wet
  u->setEnabled(true);
  u->setLevel(1.0f);
  const Stereo out = fxtest::run(*u, fxtest::constant(9600, 0.5f), 128);
  double worst = 0;
  for (size_t k = 0; k < 9600; k++) worst = std::max(worst, std::fabs(out.l[k] / 0.5 - (1.0 - std::exp(-(double)k / 960.0))));
  std::printf("    wet curve vs 1 - exp(-t / 20 ms): worst %.2e\n", worst);
  OM_CHECK(worst < 1e-4);  // Chromium's float recursion (a tau off by 1 % would be ~4e-3)
  OM_CHECK_NEAR(u->wetGain(), 1.0 - std::exp(-9599.0 / 960.0), 1e-4);
  // Disabled: no output, the wet gain keeps following its automation (always connected).
  u->setLevel(0.25f);
  u->setEnabled(false);
  const Stereo off = fxtest::run(*u, fxtest::constant(9600, 0.5f), 128);
  OM_CHECK(fxtest::maxAbs(off.l) == 0.0 && fxtest::maxAbs(off.r) == 0.0);
  OM_CHECK_NEAR(u->wetGain(), 0.25, 1e-4);
}

OM_TEST(fx_disabled_is_silent_and_frozen_type_switch_cuts_and_keeps_tails) {
  // B: an undisturbed echo. A: same input, but disabled for 1 s at 0.8 s,
  // or switched to another type and back: the echo tail resumes exactly
  // where it stopped (a disconnected Web Audio cycle is not processed).
  const size_t at = 24000, stop = 38400, pause = 48000, tail = 60000;
  const Stereo in = fxtest::noise(stop, 5, 0.5f, at, at + 2400);
  auto setup = [&](FxUnit& u) {
    u.setType(FxType::Echo);
    u.setBeatsMult(0.5f);
    u.setLevel(0.8f);
    u.setEnabled(true);
  };
  auto B = makeUnit(kSr);
  setup(*B);
  Stereo inB(stop + tail);
  std::copy(in.l.begin(), in.l.end(), inB.l.begin());
  std::copy(in.r.begin(), in.r.end(), inB.r.begin());
  const Stereo outB = fxtest::run(*B, inB, 128);
  Stereo expect(tail);
  for (size_t i = 0; i < tail; i++) {
    expect.l[i] = outB.l[stop + i];
    expect.r[i] = outB.r[stop + i];
  }
  OM_CHECK(fxtest::maxAbs(expect.l) > 0.01);
  for (int variant = 0; variant < 3; variant++) {
    auto A = makeUnit(kSr);
    setup(*A);
    fxtest::run(*A, in, 128);
    if (variant == 0) A->setEnabled(false);
    if (variant == 1) A->setType(FxType::Delay);  // a lazy chain: born, fed silence
    if (variant == 2) A->setType(FxType::Roll);
    const Stereo gap = fxtest::run(*A, fxtest::noise(pause, 9, 0.5f), 128);
    if (variant != 1) OM_CHECK(fxtest::maxAbs(gap.l) == 0.0 && fxtest::maxAbs(gap.r) == 0.0);
    if (variant == 1) OM_CHECK(fxtest::maxAbs(gap.l) > 0.0);  // the delay chain processes its own input
    // the old chain's output is cut at once: nothing of the echo tail in the gap
    if (variant == 0) A->setEnabled(true);
    A->setType(FxType::Echo);
    const Stereo resumed = fxtest::run(*A, Stereo(tail), 128);
    const double err = fxtest::maxDiff(resumed, expect);
    std::printf("    variant %d: resumed tail vs undisturbed %.3g\n", variant, err);
    OM_CHECK(err < 1e-7);
  }
}

OM_TEST(fx_roll_is_silent) {
  auto u = makeUnit(kSr);
  u->setType(FxType::Roll);
  u->setEnabled(true);
  u->setLevel(1.0f);
  const Stereo out = fxtest::run(*u, fxtest::noise(9600, 3, 0.8f), 256);
  OM_CHECK(fxtest::maxAbs(out.l) == 0.0 && fxtest::maxAbs(out.r) == 0.0);
  OM_CHECK(u->wetGain() > 0.9f);  // the level is the deck's roll mix: the wet still follows it
}

OM_TEST(fx_silence_until_the_lazy_chain_is_attached) {
  auto u = makeUnit(kSr, nullptr, false);
  u->setType(FxType::Delay);
  u->setBeatsMult(0.25f);
  u->setLevel(1.0f);
  u->setEnabled(true);
  const Stereo in = fxtest::noise(24000, 11, 0.5f, 0, 4800);
  const Stereo before = fxtest::run(*u, in, 256);
  OM_CHECK(fxtest::maxAbs(before.l) == 0.0);
  FxChainPtr c = u->makeChain(FxType::Delay);
  {
    rt::Scope rts;
    OM_CHECK(u->attachChain(FxType::Delay, c.get()) == nullptr);
  }
  (void)c.release();
  const Stereo after = fxtest::run(*u, in, 256);
  OM_CHECK(fxtest::maxAbs(after.l, 6000) > 0.05);  // first repeat at 0.125 s
}

OM_TEST(fx_startup_memory_is_the_always_present_parts_only) {
  FxUnit u;
  u.prepare(kSr, kMaxBlockFrames, nullptr);
  const size_t base = u.memoryBytes();
  const size_t echoLine = 2 * (static_cast<size_t>(std::ceil(4.0 * kSr)) + 128) * sizeof(float);  // createDelay(4): Chromium length
  std::printf("    FxUnit at 48 kHz: %zu bytes at startup (echo line %zu)\n", base, echoLine);
  OM_CHECK(base >= echoLine && base < echoLine + 64 * 1024);  // echo line + flanger 50 ms + small parts
  for (int t = 0; t < kNumFxTypes; t++)
    if (FxUnit::isLazy(static_cast<FxType>(t))) OM_CHECK(!u.hasChain(static_cast<FxType>(t)));
  auto kernel = ConvolverKernel::build(makeImpulse(2.2, 2.5, 48000, 7), kMaxBlockFrames);
  auto full = makeUnit(kSr, kernel);
  std::printf("    with every lazy chain attached: %zu bytes; shared 2.2 s kernel %zu bytes\n", full->memoryBytes(),
              kernel->memoryBytes());
  // delay, lowcut, spiral, upecho, downecho, helix: 1 line; pingpong 2; mtdelay 3
  OM_CHECK(full->memoryBytes() >= base + 11 * echoLine);
  ColorFx c;
  c.prepare(kSr, kMaxBlockFrames, nullptr);
  std::printf("    ColorFx at startup: %zu bytes\n", c.memoryBytes());
  OM_CHECK(c.memoryBytes() < 32 * 1024);
}

OM_TEST(fx_every_type_is_realtime_safe) {
  // Every type, type switches, enable toggles, level / beat changes and a
  // moving locked clock, with all chains attached: process() never allocates
  // nor frees (the runner fails the test otherwise), never outputs NaN.
  auto kernel = ConvolverKernel::build(makeImpulse(2.2, 2.5, 48000, 3), kMaxBlockFrames);
  auto u = makeUnit(kSr, kernel);
  u->setEnabled(true);
  u->setLevel(0.9f);
  const Stereo in = fxtest::noise(4096, 21, 0.7f);
  Stereo out(4096);
  BeatClock bc;
  bc.valid = true;
  bc.playing = true;
  bc.beatDur = 0.47;
  bc.beatsPerSec = 1 / 0.47;
  bool finite = true;
  for (int round = 0; round < 3; round++) {
    for (FxType t : kAllTypes) {
      rt::Scope rts;
      u->setType(t);
      u->setBeatsMult(round == 0 ? 0.25f : (round == 1 ? 1.0f : 8.0f));
      for (int b = 0; b < 16; b++) {
        const int n = (b * 37) % 256 + 1;
        u->setBeatClock(bc);
        u->process(in.l.data(), in.r.data(), out.l.data(), out.r.data(), n);
        bc.beatPos += bc.beatsPerSec * n / kSr;
        for (int i = 0; i < n; i++) finite = finite && std::isfinite(out.l[static_cast<size_t>(i)]);
        if (b == 8) u->setEnabled(false);
        if (b == 10) u->setEnabled(true);
      }
      u->reset();
    }
  }
  OM_CHECK(finite);
  ColorFx c;
  auto ck = ConvolverKernel::build(makeImpulse(2.8, 2.2, 48000, 4), kMaxBlockFrames);
  c.prepare(kSr, kMaxBlockFrames, ck);
  for (int t = 0; t < kNumColorTypes; t++) {
    FxChainPtr ch = c.makeChain(static_cast<ColorType>(t));
    if (ch) {
      rt::Scope rts;
      OM_CHECK(c.attachChain(static_cast<ColorType>(t), ch.get()) == nullptr);
    }
    (void)ch.release();
  }
  for (int t = 0; t < kNumColorTypes; t++) {
    rt::Scope rts;
    c.setType(static_cast<ColorType>(t));
    for (int b = 0; b < 8; b++) c.process(in.l.data(), in.r.data(), out.l.data(), out.r.data(), 512);
    c.reset();
  }
}

OM_TEST(fx_unit_cpu_budget_under_2_percent) {
  // < 2 % of a 256-frame block at 48 kHz per unit, every type (reverb
  // included). Measured in optimized builds; Debug builds only report.
  dsp::FpEnvGuard fpEnv;  // restored when the test ends
  dsp::flushDenormals();   // like the audio thread
  auto kernel = ConvolverKernel::build(makeImpulse(2.2, 2.5, 48000, 3), kMaxBlockFrames);
  const double blockSec = 256.0 / kSr;
  double worst = 0;
  const char* worstName = "";
  const Stereo in = fxtest::noise(256 * 400, 31, 0.5f);
  Stereo out(256);
  for (FxType t : kAllTypes) {
    auto u = makeUnit(kSr, kernel);
    u->setType(t);
    u->setBeatsMult(0.5f);
    u->setLevel(0.8f);
    u->setEnabled(true);
    size_t pos = 0;
    auto block = [&]() {
      u->setBeatClock(freeClock(0.5));
      u->process(in.l.data() + pos, in.r.data() + pos, out.l.data(), out.r.data(), 256);
      pos = (pos + 256) % in.size();
    };
    for (int i = 0; i < 400; i++) block();  // warm-up: tails, caches
    const double sec = fxtest::secondsPerCall(block, 400);
    const double pct = 100.0 * sec / blockSec;
    std::printf("    %-9s %7.3f us per 256-frame block = %.3f %%\n", fxTypeName(t), sec * 1e6, pct);
    if (pct > worst) {
      worst = pct;
      worstName = fxTypeName(t);
    }
  }
  std::printf("    worst: %s %.3f %% (%s build)\n", worstName, worst, fxtest::kOptimized ? "optimized" : "debug");
  if (fxtest::kOptimized) OM_CHECK(worst < 2.0);
}

// ===========================================================================
// Color FX bus
// ===========================================================================
namespace {
std::unique_ptr<ColorFx> makeColor(double sr, std::shared_ptr<const ConvolverKernel> k) {
  auto c = std::make_unique<ColorFx>();
  c->prepare(sr, kMaxBlockFrames, std::move(k));
  for (int t = 0; t < kNumColorTypes; t++) {
    FxChainPtr ch = c->makeChain(static_cast<ColorType>(t));
    if (!ch) continue;
    OM_CHECK(c->attachChain(static_cast<ColorType>(t), ch.get()) == nullptr);
    (void)ch.release();
  }
  return c;
}
}  // namespace

OM_TEST(color_echoes_match_engine_js_defs) {
  // engine.js _colorDefs: fixed times and feedbacks, output = the loop's
  // filter (or shaper), drift-free.
  struct Case { ColorType t; double time, fb; bool filter; dsp::BiquadType bt; float f, q; int crush; };
  using BT = dsp::BiquadType;
  const Case cases[] = {{ColorType::DubEcho, 0.35, 0.55, true, BT::Highpass, 250.0f, 1.0f, 0},
                        {ColorType::HpfEcho, 0.3, 0.5, true, BT::Highpass, 900.0f, 1.0f, 0},
                        {ColorType::LpfEcho, 0.3, 0.5, true, BT::Lowpass, 650.0f, 1.0f, 0},
                        {ColorType::BpfEcho, 0.3, 0.55, true, BT::Bandpass, 1000.0f, 1.0f, 0},
                        {ColorType::CrushEcho, 0.3, 0.5, false, BT::Highpass, 0, 0, 6}};
  const size_t start = 4800, frames = 96000;
  const Stereo in = fxtest::noise(frames, 13, 0.5f, start, start + 4800);
  for (const Case& cs : cases) {
    auto c = makeColor(kSr, nullptr);
    c->setType(cs.t);
    const Stereo out = fxtest::run(*c, in, 128);
    // reference loop (double precision, same interpolation)
    const double frames0 = static_cast<double>(static_cast<float>(cs.time)) * kSr;
    std::vector<float> curve;
    if (cs.crush) {
      curve.resize(2048);
      for (int i = 0; i < 2048; i++) {
        const double x = (i / 2047.0) * 2 - 1;
        curve[static_cast<size_t>(i)] = static_cast<float>(jsRound(x * cs.crush) / cs.crush);
      }
    }
    const dsp::BiquadCoeffs co = cs.filter ? dsp::webAudioBiquad(cs.bt, kSr, cs.f, cs.q, 0.0) : dsp::BiquadCoeffs{};
    // DelayNode(4) read like Chromium: single-precision position in a buffer
    // of 128 + 4 * rate frames written from index 0 (see fx_dsp.h).
    const int vlen = 128 + static_cast<int>(std::ceil(4.0 * kSr));
    const float desired = static_cast<float>(cs.time) * static_cast<float>(kSr);
    auto ref = [&](const std::vector<float>& x) {
      std::vector<float> line(frames, 0.0f), o(frames, 0.0f);
      double x1 = 0, x2 = 0, y1 = 0, y2 = 0;
      for (size_t t = 0; t < frames; t++) {
        const int vw = static_cast<int>(t % static_cast<size_t>(vlen));
        float rp = static_cast<float>(vw) + (static_cast<float>(vlen) - desired);
        if (rp >= static_cast<float>(vlen)) rp -= static_cast<float>(vlen);
        const int i1 = static_cast<int>(rp);
        const float f = rp - static_cast<float>(i1);
        int k1 = vw - i1;
        if (k1 < 0) k1 += vlen;
        float y = 0;
        if (t >= static_cast<size_t>(k1)) {
          const float s1 = line[t - static_cast<size_t>(k1)];
          y = s1 + f * (line[t - static_cast<size_t>(k1) + 1] - s1);
        }
        if (cs.filter) {
          const float z = static_cast<float>(co.b0 * y + co.b1 * x1 + co.b2 * x2 - co.a1 * y1 - co.a2 * y2);
          x2 = x1;
          x1 = y;
          y2 = y1;
          y1 = z;
          y = z;
        }
        if (cs.crush) {
          // WaveShaper lookup in float, like Chromium's vectorized kernel
          // (pinned bit-exact by the golden renders fx/color_crush*)
          float v = (y + 1.0f) * 1023.5f;
          if (!(v > 0.0f)) v = 0.0f;
          if (v > 2047.0f) v = 2047.0f;
          const size_t k = static_cast<size_t>(v);
          const size_t k2 = k + 1 < 2048 ? k + 1 : 2047;
          const float fr = v - static_cast<float>(k);
          y = curve[k] + fr * (curve[k2] - curve[k]);
        }
        line[t] = x[t] + static_cast<float>(cs.fb) * y;
        o[t] = y;
      }
      return o;
    };
    Stereo expect(frames);
    expect.l = ref(in.l);
    expect.r = ref(in.r);
    const double err = fxtest::maxDiff(out, expect);
    std::printf("    %s: max |native - ideal| = %.3g\n", colorTypeName(cs.t), err);
    OM_CHECK(err < 1e-6);
    OM_CHECK(fxtest::maxAbs(out.l, start + static_cast<size_t>(frames0)) > 0.005);
  }
}

OM_TEST(color_space_reverb_crush_and_lazy_chains) {
  const uint32_t seed = 0x0C0102EDu;
  const Impulse ir = makeImpulse(2.8, 2.2, 48000, seed);
  OM_CHECK(ir.left.size() == 134400);
  auto c = makeColor(kSr, ConvolverKernel::build(ir, kMaxBlockFrames));
  c->setType(ColorType::Reverb);
  const Stereo out = fxtest::run(*c, fxtest::impulse(140000, 0), 256);
  double err = 0;
  for (size_t i = 0; i < ir.left.size(); i++) {
    err = std::max(err, std::fabs(static_cast<double>(out.l[i]) - ir.left[i]));
    err = std::max(err, std::fabs(static_cast<double>(out.r[i]) - ir.right[i]));
  }
  OM_CHECK(err < 1e-6);  // impulse response = the normalized "Space" impulse
  c->setType(ColorType::Crush);  // crushCurve(5)
  Stereo in(5);
  in.l = {0.25f, -0.25f, 0.62f, 0.95f, 0.5f};
  in.r = in.l;
  const Stereo o = fxtest::run(*c, in, 5);
  OM_CHECK_NEAR(o.l[0], 0.2, 1e-7);
  OM_CHECK_NEAR(o.l[1], -0.2, 1e-7);
  OM_CHECK_NEAR(o.l[2], 0.6, 1e-7);
  OM_CHECK_NEAR(o.l[3], 1.0, 1e-7);
  // 0.5 sits on a step (2.5 rounds up): halfway between the curve points 0.4 and 0.6
  OM_CHECK_NEAR(o.l[4], 0.45, 1e-6);
  for (ColorType t : {ColorType::Filter, ColorType::Noise}) {  // no bus processing
    c->setType(t);
    OM_CHECK(fxtest::maxAbs(fxtest::run(*c, fxtest::noise(512, 2, 0.5f), 128).l) == 0.0);
  }
  ColorFx lazy;
  lazy.prepare(kSr, kMaxBlockFrames, nullptr);
  lazy.setType(ColorType::DubEcho);
  OM_CHECK(fxtest::maxAbs(fxtest::run(lazy, fxtest::noise(24000, 2, 0.5f), 256).l) == 0.0);  // not attached: silent
}

OM_TEST(color_type_switch_cuts_and_keeps_frozen_tails) {
  const Stereo in = fxtest::noise(9600, 8, 0.5f, 0, 2400);
  auto B = makeColor(kSr, nullptr);
  B->setType(ColorType::DubEcho);
  Stereo inB(9600 + 48000);
  std::copy(in.l.begin(), in.l.end(), inB.l.begin());
  std::copy(in.r.begin(), in.r.end(), inB.r.begin());
  const Stereo outB = fxtest::run(*B, inB, 128);
  auto A = makeColor(kSr, nullptr);
  A->setType(ColorType::DubEcho);
  fxtest::run(*A, in, 128);
  A->setType(ColorType::Crush);
  OM_CHECK(fxtest::maxAbs(fxtest::run(*A, Stereo(24000), 128).l) == 0.0);  // dub echo cut at once
  A->setType(ColorType::DubEcho);
  const Stereo resumed = fxtest::run(*A, Stereo(48000), 128);
  double err = 0;
  for (size_t i = 0; i < 48000; i++) err = std::max(err, std::fabs(static_cast<double>(resumed.l[i]) - outB.l[9600 + i]));
  OM_CHECK(err < 1e-7);
  OM_CHECK(fxtest::maxAbs(resumed.l) > 0.01);
}
