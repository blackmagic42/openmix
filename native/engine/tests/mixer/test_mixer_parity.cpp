// Parity of the mixer with Chromium beyond the host's 48 kHz golden suites
// (owner: mixer; dsp-parity campaign, 7 Nov 2026). Null tests against
// goldens/mixer/, rendered by tests/mixer/goldens/make_mixer_goldens.js from
// engine.js's own Deck and AudioEngine:
//  - the channel strip (EQ kills / boosts, DJ filter sweep, trim, fader) at
//    44.1 kHz and 96 kHz, with the per-band level error (third octaves) next
//    to the residual;
//  - the master chain and the crossfader at 44.1 kHz, through the Mixer;
//  - the limiter at 44.1 / 48 / 96 kHz: residual, look-ahead (lag of the
//    output), static curve (a level staircase), attack and release times,
//    native and Chromium measured the same way;
//  - the whole graph through the Mixer API (decks, EQ, trim, Color filter
//    knob, faders, crossfader and sides, master volume and filter, limiter
//    compressing) at 48 and 44.1 kHz;
//  - the FX sends / returns / pad sends / master FX send, the dry cut and the
//    master dry compensation, with identity FX units on both sides (the units
//    have their own suite in tests/fx), and the Color FX sends with an
//    identity Color bus.
// Skipped only when OM_GOLDEN_DIR is unset; a missing case fails.
// OM_MIXER_DUMP=<folder> writes every native render as <case>.native.wav.
#include <algorithm>
#include <cmath>
#include <cstdio>
#include <fstream>
#include <memory>
#include <string>
#include <vector>

#include "../../src/mixer/aparam.h"
#include "../../src/mixer/strip.h"
#include "mixer_test_util.h"
#include "om/dsp.h"
#include "om/limiter.h"
#include "om/mixer.h"
#include "om/rt.h"

using namespace om;
using om::mixer_detail::AParam;
using om::mixer_detail::ChannelStrip;
using om::mixer_detail::StripBuses;

namespace {

constexpr double kNullDb = -80.0;
constexpr double kBandDb = 0.1;  // per-band level target of the campaign

// ---------------------------------------------------------------------------
// Golden cases of goldens/mixer/
// ---------------------------------------------------------------------------
std::vector<std::string> mixerCases(const char* kind, bool* skipped) {
  std::vector<std::string> names;
  *skipped = false;
  const std::string base = omtest::goldenPath("mixer/");
  if (base.empty()) {
    *skipped = true;
    return names;
  }
  std::string text, err;
  json::Value manifest;
  if (!mixtest::readText(base + "manifest.json", text) || !json::parse(text, manifest, &err)) {
    std::printf("    goldens/mixer/manifest.json missing or unreadable (run tests/mixer/goldens/make_mixer_goldens.js)\n");
    return names;
  }
  for (const json::Value& n : manifest["cases"].items()) {
    std::string ct;
    json::Value c;
    if (!mixtest::readText(base + n.asString() + ".json", ct) || !json::parse(ct, c, &err)) continue;
    if (c["kind"].asString() == kind) names.push_back(n.asString());
  }
  return names;
}

void dumpWav(const std::string& name, const std::vector<float>& l, const std::vector<float>& r, int rate) {
  const std::string dir = omtest::envString("OM_MIXER_DUMP");
  if (dir.empty()) return;
  std::ofstream f(dir + "/" + name + ".native.wav", std::ios::binary);
  if (!f) return;
  auto u32 = [&](uint32_t v) { f.write(reinterpret_cast<const char*>(&v), 4); };
  auto u16 = [&](uint16_t v) { f.write(reinterpret_cast<const char*>(&v), 2); };
  const uint32_t bytes = static_cast<uint32_t>(l.size() * 8);
  f.write("RIFF", 4);
  u32(36 + bytes);
  f.write("WAVEfmt ", 8);
  u32(16);
  u16(3);
  u16(2);
  u32(static_cast<uint32_t>(rate));
  u32(static_cast<uint32_t>(rate) * 8);
  u16(8);
  u16(32);
  f.write("data", 4);
  u32(bytes);
  for (size_t i = 0; i < l.size(); i++) {
    f.write(reinterpret_cast<const char*>(&l[i]), 4);
    f.write(reinterpret_cast<const char*>(&r[i]), 4);
  }
}

// Every event lands where Chromium applies it (the generator only uses frames
// where ceil(frame / rate * rate) == frame): counts the others.
int offGridEvents(const std::vector<mixtest::Event>& ev, double rate) {
  int bad = 0;
  for (const mixtest::Event& e : ev)
    if (e.frame % 128 != 0 || mixtest::chromiumStepFrame(e, rate) != e.frame) bad++;
  return bad;
}

int bandIndex(const std::string& s) { return s == "low" ? 0 : (s == "mid" ? 1 : 2); }

// ---------------------------------------------------------------------------
// Per-band level error: energy of native vs Chromium in third-octave bands
// (Web Audio bandpass, Q 4.318, run in double from 0.1 s before the window),
// over the steady part of every segment between two calls.
// ---------------------------------------------------------------------------
double bandEnergy(const std::vector<float>& x, size_t a, size_t b, double fc, double rate) {
  const dsp::BiquadCoeffs k = dsp::webAudioBiquad(dsp::BiquadType::Bandpass, rate, fc, 4.318, 0.0);
  double x1 = 0, x2 = 0, y1 = 0, y2 = 0, e = 0;
  const size_t warm = a > static_cast<size_t>(0.1 * rate) ? a - static_cast<size_t>(0.1 * rate) : 0;
  for (size_t i = warm; i < b && i < x.size(); i++) {
    const double in = x[i];
    const double y = k.b0 * in + k.b1 * x1 + k.b2 * x2 - k.a1 * y1 - k.a2 * y2;
    x2 = x1;
    x1 = in;
    y2 = y1;
    y1 = y;
    if (i >= a) e += y * y;
  }
  return e;
}
struct BandResult {
  double worstDb = 0;  // max |native - Chromium| level, dB
  double atHz = 0;
  int bands = 0;
};
BandResult bandError(const std::vector<float>& nl, const std::vector<float>& nr, const omtest::Wav& gold,
                     const std::vector<int64_t>& cuts, double rate) {
  BandResult br;
  const std::vector<float> gl = mixtest::channel(gold, 0), gr = mixtest::channel(gold, 1);
  for (size_t s = 0; s + 1 < cuts.size(); s++) {
    const size_t a = static_cast<size_t>(cuts[s] + static_cast<int64_t>(0.1 * rate));  // 10 time constants of the knobs
    const size_t b = static_cast<size_t>(cuts[s + 1]);
    if (b <= a + static_cast<size_t>(0.05 * rate)) continue;
    for (double fc = 25.0; fc < 0.45 * rate && fc < 20001.0; fc *= std::pow(2.0, 1.0 / 3.0)) {
      const double eg = bandEnergy(gl, a, b, fc, rate) + bandEnergy(gr, a, b, fc, rate);
      if (eg < 2.0 * static_cast<double>(b - a) * 1e-10) continue;  // band below -100 dBFS: no meaningful level
      const double en = bandEnergy(nl, a, b, fc, rate) + bandEnergy(nr, a, b, fc, rate);
      const double d = std::fabs(10.0 * std::log10(en / eg));
      br.bands++;
      if (d > br.worstDb) {
        br.worstDb = d;
        br.atHz = fc;
      }
    }
  }
  return br;
}

// ---------------------------------------------------------------------------
// The channel strip at any rate (ChannelStrip directly, irregular blocks)
// ---------------------------------------------------------------------------
struct StripRunR {
  ChannelStrip strip;
  std::vector<float> l = std::vector<float>(kMaxBlockFrames), r = std::vector<float>(kMaxBlockFrames);
  std::vector<float> xl = std::vector<float>(kMaxBlockFrames), xr = std::vector<float>(kMaxBlockFrames);
  int64_t pos = 0;
  int k = 0;
  explicit StripRunR(double rate) {
    strip.prepare(rate, kMaxBlockFrames, 0.05);
    strip.resetDefaults();
  }
  void run(const float* inL, const float* inR, float* outL, float* outR, int64_t n) {
    int64_t done = 0;
    while (done < n) {
      int b = mixtest::blockSize(k++);
      if (b > n - done) b = static_cast<int>(n - done);
      rt::Scope rts;
      strip.front(inL + done, inR + done, l.data(), r.data(), b, pos);
      StripBuses bus;
      bus.dryL = outL + done;
      bus.dryR = outR + done;
      strip.back(l.data(), r.data(), xl.data(), xr.data(), b, pos, bus);
      pos += b;
      done += b;
    }
  }
};

// ---------------------------------------------------------------------------
// An FX unit made an identity, like the golden renders do to engine.js's
// FxUnit: wet = input x wet gain; the wet gain is an AudioParam driven like
// FxUnit.setLevel (setTargetAtTime(level, now, 0.02), Chromium's values);
// disabled = no output, the wet automation still advancing.
// ---------------------------------------------------------------------------
struct IdentityFx final : IFxProcessor {
  AParam wet;
  int64_t frame = 0;  // the unit's timeline (attached before the first block: the mixer's)
  bool enabled = false;
  std::vector<float> g = std::vector<float>(kMaxBlockFrames, 0.0f);
  explicit IdentityFx(double rate) {
    wet.prepare(rate);
    wet.reset(0.0f);
  }
  void setType(FxType) noexcept override {}
  void setEnabled(bool on) noexcept override { enabled = on; }
  void setLevel(float v) noexcept override { wet.setTarget(clampv(v, 0.0f, 1.0f), 0.02, frame); }
  void setBeatsMult(float) noexcept override {}
  void setBeatClock(const BeatClock&) noexcept override {}
  float wetGain() const noexcept override { return wet.value(); }
  void process(const float* inL, const float* inR, float* outL, float* outR, int n) noexcept override {
    wet.fill(g.data(), n, frame);
    frame += n;
    for (int i = 0; i < n; i++) {
      outL[i] = enabled ? inL[i] * g[static_cast<size_t>(i)] : 0.0f;
      outR[i] = enabled ? inR[i] * g[static_cast<size_t>(i)] : 0.0f;
    }
  }
};

// ---------------------------------------------------------------------------
// The Mixer fed by the golden inputs, irregular device-like blocks split at
// every call, master output captured.
// ---------------------------------------------------------------------------
struct Rig {
  Mixer m;
  double rate;
  int64_t pos = 0;
  int k = 0;
  std::vector<float> in[kNumDecks][2];
  float scale[kNumDecks] = {1, 1, 1, 1};
  std::vector<float> bl[kNumDecks], br[kNumDecks];
  std::vector<float> outL, outR;
  std::unique_ptr<IdentityFx> units[kNumFxSlots];
  mixtest::FakeColor color;  // identity (gain 1) Color bus
  uint16_t assign = 0x8421;
  explicit Rig(double r) : rate(r) {
    m.prepare(r, kMaxBlockFrames);
    for (int d = 0; d < kNumDecks; d++) {
      bl[d].assign(kMaxBlockFrames, 0.0f);
      br[d].assign(kMaxBlockFrames, 0.0f);
    }
  }
  void identityUnits() {
    for (int s = 0; s < kNumFxSlots; s++) units[s] = std::make_unique<IdentityFx>(rate);
    for (int u = 0; u < kNumFxUnits; u++) m.attachFx(panelUnit(u), units[u].get());
    for (int d = 0; d < kNumDecks; d++) m.attachFx(padUnit(d), units[kNumFxUnits + d].get());
    m.attachFx(masterUnit(), units[8].get());
  }
  void runUntil(int64_t until) {
    while (pos < until) {
      int n = mixtest::blockSize(k++);
      if (pos + n > until) n = static_cast<int>(until - pos);
      DeckInput din[kNumDecks];
      for (int d = 0; d < kNumDecks; d++) {
        for (int c = 0; c < 2; c++) {
          std::vector<float>& dst = c == 0 ? bl[d] : br[d];
          const std::vector<float>& src = in[d][c];
          for (int i = 0; i < n; i++) {
            const size_t f = static_cast<size_t>(pos + i);
            dst[static_cast<size_t>(i)] = f < src.size() ? src[f] * scale[d] : 0.0f;
          }
        }
        din[d].l = bl[d].data();
        din[d].r = br[d].data();
      }
      BlockClock clk;
      clk.frame = pos;
      clk.frames = n;
      clk.sampleRate = rate;
      clk.sampleTime = clk.presentTime = clk.callbackTime = static_cast<double>(pos) / rate;
      {
        rt::Scope rts;
        m.process(din, n, clk);
      }
      outL.insert(outL.end(), m.masterL(), m.masterL() + n);
      outR.insert(outR.end(), m.masterR(), m.masterR() + n);
      pos += n;
    }
  }
};

FxUnitId unitId(const json::Value& v) { return v.isString() && v.asString() == "master" ? masterUnit() : panelUnit(static_cast<int>(v.asNumber(0))); }

// Applies one engine.js call of an "engine" / "master" case to the mixer.
// noDryCut: the render never called syncLock, so the native dry cut is
// neutralized by giving the mirrors a type without dry cut (ROLL: 0).
bool applyCall(Rig& g, const mixtest::Event& e, bool noDryCut) {
  Mixer& m = g.m;
  const std::string& c = e.call;
  const json::Value& a = *e.args;
  if (c == "engine.setDeckEq") m.setDeckEq(static_cast<int>(e.num(0)), static_cast<EqBand>(bandIndex(e.str(1))), static_cast<float>(e.num(2)));
  else if (c == "engine.setDeckTrim") m.setDeckTrim(static_cast<int>(e.num(0)), static_cast<float>(e.num(1)));
  else if (c == "engine.setDeckVolume") m.setDeckVolume(static_cast<int>(e.num(0)), static_cast<float>(e.num(1)));
  else if (c == "engine.setDeckColor") m.setDeckColor(static_cast<int>(e.num(0)), static_cast<float>(e.num(1)));
  else if (c == "engine.setCrossfader") m.setCrossfader(static_cast<float>(e.num(0)));
  else if (c == "engine.setXfSide") m.setXfSide(static_cast<int>(e.num(0)), e.str(1) == "B" ? XfSide::B : XfSide::A);
  else if (c == "engine.setMasterVolume") m.setMasterVolume(static_cast<float>(e.num(0)));
  else if (c == "engine.setMasterFilter") m.setMasterFilter(static_cast<float>(e.num(0)));
  else if (c == "engine.setColorType") {
    ColorType t;
    if (!colorTypeFromName(e.str(0).c_str(), t)) return false;
    m.setColorType(t);
  } else if (c == "engine.setColorEnabled") m.setColorEnabled(a.at(0).asBool(false));
  else if (c == "engine.setFxAssign") {
    const int bit = static_cast<int>(e.num(0)) * 4 + static_cast<int>(e.num(1));
    if (a.at(2).asBool(false)) g.assign = static_cast<uint16_t>(g.assign | (1u << bit));
    else g.assign = static_cast<uint16_t>(g.assign & ~(1u << bit));
    m.setFxAssign(g.assign);
  } else if (c == "engine.updateFxSends") m.updateFxSends();
  else if (c == "engine.ensureMasterFx") m.ensureMasterFx();
  else if (c == "engine.setPadFx") {
    const json::Value& p = a.at(1);
    if (p.isObject()) {
      FxType t;
      if (!fxTypeFromName(p["type"].asString().c_str(), t)) return false;
      m.setPadFx(static_cast<int>(e.num(0)), true, t, static_cast<float>(p["beats"].asNumber(1)), static_cast<float>(p["level"].asNumber(0)));
    } else {
      m.setPadFx(static_cast<int>(e.num(0)), false, FxType::Echo, 1.0f, 0.0f);
    }
  } else if (c == "engine.setPadDryHold") {
    const json::Value& v = a.at(1);
    m.setPadDryHold(static_cast<int>(e.num(0)), v.isNumber() ? static_cast<float>(v.asNumber(0)) : NAN);
  } else if (c == "engine.syncLock") {
    // the native mixer re-evaluates the dry cut every block
  } else if (c == "fx.setType") {
    FxType t;
    if (!fxTypeFromName(e.str(1).c_str(), t)) return false;
    m.setFx(unitId(a.at(0)), kFxType, noDryCut ? FxType::Roll : t, false, 0.0f, 0.0f);
  } else if (c == "fx.setLevel") m.setFx(unitId(a.at(0)), kFxLevel, FxType::Echo, false, static_cast<float>(e.num(1)), 0.0f);
  else if (c == "fx.setEnabled") m.setFx(unitId(a.at(0)), kFxEnabled, FxType::Echo, a.at(1).asBool(false), 0.0f, 0.0f);
  else if (c == "fx.setBeatsMult") m.setFx(unitId(a.at(0)), kFxBeats, FxType::Echo, false, 0.0f, static_cast<float>(e.num(1)));
  else return false;
  return true;
}

// Replays a "master" or "engine" case through the Mixer.
struct Replay {
  std::vector<float> l, r;
  std::vector<int64_t> cuts;  // segment boundaries (event frames, start and end)
  double residual = 0;
  int unknown = 0, offGrid = 0;
  bool ok = false;
};
Replay replayMixer(const std::string& name) {
  Replay rp;
  const mixtest::Golden g = mixtest::loadGolden("mixer", name);
  if (!g.ok) {
    std::printf("    %s: %s\n", name.c_str(), g.why.c_str());
    return rp;
  }
  const double rate = g.meta["sampleRate"].asNumber(48000);
  const std::string kind = g.meta["kind"].asString();
  const bool noDryCut = g.meta["noDryCut"].asBool(false);
  dsp::flushDenormals();
  Rig rig(rate);
  if (g.meta["identityFx"].asBool(false)) rig.identityUnits();
  if (noDryCut)  // the render never ran syncLock: no panel unit may cut a dry (the master's type comes with its fx.setType)
    for (int u = 0; u < kNumFxUnits; u++) rig.m.setFx(panelUnit(u), kFxType, FxType::Roll, false, 0.0f, 0.0f);
  if (g.meta["identityColor"].asBool(false)) rig.m.attachColor(&rig.color);
  const auto& decks = g.meta["decks"].items();
  for (size_t i = 0; i < decks.size(); i++) {
    const int d = static_cast<int>(decks[i].asNumber(0));
    rig.in[d][0] = mixtest::channel(g.input, static_cast<int>(2 * i));
    rig.in[d][1] = mixtest::channel(g.input, static_cast<int>(2 * i + 1));
  }
  if (kind == "master") rig.scale[0] = 1.0f / static_cast<float>(0.85 * 0.85);  // through deck 0's default fader
  const int64_t frames = g.out.frames();
  auto ev = mixtest::events(g.meta);
  rp.offGrid = offGridEvents(ev, rate);
  rp.cuts.push_back(0);
  size_t e = 0;
  while (rig.pos < frames) {
    while (e < ev.size() && ev[e].frame == rig.pos) {
      if (!applyCall(rig, ev[e], noDryCut)) rp.unknown++;
      if (rp.cuts.back() != ev[e].frame) rp.cuts.push_back(ev[e].frame);
      e++;
    }
    rig.runUntil(e < ev.size() ? ev[e].frame : frames);
  }
  rp.cuts.push_back(frames);
  rp.l = std::move(rig.outL);
  rp.r = std::move(rig.outR);
  rp.residual = mixtest::residualStereo(rp.l, rp.r, g.out);
  dumpWav(name, rp.l, rp.r, static_cast<int>(rate));
  rp.ok = true;
  return rp;
}

// ---------------------------------------------------------------------------
// Limiter measurements (the same code on the native and Chromium outputs)
// ---------------------------------------------------------------------------
struct Seg {
  int64_t frame;
  double amp;
};
// Peak envelope over a sliding window of 1.25 periods of the 1 kHz test tone.
std::vector<float> envelope(const std::vector<float>& x, double rate) {
  const int w = static_cast<int>(std::ceil(1.25 * rate / 1000.0));
  std::vector<float> e(x.size(), 0.0f);
  for (size_t i = 0; i < x.size(); i++) {
    const size_t a = i >= static_cast<size_t>(w / 2) ? i - static_cast<size_t>(w / 2) : 0;
    const size_t b = std::min(x.size(), i + static_cast<size_t>(w / 2) + 1);
    float m = 0;
    for (size_t j = a; j < b; j++) m = std::max(m, std::fabs(x[j]));
    e[i] = m;
  }
  return e;
}
// Look-ahead: frames between the first non-zero input sample and the first
// non-zero output sample (the input starts after silence; a correlation
// would be ambiguous on a periodic test tone).
int lagOf(const std::vector<float>& in, const std::vector<float>& out) {
  auto first = [](const std::vector<float>& x) {
    for (size_t i = 0; i < x.size(); i++)
      if (x[i] != 0.0f) return static_cast<int64_t>(i);
    return static_cast<int64_t>(-1);
  };
  const int64_t a = first(in), b = first(out);
  return a >= 0 && b >= 0 ? static_cast<int>(b - a) : -1;
}
double ampAt(const std::vector<Seg>& segs, int64_t f) {
  double a = 0;
  for (const Seg& s : segs)
    if (f >= s.frame) a = s.amp;
  return a;
}
// Gain applied at each output frame, dB: output envelope / input amplitude L frames earlier.
std::vector<double> gainDb(const std::vector<float>& e, const std::vector<Seg>& segs, int lag) {
  std::vector<double> g(e.size(), 0.0);
  for (size_t i = 0; i < e.size(); i++) {
    const double a = ampAt(segs, static_cast<int64_t>(i) - lag);
    g[i] = a > 0 && e[i] > 0 ? 20.0 * std::log10(e[i] / a) : 0.0;
  }
  return g;
}
double meanOf(const std::vector<double>& v, int64_t a, int64_t b) {
  double s = 0;
  int64_t n = 0;
  for (int64_t i = std::max<int64_t>(0, a); i < b && i < static_cast<int64_t>(v.size()); i++, n++) s += v[static_cast<size_t>(i)];
  return n ? s / static_cast<double>(n) : 0.0;
}
struct LimiterNumbers {
  int lag = 0;
  std::vector<double> staticOut;  // staircase: steady output peak level per step (dBFS)
  std::vector<double> attackMs;   // per loud step: to 90 % of the final gain reduction
  std::vector<double> releaseMs;  // per quiet step after a loud one: back within 1 dB of the linear gain
  double linearGainDb = 0;
};
LimiterNumbers limiterNumbers(const std::vector<float>& in, const std::vector<float>& out, const std::vector<Seg>& segs, double rate,
                              bool staircase) {
  LimiterNumbers n;
  const int64_t a = segs[0].frame + static_cast<int64_t>(0.05 * rate);
  const int64_t b = segs.size() > 1 ? segs[1].frame - static_cast<int64_t>(0.03 * rate) : a + static_cast<int64_t>(0.1 * rate);
  n.lag = lagOf(in, out);
  if (n.lag < 0) return n;
  const int64_t w = static_cast<int64_t>(std::ceil(1.25 * rate / 1000.0));  // the envelope window
  const std::vector<float> e = envelope(out, rate);
  const std::vector<double> g = gainDb(e, segs, n.lag);
  n.linearGainDb = meanOf(g, a + n.lag, b);
  for (size_t s = 0; s < segs.size(); s++) {
    const int64_t s0 = segs[s].frame;
    const int64_t s1 = s + 1 < segs.size() ? segs[s + 1].frame : static_cast<int64_t>(out.size()) - n.lag;
    if (staircase) {
      double sum = 0;
      int64_t cnt = 0;
      for (int64_t i = s0 + n.lag + static_cast<int64_t>(0.2 * rate); i < s1 + n.lag && i < static_cast<int64_t>(e.size()); i++, cnt++)
        sum += 20.0 * std::log10(std::max(1e-12f, e[static_cast<size_t>(i)]));
      n.staticOut.push_back(cnt ? sum / static_cast<double>(cnt) : 0.0);
      continue;
    }
    if (s == 0) continue;
    const bool louder = segs[s].amp > segs[s - 1].amp;
    if (louder) {
      const double gf = meanOf(g, s0 + n.lag + static_cast<int64_t>(0.2 * rate), s1 + n.lag - static_cast<int64_t>(0.01 * rate));
      const double target = gf + 0.1 * (n.linearGainDb - gf);
      int64_t i = s0;
      while (i < s1 + n.lag && g[static_cast<size_t>(i)] > target) i++;
      n.attackMs.push_back(1000.0 * static_cast<double>(i - s0) / rate);
    } else {
      // from where the envelope window no longer sees the loud part
      int64_t i = s0 + n.lag + w;
      while (i < s1 + n.lag && i < static_cast<int64_t>(g.size()) && g[static_cast<size_t>(i)] < n.linearGainDb - 1.0) i++;
      n.releaseMs.push_back(1000.0 * static_cast<double>(i - (s0 + n.lag)) / rate);
    }
  }
  return n;
}

}  // namespace

// ---------------------------------------------------------------------------
OM_TEST(mixer_parity_strip_at_44100_and_96000) {
  bool skipped = false;
  const std::vector<std::string> names = mixerCases("strip", &skipped);
  if (skipped) OM_SKIP("OM_GOLDEN_DIR is not set (golden renders, SPEC.md §18.4)");
  OM_CHECK(names.size() >= 9);
  double worst = -400.0, worstBand = 0.0;
  int unknown = 0, offGrid = 0;
  for (const std::string& name : names) {
    const mixtest::Golden g = mixtest::loadGolden("mixer", name);
    MIXTEST_REQUIRE_GOLDEN(g);
    const double rate = g.meta["sampleRate"].asNumber(48000);
    const std::vector<float> inL = mixtest::channel(g.input, 0), inR = mixtest::channel(g.input, 1);
    const int64_t frames = g.out.frames();
    StripRunR s(rate);
    std::vector<float> outL(static_cast<size_t>(frames)), outR(static_cast<size_t>(frames));
    auto ev = mixtest::events(g.meta);
    offGrid += offGridEvents(ev, rate);
    std::vector<int64_t> cuts = {0};
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
        if (cuts.back() != f) cuts.push_back(f);
        e++;
      }
      const int64_t n = (e < ev.size() ? ev[e].frame : frames) - s.pos;
      s.run(inL.data() + s.pos, inR.data() + s.pos, outL.data() + s.pos, outR.data() + s.pos, n);
    }
    cuts.push_back(frames);
    const double res = mixtest::residualStereo(outL, outR, g.out);
    const BandResult br = bandError(outL, outR, g.out, cuts, rate);
    dumpWav(name, outL, outR, static_cast<int>(rate));
    std::printf("    %-22s %6.0f Hz  residual %7.1f dBFS, per-band level error max %.2e dB (%d band levels, worst at %.0f Hz)\n",
                name.c_str(), rate, res, br.worstDb, br.bands, br.atHz);
    worst = std::fmax(worst, res);
    worstBand = std::fmax(worstBand, br.worstDb);
  }
  OM_CHECK(unknown == 0 && offGrid == 0);
  OM_CHECK(worst < kNullDb);
  OM_CHECK(worstBand < kBandDb);
}

OM_TEST(mixer_parity_master_chain_44100) {
  bool skipped = false;
  const std::vector<std::string> names = mixerCases("master", &skipped);
  if (skipped) OM_SKIP("OM_GOLDEN_DIR is not set (golden renders, SPEC.md §18.4)");
  std::vector<std::string> all = names;
  all.push_back("m44_crossfader_curve");  // an "engine" case: two decks through the crossfader
  OM_CHECK(names.size() >= 2);
  double worst = -400.0;
  for (const std::string& name : all) {
    const Replay rp = replayMixer(name);
    OM_CHECK(rp.ok && rp.unknown == 0 && rp.offGrid == 0);
    std::printf("    %-22s residual %7.1f dBFS (%zu segments)\n", name.c_str(), rp.residual, rp.cuts.size() - 1);
    worst = std::fmax(worst, rp.residual);
  }
  OM_CHECK(worst < kNullDb);
}

OM_TEST(mixer_parity_limiter_lookahead_static_curve_attack_release) {
  bool skipped = false;
  const std::vector<std::string> names = mixerCases("limiter", &skipped);
  if (skipped) OM_SKIP("OM_GOLDEN_DIR is not set (golden renders, SPEC.md §18.4)");
  OM_CHECK(names.size() >= 5);
  dsp::flushDenormals();
  double worst = -400.0, worstStatic = 0, worstAttack = 0, worstRelease = 0;
  bool lagsOk = true;
  for (const std::string& name : names) {
    const mixtest::Golden g = mixtest::loadGolden("mixer", name);
    MIXTEST_REQUIRE_GOLDEN(g);
    const double rate = g.meta["sampleRate"].asNumber(48000);
    std::vector<float> l = mixtest::channel(g.input, 0), r = mixtest::channel(g.input, 1);
    const std::vector<float> in = l;
    const int64_t frames = g.out.frames();
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
    dumpWav(name, l, r, static_cast<int>(rate));
    worst = std::fmax(worst, res);
    std::vector<Seg> segs;
    for (const json::Value& s : g.meta["segments"].items()) segs.push_back({static_cast<int64_t>(s["frame"].asNumber(0)), s["amp"].asNumber(0)});
    OM_CHECK(segs.size() >= 2);
    if (segs.size() < 2) continue;
    const bool stairs = name.find("staircase") != std::string::npos;
    const std::vector<float> chromium = mixtest::channel(g.out, 0);
    const LimiterNumbers nn = limiterNumbers(in, l, segs, rate, stairs);
    const LimiterNumbers cn = limiterNumbers(in, chromium, segs, rate, stairs);
    lagsOk &= nn.lag == lim.latencyFrames() && cn.lag == lim.latencyFrames();
    std::printf("    %-20s %6.0f Hz  residual %7.1f dBFS; look-ahead native %d / Chromium %d frames (%.3f ms); linear gain %.4f / %.4f dB\n",
                name.c_str(), rate, res, nn.lag, cn.lag, 1000.0 * nn.lag / rate, nn.linearGainDb, cn.linearGainDb);
    if (stairs) {
      std::printf("      static curve, steady output peak (dBFS): input -> native / Chromium / curve (Limiter::staticCurveDb)\n");
      for (size_t s = 0; s < segs.size() && s < nn.staticOut.size(); s++) {
        const double x = 20.0 * std::log10(segs[s].amp);
        const double d = std::fabs(nn.staticOut[s] - cn.staticOut[s]);
        worstStatic = std::fmax(worstStatic, d);
        std::printf("        %+6.1f -> %+8.4f / %+8.4f / %+8.4f  (|native - Chromium| %.2e dB)\n", x, nn.staticOut[s], cn.staticOut[s],
                    Limiter::staticCurveDb(x, LimiterParams()), d);
      }
    } else {
      for (size_t i = 0; i < nn.attackMs.size() && i < cn.attackMs.size(); i++) {
        worstAttack = std::fmax(worstAttack, std::fabs(nn.attackMs[i] - cn.attackMs[i]));
        std::printf("      attack %zu (to 90 %% of the final reduction): native %.3f ms, Chromium %.3f ms\n", i + 1, nn.attackMs[i], cn.attackMs[i]);
      }
      for (size_t i = 0; i < nn.releaseMs.size() && i < cn.releaseMs.size(); i++) {
        worstRelease = std::fmax(worstRelease, std::fabs(nn.releaseMs[i] - cn.releaseMs[i]));
        std::printf("      release %zu (back within 1 dB of the linear gain): native %.3f ms, Chromium %.3f ms\n", i + 1, nn.releaseMs[i],
                    cn.releaseMs[i]);
      }
    }
  }
  std::printf("    worst: residual %.1f dBFS, static curve %.2e dB, attack %.3f ms, release %.3f ms\n", worst, worstStatic, worstAttack,
              worstRelease);
  OM_CHECK(worst < kNullDb);
  OM_CHECK(lagsOk);
  OM_CHECK(worstStatic < kBandDb);
  OM_CHECK(worstAttack <= 1000.0 / 44100.0 + 1e-9 && worstRelease <= 1000.0 / 44100.0 + 1e-9);  // within a frame
}

OM_TEST(mixer_parity_whole_graph_through_the_mixer_api) {
  bool skipped = false;
  const std::vector<std::string> names = mixerCases("engine", &skipped);
  if (skipped) OM_SKIP("OM_GOLDEN_DIR is not set (golden renders, SPEC.md §18.4)");
  int full = 0;
  double worst = -400.0, worstBand = 0;
  for (const std::string& name : names) {
    if (name.rfind("f", 0) != 0) continue;  // f*_full_chain
    full++;
    const Replay rp = replayMixer(name);
    OM_CHECK(rp.ok && rp.unknown == 0 && rp.offGrid == 0);
    if (!rp.ok) continue;
    const mixtest::Golden g = mixtest::loadGolden("mixer", name);
    const BandResult br = bandError(rp.l, rp.r, g.out, rp.cuts, g.meta["sampleRate"].asNumber(48000));
    std::printf("    %-22s residual %7.1f dBFS, per-band level error max %.2e dB (%d band levels), golden peak %.3f\n", name.c_str(),
                rp.residual, br.worstDb, br.bands, g.meta["peak"].asNumber(0));
    worst = std::fmax(worst, rp.residual);
    worstBand = std::fmax(worstBand, br.worstDb);
  }
  OM_CHECK(full >= 2);
  OM_CHECK(worst < kNullDb);
  OM_CHECK(worstBand < kBandDb);
}

OM_TEST(mixer_parity_fx_sends_returns_dry_cut_and_color_sends) {
  bool skipped = false;
  const std::vector<std::string> names = mixerCases("engine", &skipped);
  if (skipped) OM_SKIP("OM_GOLDEN_DIR is not set (golden renders, SPEC.md §18.4)");
  int n = 0;
  double worst = -400.0;
  for (const std::string& name : names) {
    if (name.rfind("x", 0) != 0 && name.rfind("c", 0) != 0) continue;  // x*_fx_paths, x*_dry_cut, c*_color_sends
    n++;
    const Replay rp = replayMixer(name);
    OM_CHECK(rp.ok && rp.unknown == 0 && rp.offGrid == 0);
    std::printf("    %-22s residual %7.1f dBFS (%zu segments)\n", name.c_str(), rp.residual, rp.cuts.size() - 1);
    worst = std::fmax(worst, rp.residual);
  }
  OM_CHECK(n >= 6);
  OM_CHECK(worst < kNullDb);
}
