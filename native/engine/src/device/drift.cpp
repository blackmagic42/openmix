// Drift correction of the headphones path (owner: device): the PI
// controller on the ring fill and the 4-point cubic reader that resamples
// the cue bus from the main card's clock to the second card's clock.
// RT-safe, portable. SPEC.md §8.7.
#include "drift.h"

#include <cmath>

namespace om {
namespace dev {

void DriftController::reset(double nominal, double targetFill, double inputRate) noexcept {
  nominal_ = nominal > 0 ? nominal : 1.0;
  target_ = targetFill;
  inRate_ = inputRate > 0 ? inputRate : 48000.0;
  fs_ = targetFill;
  integ_ = 0;
  corr_ = 0;
  init_ = false;
}

double DriftController::update(double fill, double dtSec) noexcept {
  if (!init_) {
    fs_ = fill;
    init_ = true;
  }
  if (dtSec > 0) {
    const double a = 1.0 - std::exp(-dtSec / kFillTauSec);
    fs_ += a * (fill - fs_);
  }
  const double e = (fs_ - target_) / inRate_;  // seconds of excess audio in the ring
  integ_ += kKi * e * (dtSec > 0 ? dtSec : 0.0);
  if (integ_ > kMaxCorrection) integ_ = kMaxCorrection;
  if (integ_ < -kMaxCorrection) integ_ = -kMaxCorrection;
  double c = kKp * e + integ_;
  if (c > kMaxCorrection) c = kMaxCorrection;
  if (c < -kMaxCorrection) c = -kMaxCorrection;
  corr_ = c;
  return ratio();
}

double CubicReader::fill(const StereoRing& ring) const noexcept {
  const double ahead = static_cast<double>(ring.available()) - 1.0 - frac_;
  return ahead > 0 ? ahead : 0.0;
}

bool CubicReader::read(StereoRing& ring, double ratio, float* out, int n, int channels, int chL, int chR) noexcept {
  if (n <= 0) return true;
  const uint64_t base = ring.readIndex();
  const double last = frac_ + (n - 1) * ratio;
  const uint64_t needed = static_cast<uint64_t>(std::floor(last)) + 4;  // x[-1] .. x[2] of the last output
  if (ring.available() < needed) return false;
  double pos = frac_;
  for (int i = 0; i < n; i++) {
    const double k = std::floor(pos);
    const float t = static_cast<float>(pos - k);
    const uint64_t i0 = base + static_cast<uint64_t>(k);
    const float* xm1 = ring.frame(i0);
    const float* x0 = ring.frame(i0 + 1);
    const float* x1 = ring.frame(i0 + 2);
    const float* x2 = ring.frame(i0 + 3);
    float y[2];
    for (int c = 0; c < 2; c++) {
      const float c1 = 0.5f * (x1[c] - xm1[c]);
      const float c2 = xm1[c] - 2.5f * x0[c] + 2.0f * x1[c] - 0.5f * x2[c];
      const float c3 = 0.5f * (x2[c] - xm1[c]) + 1.5f * (x0[c] - x1[c]);
      y[c] = ((c3 * t + c2) * t + c1) * t + x0[c];
    }
    float* o = out + static_cast<size_t>(i) * channels;
    if (chL >= 0 && chL < channels) o[chL] = y[0];
    if (chR >= 0 && chR < channels) o[chR] = y[1];
    pos += ratio;
  }
  const double adv = std::floor(pos);
  ring.consumeTo(base + static_cast<uint64_t>(adv));
  frac_ = pos - adv;
  return true;
}

void CubicReader::skipTo(StereoRing& ring, double targetFill) noexcept {
  const uint64_t w = ring.writeIndex();
  const uint64_t keep = static_cast<uint64_t>(targetFill > 0 ? targetFill : 0) + 1;  // + the history frame
  if (w > ring.readIndex() + keep) ring.consumeTo(w - keep);
  frac_ = 0;
}

void CubicReader::drop(StereoRing& ring, uint64_t frames) noexcept {
  const uint64_t r = ring.readIndex();
  const uint64_t w = ring.writeIndex();
  const uint64_t to = r + frames;
  ring.consumeTo(to <= w ? to : w);
}

double continuousFill(const StereoRing& ring, const CubicReader& rd, const PushStamp& stamp, double now,
                      double producerRate) noexcept {
  uint64_t w = 0;
  int n = 0;
  double t = 0;
  if (!stamp.read(w, n, t) || n <= 0 || producerRate <= 0) return rd.fill(ring);
  // The stamp may be one push behind the ring (pushed, not stamped yet):
  // measure against the stamped write index, consistently.
  double elapsed = (now - t) * producerRate;
  if (elapsed < -n) elapsed = -n;
  if (elapsed > 3.0 * n) elapsed = 3.0 * n;  // a stalled producer
  const double ahead = static_cast<double>(w) - rd.position(ring) - n + elapsed;
  return ahead > 0 ? ahead : 0.0;
}

}  // namespace dev
}  // namespace om
