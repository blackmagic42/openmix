// Beat FX unit: the 18 effect types of engine.js FxUnit, beat-synced, with
// LFOs phase-locked to the grid (owner: fx). SKELETON: keeps the parameters,
// outputs silence. SPEC.md §10.
#include <cstring>

#include "om/fx.h"

namespace om {

struct FxUnit::Impl {
  FxType type = FxType::Echo;  // engine.js default
  bool enabled = false;
  float level = 0.0f;          // engine.js: the FX always starts at the lowest point
  float beatsMult = 0.5f;
  BeatClock clock;
  double sampleRate = 48000;
};

FxUnit::FxUnit() : impl_(std::make_unique<Impl>()) {}
FxUnit::~FxUnit() = default;

void FxUnit::prepare(double sampleRate, int) { impl_->sampleRate = sampleRate; }
void FxUnit::setType(FxType t) noexcept { impl_->type = t; }
void FxUnit::setEnabled(bool on) noexcept { impl_->enabled = on; }
void FxUnit::setLevel(float v) noexcept { impl_->level = clampv(v, 0.0f, 1.0f); }
void FxUnit::setBeatsMult(float m) noexcept { impl_->beatsMult = m; }
void FxUnit::setBeatClock(const BeatClock& bc) noexcept { impl_->clock = bc; }
void FxUnit::reset() noexcept {}

FxType FxUnit::type() const noexcept { return impl_->type; }
bool FxUnit::enabled() const noexcept { return impl_->enabled; }
float FxUnit::level() const noexcept { return impl_->level; }
float FxUnit::beatsMult() const noexcept { return impl_->beatsMult; }
float FxUnit::wetGain() const noexcept { return impl_->enabled ? impl_->level : 0.0f; }

double FxUnit::modPeriodBeats() const noexcept {
  const double m = impl_->beatsMult;
  switch (impl_->type) {  // engine.js modPeriodBeats
    case FxType::Trans: return m;
    case FxType::Flanger: return 8 * m;
    case FxType::Phaser: return 4 * m;
    case FxType::Pan:
    case FxType::Filter: return 2 * m;
    default: return 0.0;
  }
}

double FxUnit::delayTimeSec() const noexcept {
  return clampv(impl_->clock.beatDur * impl_->beatsMult, 0.02, 3.9);  // engine.js _timeNow
}

void FxUnit::process(const float*, const float*, float* outL, float* outR, int n) noexcept {
  std::memset(outL, 0, sizeof(float) * static_cast<size_t>(n));
  std::memset(outR, 0, sizeof(float) * static_cast<size_t>(n));
}

}  // namespace om
