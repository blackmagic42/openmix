// What the sync engine needs from a deck: implemented by om::Deck, faked by
// the sync tests so that sync can be developed and tested without the real
// deck (parallel work).
//
// FROZEN FOUNDATION (maintainer: host). Every method is called on the audio
// thread, between two renders, and must be real-time safe. Positions are
// HEARD positions in track seconds at the current block's presentTime (see
// SPEC.md §4.3): what the listener hears when that block reaches the DAC.
#pragma once

#include "om/common.h"
#include "om/media.h"

namespace om {

class IDeckControl {
 public:
  virtual ~IDeckControl() = default;

  virtual bool loaded() const noexcept = 0;             // a track buffer is attached
  virtual bool playing() const noexcept = 0;            // engine.js Deck.playing
  virtual double duration() const noexcept = 0;         // track seconds
  virtual double heardPosition() const noexcept = 0;    // engine.js Deck.currentTime()
  // False while the heard position is not advancing linearly with the tempo
  // (WSOLA priming after play, scratch, spin, transient after a seek): the
  // sync calibration must not measure then (engine.js "nowC >= d.startCtx").
  virtual bool transportSettled() const noexcept = 0;
  virtual double tempo() const noexcept = 0;            // playback ratio (engine.js Deck.tempo)
  virtual void setTempo(double r) noexcept = 0;         // clamped to [kTempoMin, kTempoMax]
  // Makes the heard position at this block's presentTime exactly t (engine.js
  // Deck.seek(t) as used by sync(): no extra latency compensation needed).
  virtual void seekHeard(double t) noexcept = 0;
  // Sound goes through the WSOLA transposer (keylock or key != 0): the sync
  // servo may correct it ~10x harder (engine.js syncLock "strong").
  virtual bool routedThroughWsola() const noexcept = 0;
  virtual const BeatGrid* grid() const noexcept = 0;    // nullptr = no grid attached
  // Engine time of the last NATURAL end of track (engine.js _endedAt), NaN if none.
  virtual EngineTime endedAt() const noexcept = 0;

  // ROLL (engine.js startRoll / setRollMix / stopRoll), driven by sync's fxTick port.
  virtual bool startRoll(double beats, double mix) noexcept = 0;
  virtual void setRollMix(double mix) noexcept = 0;
  virtual void stopRoll(bool immediate) noexcept = 0;
  virtual bool rolling(double* beats) const noexcept = 0;  // beats of the active roll (if any)
};

}  // namespace om
