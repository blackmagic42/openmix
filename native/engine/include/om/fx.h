// Beat FX unit of the native engine (owner: fx): port of engine.js FxUnit —
// 18 effect types, one active at a time, LEVEL (wet gain + intensity inside
// the effect), beat fraction (1/4 .. 32 beats) following the reference deck's
// tempo, modulations phase-locked to the beat grid (replaces alignTo /
// fxTick re-alignment). Used for the 4 panel units, the 4 pad units and the
// master FX. SPEC.md §10.
//
// Threading: prepare() on the control thread (allocates the delay pool and
// the reverb); everything else on the audio thread (RT-safe).
#pragma once

#include <memory>

#include "om/common.h"

namespace om {

class FxUnit {
 public:
  FxUnit();
  ~FxUnit();
  FxUnit(const FxUnit&) = delete;
  FxUnit& operator=(const FxUnit&) = delete;

  void prepare(double sampleRate, int maxBlockFrames);  // control thread

  // ---- parameters (audio thread) ----------------------------------------------
  void setType(FxType t) noexcept;       // engine.js setType (tails of the old type are cut, like _route)
  void setEnabled(bool on) noexcept;     // engine.js setEnabled (disabled = no output at all)
  void setLevel(float v) noexcept;       // 0..1 (wet tau 20 ms, feedbacks and depths tau 50 ms)
  void setBeatsMult(float m) noexcept;   // beat fraction
  void setBeatClock(const BeatClock& bc) noexcept;  // every block, from the sync engine
  void reset() noexcept;                 // clears delay lines / reverb state

  FxType type() const noexcept;
  bool enabled() const noexcept;
  float level() const noexcept;
  float beatsMult() const noexcept;
  float wetGain() const noexcept;           // current smoothed wet gain (engine.js u.wet.gain.value)
  double modPeriodBeats() const noexcept;   // engine.js modPeriodBeats (0 = no modulation)
  double delayTimeSec() const noexcept;     // current (smoothed) delay time, for tests

  // Processes the unit's send bus and writes its WET output (wet gain
  // applied). Silence when disabled or for "roll" (the deck plays the roll).
  void process(const float* inL, const float* inR, float* outL, float* outR, int n) noexcept;

 private:
  struct Impl;  // layout belongs to the fx owner
  std::unique_ptr<Impl> impl_;
};

}  // namespace om
