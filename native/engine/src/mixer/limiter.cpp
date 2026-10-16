// Master limiter (Chromium DynamicsCompressor behaviour for engine.js
// settings, makeup gain included) (owner: mixer). SKELETON: pass-through.
// SPEC.md §9.6.
#include "om/limiter.h"

namespace om {

struct Limiter::Impl {
  Params p;
  double sampleRate = 48000;
};

Limiter::Limiter() : impl_(std::make_unique<Impl>()) {}
Limiter::~Limiter() = default;

void Limiter::prepare(double sampleRate, const Params& p) {
  impl_->sampleRate = sampleRate;
  impl_->p = p;
}
void Limiter::reset() noexcept {}
void Limiter::process(float*, float*, int) noexcept {}
float Limiter::gainReductionDb() const noexcept { return 0.0f; }
double Limiter::makeupGainDb() const noexcept { return 0.0; }
double Limiter::staticCurveDb(double inputDb, const Params&) { return inputDb; }

}  // namespace om
