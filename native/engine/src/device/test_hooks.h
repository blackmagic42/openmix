// Fault injection of the device module's tests (owner: device, private
// header): a simulated write error (disk full) and a stalled writer thread
// for the recorder. Off by default; only tests/device/ sets them. Portable.
#pragma once

#include <atomic>
#include <cstdint>

namespace om {
namespace dev {
namespace testhooks {

// Recorder: the write that would take the data past this many bytes fails
// with a simulated "disk full" error (-1 = off).
inline std::atomic<int64_t> recFailAfterBytes{-1};
// Recorder: the writer thread stops draining the ring (a stalled disk), so
// the ring overflows and push() counts dropped frames.
inline std::atomic<bool> recWriterStall{false};

}  // namespace testhooks
}  // namespace dev
}  // namespace om
