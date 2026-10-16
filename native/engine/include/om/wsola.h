// C++ port of src/js/pitch-worklet.js (WSOLA): changes the pitch without
// changing the speed (KEY +-, KEYLOCK) with a FIXED, KNOWN latency of
// LAT = kWsolaLatencySamples samples whatever the ratio — the deck reads its
// track that much ahead so what is heard stays on the beat grid
// (owner: deck). SPEC.md §8.6.
//
// Real-time safe after construction: no allocation in process().
#pragma once

#include <memory>

#include "om/common.h"

namespace om {

class Wsola {
 public:
  // Same constants as pitch-worklet.js (in samples, independent of the rate).
  static constexpr int kGrain = 1536;               // N: 32 ms grain at 48 kHz
  static constexpr int kHop = kGrain / 2;           // HS: hop = half a grain (Hann sums to 1)
  static constexpr int kOverlap = kGrain - kHop;    // OVL: compared overlap zone
  static constexpr int kSearch = 480;               // SEARCH: +- samples (one 50 Hz period)
  static constexpr int kRing = 16384;               // input memory (power of 2)
  static constexpr int kAcc = 4096;                 // output accumulator (power of 2)
  static constexpr double kRatioMin = 0.5;
  static constexpr double kRatioMax = 1.8;          // KEY +7 with keylock at -6 % ~ 1.6
  static constexpr int kLatency = kWsolaLatencySamples;  // ceil(N * (R_MAX + 1) / 2 + SEARCH + 16) = 2647
  static_assert(kLatency == 2647, "WSOLA latency must match pitch-worklet.js LAT");

  Wsola();   // allocates the rings (not RT)
  ~Wsola();
  Wsola(const Wsola&) = delete;
  Wsola& operator=(const Wsola&) = delete;

  void reset() noexcept;                      // silence, forget the previous grain
  void setPenalty(double pen) noexcept;       // alignment penalty (pitch-worklet `pen`, default 0.1)
  // Processes n samples (any n). `ratio` = frequency ratio for this call
  // (k-rate, clamped to [kRatioMin, kRatioMax]); call with chunks of <= 128
  // frames to reproduce the worklet's per-quantum ratio updates exactly.
  void process(const float* inL, const float* inR, float* outL, float* outR, int n, double ratio) noexcept;
  static constexpr int latency() noexcept { return kLatency; }

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

}  // namespace om
