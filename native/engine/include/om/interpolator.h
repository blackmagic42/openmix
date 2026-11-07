// Fractional-position reader over a TrackBuffer for the scratch and spin
// voices (owner: deck). The default is LINEAR interpolation computed like
// Chromium's AudioBufferSourceNode, (1 - f) * s[i] + f * s[i+1] in double
// (so the native engine sounds like the Web engine, SPEC.md §9.2); the
// higher qualities exist for a later blind A/B and are never the default
// before it: 4-point Hermite, 16-tap polyphase windowed sinc whose cutoff
// follows the playback rate (anti-aliasing when reading faster than 1x).
// The deck's main and roll read pointers use the private Chromium port of
// RenderFromBuffer (src/deck/deck_internal.h: accumulated position, loop
// seams, end-of-buffer extrapolation), bit-exact against Chromium's renders.
#pragma once

#include <cstdint>

#include "om/media.h"

namespace om {

enum class InterpQuality : uint8_t { Linear = 0, Hermite4 = 1, Sinc16 = 2 };

class Interpolator {
 public:
  Interpolator();
  void setQuality(InterpQuality q) noexcept { quality_ = q; }
  InterpQuality quality() const noexcept { return quality_; }

  // One stereo frame at fractional frame position `pos` of `tb`, read at
  // playback speed |rate| (for the anti-aliasing cutoff). Outside the buffer,
  // or in a chunk not received yet, the missing frames count as 0.
  void read(const TrackBuffer& tb, double pos, double rate, float& l, float& r) const noexcept;

  // n frames at positions pos0 + i * inc (inc may be negative: scratch,
  // backspin). Exact sample copy when inc == 1 and pos0 is an integer.
  void readBlock(const TrackBuffer& tb, double pos0, double inc, int n, float* l, float* r) const noexcept;

 private:
  InterpQuality quality_ = InterpQuality::Linear;
};

}  // namespace om
