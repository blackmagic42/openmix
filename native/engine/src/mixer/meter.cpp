// Peak / RMS meter with a sliding hold window (owner: mixer).
// SKELETON: reports silence. SPEC.md §9.7.
#include "om/meter.h"

namespace om {

void MeterWindow::prepare(double, double, int) noexcept { reset(); }

void MeterWindow::reset() noexcept {
  for (int i = 0; i < kMaxSlots; i++) {
    peaks_[i] = 0;
    sumSq_[i] = 0;
    counts_[i] = 0;
  }
  head_ = 0;
  inSlot_ = 0;
}

void MeterWindow::process(const float*, const float*, int) noexcept {}
float MeterWindow::peak() const noexcept { return 0.0f; }
float MeterWindow::rms() const noexcept { return 0.0f; }

}  // namespace om
