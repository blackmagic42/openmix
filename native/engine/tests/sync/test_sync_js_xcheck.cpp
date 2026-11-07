// Cross-check of the sync module against the REAL engine.js (owner: sync):
// js_xcheck/xcheck.mjs runs the Web engine's own sync code on fake decks
// through a scenario at 60 calls per second and writes a trace; this test
// runs the C++ port (engine.js parity mode, 800-frame blocks at 48 kHz = one
// call per 1/60 s, so the converted low-pass is exactly 0.85) on identical
// fake decks and compares the two traces tick by tick: master, auto master,
// calibrated, passes, tries, synced must be equal at every tick, tempo /
// syncBase / positions equal within 1e-12 (relative), errFilt / pllCorr /
// phase offset within 1e-15 (absolute). The bass rule's inputs (fader
// volume, crossfader, sides) reach the C++ port as the mixer's MixView builds
// them (float, engine.js "mix" curve).
//   node native/engine/tests/sync/js_xcheck/xcheck.mjs <trace.txt> [scenario.txt]
//   OM_SYNC_JS_TRACE=<trace.txt> [OM_SYNC_JS_SCENARIO=<scenario.txt>] om_test_sync sync_js_cross_check
// Every scenario at once (js_xcheck/scenario*.txt, one trace each):
//   node native/engine/tests/sync/js_xcheck/xcheck.mjs --all <dir>
//   OM_SYNC_JS_TRACE=<dir> om_test_sync sync_js_cross_check
// Skipped when OM_SYNC_JS_TRACE is unset. SPEC.md §12.
#include <algorithm>
#include <cmath>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>

#include "../om_test.h"
#include "om/rt.h"
#include "om/sync.h"

using namespace om;

namespace {

// engine.js Deck as xcheck.mjs fakes it: positions advance exactly with the tempo.
struct XDeck final : IDeckControl {
  bool isLoaded = false, isPlaying = false, hasGrid = false;
  double dur = 0, pos = 0, tmp = 1;
  SampleTime ended = kNaN;
  BeatGrid g;
  bool loaded() const noexcept override { return isLoaded; }
  bool playing() const noexcept override { return isPlaying; }
  double duration() const noexcept override { return isLoaded ? dur : 0; }
  double heardPosition() const noexcept override { return isLoaded ? pos : 0; }
  bool transportSettled() const noexcept override { return true; }
  double tempo() const noexcept override { return tmp; }
  void setTempo(double r) noexcept override { tmp = std::min(1.6, std::max(0.5, r)); }
  void seekHeard(double t) noexcept override {
    if (isLoaded) pos = std::min(dur, std::max(-3600.0, t));
  }
  bool routedThroughWsola() const noexcept override { return false; }
  const BeatGrid* grid() const noexcept override { return hasGrid ? &g : nullptr; }
  SampleTime endedAtSample() const noexcept override { return ended; }
  bool startRoll(double, double) noexcept override { return false; }
  void setRollMix(double) noexcept override {}
  void stopRoll(bool) noexcept override {}
  bool rolling(double* b) const noexcept override {
    if (b) *b = 0;
    return false;
  }
};

struct XTrack {
  double bpm = 0, t0 = 0, dur = 0;
  int barAnchor = 0;
  std::vector<double> beats;
};
struct XEvent {
  int tick;
  std::string kind;
  double deck, a, b;
};

std::string xcheckDir() {
  std::string f = __FILE__;
  const size_t cut = f.find_last_of("/\\");
  return (cut == std::string::npos ? std::string(".") : f.substr(0, cut)) + "/js_xcheck";
}

bool loadScenario(const std::string& path, std::vector<XTrack>& tracks, std::vector<XEvent>& evs, std::string& err) {
  std::ifstream in(path);
  if (!in) {
    err = "cannot open " + path;
    return false;
  }
  tracks.assign(16, XTrack());
  std::string line;
  auto num = [](const std::string& s) { return s.empty() ? kNaN : std::stod(s); };
  while (std::getline(in, line)) {
    std::istringstream ss(line);
    std::string w;
    ss >> w;
    if (w == "track") {
      int idx = 0, barAnchor = 0, fixed = 0;
      double trueBpm = 0, t0 = 0, dur = 0, bpmField = 0, noise = 0, seed = 0;
      ss >> idx >> trueBpm >> t0 >> dur >> bpmField >> noise >> seed >> barAnchor >> fixed;
      XTrack t;
      t.bpm = bpmField;
      t.t0 = t0;
      t.dur = dur;
      t.barAnchor = barAnchor;
      const double P = 60 / trueBpm;
      double x = seed != 0 ? seed : 1;
      if (fixed != 1) {
        for (int k = 0; t0 + k * P <= dur; k++) {
          x = std::fmod(x * 48271, 2147483647.0);  // MINSTD, as xcheck.mjs
          const double n = noise > 0 ? (x / 2147483647 * 2 - 1) * noise : 0;
          t.beats.push_back(t0 + k * P + n);
        }
      }
      if (t.beats.size() <= 2) t.beats.clear();  // engine.js loadTrack: > 2 entries to be used
      if (idx >= 0 && idx < 16) tracks[static_cast<size_t>(idx)] = t;
    } else if (w == "ev") {
      int tick = 0;
      std::string kind, s3, s4, s5;
      ss >> tick >> kind >> s3 >> s4 >> s5;
      if (kind == "ramp") {
        const int n = std::stoi(s5);
        const double f = std::pow(num(s4), 1.0 / n);
        for (int i = 0; i < n; i++) evs.push_back({tick + i, "tempomul", num(s3), f, 0});
      } else {
        evs.push_back({tick, kind, num(s3), num(s4), num(s5)});
      }
    }
  }
  std::stable_sort(evs.begin(), evs.end(), [](const XEvent& p, const XEvent& q) { return p.tick < q.tick; });
  return true;
}

// One deck's fields in a trace line.
struct XFields {
  double v[10];  // tempo, syncBase, pllCorr, calibrated, errFilt, passes, tries, phaseOffset, synced, pos
};
bool parseLine(const std::string& line, int& tick, int& mi, int& ami, XFields (&f)[kNumDecks]) {
  std::string s = line;
  std::replace(s.begin(), s.end(), '|', ' ');
  std::istringstream ss(s);
  if (!(ss >> tick >> mi >> ami)) return false;
  for (int d = 0; d < kNumDecks; d++) {
    for (double& x : f[d].v) {
      std::string w;
      if (!(ss >> w)) return false;
      x = w == "nan" ? kNaN : std::stod(w);
    }
  }
  return true;
}

// The crossfader gains as Mixer::mixView builds them (float, engine.js "mix" curve).
void applyCrossfader(MixView& mv, float x, const bool (&sideB)[kNumDecks]) {
  const float gA = x <= 0.5f ? 1.0f : (1.0f - x) * 2.0f;
  const float gB = x >= 0.5f ? 1.0f : x * 2.0f;
  for (int d = 0; d < kNumDecks; d++) mv.xfGain[d] = sideB[d] ? gB : gA;
}

struct XResult {
  size_t ticks = 0, jsTicks = 0;
  int discreteMismatch = 0;
  int masterChanges = 0, autoMasterChanges = 0;
  double maxRelTempo = 0, maxRelBase = 0, maxRelPos = 0, maxAbsErr = 0, maxAbsPll = 0, maxAbsOff = 0;
  std::string firstMismatch, error;
  bool ok() const {
    return error.empty() && ticks == jsTicks && discreteMismatch == 0 && maxRelTempo < 1e-12 && maxRelBase < 1e-12 &&
           maxRelPos < 1e-12 && maxAbsErr < 1e-15 && maxAbsPll < 1e-15 && maxAbsOff < 1e-15;
  }
};

XResult runOne(const std::string& scenarioPath, const std::string& tracePath) {
  XResult res;
  std::vector<XTrack> tracks;
  std::vector<XEvent> evs;
  if (!loadScenario(scenarioPath, tracks, evs, res.error)) return res;
  std::ifstream jsIn(tracePath);
  if (!jsIn) {
    res.error = "cannot open " + tracePath;
    return res;
  }
  std::vector<std::string> jsLines;
  for (std::string l; std::getline(jsIn, l);) {
    if (!l.empty()) jsLines.push_back(l);
  }
  res.jsTicks = jsLines.size();

  XDeck dk[kNumDecks];
  IDeckControl* ptrs[kNumDecks] = {&dk[0], &dk[1], &dk[2], &dk[3]};
  SyncEngine s;
  s.attachDecks(ptrs);
  MixView mv;
  FxRackView fv;
  float crossfader = 0.5f;
  bool sideB[kNumDecks] = {false, true, false, true};  // engine.js xfSides A B A B
  applyCrossfader(mv, crossfader, sideB);
  BlockClock clk;
  clk.sampleRate = 48000;
  clk.frames = 800;  // 1/60 s per call: keep = 0.85 exactly
  const double dt = 1.0 / 60;
  size_t ev = 0;
  int lastMi = -2, lastAmi = -2;
  for (int k = 0;; k++) {
    const double T = k / 60.0;
    clk.sampleTime = T;
    clk.presentTime = T;
    bool end = false;
    while (ev < evs.size() && evs[ev].tick == k) {
      const XEvent& e = evs[ev++];
      const int d = static_cast<int>(e.deck);
      XDeck* x = (d >= 0 && d < kNumDecks) ? &dk[d] : nullptr;
      rt::Scope rts;
      if (e.kind == "load" && x) {
        const XTrack& t = tracks[static_cast<size_t>(e.a)];
        x->isLoaded = true;
        x->isPlaying = false;
        x->hasGrid = true;
        x->g.bpm = t.bpm;
        x->g.beatOffset = t.t0;
        {
          rt::Unscoped allowed;  // the grid copy is test set-up, not audio-thread work
          x->g.beats = t.beats;
        }
        x->g.gridShift = 0;
        x->g.barAnchor = t.barAnchor;
        x->dur = t.dur;
        x->pos = e.b;
        x->tmp = 1;
        s.onTrackLoaded(d);
      } else if (e.kind == "play" && x) {
        if (x->isLoaded && !x->isPlaying) {
          x->ended = kNaN;
          x->isPlaying = true;
        }
      } else if (e.kind == "pause" && x) {
        x->isPlaying = false;
      } else if (e.kind == "sync") {
        s.sync(d, clk);
      } else if (e.kind == "tempomul" && x) {
        x->setTempo(x->tmp * e.a);
        s.onTempoCommand(d);
      } else if (e.kind == "master") {
        s.setManualMaster(d);
      } else if (e.kind == "eqlow" && x) {
        mv.eqLow[d] = static_cast<float>(e.a);
      } else if (e.kind == "volume" && x) {
        mv.volume[d] = static_cast<float>(e.a);
      } else if (e.kind == "xf") {
        crossfader = static_cast<float>(e.a);
        applyCrossfader(mv, crossfader, sideB);
      } else if (e.kind == "side" && x) {
        sideB[d] = e.a != 0;
        applyCrossfader(mv, crossfader, sideB);
      } else if (e.kind == "arm" && x) {
        s.setSynced(d, e.a != 0);
      } else if (e.kind == "jog") {
        s.setJogHold(d == 1);
      } else if (e.kind == "nudge" && x) {
        if (x->isLoaded) x->pos += e.a;
      } else if (e.kind == "reanchorall") {
        for (int j = 0; j < kNumDecks; j++) s.reanchor(j);
      } else if (e.kind == "snap") {
        s.snapToRef(d, e.a);
      } else if (e.kind == "offset") {
        s.setGlobalGridOffset(e.deck);
      } else if (e.kind == "end") {
        end = true;
      }
    }
    if (end) break;
    {
      rt::Scope rts;
      s.tick(clk, mv, fv);
    }
    if (res.ticks >= jsLines.size()) {
      res.error = "the C++ run is longer than the engine.js trace";
      return res;
    }
    int jt = 0, jmi = 0, jami = 0;
    XFields jf[kNumDecks];
    if (!parseLine(jsLines[res.ticks], jt, jmi, jami, jf)) {
      res.error = "unreadable trace line " + std::to_string(res.ticks);
      return res;
    }
    om_sync_state st;
    s.snapshot(st);
    auto mismatch = [&](const char* what, int d, double a, double b) {
      res.discreteMismatch++;
      if (res.firstMismatch.empty()) {
        char buf[200];
        std::snprintf(buf, sizeof buf, "tick %d deck %d %s: engine.js %.17g, C++ %.17g", k, d, what, a, b);
        res.firstMismatch = buf;
      }
    };
    if (jt != k) mismatch("tick", -1, jt, k);
    if (jmi != st.master_idx) mismatch("masterIdx", -1, jmi, st.master_idx);
    if (jami != st.auto_master_idx) mismatch("autoMasterIdx", -1, jami, st.auto_master_idx);
    if (st.master_idx != lastMi) res.masterChanges++;
    if (st.auto_master_idx != lastAmi) res.autoMasterChanges++;
    lastMi = st.master_idx;
    lastAmi = st.auto_master_idx;
    for (int d = 0; d < kNumDecks; d++) {
      const SyncDeckDiag g = s.diag(d);
      const double c[10] = {dk[d].tmp, st.sync_base[d], st.pll_corr[d], double(st.calibrated[d]), g.errFilt,
                            double(g.ratioPasses), double(g.ratioTries), g.phaseOffset, double(st.synced[d]),
                            dk[d].heardPosition()};
      const double* j = jf[d].v;
      for (int i : {3, 5, 6, 8}) {
        if (j[i] != c[i]) mismatch("discrete field", d, j[i], c[i]);
      }
      for (int i : {1, 7}) {
        if (std::isnan(j[i]) != std::isnan(c[i])) mismatch("null-ness", d, j[i], c[i]);
      }
      auto rel = [](double a, double b) { return std::fabs(a - b) / std::max(1e-12, std::fabs(a)); };
      res.maxRelTempo = std::max(res.maxRelTempo, rel(j[0], c[0]));
      if (!std::isnan(j[1]) && !std::isnan(c[1])) res.maxRelBase = std::max(res.maxRelBase, rel(j[1], c[1]));
      res.maxRelPos = std::max(res.maxRelPos, rel(j[9], c[9]));
      res.maxAbsPll = std::max(res.maxAbsPll, std::fabs(j[2] - c[2]));
      res.maxAbsErr = std::max(res.maxAbsErr, std::fabs(j[4] - c[4]));
      if (!std::isnan(j[7]) && !std::isnan(c[7])) res.maxAbsOff = std::max(res.maxAbsOff, std::fabs(j[7] - c[7]));
    }
    res.ticks++;
    for (XDeck& x : dk) {
      if (!x.isPlaying) continue;
      x.pos += x.tmp * dt;
      if (x.pos >= x.dur) {
        x.pos = x.dur;
        x.isPlaying = false;
        x.ended = (k + 1) / 60.0;
      }
    }
  }
  return res;
}

void printResult(const std::string& name, const XResult& r) {
  std::printf("[INFO] engine.js cross-check %s: %zu ticks, %d decision mismatches, %d master / %d auto-master changes; max "
              "difference: tempo %.3g, syncBase %.3g, position %.3g (relative), errFilt %.3g, pllCorr %.3g, phase offset %.3g "
              "(absolute)%s%s%s%s\n",
              name.c_str(), r.ticks, r.discreteMismatch, r.masterChanges, r.autoMasterChanges, r.maxRelTempo, r.maxRelBase,
              r.maxRelPos, r.maxAbsErr, r.maxAbsPll, r.maxAbsOff, r.firstMismatch.empty() ? "" : " | first: ",
              r.firstMismatch.c_str(), r.error.empty() ? "" : " | error: ", r.error.c_str());
}

}  // namespace

OM_TEST(sync_js_cross_check) {
  const std::string tracePath = omtest::envString("OM_SYNC_JS_TRACE");
  if (tracePath.empty()) OM_SKIP("set OM_SYNC_JS_TRACE=<trace of js_xcheck/xcheck.mjs, or a folder of xcheck.mjs --all> to run");
  std::vector<std::pair<std::string, std::string>> runs;  // scenario, trace
  std::error_code ec;
  if (std::filesystem::is_directory(std::filesystem::path(tracePath), ec)) {
    std::vector<std::string> names;
    {
      rt::Unscoped allowed;
      for (const auto& e : std::filesystem::directory_iterator(std::filesystem::path(xcheckDir()), ec)) {
        const std::string n = e.path().filename().string();
        if (n.rfind("scenario", 0) == 0 && n.size() > 4 && n.substr(n.size() - 4) == ".txt") names.push_back(n);
      }
    }
    std::sort(names.begin(), names.end());
    for (const std::string& n : names)
      runs.push_back({xcheckDir() + "/" + n, tracePath + "/" + n.substr(0, n.size() - 4) + ".trace"});
    OM_CHECK(!runs.empty());
  } else {
    const std::string sc = omtest::envString("OM_SYNC_JS_SCENARIO");
    runs.push_back({sc.empty() ? xcheckDir() + "/scenario.txt" : sc, tracePath});
  }
  int failed = 0;
  for (const auto& [sc, tr] : runs) {
    const XResult r = runOne(sc, tr);
    printResult(std::filesystem::path(sc).filename().string(), r);
    if (!r.ok()) failed++;
  }
  OM_CHECK(failed == 0);
}
