// Device clock mapping (owner: device): the presentTime delay-locked loop
// and the jitter statistics (p99 over the last second and over a run) the
// WASAPI backend reports in DeviceStatus.presentJitterMs / rawJitterMs.
// Portable, RT-safe (no allocation, no lock). SPEC.md §4.1, §8.3.
#include "timing.h"

#include <cmath>
#include <cstring>

namespace om {
namespace dev {

namespace {
constexpr double kTwoPi = 6.283185307179586;
}

void PresentClock::reset(double sampleRate, double bandwidthHz, double discontinuitySec) noexcept {
  rate_ = sampleRate > 0 ? sampleRate : 48000.0;
  nominalSpf_ = spf_ = 1.0 / rate_;
  bw_ = bandwidthHz > 0 ? bandwidthHz : 1.0;
  jump_ = discontinuitySec > 0 ? discontinuitySec : 0.002;
  t_ = 0;
  n_ = 0;
  updates_ = 0;
}

double PresentClock::update(int64_t frame, double raw, bool* jumped) noexcept {
  if (jumped) *jumped = false;
  if (updates_ == 0 || frame <= n_) {
    // First measurement (or a restarted stream): start on it.
    t_ = raw;
    n_ = frame;
    spf_ = nominalSpf_;
    updates_ = 1;
    return t_;
  }
  const double dn = static_cast<double>(frame - n_);
  const double pred = t_ + dn * spf_;
  const double e = raw - pred;
  if (std::fabs(e) > jump_) {
    // A real jump of the mapping (underrun, position reset): follow it at
    // once; during the warm-up this is just the loop settling.
    if (jumped && updates_ >= kWarmup) *jumped = true;
    t_ = raw;
    n_ = frame;
    spf_ = nominalSpf_;
    updates_ = updates_ >= kWarmup ? kWarmup : updates_ + 1;
    return t_;
  }
  // Second-order loop, critically damped; omega for this step's duration.
  double w = kTwoPi * bw_ * dn * spf_;
  if (w > 0.5) w = 0.5;  // very long steps (stalls): keep the loop stable
  const double b = 1.4142135623730951 * w;
  const double c = w * w;
  t_ = pred + b * e;
  spf_ += c * e / dn;
  // The device clock is within a few hundred ppm of nominal: never let the
  // estimate wander further (bad measurements during a stall).
  const double lo = nominalSpf_ * 0.99, hi = nominalSpf_ * 1.01;
  if (spf_ < lo) spf_ = lo;
  if (spf_ > hi) spf_ = hi;
  n_ = frame;
  updates_++;
  return t_;
}

void JitterWindow::reset(double windowSec) noexcept {
  window_ = windowSec > 0 ? windowSec : 1.0;
  winStart_ = -1;
  std::memset(win_, 0, sizeof(win_));
  std::memset(tot_, 0, sizeof(tot_));
  winCount_ = totCount_ = 0;
  winMaxSec_ = totMax_ = 0;
  winP99_.store(0, std::memory_order_relaxed);
  winMax_.store(0, std::memory_order_relaxed);
}

double JitterWindow::p99Of(const uint32_t* bins, uint64_t count) noexcept {
  if (count == 0) return 0;
  const uint64_t want = count - count / 100;  // >= 99 % of the values at or below the result
  uint64_t acc = 0;
  for (int i = 0; i <= kBins; i++) {
    acc += bins[i];
    if (acc >= want) return (i + 1) * 0.001;  // upper edge of the 1-us bin, in ms
  }
  return (kBins + 1) * 0.001;
}

void JitterWindow::add(double absDeviationSec, double now) noexcept {
  if (winStart_ < 0) winStart_ = now;
  if (now - winStart_ >= window_ && winCount_ > 0) {
    winP99_.store(p99Of(win_, winCount_), std::memory_order_relaxed);
    winMax_.store(winMaxSec_ * 1000.0, std::memory_order_relaxed);
    std::memset(win_, 0, sizeof(win_));
    winCount_ = 0;
    winMaxSec_ = 0;
    winStart_ = now;
  }
  const double v = absDeviationSec < 0 ? -absDeviationSec : absDeviationSec;
  int bin = static_cast<int>(v * 1e6);
  if (bin < 0 || bin > kBins) bin = kBins;
  win_[bin]++;
  tot_[bin]++;
  winCount_++;
  totCount_++;
  if (v > winMaxSec_) winMaxSec_ = v;
  if (v * 1000.0 > totMax_) totMax_ = v * 1000.0;
}

double JitterWindow::totalP99Ms() const noexcept { return p99Of(tot_, totCount_); }

}  // namespace dev
}  // namespace om
