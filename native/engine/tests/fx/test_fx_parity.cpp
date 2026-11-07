// Parity measurements of the FX module beyond its null suite (owner: fx;
// dsp-parity campaign, 7 Nov 2026):
//  - the 96 kHz cases of goldens/fx (family "rate96"): residual per case;
//  - the host's goldens/fxunit suite (tools/make-goldens.js: engine.js's
//    FxUnit for every type at levels 0.4 / 1, beat fractions 1/4..1, beat
//    duration 0.468, LFOs restarted by alignTo(0)), never consumed before:
//    modulations compared once the native beat lock has engaged (the native
//    LFO is phase-locked to the beat clock, SPEC.md §11.1), feedback echoes
//    up to their first repeat (Chromium's drift starts with the second),
//    everything else in full;
//  - echo repeats on the beat: every repeat of every delay-family type and
//    Color echo, native and Chromium (goldens/fx family "timing": engine.js's
//    own graphs, one click), measured against an ideal drift-free loop;
//  - CPU per FX unit and per Color type (128- and 256-frame blocks);
//  - FX memory at startup and after every type was used (memoryBytes(), and
//    the process's private bytes on Windows).
// Skipped only when OM_GOLDEN_DIR is unset (the golden parts).
#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <fstream>
#include <iterator>
#include <memory>
#include <string>
#include <vector>

#include "../../src/fx/fx_dsp.h"
#include "../om_test.h"
#include "fx_test_util.h"
#include "om/color_fx.h"
#include "om/convolver.h"
#include "om/fx.h"
#include "om/json.h"
#include "om/rt.h"

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <psapi.h>
#endif

using namespace om;

namespace {

constexpr double kNullDb = -80.0;

bool readText(const std::string& path, std::string& out) {
  std::ifstream f(path, std::ios::binary);
  if (!f) return false;
  out.assign(std::istreambuf_iterator<char>(f), std::istreambuf_iterator<char>());
  return true;
}
bool readJson(const std::string& path, json::Value& v) {
  std::string t, err;
  return readText(path, t) && json::parse(t, v, &err);
}

double residualDb(const std::vector<float>& al, const std::vector<float>& ar, const omtest::Wav& g, size_t from, size_t to) {
  double m = 0;
  to = std::min({to, al.size(), static_cast<size_t>(g.frames())});
  for (size_t i = from; i < to; i++) {
    m = std::max(m, std::fabs(static_cast<double>(al[i]) - g.samples[2 * i]));
    m = std::max(m, std::fabs(static_cast<double>(ar[i]) - g.samples[2 * i + 1]));
  }
  return fxtest::db(m);
}

// The shared reverb kernel of a case: om::makeImpulse (seeded) or an impulse
// saved by a golden generator (raw: normalized here like the ConvolverNode).
std::shared_ptr<const ConvolverKernel> kernelFromWav(const std::string& path, int rate) {
  omtest::Wav w;
  std::string err;
  if (!omtest::readWav(path, w, &err) || w.channels != 2) return nullptr;
  Impulse ir;
  ir.sampleRate = rate;
  const size_t n = static_cast<size_t>(w.frames());
  ir.left.resize(n);
  ir.right.resize(n);
  for (size_t i = 0; i < n; i++) {
    ir.left[i] = w.samples[2 * i];
    ir.right[i] = w.samples[2 * i + 1];
  }
  const float s = convolverNormalizationScale(ir.left, ir.right, rate);
  for (size_t i = 0; i < n; i++) {
    ir.left[i] *= s;
    ir.right[i] *= s;
  }
  ir.normalizationScale = s;
  return ConvolverKernel::build(ir, kMaxBlockFrames);
}

std::unique_ptr<FxUnit> makeUnit(double rate, std::shared_ptr<const ConvolverKernel> kernel) {
  auto u = std::make_unique<FxUnit>();
  u->prepare(rate, kMaxBlockFrames, std::move(kernel));
  for (int t = 0; t < kNumFxTypes; t++) {
    FxChainPtr ch = u->makeChain(static_cast<FxType>(t));
    if (ch && !u->attachChain(static_cast<FxType>(t), ch.get())) (void)ch.release();
  }
  return u;
}
std::unique_ptr<ColorFx> makeColor(double rate, std::shared_ptr<const ConvolverKernel> kernel) {
  auto c = std::make_unique<ColorFx>();
  c->prepare(rate, kMaxBlockFrames, std::move(kernel));
  for (int t = 0; t < kNumColorTypes; t++) {
    FxChainPtr ch = c->makeChain(static_cast<ColorType>(t));
    if (ch && !c->attachChain(static_cast<ColorType>(t), ch.get())) (void)ch.release();
  }
  return c;
}

// Replays a goldens/fx case (make_fx_goldens.js layout) like test_fx_golden.cpp.
struct FxReplay {
  std::vector<float> l, r;
  omtest::Wav gold;
  double rate = 48000;
  size_t compare = 0;
  bool ok = false;
};
FxReplay replayFxCase(const std::string& base, const json::Value& c) {
  FxReplay rp;
  omtest::Wav in;
  std::string err;
  if (!omtest::readWav(base + c["input"].asString(), in, &err) || !omtest::readWav(base + c["output"].asString(), rp.gold, &err)) return rp;
  rp.rate = c["sampleRate"].asNumber(48000);
  const size_t frames = static_cast<size_t>(in.frames());
  std::shared_ptr<const ConvolverKernel> kernel;
  const json::Value& imp = c["impulse"];
  if (imp.isObject())
    kernel = ConvolverKernel::build(makeImpulse(imp["seconds"].asNumber(2.2), imp["decay"].asNumber(2.5), static_cast<int>(rp.rate),
                                                static_cast<uint32_t>(imp["seed"].asNumber(1))),
                                    kMaxBlockFrames);
  const bool color = c["kind"].asString() == "color";
  std::unique_ptr<FxUnit> unit;
  std::unique_ptr<ColorFx> bus;
  if (color) bus = makeColor(rp.rate, kernel);
  else unit = makeUnit(rp.rate, kernel);
  std::vector<float> l(frames), r(frames);
  for (size_t i = 0; i < frames; i++) {
    l[i] = in.samples[2 * i];
    r[i] = in.samples[2 * i + 1];
  }
  rp.l.assign(frames, 0.0f);
  rp.r.assign(frames, 0.0f);
  double beatDur = 0.5;
  const auto& ev = c["events"].items();
  size_t e = 0, pos = 0;
  while (pos < frames) {
    while (e < ev.size() && static_cast<size_t>(ev[e]["frame"].asNumber(0)) <= pos) {
      const std::string op = ev[e]["op"].asString();
      const json::Value& v = ev[e]["value"];
      e++;
      if (color) {
        ColorType t;
        if (op == "colorType" && colorTypeFromName(v.asString().c_str(), t)) bus->setType(t);
        continue;
      }
      FxType t;
      if (op == "setType" && fxTypeFromName(v.asString().c_str(), t)) unit->setType(t);
      else if (op == "setEnabled") unit->setEnabled(v.asBool(false));
      else if (op == "setLevel") unit->setLevel(static_cast<float>(v.asNumber(0)));
      else if (op == "setBeatsMult") unit->setBeatsMult(static_cast<float>(v.asNumber(0.5)));
      else if (op == "setBeatDur") {
        beatDur = v.asNumber(0.5);
        BeatClock bc;
        bc.beatDur = beatDur;
        unit->setBeatClock(bc);
      }
    }
    size_t end = std::min(frames, pos + 128);
    if (e < ev.size()) end = std::min(end, std::max(static_cast<size_t>(ev[e]["frame"].asNumber(0)), pos + 1));
    const int n = static_cast<int>(end - pos);
    rt::Scope rts;
    if (color) {
      bus->process(l.data() + pos, r.data() + pos, rp.l.data() + pos, rp.r.data() + pos, n);
    } else {
      BeatClock bc;
      bc.beatDur = beatDur;
      unit->setBeatClock(bc);
      unit->process(l.data() + pos, r.data() + pos, rp.l.data() + pos, rp.r.data() + pos, n);
    }
    pos = end;
  }
  rp.compare = std::min(frames, static_cast<size_t>(c["compareFrames"].asNumber(static_cast<double>(frames))));
  rp.ok = true;
  return rp;
}

std::vector<json::Value> fxCasesOfFamily(const std::string& base, const char* family) {
  std::vector<json::Value> out;
  json::Value manifest;
  if (!readJson(base + "manifest.json", manifest)) return out;
  for (const json::Value& n : manifest["cases"].items()) {
    json::Value c;
    if (readJson(base + n.asString() + ".json", c) && c["family"].asString() == family) out.push_back(c);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Echo timing: |y| centroids of every repeat against an ideal drift-free loop
// ---------------------------------------------------------------------------
struct LoopSpec {
  double fb = 0;
  bool hasFilter = false;
  dsp::BiquadType filter = dsp::BiquadType::Highpass;
  double freq = 0, q = 1;
  bool outFilter = false;
  int crush = 0;          // crushCurve steps in the loop (Color crushecho)
  bool pingpong = false;  // unfiltered: repeat k at k * D exactly
};
LoopSpec unitSpec(FxType t) {
  using BT = dsp::BiquadType;
  auto fbFor = [](double base) { return std::min(0.97, base); };  // level 1
  switch (t) {
    case FxType::Echo: return {fbFor(0.45), true, BT::Highpass, 120, 1, false, 0, false};
    case FxType::Delay: return {fbFor(0.22), false, BT::Highpass, 0, 1, false, 0, false};
    case FxType::PingPong: return {fbFor(0.42), false, BT::Highpass, 0, 1, false, 0, true};
    case FxType::LowCut: return {fbFor(0.5), true, BT::Highpass, 700, 1, false, 0, false};
    case FxType::Spiral: return {fbFor(0.72), true, BT::Bandpass, 900, 0.9, true, 0, false};
    case FxType::UpEcho: return {fbFor(0.5), true, BT::Highpass, 500, 1, true, 0, false};
    case FxType::DownEcho: return {fbFor(0.5), true, BT::Lowpass, 1200, 1, true, 0, false};
    case FxType::Helix: return {fbFor(0.97), false, BT::Highpass, 0, 1, false, 0, false};
    default: return {};
  }
}
LoopSpec colorSpec(ColorType t) {
  using BT = dsp::BiquadType;
  switch (t) {
    case ColorType::DubEcho: return {0.55, true, BT::Highpass, 250, 1, true, 0, false};
    case ColorType::HpfEcho: return {0.5, true, BT::Highpass, 900, 1, true, 0, false};
    case ColorType::LpfEcho: return {0.5, true, BT::Lowpass, 650, 1, true, 0, false};
    case ColorType::BpfEcho: return {0.55, true, BT::Bandpass, 1000, 1, true, 0, false};
    case ColorType::CrushEcho: return {0.5, false, BT::Highpass, 0, 1, true, 6, false};
    default: return {};
  }
}
// Ideal loop in double: exact (fractional) delay D, linear interpolation,
// the same loop filter (Web Audio coefficients) or crush shaper.
std::vector<double> idealLoop(const LoopSpec& s, double D, double rate, const std::vector<float>& x) {
  const size_t n = x.size();
  std::vector<double> line(n, 0.0), out(n, 0.0);
  const dsp::BiquadCoeffs c = s.hasFilter ? dsp::webAudioBiquad(s.filter, rate, s.freq, s.q, 0.0) : dsp::BiquadCoeffs{};
  std::vector<float> curve(fx::kCurveLength, 0.0f);
  if (s.crush) fx::makeCrushCurve(s.crush, curve.data());
  double x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (size_t t = 0; t < n; t++) {
    const double p = static_cast<double>(t) - D;
    double y = 0;
    if (p >= 0) {
      const size_t i = static_cast<size_t>(p);
      const double f = p - static_cast<double>(i);
      y = (1 - f) * line[i] + f * (i + 1 < t ? line[i + 1] : 0.0);
    }
    double z = y;
    if (s.hasFilter) {
      z = c.b0 * y + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
      x2 = x1;
      x1 = y;
      y2 = y1;
      y1 = z;
    }
    if (s.crush) z = fx::shape(curve.data(), static_cast<float>(z));
    line[t] = x[t] + s.fb * z;
    out[t] = s.outFilter || s.crush ? z : y;
  }
  return out;
}
template <class V>
double centroidAbs(const V& y, double a, double b) {
  double s = 0, w = 0;
  const size_t i0 = static_cast<size_t>(std::max(0.0, std::floor(a)));
  const size_t i1 = std::min(y.size(), static_cast<size_t>(std::max(0.0, std::ceil(b))));
  for (size_t i = i0; i < i1; i++) {
    const double v = std::fabs(static_cast<double>(y[i]));
    s += v * static_cast<double>(i);
    w += v;
  }
  return w > 0 ? s / w : -1;
}

// Private bytes of this process (Windows), 0 elsewhere.
double privateMb() {
#ifdef _WIN32
  PROCESS_MEMORY_COUNTERS_EX pmc{};
  if (GetProcessMemoryInfo(GetCurrentProcess(), reinterpret_cast<PROCESS_MEMORY_COUNTERS*>(&pmc), sizeof(pmc)))
    return static_cast<double>(pmc.PrivateUsage) / (1024.0 * 1024.0);
#endif
  return 0.0;
}

}  // namespace

// ---------------------------------------------------------------------------
OM_TEST(fx_parity_96000_hz_cases) {
  const std::string base = omtest::goldenPath("fx/");
  if (base.empty()) OM_SKIP("OM_GOLDEN_DIR is not set (run tests/fx/goldens/make_fx_goldens.js)");
  const std::vector<json::Value> cases = fxCasesOfFamily(base, "rate96");
  OM_CHECK(cases.size() >= 10);
  int failed = 0;
  for (const json::Value& c : cases) {
    const FxReplay rp = replayFxCase(base, c);
    OM_CHECK(rp.ok);
    if (!rp.ok) continue;
    const double res = residualDb(rp.l, rp.r, rp.gold, 0, rp.compare);
    std::printf("    %-24s %6.0f Hz  residual %7.1f dBFS\n", c["case"].asString().c_str(), rp.rate, res);
    if (!(res < kNullDb)) failed++;
  }
  OM_CHECK(failed == 0);
}

OM_TEST(fx_parity_fxunit_suite_engine_js) {
  const std::string base = omtest::goldenPath("fxunit/");
  if (base.empty()) OM_SKIP("OM_GOLDEN_DIR is not set (run tools/make-goldens.js)");
  json::Value index;
  OM_CHECK(readJson(omtest::goldenPath("index.json"), index));
  const std::shared_ptr<const ConvolverKernel> kernel = kernelFromWav(base + "reverb_impulse.wav", 48000);
  OM_CHECK(kernel != nullptr);
  int cases = 0, failed = 0;
  double worstFull = -400, worstMod = -400, worstFirst = -400;
  for (const json::Value& entry : index["cases"].items()) {
    if (entry["suite"].asString() != "fxunit") continue;
    const std::string name = entry["case"].asString();
    json::Value c;
    omtest::Wav in, gold;
    std::string err;
    if (!readJson(base + name + ".json", c) || !omtest::readWav(base + name + ".input.wav", in, &err) ||
        !omtest::readWav(base + name + ".wav", gold, &err)) {
      std::printf("    %s: unreadable\n", name.c_str());
      failed++;
      continue;
    }
    cases++;
    const double rate = c["sampleRate"].asNumber(48000);
    const size_t frames = static_cast<size_t>(gold.frames());
    FxType type = FxType::Echo;
    float level = 0, beats = 0.5f;
    double beatDur = 0.5;
    for (const json::Value& e : c["events"].items()) {
      const std::string call = e["call"].asString();
      const json::Value& a = e["args"].at(0);
      if (call == "unit.setType") fxTypeFromName(a.asString().c_str(), type);
      else if (call == "unit.setLevel") level = static_cast<float>(a.asNumber(0));
      else if (call == "unit.setBeatsMult") beats = static_cast<float>(a.asNumber(0.5));
      else if (call == "unit.setBeatDur") beatDur = a.asNumber(0.5);
    }
    auto unit = makeUnit(rate, kernel);
    // engine.js order: setType, setBeatsMult, setBeatDur, setLevel, setEnabled, alignTo(0)
    unit->setType(type);
    unit->setBeatsMult(beats);
    BeatClock bc;
    bc.valid = bc.playing = true;
    bc.beatDur = beatDur;
    bc.beatsPerSec = 1.0 / beatDur;
    bc.beatPos = 0;
    unit->setBeatClock(bc);
    unit->setLevel(level);
    unit->setEnabled(true);
    std::vector<float> l(frames), r(frames), ol(frames), orr(frames);
    for (size_t i = 0; i < frames; i++) {
      l[i] = in.samples[2 * i];
      r[i] = in.samples[2 * i + 1];
    }
    for (size_t pos = 0; pos < frames; pos += 128) {
      const int n = static_cast<int>(std::min<size_t>(128, frames - pos));
      bc.beatPos = static_cast<double>(pos) * bc.beatsPerSec / rate;  // beat 0 at frame 0 (the golden's grid)
      rt::Scope rts;
      unit->setBeatClock(bc);
      unit->process(l.data() + pos, r.data() + pos, ol.data() + pos, orr.data() + pos, n);
    }
    // what is comparable
    const double P = unit->modPeriodBeats();
    const double D = std::min(std::max(beatDur * beats, 0.02), 3.9) * rate;
    size_t from = 0, to = frames;
    const char* how = "full";
    const bool feedback = type == FxType::Echo || type == FxType::Delay || type == FxType::PingPong || type == FxType::LowCut ||
                          type == FxType::Spiral || type == FxType::UpEcho || type == FxType::DownEcho || type == FxType::Helix;
    if (P > 0) {
      const double G = P < 1 ? P : std::min(P, 4.0);  // the native lock starts at the first boundary after beat 0
      from = static_cast<size_t>((G * beatDur + 0.2) * rate);
      how = "after the beat lock";
    } else if (feedback) {
      to = static_cast<size_t>(0.05 * rate + 2 * D) - 16;  // click at 0.05 s: up to its first repeat
      how = "first repeat";
    }
    const double res = from < to ? residualDb(ol, orr, gold, from, to) : -400.0;
    std::printf("    %-24s residual %7.1f dBFS over [%.3f, %.3f) s (%s)\n", name.c_str(), res, from / rate, to / rate, how);
    const std::string dump = omtest::envString("OM_FX_DUMP");
    if (!dump.empty()) {  // <case>.fxunit.native.wav (float32 stereo), to study a residual
      std::ofstream f(dump + "/" + name + ".fxunit.native.wav", std::ios::binary);
      auto u32 = [&](uint32_t v) { f.write(reinterpret_cast<const char*>(&v), 4); };
      auto u16 = [&](uint16_t v) { f.write(reinterpret_cast<const char*>(&v), 2); };
      const uint32_t bytes = static_cast<uint32_t>(frames * 8);
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
      for (size_t i = 0; i < frames; i++) {
        f.write(reinterpret_cast<const char*>(&ol[i]), 4);
        f.write(reinterpret_cast<const char*>(&orr[i]), 4);
      }
    }
    // TRANS after the lock: the native gate follows the exact beat grid,
    // Chromium's alignTo() oscillator accumulates a float increment (4 Hz:
    // 0.34133333 table units, 1e-8 low), so its band-limited square edges
    // drift ~5e-4 table units (1.5e-3 frames) late over 3 s: about -70 dBFS
    // at the edges, the deliberate continuous lock of SPEC.md §20. Bounded at
    // -60 dBFS; every other comparison at -80 dBFS.
    const double limit = (type == FxType::Trans && P > 0) ? -60.0 : kNullDb;
    if (!(res < limit)) failed++;
    if (P > 0) worstMod = std::max(worstMod, res);
    else if (feedback) worstFirst = std::max(worstFirst, res);
    else worstFull = std::max(worstFull, res);
  }
  std::printf("    %d cases; worst: full %.1f dBFS, modulations after the lock %.1f dBFS, echoes to the first repeat %.1f dBFS\n", cases,
              worstFull, worstMod, worstFirst);
  OM_CHECK(cases >= 50);
  OM_CHECK(failed == 0);
}

OM_TEST(fx_parity_echo_repeats_on_the_beat) {
  const std::string base = omtest::goldenPath("fx/");
  if (base.empty()) OM_SKIP("OM_GOLDEN_DIR is not set (run tests/fx/goldens/make_fx_goldens.js)");
  const std::vector<json::Value> cases = fxCasesOfFamily(base, "timing");
  OM_CHECK(cases.size() >= 15);
  double worstNative = 0, worstChromiumSlopeDev = 0;
  int repeatsMeasured = 0;
  for (const json::Value& c : cases) {
    const FxReplay rp = replayFxCase(base, c);
    OM_CHECK(rp.ok);
    if (!rp.ok) continue;
    const double rate = rp.rate;
    const bool color = c["kind"].asString() == "color";
    LoopSpec spec;
    double D = 0;
    std::string type;
    for (const json::Value& e : c["events"].items()) {
      const std::string op = e["op"].asString();
      if (op == "setType" || op == "colorType") type = e["value"].asString();
    }
    double beatDur = 0.5, beats = 0.5;
    for (const json::Value& e : c["events"].items()) {
      if (e["op"].asString() == "setBeatDur") beatDur = e["value"].asNumber(0.5);
      if (e["op"].asString() == "setBeatsMult") beats = e["value"].asNumber(0.5);
    }
    if (color) {
      ColorType t;
      if (!colorTypeFromName(type.c_str(), t)) continue;
      spec = colorSpec(t);
      D = static_cast<double>(static_cast<float>(t == ColorType::DubEcho ? 0.35 : 0.3)) * rate;
    } else {
      FxType t;
      if (!fxTypeFromName(type.c_str(), t)) continue;
      spec = unitSpec(t);
      D = std::min(std::max(beatDur * beats, 0.02), 3.9) * rate;
    }
    // the click
    omtest::Wav in;
    std::string err;
    omtest::readWav(base + c["input"].asString(), in, &err);
    std::vector<float> click = std::vector<float>(static_cast<size_t>(in.frames()), 0.0f);
    size_t i0 = 0;
    for (size_t i = 0; i < click.size(); i++) {
      click[i] = in.samples[2 * i];
      if (click[i] != 0.0f) i0 = i;
    }
    const std::vector<double> ideal = spec.pingpong ? std::vector<double>() : idealLoop(spec, D, rate, click);
    // per-repeat |y| (both channels: ping-pong alternates sides)
    std::vector<float> nat(rp.l.size()), chr(rp.l.size());
    for (size_t i = 0; i < nat.size(); i++) {
      nat[i] = std::fabs(rp.l[i]) + std::fabs(rp.r[i]);
      chr[i] = std::fabs(rp.gold.samples[2 * i]) + std::fabs(rp.gold.samples[2 * i + 1]);
    }
    double worstHere = 0;
    std::vector<double> drift;
    std::string row;
    for (int k = 1;; k++) {
      const double expect = static_cast<double>(i0) + k * D;
      if (expect + 0.7 * D >= static_cast<double>(nat.size())) break;
      const double ci = spec.pingpong ? expect : centroidAbs(ideal, expect - 0.3 * D, expect + 0.7 * D);
      const double cn = centroidAbs(nat, expect - 0.3 * D, expect + 0.7 * D);
      const double cc = centroidAbs(chr, expect - 0.3 * D, expect + 0.7 * D);
      if (ci < 0 || cn < 0) break;
      worstHere = std::max(worstHere, std::fabs(cn - ci));
      drift.push_back(cc - ci);
      repeatsMeasured++;
      char buf[48];
      std::snprintf(buf, sizeof(buf), " %+.1f", cc - ci);
      row += buf;
    }
    // Chromium: frames late per repeat (least squares through (k, drift_k))
    double sk = 0, sd = 0, skk = 0, skd = 0;
    for (size_t k = 0; k < drift.size(); k++) {
      sk += static_cast<double>(k + 1);
      sd += drift[k];
      skk += static_cast<double>((k + 1) * (k + 1));
      skd += static_cast<double>(k + 1) * drift[k];
    }
    const double m = static_cast<double>(drift.size());
    const double slope = m > 1 ? (m * skd - sk * sd) / (m * skk - sk * sk) : 0.0;
    worstNative = std::max(worstNative, worstHere);
    // ping-pong: one DelayNode cycle (L -> R -> fb -> L) per two repeats
    if (drift.size() > 2 && !spec.pingpong) worstChromiumSlopeDev = std::max(worstChromiumSlopeDev, std::fabs(slope - 128.0));
    std::printf("    %-24s %6.0f Hz  D %9.3f frames, %zu repeats: native worst |error| %.3f frames; Chromium late by%s frames (%.2f per %s)\n",
                c["case"].asString().c_str(), rate, D, drift.size(), worstHere, row.c_str(), spec.pingpong ? 2 * slope : slope,
                spec.pingpong ? "cycle of 2 repeats" : "repeat");
  }
  std::printf("    %d repeats measured: native worst %.3f frames from the beat; Chromium %.2f frames per repeat off 128 at most\n",
              repeatsMeasured, worstNative, worstChromiumSlopeDev);
  OM_CHECK(repeatsMeasured > 60);
  OM_CHECK(worstNative < 1.0);
}

OM_TEST(fx_parity_cpu_per_unit_128_and_256_frame_blocks) {
  const double rate = 48000;
  const Impulse ir = makeImpulse(2.2, 2.5, 48000, 0x0f00d5edu);
  const auto kernel = ConvolverKernel::build(ir, kMaxBlockFrames);
  const auto ckernel = ConvolverKernel::build(makeImpulse(2.8, 2.2, 48000, 0x0c0102edu), kMaxBlockFrames);
  const fxtest::Stereo in = fxtest::noise(static_cast<size_t>(rate), 7, 0.4f);
  std::vector<float> ol(2048), orr(2048);
  const char* tag = fxtest::kOptimized ? "" : " [debug build: not representative]";
  std::printf("    us per block at 48 kHz (median of 5 runs of 1 s of audio)%s\n", tag);
  double worst256 = 0;
  for (int block : {128, 256}) {
    const double period = 1e6 * block / rate;
    for (int t = 0; t < kNumFxTypes; t++) {
      auto u = makeUnit(rate, kernel);
      u->setType(static_cast<FxType>(t));
      u->setBeatsMult(0.5f);
      u->setLevel(1.0f);
      u->setEnabled(true);
      BeatClock bc;
      bc.valid = bc.playing = true;
      size_t pos = 0;
      const double sec = fxtest::secondsPerCall(
          [&] {
            if (pos + static_cast<size_t>(block) > in.size()) pos = 0;
            bc.beatPos = static_cast<double>(pos) * 2.0 / rate;
            u->setBeatClock(bc);
            u->process(in.l.data() + pos, in.r.data() + pos, ol.data(), orr.data(), block);
            pos += static_cast<size_t>(block);
          },
          static_cast<int>(rate / block));
      const double us = sec * 1e6;
      if (block == 256) worst256 = std::max(worst256, us / period);
      std::printf("      %4d frames  unit %-9s %8.3f us = %6.3f %%\n", block, fxTypeName(static_cast<FxType>(t)), us, 100.0 * us / period);
    }
    for (ColorType t : {ColorType::DubEcho, ColorType::HpfEcho, ColorType::LpfEcho, ColorType::BpfEcho, ColorType::CrushEcho,
                        ColorType::Reverb, ColorType::Crush}) {
      auto c = makeColor(rate, ckernel);
      c->setType(t);
      size_t pos = 0;
      const double sec = fxtest::secondsPerCall(
          [&] {
            if (pos + static_cast<size_t>(block) > in.size()) pos = 0;
            c->process(in.l.data() + pos, in.r.data() + pos, ol.data(), orr.data(), block);
            pos += static_cast<size_t>(block);
          },
          static_cast<int>(rate / block));
      std::printf("      %4d frames  color %-8s %8.3f us = %6.3f %%\n", block, colorTypeName(t), sec * 1e6, 100.0 * sec * 1e6 / period);
    }
  }
  std::printf("    worst unit: %.3f %% of a 256-frame block (SPEC.md §11.7 budget: 2 %%)%s\n", 100.0 * worst256, tag);
  if (fxtest::kOptimized) OM_CHECK(worst256 < 0.02);
}

OM_TEST(fx_parity_memory_at_startup_and_after_every_type) {
  const double rate = 48000;
  const double mb0 = privateMb();
  const auto kernel = ConvolverKernel::build(makeImpulse(2.2, 2.5, 48000, 0x0f00d5edu), kMaxBlockFrames);
  const auto ckernel = ConvolverKernel::build(makeImpulse(2.8, 2.2, 48000, 0x0c0102edu), kMaxBlockFrames);
  // engine start (SPEC.md §11.5): the four panel units and the Color bus, no lazy chain
  std::vector<std::unique_ptr<FxUnit>> units;
  for (int i = 0; i < 4; i++) {
    units.push_back(std::make_unique<FxUnit>());
    units.back()->prepare(rate, kMaxBlockFrames, kernel);
  }
  auto color = std::make_unique<ColorFx>();
  color->prepare(rate, kMaxBlockFrames, ckernel);
  const double mbStart = privateMb();
  size_t startBytes = color->memoryBytes() + kernel->memoryBytes() + ckernel->memoryBytes();
  for (const auto& u : units) startBytes += u->memoryBytes();
  // every unit (4 panel + 4 pad + master) after every type was used, every Color type too
  for (int i = 0; i < 5; i++) {
    units.push_back(std::make_unique<FxUnit>());
    units.back()->prepare(rate, kMaxBlockFrames, kernel);
  }
  for (auto& u : units)
    for (int t = 0; t < kNumFxTypes; t++) {
      FxChainPtr ch = u->makeChain(static_cast<FxType>(t));
      if (ch && !u->attachChain(static_cast<FxType>(t), ch.get())) (void)ch.release();
    }
  for (int t = 0; t < kNumColorTypes; t++) {
    FxChainPtr ch = color->makeChain(static_cast<ColorType>(t));
    if (ch && !color->attachChain(static_cast<ColorType>(t), ch.get())) (void)ch.release();
  }
  const double mbAll = privateMb();
  size_t allBytes = color->memoryBytes() + kernel->memoryBytes() + ckernel->memoryBytes();
  for (const auto& u : units) allBytes += u->memoryBytes();
  // one panel unit that used every type
  const size_t oneUnitAll = units[0]->memoryBytes();
  std::printf("    at engine start (4 panel units + Color bus + shared 2.2 s / 2.8 s kernels): %.2f MB by memoryBytes()", startBytes / 1048576.0);
  if (mb0 > 0) std::printf(", private bytes +%.2f MB", mbStart - mb0);
  std::printf("\n    one unit after every type: %.2f MB; all 9 units and the Color bus after every type: %.2f MB by memoryBytes()",
              oneUnitAll / 1048576.0, allBytes / 1048576.0);
  if (mb0 > 0) std::printf(", private bytes +%.2f MB", mbAll - mb0);
  std::printf("\n    Color bus with every chain: %.2f MB\n", color->memoryBytes() / 1048576.0);
  OM_CHECK(startBytes < 16u * 1024u * 1024u);  // SPEC.md §11.5: the four echo lines plus the shared kernels
  // memoryBytes() accounts for what the process really allocated (within 10 %,
  // allocator overheads aside; not under AddressSanitizer, whose redzones,
  // shadow memory and quarantine add ~14 % to the private bytes)
#if !defined(__SANITIZE_ADDRESS__)
  if (mb0 > 0) OM_CHECK(std::fabs((mbAll - mb0) - allBytes / 1048576.0) < 0.1 * (allBytes / 1048576.0) + 2.0);
#endif
}
