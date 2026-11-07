// Private header of the fx module (owner: fx): the memory of one effect chain
// (stereo delay lines + loop filter state + the engine.js AudioParams of the
// chain, or a reverb's convolver state), shared by FxUnit and ColorFx. Lazy
// chains are created zeroed on the control thread (FxUnit::makeChain /
// ColorFx::makeChain), owned by their unit once attached on the audio thread,
// and freed with the unit (control thread); the FX unit's always-present echo
// chain is one too (made by prepare()). SPEC.md §11.5.
#pragma once

#include <cstddef>
#include <cstdint>
#include <memory>
#include <vector>

#include "fx_dsp.h"
#include "om/convolver.h"
#include "om/dsp.h"

namespace om {

class FxChain {
 public:
  uint8_t type = 0;       // FxType (FxUnit) or ColorType (ColorFx)
  bool color = false;     // made by ColorFx
  double sampleRate = 0;  // the rate the memory was made for
  // Delay lines (zeroed), views into `mem`.
  std::vector<float> mem;
  fx::Lines lines;
  // engine.js AudioParams of the chain: set when the chain is first routed
  // ("born", engine.js builds the nodes at that moment with _timeNow() and
  // _fbFor()), then driven by _applyTime / setLevel like the Web engine.
  bool born = false;
  fx::Param delay;   // DelayNode.delayTime of every line of the chain (s)
  fx::Param fb;      // feedback GainNode.gain
  double fbBase = 0;  // engine.js fbBase
  // Loop filter (BiquadFilterNode) or none, and the WaveShaper of crushecho.
  bool hasFilter = false;
  dsp::BiquadCoeffs filterCoeffs;
  fx::BiquadState filter[2];
  std::vector<float> curve;  // crushecho: crushCurve(6)
  // Reverb chains.
  std::unique_ptr<Convolver> reverb;

  size_t bytes() const noexcept {
    return sizeof(FxChain) + mem.capacity() * sizeof(float) + curve.capacity() * sizeof(float) +
           (reverb ? reverb->memoryBytes() + sizeof(Convolver) : 0);
  }
  // Makes `count` stereo lines of `frames` frames (zeroed), read like
  // Chromium DelayNodes of `chromiumLength` frames (fx_dsp.h).
  void allocLines(int count, int frames, int chromiumLength) {
    mem.assign(static_cast<size_t>(count) * 2 * static_cast<size_t>(frames), 0.0f);
    lines.mem = mem.data();
    lines.len = frames;
    lines.count = count;
    lines.w = 0;
    lines.vlen = chromiumLength;
    lines.vw = 0;
    lines.valid = frames;  // fresh zeros are valid history
  }
  // O(1) clear of the history (audio thread).
  void clear() noexcept {
    lines.valid = 0;
    filter[0].reset();
    filter[1].reset();
    if (reverb) reverb->reset();
  }
};

}  // namespace om
