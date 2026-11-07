// Master safety limiter (owner: mixer): a port of Chromium's
// DynamicsCompressorKernel (third_party/blink/renderer/platform/audio/
// dynamics_compressor_kernel.cc, BSD-3 — keep its license header in the
// port) with the settings engine.js gives its DynamicsCompressorNode:
// threshold -3 dB, knee 0, ratio 12, attack 2 ms, release 150 ms. Includes
// what makes both engines play at the same loudness and timing:
//  - the 6 ms uniform pre-delay (look-ahead): it is master-chain latency,
//    reported to the core so heard positions stay exact;
//  - the automatic makeup gain pow(1 / Saturate(1, k), 0.6) (+1.65 dB here);
//  - the knee curve with k solved for the 1/ratio slope, the 32-frame
//    division processing, the adaptive release polynomial (release zones
//    0.09 / 0.16 / 0.42 / 0.98), the saturation release (2.5 ms) and the
//    detector average, as in Chromium. SPEC.md §10.6.
#pragma once

#include <memory>

namespace om {

// Settings of the limiter (namespace scope, not nested: a nested struct with
// member initializers cannot be a default argument of its enclosing class
// in clang — found by the portable build).
struct LimiterParams {
  float thresholdDb = -3.0f;   // engine.js limiter.threshold
  float kneeDb = 0.0f;         // engine.js limiter.knee
  float ratio = 12.0f;         // engine.js limiter.ratio
  float attackSec = 0.002f;    // engine.js limiter.attack
  float releaseSec = 0.15f;    // engine.js limiter.release
  float preDelaySec = 0.006f;  // Chromium DynamicsCompressor uniform pre-delay
};

class Limiter {
 public:
  using Params = LimiterParams;

  Limiter();
  ~Limiter();
  Limiter(const Limiter&) = delete;
  Limiter& operator=(const Limiter&) = delete;

  void prepare(double sampleRate, const Params& p = Params());  // control thread (allocates the pre-delay)
  void reset() noexcept;
  void process(float* l, float* r, int n) noexcept;              // in place, audio thread
  float gainReductionDb() const noexcept;                        // current reduction (<= 0), engine.js .reduction
  double makeupGainDb() const noexcept;
  int latencyFrames() const noexcept;                            // pre-delay in frames

  // Steady-state output level (dB) for a constant input level (dB), makeup
  // gain included — the reference curve of the tests.
  static double staticCurveDb(double inputDb, const Params& p);

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

}  // namespace om
