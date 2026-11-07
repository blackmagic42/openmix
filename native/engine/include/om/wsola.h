// Line-by-line C++ port of src/js/pitch-worklet.js (WSOLA): changes the
// pitch without changing the speed (KEY +-, KEYLOCK) with the worklet's
// FIXED, KNOWN latency of LAT = kWsolaLatencySamples samples whatever the
// ratio (owner: deck). SPEC.md §9.4.
//
// Same constants, same periodic Hann window, same coarse (step 4) then fine
// (+-3) normalized-correlation search with the same offset penalty, same
// linear interpolation inside the grains, same 50 % overlap-add: in
// "lockstep" mode (process() fed on a 128-frame quantum grid with the k-rate
// ratio of each quantum) the output is bit-identical to the worklet within
// float rounding. The quantum grid belongs to the DECK, not to the device
// blocks: the deck splits its rendering at its quantum edges and carries the
// remainder over (blocks of 441 / 480 / variable frames and the core's
// "when" splits must not move the quantum boundaries, or parity would hold
// in the tests only).
//
// Native improvement (the reason the deck reads straight from the track):
// prime() restarts the stream as if the transposer had already been running
// on the new position, so PLAY, hot cues, seeks and route changes output
// the right audio at once instead of 55-60 ms later or after a fade-in. It
// computes only what the first output needs: the grain at G0 - HS placed
// without search, then the grain at G0 with one search (~2 grains); cost
// target (tested): 4 simultaneous primes < 25 % of a 128-frame period.
//
// Measured (tests/deck): bit-exact (max |diff| = 0) against the real
// pitch-worklet.js in an AudioWorklet on ratio steps, ramps and
// setTargetAtTime between 0.5 and 1.8, for 128 / 441 / 480 / irregular
// blocks split on the quantum grid. The correlation search is computed
// side by side for 8 candidates (each with the worklet's own sequential
// sums: exact, not approximate). Frame counters are rebased by 2^27 (a
// multiple of RING and ACC) past 2^28 so every position stays exact in double.
//
// Real-time safe after construction: no allocation in process() / prime().
#pragma once

#include <cstdint>
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
  static constexpr int kRing = 16384;               // RING: input memory (power of 2)
  static constexpr int kAcc = 4096;                 // ACC: output accumulator (power of 2)
  static constexpr double kRatioMin = 0.5;          // R_MIN
  static constexpr double kRatioMax = 1.8;          // R_MAX: KEY +7 with keylock at -6 % ~ 1.6
  static constexpr double kDefaultPenalty = 0.1;    // processorOptions.pen default
  static constexpr int kQuantum = kRenderQuantum;   // the k-rate ratio changes on this grid (128 frames)
  static constexpr int kLatency = kWsolaLatencySamples;  // LAT = ceil(N * (R_MAX + 1) / 2 + SEARCH + 16) = 2647
  static_assert(kLatency == 2647, "WSOLA latency must match pitch-worklet.js LAT");
  // Input history prime() may read (an upper bound): LAT + one hop (the grain
  // that overlaps the first output) + the worst grain offset
  // (N * (R_MAX - 1) / 2) + SEARCH, rounded up. The deck's armed start waits
  // until the chunks holding it are ready; the deck owner may refine the
  // bound (with a test proving no read ever goes below the primed history).
  static constexpr int kPrimeFrames = kLatency + kHop + kGrain / 2 + kSearch + 32;
  static_assert(kPrimeFrames < kRing, "primed history must fit in the input ring");

  Wsola();   // allocates the rings (not RT)
  ~Wsola();
  Wsola(const Wsola&) = delete;
  Wsola& operator=(const Wsola&) = delete;

  // Silence, forget the previous grain (state of a freshly constructed worklet).
  void reset() noexcept;
  void setPenalty(double pen) noexcept;  // alignment penalty (pitch-worklet `pen`)

  // pitch-worklet.js process(): consumes n input frames, produces n output
  // frames, with ONE ratio for the call: the caller (the deck) calls it with
  // n <= the frames left in its current 128-frame quantum and that quantum's
  // k-rate ratio. The ratio is clamped to [kRatioMin, kRatioMax]; output
  // frame G corresponds to input frame G - kLatency.
  void process(const float* inL, const float* inR, float* outL, float* outR, int n, double ratio) noexcept;

  // Restart as if the kPrimeFrames input frames in hist* had just been
  // received and processed (oldest first, the last one immediately precedes
  // the next process() input): the input ring gets the history, the output
  // accumulator holds the ~2 grains that overlap the next output (§9.4),
  // and the next process() output starts at full level on input index
  // (next - kLatency).
  void prime(const float* histL, const float* histR, double ratio) noexcept;

  int64_t inputFrames() const noexcept;   // inW of the worklet
  int64_t outputFrames() const noexcept;  // outP of the worklet
  static constexpr int latency() noexcept { return kLatency; }

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

}  // namespace om
