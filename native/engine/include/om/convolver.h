// Uniformly partitioned FFT convolution (stereo impulse, independent L/R like
// a Web Audio ConvolverNode fed in stereo) and the synthetic impulses of
// engine.js makeImpulse() with ConvolverNode normalization (owner: fx).
// SPEC.md §10.3.
#pragma once

#include <cstdint>
#include <memory>
#include <vector>

namespace om {

// engine.js makeImpulse(seconds, decay): stereo noise * (1 - i/len)^decay,
// from a SEEDED generator (deterministic tests), already multiplied by the
// Web Audio ConvolverNode normalization scale (normalize = true).
struct Impulse {
  std::vector<float> left, right;
  int sampleRate = 0;
  float normalizationScale = 1.0f;  // the factor that was applied
};
Impulse makeImpulse(double seconds, double decay, int sampleRate, uint32_t seed);

class Convolver {
 public:
  Convolver();
  ~Convolver();
  Convolver(const Convolver&) = delete;
  Convolver& operator=(const Convolver&) = delete;

  // Control thread: partitions the impulse (partition = blockFrames, power of 2).
  void prepare(const Impulse& ir, int blockFrames);
  void reset() noexcept;
  // Audio thread: any n (internally buffered to the partition size).
  void process(const float* inL, const float* inR, float* outL, float* outR, int n) noexcept;
  int latencyFrames() const noexcept;  // 0 when the partition matches the block (uniform OLS with direct first block)

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

}  // namespace om
