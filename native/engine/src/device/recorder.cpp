// Mix recorder: lock-free ring from the audio thread, writer thread, WAV /
// RF64 file with periodic header patching (owner: device).
// SKELETON: start() reports "not implemented". SPEC.md §13.
#include "om/recorder.h"

namespace om {

struct Recorder::Impl {
  RecStatus status;
};

Recorder::Recorder() : impl_(std::make_unique<Impl>()) {}
Recorder::~Recorder() = default;

bool Recorder::start(const std::string&, RecFormat, int, std::string* err) {
  if (err) *err = "recorder not implemented yet";
  return false;
}

void Recorder::push(const float*, const float*, int) noexcept {}

RecStatus Recorder::stop() { return impl_->status; }

RecStatus Recorder::status() const { return impl_->status; }

bool Recorder::active() const noexcept { return false; }

}  // namespace om
