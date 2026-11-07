// Zero-latency partitioned FFT convolution (owner: fx) for the reverbs of
// the FX units and of the Color FX, behaving like a Web Audio ConvolverNode
// fed in stereo with a stereo impulse (L with IR L, R with IR R), and the
// synthetic impulses of engine.js makeImpulse() scaled with Chromium's
// Reverb::CalculateNormalizationScale (normalize = true):
//   power = sqrt(sum of squares of all channels / (channels * length)),
//   power = max(power, 0.000125), scale = (1 / power) * 10^(-58 / 20)
//   * 44100 / sampleRate. SPEC.md §11.3.
// Own FFT code (src/fx/fft.cpp, written here): no download.
//
// Split in two (SPEC.md §11.3, §11.5):
//  - ConvolverKernel: the impulse partitioned in the frequency domain ONCE,
//    immutable, shared by every convolver using the same impulse (all FX
//    units' reverbs share one kernel);
//  - Convolver: the per-instance state (input history, frequency-domain delay
//    lines, accumulators), allocated with its lazy chain.
// NON-UNIFORM partitions: a 64-tap direct-form head, then uniformly
// partitioned overlap-save levels of 64, 256 and 1024 frames (3 partitions
// each, computed when their block completes: offset >= block), then the tail
// in partitions of 2048 frames starting at 4096 frames, whose FFT work is
// spread over the following 2048 frames (offset >= 2 x block): zero added
// latency for ANY block size <= 2048, constant work per block. Idle tail
// (input silent for longer than the impulse, or the remaining tail provably
// below -120 dBFS): zeros without work. Budget: < 1 % of a 256-frame block
// per instance at 48 kHz.
#pragma once

#include <cstddef>
#include <cstdint>
#include <memory>
#include <vector>

namespace om {

// engine.js makeImpulse(seconds, decay): stereo noise * (1 - i/len)^decay,
// len = floor(rate * seconds), from a SEEDED generator (deterministic tests;
// the Web engine uses Math.random, so the golden renders hand the same seeded
// impulse to their ConvolverNode), already multiplied by the ConvolverNode
// normalization scale. The generator is xorshift32 (x ^= x << 13; x ^= x >>
// 17; x ^= x << 5; seed 0 -> 0x9E3779B9), uniform = x / 2^32, sample =
// (uniform * 2 - 1) * pow(1 - i / len, decay) rounded to float, left channel
// first then right, one stream.
struct Impulse {
  std::vector<float> left, right;
  int sampleRate = 0;
  float normalizationScale = 1.0f;  // the factor that was applied
};
Impulse makeImpulse(double seconds, double decay, int sampleRate, uint32_t seed);
float convolverNormalizationScale(const std::vector<float>& left, const std::vector<float>& right, int sampleRate);

// Immutable frequency-domain partitions of one impulse (control thread
// builds it; any thread may read it).
class ConvolverKernel {
 public:
  ~ConvolverKernel();
  ConvolverKernel(const ConvolverKernel&) = delete;
  ConvolverKernel& operator=(const ConvolverKernel&) = delete;
  // `maxBlockFrames` is advisory: every block size <= 2048 is supported.
  static std::shared_ptr<const ConvolverKernel> build(const Impulse& ir, int maxBlockFrames);
  int lengthFrames() const noexcept;
  int sampleRate() const noexcept;

  // Partition layout (tests, diagnostics).
  struct Partitions {
    int blockFrames;   // partition size (frames)
    int count;         // number of partitions of that size
    int offsetFrames;  // impulse offset of the first one
    bool spread;       // FFT work spread over the following block period
  };
  int directTaps() const noexcept;                   // direct-form head length
  const std::vector<Partitions>& layout() const noexcept;
  size_t memoryBytes() const noexcept;               // the shared spectra

  struct Impl;
  const Impl& impl() const noexcept { return *impl_; }

 private:
  ConvolverKernel();
  std::unique_ptr<Impl> impl_;
};

class Convolver {
 public:
  Convolver();
  ~Convolver();
  Convolver(const Convolver&) = delete;
  Convolver& operator=(const Convolver&) = delete;

  // Control thread: allocates the per-instance state for `kernel` (nullptr:
  // process() outputs silence).
  void prepare(std::shared_ptr<const ConvolverKernel> kernel, int maxBlockFrames);
  // Audio thread, O(small): forgets the input history (the output is then
  // exactly what a fresh convolver would produce).
  void reset() noexcept;
  // Audio thread: any n <= 2048; in-place (in == out) allowed.
  void process(const float* inL, const float* inR, float* outL, float* outR, int n) noexcept;
  bool idle() const noexcept;          // the tail is over: process() outputs zeros without work
  int latencyFrames() const noexcept;  // always 0 (ConvolverNode has none)
  size_t memoryBytes() const noexcept; // the per-instance state

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

}  // namespace om
