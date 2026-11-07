// Simulation helpers of the sync tests (owner: sync): fake decks that play a
// beat grid on the sample clock (heard position advanced block by block,
// WSOLA lag under keylock, natural ends, ROLL bookkeeping), tracks with a
// noisy detected grid and their true beats, a block driver with a jittered
// presentTime, the engine.js replay model (servo at 60 fps on extrapolated
// positions and a ctx.currentTime moving in 128-frame steps), and phase-error
// statistics. Test code only (allocates outside rt::Scope). SPEC.md §12, §18.
#pragma once

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <vector>

#include "om/common.h"
#include "om/deck_control.h"
#include "om/grid.h"
#include "om/media.h"
#include "om/rt.h"
#include "om/sync.h"

namespace synctest {

using namespace om;

constexpr double kRate = 48000.0;
constexpr double kWsolaLag = kWsolaLatencySamples / kRate;  // 2647 frames: the WSOLA heard lag
constexpr double kGraceForTests = 1.2;                       // engine.js auto-master cut tolerance

// engine.js octave folding, for expected values
inline double foldForTests(double r) {
  while (r > 1.6) r /= 2;
  while (r < 0.5) r *= 2;
  return r;
}

// Deterministic generator (the same numbers on every platform).
struct Rng {
  uint64_t s;
  explicit Rng(uint64_t seed) : s(seed ? seed : 0x9E3779B97F4A7C15ull) {}
  uint64_t next() {
    s ^= s >> 12;
    s ^= s << 25;
    s ^= s >> 27;
    return s * 0x2545F4914F6CDD1Dull;
  }
  double uniform() { return (next() >> 11) * (1.0 / 9007199254740992.0); }  // [0, 1)
  double sym(double a) { return (uniform() * 2 - 1) * a; }                // [-a, a)
};

// Tempo history of a deck's READ pointer, to compute the HEARD advance of a
// deck routed through the WSOLA transposer (heard rate = read rate 2647
// frames earlier). Fixed size: allocation-free.
struct TempoHistory {
  struct Seg {
    double t0, t1, tempo;
  };
  static constexpr int kN = 512;
  Seg seg[kN];
  int head = 0;
  int count = 0;
  void reset() { count = 0; }
  void push(double t0, double t1, double tempo) {
    seg[head] = {t0, t1, tempo};
    head = (head + 1) % kN;
    if (count < kN) count++;
  }
  // integral of the read tempo over [a, b); before the history: `before`
  double integral(double a, double b, double before) const {
    double sum = 0;
    double covered = b;  // [a, covered) still to integrate, walking back in time
    for (int k = 0; k < count && covered > a; k++) {
      const Seg& s = seg[(head - 1 - k + kN) % kN];
      if (s.t0 >= covered) continue;
      const double lo = std::max(a, s.t0);
      const double hi = std::min(covered, s.t1);
      if (hi > lo) sum += (hi - lo) * s.tempo;
      covered = std::min(covered, std::max(a, s.t0));
    }
    if (covered > a) sum += (covered - a) * before;
    return sum;
  }
};

// The native deck as the sync engine sees it: the heard position at the
// block's presentTime, advanced by exactly frames / rate x tempo per block
// (the tempo set during the tick applies to that block), with the WSOLA lag
// when routed through the transposer.
struct SimDeck final : IDeckControl {
  // configuration
  bool isLoaded = true;
  bool wsola = false;          // routed through the transposer (keylock / key)
  double dur = 600.0;
  const BeatGrid* g = nullptr;
  bool forceUnsettled = false; // test hook: transport not settled
  double settleSec = 0.0;      // unsettled during this long after play / seek (prime / crossfade)
  bool frozen = false;         // test hook: the position does not advance
  // transport
  bool isPlaying = false;
  double pos = 0.0;
  double tmp = 1.0;
  SampleTime ended = kNaN;
  SampleTime now = 0.0;
  SampleTime unsettledUntil = -1.0;
  double tempoAtPrime = 1.0;
  TempoHistory hist;
  // ROLL
  bool rollOn = false;
  bool refuseRoll = false;
  double rollB = 0.0;
  double rollMixV = 0.0;
  int rollStarts = 0, rollStops = 0, rollMixSets = 0;
  bool lastStopImmediate = true;
  // counters
  int tempoSets = 0;
  int seeks = 0;

  bool loaded() const noexcept override { return isLoaded; }
  bool playing() const noexcept override { return isPlaying; }
  double duration() const noexcept override { return isLoaded ? dur : 0.0; }
  double heardPosition() const noexcept override { return isLoaded ? pos : 0.0; }
  bool transportSettled() const noexcept override { return !forceUnsettled && now >= unsettledUntil; }
  double tempo() const noexcept override { return tmp; }
  void setTempo(double r) noexcept override {
    tmp = clampv(r, kTempoMin, kTempoMax);
    tempoSets++;
  }
  void seekHeard(double t) noexcept override {
    pos = clampv(t, -kPreRollSec, dur);
    seeks++;
    prime();
  }
  bool routedThroughWsola() const noexcept override { return wsola; }
  const BeatGrid* grid() const noexcept override { return g; }
  SampleTime endedAtSample() const noexcept override { return ended; }
  bool startRoll(double beats, double mix) noexcept override {
    if (refuseRoll || !isPlaying || !(beats > 0)) return false;
    rollOn = true;
    rollB = beats;
    rollMixV = mix;
    rollStarts++;
    return true;
  }
  void setRollMix(double mix) noexcept override {
    if (!rollOn) return;
    rollMixV = mix;
    rollMixSets++;
  }
  void stopRoll(bool immediate) noexcept override {
    if (!rollOn) return;
    rollOn = false;
    rollStops++;
    lastStopImmediate = immediate;
  }
  bool rolling(double* beats) const noexcept override {
    if (beats) *beats = rollOn ? rollB : 0.0;
    return rollOn;
  }

  void prime() {
    hist.reset();
    tempoAtPrime = tmp;
    unsettledUntil = now + settleSec;
  }
  void play() {
    if (isPlaying || !isLoaded) return;
    isPlaying = true;
    ended = kNaN;
    prime();
  }
  void pause() {
    isPlaying = false;
    rollOn = false;
  }
  void load(const BeatGrid* grid, double duration, double at = 0.0) {
    isLoaded = true;
    isPlaying = false;
    g = grid;
    dur = duration;
    pos = at;
    tmp = 1.0;
    ended = kNaN;
    rollOn = false;
    hist.reset();
  }
  // Before the tick of the block starting at sample time t.
  void beginBlock(SampleTime t) { now = t; }
  // After the tick: renders [t, t + h) at the tempo the tick left.
  void advance(SampleTime t, double h) {
    hist.push(t, t + h, tmp);
    if (!isPlaying || frozen) return;
    const double adv = wsola ? hist.integral(t - kWsolaLag, t + h - kWsolaLag, tempoAtPrime) : tmp * h;
    pos += adv;
    if (pos >= dur) {  // natural end (engine.js onended)
      pos = dur;
      isPlaying = false;
      rollOn = false;
      ended = t + h;
    }
  }
};

// A track: TRUE beats every trueP seconds from t0, and the detected grid the
// analysis gave (dynamic beats with uniform noise of +-noise s, or a fixed
// grid). bpmField = the rounded BPM of the analysis (engine.js deck.bpm).
struct Track {
  double trueP = 0.5;
  double t0 = 0.0;
  double dur = 300.0;
  BeatGrid grid;
  double trueBeat(double pos) const { return (pos - t0) / trueP; }
};

inline Track makeDynamicTrack(double trueBpm, double t0, double dur, double bpmField, double noise, uint64_t seed,
                              int barAnchor = 0) {
  Track tr;
  tr.trueP = 60.0 / trueBpm;
  tr.t0 = t0;
  tr.dur = dur;
  tr.grid.bpm = bpmField;
  tr.grid.beatOffset = t0;
  tr.grid.barAnchor = barAnchor;
  Rng rng(seed);
  const int n = static_cast<int>((dur - t0) / tr.trueP) + 1;
  tr.grid.beats.reserve(static_cast<size_t>(n));
  for (int k = 0; k < n; k++) tr.grid.beats.push_back(t0 + k * tr.trueP + (noise > 0 ? rng.sym(noise) : 0.0));
  return tr;
}

inline Track makeFixedTrack(double bpm, double beatOffset, double dur) {
  Track tr;
  tr.trueP = 60.0 / bpm;
  tr.t0 = beatOffset;
  tr.dur = dur;
  tr.grid.bpm = bpm;
  tr.grid.beatOffset = beatOffset;
  return tr;
}

// Four SimDecks + a SyncEngine + the views, driven block by block like the
// core's render callback (commands first, then tick, then the decks render).
struct Rig {
  SimDeck deck[kNumDecks];
  IDeckControl* ptrs[kNumDecks];
  SyncEngine sync;
  MixView mix;
  FxRackView fx;
  BlockClock clk;
  int blockFrames = 128;
  double presentJitter = 0.0;  // amplitude (s) of a random presentTime / callbackTime jitter
  Rng rng{12345};
  uint64_t blocks = 0;

  Rig() {
    for (int i = 0; i < kNumDecks; i++) {
      ptrs[i] = &deck[i];
      deck[i].isLoaded = false;
    }
    sync.attachDecks(ptrs);
    clk.sampleRate = kRate;
    clk.frames = blockFrames;
  }
  double h() const { return blockFrames / clk.sampleRate; }
  SampleTime now() const { return clk.sampleTime; }
  // The tick of the block starting at now() (what the core does before the decks render).
  void tickOnly() {
    clk.frames = blockFrames;
    // presentTime / callbackTime: the device mapping, with jitter that the
    // sync engine must ignore (it measures durations on sampleTime)
    clk.callbackTime = clk.sampleTime + 1.0 + rng.sym(presentJitter);
    clk.presentTime = clk.sampleTime + 1.03 + rng.sym(presentJitter);
    for (SimDeck& d : deck) d.beginBlock(clk.sampleTime);
    rt::Scope rts;
    sync.tick(clk, mix, fx);
  }
  // The decks render the block; the sample clock advances.
  void advanceOnly() {
    for (SimDeck& d : deck) d.advance(clk.sampleTime, h());
    clk.sampleTime += h();
    clk.frame += blockFrames;
    blocks++;
  }
  void step(int n = 1) {
    for (int i = 0; i < n; i++) {
      tickOnly();
      advanceOnly();
    }
  }
  void run(double seconds) { step(static_cast<int>(std::ceil(seconds / h() - 1e-9))); }
  // Commands, applied like the core does: on the audio thread before the next tick.
  bool doSync(int d) {
    for (SimDeck& x : deck) x.beginBlock(clk.sampleTime);
    rt::Scope rts;
    return sync.sync(d, clk);
  }
  bool snap(int d, double maxErr = 0.06) {
    rt::Scope rts;
    return sync.snapToRef(d, maxErr);
  }
  void reanchor(int d) {
    rt::Scope rts;
    sync.reanchor(d);
  }
  void tempoCommand(int d, double r) {
    rt::Scope rts;
    deck[d].setTempo(r);
    sync.onTempoCommand(d);
  }
  void play(int d) {
    deck[d].beginBlock(clk.sampleTime);
    deck[d].play();
  }
  void load(int d, const Track& tr, double at = 0.0) {
    deck[d].load(&tr.grid, tr.dur, at);
    rt::Scope rts;
    sync.onTrackLoaded(d);
  }
  double beatPhaseOf(int d) const {
    const SimDeck& x = deck[d];
    return grid::beatPhase(*x.g, x.pos, 0.0);
  }
  double barPhaseOf(int d) const {
    const SimDeck& x = deck[d];
    return grid::barPhase(*x.g, x.pos, 0.0);
  }
};

inline double wrapHalf(double e) { return e - std::floor(e + 0.5); }

// Percentile of |x| (p in [0, 1]); 0 for an empty set.
inline double percentileAbs(std::vector<double> v, double p) {
  if (v.empty()) return 0.0;
  for (double& x : v) x = std::fabs(x);
  std::sort(v.begin(), v.end());
  const size_t k = static_cast<size_t>(std::min<double>(static_cast<double>(v.size() - 1), std::floor(p * v.size())));
  return v[k];
}

// ---------------------------------------------------------------------------
// The engine.js replay model: one deck as the Web engine sees it. app.js runs
// engine.syncLock() from requestAnimationFrame (60 fps with jitter and the odd
// stall), reading positions EXTRAPOLATED from (offset, startCtx, tempo) at
// ctx.currentTime, which moves in 128-frame steps. setTempo re-anchors with
// the procLat compensation (engine.js Deck.setTempo); a seek while playing
// restarts the sources 30 ms ahead (engine.js seek / _startAll). The audible
// truth is integrated per 128-frame quantum: the playbackRate set at
// ctx.currentTime applies from that quantum; under keylock the heard rate is
// the read rate procLat earlier.
// ---------------------------------------------------------------------------
struct JsDeck final : IDeckControl {
  const double* cT = nullptr;  // ctx.currentTime of the model
  bool isLoaded = false;
  bool isPlaying = false;
  bool wsola = false;
  double dur = 600.0;
  double tempoV = 1.0;
  double offset = 0.0;
  double startCtx = 0.0;
  double procLat = 0.0;  // engine.js Deck.procLat (WSOLA latency when routed)
  const BeatGrid* g = nullptr;
  SampleTime ended = kNaN;
  // audible truth
  double truePos = 0.0;
  double trueStart = 0.0;  // the sound starts (silence before: position frozen)
  double tempoAtPrime = 1.0;
  TempoHistory hist;

  double estimate() const {
    if (!isLoaded) return 0.0;
    if (!isPlaying) return offset;
    const double t = offset + (*cT - startCtx) * tempoV;
    return std::min(t, dur);
  }
  bool loaded() const noexcept override { return isLoaded; }
  bool playing() const noexcept override { return isPlaying; }
  double duration() const noexcept override { return isLoaded ? dur : 0.0; }
  double heardPosition() const noexcept override { return estimate(); }
  bool transportSettled() const noexcept override { return *cT >= startCtx; }
  double tempo() const noexcept override { return tempoV; }
  void setTempo(double r) noexcept override {
    r = clampv(r, kTempoMin, kTempoMax);
    if (isPlaying && *cT >= startCtx) {
      offset = estimate() + procLat * (tempoV - r);
      startCtx = *cT;
    }
    tempoV = r;
  }
  void seekHeard(double t) noexcept override {
    if (!isLoaded) return;
    t = clampv(t, -kPreRollSec, dur);
    if (isPlaying) {
      double target = t + 0.03 * tempoV;
      if (target > dur) target = dur;
      offset = target;
      startCtx = *cT + 0.03;
      // the new source starts at startCtx from target: the heard position
      // continues virtually from t (silent 30 ms gap)
      truePos = t;
      trueStart = *cT;
      tempoAtPrime = tempoV;
      hist.reset();
    } else {
      offset = t;
      truePos = t;
    }
  }
  bool routedThroughWsola() const noexcept override { return wsola; }
  const BeatGrid* grid() const noexcept override { return g; }
  SampleTime endedAtSample() const noexcept override { return ended; }
  bool startRoll(double, double) noexcept override { return false; }
  void setRollMix(double) noexcept override {}
  void stopRoll(bool) noexcept override {}
  bool rolling(double* beats) const noexcept override {
    if (beats) *beats = 0.0;
    return false;
  }

  void load(const BeatGrid* grid, double duration, double at) {
    isLoaded = true;
    isPlaying = false;
    g = grid;
    dur = duration;
    offset = at;
    truePos = at;
    tempoV = 1.0;
    ended = kNaN;
    hist.reset();
  }
  void setKeylock(bool on) {
    wsola = on;
    procLat = on ? kWsolaLag : 0.0;
  }
  // engine.js play(): _startAll(0, offset, readAhead=false): the sound is
  // scheduled 30 ms ahead and, through the transposer, heard procLat later
  void play() {
    if (!isLoaded || isPlaying) return;
    ended = kNaN;
    const double at = *cT + 0.03;
    const double lead = procLat * tempoV;
    const double heard = offset;
    offset = heard - lead;
    startCtx = at;
    isPlaying = true;
    truePos = heard - lead - 0.03 * tempoV;  // virtual heard position now (reaches `heard` at at + procLat)
    trueStart = *cT;
    tempoAtPrime = tempoV;
    hist.reset();
  }
  void pause() {
    if (!isPlaying) return;
    if (*cT >= startCtx) offset = estimate();
    isPlaying = false;
  }
  // The audio thread renders the quantum [t, t + q) at the current playbackRate.
  void quantum(double t, double q) {
    hist.push(t, t + q, tempoV);
    if (!isPlaying) return;
    const double adv = wsola ? hist.integral(t - procLat, t + q - procLat, tempoAtPrime) : tempoV * q;
    truePos += adv;
    if (truePos >= dur) {
      truePos = dur;
      isPlaying = false;
      offset = dur;
      ended = t + q;
    }
  }
};

}  // namespace synctest
