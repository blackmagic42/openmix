// Peak / RMS meter with a sliding hold window (owner: mixer): a ring of
// per-slot maxima and sums of squares. The window always covers at least
// windowSec of the most recent audio (slots = ceil(window / slot) + 1, the
// newest one partly filled), so a reader polling every <= windowSec sees
// every peak. The peak is taken on the mono fold 0.5 x (L + R), like
// engine.js's AnalyserNode meters; the RMS stays per channel. Real-time safe
// (no allocation). SPEC.md §10.8.
#include "om/meter.h"

#include <cmath>

namespace om {

void MeterWindow::prepare(double sampleRate, double windowSec, int slotFrames) noexcept {
  framesPerSlot_ = slotFrames > 0 ? slotFrames : 128;
  const double slotSec = sampleRate > 0 ? static_cast<double>(framesPerSlot_) / sampleRate : 0.0;
  int slots = slotSec > 0 ? static_cast<int>(std::ceil(windowSec / slotSec)) + 1 : 2;
  if (slots < 2) slots = 2;
  if (slots > kMaxSlots) slots = kMaxSlots;
  slots_ = slots;
  reset();
}

void MeterWindow::reset() noexcept {
  for (int i = 0; i < kMaxSlots; i++) {
    peaks_[i] = 0;
    sumSq_[i] = 0;
    counts_[i] = 0;
  }
  head_ = 0;
  inSlot_ = 0;
}

void MeterWindow::process(const float* l, const float* r, int n) noexcept {
  int i = 0;
  while (i < n) {
    int take = static_cast<int>(framesPerSlot_ - inSlot_);
    if (take > n - i) take = n - i;
    // four independent accumulators (no long dependency chain); a slot holds
    // at most a few hundred frames, so float sums are exact enough for RMS
    float p0 = peaks_[head_], p1 = 0.0f;
    float s0 = 0.0f, s1 = 0.0f, s2 = 0.0f, s3 = 0.0f;
    const int end = i + take;
    int k = i;
    for (; k + 2 <= end; k += 2) {
      // the peak of the "speakers" mono fold 0.5 x (L + R): engine.js's
      // AnalyserNodes have no splitter, so Chromium's RealtimeAnalyser
      // down-mixes stereo to mono before getFloatTimeDomainData
      const float m0 = std::fabs(0.5f * (l[k] + r[k])), m1 = std::fabs(0.5f * (l[k + 1] + r[k + 1]));
      if (m0 > p0) p0 = m0;
      if (m1 > p1) p1 = m1;
      s0 += l[k] * l[k];
      s1 += r[k] * r[k];
      s2 += l[k + 1] * l[k + 1];
      s3 += r[k + 1] * r[k + 1];
    }
    if (k < end) {
      const float m = std::fabs(0.5f * (l[k] + r[k]));
      if (m > p0) p0 = m;
      s0 += l[k] * l[k];
      s1 += r[k] * r[k];
    }
    peaks_[head_] = p0 > p1 ? p0 : p1;
    sumSq_[head_] += static_cast<double>(s0) + s1 + s2 + s3;
    counts_[head_] += 2 * static_cast<int64_t>(take);
    inSlot_ += take;
    i += take;
    if (inSlot_ >= framesPerSlot_) {
      head_ = (head_ + 1) % slots_;
      peaks_[head_] = 0;
      sumSq_[head_] = 0;
      counts_[head_] = 0;
      inSlot_ = 0;
    }
  }
}

float MeterWindow::peak() const noexcept {
  float pk = 0;
  for (int s = 0; s < slots_; s++)
    if (peaks_[s] > pk) pk = peaks_[s];
  return pk;
}

float MeterWindow::rms() const noexcept {
  double ss = 0;
  int64_t n = 0;
  for (int s = 0; s < slots_; s++) {
    ss += sumSq_[s];
    n += counts_[s];
  }
  return n > 0 ? static_cast<float>(std::sqrt(ss / static_cast<double>(n))) : 0.0f;
}

}  // namespace om
