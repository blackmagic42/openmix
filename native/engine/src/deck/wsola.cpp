// WSOLA pitch shifter, C++ port of src/js/pitch-worklet.js (owner: deck).
// SKELETON: outputs silence. SPEC.md §8.6.
#include <cstring>

#include "om/wsola.h"

namespace om {

struct Wsola::Impl {
  double pen = 0.1;
};

Wsola::Wsola() : impl_(std::make_unique<Impl>()) {}
Wsola::~Wsola() = default;

void Wsola::reset() noexcept {}
void Wsola::setPenalty(double pen) noexcept { impl_->pen = pen; }

void Wsola::process(const float*, const float*, float* outL, float* outR, int n, double) noexcept {
  std::memset(outL, 0, sizeof(float) * static_cast<size_t>(n));
  std::memset(outR, 0, sizeof(float) * static_cast<size_t>(n));
}

}  // namespace om
