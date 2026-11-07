// Tests of the mixer's channel strip and AudioParam emulation (owner:
// mixer): engine.js curves (trim 4^v, EQ v >= 0 ? 6v : 40v dB, DJ filter
// mapping, fader v^2), Chromium's setTargetAtTime values (its x86 groups
// of 4, convergence tested at render quantum starts, event start frames;
// bit-exact against Chromium's AudioParam probes, as hashes), EQ
// coefficients bit-identical to dsp::webAudioBiquad, the fused filter
// cascade bit-identical to the filters run one by one, transparent bypass
// bit-exact, non-finite inputs never poisoning a filter; and the null tests
// against Chromium's renders of engine.js's own Deck class (golden knob
// sweeps strip/*, the Color "noise" path color/noise; OM_GOLDEN_DIR,
// residual < -80 dBFS). SPEC.md §10.1, §10.2, §18.4.
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <vector>

#include "../../src/mixer/strip.h"
#include "mixer_test_util.h"
#include "om/rt.h"

using namespace om;
using om::mixer_detail::AParam;
using om::mixer_detail::ChannelStrip;
using om::mixer_detail::DjFilter;
using om::mixer_detail::EqFilter;
using om::mixer_detail::StripBuses;

namespace {

// Runs one strip over planar input; adds the dryOut output (the strip's
// contribution to the master sum) into out. Irregular block sizes. An
// optional looped mono noise source feeds the Color "noise" input.
struct StripRun {
  ChannelStrip strip;
  std::vector<float> l = std::vector<float>(kMaxBlockFrames), r = std::vector<float>(kMaxBlockFrames);
  std::vector<float> xl = std::vector<float>(kMaxBlockFrames), xr = std::vector<float>(kMaxBlockFrames);
  std::vector<float> nz = std::vector<float>(kMaxBlockFrames);
  const std::vector<float>* noise = nullptr;  // looped from frame 0 (engine.js noiseSrc)
  int64_t pos = 0;
  int k = 0;
  StripRun() {
    strip.prepare(48000.0, kMaxBlockFrames, 0.05);
    strip.resetDefaults();
  }
  // processes [pos, pos + n) of in -> out (adds into out)
  void run(const float* inL, const float* inR, float* outL, float* outR, int64_t n) {
    int64_t done = 0;
    while (done < n) {
      int b = mixtest::blockSize(k++);
      if (b > n - done) b = static_cast<int>(n - done);
      if (noise) {
        const size_t len = noise->size();
        for (int i = 0; i < b; i++) nz[static_cast<size_t>(i)] = (*noise)[static_cast<size_t>(pos + i) % len];
      }
      rt::Scope rts;
      strip.front(inL + done, inR + done, l.data(), r.data(), b, pos);
      StripBuses bus;
      bus.dryL = outL + done;
      bus.dryR = outR + done;
      bus.noise = noise ? nz.data() : nullptr;
      strip.back(l.data(), r.data(), xl.data(), xr.data(), b, pos, bus);
      pos += b;
      done += b;
    }
  }
};

double gainAt(const std::vector<float>& out, const std::vector<float>& in, size_t from, size_t to) {
  return mixtest::rmsOf(out.data() + from, to - from) / mixtest::rmsOf(in.data() + from, to - from);
}

int bandIndex(const std::string& s) { return s == "low" ? 0 : (s == "mid" ? 1 : 2); }

}  // namespace

// ---------------------------------------------------------------------------
// AudioParam emulation (Chromium AudioParamTimeline::ProcessSetTarget, x86)
// ---------------------------------------------------------------------------
namespace {
// FNV-1a 64 over the bit patterns of the values (little-endian bytes).
uint64_t fnv1a(const std::vector<float>& v) {
  uint64_t h = 0xcbf29ce484222325ull;
  for (float x : v) {
    uint32_t u;
    std::memcpy(&u, &x, 4);
    for (int b = 0; b < 4; b++) {
      h ^= (u >> (8 * b)) & 0xFFu;
      h *= 0x100000001b3ull;
    }
  }
  return h;
}
struct ParamEvent {
  int64_t frame;
  bool value;  // AudioParam.value = x (else setTargetAtTime)
  double x, tau;
};
// Replays events on an AParam in irregular blocks, returns the values.
std::vector<float> replay(float v0, const std::vector<ParamEvent>& ev, int64_t frames) {
  AParam p;
  p.prepare(48000.0);
  p.reset(v0);
  std::vector<float> got(static_cast<size_t>(frames));
  size_t k = 0;
  int64_t pos = 0;
  int b = 0;
  while (pos < frames) {
    while (k < ev.size() && ev[k].frame == pos) {
      if (ev[k].value)
        p.setValue(static_cast<float>(ev[k].x), pos);
      else
        p.setTarget(static_cast<float>(ev[k].x), ev[k].tau, pos);
      k++;
    }
    int n = mixtest::blockSize(b++);
    if (k < ev.size() && ev[k].frame - pos < n) n = static_cast<int>(ev[k].frame - pos);
    if (pos + n > frames) n = static_cast<int>(frames - pos);
    {
      rt::Scope rts;
      p.fill(got.data() + pos, n, pos);
    }
    pos += n;
  }
  return got;
}
}  // namespace

OM_TEST(mixer_aparam_settarget_like_chromium) {
  const float c0 = static_cast<float>(1.0 - std::exp(-1.0 / (48000.0 * static_cast<double>(0.01f))));
  const float c1 = c0 * (2.0f - c0), c2 = c0 * ((c0 - 3.0f) * c0 + 3.0f);
  const float c3 = c0 * (c0 * ((4.0f - c0) * c0 - 6.0f) + 4.0f);
  AParam p;
  p.prepare(48000.0);
  p.reset(0.0f);
  std::vector<float> v(60000);
  // an event at a quantum start whose time is exact (1024 / 48000 x 48000 == 1024)
  p.setTarget(1.0f, 0.01, 1024);
  {
    rt::Scope rts;
    p.fill(v.data() + 1024, 128, 1024);  // frames 1024..1151
  }
  OM_CHECK(v[1024] == 0.0f);  // the event's first frame holds the previous value
  OM_CHECK(v[1025] == c0);    // then Chromium's groups of 4: b + d c0, b + d c1, b + d c2
  OM_CHECK(v[1026] == c1);
  OM_CHECK(v[1027] == c2);
  OM_CHECK(v[1028] == c3);    // the next group's base: b + d c3
  OM_CHECK(v[1029] == c3 + (1.0f - c3) * c0);
  // the next quantum starts with one serial step from the last written value
  p.fill(v.data() + 1152, 1, 1152);
  OM_CHECK(v[1152] == v[1151] + (1.0f - v[1151]) * c0);
  // convergence is only tested at quantum starts: 10 time constants (4800 frames) are over at 5888
  for (int64_t f = 1153; f < 6400; f += 64) p.fill(v.data() + f, static_cast<int>(std::min<int64_t>(64, 6400 - f)), f);
  int64_t snap = -1;
  for (int64_t f = 1025; f < 6400; f++)
    if (v[static_cast<size_t>(f)] == 1.0f) {
      snap = f;
      break;
    }
  OM_CHECK(snap == 5888 && v[5887] < 1.0f);  // 46 x 128
  OM_CHECK(p.idle() && p.value() == 1.0f);
  // relative threshold e^-10 x |target| (0.25 -> 0.26, tau 5 ms)
  p.reset(0.25f);
  p.setTarget(0.26f, 0.005, 12032);
  for (int64_t f = 12032; f < 15000; f += 100) p.fill(v.data() + (f - 12032), 100, f);
  snap = -1;
  for (int64_t i = 1; i < 2968; i++)
    if (v[static_cast<size_t>(i)] == 0.26f) {
      snap = 12032 + i;
      break;
    }
  OM_CHECK(snap == 13696);  // the first quantum start where |v - 0.26| < e^-10 x 0.26
  // an event time that rounds up (26496 / 48000 x 48000 = 26496.000000000004) starts one frame later...
  p.reset(1e-6f);
  p.setTarget(0.0f, 0.01, 26496);
  p.fill(v.data(), 4, 26496);
  OM_CHECK(v[0] == 1e-6f && v[1] == 0.0f);  // ...where |v| < e^-10 (target 0) converges at once
  // .value = x applies at its own frame
  p.setValue(0.7225f, 33664);
  p.fill(v.data(), 2, 33664);
  OM_CHECK(v[0] == 0.7225f && p.idle());
  // retarget while moving at a quantum start: one more step of the old automation, then the new one
  p.reset(0.3f);
  p.setTarget(0.31f, 0.01, 0);
  p.fill(v.data(), 256, 0);
  const float before = v[255];
  p.setTarget(0.5f, 0.01, 256);
  p.fill(v.data(), 2, 256);
  OM_CHECK(v[0] == before + (0.31f - before) * c0);
  OM_CHECK(v[1] == v[0] + (0.5f - v[0]) * c0);
  // ...and mid-quantum: the last value is held
  p.fill(v.data(), 44, 258);
  const float held = v[43];
  p.setTarget(0.2f, 0.01, 302);
  p.fill(v.data(), 2, 302);
  OM_CHECK(v[0] == held && v[1] == held + (0.2f - held) * c0);
  // values do not depend on how the frames are split into blocks
  AParam a, b;
  a.prepare(48000.0);
  b.prepare(48000.0);
  a.reset(0.2f);
  b.reset(0.2f);
  a.setTarget(0.9f, 0.015, 77);
  b.setTarget(0.9f, 0.015, 77);
  std::vector<float> va(12000), vb(12000);
  a.fill(va.data(), 77, 0);
  a.fill(va.data() + 77, 12000 - 77, 77);
  b.fill(vb.data(), 77, 0);
  for (int64_t f = 77, k = 0; f < 12000; k++) {
    int n = mixtest::blockSize(static_cast<int>(k));
    if (f + n > 12000) n = static_cast<int>(12000 - f);
    b.fill(vb.data() + f, n, f);
    f += n;
  }
  OM_CHECK(std::memcmp(va.data(), vb.data(), sizeof(float) * va.size()) == 0);
}

// Bit-exact against Chromium: two OfflineAudioContext probes rendered by
// Electron 43.1.0 (ConstantSource(1) -> GainNode whose gain gets these
// events -> destination: the output IS the gain values), reduced to an
// FNV-1a hash of every value: setTarget from rest, retargets while moving
// at quantum starts, an event scheduled mid-quantum, an event time that
// rounds up, .value steps, the relative / zero / time convergence rules, a
// value stuck by float rounding (0.50005 -> 0.5 with tau 1 s never moves).
OM_TEST(mixer_aparam_bit_exact_vs_chromium_probes) {
  const std::vector<ParamEvent> settarget = {
      {1024, false, 1, 0.01},    {2944, false, 0.25, 0.01}, {12032, false, 0.26, 0.005}, {19200, false, 0, 0.002},
      {26368, true, 1e-06, 0},   {26496, false, 0, 0.01},   {33664, true, 0.7225, 0},    {34944, false, 0.7225, 0.01},
      {36645, false, 0.3, 0.01}, {38400, false, 0.5, 0.01}, {39040, false, 0.5, 0.01},   {45568, false, 1, 0.015},
      {50432, false, 0.9, 0.05}};
  const std::vector<float> got = replay(0.0f, settarget, 57600);
  const uint64_t h1 = fnv1a(got);
  std::printf("    probe 1 (13 events, 57600 frames): fnv1a %016llx (Chromium 1c3440a66c0c7e30)\n",
              static_cast<unsigned long long>(h1));
  OM_CHECK(h1 == 0x1c3440a66c0c7e30ull);
  struct Ch {
    float v0;
    double target, tau;
    uint64_t hash;
  } chans[] = {{8e-05f, 0, 1, 0x702ab038fb76f4a5ull},
               {0.50005f, 0.5, 1, 0x7a8e17e032229925ull},
               {-1000.0f, 1, 0.0008, 0x04a45071b519fec8ull},
               {-40.0f, -40.002, 1, 0x7df0107daa669325ull}};
  for (const Ch& c : chans) {
    const uint64_t h = fnv1a(replay(c.v0, {{1280, false, c.target, c.tau}}, 72064));
    std::printf("    probe 2 (%g -> %g, tau %g s): fnv1a %016llx (Chromium %016llx)\n", static_cast<double>(c.v0), c.target,
                c.tau, static_cast<unsigned long long>(h), static_cast<unsigned long long>(c.hash));
    OM_CHECK(h == c.hash);
  }
}

// ---------------------------------------------------------------------------
// Coefficients and curves (no golden needed)
// ---------------------------------------------------------------------------
OM_TEST(mixer_eq_coefficients_bit_identical_to_web_audio_formulas) {
  for (double rate : {44100.0, 48000.0, 96000.0}) {
    struct B {
      dsp::BiquadType t;
      float f, q;
    } bands[] = {{dsp::BiquadType::Lowshelf, 200.0f, 1.0f}, {dsp::BiquadType::Peaking, 1000.0f, 0.9f},
                 {dsp::BiquadType::Highshelf, 8000.0f, 1.0f}};
    for (const B& b : bands) {
      EqFilter band;
      band.prepare(b.t, b.f, b.q, rate);
      for (int i = 0; i <= 460; i++) {
        const double g = -40.0 + 0.1 * i + 1e-3 * std::sin(i);
        const dsp::BiquadCoeffs a = band.coeffs(g);
        const dsp::BiquadCoeffs w = dsp::webAudioBiquad(b.t, rate, b.f, b.q, g);
        OM_CHECK(a.b0 == w.b0 && a.b1 == w.b1 && a.b2 == w.b2 && a.a1 == w.a1 && a.a2 == w.a2);
      }
    }
  }
}

// The fused cascade (strip.h Cascade) must give exactly what running each
// filter in turn gives: outputs and states, bit for bit, for every mix of
// biquad and identity stages and any block size (1 frame included).
OM_TEST(mixer_cascade_bit_identical_to_sequential_filters) {
  using om::mixer_detail::BiquadState;
  using om::mixer_detail::Cascade;
  uint32_t seed = 0xC0FFEEu;
  auto rnd = [&]() {
    seed ^= seed << 13;
    seed ^= seed >> 17;
    seed ^= seed << 5;
    return static_cast<double>(seed) / 4294967296.0;
  };
  const dsp::BiquadType types[] = {dsp::BiquadType::Lowshelf, dsp::BiquadType::Peaking, dsp::BiquadType::Highshelf,
                                   dsp::BiquadType::Lowpass, dsp::BiquadType::Highpass};
  bool same = true;
  int blocks = 0;
  for (int config = 0; config < 64; config++) {
    const int stages = 1 + config % 4;
    dsp::BiquadCoeffs k[4];
    bool identity[4];
    BiquadState a[4][2], b[4][2];
    for (int j = 0; j < stages; j++) {
      identity[j] = ((config >> (2 + j)) & 1) != 0 && j != config % stages;  // at least one biquad
      k[j] = dsp::webAudioBiquad(types[static_cast<int>(rnd() * 5) % 5], 48000, 40 + rnd() * 15000, 0.5 + rnd(),
                                 -20 + 26 * rnd());
    }
    std::vector<float> la(2048), ra(2048), lb(2048), rb(2048);
    for (int blk = 0; blk < 40; blk++) {
      const int n = blk % 7 == 3 ? 1 : 1 + static_cast<int>(rnd() * 600);
      for (int i = 0; i < n; i++) {
        la[static_cast<size_t>(i)] = lb[static_cast<size_t>(i)] = static_cast<float>(rnd() * 2 - 1);
        ra[static_cast<size_t>(i)] = rb[static_cast<size_t>(i)] = static_cast<float>(rnd() - 0.5);
      }
      // sequential, as before the fusion: each filter over the whole block
      for (int j = 0; j < stages; j++) {
        if (identity[j]) {
          om::mixer_detail::biquadIdentity(a[j][0], la.data(), n);
          om::mixer_detail::biquadIdentity(a[j][1], ra.data(), n);
        } else {
          om::mixer_detail::biquadBlock(k[j], a[j][0], la.data(), n);
          om::mixer_detail::biquadBlock(k[j], a[j][1], ra.data(), n);
          om::mixer_detail::biquadFlush(a[j][0]);
          om::mixer_detail::biquadFlush(a[j][1]);
        }
      }
      Cascade c;
      for (int j = 0; j < stages; j++) {
        if (identity[j])
          c.addIdentity(b[j]);
        else
          c.addBiquad(&k[j], b[j]);
      }
      {
        rt::Scope rts;
        c.run(lb.data(), rb.data(), n);
      }
      same &= std::memcmp(la.data(), lb.data(), sizeof(float) * static_cast<size_t>(n)) == 0;
      same &= std::memcmp(ra.data(), rb.data(), sizeof(float) * static_cast<size_t>(n)) == 0;
      for (int j = 0; j < stages; j++)
        for (int ch = 0; ch < 2; ch++)
          same &= a[j][ch].x1 == b[j][ch].x1 && a[j][ch].x2 == b[j][ch].x2 && a[j][ch].y1 == b[j][ch].y1 &&
                  a[j][ch].y2 == b[j][ch].y2;
      blocks++;
    }
  }
  OM_CHECK(same && blocks == 64 * 40);
}

OM_TEST(mixer_strip_curves_match_engine_js) {
  const size_t N = 48000;
  // TRIM 4^v and fader v^2 (steady state after 10 time constants: exact float gains)
  for (double v : {-1.0, -0.5, 0.0, 0.37, 1.0}) {
    StripRun s;
    const auto in = mixtest::constant(N, 0.25f);
    std::vector<float> outL(N), outR(N);
    s.strip.setTrim(v, 0);
    s.strip.setVolume(0.6, 0);
    s.run(in.data(), in.data(), outL.data(), outR.data(), N);
    const float want = 0.25f * static_cast<float>(std::pow(4.0, v)) * static_cast<float>(0.6 * 0.6);
    OM_CHECK_NEAR(outL[N - 1], want, 1e-7);
    OM_CHECK(s.strip.trimParam().idle() && s.strip.faderParam().idle());
  }
  // EQ gains: v >= 0 ? 6v : 40v dB, measured on sines against the biquad's magnitude response
  struct Case {
    int band;
    double hz, v;
  } cases[] = {{0, 50, 1.0}, {0, 50, -1.0}, {0, 100, 0.5}, {1, 1000, 1.0}, {1, 1000, -0.5},
               {2, 15000, 1.0}, {2, 15000, -1.0}, {2, 12000, 0.25}};
  for (const Case& c : cases) {
    StripRun s;
    const auto in = mixtest::sine(N, c.hz, 0.1);
    std::vector<float> outL(N), outR(N);
    s.strip.setEq(c.band, c.v, 0);
    s.strip.setVolume(1.0, 0);
    s.run(in.data(), in.data(), outL.data(), outR.data(), N);
    const double db = c.v >= 0 ? 6 * c.v : 40 * c.v;
    const dsp::BiquadType t = c.band == 0 ? dsp::BiquadType::Lowshelf
                                          : (c.band == 1 ? dsp::BiquadType::Peaking : dsp::BiquadType::Highshelf);
    const double f = c.band == 0 ? 200 : (c.band == 1 ? 1000 : 8000);
    const double want = dsp::magnitudeDb(dsp::webAudioBiquad(t, 48000, f, c.band == 1 ? 0.9f : 1.0f, db), c.hz, 48000);
    const double got = 20 * std::log10(gainAt(outL, in, N / 2, N));
    OM_CHECK_NEAR(got, want, 0.02);
  }
  // DJ filter mapping (engine.js _applyBiquad): dead zone 0.04, HPF 20*400^v, LPF 20000*(80/20000)^-v
  {
    DjFilter f;
    f.prepare(48000);
    f.set(0.03);
    OM_CHECK(f.kind() == DjFilter::Kind::Neutral);
    f.set(-0.039);
    OM_CHECK(f.kind() == DjFilter::Kind::Neutral);
    f.set(0.5);
    OM_CHECK(f.kind() == DjFilter::Kind::Highpass && f.frequency() == static_cast<float>(20 * std::pow(400.0, 0.5)));
    f.set(1.0);
    OM_CHECK_NEAR(f.frequency(), 8000.0, 1e-3);
    f.set(-1.0);
    OM_CHECK(f.kind() == DjFilter::Kind::Lowpass);
    OM_CHECK_NEAR(f.frequency(), 80.0, 1e-4);
    f.set(-0.5);
    OM_CHECK(f.frequency() == static_cast<float>(20000 * std::pow(80.0 / 20000.0, 0.5)));
    // Q 0.9 in dB: +0.9 dB of resonance at the cutoff
    OM_CHECK_NEAR(dsp::magnitudeDb(f.coeffs(), f.frequency(), 48000), 0.9, 0.05);
  }
  // fader smoothing: tau 10 ms (1 - 1/e after 480 frames)
  {
    StripRun s;
    const auto in = mixtest::constant(9600, 1.0f);
    std::vector<float> outL(9600), outR(9600);
    s.strip.setVolume(0.0, 0);
    s.run(in.data(), in.data(), outL.data(), outR.data(), 9600);  // converged at 0 (10 tau + a quantum)
    std::fill(outL.begin(), outL.end(), 0.0f);
    std::fill(outR.begin(), outR.end(), 0.0f);
    s.strip.setVolume(1.0, s.pos);
    s.run(in.data(), in.data(), outL.data(), outR.data(), 4800);
    OM_CHECK(outL[0] == 0.0f);
    OM_CHECK_NEAR(outL[480], 1.0 - std::exp(-1.0), 2e-3);
  }
}

OM_TEST(mixer_strip_neutral_settings_are_bit_transparent) {
  // trim 0, EQ 0 dB, filter in its dead zone, volume 1: the strip returns its input exactly
  StripRun s;
  const size_t N = 20000;
  const auto in = mixtest::noise(N, 0.8f, 1234);
  std::vector<float> outL(N), outR(N);
  s.strip.setVolume(1.0, 0);
  s.strip.setFilter(0.02);
  s.run(in.data(), in.data(), outL.data(), outR.data(), 9600);  // the fader converges (10 tau + a quantum)
  std::fill(outL.begin(), outL.end(), 0.0f);
  s.run(in.data() + 9600, in.data() + 9600, outL.data(), outR.data(), N - 9600);
  bool exact = true;
  for (size_t i = 0; i < N - 9600; i++) exact &= outL[i] == in[9600 + i];
  OM_CHECK(exact);
  // After an EQ excursion back to 0 dB, the float-feedback state of the
  // 200 Hz shelf keeps a few-ulp error (the deadband of Chromium's own
  // arithmetic, reproduced here): the band keeps filtering, like Chromium,
  // instead of bypassing; the output stays within -110 dBFS of the input.
  s.strip.setEq(0, 1.0, s.pos);
  s.run(in.data(), in.data(), outL.data(), outR.data(), 4800);
  s.strip.setEq(0, 0.0, s.pos);
  std::fill(outL.begin(), outL.end(), 0.0f);
  std::fill(outR.begin(), outR.end(), 0.0f);
  s.run(in.data(), in.data(), outL.data(), outR.data(), N);
  OM_CHECK(s.strip.eqBand(0).gainParam().idle() && s.strip.eqBand(0).gainDb() == 0.0f);
  OM_CHECK(!s.strip.eqBand(0).state(0).transparent());
  OM_CHECK(omtest::residualDb(outL.data() + (N - 4000), in.data() + (N - 4000), 4000) < -110.0);
  // silence flushes that state: the identity bypass engages again, bit-exact
  const auto silent = mixtest::constant(48000, 0.0f);
  std::vector<float> sink(48000);
  s.run(silent.data(), silent.data(), sink.data(), sink.data(), 48000);
  OM_CHECK(s.strip.eqBand(0).state(0).transparent() && s.strip.eqBand(0).state(1).transparent());
  std::fill(outL.begin(), outL.end(), 0.0f);
  s.run(in.data(), in.data(), outL.data(), outR.data(), N);
  bool again = true;
  for (size_t i = 0; i < N; i++) again &= outL[i] == in[i];
  OM_CHECK(again);
}

OM_TEST(mixer_strip_recovers_from_a_non_finite_input) {
  // Chromium would keep a NaN in its biquad state for good (the channel stays
  // silent); the native strip starts again from rest at the next block.
  StripRun s;
  s.strip.setEq(1, -0.5, 0);
  s.strip.setFilter(-0.4);
  const size_t N = 9600;
  auto in = mixtest::sine(N, 440, 0.2);
  in[1000] = std::nanf("");
  in[1001] = INFINITY;
  std::vector<float> outL(N), outR(N);
  s.run(in.data(), in.data(), outL.data(), outR.data(), static_cast<int64_t>(N));
  bool finiteTail = true;
  for (size_t i = 4000; i < N; i++) finiteTail &= std::isfinite(outL[i]) != 0;
  OM_CHECK(finiteTail);
  OM_CHECK(mixtest::rmsOf(outL.data() + 6000, 3600) > 0.01);  // sound again
}

// ---------------------------------------------------------------------------
// Null tests against Chromium renders of engine.js's Deck (golden knob sweeps)
// ---------------------------------------------------------------------------
OM_TEST(mixer_strip_null_vs_chromium_knob_sweeps) {
  const char* cases[] = {"eq_low_sweep", "eq_mid_sweep", "eq_high_sweep", "eq_kill_all",
                         "filter_sweep", "trim_steps", "fader_steps"};
  double worst = -400.0;
  int unknown = 0, bad = 0;
  for (const char* name : cases) {
    const mixtest::Golden g = mixtest::loadGolden("strip", name);
    MIXTEST_REQUIRE_GOLDEN(g);
    OM_CHECK(g.meta["sampleRate"].asNumber(0) == 48000 && g.input.frames() >= g.out.frames());
    const std::vector<float> inL = mixtest::channel(g.input, 0), inR = mixtest::channel(g.input, 1);
    const int64_t frames = g.out.frames();
    StripRun s;
    std::vector<float> outL(static_cast<size_t>(frames)), outR(static_cast<size_t>(frames));
    auto ev = mixtest::events(g.meta);
    mixtest::applyChromiumStepTiming(ev, 48000.0, "deck.setFilter", &bad);
    size_t e = 0;
    while (s.pos < frames) {
      while (e < ev.size() && ev[e].frame == s.pos) {
        const mixtest::Event& x = ev[e];
        const int64_t f = s.pos;
        if (x.call == "deck.setTrim") s.strip.setTrim(clampv(x.num(0), -1.0, 1.0), f);
        else if (x.call == "deck.setEq") s.strip.setEq(bandIndex(x.str(0)), clampv(x.num(1), -1.0, 1.0), f);
        else if (x.call == "deck.setFilter") s.strip.setFilter(x.num(0));
        else if (x.call == "deck.setVolume") s.strip.setVolume(clampv(x.num(0), 0.0, 1.0), f);
        else unknown++;
        e++;
      }
      int64_t n = frames - s.pos;
      if (e < ev.size()) n = ev[e].frame - s.pos;
      // run() splits into irregular device-like blocks itself
      s.run(inL.data() + s.pos, inR.data() + s.pos, outL.data() + s.pos, outR.data() + s.pos, n);
    }
    const double res = mixtest::residualStereo(outL, outR, g.out);
    std::printf("    strip/%s: residual %.1f dBFS (%zu events)\n", name, res, ev.size());
    worst = std::fmax(worst, res);
  }
  OM_CHECK(unknown == 0 && bad == 0);
  OM_CHECK(worst < -80.0);
}

// Color "noise": engine.js noiseSrc (looped 2 s buffer from frame 0) ->
// noiseGain (amt^2 x 0.4, tau 10 ms) -> fader -> xf -> dryOut. The golden
// gives Chromium's own noise buffer (seeded Math.random).
OM_TEST(mixer_color_noise_null_vs_chromium) {
  const mixtest::Golden g = mixtest::loadGolden("color", "noise");
  MIXTEST_REQUIRE_GOLDEN(g);
  omtest::Wav nb;
  std::string err;
  const std::string nbPath = g.dir + g.meta["files"]["noise"].asString();
  OM_CHECK(omtest::readWav(nbPath, nb, &err));
  const std::vector<float> noise = mixtest::channel(nb, 0);
  OM_CHECK(noise.size() == 96000);  // 2 s at 48 kHz, mono
  const int64_t frames = g.out.frames();
  StripRun s;
  s.noise = &noise;
  const std::vector<float> silence(static_cast<size_t>(frames), 0.0f);
  std::vector<float> outL(static_cast<size_t>(frames)), outR(static_cast<size_t>(frames));
  const auto ev = mixtest::events(g.meta);
  size_t e = 0;
  bool noiseMode = false;
  int unknown = 0;
  while (s.pos < frames) {
    while (e < ev.size() && ev[e].frame == s.pos) {
      const mixtest::Event& x = ev[e];
      if (x.call == "engine.setColorType") {
        noiseMode = x.str(0) == "noise";
      } else if (x.call == "engine.setDeckColor" && static_cast<int>(x.num(0)) == 0) {
        // engine.js setDeckColor in "noise" mode: filter neutral, noise gain amt^2 x 0.4
        const double amt = std::fabs(clampv(x.num(1), -1.0, 1.0));
        s.strip.setFilter(0.0);
        s.strip.noise.setTarget(noiseMode ? static_cast<float>(amt * amt * 0.4) : 0.0f, 0.01, s.pos);
      } else {
        unknown++;
      }
      e++;
    }
    int64_t n = frames - s.pos;
    if (e < ev.size()) n = ev[e].frame - s.pos;
    s.run(silence.data() + s.pos, silence.data() + s.pos, outL.data() + s.pos, outR.data() + s.pos, n);
  }
  const double res = mixtest::residualStereo(outL, outR, g.out);
  std::printf("    color/noise: residual %.1f dBFS (%zu events)\n", res, ev.size());
  OM_CHECK(unknown == 0);
  OM_CHECK(res < -80.0);
}
