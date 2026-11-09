// Sync engine of the native engine (owner: sync): automatic master and bass
// handover, SYNC (tempo ratio + bar alignment), the continuous lock (repair,
// follow-master, flash calibration, holding servo), master handover without
// jumps, ROLL driving, and the beat clocks of the FX units and of every deck
// (VST transport). Verbatim port of src/js/engine.js (sync, syncLock minus
// the dry cut, _updateAutoMaster, _pickBassDeck, getMasterDeck, _syncRatio,
// _localPeriod, _beatPhase, _barPhase, _period, reanchorSync, snapToRef,
// _followMaster, fxRefDeck, nextBoundaryAt, fxTick ROLL) and of app.js
// beatOf(), run every audio block on exact heard positions with every
// duration on the sample clock. Real-time safe: no allocation, no free, no
// lock, no I/O, noexcept. SPEC.md §12, Appendix A.
//
// Porting notes (engine.js semantics kept on purpose):
//  - JavaScript null is NaN for numbers and -1 for deck indexes; "x || 0" and
//    "!x" tests use truthy() (NaN and 0 are falsy, like null and 0 in JS),
//    except the stop timestamps of _updateAutoMaster, which are "set or not"
//    (the sample clock starts at 0, performance.now() never did).
//  - Every tempo the lock sets goes through setTempo(), which calls
//    followMaster() like engine.js Deck.setTempo -> _onTempo -> _followMaster.
//  - Non-finite tempi are never sent to a deck (engine.js would throw in the
//    AudioParam setter); octave folding returns NaN for a non-finite or
//    non-positive ratio (engine.js would loop forever on Infinity).
// Proven against engine.js itself: tests/sync/js_xcheck/xcheck.mjs runs the
// Web engine's own sync code and test_sync_js_xcheck.cpp compares every
// decision tick by tick (parity mode). The native precision refinements
// (sync.h, setNativePrecision, ON by default since the owner's decision of
// 2026-11-09; off = engine.js parity) are marked "native precision" below.
#include "om/sync.h"

#include <cmath>

#include "om/grid.h"

namespace om {
namespace {

// ---- engine.js constants (SPEC.md Appendix A) ------------------------------------
constexpr double kGraceSec = 1.2;            // _updateAutoMaster: a cut keeps the crown 1.2 s
constexpr double kEndedWindowSec = 2.0;      // natural end less than 2 s ago = immediate handover
constexpr float kBassOpenAbove = -0.9f;      // _pickBassDeck: bass "open" when eq.low > -0.9
constexpr double kBassBonus = 10.0;          // open bass first (x10), then the most audible
constexpr double kFollowEps = 1e-6;          // _followMaster / follow-master scaling threshold
constexpr double kStoppedEps = 1e-6;         // stopped SYNC deck: retarget beyond this relative gap
constexpr double kHandoverKeep = 0.004;      // handover: keep the current speed within 0.4 %
constexpr double kRepair = 0.06;             // self-repair beyond 6 %
constexpr double kMagnet = 0.03;             // reanchor / present-alignment magnet (beat)
constexpr double kSnapMaxErr = 0.06;         // snapToRef default magnet (beat)
constexpr double kOffsetAdopt = 0.08;        // a phase error beyond 0.08 beat is adopted as the offset
constexpr double kCalWindow0 = 1.0;          // calibration stage 1 window (s)
constexpr double kCalWindow1 = 8.0;          // calibration stage 2 window (s)
constexpr double kCalTimeout = 2.0;          // a window older than duration + 2 s restarts
constexpr int kCalMaxTries = 12;             // give up (calibrated) after 12 windows started
constexpr int kCalMaxPasses = 4;             // done after 4 passes
constexpr double kCalLimit0 = 0.01;          // stage 1: ratio correction within +-1 %
constexpr double kCalLimit1 = 0.001;         // stage 2: within +-0.1 %
constexpr double kCalCap = 0.02;             // absolute cap: +-2 % of the target ratio
constexpr double kCalDone = 0.0002;          // done when the correction is below 0.02 %
constexpr double kCalValidity = 0.05;        // validity of a window (track s per tempo / real s)
constexpr double kServoFileMaxDt = 0.1;      // servo bookkeeping: at most 0.1 s per step
constexpr double kErrKeepPerCall = 0.85;     // error low-pass, tuned for 60 calls per second...
constexpr double kCallsPerSec = 60.0;        // ...converted per block: keep = 0.85^(blockSec * 60)
constexpr double kDeadZone = 0.0015;         // beat: total rest inside
constexpr double kServoLimit = 0.002;        // holding servo: +-0.2 %, gain 0.08
constexpr double kServoGain = 0.08;
constexpr double kServoLimitStrong = 0.015;  // through the transposer: +-1.5 %, gain 1.0
constexpr double kServoGainStrong = 1.0;
constexpr double kTempoEps = 1e-9;           // servo rest: retempo beyond this
constexpr float kRollLevelMin = 0.02f;       // fxTick: panel / master ROLL unit level > 0.02
constexpr double kRollBeatsEps = 1e-6;       // fxTick: a roll of other beats is restarted
constexpr double kBeatDurFallback = 0.5;     // app.js: masterBeat || 0.5
constexpr double kBoundaryEps = 1e-6;        // nextBoundaryAt: ceil((f - anchor) / G + 1e-6)
// Native precision refinements (setNativePrecision, on by default; off = engine.js parity)
constexpr double kCoarseNoise = 0.001;       // the 1 s window's noise floor (engine.js: +-0.13 BPM ~ 0.1 %)
constexpr double kIntegralSec = 30.0;        // integral time of the holding servo (damping >= 0.85 from 75 BPM up)
constexpr double kIntegralMaxErr = 0.01;     // beat: larger (transient) errors are not integrated

constexpr int kLastMiUnset = -2;             // engine.js this._lastMi starts undefined

// JavaScript truthiness of a number that may be null (NaN): false for NaN and 0.
inline bool truthy(double v) noexcept { return v == v && v != 0.0; }
inline double orZero(double v) noexcept { return truthy(v) ? v : 0.0; }  // (x || 0)
inline double orOne(double v) noexcept { return truthy(v) ? v : 1.0; }   // (x || 1)
// Math.max / Math.min: NaN when either argument is NaN.
inline double jsMax(double a, double b) noexcept { return (a != a || b != b) ? kNaN : (a > b ? a : b); }
inline double jsMin(double a, double b) noexcept { return (a != a || b != b) ? kNaN : (a < b ? a : b); }

// engine.js: while (r > 1.6) r /= 2; while (r < 0.5) r *= 2;
inline double foldOctave(double r) noexcept {
  if (!(r > 0.0) || !std::isfinite(r)) return kNaN;
  while (r > kTempoMax) r /= 2;
  while (r < kTempoMin) r *= 2;
  return r;
}

// engine.js phase wraps: err > 0.5 -> -1, err < -0.5 -> +1
inline double wrapHalf(double e) noexcept {
  if (e > 0.5) e -= 1;
  if (e < -0.5) e += 1;
  return e;
}

// engine.js Deck._ratioMeas
struct RatioMeas {
  SampleTime t = 0.0;      // window start (sample clock)
  double e = 0.0;          // phase error at the start (beats)
  double dp = 0.0;         // deck heard position at the start
  double mp = 0.0;         // reference heard position at the start
  double servoFile = 0.0;  // track seconds the servo added since the start
};

// engine.js Deck sync fields
struct DeckSync {
  bool synced = false;
  double syncBase = kNaN;     // _syncBase
  double syncRef = kNaN;      // _syncRef
  double syncWant = kNaN;     // _syncWant
  double lastWant = kNaN;     // _lastWant
  double pllCorr = 0.0;       // _pllCorr
  double syncPhaseOff = 0.0;  // _syncPhaseOff (NaN = null)
  bool phaseFree = false;     // _phaseFree
  bool ratioCal = false;      // _ratioCal
  bool measActive = false;    // _ratioMeas != null
  RatioMeas meas;
  int ratioPasses = 0;        // _ratioPasses
  int ratioTries = 0;         // _ratioTries
  double errFilt = 0.0;       // _errFilt
  bool servoEngaged = false;  // the holding servo corrected in the last block (always, in native precision)
  double integ = 0.0;         // native precision: integral part of the servo correction (relative tempo)
  SampleTime servoAt = kNaN;  // _servoAt (NaN = undefined)
  // native precision: follow-master base changes waiting to be HEARD together
  // with the master's (a keylock master hears its tempo 2647 frames later).
  // While some are pending the deck keeps playing playBase.
  struct Pending {
    SampleTime at;
    double factor;
  };
  static constexpr int kPendingMax = 32;
  Pending pend[kPendingMax] = {};
  int pendHead = 0;
  int pendCount = 0;
  double playBase = kNaN;
  bool padRoll = false;       // _padRoll
  double padRollBeats = 0.0;
  double padRollMix = 1.0;
  // outputs of the last tick
  double lastErr = kNaN;
  double beatDur = kNaN;      // app.js beatOf(deck), NaN without BPM
  BeatClock clock;            // deckBeatClock
};

BeatClock fallbackClock(double beatDur) noexcept {
  BeatClock c;
  c.valid = false;
  c.playing = false;
  c.beatDur = beatDur;
  c.beatPos = 0.0;
  c.beatsPerSec = 0.0;
  c.baseTempo = 1.0;
  return c;
}

}  // namespace

struct SyncEngine::Impl {
  IDeckControl* decks[kNumDecks] = {};
  DeckSync ds[kNumDecks];
  int masterIdx = -1;           // engine.js masterIdx (null = -1)
  int autoMasterIdx = -1;       // engine.js autoMasterIdx
  bool jogHold = false;
  SampleTime mmStopAt = kNaN;   // engine.js _mmStopAt (falsy = NaN)
  SampleTime amStopAt = kNaN;   // engine.js _amStopAt
  int lastMi = kLastMiUnset;    // engine.js _lastMi
  bool following = false;       // engine.js _following
  bool precision = true;        // native precision refinements (default ON, owner 2026-11-09; off = engine.js parity)
  double gridOffset = 0.0;      // engine.js GLOBAL_GRID_OFFSET
  SampleTime blockNow = 0.0;    // sample time of the block being prepared (commands: the next one)
  // views of the last tick
  BlockClock clk;
  MixView mix;
  FxRackView fx;
  // error low-pass coefficient cache (per block duration)
  int keepFrames = -1;
  double keepRate = 0.0;
  double keep = 1.0;
  // beat clocks of the FX units (the decks' are in ds[].clock)
  BeatClock panel[kNumFxUnits];
  BeatClock pad[kNumDecks];
  BeatClock master;

  Impl() { reset(); }

  void reset() noexcept {
    masterIdx = -1;
    autoMasterIdx = -1;
    jogHold = false;
    mmStopAt = kNaN;
    amStopAt = kNaN;
    lastMi = kLastMiUnset;
    following = false;
    for (DeckSync& s : ds) s = DeckSync();
    for (BeatClock& c : panel) c = fallbackClock(kBeatDurFallback);
    for (BeatClock& c : pad) c = fallbackClock(kBeatDurFallback);
    master = fallbackClock(kBeatDurFallback);
    for (DeckSync& s : ds) s.clock = fallbackClock(kBeatDurFallback);
  }

  // ---- deck accessors (engine.js Deck fields) ------------------------------------------
  IDeckControl* deck(int i) const noexcept { return (i >= 0 && i < kNumDecks) ? decks[i] : nullptr; }
  const BeatGrid* gridOf(int i) const noexcept {
    const IDeckControl* d = deck(i);
    return d ? d->grid() : nullptr;
  }
  bool hasBpm(int i) const noexcept {  // engine.js d.bpm (truthy)
    const BeatGrid* g = gridOf(i);
    return g && g->bpm > 0;
  }
  double bpmOf(int i) const noexcept {
    const BeatGrid* g = gridOf(i);
    return g ? g->bpm : 0.0;
  }
  bool hasBeats(int i) const noexcept {  // engine.js d.beats (non-null)
    const BeatGrid* g = gridOf(i);
    return g && g->hasDynamic();
  }
  bool isPlaying(int i) const noexcept {
    const IDeckControl* d = deck(i);
    return d && d->playing();
  }
  bool isLoaded(int i) const noexcept {  // engine.js d.buffer
    const IDeckControl* d = deck(i);
    return d && d->loaded();
  }
  double posOf(int i) const noexcept {  // engine.js d.currentTime()
    const IDeckControl* d = deck(i);
    return d ? d->heardPosition() : 0.0;
  }
  double tempoOf(int i) const noexcept {
    const IDeckControl* d = deck(i);
    return d ? d->tempo() : 1.0;
  }
  bool settled(int i) const noexcept {
    const IDeckControl* d = deck(i);
    return d && d->transportSettled();
  }
  // tempo / (1 + (_pllCorr || 0))
  double baseOf(int i) const noexcept { return tempoOf(i) / (1 + orZero(ds[i].pllCorr)); }

  // ---- native precision: follow-master changes aligned on what is HEARD ---------------
  // Seconds between a tempo change and the moment it is heard (WSOLA lockstep).
  double hearLag(int i) const noexcept {
    const IDeckControl* d = deck(i);
    const double rate = clk.sampleRate > 0 ? clk.sampleRate : 48000.0;
    return d && d->routedThroughWsola() ? kWsolaLatencySamples / rate : 0.0;
  }
  // The base the deck plays now: syncBase, or the base before the pending changes.
  static double playBaseOf(const DeckSync& s) noexcept { return s.pendCount ? s.playBase : s.syncBase; }
  static void flushPending(DeckSync& s) noexcept {
    s.pendCount = 0;
    s.pendHead = 0;
  }
  // syncBase has just been scaled by f (bookkeeping, engine.js); the deck
  // plays it `delay` seconds later. Returns false when it must apply now.
  bool deferScaling(DeckSync& s, double f, double baseBefore, double delay) noexcept {
    if (!precision || !(delay > 0)) {
      flushPending(s);
      return false;
    }
    if (s.pendCount == DeckSync::kPendingMax) {  // degenerate flood: apply everything now
      flushPending(s);
      return false;
    }
    if (s.pendCount == 0) s.playBase = baseBefore;
    s.pend[(s.pendHead + s.pendCount) % DeckSync::kPendingMax] = {blockNow + delay, f};
    s.pendCount++;
    return true;
  }
  // Every block (also under jogHold or the auto-master freeze): the changes
  // now heard on the master are played by their followers.
  void servicePending(SampleTime now) noexcept {
    for (int i = 0; i < kNumDecks; i++) {
      DeckSync& s = ds[i];
      if (!s.pendCount) continue;
      const int before = s.pendCount;
      while (s.pendCount && s.pend[s.pendHead].at <= now) {
        s.playBase *= s.pend[s.pendHead].factor;
        s.pendHead = (s.pendHead + 1) % DeckSync::kPendingMax;
        s.pendCount--;
      }
      if (s.pendCount != before) setTempo(i, playBaseOf(s) * (1 + orZero(s.pllCorr)));
    }
  }

  // ---- engine.js grid helpers on the heard position --------------------------------------
  double beatPhase(int i) const noexcept {  // _beatPhase
    const BeatGrid* g = gridOf(i);
    return g ? grid::beatPhase(*g, posOf(i), gridOffset) : kNaN;
  }
  double barPhase(int i) const noexcept {  // _barPhase
    const BeatGrid* g = gridOf(i);
    return g ? grid::barPhase(*g, posOf(i), gridOffset) : kNaN;
  }
  double period(int i) const noexcept {  // _period
    const BeatGrid* g = gridOf(i);
    return g ? grid::period(*g, posOf(i), gridOffset) : kNaN;
  }
  double localPeriod(int i) const noexcept {  // _localPeriod
    const BeatGrid* g = gridOf(i);
    return g ? grid::localPeriod(*g, posOf(i), gridOffset) : kNaN;
  }
  // _period(d) || 60 / d.bpm
  double periodOrBpm(int i) const noexcept {
    const double p = period(i);
    return truthy(p) ? p : 60.0 / bpmOf(i);
  }

  // engine.js _syncRatio(d, m): tempo giving d exactly m's beat speed (m's servo correction removed)
  double syncRatio(int d, int m) const noexcept {
    const double mBase = baseOf(m);
    const double pd = localPeriod(d);
    const double pm = localPeriod(m);
    const double ratio = truthy(pd) && truthy(pm) ? (mBase * pd) / pm : (bpmOf(m) * mBase) / bpmOf(d);
    return foldOctave(ratio);
  }

  int effectiveMaster() const noexcept { return masterIdx >= 0 ? masterIdx : autoMasterIdx; }

  // engine.js getMasterDeck(excludeIdx)
  int getMasterDeck(int excl) const noexcept {
    if (masterIdx >= 0 && masterIdx != excl && hasBpm(masterIdx)) return masterIdx;
    if (autoMasterIdx >= 0 && autoMasterIdx != excl && hasBpm(autoMasterIdx) && isPlaying(autoMasterIdx))
      return autoMasterIdx;
    // a NON-SYNCED deck first: two followers never chase each other
    for (int j = 0; j < kNumDecks; j++) {
      if (j != excl && isPlaying(j) && hasBpm(j) && !ds[j].synced) return j;
    }
    for (int j = 0; j < kNumDecks; j++) {
      if (j != excl && isPlaying(j) && hasBpm(j)) return j;
    }
    return -1;
  }

  // engine.js fxRefDeck(u) on the LIVE assign matrix
  int fxRefDeck(int u) const noexcept {
    if (u >= 0 && u < kNumFxUnits) {
      for (int d = 0; d < kNumDecks; d++) {
        if (fx.assigned(u, d) && isPlaying(d) && hasBpm(d)) return d;
      }
    }
    return getMasterDeck(-1);
  }

  // engine.js _pickBassDeck(excl): open bass first (x10), then the most heard
  int pickBassDeck(int excl) const noexcept {
    int best = -1;
    double bestScore = -1;
    for (int j = 0; j < kNumDecks; j++) {
      if (j == excl || !isPlaying(j) || !hasBpm(j)) continue;
      const double side = mix.xfGain[j];  // target crossfader gain of the deck's side
      const double heard = orZero(mix.volume[j]) * side;
      const double bass = mix.eqLow[j] > kBassOpenAbove ? 1.0 + mix.eqLow[j] : 0.0;
      const double score = (bass > 0 ? kBassBonus + bass : 0.0) + heard;
      if (score > bestScore) {
        bestScore = score;
        best = j;
      }
    }
    return best;
  }

  // engine.js mm._endedAt && nowS - mm._endedAt < 2 (sample clock)
  bool endedRecently(int i, SampleTime now) const noexcept {
    const IDeckControl* d = deck(i);
    if (!d) return false;
    const SampleTime e = d->endedAtSample();
    return truthy(e) && now - e < kEndedWindowSec;
  }

  // engine.js _updateAutoMaster(), every duration on the sample clock
  void updateAutoMaster(SampleTime nowS) noexcept {
    if (masterIdx >= 0) {
      bool anyOther = false;
      for (int j = 0; j < kNumDecks; j++) {
        if (j != masterIdx && isPlaying(j) && hasBpm(j)) anyOther = true;
      }
      if (isPlaying(masterIdx) || !anyOther) {
        mmStopAt = kNaN;
      } else {
        const bool ended = endedRecently(masterIdx, nowS);
        if (!isSet(mmStopAt)) mmStopAt = nowS;
        if (ended || nowS - mmStopAt >= kGraceSec) {
          const int j = pickBassDeck(masterIdx);
          if (j >= 0) {
            masterIdx = j;  // the MASTER button lights up on the new one
            autoMasterIdx = j;
          }
          mmStopAt = kNaN;
        }
      }
    }
    const int am = autoMasterIdx;
    if (am >= 0 && deck(am) && isPlaying(am)) {
      amStopAt = kNaN;
      return;  // the master stays master as long as it plays
    }
    if (am >= 0 && deck(am)) {
      // cut tolerance: a master stopped for a moment keeps its crown 1.2 s;
      // a natural end (less than 2 s ago) hands over at once
      if (!endedRecently(am, nowS)) {
        if (!isSet(amStopAt)) {
          amStopAt = nowS;
          return;
        }
        if (nowS - amStopAt < kGraceSec) return;
      }
      amStopAt = kNaN;
    }
    bool anyPlaying = false;
    for (int j = 0; j < kNumDecks; j++) {
      if (isPlaying(j) && hasBpm(j)) anyPlaying = true;
    }
    if (!anyPlaying) {
      autoMasterIdx = -1;
      return;
    }
    autoMasterIdx = pickBassDeck(-1);
  }

  // engine.js Deck.setTempo(r) + its _onTempo hook (_followMaster)
  void setTempo(int i, double r) noexcept {
    IDeckControl* d = deck(i);
    if (!d || !std::isfinite(r)) return;
    d->setTempo(r);
    followMaster(i);
  }

  // engine.js _followMaster(i): the master changed tempo, its synced
  // followers scale their base in the same block (calibration kept)
  void followMaster(int i) noexcept {
    if (following) return;  // (the followers themselves don't trigger anything)
    const int mi = effectiveMaster();
    if (i != mi || i < 0) return;
    if (!hasBpm(i)) return;
    following = true;
    const double mBase = baseOf(i);
    const double mBpm = bpmOf(i);
    for (int j = 0; j < kNumDecks; j++) {
      DeckSync& s = ds[j];
      if (j == i || !s.synced || !isPlaying(j) || !hasBpm(j) || !truthy(s.syncBase) || !truthy(s.lastWant)) continue;
      if (getMasterDeck(j) != i) continue;
      const double want = foldOctave((mBpm * mBase) / bpmOf(j));
      if (!(want > 0)) continue;
      if (std::fabs(want / s.lastWant - 1) <= kFollowEps) continue;
      const double f = want / s.lastWant;
      const double before = playBaseOf(s);
      s.syncBase *= f;
      s.syncRef = (truthy(s.syncRef) ? s.syncRef : s.syncBase / f) * f;
      s.lastWant = want;
      s.syncWant = want;
      s.measActive = false;
      // (native precision: played when the master's change is heard)
      deferScaling(s, f, before, hearLag(i) - hearLag(j));
      setTempo(j, playBaseOf(s) * (1 + orZero(s.pllCorr)));
    }
    following = false;
  }

  // engine.js fxTick(), ROLL part: the held pad first, then a panel ROLL unit
  // live-assigned to the deck (level > 0.02), then a master FX ROLL
  void driveRolls() noexcept {
    for (int i = 0; i < kNumDecks; i++) {
      IDeckControl* d = deck(i);
      if (!d) continue;
      const DeckSync& s = ds[i];
      bool want = false;
      double wantBeats = 0.0, wantMix = 0.0;
      if (s.padRoll) {
        want = true;
        wantBeats = s.padRollBeats;
        wantMix = s.padRollMix;
      }
      for (int u = 0; u < kNumFxUnits && !want; u++) {
        const FxUnitView& v = fx.panel[u];
        if (v.enabled && v.type == FxType::Roll && fx.assigned(u, i) && v.level > kRollLevelMin) {
          want = true;
          wantBeats = v.beatsMult;
          wantMix = v.level;
        }
      }
      if (!want && fx.masterExists && fx.master.enabled && fx.master.type == FxType::Roll &&
          fx.master.level > kRollLevelMin) {
        want = true;
        wantBeats = fx.master.beatsMult;
        wantMix = fx.master.level;
      }
      double rollBeats = 0.0;
      const bool rolling = d->rolling(&rollBeats);
      if (want && d->playing()) {
        if (!rolling || std::fabs(rollBeats - wantBeats) > kRollBeatsEps) d->startRoll(wantBeats, wantMix);
        else d->setRollMix(wantMix);
      } else if (rolling) {
        d->stopRoll(false);
      }
    }
  }

  // engine.js syncLock() after the jogHold test: handover, follow-master,
  // repair, flash calibration, holding servo. nowC on the sample clock.
  void lock(SampleTime nowC) noexcept {
    const int mi = effectiveMaster();
    // MASTER CHANGE = TRANSITION WITHOUT ANY JUMP: each synced deck restarts
    // from its CURRENT speed and recalibrates against the new master
    if (mi != lastMi) {
      lastMi = mi;
      const bool mNewOk = mi >= 0 && deck(mi) && hasBpm(mi);
      const double mEff = mNewOk ? bpmOf(mi) * baseOf(mi) : kNaN;
      // native precision: the new master's own setTempo below must not scale
      // the followers handed over after it (engine.js _onTempo ordering:
      // they would move by want(new) / want(old), the BPM-field rounding)
      const bool guard = precision && !following;
      if (guard) following = true;
      for (int j = 0; j < kNumDecks; j++) {
        DeckSync& s = ds[j];
        flushPending(s);
        if (!deck(j)) continue;
        // native precision: a SYNC deck without a base yet (typically the deck
        // that was master since it started) is handed over like the others,
        // from its current speed. engine.js skips it here, and the repair below
        // re-aims it at the BPM-field ratio: a jump of the BPM rounding (up to
        // ~0.06 %), then a whole recalibration.
        if (precision && !truthy(s.syncBase) && j != mi && s.synced && hasBpm(j) && isPlaying(j) && truthy(mEff))
          s.syncBase = tempoOf(j) / (1 + orZero(s.pllCorr));
        if (!truthy(s.syncBase)) continue;
        // the speed kept: the base (engine.js drops the servo correction);
        // native precision: with the ratio residue the integral term learned
        // (only the momentary proportional part of the correction is dropped)
        double cur = tempoOf(j) / (1 + orZero(s.pllCorr));
        if (precision) cur *= 1 + s.integ;
        if (j != mi && s.synced && hasBpm(j) && truthy(mEff)) {
          // a SYNCED deck targets the new master's BPM, but keeps EXACTLY its
          // speed when it already beats within 0.4 % of it
          const double want = syncRatio(j, mi);
          s.syncBase = (std::fabs(cur / want - 1) < kHandoverKeep || !(want > 0)) ? cur : want;
        } else {
          // the deck that BECOMES master (or a non-synced one) never jumps
          s.syncBase = cur;
        }
        s.syncRef = s.syncBase;
        s.pllCorr = 0;
        s.integ = 0;
        setTempo(j, s.syncBase);
        s.ratioCal = false;
        s.measActive = false;
        s.syncPhaseOff = kNaN;  // re-anchored on the PRESENT alignment below
        s.errFilt = 0;
        s.servoEngaged = false;
        s.lastWant = kNaN;      // the target has just been re-aimed: no double scaling
      }
      if (guard) following = false;
    }
    // AUTO master briefly stopped (within the grace period): freeze everything
    if (masterIdx < 0 && mi >= 0 && deck(mi) && !isPlaying(mi)) return;

    for (int i = 0; i < kNumDecks; i++) {
      DeckSync& s = ds[i];
      IDeckControl* d = deck(i);
      if (!d) continue;
      if (i == mi) {
        // the MASTER is the reference: never re-aligned; only its correction is removed
        s.integ = 0;
        if (truthy(s.pllCorr)) {
          s.pllCorr = 0;
          if (s.synced && truthy(s.syncBase)) setTempo(i, s.syncBase);
        }
        continue;
      }
      // SYNC deck STOPPED: it already takes the master's BPM (the phase locks on PLAY)
      if (s.synced && !d->playing() && hasBpm(i) && d->loaded()) {
        const int m0 = getMasterDeck(i);
        if (m0 >= 0 && isPlaying(m0) && hasBpm(m0)) {
          const double w = foldOctave((bpmOf(m0) * baseOf(m0)) / bpmOf(i));
          if (w > 0 && std::fabs(d->tempo() / w - 1) > kStoppedEps) setTempo(i, w);
        }
        continue;
      }
      if (!s.synced || !d->playing()) continue;
      const int m = getMasterDeck(i);
      if (m < 0 || !isPlaying(m)) continue;
      // ABSOLUTE "SAME BPM" GUARANTEE: the deck always targets the master's BPM
      if (hasBpm(i) && hasBpm(m)) {
        const double want = foldOctave((bpmOf(m) * baseOf(m)) / bpmOf(i));
        // the master changed tempo: followers scale in the same proportion
        // (only against the REAL master)
        if (truthy(s.syncBase) && truthy(s.lastWant) && m == mi && std::fabs(want / s.lastWant - 1) > kFollowEps) {
          const double f = want / s.lastWant;
          const double before = playBaseOf(s);
          s.syncBase *= f;
          s.syncRef = (truthy(s.syncRef) ? s.syncRef : s.syncBase / f) * f;
          deferScaling(s, f, before, hearLag(m) - hearLag(i));  // (native precision: heard together)
          setTempo(i, playBaseOf(s) * (1 + orZero(s.pllCorr)));
          s.measActive = false;  // the window saw two tempi
        }
        s.lastWant = want;
        s.syncWant = want;
        // REPAIR beyond 6 %: immediate re-aim, then flash recalibration
        if (!truthy(s.syncBase) || std::fabs(s.syncBase / want - 1) > kRepair) {
          flushPending(s);
          s.syncBase = want;
          s.syncRef = want;
          s.pllCorr = 0;
          s.integ = 0;
          setTempo(i, want);
          s.ratioCal = false;
          s.measActive = false;
          s.ratioPasses = 0;
          s.ratioTries = 0;
          s.syncPhaseOff = kNaN;
          s.errFilt = 0;
          s.servoEngaged = false;
          continue;
        }
      }
      if (!truthy(s.syncBase)) continue;  // no BPM detected: nothing to lock
      const double pm = beatPhase(m);
      const double pd = beatPhase(i);
      if (!isSet(pm) || !isSet(pd)) continue;
      // after a master change the PRESENT alignment becomes the target
      if (!isSet(s.syncPhaseOff)) {
        double off = pm - pd;
        off -= jsRound(off);
        if (std::fabs(off) < kMagnet) off = 0;
        s.syncPhaseOff = off;
      }
      double err = pm - pd - orZero(s.syncPhaseOff);
      err -= jsRound(err);
      s.lastErr = err;
      // red lines clearly elsewhere: ADOPT that alignment instead of chasing it
      if (std::fabs(err) > kOffsetAdopt) {
        s.syncPhaseOff = pm - pd;
        s.measActive = false;
        if (!s.ratioCal) s.ratioPasses = 0;
        s.errFilt = 0;
        s.servoEngaged = false;
        if (precision) {
          // native precision: the learned ratio residue still holds (only the
          // phase target moved); the proportional part is dropped
          if (s.pllCorr != s.integ) {
            s.pllCorr = s.integ;
            setTempo(i, playBaseOf(s) * (1 + s.integ));
          }
        } else if (truthy(s.pllCorr)) {
          s.pllCorr = 0;
          setTempo(i, playBaseOf(s));
        }
        continue;
      }
      // FLASH CALIBRATION: what the servo added since the previous block is
      // accounted for (track seconds)
      if (s.measActive && isSet(s.servoAt)) {
        s.meas.servoFile += orZero(s.pllCorr) * s.syncBase * jsMin(kServoFileMaxDt, jsMax(0.0, nowC - s.servoAt));
      }
      s.servoAt = nowC;
      if (!s.ratioCal) {
        // nothing is measured while either transport is not advancing linearly
        // (native precision: nor while a follow-master change is still unheard)
        if (d->transportSettled() && settled(m) && s.pendCount == 0) {
          const int pass = s.ratioPasses;
          const double duration = pass == 0 ? kCalWindow0 : kCalWindow1;
          if (!s.measActive || nowC - s.meas.t > duration + kCalTimeout) {
            s.ratioTries += 1;
            if (s.ratioTries > kCalMaxTries) {
              s.ratioCal = true;
            } else {
              s.measActive = true;
              s.meas.t = nowC;
              s.meas.e = err;
              s.meas.dp = d->heardPosition();
              s.meas.mp = posOf(m);
              s.meas.servoFile = 0;
            }
          } else if (nowC - s.meas.t >= duration) {
            const double dtW = nowC - s.meas.t;
            // VALIDITY: a jump / seek / loop during the window corrupts the slope
            const bool dOk = std::fabs((d->heardPosition() - s.meas.dp) - (dtW * s.syncBase + s.meas.servoFile)) <
                             kCalValidity * orOne(d->tempo());
            const bool mOk = std::fabs((posOf(m) - s.meas.mp) / orOne(tempoOf(m)) - dtW) < kCalValidity;
            if (!dOk || !mOk) {
              s.measActive = false;
            } else {
              double de = err - s.meas.e;
              de -= jsRound(de);
              const double per = periodOrBpm(i);
              // drift due to the RATIO alone = observed drift + what the servo caught up
              const double drift = de + s.meas.servoFile / per;
              const double fd = (bpmOf(i) * d->tempo()) / 60;  // beats per second
              const double kRaw = 1 + drift / (dtW * fd);
              const double lim0 = pass == 0 ? kCalLimit0 : kCalLimit1;
              double k = jsMax(1 - lim0, jsMin(1 + lim0, kRaw));
              // native precision: a coarse (1 s) correction below that window's
              // own noise floor is noise: keep the ratio, refine it in the fine stage
              if (precision && pass == 0 && std::fabs(k - 1) < kCoarseNoise) k = 1;
              // ABSOLUTE CAP: +-2 % of the target ratio
              const double target = truthy(s.syncWant) ? s.syncWant : s.syncBase;
              const double baseBefore = s.syncBase;
              s.syncBase = jsMax(target * (1 - kCalCap), jsMin(target * (1 + kCalCap), s.syncBase * k));
              s.syncRef = s.syncBase;
              // native precision: the new base takes the whole ratio residue
              // (the window accounted for what the servo added): the integral
              // part that compensated it starts again from 0
              if (precision && s.syncBase != baseBefore) s.integ = 0;
              flushPending(s);
              s.ratioPasses = pass + 1;
              // native precision: a 1 s window (+-0.13 BPM, engine.js's own
              // figure) cannot certify a 0.02 % residue: done after a fine pass only
              const bool fineOk = !precision || pass >= 1;
              s.ratioCal = (fineOk && std::fabs(k - 1) < kCalDone) || s.ratioPasses >= kCalMaxPasses;
              s.measActive = false;
            }
          }
        }
      }
      // SMOOTHED ERROR (0.85 / 0.15 per 1/60 s, converted per block)
      s.errFilt = s.errFilt * keep + err * (1 - keep);
      const double eF = s.errFilt;
      // HOLDING SERVO: +-0.2 % (gain 0.08), or +-1.5 % (gain 1.0) through the transposer
      const bool strong = d->routedThroughWsola();
      const double lim = strong ? kServoLimitStrong : kServoLimit;
      const double gain = strong ? kServoGainStrong : kServoGain;
      if (precision) {
        // native precision: proportional + INTEGRAL servo, always on. The
        // proportional servo alone holds the ratio residue r the calibration
        // leaves (its 8 s window is noise-limited) with a constant phase error
        // of r / gain, and its dead zone lets the error drift back to 0.0015
        // beat (1.2 ms at 75 BPM): the error in ms grows with the beat length
        // and the grid noise. The integral term learns r (in pllCorr only: the
        // base, hence the BPM shown, does not move) and the error returns to 0.
        // Transient errors (> 0.01 beat) are not integrated.
        const double blockSec = (clk.frames > 0 && clk.sampleRate > 0) ? clk.frames / clk.sampleRate : 0.0;
        if (std::fabs(eF) < kIntegralMaxErr)
          s.integ = jsMax(-lim, jsMin(lim, s.integ + eF * gain * blockSec / kIntegralSec));
        const double corr = jsMax(-lim, jsMin(lim, eF * gain + s.integ));
        s.servoEngaged = true;
        s.pllCorr = corr;
        setTempo(i, playBaseOf(s) * (1 + corr));
        continue;
      }
      if (std::fabs(eF) < kDeadZone) {
        // glued to the wanted offset: total rest
        s.servoEngaged = false;
        if (truthy(s.pllCorr)) s.pllCorr = 0;
        const double pb = playBaseOf(s);
        if (std::fabs(d->tempo() - pb) > kTempoEps) setTempo(i, pb);
        continue;
      }
      s.servoEngaged = true;
      const double corr = jsMax(-lim, jsMin(lim, eF * gain));
      s.pllCorr = corr;
      setTempo(i, playBaseOf(s) * (1 + corr));
    }
  }

  // ---- beat clocks (app.js frame loop, after syncLock) --------------------------------------
  // app.js beatOf(dk): real seconds per beat, servo correction removed (NaN without BPM)
  double beatOf(int i) const noexcept {
    if (!hasBpm(i)) return kNaN;
    double per = localPeriod(i);
    if (!truthy(per)) per = 60.0 / bpmOf(i);
    return per / (orOne(tempoOf(i)) / (1 + orZero(ds[i].pllCorr)));
  }

  BeatClock makeDeckClock(int i, double beatDur) const noexcept {
    BeatClock c = fallbackClock(kBeatDurFallback);
    const IDeckControl* d = deck(i);
    if (!d) return c;
    c.playing = d->playing();
    const double tmp = orOne(d->tempo());
    c.baseTempo = tmp / (1 + orZero(ds[i].pllCorr));
    if (truthy(beatDur)) {
      c.beatDur = beatDur;
      c.valid = true;
    }
    const BeatGrid* g = d->grid();
    if (!g) return c;
    const double pos = d->heardPosition();
    double f = kNaN;
    double len = kNaN;
    if (g->hasDynamic()) {
      f = grid::indexFracAt(*g, pos, gridOffset) - g->barAnchor;
      len = grid::periodAt(*g, pos, gridOffset);
    } else if (g->bpm > 0) {
      f = (pos - (isSet(g->beatOffset) ? g->beatOffset : 0.0)) * g->bpm / 60.0;
      len = 60.0 / g->bpm;
    }
    if (std::isfinite(f)) {
      c.beatPos = f;
      if (c.playing && len > 0) c.beatsPerSec = tmp / len;
    }
    return c;
  }

  // the clock of reference deck `ref` with app.js's beat duration fallback
  BeatClock unitClock(int ref, double fallbackDur) const noexcept {
    if (ref < 0) return fallbackClock(fallbackDur);
    BeatClock c = ds[ref].clock;
    if (!truthy(ds[ref].beatDur)) {
      c.beatDur = fallbackDur;
      c.valid = false;
    }
    return c;
  }

  void computeClocks() noexcept {
    for (int i = 0; i < kNumDecks; i++) {
      DeckSync& s = ds[i];
      s.beatDur = beatOf(i);
      s.clock = makeDeckClock(i, s.beatDur);
    }
    const int md = getMasterDeck(-1);
    const double masterBeat = md >= 0 && truthy(ds[md].beatDur) ? ds[md].beatDur : kBeatDurFallback;
    for (int u = 0; u < kNumFxUnits; u++) panel[u] = unitClock(fxRefDeck(u), masterBeat);
    for (int d = 0; d < kNumDecks; d++) {
      // pad units follow their own deck (its grid phase), with the master's
      // beat duration when the deck has no BPM (app.js: beatOf(deck) || masterBeat)
      pad[d] = ds[d].clock;
      if (!truthy(ds[d].beatDur)) {
        pad[d].beatDur = masterBeat;
        pad[d].valid = false;
      }
    }
    master = unitClock(md, masterBeat);
  }

  // engine.js nextBoundaryAt(d, periodBeats), presentTime base
  EngineTime nextBoundaryAt(int i, double periodBeats) const noexcept {
    const IDeckControl* d = deck(i);
    if (!d || !d->playing() || !(periodBeats > 0)) return kNaN;
    const BeatGrid* g = d->grid();
    if (!g) return kNaN;
    const double pos = d->heardPosition();
    double f = kNaN;
    double anchor = 0;
    if (g->hasDynamic()) {
      f = grid::indexFracAt(*g, pos, gridOffset);
      anchor = g->barAnchor;
    } else if (g->bpm > 0 && isSet(g->beatOffset)) {
      f = ((pos - g->beatOffset) * g->bpm) / 60;
    } else {
      return kNaN;
    }
    if (!isSet(f)) return kNaN;
    // alignment grid: the period if shorter than a beat, else the bar
    const double G = periodBeats < 1 ? periodBeats : (periodBeats < 4 ? periodBeats : 4.0);
    const double k = std::ceil((f - anchor) / G + kBoundaryEps) * G + anchor;
    const double tFile = g->hasDynamic() ? grid::timeAtIndex(*g, k, gridOffset) : g->beatOffset + (k * 60) / g->bpm;
    if (!isSet(tFile)) return kNaN;
    const EngineTime now = clk.presentTime;
    const EngineTime at = now + (tFile - pos) / orOne(d->tempo());
    return at > now ? at : kNaN;
  }
};

SyncEngine::SyncEngine() : impl_(std::make_unique<Impl>()) {}
SyncEngine::~SyncEngine() = default;

void SyncEngine::attachDecks(IDeckControl* const decks[kNumDecks]) noexcept {
  for (int i = 0; i < kNumDecks; i++) impl_->decks[i] = decks ? decks[i] : nullptr;
}

// ---- commands -------------------------------------------------------------------------------
void SyncEngine::setManualMaster(int idx) noexcept { impl_->masterIdx = (idx >= 0 && idx < kNumDecks) ? idx : -1; }

void SyncEngine::setJogHold(bool on) noexcept { impl_->jogHold = on; }

void SyncEngine::setSynced(int d, bool on) noexcept {
  if (d >= 0 && d < kNumDecks) impl_->ds[d].synced = on;
}

void SyncEngine::writeSyncBase(int d, const SyncBaseWrite& w) noexcept {
  if (d < 0 || d >= kNumDecks) return;
  DeckSync& s = impl_->ds[d];
  if (w.mask & SyncBaseWrite::kBase) {
    s.syncBase = w.base;
    Impl::flushPending(s);
  }
  if (w.mask & SyncBaseWrite::kRef) s.syncRef = w.ref;
  if (w.mask & SyncBaseWrite::kPllCorr) s.pllCorr = std::isfinite(w.pllCorr) ? w.pllCorr : 0.0;
  // the UI rewrote the base or the correction: the learned residue no longer applies
  if (w.mask & (SyncBaseWrite::kBase | SyncBaseWrite::kPllCorr)) s.integ = 0;
}

// engine.js sync(i): EXACT tempo of the master (local grids), then BAR alignment
bool SyncEngine::sync(int i, const BlockClock&) noexcept {
  Impl& im = *impl_;
  IDeckControl* d = im.deck(i);
  if (!d || !im.hasBpm(i)) return false;
  const int m = im.getMasterDeck(i);
  if (m < 0 || !im.hasBpm(m)) return false;
  const double ratio = im.syncRatio(i, m);
  if (!(ratio > 0)) return false;
  DeckSync& s = im.ds[i];
  Impl::flushPending(s);
  im.setTempo(i, ratio);
  s.syncBase = d->tempo();  // reference for the continuous lock
  s.syncRef = d->tempo();   // safety anchor
  s.phaseFree = false;
  // BAR alignment: on a dynamic grid the target is a beat INDEX converted back to a position
  const double pm = im.barPhase(m);
  const double pd = im.barPhase(i);
  if (isSet(pm) && isSet(pd)) {
    const double err = wrapHalf(pm - pd);
    const double pos = d->heardPosition();
    double target = kNaN;
    if (im.hasBeats(i)) {
      const BeatGrid* g = d->grid();
      const double f = grid::indexFracAt(*g, pos, im.gridOffset);
      if (isSet(f)) target = grid::timeAtIndex(*g, f + err * 4, im.gridOffset);
    }
    if (!isSet(target)) target = pos + err * 4 * im.periodOrBpm(i);
    d->seekHeard(target);
  }
  s.synced = true;
  s.syncPhaseOff = 0;  // SYNC = back to grid-on-grid alignment
  s.ratioCal = false;  // calibration from the next block
  s.measActive = false;
  s.ratioTries = 0;
  s.errFilt = 0;
  s.servoEngaged = false;
  s.pllCorr = 0;
  s.integ = 0;
  s.lastWant = kNaN;
  // straight to the FINE stage (8 s) when both ratios come from dynamic grids
  s.ratioPasses = im.hasBeats(i) && im.hasBeats(m) ? 1 : 0;
  return true;
}

// engine.js reanchorSync(i): adopt the CURRENT alignment after a manual jog
void SyncEngine::reanchor(int i) noexcept {
  Impl& im = *impl_;
  IDeckControl* d = im.deck(i);
  if (!d) return;
  if (i == im.effectiveMaster()) return;  // the master is never anchored against a slave
  DeckSync& s = im.ds[i];
  if (!s.synced || !d->playing()) return;
  const int m = im.getMasterDeck(i);
  if (m < 0 || !im.isPlaying(m)) return;
  const double pm = im.beatPhase(m);
  const double pd = im.beatPhase(i);
  if (!isSet(pm) || !isSet(pd)) return;
  double err = wrapHalf(pm - pd);
  if (std::fabs(err) < kMagnet) err = 0;  // VISUAL MAGNET: almost aligned = exactly aligned
  s.syncPhaseOff = err;
  s.errFilt = 0;
  s.servoEngaged = false;
  s.measActive = false;  // the gesture corrupted the window (the calibration acquired is kept)
  s.phaseFree = true;
}

// engine.js snapToRef(i, maxErr): finishes an almost-aligned release (magnet)
bool SyncEngine::snapToRef(int i, double maxErr) noexcept {
  Impl& im = *impl_;
  IDeckControl* d = im.deck(i);
  if (!d) return false;
  if (!(maxErr == maxErr)) maxErr = kSnapMaxErr;
  const BeatGrid* g = d->grid();
  if (!d->loaded() || !g || !(g->bpm > 0) || (!isSet(g->beatOffset) && !g->hasDynamic())) return false;
  auto hasGrid = [&im](int x) {
    const BeatGrid* gx = im.gridOf(x);
    return im.isLoaded(x) && gx && gx->bpm > 0 && (isSet(gx->beatOffset) || gx->hasDynamic());
  };
  int m = -1;
  if (im.masterIdx >= 0 && im.masterIdx != i) {
    if (hasGrid(im.masterIdx) && im.isPlaying(im.masterIdx)) m = im.masterIdx;
  }
  if (m < 0) {
    for (int j = 0; j < kNumDecks; j++) {
      if (j != i && im.isPlaying(j) && hasGrid(j)) {
        m = j;
        break;
      }
    }
  }
  if (m < 0) return false;
  const double pm = im.beatPhase(m);
  const double pd = im.beatPhase(i);
  if (!isSet(pm) || !isSet(pd)) return false;
  const double err = wrapHalf(pm - pd);
  if (std::fabs(err) > maxErr) return false;
  d->seekHeard(d->heardPosition() + err * im.periodOrBpm(i));
  return true;
}

void SyncEngine::setPadRoll(int d, double beats, double mix) noexcept {
  if (d < 0 || d >= kNumDecks) return;
  DeckSync& s = impl_->ds[d];
  s.padRoll = beats > 0;
  s.padRollBeats = s.padRoll ? beats : 0.0;
  s.padRollMix = s.padRoll ? mix : 1.0;
}

void SyncEngine::setGlobalGridOffset(double sec) noexcept { impl_->gridOffset = truthy(sec) ? sec : 0.0; }

// engine.js loadTrack(): SYNC stays on, the new track restarts from a blank ratio
void SyncEngine::onTrackLoaded(int d) noexcept {
  if (d < 0 || d >= kNumDecks) return;
  DeckSync& s = impl_->ds[d];
  Impl::flushPending(s);
  s.padRoll = false;
  s.padRollBeats = 0.0;
  s.padRollMix = 1.0;
  s.syncBase = kNaN;
  s.syncRef = kNaN;
  s.syncWant = kNaN;
  s.pllCorr = 0;
  s.syncPhaseOff = 0;
  s.phaseFree = false;
  s.ratioCal = false;
  s.measActive = false;
  s.ratioPasses = 0;
  s.ratioTries = 0;
  s.errFilt = 0;
  s.servoEngaged = false;
  s.integ = 0;
}

void SyncEngine::onTempoCommand(int d) noexcept { impl_->followMaster(d); }

void SyncEngine::resetToDefaults() noexcept { impl_->reset(); }

void SyncEngine::setNativePrecision(bool on) noexcept { impl_->precision = on; }
bool SyncEngine::nativePrecision() const noexcept { return impl_->precision; }

// ---- per block ------------------------------------------------------------------------------
void SyncEngine::tick(const BlockClock& clk, const MixView& mix, const FxRackView& fx) noexcept {
  Impl& im = *impl_;
  im.clk = clk;
  im.mix = mix;
  im.fx = fx;
  im.blockNow = clk.sampleTime;
  if (clk.frames != im.keepFrames || clk.sampleRate != im.keepRate) {
    im.keepFrames = clk.frames;
    im.keepRate = clk.sampleRate;
    const double blockSec = (clk.frames > 0 && clk.sampleRate > 0) ? clk.frames / clk.sampleRate : 0.0;
    im.keep = std::pow(kErrKeepPerCall, blockSec * kCallsPerSec);
  }
  im.driveRolls();                       // engine.js fxTick (ROLL part)
  im.updateAutoMaster(clk.sampleTime);   // engine.js _updateAutoMaster
  im.servicePending(clk.sampleTime);     // (native precision only: nothing pending otherwise)
  if (!im.jogHold) im.lock(clk.sampleTime);
  im.computeClocks();                    // app.js beat clocks, after the lock
  // commands applied before the next tick act at the start of the next block
  im.blockNow = clk.sampleTime + ((clk.frames > 0 && clk.sampleRate > 0) ? clk.frames / clk.sampleRate : 0.0);
}

// ---- outputs --------------------------------------------------------------------------------
int SyncEngine::masterIdx() const noexcept { return impl_->masterIdx; }
int SyncEngine::autoMasterIdx() const noexcept { return impl_->autoMasterIdx; }
int SyncEngine::effectiveMaster() const noexcept { return impl_->effectiveMaster(); }
int SyncEngine::masterDeckFor(int excludeIdx) const noexcept { return impl_->getMasterDeck(excludeIdx); }
int SyncEngine::fxRefDeck(int unit) const noexcept { return impl_->fxRefDeck(unit); }
bool SyncEngine::synced(int d) const noexcept { return d >= 0 && d < kNumDecks && impl_->ds[d].synced; }

BeatClock SyncEngine::panelBeatClock(int unit) const noexcept {
  return (unit >= 0 && unit < kNumFxUnits) ? impl_->panel[unit] : fallbackClock(kBeatDurFallback);
}
BeatClock SyncEngine::padBeatClock(int deck) const noexcept {
  return (deck >= 0 && deck < kNumDecks) ? impl_->pad[deck] : fallbackClock(kBeatDurFallback);
}
BeatClock SyncEngine::masterBeatClock() const noexcept { return impl_->master; }
BeatClock SyncEngine::deckBeatClock(int deck) const noexcept {
  return (deck >= 0 && deck < kNumDecks) ? impl_->ds[deck].clock : fallbackClock(kBeatDurFallback);
}

EngineTime SyncEngine::nextBoundaryAt(int deck, double periodBeats) const noexcept {
  return impl_->nextBoundaryAt(deck, periodBeats);
}

SyncDeckDiag SyncEngine::diag(int deck) const noexcept {
  SyncDeckDiag g;
  if (deck < 0 || deck >= kNumDecks) return g;
  const DeckSync& s = impl_->ds[deck];
  g.syncWant = s.syncWant;
  g.lastWant = s.lastWant;
  g.phaseOffset = s.syncPhaseOff;
  g.errFilt = s.errFilt;
  g.lastErr = s.lastErr;
  g.measuring = s.measActive;
  g.measStart = s.measActive ? s.meas.t : kNaN;
  g.measServoFile = s.measActive ? s.meas.servoFile : 0.0;
  g.ratioPasses = s.ratioPasses;
  g.ratioTries = s.ratioTries;
  g.phaseFree = s.phaseFree;
  g.padRoll = s.padRoll;
  g.padRollBeats = s.padRollBeats;
  g.padRollMix = s.padRollMix;
  g.integ = s.integ;
  return g;
}

void SyncEngine::snapshot(om_sync_state& s) const noexcept {
  const Impl& im = *impl_;
  s = om_sync_state();
  s.master_idx = im.masterIdx;
  s.auto_master_idx = im.autoMasterIdx;
  s.jog_hold = im.jogHold ? 1 : 0;
  for (int d = 0; d < kNumDecks; d++) {
    const DeckSync& x = im.ds[d];
    s.synced[d] = x.synced ? 1 : 0;
    s.calibrated[d] = x.ratioCal ? 1 : 0;
    s.sync_base[d] = x.syncBase;
    s.sync_ref[d] = x.syncRef;
    s.pll_corr[d] = x.pllCorr;
    s.beat_dur[d] = x.beatDur;
  }
}

}  // namespace om
