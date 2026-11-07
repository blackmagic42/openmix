// Long replays of the sync module (owner: sync): a simulated 10-minute DJ
// session (dynamic grids with +-0.3 ms analysis noise and rounded BPM
// fields, a fixed grid, tempo ramps and a BPM nudge on the master, a keylock
// deck, a cut handover, a manual master change, a natural end, a re-sync)
// run (1) through the native lock, every 128-frame block on exact heard
// positions, in its engine.js-parity mode and with the native precision
// refinements, and (2) through the SAME verbatim logic driven the way the
// Web engine runs it: engine.js syncLock from requestAnimationFrame at 60
// fps (jitter, the odd late frame), on positions extrapolated from
// ctx.currentTime, which moves in 128-frame steps (sync_sim.h JsDeck). The
// phase error between every synced deck and its master is measured on the
// AUDIBLE positions every 128-frame quantum, against the detected grids (what
// a lock can see) and against the true beats. Also: the lock without any UI
// (no state read, no command for 10 minutes) and the CPU cost of tick().
// Results are printed as [INFO] lines. OM_SYNC_SWEEP=<n> runs the acceptance
// on n noise seeds. SPEC.md §12 (acceptance), §18.
#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <string>
#include <vector>

#include "../om_test.h"
#include "om/rt.h"
#include "om/sync.h"
#include "sync_sim.h"

using namespace om;
using namespace synctest;

namespace {

struct Event {
  enum Kind { Load, Play, Pause, Sync, TempoMul, Master, EqLow, Keylock };
  double t;
  Kind kind;
  int deck;
  int track;
  double a;
};

struct Session {
  std::vector<Track> tracks;
  std::vector<Event> events;
  double seconds = 600.0;
  void add(double t, Event::Kind k, int deck, double a = 0.0, int track = -1) { events.push_back({t, k, deck, track, a}); }
  // a fader move at the UI rate (60 Hz): `factor` spread over [t0, t1)
  void ramp(double t0, double t1, int deck, double factor) {
    const int n = static_cast<int>(std::lround((t1 - t0) * 60));
    const double step = std::pow(factor, 1.0 / n);
    for (int i = 0; i < n; i++) add(t0 + i / 60.0, Event::TempoMul, deck, step);
  }
  void sort() {
    std::stable_sort(events.begin(), events.end(), [](const Event& x, const Event& y) { return x.t < y.t; });
  }
};

// The 10-minute session. True tempi are not round; the analysis BPM fields
// are; `seed` draws another analysis noise for every dynamic grid.
Session makeSession(double noise, uint64_t seed) {
  Session s;
  const uint64_t k = seed * 1000;
  s.tracks.push_back(makeDynamicTrack(127.93, 0.081, 480, 128.0, noise, 101 + k));  // T0
  s.tracks.push_back(makeDynamicTrack(126.21, 0.043, 420, 126.2, noise, 102 + k));  // T1 (ends during the mix)
  s.tracks.push_back(makeDynamicTrack(128.42, 0.118, 640, 128.4, noise, 103 + k));  // T2
  s.tracks.push_back(makeDynamicTrack(125.07, 0.025, 640, 125.1, noise, 104 + k));  // T3
  s.tracks.push_back(makeFixedTrack(124.0, 0.2, 640));                              // T4 (fixed grid)
  using E = Event;
  s.add(0.0, E::Load, 0, 0.0, 0);
  s.add(0.0, E::Play, 0);
  s.add(10.0, E::Load, 1, 31.0, 1);
  s.add(10.0, E::Play, 1);
  s.add(10.5, E::Sync, 1);
  s.ramp(40.0, 44.0, 0, 1.02);                                         // master fader +2 %
  s.add(70.0, E::TempoMul, 0, (128.0 * 1.02 + 0.5) / (128.0 * 1.02));  // master BPM nudge +0.5
  s.add(90.0, E::Load, 2, 20.0, 2);
  s.add(90.0, E::Keylock, 2, 1.0);
  s.add(90.0, E::Play, 2);
  s.add(90.5, E::Sync, 2);
  s.add(120.0, E::EqLow, 1, -1.0);   // bass kill on deck 1
  s.add(150.0, E::Pause, 0);         // the master is cut: deck 2 (open bass, keylock) takes over after 1.2 s
  s.add(170.0, E::Load, 0, 10.0, 3);
  s.add(170.0, E::Play, 0);
  s.add(170.6, E::Sync, 0);
  s.ramp(200.0, 206.0, 2, 0.97);     // the keylock master slows down 3 %
  s.add(240.0, E::Master, 1, 1.0);   // manual master: deck 1
  s.add(250.0, E::EqLow, 1, 0.0);
  s.add(280.0, E::Load, 3, 5.0, 4);
  s.add(280.0, E::Play, 3);
  s.add(280.4, E::Sync, 3);
  // ~391 s: deck 1 (manual master) reaches its natural end: immediate handover to deck 0
  s.ramp(420.0, 424.0, 0, 1.015);
  s.add(450.0, E::Pause, 3);
  s.add(460.0, E::Play, 3);  // app.js playDeck: a SYNCED deck that starts is synced at once
  s.add(460.0, E::Sync, 3);
  s.add(500.0, E::Master, -1, -1.0);  // back to automatic (same master)
  s.ramp(530.0, 532.0, 0, 0.99);
  s.sort();
  return s;
}

struct Stats {
  std::vector<double> gridMs;  // phase error on the detected grids (what a lock can see), ms
  std::vector<double> trueMs;  // phase error on the true beats (what the listener hears), ms
  double p50g = 0, p99g = 0, p999g = 0, maxg = 0, over1g = 0;
  double p50t = 0, p99t = 0, maxt = 0;
  size_t n = 0;
  void reserve(size_t k) {
    gridMs.reserve(k);
    trueMs.reserve(k);
  }
  void finish() {
    n = gridMs.size();
    p50g = percentileAbs(gridMs, 0.50);
    p99g = percentileAbs(gridMs, 0.99);
    p999g = percentileAbs(gridMs, 0.999);
    maxg = percentileAbs(gridMs, 1.0);
    p50t = percentileAbs(trueMs, 0.50);
    p99t = percentileAbs(trueMs, 0.99);
    maxt = percentileAbs(trueMs, 1.0);
    size_t k = 0;
    for (double x : gridMs) k += std::fabs(x) > 1.0 ? 1 : 0;
    over1g = n ? 100.0 * static_cast<double>(k) / static_cast<double>(n) : 0.0;
    gridMs = std::vector<double>();  // keep the summary only
    trueMs = std::vector<double>();
  }
  void print(const char* what) const {
    std::printf("[INFO] %s: %zu samples | grid error p50 %.3f ms, p99 %.3f ms, p99.9 %.3f ms, max %.3f ms, >1 ms %.2f %% "
                "| true-beat error p50 %.3f ms, p99 %.3f ms, max %.3f ms\n",
                what, n, p50g, p99g, p999g, maxg, over1g, p50t, p99t, maxt);
  }
};

// Phase error of every synced follower against the master, on audible positions.
void measure(Stats& st, const Session& s, const int (&deckTrack)[kNumDecks], const double (&pos)[kNumDecks],
             const bool (&playing)[kNumDecks], const double (&tempo)[kNumDecks], int m, const bool (&synced)[kNumDecks]) {
  if (m < 0 || !playing[m] || deckTrack[m] < 0) return;
  const Track& tm = s.tracks[static_cast<size_t>(deckTrack[m])];
  const double beatSec = tm.trueP / tempo[m];
  for (int f = 0; f < kNumDecks; f++) {
    if (f == m || !synced[f] || !playing[f] || deckTrack[f] < 0) continue;
    const Track& tf = s.tracks[static_cast<size_t>(deckTrack[f])];
    const double g = grid::beatIndexAt(tm.grid, pos[m], 0.0) - grid::beatIndexAt(tf.grid, pos[f], 0.0);
    const double t = tm.trueBeat(pos[m]) - tf.trueBeat(pos[f]);
    st.gridMs.push_back(wrapHalf(g) * beatSec * 1000.0);
    st.trueMs.push_back(wrapHalf(t) * beatSec * 1000.0);
  }
}

// (1) The native lock: every block, exact heard positions.
Stats runNative(const Session& s, int blockFrames, bool precision) {
  Rig r;
  r.sync.setNativePrecision(precision);
  r.blockFrames = blockFrames;
  r.presentJitter = 0.003;  // device mapping jitter: irrelevant to the lock (sample clock)
  int deckTrack[kNumDecks] = {-1, -1, -1, -1};
  Stats st;
  st.reserve(static_cast<size_t>(s.seconds / r.h()) * 3 + 16);
  size_t ev = 0;
  const long nBlocks = static_cast<long>(s.seconds / r.h());
  for (long b = 0; b < nBlocks; b++) {
    while (ev < s.events.size() && s.events[ev].t <= r.now() + 1e-9) {
      const Event& e = s.events[ev++];
      switch (e.kind) {
        case Event::Load:
          r.load(e.deck, s.tracks[static_cast<size_t>(e.track)], e.a);
          deckTrack[e.deck] = e.track;
          break;
        case Event::Play: r.play(e.deck); break;
        case Event::Pause: r.deck[e.deck].pause(); break;
        case Event::Sync: r.doSync(e.deck); break;
        case Event::TempoMul: r.tempoCommand(e.deck, r.deck[e.deck].tmp * e.a); break;
        case Event::Master: r.sync.setManualMaster(static_cast<int>(e.a)); break;
        case Event::EqLow: r.mix.eqLow[e.deck] = static_cast<float>(e.a); break;
        case Event::Keylock: r.deck[e.deck].wsola = e.a != 0; break;
      }
    }
    r.tickOnly();
    double pos[kNumDecks], tempo[kNumDecks];
    bool playing[kNumDecks], synced[kNumDecks];
    for (int d = 0; d < kNumDecks; d++) {
      pos[d] = r.deck[d].pos;
      tempo[d] = r.deck[d].tmp;
      playing[d] = r.deck[d].isPlaying;
      synced[d] = r.sync.synced(d);
    }
    measure(st, s, deckTrack, pos, playing, tempo, r.sync.effectiveMaster(), synced);
    r.advanceOnly();
  }
  st.finish();
  return st;
}

// How the Web engine's animation frames arrive.
struct JsTiming {
  double jitter = 0.0;      // +- seconds around 1/60 s
  double stallProb = 0.0;   // probability that a frame is late
  double stallMin = 0.04, stallMax = 0.1;
  uint64_t seed = 7;
};

// (2) The same logic driven like engine.js: syncLock at the animation
// frames, positions extrapolated at ctx.currentTime (128-frame steps), the
// error low-pass 0.85 / 0.15 per call (800-frame "blocks" = 1/60 s), the
// audible truth rendered per 128-frame quantum.
struct JsRig {
  double cT = 0.0;
  JsDeck deck[kNumDecks];
  IDeckControl* ptrs[kNumDecks];
  SyncEngine sync;
  MixView mix;
  FxRackView fx;
  BlockClock clk;
  JsRig() {
    for (int d = 0; d < kNumDecks; d++) {
      deck[d].cT = &cT;
      ptrs[d] = &deck[d];
    }
    sync.attachDecks(ptrs);
    clk.sampleRate = kRate;
    clk.frames = 800;  // one call = 1/60 s: keep = 0.85, engine.js's per-frame low-pass
  }
  void frame(double wall) {
    clk.sampleTime = cT;  // engine.js measured its windows on ctx.currentTime
    clk.presentTime = cT;
    clk.callbackTime = wall;
    rt::Scope rts;
    sync.tick(clk, mix, fx);
  }
};

Stats runJs(const Session& s, const JsTiming& tm) {
  JsRig j;
  int deckTrack[kNumDecks] = {-1, -1, -1, -1};
  Rng rng(tm.seed);
  const double q = kRenderQuantum / kRate;
  Stats st;
  st.reserve(static_cast<size_t>(s.seconds / q) * 3 + 16);
  size_t ev = 0;
  double nextFrame = 1.0 / 60;
  const long nQ = static_cast<long>(s.seconds / q);
  for (long k = 0; k < nQ; k++) {
    const double T = k * q;
    j.cT = T;
    while (ev < s.events.size() && s.events[ev].t <= T + 1e-9) {
      const Event& e = s.events[ev++];
      JsDeck& d = j.deck[e.deck >= 0 ? e.deck : 0];
      switch (e.kind) {
        case Event::Load: {
          const Track& tr = s.tracks[static_cast<size_t>(e.track)];
          d.load(&tr.grid, tr.dur, e.a);
          deckTrack[e.deck] = e.track;
          rt::Scope rts;
          j.sync.onTrackLoaded(e.deck);
          break;
        }
        case Event::Play: d.play(); break;
        case Event::Pause: d.pause(); break;
        case Event::Sync: {
          j.clk.sampleTime = T;
          j.clk.presentTime = T;
          rt::Scope rts;
          j.sync.sync(e.deck, j.clk);
          break;
        }
        case Event::TempoMul: {
          rt::Scope rts;
          d.setTempo(d.tempoV * e.a);
          j.sync.onTempoCommand(e.deck);
          break;
        }
        case Event::Master: j.sync.setManualMaster(static_cast<int>(e.a)); break;
        case Event::EqLow: j.mix.eqLow[e.deck] = static_cast<float>(e.a); break;
        case Event::Keylock: d.setKeylock(e.a != 0); break;
      }
    }
    while (nextFrame < T + q) {
      j.frame(nextFrame);
      double dt = 1.0 / 60 + rng.sym(tm.jitter);
      if (tm.stallProb > 0 && rng.uniform() < tm.stallProb) dt += tm.stallMin + rng.uniform() * (tm.stallMax - tm.stallMin);
      nextFrame += dt;
    }
    double pos[kNumDecks], tempo[kNumDecks];
    bool playing[kNumDecks], synced[kNumDecks];
    for (int d = 0; d < kNumDecks; d++) {
      pos[d] = j.deck[d].truePos;
      tempo[d] = j.deck[d].tempoV;
      playing[d] = j.deck[d].isPlaying;
      synced[d] = j.sync.synced(d);
    }
    measure(st, s, deckTrack, pos, playing, tempo, j.sync.effectiveMaster(), synced);
    for (JsDeck& d : j.deck) d.quantum(T, q);
  }
  st.finish();
  return st;
}

struct SeedResult {
  Stats verbatim, precise, jsIdeal, jsReal;
};

SeedResult runSeed(uint64_t seed) {
  const Session s = makeSession(0.0003, seed);
  SeedResult r;
  r.verbatim = runNative(s, 128, false);
  r.precise = runNative(s, 128, true);
  r.jsIdeal = runJs(s, JsTiming());
  JsTiming real;
  real.jitter = 0.0015;
  real.stallProb = 0.003;
  real.seed = 7 + seed;
  r.jsReal = runJs(s, real);
  std::printf("[INFO] seed %llu: native verbatim p99 %.3f ms (true %.3f) | native precision p99 %.3f ms (true %.3f, max %.3f) "
              "| engine.js replay ideal 60 fps p99 %.3f ms (true %.3f) | engine.js replay real frames p99 %.3f ms (true %.3f)\n",
              static_cast<unsigned long long>(seed), r.verbatim.p99g, r.verbatim.p99t, r.precise.p99g, r.precise.p99t,
              r.precise.maxg, r.jsIdeal.p99g, r.jsIdeal.p99t, r.jsReal.p99g, r.jsReal.p99t);
  return r;
}

// The SPEC's criteria for one seed: precision < 1 ms p99 (grid and true
// beats), never worse than either engine.js replay.
void checkSeed(const SeedResult& r) {
  OM_CHECK(r.precise.n > 300000 && r.jsIdeal.n > 300000);
  OM_CHECK(r.precise.p99g < 1.0 && r.precise.p99t < 1.0);
  OM_CHECK(r.precise.p99g <= r.jsIdeal.p99g && r.precise.p99g <= r.jsReal.p99g);
  OM_CHECK(r.precise.p99t <= r.jsIdeal.p99t && r.precise.p99t <= r.jsReal.p99t);
}

}  // namespace

// Acceptance (SPEC.md §12): phase error < 1 ms p99 over a 10-minute synced
// mix with +-0.3 ms grid noise, tempo moves and handovers, never worse than
// the JS servo replayed on the same inputs. Met by the native precision
// refinements (A/B switch); the engine.js-parity mode reproduces the
// engine.js replay (its dead zone parks the error at ~0.7 ms and its 1 s
// calibration pass can leave a 0.02 % residue: p99 ~1-1.6 ms, like engine.js).
OM_TEST(sync_replay_10_minute_mix_acceptance) {
  double parity = 0;
  for (uint64_t seed = 0; seed < 4; seed++) {
    const SeedResult r = runSeed(seed);
    checkSeed(r);
    parity = std::max(parity, std::fabs(r.verbatim.p99g - r.jsIdeal.p99g));
  }
  OM_CHECK(parity < 0.1);  // parity mode = the engine.js algorithm on exact positions
  // a 10 ms shared-mode device period (480-frame blocks)
  const Stats p480 = runNative(makeSession(0.0003, 0), 480, true);
  p480.print("native precision, 480-frame blocks (10 ms period), seed 0");
  OM_CHECK(p480.p99g < 1.0 && p480.p99t < 1.0);
}

// OM_SYNC_SWEEP=<n>: the acceptance criteria on n noise seeds (opt-in, ~2 s per seed).
OM_TEST(sync_replay_seed_sweep) {
  const std::string n = omtest::envString("OM_SYNC_SWEEP");
  if (n.empty()) OM_SKIP("set OM_SYNC_SWEEP=<seeds> to run");
  const uint64_t seeds = static_cast<uint64_t>(std::stoul(n));
  double worstPrecise = 0, worstPreciseTrue = 0, sumVerbatim = 0, sumJs = 0;
  for (uint64_t seed = 0; seed < seeds; seed++) {
    const SeedResult r = runSeed(seed);
    checkSeed(r);
    worstPrecise = std::max(worstPrecise, r.precise.p99g);
    worstPreciseTrue = std::max(worstPreciseTrue, r.precise.p99t);
    sumVerbatim += r.verbatim.p99g;
    sumJs += r.jsIdeal.p99g;
  }
  std::printf("[INFO] %llu seeds: precision worst p99 %.3f ms (true %.3f) | mean p99 verbatim %.3f ms, engine.js replay %.3f ms\n",
              static_cast<unsigned long long>(seeds), worstPrecise, worstPreciseTrue, sumVerbatim / seeds, sumJs / seeds);
}

// No UI dependency: the Web engine's lock runs on animation frames and stops
// when the window is minimized; the native lock runs in every audio block.
// Two synced decks, then 10 minutes of blocks with NO state read and NO
// command (the error is computed from the fake decks, i.e. the audio).
OM_TEST(sync_lock_without_ui_10_minutes) {
  const Track a = makeDynamicTrack(127.93, 0.081, 700, 128.0, 0.0003, 201);
  const Track b = makeDynamicTrack(126.21, 0.043, 700, 126.2, 0.0003, 202);
  auto err = [&](double pm, double pf, double tempoM, std::vector<double>& g, std::vector<double>& t) {
    const double beatSec = a.trueP / tempoM;
    g.push_back(wrapHalf(grid::beatIndexAt(a.grid, pm, 0.0) - grid::beatIndexAt(b.grid, pf, 0.0)) * beatSec * 1000.0);
    t.push_back(wrapHalf(a.trueBeat(pm) - b.trueBeat(pf)) * beatSec * 1000.0);
  };
  double nativeMax[2] = {0, 0};
  for (const bool precision : {false, true}) {
    Rig r;
    r.sync.setNativePrecision(precision);
    r.load(0, a, 0.0);
    r.load(1, b, 31.0);
    r.play(0);
    r.run(5.0);
    r.play(1);
    r.run(0.5);
    OM_CHECK(r.doSync(1));
    const long n = static_cast<long>(600.0 / r.h());
    std::vector<double> g, t;
    g.reserve(static_cast<size_t>(n));
    t.reserve(static_cast<size_t>(n));
    for (long i = 0; i < n; i++) {
      r.tickOnly();  // nothing else reaches the engine
      err(r.deck[0].pos, r.deck[1].pos, r.deck[0].tmp, g, t);
      r.advanceOnly();
    }
    const double p99g = percentileAbs(g, 0.99), maxg = percentileAbs(g, 1.0), p99t = percentileAbs(t, 0.99);
    nativeMax[precision ? 1 : 0] = maxg;
    std::printf("[INFO] native lock (%s), no UI for 10 min: grid error p99 %.3f ms, max %.3f ms | true-beat error p99 %.3f ms\n",
                precision ? "precision" : "engine.js parity", p99g, maxg, p99t);
    OM_CHECK(r.deck[0].isPlaying && r.deck[1].isPlaying);
    // locked: within the dead zone (0.0015 beat = 0.69 ms here) plus the grid noise
    OM_CHECK(p99g < (precision ? 1.0 : 1.3) && maxg < 2.0);
  }
  // the Web engine with its window hidden from 35 s on (no animation frame at all)
  double cT = 0;
  JsDeck jd[kNumDecks];
  IDeckControl* ptrs[kNumDecks];
  for (int d = 0; d < kNumDecks; d++) {
    jd[d].cT = &cT;
    ptrs[d] = &jd[d];
  }
  SyncEngine js;
  js.attachDecks(ptrs);
  MixView mv;
  FxRackView fv;
  BlockClock clk;
  clk.sampleRate = kRate;
  clk.frames = 800;
  jd[0].load(&a.grid, a.dur, 0.0);
  jd[1].load(&b.grid, b.dur, 31.0);
  jd[0].play();
  const double q = kRenderQuantum / kRate;
  double nextFrame = 1.0 / 60;
  bool started = false, synced = false;
  std::vector<double> jg, jt;
  const long nq = static_cast<long>(640.0 / q);
  jg.reserve(static_cast<size_t>(nq));
  jt.reserve(static_cast<size_t>(nq));
  for (long k = 0; k < nq; k++) {
    const double T = k * q;
    cT = T;
    if (!started && T >= 5.0) {
      jd[1].play();
      started = true;
    }
    if (!synced && T >= 5.5) {
      clk.sampleTime = T;
      rt::Scope rts;
      js.sync(1, clk);
      synced = true;
    }
    while (nextFrame < T + q) {
      if (nextFrame < 35.0) {
        clk.sampleTime = cT;
        clk.presentTime = cT;
        rt::Scope rts;
        js.tick(clk, mv, fv);
      }
      nextFrame += 1.0 / 60;
    }
    if (T >= 40.0) err(jd[0].truePos, jd[1].truePos, jd[0].tempoV, jg, jt);
    for (JsDeck& d : jd) d.quantum(T, q);
  }
  const double jsP99 = percentileAbs(jg, 0.99), jsMax = percentileAbs(jg, 1.0);
  std::printf("[INFO] engine.js replay, window hidden after 35 s (next 10 min): grid error p99 %.3f ms, max %.3f ms\n",
              jsP99, jsMax);
  OM_CHECK(jsMax > nativeMax[0] && jsMax > nativeMax[1]);
}

// CPU per block: tick() with 4 decks playing (3 synced, one through the
// transposer, ~1000-beat dynamic grids), FX units and rolls active, plus the
// clock getters the core calls every block, in both modes.
OM_TEST(sync_cpu_per_block) {
  for (const bool precision : {false, true}) {
    Rig r;
    r.sync.setNativePrecision(precision);
    const Track t[4] = {makeDynamicTrack(127.93, 0.08, 520, 128, 0.0003, 301),
                        makeDynamicTrack(126.21, 0.04, 520, 126.2, 0.0003, 302),
                        makeDynamicTrack(128.42, 0.11, 520, 128.4, 0.0003, 303),
                        makeDynamicTrack(125.07, 0.02, 520, 125.1, 0.0003, 304)};
    for (int d = 0; d < kNumDecks; d++) r.load(d, t[d], 20.0 + d);
    r.deck[2].wsola = true;
    r.fx.panel[0].enabled = true;
    r.fx.panel[1].enabled = true;
    r.fx.panel[1].type = FxType::Flanger;
    r.fx.panel[3].enabled = true;
    r.fx.panel[3].type = FxType::Roll;
    r.fx.panel[3].level = 0.5f;
    r.fx.masterExists = true;
    r.fx.master.enabled = true;
    r.play(0);
    r.run(0.2);
    for (int d = 1; d < kNumDecks; d++) r.play(d);
    r.run(0.2);
    for (int d = 1; d < kNumDecks; d++) OM_CHECK(r.doSync(d));
    r.run(20.0);  // calibrated, steady state
    const int N = 100000;  // 267 s of 128-frame blocks
    std::vector<double> us;
    us.reserve(N);
    double sink = 0;
    for (int i = 0; i < N; i++) {
      for (SimDeck& d : r.deck) d.beginBlock(r.clk.sampleTime);
      r.clk.frames = r.blockFrames;
      const auto t0 = std::chrono::steady_clock::now();
      {
        rt::Scope rts;
        r.sync.tick(r.clk, r.mix, r.fx);
        for (int u = 0; u < kNumFxUnits; u++) sink += r.sync.panelBeatClock(u).beatPos;
        for (int k = 0; k < kNumDecks; k++) sink += r.sync.padBeatClock(k).beatPos + r.sync.deckBeatClock(k).beatPos;
        sink += r.sync.masterBeatClock().beatPos;
      }
      const auto t1 = std::chrono::steady_clock::now();
      us.push_back(std::chrono::duration<double, std::micro>(t1 - t0).count());
      r.advanceOnly();
    }
    double sum = 0;
    for (double x : us) sum += x;
    const double mean = sum / N;
    const double p99 = percentileAbs(us, 0.99), mx = percentileAbs(us, 1.0);
    const double blockUs = 1e6 * 128 / kRate;
#ifdef NDEBUG
    const char* build = "optimized build";
#else
    const char* build = "DEBUG build: unoptimized, checked iterators";
#endif
    std::printf("[INFO] sync tick + 13 clock reads (%s, %s), 4 decks playing (3 synced, 1 keylock): mean %.2f us "
                "(%.3f %% of a 128-frame block), p99 %.2f us, max %.2f us (checksum %.1f)\n",
                precision ? "precision" : "engine.js parity", build, mean, 100.0 * mean / blockUs, p99, mx, sink);
    OM_CHECK(mean < 0.05 * blockUs);  // < 5 % of a block even unoptimized
    om_sync_state st;
    r.sync.snapshot(st);
    OM_CHECK(st.calibrated[1] && st.calibrated[3]);
  }
}
