// Polyphase windowed-sinc sample-rate converter used by the decoder
// (owner: decoder). SKELETON: only the same-rate passthrough works.
// SPEC.md §7.3.
#include "om/resampler.h"

namespace om {

struct Resampler::Impl {
  int inRate = 0, outRate = 0, channels = 2;
};

Resampler::Resampler(int inRate, int outRate, int channels, int, double, double) : impl_(std::make_unique<Impl>()) {
  impl_->inRate = inRate;
  impl_->outRate = outRate;
  impl_->channels = channels;
}

Resampler::~Resampler() = default;

void Resampler::process(const float* in, int64_t inFrames, std::vector<float>& out, bool) {
  if (!passthrough() || !in || inFrames <= 0) return;  // TODO(decoder): polyphase sinc
  out.insert(out.end(), in, in + inFrames * impl_->channels);
}

int64_t Resampler::outputFramesFor(int64_t inFrames) const noexcept {
  if (impl_->inRate <= 0) return 0;
  return (inFrames * impl_->outRate + impl_->inRate - 1) / impl_->inRate;
}

bool Resampler::passthrough() const noexcept { return impl_->inRate == impl_->outRate; }

void Resampler::reset() {}

}  // namespace om
