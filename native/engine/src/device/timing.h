// Device clock mapping of the device layer (owner: device, private header):
//  - PresentClock: a delay-locked loop (second order, F. Adriaensen's
//    "Using a DLL to filter time") over the raw stream-frame -> engine-time
//    measurements (IAudioClock::GetPosition + its QPC stamp), so presentTime
//    is smooth, monotonic and continuous (never the callback wake-up time),
//    with discontinuity detection (glitches);
//  - JitterWindow: p99 / max of absolute deviations over tumbling windows
//    (the last completed second) and over the whole run, from a fixed
//    1-us histogram (no allocation: RT-safe).
// Portable. SPEC.md §4.1, §8.3.
#pragma once

#include <atomic>
#include <cstdint>

namespace om {
namespace dev {

class PresentClock {
 public:
  // bandwidthHz: loop bandwidth (lower = smoother, slower to follow drift).
  // discontinuitySec: a raw value that far from the prediction restarts the
  // loop on it (a real jump: underrun, device restart).
  void reset(double sampleRate, double bandwidthHz = 1.0, double discontinuitySec = 0.002) noexcept;
  // One measurement per callback: `raw` = engine time at which stream frame
  // `frame` (the first frame of the block about to be written) is
  // presented. Returns the filtered time of that frame. `jumped` is set when
  // the loop restarted on a discontinuity (never during the first updates).
  double update(int64_t frame, double raw, bool* jumped = nullptr) noexcept;
  bool locked() const noexcept { return updates_ >= kWarmup; }
  double secondsPerFrame() const noexcept { return spf_; }
  int64_t updates() const noexcept { return updates_; }
  static constexpr int kWarmup = 8;

 private:
  double rate_ = 48000, nominalSpf_ = 1.0 / 48000, spf_ = 1.0 / 48000;
  double bw_ = 1.0, jump_ = 0.002;
  double t_ = 0;          // filtered time of frame n_
  int64_t n_ = 0;
  int64_t updates_ = 0;
};

class JitterWindow {
 public:
  static constexpr int kBins = 5000;  // 1 us bins: 0 .. 5 ms, then an overflow bin
  void reset(double windowSec = 1.0) noexcept;
  // RT-safe. `now` = any monotonic seconds (closes the window when due).
  void add(double absDeviationSec, double now) noexcept;
  // Last completed window (the "last second" of the status) and whole run.
  double windowP99Ms() const noexcept { return winP99_.load(std::memory_order_relaxed); }
  double windowMaxMs() const noexcept { return winMax_.load(std::memory_order_relaxed); }
  double totalP99Ms() const noexcept;  // reads the run histogram: call from the owner thread or after the run
  double totalMaxMs() const noexcept { return totMax_; }
  uint64_t totalCount() const noexcept { return totCount_; }

 private:
  static double p99Of(const uint32_t* bins, uint64_t count) noexcept;
  double window_ = 1.0, winStart_ = -1;
  uint32_t win_[kBins + 1] = {};
  uint32_t tot_[kBins + 1] = {};
  uint64_t winCount_ = 0, totCount_ = 0;
  double winMaxSec_ = 0, totMax_ = 0;
  std::atomic<double> winP99_{0}, winMax_{0};
};

}  // namespace dev
}  // namespace om
