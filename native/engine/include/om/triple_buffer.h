// Lock-free "latest value" mailbox (triple buffer): the audio thread publishes
// a state snapshot every block, the control thread reads the most recent one
// whenever it wants (at ~60 Hz) without ever blocking the writer.
//
// FROZEN FOUNDATION (maintainer: host). One writer thread, one reader thread.
#pragma once

#include <atomic>
#include <cstdint>
#include <type_traits>

namespace om {

template <class T>
class TripleBuffer {
  static_assert(std::is_trivially_copyable<T>::value, "TripleBuffer<T>: T must be trivially copyable");

 public:
  TripleBuffer() = default;
  explicit TripleBuffer(const T& init) {
    for (auto& b : bufs_) b = init;
  }

  // Writer: fill the buffer returned here, then call publish().
  T& writeBuffer() noexcept { return bufs_[write_]; }

  // Writer: makes the write buffer the latest value (never blocks).
  void publish() noexcept {
    const uint32_t prev = middle_.exchange(write_ | kFresh, std::memory_order_acq_rel);
    write_ = prev & kIndexMask;
  }

  // Reader: copies the latest published value into `out`. Returns true when a
  // new value was published since the previous read (out is then updated).
  bool read(T& out) noexcept {
    if (middle_.load(std::memory_order_acquire) & kFresh) {
      const uint32_t prev = middle_.exchange(read_, std::memory_order_acq_rel);
      read_ = prev & kIndexMask;
      out = bufs_[read_];
      return true;
    }
    return false;
  }

  // Reader: pointer to the latest value (valid until the next latest()/read()).
  const T& latest() noexcept {
    if (middle_.load(std::memory_order_acquire) & kFresh) {
      const uint32_t prev = middle_.exchange(read_, std::memory_order_acq_rel);
      read_ = prev & kIndexMask;
    }
    return bufs_[read_];
  }

 private:
  static constexpr uint32_t kFresh = 4u;
  static constexpr uint32_t kIndexMask = 3u;
  T bufs_[3]{};
  uint32_t write_ = 0;                     // owned by the writer
  uint32_t read_ = 1;                      // owned by the reader
  std::atomic<uint32_t> middle_{2u};       // shared: index of the spare buffer + fresh flag
};

}  // namespace om
