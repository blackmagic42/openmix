// Sampler voices (10 one-shot pads) mixed into the post bus (owner: mixer).
// SKELETON: slots can be attached, playback is silent. SPEC.md §9.8.
#include "om/sampler.h"

namespace om {

struct Sampler::Impl {
  const TrackBuffer* slots[kNumSamplerSlots] = {};
};

Sampler::Sampler() : impl_(std::make_unique<Impl>()) {}
Sampler::~Sampler() = default;

void Sampler::prepare(double, int) {}

const TrackBuffer* Sampler::attach(int slot, const TrackBuffer* tb) noexcept {
  if (slot < 0 || slot >= kNumSamplerSlots) return tb;
  const TrackBuffer* old = impl_->slots[slot];
  impl_->slots[slot] = tb;
  return old;
}

void Sampler::play(int, float) noexcept {}
void Sampler::stop(int) noexcept {}

bool Sampler::loaded(int slot) const noexcept {
  return slot >= 0 && slot < kNumSamplerSlots && impl_->slots[slot] != nullptr;
}

void Sampler::render(float*, float*, int) noexcept {}

}  // namespace om
