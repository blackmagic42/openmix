// Fractional-position reading of int16 track buffers: linear, 4-point
// Hermite and 16-tap polyphase windowed sinc with a rate-dependent cutoff
// (owner: deck). SKELETON: linear interpolation only. SPEC.md §8.2.
#include <cmath>

#include "om/interpolator.h"

namespace om {

Interpolator::Interpolator() = default;

void Interpolator::read(const TrackBuffer& tb, double pos, double, float& l, float& r) const noexcept {
  const double fl = std::floor(pos);
  const int64_t i = static_cast<int64_t>(fl);
  const float f = static_cast<float>(pos - fl);
  l = tb.left(i) + (tb.left(i + 1) - tb.left(i)) * f;
  r = tb.right(i) + (tb.right(i + 1) - tb.right(i)) * f;
}

void Interpolator::readBlock(const TrackBuffer& tb, double pos0, double inc, int n, float* l, float* r) const noexcept {
  for (int k = 0; k < n; k++) read(tb, pos0 + inc * k, inc, l[k], r[k]);
}

}  // namespace om
