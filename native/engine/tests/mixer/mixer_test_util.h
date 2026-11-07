// Test helpers of the mixer module (owner: mixer): fake FX processors and
// a fake Color processor (the FX seam: no real FX unit is linked), a fake
// two-phase insert that records the call order and can be late (then it
// returns the latency-aligned dry, like the VST host), signal generators,
// the steady-state gain of the Chromium limiter below its threshold, and the
// loader of the golden references rendered by Chromium itself
// (tools/make-goldens.js -> OM_GOLDEN_DIR/<suite>/<case>.{json,wav,input.wav},
// SPEC.md §18.4). Tests only: these helpers allocate.
#pragma once

#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

#include "../om_test.h"
#include "om/common.h"
#include "om/json.h"
#include "om/limiter.h"

namespace mixtest {

// ---------------------------------------------------------------------------
// FX seam fakes
// ---------------------------------------------------------------------------
// Passthrough unit: wet = input x wet gain (the level, applied at once),
// silence when disabled. Records what it was given.
struct FakeFx final : om::IFxProcessor {
  om::FxType type = om::FxType::Echo;
  bool enabled = false;
  float level = 0.0f, beats = 0.5f;
  int calls = 0;            // parameter setter calls
  int processCalls = 0;
  int beatClocks = 0;
  om::BeatClock lastClock;
  std::vector<float> lastInL, lastInR;  // input of the last process() (pre-sized: no allocation in RT scope)
  double inputEnergy = 0;   // sum of squares of everything received
  FakeFx() : lastInL(om::kMaxBlockFrames, 0.0f), lastInR(om::kMaxBlockFrames, 0.0f) {}
  void setType(om::FxType t) noexcept override { type = t, calls++; }
  void setEnabled(bool on) noexcept override { enabled = on, calls++; }
  void setLevel(float v) noexcept override { level = v, calls++; }
  void setBeatsMult(float m) noexcept override { beats = m, calls++; }
  void setBeatClock(const om::BeatClock& bc) noexcept override { lastClock = bc, beatClocks++; }
  float wetGain() const noexcept override { return enabled ? level : 0.0f; }
  void process(const float* inL, const float* inR, float* outL, float* outR, int n) noexcept override {
    processCalls++;
    const float g = wetGain();
    for (int i = 0; i < n; i++) {
      lastInL[static_cast<size_t>(i)] = inL[i];
      lastInR[static_cast<size_t>(i)] = inR[i];
      inputEnergy += static_cast<double>(inL[i]) * inL[i] + static_cast<double>(inR[i]) * inR[i];
      outL[i] = inL[i] * g;
      outR[i] = inR[i] * g;
    }
  }
};

// Color bus fake: output = input x gain (before the mixer's 0.85 colorWet).
struct FakeColor final : om::IColorProcessor {
  om::ColorType type = om::ColorType::Filter;
  int typeCalls = 0;
  float gain = 1.0f;
  double inputEnergy = 0;
  void setType(om::ColorType t) noexcept override { type = t, typeCalls++; }
  void process(const float* inL, const float* inR, float* outL, float* outR, int n) noexcept override {
    for (int i = 0; i < n; i++) {
      inputEnergy += static_cast<double>(inL[i]) * inL[i] + static_cast<double>(inR[i]) * inR[i];
      outL[i] = inL[i] * gain;
      outR[i] = inR[i] * gain;
    }
  }
};

// Two-phase insert fake (SPEC.md §10.6, §13.2): records every call in
// order; an active deck's "plugin" multiplies by `gain`; a LATE deck
// returns its dry delayed by `latency` frames (the latency-aligned dry);
// `nanAt` >= 0 makes the plugin output a NaN at that absolute frame.
struct FakeInsert final : om::IInsert {
  struct Call {
    char what;  // 'b' begin, 'e' end
    int deck;
  };
  Call calls[4096];
  int ncalls = 0;
  bool active[om::kNumDecks] = {false, false, false, false};
  bool late[om::kNumDecks] = {false, false, false, false};
  float gain[om::kNumDecks] = {1, 1, 1, 1};
  int latency[om::kNumDecks] = {0, 0, 0, 0};
  int64_t nanAt[om::kNumDecks] = {-1, -1, -1, -1};
  std::vector<float> dryL[om::kNumDecks], dryR[om::kNumDecks];  // delay lines (pre-sized)
  int64_t written[om::kNumDecks] = {0, 0, 0, 0};
  std::vector<float> inL[om::kNumDecks], inR[om::kNumDecks];    // block given to begin()
  FakeInsert() {
    for (int d = 0; d < om::kNumDecks; d++) {
      dryL[d].assign(1 << 16, 0.0f);
      dryR[d].assign(1 << 16, 0.0f);
      inL[d].assign(om::kMaxBlockFrames, 0.0f);
      inR[d].assign(om::kMaxBlockFrames, 0.0f);
    }
  }
  bool begin(int d, const float* l, const float* r, int n) noexcept override {
    if (ncalls < 4096) calls[ncalls++] = {'b', d};
    for (int i = 0; i < n; i++) {
      inL[d][static_cast<size_t>(i)] = l[i];
      inR[d][static_cast<size_t>(i)] = r[i];
      const size_t k = static_cast<size_t>((written[d] + i) & ((1 << 16) - 1));
      dryL[d][k] = l[i];
      dryR[d][k] = r[i];
    }
    written[d] += n;
    return active[d];
  }
  void end(int d, float* l, float* r, int n) noexcept override {
    if (ncalls < 4096) calls[ncalls++] = {'e', d};
    const int64_t start = written[d] - n;
    if (late[d]) {
      for (int i = 0; i < n; i++) {
        const int64_t f = start - latency[d] + i;
        const size_t k = static_cast<size_t>(f & ((1 << 16) - 1));
        l[i] = f >= 0 ? dryL[d][k] : 0.0f;
        r[i] = f >= 0 ? dryR[d][k] : 0.0f;
      }
    } else {
      for (int i = 0; i < n; i++) {
        l[i] *= gain[d];
        r[i] *= gain[d];
      }
    }
    if (nanAt[d] >= start && nanAt[d] < start + n) l[nanAt[d] - start] = std::nanf("");
  }
  int latencyFrames(int d) const noexcept override { return latency[d]; }
};

// ---------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------
inline std::vector<float> constant(size_t n, float v) { return std::vector<float>(n, v); }
inline std::vector<float> sine(size_t n, double hz, double amp, double rate = 48000.0, double phase = 0.0) {
  std::vector<float> v(n);
  for (size_t i = 0; i < n; i++) v[i] = static_cast<float>(amp * std::sin(2 * om::kPi * hz * i / rate + phase));
  return v;
}
inline std::vector<float> noise(size_t n, float amp, uint32_t seed) {
  std::vector<float> v(n);
  uint32_t x = seed ? seed : 1u;
  for (size_t i = 0; i < n; i++) {
    x ^= x << 13;
    x ^= x >> 17;
    x ^= x << 5;
    v[i] = amp * (static_cast<float>(x) / 4294967296.0f * 2.0f - 1.0f);
  }
  return v;
}
inline double rmsOf(const float* x, size_t n) {
  double s = 0;
  for (size_t i = 0; i < n; i++) s += static_cast<double>(x[i]) * x[i];
  return n ? std::sqrt(s / static_cast<double>(n)) : 0.0;
}
inline double peakOf(const float* x, size_t n) {
  double m = 0;
  for (size_t i = 0; i < n; i++) m = std::fabs(x[i]) > m ? std::fabs(x[i]) : m;
  return m;
}
// Irregular device-like block sizes (shared-mode WASAPI, 441-frame periods, sub-block splits).
inline int blockSize(int k) {
  static const int sizes[] = {128, 480, 441, 333, 1024, 64, 7, 256, 2048, 199, 512, 96};
  return sizes[k % 12];
}

// Relative comparison that prints both values when it fails.
inline bool near(double got, double want, double rel, const char* what = "") {
  const bool ok = std::fabs(got - want) <= rel * std::fmax(1e-12, std::fabs(want));
  if (!ok) std::printf("    %s: got %.9g, want %.9g (rel %.3g)\n", what, got, want, (got - want) / want);
  return ok;
}

// The gain Chromium's DynamicsCompressor applies in its steady state below
// the threshold: the makeup (+1.65 dB) x sin(pi/2 x the compressor gain the
// detector settles on). In float, the detector's release stops ~260 ulps
// below 1 (its increment rounds away), so the gain is ~1.5e-5 below the
// makeup — Chromium does the same (golden renders). Measured, not assumed.
inline double steadyLimiterGain(double rate = 48000.0) {
  om::Limiter lim;
  lim.prepare(rate);
  std::vector<float> l(96000, 0.01f), r(96000, 0.01f);
  lim.process(l.data(), r.data(), 96000);
  return static_cast<double>(l.back()) / 0.01;
}

// ---------------------------------------------------------------------------
// Golden references rendered by Chromium (tools/make-goldens.js, SPEC.md §18.4)
// ---------------------------------------------------------------------------
struct Golden {
  om::json::Value meta;
  omtest::Wav out;     // the Chromium render <case>.wav
  omtest::Wav input;   // what it was fed (<case>.input.wav)
  std::string dir;     // the golden root (for meta "files")
  std::string why;     // reason when not available
  bool ok = false;
};

inline bool readText(const std::string& path, std::string& text) {
  FILE* f = std::fopen(path.c_str(), "rb");
  if (!f) return false;
  char buf[4096];
  size_t k;
  while ((k = std::fread(buf, 1, sizeof(buf), f)) > 0) text.append(buf, k);
  std::fclose(f);
  return true;
}

// Loads <suite>/<name>.json, .wav and its input. ok = false with `why` set
// when OM_GOLDEN_DIR is unset (the only accepted reason to skip) or when the
// case is missing / unreadable (callers fail then: a golden run must not
// silently skip a case).
inline Golden loadGolden(const std::string& suite, const std::string& name) {
  Golden g;
  const std::string base = omtest::goldenPath(suite + "/" + name);
  if (base.empty()) {
    g.why = "OM_GOLDEN_DIR is not set (golden renders, SPEC.md §18.4)";
    return g;
  }
  g.dir = base.substr(0, base.size() - (suite.size() + 1 + name.size()));
  std::string text, err;
  if (!readText(base + ".json", text)) {
    g.why = "golden case missing: " + base + ".json";
    return g;
  }
  if (!om::json::parse(text, g.meta, &err)) {
    g.why = "bad golden json: " + err;
    return g;
  }
  if (!omtest::readWav(base + ".wav", g.out, &err)) {
    g.why = err;
    return g;
  }
  if (g.meta["input"].isString()) {
    const std::string in = base.substr(0, base.size() - name.size()) + g.meta["input"].asString();
    if (!omtest::readWav(in, g.input, &err)) {
      g.why = err;
      return g;
    }
  }
  g.ok = true;
  return g;
}

// Skips when OM_GOLDEN_DIR is unset; FAILS when it is set but the case is
// missing or unreadable.
#define MIXTEST_REQUIRE_GOLDEN(g)                                         \
  do {                                                                     \
    if (!(g).ok) {                                                         \
      if (omtest::envString("OM_GOLDEN_DIR").empty()) OM_SKIP((g).why);    \
      std::printf("    %s\n", (g).why.c_str());                           \
      OM_CHECK(!"golden case unavailable");                                \
    }                                                                      \
  } while (0)

// Channel c of an interleaved WAV as a planar vector.
inline std::vector<float> channel(const omtest::Wav& w, int c) {
  const size_t n = static_cast<size_t>(w.frames());
  std::vector<float> v(n);
  if (w.channels <= 0) return v;
  const int cc = c < w.channels ? c : w.channels - 1;
  for (size_t i = 0; i < n; i++) v[i] = w.samples[i * static_cast<size_t>(w.channels) + static_cast<size_t>(cc)];
  return v;
}

// Golden events {frame, time, call, args}, sorted by frame (stable).
struct Event {
  int64_t frame = 0;
  double time = 0;  // context time of the call (frame / rate, as a JS double)
  std::string call;
  const om::json::Value* args = nullptr;
  double num(size_t i) const { return args->at(i).asNumber(0); }
  std::string str(size_t i) const { return args->at(i).asString(); }
};
inline std::vector<Event> events(const om::json::Value& meta) {
  std::vector<Event> ev;
  for (const auto& e : meta["events"].items()) {
    Event x;
    x.frame = static_cast<int64_t>(e["frame"].asNumber(0));
    x.time = e["time"].asNumber(static_cast<double>(x.frame) / meta["sampleRate"].asNumber(48000));
    x.call = e["call"].asString();
    x.args = &e["args"];
    ev.push_back(x);
  }
  for (size_t i = 1; i < ev.size(); i++)
    for (size_t j = i; j > 0 && ev[j].frame < ev[j - 1].frame; j--) std::swap(ev[j], ev[j - 1]);
  return ev;
}

// Where Chromium applies an `AudioParam.value = x` set at context time t:
// `.value =` schedules setValueAtTime(x, currentTime), and an event's first
// frame is ceil(t x rate) in double arithmetic. currentTime = frame / rate
// is not exact, so for some frames (60160 at 48 kHz: 1.2533333333333334 x
// 48000 = 60160.00000000001) the step lands ONE frame later. engine.js sets
// the DJ filters with `.value` (frequency, Q, gain; the type change itself
// applies at the quantum start). A Chromium artefact, emulated by the null
// tests only: the native engine applies a knob at the block it arrives in.
inline int64_t chromiumStepFrame(const Event& e, double rate) {
  return static_cast<int64_t>(std::ceil(e.time * rate));
}
// The DJ filter kind of a knob value (engine.js _applyBiquad): 0 neutral, 1 HPF, 2 LPF.
inline int djFilterKind(double v) { return std::fabs(v) < 0.04 ? 0 : (v > 0 ? 1 : 2); }
// Moves the DJ filter events (`.value` steps) to the frame where Chromium
// applies them; a step that would change the filter TYPE one frame before
// its frequency cannot be expressed through the engine API: counted in *bad.
inline void applyChromiumStepTiming(std::vector<Event>& ev, double rate, const char* filterCall, int* bad) {
  double v = 0.0;  // filters start neutral
  for (Event& e : ev) {
    if (e.call != filterCall) continue;
    const double nv = e.call == std::string("deck.setFilter") || e.call == std::string("engine.setMasterFilter")
                          ? e.num(0)
                          : e.num(e.args->size() - 1);
    const int64_t f = chromiumStepFrame(e, rate);
    if (f != e.frame) {
      if (djFilterKind(nv) != djFilterKind(v) && bad) ++*bad;
      e.frame = f;
    }
    v = nv;
  }
  for (size_t i = 1; i < ev.size(); i++)
    for (size_t j = i; j > 0 && ev[j].frame < ev[j - 1].frame; j--) std::swap(ev[j], ev[j - 1]);
}

// Worst residual (dBFS) of two planar stereo renders against a golden; when
// it is above -80 dBFS (or with OM_MIXER_VERBOSE=1), prints where it happens.
inline double residualStereo(const std::vector<float>& l, const std::vector<float>& r, const omtest::Wav& want) {
  const std::vector<float> wl = channel(want, 0), wr = channel(want, 1);
  const size_t n = wl.size() < l.size() ? wl.size() : l.size();
  if (n == 0 || l.size() != wl.size()) return 0.0;  // a length mismatch is a failure
  const double res = std::fmax(omtest::residualDb(l.data(), wl.data(), n), omtest::residualDb(r.data(), wr.data(), n));
  if (res >= -80.0 || omtest::envFlag("OM_MIXER_VERBOSE")) {
    size_t worst = 0, first = n;
    double m = 0;
    for (size_t i = 0; i < n; i++) {
      const double e = std::fmax(std::fabs(static_cast<double>(l[i]) - wl[i]), std::fabs(static_cast<double>(r[i]) - wr[i]));
      if (e > 1e-4 && first == n) first = i;
      if (e > m) {
        m = e;
        worst = i;
      }
    }
    std::printf("    worst at frame %zu (got %.7g, want %.7g), first error > 1e-4 at frame %zu\n", worst, l[worst],
                wl[worst], first);
  }
  return res;
}

}  // namespace mixtest
