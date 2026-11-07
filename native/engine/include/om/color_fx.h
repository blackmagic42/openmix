// Color FX bus of the channel FILTER knobs (owner: fx): port of engine.js
// _colorDefs (Dub / HPF / LPF / BPF / Crush echo loops with FIXED delay
// times and feedbacks), cReverb ("Space": 2.8 s impulse, decay 2.2) and
// cCrush (crushCurve(5)). "filter" and "noise" have no bus processing (the
// deck biquad and the per-deck noise gain live in the mixer). Implements
// IColorProcessor (common.h). Like engine.js, the echo chains and the reverb
// are built lazily: makeChain() on the control thread, attachChain() on the
// audio thread (AttachColorChain); silence for a type until its chain is
// attached. The echo lines never need more than 0.5 s. Like the FX units'
// echoes, the color echoes are drift-free (each repeat k * time after the
// input, within a sample; Chromium adds 128 frames per trip, SPEC.md §20),
// and a chain that is not routed is frozen. SPEC.md §11.4, §11.5.
#pragma once

#include <cstddef>
#include <memory>

#include "om/common.h"
#include "om/convolver.h"
#include "om/fx.h"

namespace om {

class ColorFx final : public IColorProcessor {
 public:
  ColorFx();
  ~ColorFx() override;  // frees the attached chains (control thread)
  ColorFx(const ColorFx&) = delete;
  ColorFx& operator=(const ColorFx&) = delete;

  // ---- control thread ----
  // `reverbKernel`: the shared 2.8 s "Space" impulse (makeImpulse(2.8, 2.2)).
  // Re-prepares the attached chains for the new rate (zeroed).
  void prepare(double sampleRate, int maxBlockFrames, std::shared_ptr<const ConvolverKernel> reverbKernel);
  static bool isLazy(ColorType t) noexcept;   // dubecho, hpfecho, lpfecho, bpfecho, crushecho, reverb
  FxChainPtr makeChain(ColorType t) const;    // zeroed memory (nullptr when not lazy / OOM)
  size_t memoryBytes() const noexcept;        // the bus and its attached chains (shared kernel excluded)

  // ---- audio thread ----
  // Same contract as FxUnit::attachChain (returns the chain when refused).
  FxChain* attachChain(ColorType t, FxChain* chain) noexcept;
  bool hasChain(ColorType t) const noexcept;
  // engine.js _routeColor (switching cuts the old chain's output; chains
  // keep their frozen state like the Web engine's lazily built ones).
  void setType(ColorType t) noexcept override;
  ColorType type() const noexcept;
  void reset() noexcept;  // O(1): forgets every line / reverb history
  // Processes the color bus (sum of the decks' color sends) and writes the
  // wet signal BEFORE the 0.85 colorWet gain (applied by the mixer).
  // In-place (in == out) allowed.
  void process(const float* inL, const float* inR, float* outL, float* outR, int n) noexcept override;

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

}  // namespace om
