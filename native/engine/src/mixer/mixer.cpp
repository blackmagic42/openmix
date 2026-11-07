// The native mixer (owner: mixer): the engine.js audio graph after the decks.
// Per deck: channel strip (strip.h: TRIM, EQ, FILTER), the two-phase VST
// insert point (IInsert::begin for every deck, the decks without an insert
// and the sampler meanwhile, then IInsert::end), `post` taps (PFL cue send,
// meter, Color send), fader + Color noise, crossfader, FX sends (latched by
// updateFxSends on the live assign matrix) and the pad send, dryOut with the
// per-deck FX dry cut. Master: masterGain -> dryComp -> post bus <- fxReturn
// (panel / pad wets + 0.85 x Color FX bus, gain = master volume) <- master FX
// wet (fed by masterGain) <- sampler voices; master filter -> master meter
// -> limiter -> master 1/2 (+ recorder); cue bus -> 3/4 or the phones card.
// FX seam: the units are IFxProcessor / IColorProcessor pointers attached
// by the core; their parameters live in mirrors here (a unit attached later
// gets them at once; fxRackView never depends on a unit). Every engine.js
// AudioParam ramp is reproduced frame by frame (aparam.h), including
// Chromium's frozen automations of sends that engine.js's graph does not pull
// (Color sends in the "filter" / "noise" modes, sends of disabled FX and pad
// units: strip.h). The Color "noise" source is engine.js's: a 2 s buffer of
// uniform white noise looped from the engine's first frame. Robustness beyond Chromium (no effect on finite
// signals): a non-finite sample coming back from a plugin insert is zeroed,
// and the master and cue buses never carry one to the device. Real-time
// safe: no allocation outside prepare(). SPEC.md §10.
#include "om/mixer.h"

#include <cmath>
#include <cstring>
#include <vector>

#include "strip.h"

namespace om {

using mixer_detail::addGain;
using mixer_detail::addInto;
using mixer_detail::AParam;
using mixer_detail::applyGain;
using mixer_detail::ChannelStrip;
using mixer_detail::DjFilter;
using mixer_detail::StripBuses;

namespace {
constexpr double kMeterWindowSec = 0.05;    // >= 3 state periods at 60 Hz: no peak missed between two reads
constexpr float kColorWet = 0.85f;          // engine.js colorWet.gain
constexpr double kKnobTau = 0.01;           // setTargetAtTime(..., 0.01)
constexpr double kSendTau = 0.015;          // updateFxSends
constexpr double kPadOnTau = 0.01;          // setPadFx on
constexpr double kPadOffTau = 0.02;         // setPadFx off
constexpr double kDryTau = 0.02;            // syncLock dry cut
constexpr double kDryCompTau = 0.05;        // syncLock dryComp
constexpr double kHysteresis = 0.01;        // dry cut / dryComp target changes
constexpr float kDefaultVolume = 0.85f;
constexpr float kDefaultMasterVolume = 0.9f;
constexpr uint16_t kDefaultAssign = 0x8421;  // unit u processes deck u
constexpr double kNoiseBufferSec = 2.0;      // engine.js: createBuffer(1, sampleRate * 2, sampleRate), looped
constexpr uint32_t kNoiseSeed = 0x2545F491u;

// Replaces every non-finite sample by 0 (a plugin may output NaN / Inf; one
// such sample would otherwise poison every filter state after it).
inline void sanitize(float* x, int n) noexcept {
  for (int i = 0; i < n; i++)
    if (!(std::fabs(x[i]) <= 3.0e38f)) x[i] = 0.0f;
}

// What the mixer remembers of one FX unit (engine.js FxUnit fields).
struct UnitMirror {
  FxUnitView view;
  bool requested = false;  // engine.js padFx[i] / masterFx != null (panel units: always)
  IFxProcessor* unit = nullptr;
  void push() const noexcept {
    if (!unit) return;
    unit->setType(view.type);
    unit->setBeatsMult(view.beatsMult);
    unit->setLevel(view.level);
    unit->setEnabled(view.enabled);
  }
  float wet() const noexcept { return unit ? unit->wetGain() : 0.0f; }
};

inline void advance(AParam& p, int n, int64_t f0) noexcept {
  if (!p.idle()) p.fill(nullptr, n, f0);
}

// Color types that feed the Color FX bus ("filter" and "noise" live in the strips).
inline bool colorHasBus(ColorType t) noexcept { return t != ColorType::Filter && t != ColorType::Noise; }
}  // namespace

struct Mixer::Impl {
  double sampleRate = 48000.0;
  int maxFrames = 0;
  int64_t frame = 0;  // frames rendered: the quantum phase of every AudioParam emulation

  ChannelStrip strip[kNumDecks];
  // knob values (engine.js fields) for the views and the re-applications
  float volume[kNumDecks];
  float trim[kNumDecks];
  float eq[kNumDecks][3];
  float colorKnob[kNumDecks];
  bool pfl[kNumDecks];
  XfSide sides[kNumDecks];
  float padDry[kNumDecks];   // deck._padDryHold (NaN = null)
  double dryCur[kNumDecks];  // deck._dryCur (NaN = undefined)
  double dryTarget = kNaN;   // engine._dryTarget
  float crossfader = 0.5f;
  float masterVolume = kDefaultMasterVolume;
  float masterFilterV = 0.0f;
  ColorType colorType = ColorType::Filter;
  bool colorEnabled = true;

  UnitMirror units[kNumFxSlots];  // fxSlotIndex(): panel 0-3, pad 4-7, master 8
  uint16_t assign = kDefaultAssign;  // the LIVE engine.js fxAssign (fx.assign)
  IColorProcessor* color = nullptr;
  IInsert* insert = nullptr;

  AParam masterGain, fxReturn, dryComp;
  DjFilter masterFilter;
  MeterWindow masterMeter, cueMeter;
  Limiter limiter;
  Sampler sampler;
  OutputRouting routing;
  std::vector<float> noiseBuf;  // engine.js noiseSrc: 2 s of Math.random() * 2 - 1, looped from frame 0

  // block buffers (prepare)
  std::vector<float> arena;
  float* postL[kNumDecks] = {};
  float* postR[kNumDecks] = {};
  float* xfL[kNumDecks] = {};
  float* xfR[kNumDecks] = {};
  float* fxL[kNumFxUnits] = {};
  float* fxR[kNumFxUnits] = {};
  float* padL[kNumDecks] = {};
  float* padR[kNumDecks] = {};
  float* sumL = nullptr;   // decks' dryOut sum (masterGain input)
  float* sumR = nullptr;
  float* mgL = nullptr;    // masterGain output
  float* mgR = nullptr;
  float* mstL = nullptr;   // post bus -> master filter -> limiter: the master output
  float* mstR = nullptr;
  float* cueL = nullptr;
  float* cueR = nullptr;
  float* colL = nullptr;   // Color FX bus
  float* colR = nullptr;
  float* retL = nullptr;   // fxReturn input
  float* retR = nullptr;
  float* wetL = nullptr;   // one unit's output
  float* wetR = nullptr;
  float* noise = nullptr;  // shared Color noise source (mono)
  float* zero = nullptr;   // silence for units without a send
  float* scratch = nullptr;
  bool insertActive[kNumDecks] = {};

  Impl() {
    for (int u = 0; u < kNumFxUnits; u++) units[u].requested = true;  // the 4 panel units always exist
    resetKnobs();
    for (auto& s : strip) s.resetDefaults();
    masterGain.reset(kDefaultMasterVolume);
    fxReturn.reset(kDefaultMasterVolume);
    dryComp.reset(1.0f);
    masterFilter.set(0.0);
  }

  void resetKnobs() noexcept {
    for (int d = 0; d < kNumDecks; d++) {
      volume[d] = kDefaultVolume;
      trim[d] = 0;
      eq[d][0] = eq[d][1] = eq[d][2] = 0;
      colorKnob[d] = 0;
      pfl[d] = false;
      padDry[d] = NAN;
      dryCur[d] = kNaN;
    }
    sides[0] = XfSide::A;
    sides[1] = XfSide::B;
    sides[2] = XfSide::A;
    sides[3] = XfSide::B;
    dryTarget = kNaN;
    crossfader = 0.5f;
    masterVolume = kDefaultMasterVolume;
    masterFilterV = 0.0f;
    colorType = ColorType::Filter;
    colorEnabled = true;
    assign = kDefaultAssign;
  }

  void allocate(int n) {
    maxFrames = n;
    const size_t N = static_cast<size_t>(n);
    // 2 x (post, xf, pad) per deck + 2 x fx bus + sum, mg, mst, cue, col, ret, wet + noise, zero, scratch
    const size_t buffers = 2 * (3 * kNumDecks + kNumFxUnits + 7) + 3;
    arena.assign(buffers * N, 0.0f);
    float* p = arena.data();
    auto take = [&]() {
      float* q = p;
      p += N;
      return q;
    };
    for (int d = 0; d < kNumDecks; d++) {
      postL[d] = take();
      postR[d] = take();
      xfL[d] = take();
      xfR[d] = take();
      padL[d] = take();
      padR[d] = take();
    }
    for (int u = 0; u < kNumFxUnits; u++) {
      fxL[u] = take();
      fxR[u] = take();
    }
    sumL = take();
    sumR = take();
    mgL = take();
    mgR = take();
    mstL = take();
    mstR = take();
    cueL = take();
    cueR = take();
    colL = take();
    colR = take();
    retL = take();
    retR = take();
    wetL = take();
    wetR = take();
    noise = take();
    zero = take();
    scratch = take();
    // the shared Color noise source (one buffer, every deck's noise gain reads it)
    size_t len = static_cast<size_t>(sampleRate * kNoiseBufferSec);
    if (len < 1) len = 1;
    noiseBuf.assign(len, 0.0f);
    dsp::WhiteNoise gen(kNoiseSeed);
    for (float& x : noiseBuf) x = gen.next();
  }

  // The looped noise source for frames [f0, f0 + n): a pointer into the
  // buffer, or the block copied into `noise` when it wraps.
  const float* noiseBlock(int64_t f0, int n) noexcept {
    const int64_t len = static_cast<int64_t>(noiseBuf.size());
    const int64_t at = f0 % len;
    if (at + n <= len) return noiseBuf.data() + at;
    int64_t k = at;
    for (int i = 0; i < n; i++) {
      noise[i] = noiseBuf[static_cast<size_t>(k)];
      if (++k == len) k = 0;
    }
    return noise;
  }

  // engine.js setDeckColor(i, filterVal)
  void applyDeckColor(int d) noexcept {
    ChannelStrip& s = strip[d];
    const double v = colorKnob[d];
    const double amt = std::fabs(v);
    float colorSend = 0.0f, noiseGain = 0.0f;
    if (!colorEnabled) {
      s.setFilter(0.0);
    } else if (colorType == ColorType::Filter) {
      s.setFilter(v);
    } else if (colorType == ColorType::Noise) {
      s.setFilter(0.0);
      noiseGain = static_cast<float>(amt * amt * 0.4);
    } else {
      s.setFilter(0.0);
      colorSend = static_cast<float>(amt);
    }
    s.color.setTarget(colorSend, kKnobTau, frame);
    s.noise.setTarget(noiseGain, kKnobTau, frame);
  }

  // engine.js applyCrossfader(): "mix" curve
  void applyCrossfader() noexcept {
    const double x = crossfader;
    const double gA = x <= 0.5 ? 1 : (1 - x) * 2;
    const double gB = x >= 0.5 ? 1 : x * 2;
    for (int d = 0; d < kNumDecks; d++)
      strip[d].xf.setTarget(static_cast<float>(sides[d] == XfSide::A ? gA : gB), kKnobTau, frame);
  }

  // engine.js syncLock(): per-deck FX dry cut and the master dry compensation
  void updateDryCut(int64_t f0) noexcept {
    for (int d = 0; d < kNumDecks; d++) {
      double cut = 0;
      for (int u = 0; u < kNumFxUnits; u++) {
        const UnitMirror& U = units[u];
        if (!U.view.enabled || !((assign >> (u * 4 + d)) & 1u)) continue;
        double lv = U.wet();
        if (!(lv == lv)) lv = 0;  // `|| 0`
        if (lv > 1) lv = 1;
        const double c = fxDryCut(U.view.type) * lv;
        if (c > cut) cut = c;
      }
      double dry = 1 - cut;
      const UnitMirror& P = units[kNumFxUnits + d];
      if (P.requested && P.view.enabled && !std::isnan(padDry[d]) && padDry[d] < dry) dry = padDry[d];
      const double cur = std::isnan(dryCur[d]) ? 1.0 : dryCur[d];
      if (std::fabs(cur - dry) > kHysteresis) {
        dryCur[d] = dry;
        strip[d].dry.setTarget(static_cast<float>(dry), kDryTau, f0);
      }
    }
    const UnitMirror& M = units[8];
    double mWet = 0;
    if (M.requested && M.view.enabled) {
      mWet = M.wet();
      if (!(mWet == mWet)) mWet = 0;
      if (mWet > 1) mWet = 1;
    }
    const double dryT = 1 - (M.requested ? fxDryCut(M.view.type) : 0.45) * mWet;
    const double cur = std::isnan(dryTarget) ? 1.0 : dryTarget;
    if (std::fabs(cur - dryT) > kHysteresis) {
      dryTarget = dryT;
      dryComp.setTarget(static_cast<float>(dryT), kDryCompTau, f0);
    }
  }

  // Which sends engine.js's graph pulls this block (strip.h: frozen sends).
  struct Pulled {
    bool color = true;                            // the Color bus is routed (a bus type)
    bool fx[kNumFxUnits] = {true, true, true, true};  // the unit is enabled (its input is connected)
    bool pad[kNumDecks] = {true, true, true, true};   // the pad unit exists and is enabled
  };

  StripBuses busesFor(int d, bool cueOn, bool colorOn, const bool fxOn[kNumFxUnits], const bool padOn[kNumDecks],
                      const Pulled& pulled, const float* noiseSrc) noexcept {
    StripBuses b;
    if (cueOn) {
      b.cueL = cueL;
      b.cueR = cueR;
    }
    if (colorOn) {
      b.colorL = colL;
      b.colorR = colR;
    }
    b.colorFrozen = !pulled.color;
    for (int u = 0; u < kNumFxUnits; u++) {
      if (fxOn[u]) {
        b.fxL[u] = fxL[u];
        b.fxR[u] = fxR[u];
      }
      b.fxFrozen[u] = !pulled.fx[u];
    }
    if (padOn[d]) {
      b.padL = padL[d];
      b.padR = padR[d];
    }
    b.padFrozen = !pulled.pad[d];
    b.dryL = sumL;
    b.dryR = sumR;
    b.noise = noiseSrc;
    return b;
  }

  void process(const DeckInput in[kNumDecks], int n, const BlockClock& clk) noexcept {
    const int64_t f0 = frame;
    const size_t bytes = sizeof(float) * static_cast<size_t>(n);
    updateDryCut(f0);

    // Sends whose destination engine.js does not pull are frozen, like
    // Chromium's unprocessed nodes: the color sends while the Color type has
    // no bus ("filter", "noise": _routeColor disconnects colorBus), the FX
    // sends of a disabled unit and the pad send of a disabled pad unit
    // (FxUnit._route disconnects its input). They resume from their frozen
    // values (aparam.h), e.g. a unit enabled again gets its latched send back
    // at once, as in the Web engine.
    Pulled pulled;
    pulled.color = colorHasBus(colorType);
    for (int u = 0; u < kNumFxUnits; u++) pulled.fx[u] = units[u].view.enabled;
    for (int d = 0; d < kNumDecks; d++) {
      const UnitMirror& P = units[kNumFxUnits + d];
      pulled.pad[d] = P.requested && P.view.enabled;
    }
    // which buses carry signal this block (a send at a constant 0 adds nothing)
    bool cueOn = false, colorOn = false, noiseOn = false;
    bool fxOn[kNumFxUnits] = {false, false, false, false};
    bool padOn[kNumDecks];
    for (int d = 0; d < kNumDecks; d++) {
      const ChannelStrip& s = strip[d];
      cueOn |= !s.cue.constantAt(0.0f);
      colorOn |= pulled.color && !s.color.constantAt(0.0f);
      noiseOn |= !s.noise.constantAt(0.0f);
      for (int u = 0; u < kNumFxUnits; u++) fxOn[u] |= pulled.fx[u] && !s.send[u].constantAt(0.0f);
      padOn[d] = pulled.pad[d] && !s.pad.constantAt(0.0f);
    }
    std::memset(sumL, 0, bytes);
    std::memset(sumR, 0, bytes);
    std::memset(mstL, 0, bytes);
    std::memset(mstR, 0, bytes);
    std::memset(cueL, 0, bytes);
    std::memset(cueR, 0, bytes);
    if (colorOn) {
      std::memset(colL, 0, bytes);
      std::memset(colR, 0, bytes);
    }
    for (int u = 0; u < kNumFxUnits; u++) {
      if (!fxOn[u]) continue;
      std::memset(fxL[u], 0, bytes);
      std::memset(fxR[u], 0, bytes);
    }
    for (int d = 0; d < kNumDecks; d++) {
      if (!padOn[d]) continue;
      std::memset(padL[d], 0, bytes);
      std::memset(padR[d], 0, bytes);
    }
    const float* noiseSrc = noiseOn ? noiseBlock(f0, n) : nullptr;

    // phase 1: every strip up to its FILTER, then hand the blocks to the inserts
    for (int d = 0; d < kNumDecks; d++) {
      strip[d].front(in[d].l, in[d].r, postL[d], postR[d], n, f0);
      insertActive[d] = insert != nullptr && insert->begin(d, postL[d], postR[d], n);
    }
    // phase 2: the decks without an active insert and the sampler, while the plugins run
    for (int d = 0; d < kNumDecks; d++) {
      if (insertActive[d]) continue;
      strip[d].back(postL[d], postR[d], xfL[d], xfR[d], n, f0, busesFor(d, cueOn, colorOn, fxOn, padOn, pulled, noiseSrc));
    }
    sampler.render(mstL, mstR, n, clk);  // post bus: after the master volume, before the master filter
    // phase 3: collect the plugin outputs (or their latency-aligned dry) and finish those strips
    for (int d = 0; d < kNumDecks; d++) {
      if (!insertActive[d]) continue;
      insert->end(d, postL[d], postR[d], n);
      sanitize(postL[d], n);  // plugin output: never let a NaN / Inf into the strip, the cue or the buses
      sanitize(postR[d], n);
      strip[d].back(postL[d], postR[d], xfL[d], xfR[d], n, f0, busesFor(d, cueOn, colorOn, fxOn, padOn, pulled, noiseSrc));
    }

    // master: masterGain -> (master FX send) -> dryComp -> post bus
    applyGain(masterGain, sumL, sumR, mgL, mgR, n, f0, scratch);
    UnitMirror& M = units[8];
    if (M.unit) {
      M.unit->process(mgL, mgR, wetL, wetR, n);  // master FX wet goes straight into the post bus
      if (M.view.enabled) addInto(wetL, wetR, mstL, mstR, n);
    }
    addGain(dryComp, mgL, mgR, mstL, mstR, n, f0, scratch);

    // FX returns: panel units, pad units, Color FX bus (x 0.85) -> fxReturn (master volume)
    bool anyReturn = false;
    for (int u = 0; u < kNumFxUnits; u++) {
      UnitMirror& U = units[u];
      if (!U.unit) continue;
      const float* inL = fxOn[u] ? fxL[u] : zero;
      const float* inR = fxOn[u] ? fxR[u] : zero;
      U.unit->process(inL, inR, wetL, wetR, n);
      if (!U.view.enabled) continue;  // disabled = no output (IFxProcessor contract)
      if (!anyReturn) {
        std::memcpy(retL, wetL, bytes);
        std::memcpy(retR, wetR, bytes);
        anyReturn = true;
      } else {
        addInto(wetL, wetR, retL, retR, n);
      }
    }
    for (int d = 0; d < kNumDecks; d++) {
      UnitMirror& P = units[kNumFxUnits + d];
      if (!P.unit) continue;
      const float* inL = padOn[d] ? padL[d] : zero;
      const float* inR = padOn[d] ? padR[d] : zero;
      P.unit->process(inL, inR, wetL, wetR, n);
      if (!P.view.enabled) continue;
      if (!anyReturn) {
        std::memcpy(retL, wetL, bytes);
        std::memcpy(retR, wetR, bytes);
        anyReturn = true;
      } else {
        addInto(wetL, wetR, retL, retR, n);
      }
    }
    if (color) {
      color->process(colorOn ? colL : zero, colorOn ? colR : zero, wetL, wetR, n);
      if (colorHasBus(colorType)) {
        if (!anyReturn) {
          for (int i = 0; i < n; i++) {
            retL[i] = wetL[i] * kColorWet;
            retR[i] = wetR[i] * kColorWet;
          }
          anyReturn = true;
        } else {
          for (int i = 0; i < n; i++) {
            retL[i] += wetL[i] * kColorWet;
            retR[i] += wetR[i] * kColorWet;
          }
        }
      }
    }
    if (anyReturn)
      addGain(fxReturn, retL, retR, mstL, mstR, n, f0, scratch);
    else
      advance(fxReturn, n, f0);

    // post bus -> master filter -> master meter -> limiter
    masterFilter.process(mstL, mstR, n);
    masterMeter.process(mstL, mstR, n);
    limiter.process(mstL, mstR, n);
    // a non-finite sample must never reach the device, the phones or the recording
    sanitize(mstL, n);
    sanitize(mstR, n);
    if (cueOn) {
      sanitize(cueL, n);
      sanitize(cueR, n);
    }
    cueMeter.process(cueL, cueR, n);
    frame += n;
  }
};

Mixer::Mixer() : impl_(std::make_unique<Impl>()) { prepare(48000.0, kMaxBlockFrames); }
Mixer::~Mixer() = default;

void Mixer::prepare(double sampleRate, int maxBlockFrames) {
  Impl& m = *impl_;
  m.sampleRate = sampleRate > 0 ? sampleRate : 48000.0;
  const int n = maxBlockFrames > 0 ? maxBlockFrames : kMaxBlockFrames;
  for (auto& s : m.strip) s.prepare(m.sampleRate, n, kMeterWindowSec);
  for (AParam* p : {&m.masterGain, &m.fxReturn, &m.dryComp}) {
    p->prepare(m.sampleRate);
    p->reset(p->target());
  }
  m.masterFilter.prepare(m.sampleRate);
  m.masterFilter.resetState();
  m.masterMeter.prepare(m.sampleRate, kMeterWindowSec, 128);
  m.cueMeter.prepare(m.sampleRate, kMeterWindowSec, 128);
  m.limiter.prepare(m.sampleRate);
  m.sampler.prepare(m.sampleRate, n);
  m.allocate(n);
}

void Mixer::setInsert(IInsert* insert) noexcept { impl_->insert = insert; }

IFxProcessor* Mixer::attachFx(FxUnitId id, IFxProcessor* unit) noexcept {
  UnitMirror& u = impl_->units[fxSlotIndex(id)];
  IFxProcessor* old = u.unit;
  u.unit = unit;
  u.push();
  return old;
}

IColorProcessor* Mixer::attachColor(IColorProcessor* color) noexcept {
  IColorProcessor* old = impl_->color;
  impl_->color = color;
  if (color) color->setType(impl_->colorType);
  return old;
}

void Mixer::setFx(FxUnitId id, uint8_t mask, FxType type, bool enabled, float level, float beats) noexcept {
  UnitMirror& u = impl_->units[fxSlotIndex(id)];
  u.requested = true;  // fx.set on the master unit = engine.js ensureMasterFx(); a pad unit exists from then on
  if (mask & kFxType) u.view.type = type;
  if (mask & kFxBeats) u.view.beatsMult = beats;
  if (mask & kFxLevel) u.view.level = clampv(level, 0.0f, 1.0f);
  if (mask & kFxEnabled) u.view.enabled = enabled;
  if (!u.unit) return;
  if (mask & kFxType) u.unit->setType(type);
  if (mask & kFxBeats) u.unit->setBeatsMult(beats);
  if (mask & kFxLevel) u.unit->setLevel(u.view.level);
  if (mask & kFxEnabled) u.unit->setEnabled(enabled);
}

void Mixer::ensureMasterFx() noexcept { impl_->units[fxSlotIndex(masterUnit())].requested = true; }

bool Mixer::fxRequested(FxUnitId id) const noexcept { return impl_->units[fxSlotIndex(id)].requested; }

// app.js's frame loop calls setBeatDur() on ENABLED units only (panel, pad
// and master): a disabled unit keeps the beat duration it had when it was
// switched off, and its delay lines glide (tau 80 ms) from that stale value
// once enabled again. Same here: the core's per-block clock reaches enabled
// units only; on the block a unit is enabled the new clock arrives and the
// glide starts (FxUnit::setBeatClock itself stays engine.js setBeatDur,
// which works on a disabled unit: the FX goldens drive it that way).
void Mixer::setFxBeatClock(FxUnitId id, const BeatClock& bc) noexcept {
  const UnitMirror& m = impl_->units[fxSlotIndex(id)];
  if (m.unit && m.view.enabled) m.unit->setBeatClock(bc);
}

void Mixer::setFxAssign(uint16_t bits) noexcept { impl_->assign = bits; }

void Mixer::updateFxSends() noexcept {
  Impl& m = *impl_;
  for (int d = 0; d < kNumDecks; d++) {
    for (int u = 0; u < kNumFxUnits; u++) {
      const bool on = m.units[u].view.enabled && ((m.assign >> (u * 4 + d)) & 1u);
      m.strip[d].send[u].setTarget(on ? 1.0f : 0.0f, kSendTau, m.frame);
    }
  }
}

void Mixer::setPadFx(int d, bool on, FxType type, float beats, float level) noexcept {
  if (d < 0 || d >= kNumDecks) return;
  Impl& m = *impl_;
  UnitMirror& u = m.units[fxSlotIndex(padUnit(d))];
  if (!u.requested) {
    if (!on) return;     // engine.js: no pad unit yet and nothing to stop
    u.requested = true;  // created on first use (memory: the control thread, SPEC.md §11.5)
  }
  if (on) {
    u.view.type = type;
    u.view.beatsMult = beats;
    u.view.level = clampv(level, 0.0f, 1.0f);
    u.view.enabled = true;
    if (u.unit) {
      u.unit->setType(type);
      u.unit->setBeatsMult(beats);
      u.unit->setLevel(u.view.level);
      u.unit->setEnabled(true);
    }
    m.strip[d].pad.setTarget(1.0f, kPadOnTau, m.frame);
  } else {
    m.strip[d].pad.setTarget(0.0f, kPadOffTau, m.frame);
    u.view.enabled = false;
    if (u.unit) u.unit->setEnabled(false);
  }
}

void Mixer::setRouting(const OutputRouting& r) noexcept { impl_->routing = r; }

void Mixer::setDeckVolume(int d, float v) noexcept {
  if (d < 0 || d >= kNumDecks) return;
  Impl& m = *impl_;
  m.volume[d] = clampv(v, 0.0f, 1.0f);
  m.strip[d].setVolume(m.volume[d], m.frame);
}

void Mixer::setDeckTrim(int d, float v) noexcept {
  if (d < 0 || d >= kNumDecks) return;
  Impl& m = *impl_;
  m.trim[d] = clampv(v, -1.0f, 1.0f);
  m.strip[d].setTrim(m.trim[d], m.frame);
}

void Mixer::setDeckEq(int d, EqBand b, float v) noexcept {
  if (d < 0 || d >= kNumDecks) return;
  Impl& m = *impl_;
  const int band = static_cast<int>(b);
  if (band < 0 || band > 2) return;
  m.eq[d][band] = clampv(v, -1.0f, 1.0f);
  m.strip[d].setEq(band, m.eq[d][band], m.frame);
}

void Mixer::setDeckColor(int d, float v) noexcept {
  if (d < 0 || d >= kNumDecks) return;
  impl_->colorKnob[d] = clampv(v, -1.0f, 1.0f);
  impl_->applyDeckColor(d);
}

void Mixer::setDeckPfl(int d, bool on) noexcept {
  if (d < 0 || d >= kNumDecks) return;
  Impl& m = *impl_;
  m.pfl[d] = on;
  m.strip[d].cue.setTarget(on ? 1.0f : 0.0f, kKnobTau, m.frame);
}

void Mixer::setXfSide(int d, XfSide s) noexcept {
  if (d < 0 || d >= kNumDecks) return;
  impl_->sides[d] = s;
  impl_->applyCrossfader();
}

void Mixer::setPadDryHold(int d, float dry) noexcept {
  if (d < 0 || d >= kNumDecks) return;
  impl_->padDry[d] = std::isnan(dry) ? NAN : clampv(dry, 0.0f, 1.0f);
}

void Mixer::setCrossfader(float x) noexcept {
  impl_->crossfader = clampv(x, 0.0f, 1.0f);
  impl_->applyCrossfader();
}

void Mixer::setMasterVolume(float v) noexcept {
  Impl& m = *impl_;
  m.masterVolume = clampv(v, 0.0f, 1.0f);
  m.masterGain.setTarget(m.masterVolume, kKnobTau, m.frame);
  m.fxReturn.setTarget(m.masterVolume, kKnobTau, m.frame);
}

void Mixer::setMasterFilter(float v) noexcept {
  Impl& m = *impl_;
  m.masterFilterV = clampv(v, -1.0f, 1.0f);
  m.masterFilter.set(m.masterFilterV);
}

void Mixer::setColorType(ColorType t) noexcept {
  Impl& m = *impl_;
  m.colorType = t;
  if (m.color) m.color->setType(t);
  for (int d = 0; d < kNumDecks; d++) m.applyDeckColor(d);  // re-apply each knob in the new mode
}

void Mixer::setColorEnabled(bool on) noexcept {
  Impl& m = *impl_;
  m.colorEnabled = on;
  for (int d = 0; d < kNumDecks; d++) m.applyDeckColor(d);
}

void Mixer::resetToDefaults() noexcept {
  Impl& m = *impl_;
  for (int i = 0; i < kNumFxSlots; i++) {
    m.units[i].view = FxUnitView();
    m.units[i].requested = i < kNumFxUnits;
    m.units[i].push();
  }
  m.resetKnobs();
  for (auto& s : m.strip) s.resetDefaults();
  m.masterGain.reset(kDefaultMasterVolume);
  m.fxReturn.reset(kDefaultMasterVolume);
  m.dryComp.reset(1.0f);
  m.masterFilter.set(0.0);
  m.masterFilter.resetState();
  m.masterMeter.reset();
  m.cueMeter.reset();
  if (m.color) m.color->setType(m.colorType);
  m.sampler.stopAll();
}

Sampler& Mixer::sampler() noexcept { return impl_->sampler; }

void Mixer::process(const DeckInput in[kNumDecks], int frames, const BlockClock& clk) noexcept {
  Impl& m = *impl_;
  if (frames <= 0 || m.maxFrames <= 0) return;
  if (frames > m.maxFrames) frames = m.maxFrames;  // the core never sends more than prepared
  m.process(in, frames, clk);
}

void Mixer::writeOutput(float* interleaved, int frames, int channels) const noexcept {
  const Impl& m = *impl_;
  if (!interleaved || frames <= 0 || channels <= 0) return;
  if (frames > m.maxFrames) frames = m.maxFrames;
  std::memset(interleaved, 0, sizeof(float) * static_cast<size_t>(frames) * static_cast<size_t>(channels));
  const OutputRouting& r = m.routing;
  if (channels == 1 && r.masterL == 0 && r.masterR == 1) {
    // a mono endpoint: the Web Audio "speakers" down-mix of the stereo master
    for (int i = 0; i < frames; i++) interleaved[i] = 0.5f * (m.mstL[i] + m.mstR[i]);
    return;
  }
  auto put = [&](int ch, const float* bus) {
    if (ch < 0 || ch >= channels) return;
    for (int i = 0; i < frames; i++) interleaved[static_cast<size_t>(i) * channels + ch] = bus[i];
  };
  put(r.masterL, m.mstL);
  put(r.masterR, m.mstR);
  put(r.cueL, m.cueL);
  put(r.cueR, m.cueR);
}

const float* Mixer::masterL() const noexcept { return impl_->mstL; }
const float* Mixer::masterR() const noexcept { return impl_->mstR; }
const float* Mixer::cueL() const noexcept { return impl_->cueL; }
const float* Mixer::cueR() const noexcept { return impl_->cueR; }
int Mixer::masterLatencyFrames() const noexcept { return impl_->limiter.latencyFrames(); }

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
  for (int i = 0; i < kNumFxUnits; i++) v.panel[i] = m.units[i].view;
  for (int i = 0; i < kNumDecks; i++) {
    v.pad[i] = m.units[kNumFxUnits + i].view;
    v.padExists[i] = m.units[kNumFxUnits + i].requested;
  }
  v.master = m.units[8].view;
  v.masterExists = m.units[8].requested;
  v.assign = m.assign;
}

float Mixer::deckVolume(int d) const noexcept { return (d >= 0 && d < kNumDecks) ? impl_->volume[d] : 0.0f; }

void Mixer::deckMeters(int d, float& peak, float& rms, float& dry) const noexcept {
  if (d < 0 || d >= kNumDecks) {
    peak = rms = 0.0f;
    dry = 1.0f;
    return;
  }
  const ChannelStrip& s = impl_->strip[d];
  peak = s.meter().peak();
  rms = s.meter().rms();
  dry = s.dry.value();
}

void Mixer::snapshot(om_mixer_state& s) const noexcept {
  const Impl& m = *impl_;
  s = om_mixer_state();
  s.master_peak = m.masterMeter.peak();
  s.master_rms = m.masterMeter.rms();
  s.cue_peak = m.cueMeter.peak();
  s.gain_reduction_db = m.limiter.gainReductionDb();
  s.dry_comp = m.dryComp.value();
  for (int i = 0; i < kNumFxUnits; i++) s.fx_wet[i] = m.units[i].wet();
  for (int i = 0; i < kNumDecks; i++) s.pad_wet[i] = m.units[kNumFxUnits + i].wet();
  s.master_wet = m.units[8].wet();
  s.sampler_dropped = m.sampler.droppedTriggers();
}

}  // namespace om
