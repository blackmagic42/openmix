// Peak / RMS meter with a sliding hold window (owner: mixer), so that a
// reader polling at ~60 Hz never misses a peak that happened between two
// polls. Replaces engine.js's AnalyserNode taps (fftSize 512, every other
// sample, read at frame time): deck meters on `post` (post-insert,
// pre-fader), master meter after the master filter, before the limiter.
// Real-time safe: fixed ring of per-slot maxima, no allocation.
#pragma once

#include <cstdint>

namespace om {

class MeterWindow {
 public:
  static constexpr int kMaxSlots = 64;

  // windowSec: how long a peak stays visible (>= 1 / stateHz); slotFrames:
  // granularity of the window (typically 128 frames).
  void prepare(double sampleRate, double windowSec, int slotFrames) noexcept;
  void reset() noexcept;
  void process(const float* l, const float* r, int n) noexcept;  // audio thread
  float peak() const noexcept;  // max |0.5 x (L + R)| over the window (linear; Chromium's analyser mono fold)
  float rms() const noexcept;   // RMS over the window (linear)

 private:
  float peaks_[kMaxSlots] = {};
  double sumSq_[kMaxSlots] = {};
  int64_t counts_[kMaxSlots] = {};
  int slots_ = 1;
  int head_ = 0;
  int64_t framesPerSlot_ = 128;
  int64_t inSlot_ = 0;
};

}  // namespace om
