// Color FX bus effects of the channel FILTER knobs (owner: fx): the five
// echo loops of engine.js _colorDefs (fixed times and feedbacks, 0.5 s
// lines, output = the loop's filter or shaper like buildEchoLoop's `out`),
// the "Space" reverb (2.8 s / decay 2.2 shared kernel) and the crush
// (crushCurve(5)); the echo chains and the reverb are built lazily off the
// audio thread. Drift-free loops (SPEC.md §20); chains not routed are frozen.
// SPEC.md §11.4, §11.5.
#include <cmath>
#include <cstring>
#include <new>

#include "fx_chain.h"
#include "fx_dsp.h"
#include "om/color_fx.h"

namespace om {

namespace {

constexpr double kColorLineSeconds = 0.5;  // the color echo times never exceed 0.35 s

// engine.js _colorDefs
struct ColorSpec {
  double time;
  double fb;
  bool hasFilter;
  dsp::BiquadType filter;
  float freq, q;  // q: Web Audio default 1 unless given
  int crush;      // crushCurve steps in the loop (0: none)
};
ColorSpec colorSpec(ColorType t) noexcept {
  using BT = dsp::BiquadType;
  switch (t) {
    case ColorType::DubEcho: return {0.35, 0.55, true, BT::Highpass, 250.0f, 1.0f, 0};
    case ColorType::HpfEcho: return {0.3, 0.5, true, BT::Highpass, 900.0f, 1.0f, 0};
    case ColorType::LpfEcho: return {0.3, 0.5, true, BT::Lowpass, 650.0f, 1.0f, 0};
    case ColorType::BpfEcho: return {0.3, 0.55, true, BT::Bandpass, 1000.0f, 1.0f, 0};
    case ColorType::CrushEcho: return {0.3, 0.5, false, BT::Highpass, 0, 0, 6};
    default: return {0, 0, false, BT::Highpass, 0, 0, 0};
  }
}

bool isEcho(ColorType t) noexcept {
  return t == ColorType::DubEcho || t == ColorType::HpfEcho || t == ColorType::LpfEcho || t == ColorType::BpfEcho ||
         t == ColorType::CrushEcho;
}

inline void zero2(float* l, float* r, int n) noexcept {
  std::memset(l, 0, sizeof(float) * static_cast<size_t>(n));
  std::memset(r, 0, sizeof(float) * static_cast<size_t>(n));
}

}  // namespace

struct ColorFx::Impl {
  ColorType type = ColorType::Filter;
  double sr = 48000;
  int maxBlock = kMaxBlockFrames;
  bool prepared = false;
  std::shared_ptr<const ConvolverKernel> reverbKernel;
  FxChain* chains[kNumColorTypes] = {};  // owned once attached
  float crush[fx::kCurveLength] = {};     // cCrush: crushCurve(5)

  bool setupChain(FxChain& c, ColorType t) {
    c.type = static_cast<uint8_t>(t);
    c.color = true;
    c.sampleRate = sr;
    if (t == ColorType::Reverb) {
      if (!c.reverb) c.reverb = std::make_unique<Convolver>();
      c.reverb->prepare(reverbKernel, maxBlock);
      c.born = true;
      return true;
    }
    const ColorSpec s = colorSpec(t);
    // A 0.5 s line read like engine.js's createDelay(4) (buildEchoLoop maxT).
    c.allocLines(1, static_cast<int>(std::ceil(kColorLineSeconds * sr)) + 4, fx::chromiumDelayBufferLength(4.0, sr));
    c.delay.set(s.time);  // DelayNode.delayTime.value = time
    c.fb.set(s.fb);       // feedback GainNode.gain.value = fb
    c.fbBase = s.fb;
    c.hasFilter = s.hasFilter;
    if (s.hasFilter)
      c.filterCoeffs = dsp::webAudioBiquad(s.filter, sr, static_cast<double>(s.freq), static_cast<double>(s.q), 0.0);
    c.filter[0].reset();
    c.filter[1].reset();
    if (s.crush > 0) {
      c.curve.assign(fx::kCurveLength, 0.0f);
      fx::makeCrushCurve(s.crush, c.curve.data());
    }
    c.born = true;
    return true;
  }

  // buildEchoLoop: in -> delay -> [filter | shaper] -> fb -> delay; out = the last node.
  void processEcho(FxChain& c, const float* inL, const float* inR, float* outL, float* outR, int n) noexcept {
    fx::Lines& L = c.lines;
    float* bl = L.line(0, 0);
    float* br = L.line(0, 1);
    const float* curve = c.curve.empty() ? nullptr : c.curve.data();
    const float desired = static_cast<float>(c.delay.value()) * static_cast<float>(sr);  // static delayTime
    const float g = static_cast<float>(c.fb.value());
    for (int i = 0; i < n; i++) {
      const float xl = inL[i], xr = inR[i];
      const fx::Tap tp = fx::chromiumTap(L, desired);
      float yl, yr;
      if (L.valid >= L.len) {
        yl = fx::readTap(bl, tp);
        yr = fx::readTap(br, tp);
      } else {
        yl = fx::readTapValid(bl, tp, L.valid);
        yr = fx::readTapValid(br, tp, L.valid);
      }
      if (c.hasFilter) {
        yl = fx::biquadTick(c.filterCoeffs, c.filter[0], yl);
        yr = fx::biquadTick(c.filterCoeffs, c.filter[1], yr);
      }
      if (curve) {
        yl = fx::shape(curve, yl);
        yr = fx::shape(curve, yr);
      }
      bl[L.w] = xl + g * yl;
      br[L.w] = xr + g * yr;
      L.advance();
      outL[i] = yl;
      outR[i] = yr;
    }
    c.filter[0].flushTiny();
    c.filter[1].flushTiny();
  }
};

ColorFx::ColorFx() : impl_(std::make_unique<Impl>()) {}
ColorFx::~ColorFx() {
  for (FxChain*& c : impl_->chains) {
    FxChainDeleter()(c);
    c = nullptr;
  }
}

void ColorFx::prepare(double sampleRate, int maxBlockFrames, std::shared_ptr<const ConvolverKernel> reverbKernel) {
  Impl& m = *impl_;
  m.prepared = false;
  m.sr = sampleRate > 0 ? sampleRate : 48000.0;
  m.maxBlock = maxBlockFrames > 0 ? maxBlockFrames : kMaxBlockFrames;
  m.reverbKernel = std::move(reverbKernel);
  fx::makeCrushCurve(5, m.crush);
  for (int t = 0; t < kNumColorTypes; t++)
    if (m.chains[t]) m.setupChain(*m.chains[t], static_cast<ColorType>(t));
  m.prepared = true;
}

bool ColorFx::isLazy(ColorType t) noexcept { return isEcho(t) || t == ColorType::Reverb; }

FxChainPtr ColorFx::makeChain(ColorType t) const {
  if (!isLazy(t)) return nullptr;
  FxChainPtr c(new (std::nothrow) FxChain());
  if (!c) return nullptr;
  try {
    if (!impl_->setupChain(*c, t)) return nullptr;
  } catch (...) {
    return nullptr;
  }
  return c;
}

size_t ColorFx::memoryBytes() const noexcept {
  size_t b = sizeof(Impl);
  for (const FxChain* c : impl_->chains)
    if (c) b += c->bytes();
  return b;
}

FxChain* ColorFx::attachChain(ColorType t, FxChain* chain) noexcept {
  Impl& m = *impl_;
  if (!chain || !isLazy(t)) return chain;
  FxChain*& slot = m.chains[static_cast<int>(t)];
  if (slot) return chain;
  if (!chain->color || chain->type != static_cast<uint8_t>(t) || chain->sampleRate != m.sr) return chain;
  slot = chain;
  return nullptr;
}

bool ColorFx::hasChain(ColorType t) const noexcept { return !isLazy(t) || impl_->chains[static_cast<int>(t)] != nullptr; }

void ColorFx::setType(ColorType t) noexcept {
  if (static_cast<int>(t) < 0 || static_cast<int>(t) >= kNumColorTypes) return;
  impl_->type = t;
}
ColorType ColorFx::type() const noexcept { return impl_->type; }

void ColorFx::reset() noexcept {
  for (FxChain* c : impl_->chains)
    if (c) c->clear();
}

void ColorFx::process(const float* inL, const float* inR, float* outL, float* outR, int n) noexcept {
  Impl& m = *impl_;
  if (n <= 0) return;
  if (m.prepared) {
    const ColorType t = m.type;
    FxChain* c = m.chains[static_cast<int>(t)];
    if (isEcho(t) && c && c->lines.count > 0) {
      m.processEcho(*c, inL, inR, outL, outR, n);
      return;
    }
    if (t == ColorType::Reverb && c && c->reverb) {
      c->reverb->process(inL, inR, outL, outR, n);
      return;
    }
    if (t == ColorType::Crush) {
      for (int i = 0; i < n; i++) {
        outL[i] = fx::shape(m.crush, inL[i]);
        outR[i] = fx::shape(m.crush, inR[i]);
      }
      return;
    }
  }
  zero2(outL, outR, n);  // filter / noise (mixer), or memory not attached yet
}

}  // namespace om
