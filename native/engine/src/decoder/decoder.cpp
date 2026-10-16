// Decode job queue: worker threads (below-normal priority), cancellation,
// progress, Track / Stems / Sample jobs, timeline alignment (owner: decoder).
// SKELETON: every submitted job completes at once with "not implemented",
// so the engine core can already exercise the load flow. SPEC.md §7.
#include <deque>
#include <mutex>

#include "om/decoder.h"

namespace om {

const char* decodeErrorName(DecodeError e) noexcept {
  switch (e) {
    case DecodeError::None: return "none";
    case DecodeError::Unsupported: return "unsupported";
    case DecodeError::NotFound: return "notFound";
    case DecodeError::Io: return "io";
    case DecodeError::Cancelled: return "cancelled";
    case DecodeError::OutOfMemory: return "memory";
    case DecodeError::Internal: return "internal";
  }
  return "internal";
}

struct Decoder::Impl {
  std::mutex m;
  std::deque<DecodeResult> done;
};

Decoder::Decoder(int) : impl_(std::make_unique<Impl>()) {}
Decoder::~Decoder() { shutdown(); }

void Decoder::submit(DecodeRequest req) {
  DecodeResult r;
  r.id = req.id;
  r.kind = req.kind;
  r.error = DecodeError::Internal;
  r.message = "decoder not implemented yet";
  std::lock_guard<std::mutex> lk(impl_->m);
  impl_->done.push_back(std::move(r));
}

void Decoder::cancel(uint64_t) {}

bool Decoder::poll(DecodeResult& out) {
  std::lock_guard<std::mutex> lk(impl_->m);
  if (impl_->done.empty()) return false;
  out = std::move(impl_->done.front());
  impl_->done.pop_front();
  return true;
}

float Decoder::progress(uint64_t) const { return -1.0f; }

void Decoder::shutdown() {}

}  // namespace om
