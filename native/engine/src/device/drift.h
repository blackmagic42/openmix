// Drift correction of the headphones path (owner: device, private header):
// the main callback writes the cue bus into a StereoRing at the main card's
// clock, the second card's thread reads it at its own clock.
//  - PushStamp: the producer's last push (write index, frames, engine time)
//    behind a seqlock (RT-safe on both sides), so the consumer can measure
//    a CONTINUOUS fill: without it the fill seen at the consumer's callbacks
//    carries the producer's block sawtooth, whose phase drifts exactly as
//    fast as the clocks do, and biases the ratio by the drift itself;
//  - DriftController: PI controller on that fill; its output is the
//    consumption ratio (input frames per output frame);
//  - CubicReader: reads the ring at that fractional ratio with a 4-point
//    cubic (Catmull-Rom) interpolation.
// All RT-safe and portable; SecondaryOutput::simulateDrift() runs them
// against simulated clocks. SPEC.md §8.7.
#pragma once

#include <atomic>
#include <cstdint>

#include "ring.h"

namespace om {
namespace dev {

class PushStamp {
 public:
  // Producer, after a successful push: write index after it, its size, its time.
  void publish(uint64_t writeIndexAfter, int frames, double t) noexcept {
    const uint32_t s = seq_.load(std::memory_order_relaxed);
    seq_.store(s + 1, std::memory_order_relaxed);  // odd: being written
    std::atomic_thread_fence(std::memory_order_release);
    w_.store(writeIndexAfter, std::memory_order_relaxed);
    n_.store(frames, std::memory_order_relaxed);
    t_.store(t, std::memory_order_relaxed);
    seq_.store(s + 2, std::memory_order_release);
  }
  // Consumer: a consistent copy of the last publish (false: none yet).
  bool read(uint64_t& w, int& frames, double& t) const noexcept {
    for (int tries = 0; tries < 8; tries++) {
      const uint32_t s0 = seq_.load(std::memory_order_acquire);
      if (s0 & 1u) continue;
      w = w_.load(std::memory_order_relaxed);
      frames = n_.load(std::memory_order_relaxed);
      t = t_.load(std::memory_order_relaxed);
      std::atomic_thread_fence(std::memory_order_acquire);
      if (seq_.load(std::memory_order_relaxed) == s0) return s0 != 0;
    }
    return false;
  }
  void reset() noexcept { seq_.store(0, std::memory_order_release); }

 private:
  std::atomic<uint32_t> seq_{0};
  std::atomic<uint64_t> w_{0};
  std::atomic<int> n_{0};
  std::atomic<double> t_{0};
};

class DriftController {
 public:
  static constexpr double kFillTauSec = 0.5;    // smoothing of the fill measurement
  static constexpr double kKp = 0.5;            // 1/s per second of fill error
  static constexpr double kKi = 0.0625;         // 1/s^2: natural frequency 0.25 rad/s, critically damped
  static constexpr double kMaxCorrection = 0.01;  // +- 1 % (real clocks differ by < 0.05 %)
  // nominal = inputRate / outputRate (input frames per output frame when both
  // clocks run at their nominal rates); target = fill to hold (input frames).
  void reset(double nominal, double targetFill, double inputRate) noexcept;
  // One consumer callback: `fill` = input frames ahead of the read position
  // before reading, `dtSec` = duration of the callback's output. Returns the
  // consumption ratio to use for this callback.
  double update(double fill, double dtSec) noexcept;
  double ratio() const noexcept { return nominal_ * (1.0 + corr_); }
  double correction() const noexcept { return 1.0 + corr_; }  // 1.0 = no drift
  double filteredFill() const noexcept { return fs_; }
  double target() const noexcept { return target_; }

 private:
  double nominal_ = 1.0, target_ = 0, inRate_ = 48000;
  double fs_ = 0, integ_ = 0, corr_ = 0;
  bool init_ = false;
};

class CubicReader {
 public:
  void reset() noexcept { frac_ = 0; }
  // Absolute (fractional) input position of the next output frame.
  double position(const StereoRing& ring) const noexcept { return static_cast<double>(ring.readIndex()) + 1.0 + frac_; }
  // Input frames ahead of the interpolation position (sawtooth included).
  double fill(const StereoRing& ring) const noexcept;
  // Writes n frames into out[i * channels + chL / chR] (other channels
  // untouched), consuming `ratio` input frames per output frame. Returns
  // false (nothing written, nothing consumed) when the ring does not hold
  // enough frames: the caller outputs silence and primes again.
  bool read(StereoRing& ring, double ratio, float* out, int n, int channels, int chL, int chR) noexcept;
  // Drops input so that `targetFill` frames remain ahead of the position.
  void skipTo(StereoRing& ring, double targetFill) noexcept;
  // Drops `frames` whole input frames (they must be in the ring).
  void drop(StereoRing& ring, uint64_t frames) noexcept;

 private:
  double frac_ = 0;  // position relative to readIndex() + 1 (the frame at readIndex is the x[-1] history)
};

// Fill as if the producer wrote continuously at producerRate: the frames of
// its last push count only for the share of that push's duration that has
// elapsed at `now` (same clock as the stamps). Falls back to the plain fill
// before the first stamp.
double continuousFill(const StereoRing& ring, const CubicReader& rd, const PushStamp& stamp, double now,
                      double producerRate) noexcept;

}  // namespace dev
}  // namespace om
