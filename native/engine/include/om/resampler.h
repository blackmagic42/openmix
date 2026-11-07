// Offline high-quality sample-rate converter (owner: decoder), used by the
// shadow decoder (in its own process) to bring the span of a native decode
// around the reference window to the reference rate before comparing
// timelines: polyphase windowed sinc (Kaiser), rational ratio (e.g. 44100 ->
// 48000 = 160/147), streaming API, output time-aligned with the input (group
// delay compensated: output frame j is the input signal at input time
// j * inRate / outRate exactly, so a pure resampling never shows up as a
// timeline offset). Portable; not used on the audio thread. SPEC.md §7.4.
//
// Design: the 6 dB point of the anti-alias / anti-image low-pass sits at the
// lower of the two Nyquist frequencies; the passband ends at `cutoff` x that
// Nyquist and the stopband starts at (2 - cutoff) x it (aliasing is only
// allowed inside the transition band). Kaiser beta 10 gives ~99 dB of
// stopband rejection and a passband ripple far below 0.01 dB; the length
// follows from the transition width (Kaiser's formula) unless tapsPerPhase
// is given. Each polyphase row is normalized to unity DC gain. Very large
// ratio terms (more than 2048 phases) use a 2048-phase table with linear
// interpolation between rows.
#pragma once

#include <cstdint>
#include <memory>
#include <vector>

namespace om {

class Resampler {
 public:
  // tapsPerPhase: filter length per output phase in input frames (even; 0 =
  // derived from cutoff and kaiserBeta); cutoff: passband edge as a fraction
  // of the lower Nyquist (0.5 .. 0.995); kaiserBeta: stopband (10 ~ 99 dB).
  Resampler(int inRate, int outRate, int channels = 2, int tapsPerPhase = 0, double cutoff = 0.95,
            double kaiserBeta = 10.0);
  ~Resampler();
  Resampler(const Resampler&) = delete;
  Resampler& operator=(const Resampler&) = delete;

  // Consumes `inFrames` interleaved frames and APPENDS the produced frames to
  // `out`. Call once more with flush = true (inFrames may be 0) at the end:
  // the total output is then exactly outputFramesFor(total input) frames.
  void process(const float* in, int64_t inFrames, std::vector<float>& out, bool flush);
  // Exact number of output frames for a whole input of `inFrames` frames:
  // ceil(inFrames * outRate / inRate).
  int64_t outputFramesFor(int64_t inFrames) const noexcept;
  // Half-length of the filter in INPUT frames: output j depends only on the
  // input frames k with |k - j * inRate / outRate| < halfLengthFrames(). The
  // margin the shadow decoder keeps on each side of the span it resamples.
  int halfLengthFrames() const noexcept;
  int tapsPerPhase() const noexcept;   // 2 x halfLengthFrames (0 when passthrough)
  int upFactor() const noexcept;       // L: outRate / gcd
  int downFactor() const noexcept;     // M: inRate / gcd
  bool passthrough() const noexcept;   // same rates: plain copy
  void reset();

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

}  // namespace om
