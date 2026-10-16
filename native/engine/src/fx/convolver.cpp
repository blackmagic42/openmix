// Partitioned FFT convolution and engine.js makeImpulse() with ConvolverNode
// normalization (owner: fx). SKELETON: empty impulse, silent output.
// SPEC.md §10.3.
#include <cstring>

#include "om/convolver.h"

namespace om {

Impulse makeImpulse(double, double, int sampleRate, uint32_t) {
  Impulse ir;
  ir.sampleRate = sampleRate;
  return ir;
}

struct Convolver::Impl {
  int partition = 128;
};

Convolver::Convolver() : impl_(std::make_unique<Impl>()) {}
Convolver::~Convolver() = default;

void Convolver::prepare(const Impulse&, int blockFrames) { impl_->partition = blockFrames; }
void Convolver::reset() noexcept {}

void Convolver::process(const float*, const float*, float* outL, float* outR, int n) noexcept {
  std::memset(outL, 0, sizeof(float) * static_cast<size_t>(n));
  std::memset(outR, 0, sizeof(float) * static_cast<size_t>(n));
}

int Convolver::latencyFrames() const noexcept { return 0; }

}  // namespace om
