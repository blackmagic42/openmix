// Color FX bus of the channel FILTER knobs (owner: fx): port of engine.js
// _colorDefs (Dub / HPF / LPF / BPF / Crush echo loops with FIXED delay
// times), cReverb ("Space", 2.8 s impulse) and cCrush (crushCurve(5)).
// "filter" and "noise" have no bus processing (deck biquad / per-deck noise
// gain, both in the mixer). SPEC.md §10.4.
#pragma once

#include <memory>

#include "om/common.h"

namespace om {

class ColorFx {
 public:
  ColorFx();
  ~ColorFx();
  ColorFx(const ColorFx&) = delete;
  ColorFx& operator=(const ColorFx&) = delete;

  void prepare(double sampleRate, int maxBlockFrames);  // control thread
  void setType(ColorType t) noexcept;                   // audio thread (switching cuts the old tail)
  ColorType type() const noexcept;
  void reset() noexcept;
  // Processes the color bus (sum of the decks' color sends) and writes the
  // wet signal BEFORE the 0.85 colorWet gain (applied by the mixer).
  void process(const float* inL, const float* inR, float* outL, float* outR, int n) noexcept;

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

}  // namespace om
