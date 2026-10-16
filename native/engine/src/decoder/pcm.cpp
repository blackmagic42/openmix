// PCM helpers of the decoder: float -> int16 TrackBuffer (TPDF dither,
// headroom gain), timeline alignment by cross-correlation (port of app.js
// alignStems), timeline shifting (owner: decoder). SKELETON. SPEC.md §7.4-7.6.
#include "om/decoder.h"

namespace om {

std::unique_ptr<TrackBuffer> toTrackBuffer(const float*, int64_t, int) { return nullptr; }

int64_t findLagFrames(const float*, int64_t, const float*, int64_t, int64_t, int64_t, double* score) {
  if (score) *score = 0.0;
  return 0;
}

void shiftFrames(TrackBuffer&, int64_t) {}

}  // namespace om
