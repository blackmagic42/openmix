// Lock-free single-producer / single-consumer ring queue: the only way data
// crosses into or out of the audio thread (commands UI->audio, events and
// retired objects audio->control).
//
// FROZEN FOUNDATION (maintainer: host). Wait-free push/pop, no allocation
// after construction, safe to use from a real-time thread. Exactly ONE thread
// may push and exactly ONE thread may pop.
#pragma once

#include <atomic>
#include <cstddef>
#include <memory>
#include <type_traits>

namespace om {

#ifdef _MSC_VER
#pragma warning(push)
#pragma warning(disable : 4324)  // structure padded due to alignment specifier (intended)
#endif

template <class T>
class SpscQueue {
  static_assert(std::is_trivially_copyable<T>::value, "SpscQueue<T>: T must be trivially copyable");

 public:
  // Capacity is rounded up to a power of two (one slot stays free). Allocates:
  // construct on a non-real-time thread.
  explicit SpscQueue(size_t capacity) {
    size_t n = 2;
    while (n < capacity + 1) n <<= 1;
    mask_ = n - 1;
    buf_.reset(new T[n]);
  }
  SpscQueue(const SpscQueue&) = delete;
  SpscQueue& operator=(const SpscQueue&) = delete;

  // Producer thread only. Returns false when the queue is full.
  bool push(const T& v) noexcept {
    const size_t t = tail_.load(std::memory_order_relaxed);
    const size_t next = (t + 1) & mask_;
    if (next == cachedHead_) {
      cachedHead_ = head_.load(std::memory_order_acquire);
      if (next == cachedHead_) return false;
    }
    buf_[t] = v;
    tail_.store(next, std::memory_order_release);
    return true;
  }

  // Consumer thread only. Returns false when the queue is empty.
  bool pop(T& out) noexcept {
    const size_t h = head_.load(std::memory_order_relaxed);
    if (h == cachedTail_) {
      cachedTail_ = tail_.load(std::memory_order_acquire);
      if (h == cachedTail_) return false;
    }
    out = buf_[h];
    head_.store((h + 1) & mask_, std::memory_order_release);
    return true;
  }

  // Consumer thread only: copies the next element without removing it.
  bool peek(T& out) noexcept {
    const size_t h = head_.load(std::memory_order_relaxed);
    if (h == cachedTail_) {
      cachedTail_ = tail_.load(std::memory_order_acquire);
      if (h == cachedTail_) return false;
    }
    out = buf_[h];
    return true;
  }

  size_t capacity() const noexcept { return mask_; }

  // Approximate (exact only when called from the producer or the consumer while the other is idle).
  size_t sizeApprox() const noexcept {
    const size_t t = tail_.load(std::memory_order_acquire);
    const size_t h = head_.load(std::memory_order_acquire);
    return (t - h) & mask_;
  }
  bool emptyApprox() const noexcept { return sizeApprox() == 0; }

 private:
  alignas(64) std::atomic<size_t> head_{0};  // next slot to read (written by the consumer)
  size_t cachedTail_ = 0;                    // consumer's copy of tail_
  alignas(64) std::atomic<size_t> tail_{0};  // next slot to write (written by the producer)
  size_t cachedHead_ = 0;                    // producer's copy of head_
  alignas(64) size_t mask_ = 0;
  std::unique_ptr<T[]> buf_;
};

#ifdef _MSC_VER
#pragma warning(pop)
#endif

}  // namespace om
