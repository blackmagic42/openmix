// Lock-free single-producer / single-consumer ring of stereo float frames
// (owner: device, private header): the audio thread pushes the master (to
// the recorder's writer thread) or the cue bus (to the headphones card's
// thread) through it. Indices are 64-bit frame counters (never wrap in
// practice); the buffer is interleaved L/R with a power-of-two capacity.
// push() is all-or-nothing (a block that does not fit is dropped whole, so
// the consumer never sees half a block). Wait-free, no allocation after
// allocate(). Portable. SPEC.md §3.2, §8.7, §14.
#pragma once

#include <atomic>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <new>

namespace om {
namespace dev {

#ifdef _MSC_VER
#pragma warning(push)
#pragma warning(disable : 4324)  // padded for the cache-line alignment (intended)
#endif

class StereoRing {
 public:
  // Non-real-time; only while no producer / consumer runs. Rounds up to a
  // power of two. Returns false on allocation failure.
  bool allocate(size_t minFrames) {
    size_t n = 64;
    while (n < minFrames) n <<= 1;
    std::unique_ptr<float[]> b(new (std::nothrow) float[n * 2]());
    if (!b) return false;
    buf_ = std::move(b);
    mask_ = n - 1;
    w_.store(0, std::memory_order_relaxed);
    r_.store(0, std::memory_order_relaxed);
    return true;
  }
  bool allocated() const noexcept { return buf_ != nullptr; }
  size_t capacity() const noexcept { return buf_ ? mask_ + 1 : 0; }

  // ---- producer ----
  bool push(const float* l, const float* r, size_t n) noexcept {
    if (!buf_ || n == 0) return n == 0;
    const uint64_t w = w_.load(std::memory_order_relaxed);
    const uint64_t rd = r_.load(std::memory_order_acquire);
    if (capacity() - static_cast<size_t>(w - rd) < n) return false;
    float* b = buf_.get();
    for (size_t i = 0; i < n; i++) {
      const size_t k = static_cast<size_t>((w + i) & mask_) * 2;
      b[k] = l[i];
      b[k + 1] = r ? r[i] : l[i];
    }
    w_.store(w + n, std::memory_order_release);
    return true;
  }
  uint64_t producerWriteIndex() const noexcept { return w_.load(std::memory_order_relaxed); }  // producer only
  size_t freeFrames() const noexcept {
    return capacity() - static_cast<size_t>(w_.load(std::memory_order_relaxed) - r_.load(std::memory_order_acquire));
  }

  // ---- consumer ----
  uint64_t readIndex() const noexcept { return r_.load(std::memory_order_relaxed); }
  uint64_t writeIndex() const noexcept { return w_.load(std::memory_order_acquire); }
  size_t available() const noexcept {
    return static_cast<size_t>(w_.load(std::memory_order_acquire) - r_.load(std::memory_order_relaxed));
  }
  // Frame `idx` (absolute counter) as {L, R}; the caller keeps idx in [readIndex, writeIndex).
  const float* frame(uint64_t idx) const noexcept { return buf_.get() + static_cast<size_t>(idx & mask_) * 2; }
  // Contiguous interleaved span starting at absolute frame idx: at most `n`
  // frames up to the end of the buffer. Returns the span length in frames.
  size_t span(uint64_t idx, size_t n, const float** out) const noexcept {
    const size_t pos = static_cast<size_t>(idx & mask_);
    const size_t until = capacity() - pos;
    *out = buf_.get() + pos * 2;
    return n < until ? n : until;
  }
  // Releases every frame before idx (idx in [readIndex, writeIndex]).
  void consumeTo(uint64_t idx) noexcept { r_.store(idx, std::memory_order_release); }

 private:
  std::unique_ptr<float[]> buf_;
  size_t mask_ = 0;
  alignas(64) std::atomic<uint64_t> w_{0};
  alignas(64) std::atomic<uint64_t> r_{0};
};

#ifdef _MSC_VER
#pragma warning(pop)
#endif

}  // namespace dev
}  // namespace om
