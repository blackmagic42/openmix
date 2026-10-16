// Offline high-quality sample-rate converter used by the decoder to bring
// files to the device rate: polyphase windowed sinc (Kaiser), rational
// ratio (e.g. 44100 -> 48000 = 160/147), streaming API, output time-aligned
// with the input (group delay compensated) (owner: decoder). SPEC.md §7.3.
#pragma once

#include <cstdint>
#include <memory>
#include <vector>

namespace om {

class Resampler {
 public:
  // tapsPerPhase: filter length per output phase (32 = transparent for music);
  // cutoff: fraction of the lower Nyquist kept (0.95); kaiserBeta: stopband.
  Resampler(int inRate, int outRate, int channels = 2, int tapsPerPhase = 32, double cutoff = 0.95,
            double kaiserBeta = 8.6);
  ~Resampler();
  Resampler(const Resampler&) = delete;
  Resampler& operator=(const Resampler&) = delete;

  // Consumes `inFrames` interleaved frames and APPENDS the produced frames to
  // `out`. Call once more with flush = true (inFrames may be 0) at the end.
  void process(const float* in, int64_t inFrames, std::vector<float>& out, bool flush);
  // Exact number of output frames for a whole input of `inFrames` frames.
  int64_t outputFramesFor(int64_t inFrames) const noexcept;
  bool passthrough() const noexcept;  // same rates: plain copy
  void reset();

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

}  // namespace om
