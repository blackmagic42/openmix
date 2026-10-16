// Fractional-position reader over an int16 TrackBuffer for varispeed,
// scratch and spin playback (owner: deck). Quality modes: linear (tests),
// 4-point Hermite, 16-tap polyphase windowed sinc whose cutoff follows the
// playback rate (anti-aliasing when reading faster than 1x). SPEC.md §8.2.
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
  // playback speed |rate| (for the anti-aliasing cutoff). Outside the buffer = 0.
  void read(const TrackBuffer& tb, double pos, double rate, float& l, float& r) const noexcept;

  // n frames at positions pos0 + i * inc (inc may be negative: backspin).
  // Exact sample copy when inc == 1 and pos0 is an integer.
  void readBlock(const TrackBuffer& tb, double pos0, double inc, int n, float* l, float* r) const noexcept;

 private:
  InterpQuality quality_ = InterpQuality::Sinc16;
};

}  // namespace om
