// Master safety limiter reproducing the Web Audio DynamicsCompressorNode of
// engine.js (threshold -3 dB, knee 0, ratio 12, attack 2 ms, release 150 ms)
// including Chromium's 6 ms pre-delay (look-ahead) and its automatic makeup
// gain (pow(1 / fullRangeGain, 0.6)) so both engines play at the same
// loudness (owner: mixer). SPEC.md §9.6.
#pragma once

#include <memory>

namespace om {

class Limiter {
 public:
  struct Params {
    float thresholdDb = -3.0f;
    float kneeDb = 0.0f;
    float ratio = 12.0f;
    float attackSec = 0.002f;
    float releaseSec = 0.15f;
    float preDelaySec = 0.006f;  // Chromium DynamicsCompressor uniform pre-delay
  };

  Limiter();
  ~Limiter();
  void prepare(double sampleRate, const Params& p = Params());  // control thread (allocates the pre-delay)
  void reset() noexcept;
  void process(float* l, float* r, int n) noexcept;              // in place, audio thread
  float gainReductionDb() const noexcept;                        // current reduction (<= 0)
  double makeupGainDb() const noexcept;

  // Steady-state output level (dB) for a constant input level (dB), makeup
  // gain included — the reference curve of the tests.
  static double staticCurveDb(double inputDb, const Params& p);

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

}  // namespace om
