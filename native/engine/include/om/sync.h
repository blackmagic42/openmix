// Tempo / phase lock of the native engine, run on the audio thread at block
// rate (owner: sync). Port of engine.js: sync(), syncLock() (handover without
// jumps, self-repair, flash calibration, holding servo), _updateAutoMaster()
// and _pickBassDeck() (automatic master rules), getMasterDeck(),
// reanchorSync(), snapToRef(), _followMaster(), fxRefDeck(), nextBoundaryAt()
// and fxTick() (ROLL driving + per-unit beat clocks for the FX). The engine
// owns this logic; the UI only reads the result in the state snapshots.
// SPEC.md §11.
#pragma once

#include <memory>

#include "om/common.h"
#include "om/deck_control.h"

namespace om {

struct SyncSnapshot {
  int masterIdx = -1;      // engine.js masterIdx (manual MASTER button), -1 = null
  int autoMasterIdx = -1;  // engine.js autoMasterIdx, -1 = null
  bool synced[kNumDecks] = {false, false, false, false};
  double syncBase[kNumDecks] = {kNaN, kNaN, kNaN, kNaN};  // engine.js _syncBase (NaN = null)
  double pllCorr[kNumDecks] = {0, 0, 0, 0};               // engine.js _pllCorr
  bool calibrated[kNumDecks] = {false, false, false, false};  // engine.js _ratioCal
  bool jogHold = false;
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
  // deck._syncBase = base (NaN = null); resetCorr: deck._pllCorr = 0
  void setSyncBase(int d, double base, bool resetCorr) noexcept;
  bool sync(int d) noexcept;                // engine.js sync(i)
  void reanchor(int d) noexcept;            // engine.js reanchorSync(i)
  bool snapToRef(int d, double maxErr) noexcept;  // engine.js snapToRef(i, maxErr)
  void setPadRoll(int d, double beats, double mix) noexcept;  // deck._padRoll (beats <= 0 = none)
  void setGlobalGridOffset(double sec) noexcept;
  void onTrackLoaded(int d) noexcept;       // engine.js loadTrack sync resets (SYNC itself stays on)
  void onTempoCommand(int d) noexcept;      // UI tempo change of deck d: engine.js _onTempo -> _followMaster

  // ---- per block (audio thread), BEFORE the decks render ---------------------
  // Auto-master, master handover, follow-master, self-repair, calibration,
  // servo, ROLL driving, and the beat clocks of every FX unit.
  void tick(const BlockClock& clk, const MixView& mix, const FxRackView& fx) noexcept;

  // ---- outputs ---------------------------------------------------------------------
  int masterIdx() const noexcept;
  int autoMasterIdx() const noexcept;
  int effectiveMaster() const noexcept;     // masterIdx if set, else autoMasterIdx (-1 = none)
  int masterDeckFor(int excludeIdx) const noexcept;  // engine.js getMasterDeck(excl) (-1 = none)
  BeatClock panelBeatClock(int unit) const noexcept;  // engine.js fxRefDeck(u) + beatOf()
  BeatClock padBeatClock(int deck) const noexcept;    // pad units follow their own deck
  BeatClock masterBeatClock() const noexcept;         // master FX follows the master deck
  void snapshot(SyncSnapshot& s) const noexcept;

 private:
  struct Impl;  // layout belongs to the sync owner
  std::unique_ptr<Impl> impl_;
};

}  // namespace om
