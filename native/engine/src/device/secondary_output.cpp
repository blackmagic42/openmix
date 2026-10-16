// Headphones on a second sound card: lock-free ring fed by the main audio
// thread, own WASAPI stream, drift-compensating resampler (owner: device).
// SKELETON: open() reports "not implemented". SPEC.md §6.5.
#include "om/device.h"

namespace om {

struct SecondaryOutput::Impl {
  bool active = false;
};

SecondaryOutput::SecondaryOutput() : impl_(std::make_unique<Impl>()) {}
SecondaryOutput::~SecondaryOutput() { close(); }

bool SecondaryOutput::open(const DeviceConfig&, int, std::string* err) {
  if (err) *err = "secondary output not implemented yet";
  return false;
}

void SecondaryOutput::close() { impl_->active = false; }

void SecondaryOutput::push(const float*, const float*, int) noexcept {}

bool SecondaryOutput::active() const noexcept { return impl_->active; }

DeviceStatus SecondaryOutput::status() const { return DeviceStatus(); }

double SecondaryOutput::driftRatio() const noexcept { return 1.0; }

}  // namespace om
