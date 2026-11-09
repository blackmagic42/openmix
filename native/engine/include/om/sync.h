// Tempo / phase lock and master election of the native engine, run on the
// audio thread every block on exact heard positions (owner: sync). Verbatim
// port, constants included, of engine.js: sync(), syncLock() (dry-cut part
// excepted: the mixer does it), _updateAutoMaster(), _pickBassDeck(),
// getMasterDeck(), _syncRatio(), _localPeriod(), _beatPhase(), _barPhase(),
// _period(), reanchorSync(), snapToRef(), _followMaster(), fxRefDeck(),
// nextBoundaryAt() and fxTick() (ROLL driving), plus app.js beatOf() for the
// FX beat clocks and the per-deck beat clocks of the VST transport.
// SPEC.md §12.
//
// Time base: engine.js mixed performance.now() (grace periods, _endedAt)
// and ctx.currentTime (calibration, deliberately the audio clock); here
// EVERY duration uses the sample clock (BlockClock::sampleTime, SPEC.md
// §4.1) and positions are heard positions at the block's presentTime. The
// only call-rate-dependent constant of syncLock — the 0.85 / 0.15 error
// low-pass tuned for 60 calls per second — is converted per block:
// keep = 0.85^(blockSeconds * 60). Every other threshold is a duration or a
// ratio and is kept verbatim.
//
// engine.js Deck.setTempo() calls _followMaster(deck) every time (the
// _onTempo hook); the port does the same for every tempo it sets, and the
// core calls onTempoCommand() after a UI tempo command.
//
// Beat clocks (BeatClock, common.h), computed at the end of tick() from the
// tempi the lock has just set:
//  - valid: the reference deck has a BPM (beatDur comes from it);
//  - playing: the reference deck plays (engine.js Deck.playing);
//  - beatDur: app.js beatOf() = localPeriod / (tempo / (1 + pllCorr)) in
//    real seconds; fallbacks as app.js (the master's, then 0.5 s);
//  - beatPos: fractional beat index of the reference deck's heard position at
//    the block's presentTime, relative to the bar anchor (bars start at
//    multiples of 4; fixed grid: from beatOffset; BPM without any grid
//    position: from 0, like engine.js startRoll); 0 without a reference;
//  - beatsPerSec: d(beatPos)/dt in real time = tempo / length of the current
//    beat (servo correction included) while the reference plays, else 0;
//  - baseTempo: the reference deck's tempo / (1 + pllCorr).
//
// The JS proxy mirrors the same decisions (sync() result, getMasterDeck...)
// for app.js's synchronous calls; the engine is authoritative.
//
// Threading: attachDecks() at setup; everything else on the audio thread,
// real-time safe (no allocation, no free, no lock, no I/O, noexcept).
#pragma once

#include <memory>

#include "om/common.h"
#include "om/deck_control.h"
#include "om/om_state.h"

namespace om {

// Fields of a "sync.base" command (engine.js writes to _syncBase, _syncRef, _pllCorr).
struct SyncBaseWrite {
  enum : uint8_t { kBase = 1, kRef = 2, kPllCorr = 4 };
  uint8_t mask = 0;
  double base = kNaN;    // NaN = null
  double ref = kNaN;     // NaN = null
  double pllCorr = 0.0;
};

// Internal lock state of one deck (engine.js private Deck fields), for tests
// and diagnostics. Not part of the protocol.
struct SyncDeckDiag {
  double syncWant = kNaN;      // engine.js _syncWant (NaN = null)
  double lastWant = kNaN;      // engine.js _lastWant (NaN = null)
  double phaseOffset = kNaN;   // engine.js _syncPhaseOff in beats (NaN = null: re-anchored at the next block)
  double errFilt = 0.0;        // engine.js _errFilt: low-passed phase error (beats)
  double lastErr = kNaN;       // phase error (beats, offset removed) the lock measured in the last tick, NaN = not measured
  bool measuring = false;      // a calibration window is open (engine.js _ratioMeas != null)
  SampleTime measStart = kNaN; // its start on the sample clock (_ratioMeas.t)
  double measServoFile = 0.0;  // track seconds the servo added since (_ratioMeas.servoFile)
  int ratioPasses = 0;         // engine.js _ratioPasses
  int ratioTries = 0;          // engine.js _ratioTries
  bool phaseFree = false;      // engine.js _phaseFree (kept for parity, not used by the lock)
  bool padRoll = false;        // engine.js _padRoll != null
  double padRollBeats = 0.0;
  double padRollMix = 0.0;
  double integ = 0.0;          // native precision: integral part of pllCorr (0 in engine.js parity)
};

class SyncEngine {
 public:
  SyncEngine();
  ~SyncEngine();
  SyncEngine(const SyncEngine&) = delete;
  SyncEngine& operator=(const SyncEngine&) = delete;

  // Setup: the decks to drive (real om::Deck, or fakes in the tests).
  void attachDecks(IDeckControl* const decks[kNumDecks]) noexcept;

  // ---- commands (audio thread) ----------------------------------------------
  void setManualMaster(int idx) noexcept;   // engine.js masterIdx = idx (-1 = null / automatic)
  void setJogHold(bool on) noexcept;        // engine.js jogHold
  void setSynced(int d, bool on) noexcept;  // deck.synced = on
  void writeSyncBase(int d, const SyncBaseWrite& w) noexcept;
  bool sync(int d, const BlockClock& clk) noexcept;     // engine.js sync(i)
  void reanchor(int d) noexcept;                        // engine.js reanchorSync(i)
  bool snapToRef(int d, double maxErr) noexcept;        // engine.js snapToRef(i, maxErr) (NaN = 0.06)
  void setPadRoll(int d, double beats, double mix) noexcept;  // deck._padRoll (beats <= 0 = null)
  void setGlobalGridOffset(double sec) noexcept;
  void onTrackLoaded(int d) noexcept;       // engine.js loadTrack sync resets (SYNC itself stays on)
  // A UI tempo command was applied to deck d: engine.js _onTempo ->
  // _followMaster(d). The engine also calls it internally whenever the
  // servo or a handover changes the master's tempo.
  void onTempoCommand(int d) noexcept;
  void resetToDefaults() noexcept;          // hello {reset}: masterIdx null, jogHold off, every deck unsynced
  // Native precision refinements (ON by default since the owner's decision
  // of 2026-11-09; off = engine.js parity, still available through
  // sync.precision {on:false}; the mode is kept across resetToDefaults).
  // Every engine.js constant is unchanged; when on, these engine.js
  // artifacts are removed:
  //  1. a calibration ends on a "negligible" correction only after a fine
  //     (8 s) pass, never on the 1 s pass alone (engine.js rates that window
  //     +-0.13 BPM: it cannot certify 0.02 %);
  //  2. a coarse (1 s) correction smaller than that window's noise floor
  //     (0.1 %) is not applied: the fine stage refines the ratio instead;
  //  3. the holding servo is proportional + INTEGRAL and always on (same
  //     gains and limits, integral time 30 s, errors > 0.01 beat not
  //     integrated): engine.js's proportional servo holds the ratio residue r
  //     the noise-limited calibration leaves with a constant error r / 0.08,
  //     and its 0.0015-beat dead zone lets the error drift back to its edge,
  //     so the error in ms grew with the beat length (1.2 ms at 75 BPM) and
  //     the grid noise. The integral part lives in pllCorr only: the base,
  //     hence the BPM shown, does not move. It restarts from 0 whenever the
  //     base is re-aimed (SYNC, calibration pass, repair, track load, UI write)
  //     and is kept across a phase-offset adoption or a re-anchor;
  //  4. a master change never scales the followers through the new master's
  //     own setTempo (engine.js _onTempo ordering: the followers handed over
  //     after it moved by want(new) / want(old), i.e. the BPM-field rounding);
  //  5. a follower plays a follow-master change when the master's change is
  //     HEARD (a master through the WSOLA transposer hears its tempo 2647
  //     frames later; engine.js left a phase error of tempo step x 55 ms);
  //  6. at a master change, a SYNC deck without a base yet (typically the deck
  //     that was master since it started) is handed over from its current
  //     speed like the others (engine.js skips it, then its repair re-aims it
  //     at the BPM-field ratio: a jump of the BPM rounding, ~0.05 %, and a
  //     whole recalibration);
  //  7. at a master change, the speed kept includes the residue the integral
  //     part had learned; only the momentary proportional part is dropped.
  // Measured on the 10-minute replay (tests/sync/test_sync_replay.cpp, 100
  // seeds) and end to end on the real engine (rendered click tracks): see
  // HANDOFF/refs/native/verify-reports/sync-phase.json.
  // SPEC.md §12 (acceptance, precision mode), §20, Appendix E.9 (the
  // owner's decision of 2026-11-09: precision by default).
  void setNativePrecision(bool on) noexcept;
  bool nativePrecision() const noexcept;

  // ---- per block (audio thread), BEFORE the decks render ---------------------
  // Auto-master, master handover, SYNC deck stopped follows the master BPM,
  // self-repair, flash calibration, holding servo (unless jogHold), ROLL
  // driving, and the beat clocks of every FX unit and deck. Durations on
  // clk.sampleTime.
  void tick(const BlockClock& clk, const MixView& mix, const FxRackView& fx) noexcept;

  // ---- outputs ---------------------------------------------------------------------
  int masterIdx() const noexcept;
  int autoMasterIdx() const noexcept;
  int effectiveMaster() const noexcept;               // masterIdx if set, else autoMasterIdx (-1 = none)
  int masterDeckFor(int excludeIdx) const noexcept;   // engine.js getMasterDeck(excl) (-1 = null)
  // engine.js fxRefDeck(u) on the LIVE assign matrix of the last tick: the
  // first assigned deck that plays with a BPM, else getMasterDeck(-1).
  int fxRefDeck(int unit) const noexcept;
  bool synced(int d) const noexcept;
  BeatClock panelBeatClock(int unit) const noexcept;  // engine.js fxRefDeck(u) + app.js beatOf()
  BeatClock padBeatClock(int deck) const noexcept;    // pad units follow their own deck, else the master
  BeatClock masterBeatClock() const noexcept;         // master FX follows getMasterDeck(-1)
  // Deck d's own beat clock at the block's presentTime (playing, beatDur,
  // beatPos, beatsPerSec, baseTempo = tempo / (1 + pllCorr)): the VST
  // transport of its insert (SPEC.md §13.3).
  BeatClock deckBeatClock(int deck) const noexcept;
  // engine.js nextBoundaryAt(d, periodBeats): ENGINE time (presentTime base of
  // the last tick) at which deck d's next multiple of periodBeats is heard
  // (locked to the bar when periodBeats >= 1); NaN = null.
  EngineTime nextBoundaryAt(int deck, double periodBeats) const noexcept;
  SyncDeckDiag diag(int deck) const noexcept;
  void snapshot(om_sync_state& s) const noexcept;

 private:
  struct Impl;  // layout belongs to the sync owner
  std::unique_ptr<Impl> impl_;
};

}  // namespace om
