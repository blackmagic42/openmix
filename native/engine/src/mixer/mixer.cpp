// The native mixer: channel strips, FX sends/returns, Color FX bus, master
// bus, limiter, sampler, meters, output routing (owner: mixer).
// SKELETON: stores the parameters and owns the FX units, but outputs
// silence. SPEC.md §9.
#include <cmath>
#include <cstring>
#include <vector>

#include "om/mixer.h"

namespace om {

struct Mixer::Impl {
  FxUnit panel[kNumFxUnits];
  FxUnit pad[kNumDecks];
  FxUnit master;
  ColorFx color;
  Sampler sampler;
  Limiter limiter;
  IInsert* insert = nullptr;
  OutputRouting routing;
  float volume[kNumDecks] = {0.85f, 0.85f, 0.85f, 0.85f};  // engine.js Deck.volume default
  float trim[kNumDecks] = {0, 0, 0, 0};
  float eq[kNumDecks][3] = {};
  float color[kNumDecks] = {0, 0, 0, 0};
  bool pfl[kNumDecks] = {false, false, false, false};
  XfSide sides[kNumDecks] = {XfSide::A, XfSide::B, XfSide::A, XfSide::B};
  float crossfader = 0.5f;
  float masterVolume = 0.9f;
  float masterFilter = 0.0f;
  ColorType colorType = ColorType::Filter;
  bool colorEnabled = true;
  uint16_t assign = 0x8421;
  float padDry[kNumDecks] = {NAN, NAN, NAN, NAN};
  std::vector<float> mL, mR, cL, cR;  // master and cue buses
};

Mixer::Mixer() : impl_(std::make_unique<Impl>()) {}
Mixer::~Mixer() = default;

void Mixer::prepare(double sampleRate, int maxBlockFrames) {
  Impl& m = *impl_;
  for (auto& u : m.panel) u.prepare(sampleRate, maxBlockFrames);
  for (auto& u : m.pad) u.prepare(sampleRate, maxBlockFrames);
  m.master.prepare(sampleRate, maxBlockFrames);
  m.color.prepare(sampleRate, maxBlockFrames);
  m.sampler.prepare(sampleRate, maxBlockFrames);
  m.limiter.prepare(sampleRate);
  m.mL.assign(static_cast<size_t>(maxBlockFrames), 0.0f);
  m.mR.assign(static_cast<size_t>(maxBlockFrames), 0.0f);
  m.cL.assign(static_cast<size_t>(maxBlockFrames), 0.0f);
  m.cR.assign(static_cast<size_t>(maxBlockFrames), 0.0f);
}

void Mixer::setInsert(IInsert* insert) noexcept { impl_->insert = insert; }
void Mixer::setRouting(const OutputRouting& r) noexcept { impl_->routing = r; }
void Mixer::setDeckVolume(int d, float v) noexcept { impl_->volume[d] = clampv(v, 0.0f, 1.0f); }
void Mixer::setDeckTrim(int d, float v) noexcept { impl_->trim[d] = clampv(v, -1.0f, 1.0f); }
void Mixer::setDeckEq(int d, EqBand b, float v) noexcept { impl_->eq[d][static_cast<int>(b)] = clampv(v, -1.0f, 1.0f); }
void Mixer::setDeckColor(int d, float v) noexcept { impl_->color[d] = clampv(v, -1.0f, 1.0f); }
void Mixer::setDeckPfl(int d, bool on) noexcept { impl_->pfl[d] = on; }
void Mixer::setCrossfader(float x) noexcept { impl_->crossfader = clampv(x, 0.0f, 1.0f); }
void Mixer::setXfSide(int d, XfSide s) noexcept { impl_->sides[d] = s; }
void Mixer::setMasterVolume(float v) noexcept { impl_->masterVolume = clampv(v, 0.0f, 1.0f); }
void Mixer::setMasterFilter(float v) noexcept { impl_->masterFilter = clampv(v, -1.0f, 1.0f); }
void Mixer::setColorType(ColorType t) noexcept { impl_->colorType = t; }
void Mixer::setColorEnabled(bool on) noexcept { impl_->colorEnabled = on; }
void Mixer::setFxAssign(uint16_t bits) noexcept { impl_->assign = bits; }
void Mixer::setPadFx(int d, bool on, FxType type, float beats, float level) noexcept {
  FxUnit& u = impl_->pad[d];
  if (on) {
    u.setType(type);
    u.setBeatsMult(beats);
    u.setLevel(level);
  }
  u.setEnabled(on);
}
void Mixer::setPadDryHold(int d, float dry) noexcept { impl_->padDry[d] = dry; }

FxUnit& Mixer::fx(FxUnitId id) noexcept {
  if (id.kind == FxUnitId::Pad) return impl_->pad[id.index % kNumDecks];
  if (id.kind == FxUnitId::Master) return impl_->master;
  return impl_->panel[id.index % kNumFxUnits];
}
FxUnit& Mixer::panelFx(int u) noexcept { return impl_->panel[u]; }
FxUnit& Mixer::padFx(int d) noexcept { return impl_->pad[d]; }
FxUnit& Mixer::masterFx() noexcept { return impl_->master; }
ColorFx& Mixer::colorFx() noexcept { return impl_->color; }
Sampler& Mixer::sampler() noexcept { return impl_->sampler; }

void Mixer::process(const DeckInput[kNumDecks], int frames, const BlockClock&) noexcept {
  Impl& m = *impl_;
  const size_t n = static_cast<size_t>(frames);
  std::memset(m.mL.data(), 0, n * sizeof(float));
  std::memset(m.mR.data(), 0, n * sizeof(float));
  std::memset(m.cL.data(), 0, n * sizeof(float));
  std::memset(m.cR.data(), 0, n * sizeof(float));
}

void Mixer::writeOutput(float* interleaved, int frames, int channels) const noexcept {
  std::memset(interleaved, 0, sizeof(float) * static_cast<size_t>(frames) * static_cast<size_t>(channels));
}

const float* Mixer::masterL() const noexcept { return impl_->mL.data(); }
const float* Mixer::masterR() const noexcept { return impl_->mR.data(); }
const float* Mixer::cueL() const noexcept { return impl_->cL.data(); }
const float* Mixer::cueR() const noexcept { return impl_->cR.data(); }

MixView Mixer::mixView() const noexcept {
  const Impl& m = *impl_;
  MixView v;
  const float x = m.crossfader;
  const float gA = x <= 0.5f ? 1.0f : (1.0f - x) * 2.0f;  // engine.js applyCrossfader "mix" curve
  const float gB = x >= 0.5f ? 1.0f : x * 2.0f;
  for (int d = 0; d < kNumDecks; d++) {
    v.volume[d] = m.volume[d];
    v.eqLow[d] = m.eq[d][0];
    v.xfGain[d] = m.sides[d] == XfSide::A ? gA : gB;
  }
  return v;
}

void Mixer::fxRackView(FxRackView& v) const noexcept {
  const Impl& m = *impl_;
  auto view = [](const FxUnit& u) {
    FxUnitView f;
    f.enabled = u.enabled();
    f.type = u.type();
    f.level = u.level();
    f.beatsMult = u.beatsMult();
    return f;
  };
  for (int i = 0; i < kNumFxUnits; i++) v.panel[i] = view(m.panel[i]);
  for (int i = 0; i < kNumDecks; i++) v.pad[i] = view(m.pad[i]);
  v.master = view(m.master);
  v.assign = m.assign;
}

float Mixer::deckVolume(int d) const noexcept { return impl_->volume[d]; }

void Mixer::snapshot(MixerSnapshot& s) const noexcept { s = MixerSnapshot(); }

}  // namespace om
