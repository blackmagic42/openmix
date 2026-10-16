// Peak / RMS meter with a sliding hold window, so that a reader polling at
// ~60 Hz never misses a peak that happened between two polls (owner: mixer).
// Real-time safe: fixed ring of per-block maxima.
#pragma once

#include <cstdint>

namespace om {

class MeterWindow {
 public:
  static constexpr int kMaxSlots = 64;

  // windowSec: how long a peak stays visible (>= 1 / stateHz); blockFrames:
  // typical block size (the window is a ring of per-block values).
  void prepare(double sampleRate, double windowSec, int blockFrames) noexcept;
  void reset() noexcept;
  void process(const float* l, const float* r, int n) noexcept;  // audio thread
  float peak() const noexcept;  // max |x| over the window (linear)
  float rms() const noexcept;   // RMS over the window (linear)

 private:
  float peaks_[kMaxSlots] = {};
  double sumSq_[kMaxSlots] = {};
  int64_t counts_[kMaxSlots] = {};
  int slots_ = 1;
  int head_ = 0;
  int64_t framesPerSlot_ = 256;
  int64_t inSlot_ = 0;
};

}  // namespace om
