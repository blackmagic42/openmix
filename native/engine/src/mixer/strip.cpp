// Channel strip of the native mixer and the filters shared with the master
// bus (owner: mixer): biquads with Chromium's direct form I, EQ bands with
// per-frame coefficients while their gain moves, the DJ filter, and the
// strip's gains / taps / sends. See strip.h. Real-time safe after prepare().
#include "strip.h"

#include <cfloat>
#include <cmath>
#include <cstring>

namespace om {
namespace mixer_detail {

// ---------------------------------------------------------------------------
// Biquads
// ---------------------------------------------------------------------------
void biquadBlock(const dsp::BiquadCoeffs& k, BiquadState& s, float* x, int n) noexcept {
  const double b0 = k.b0, b1 = k.b1, b2 = k.b2, a1 = k.a1, a2 = k.a2;
  double x1 = s.x1, x2 = s.x2, y1 = s.y1, y2 = s.y2;
  for (int i = 0; i < n; i++) {
    const float in = x[i];
    const float y = static_cast<float>(b0 * in + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2);
    x2 = x1;
    x1 = in;
    y2 = y1;
    y1 = y;
    x[i] = y;
  }
  s.x1 = x1;
  s.x2 = x2;
  s.y1 = y1;
  s.y2 = y2;
}

void biquadIdentity(BiquadState& s, const float* x, int n) noexcept {
  if (n <= 0) return;
  if (n >= 2) {
    s.x2 = x[n - 2];
    s.x1 = x[n - 1];
  } else {
    s.x2 = s.x1;
    s.x1 = x[0];
  }
  s.y1 = s.x1;
  s.y2 = s.x2;
}

void biquadFlush(BiquadState& s) noexcept {
  // Not in Chromium: a state poisoned by a non-finite input would keep the
  // filter silent forever; start again from rest instead (finite signals are
  // never affected).
  if (!(std::fabs(s.x1) + std::fabs(s.x2) + std::fabs(s.y1) + std::fabs(s.y2) <= 1.0e300)) {
    s = BiquadState();
    return;
  }
  // Chromium Biquad::Process: no stream of subnormals once the input is silent
  if (s.x1 == 0.0 && s.x2 == 0.0 && (s.y1 != 0.0 || s.y2 != 0.0) && std::fabs(s.y1) < FLT_MIN &&
      std::fabs(s.y2) < FLT_MIN) {
    s.y1 = 0.0;
    s.y2 = 0.0;
  }
  // DenormalDisabler::FlushDenormalFloatToZero on the state
  auto flush = [](double& v) {
    if (v != 0.0 && std::fabs(v) < FLT_MIN) v = 0.0;
  };
  flush(s.x1);
  flush(s.x2);
  flush(s.y1);
  flush(s.y2);
}

// ---------------------------------------------------------------------------
// Cascade of constant-coefficient biquads (see strip.h)
// ---------------------------------------------------------------------------
namespace {
// N biquads in series, both channels, sample by sample. The expression of
// each stage is biquadBlock's, character for character.
template <int N>
void cascadeKernel(const dsp::BiquadCoeffs* const* k, BiquadState* const* st, float* l, float* r, int n) noexcept {
  double b0[N], b1[N], b2[N], a1[N], a2[N];
  double lx1[N], lx2[N], ly1[N], ly2[N], rx1[N], rx2[N], ry1[N], ry2[N];
  for (int j = 0; j < N; j++) {
    b0[j] = k[j]->b0;
    b1[j] = k[j]->b1;
    b2[j] = k[j]->b2;
    a1[j] = k[j]->a1;
    a2[j] = k[j]->a2;
    const BiquadState& L = st[j][0];
    const BiquadState& R = st[j][1];
    lx1[j] = L.x1, lx2[j] = L.x2, ly1[j] = L.y1, ly2[j] = L.y2;
    rx1[j] = R.x1, rx2[j] = R.x2, ry1[j] = R.y1, ry2[j] = R.y2;
  }
  for (int i = 0; i < n; i++) {
    float vl = l[i], vr = r[i];
    for (int j = 0; j < N; j++) {
      const float inL = vl;
      const float yl = static_cast<float>(b0[j] * inL + b1[j] * lx1[j] + b2[j] * lx2[j] - a1[j] * ly1[j] - a2[j] * ly2[j]);
      lx2[j] = lx1[j];
      lx1[j] = inL;
      ly2[j] = ly1[j];
      ly1[j] = yl;
      vl = yl;
      const float inR = vr;
      const float yr = static_cast<float>(b0[j] * inR + b1[j] * rx1[j] + b2[j] * rx2[j] - a1[j] * ry1[j] - a2[j] * ry2[j]);
      rx2[j] = rx1[j];
      rx1[j] = inR;
      ry2[j] = ry1[j];
      ry1[j] = yr;
      vr = yr;
    }
    l[i] = vl;
    r[i] = vr;
  }
  for (int j = 0; j < N; j++) {
    BiquadState& L = st[j][0];
    BiquadState& R = st[j][1];
    L.x1 = lx1[j], L.x2 = lx2[j], L.y1 = ly1[j], L.y2 = ly2[j];
    R.x1 = rx1[j], R.x2 = rx2[j], R.y1 = ry1[j], R.y2 = ry2[j];
  }
}
}  // namespace

void Cascade::run(float* l, float* r, int n) noexcept {
  if (n <= 0) return;
  // identity stages fed by the cascade input: their history is the input itself
  for (int i = 0; i < ni_; i++) {
    if (src_[i] >= 0) continue;
    biquadIdentity(id_[i][0], l, n);
    biquadIdentity(id_[i][1], r, n);
  }
  switch (nb_) {
    case 1: cascadeKernel<1>(k_, s_, l, r, n); break;
    case 2: cascadeKernel<2>(k_, s_, l, r, n); break;
    case 3: cascadeKernel<3>(k_, s_, l, r, n); break;
    case 4: cascadeKernel<4>(k_, s_, l, r, n); break;
    default: break;
  }
  // identity stages fed by biquad j: its last two outputs (before the flush,
  // as the identity stage would have stored the samples it received)
  for (int i = 0; i < ni_; i++) {
    if (src_[i] < 0) continue;
    const BiquadState* from = s_[src_[i]];
    for (int c = 0; c < 2; c++) {
      BiquadState& s = id_[i][c];
      if (n >= 2) {
        s.x2 = from[c].y2;
        s.x1 = from[c].y1;
      } else {
        s.x2 = s.x1;
        s.x1 = from[c].y1;
      }
      s.y1 = s.x1;
      s.y2 = s.x2;
    }
  }
  for (int j = 0; j < nb_; j++) {
    biquadFlush(s_[j][0]);
    biquadFlush(s_[j][1]);
  }
}

// ---------------------------------------------------------------------------
// EQ band
// ---------------------------------------------------------------------------
void EqFilter::prepare(dsp::BiquadType type, float frequency, float q, double sampleRate) noexcept {
  type_ = type;
  sampleRate_ = sampleRate;
  frequency_ = static_cast<double>(frequency);
  q_ = static_cast<double>(q);
  // the same normalization as dsp::webAudioBiquad (and Chromium)
  const double nyquist = 0.5 * sampleRate;
  double f = nyquist > 0 ? frequency_ / nyquist : 0.0;
  if (f < 0) f = 0;
  if (f > 1) f = 1;
  f_ = f;
  const double w0 = kPi * f;
  sinw0_ = std::sin(w0);
  cosw0_ = std::cos(w0);
  gain_.prepare(sampleRate);
  gain_.reset(gain_.target());
  kValid_ = false;
}

void EqFilter::snapGainDb(float db) noexcept {
  gain_.reset(db);
  kValid_ = false;
}

dsp::BiquadCoeffs EqFilter::coeffs(double gainDb) const noexcept {
  using dsp::BiquadCoeffs;
  using dsp::detail::normalized;
  // Same operations, in the same order, as dsp::webAudioBiquad: only sin(w0)
  // and cos(w0) are cached (the frequency of a band never changes).
  const double A = std::pow(10.0, gainDb / 40.0);
  switch (type_) {
    case dsp::BiquadType::Lowshelf: {
      if (f_ == 1) return BiquadCoeffs{A * A, 0, 0, 0, 0};
      if (f_ <= 0) return BiquadCoeffs{1, 0, 0, 0, 0};
      const double alpha = 0.5 * sinw0_ * std::sqrt(2.0);
      const double k = cosw0_;
      const double k2 = 2 * std::sqrt(A) * alpha;
      const double ap = A + 1, am = A - 1;
      return normalized(A * (ap - am * k + k2), 2 * A * (am - ap * k), A * (ap - am * k - k2), ap + am * k + k2,
                        -2 * (am + ap * k), ap + am * k - k2);
    }
    case dsp::BiquadType::Highshelf: {
      if (f_ == 1) return BiquadCoeffs{1, 0, 0, 0, 0};
      if (f_ <= 0) return BiquadCoeffs{A * A, 0, 0, 0, 0};
      const double alpha = 0.5 * sinw0_ * std::sqrt(2.0);
      const double k = cosw0_;
      const double k2 = 2 * std::sqrt(A) * alpha;
      const double ap = A + 1, am = A - 1;
      return normalized(A * (ap + am * k + k2), -2 * A * (am + ap * k), A * (ap + am * k - k2), ap - am * k + k2,
                        2 * (am - ap * k), ap - am * k - k2);
    }
    case dsp::BiquadType::Peaking: {
      const double qq = q_ > 0 ? q_ : 0;
      if (f_ > 0 && f_ < 1) {
        if (qq > 0) {
          const double alpha = sinw0_ / (2 * qq);
          const double k = cosw0_;
          return normalized(1 + alpha * A, -2 * k, 1 - alpha * A, 1 + alpha / A, -2 * k, 1 - alpha / A);
        }
        return BiquadCoeffs{A * A, 0, 0, 0, 0};
      }
      return BiquadCoeffs{1, 0, 0, 0, 0};
    }
    default:
      return dsp::webAudioBiquad(type_, sampleRate_, frequency_, q_, gainDb);
  }
}

void EqFilter::addStatic(Cascade& c) noexcept {
  const float g = gain_.value();
  if (g == 0.0f && s_[0].transparent() && s_[1].transparent()) {
    // 0 dB: coefficients b == a, transparent state: filtering returns x exactly
    c.addIdentity(s_);
    return;
  }
  if (!kValid_ || kGain_ != g) {
    k_ = coeffs(g);
    kGain_ = g;
    kValid_ = true;
  }
  c.addBiquad(&k_, s_);
}

void EqFilter::process(float* l, float* r, int n, int64_t f0, float* scratch) noexcept {
  if (gain_.idle()) {
    Cascade c;
    addStatic(c);
    c.run(l, r, n);
    return;
  }
  // Gain under automation: coefficients per frame (Chromium's sample-accurate path)
  gain_.fill(scratch, n, f0);
  BiquadState& L = s_[0];
  BiquadState& R = s_[1];
  double lx1 = L.x1, lx2 = L.x2, ly1 = L.y1, ly2 = L.y2;
  double rx1 = R.x1, rx2 = R.x2, ry1 = R.y1, ry2 = R.y2;
  dsp::BiquadCoeffs k = k_;
  float kg = kGain_;
  bool kv = kValid_;
  for (int i = 0; i < n; i++) {
    const float g = scratch[i];
    if (!kv || g != kg) {
      k = coeffs(g);
      kg = g;
      kv = true;
    }
    const float inL = l[i];
    const float yl = static_cast<float>(k.b0 * inL + k.b1 * lx1 + k.b2 * lx2 - k.a1 * ly1 - k.a2 * ly2);
    lx2 = lx1;
    lx1 = inL;
    ly2 = ly1;
    ly1 = yl;
    l[i] = yl;
    const float inR = r[i];
    const float yr = static_cast<float>(k.b0 * inR + k.b1 * rx1 + k.b2 * rx2 - k.a1 * ry1 - k.a2 * ry2);
    rx2 = rx1;
    rx1 = inR;
    ry2 = ry1;
    ry1 = yr;
    r[i] = yr;
  }
  L.x1 = lx1;
  L.x2 = lx2;
  L.y1 = ly1;
  L.y2 = ly2;
  R.x1 = rx1;
  R.x2 = rx2;
  R.y1 = ry1;
  R.y2 = ry2;
  biquadFlush(L);
  biquadFlush(R);
  k_ = k;
  kGain_ = kg;
  kValid_ = kv;
}

// ---------------------------------------------------------------------------
// DJ filter
// ---------------------------------------------------------------------------
void DjFilter::prepare(double sampleRate) noexcept {
  sampleRate_ = sampleRate;
  computeCoeffs();
}

void DjFilter::set(double v) noexcept {
  v = clampv(v, -1.0, 1.0);
  Kind kind;
  float freq;
  if (std::fabs(v) < 0.04) {
    kind = Kind::Neutral;  // peaking, gain 0, 1 kHz: transparent
    freq = 1000.0f;
  } else if (v > 0) {
    kind = Kind::Highpass;
    freq = static_cast<float>(20.0 * std::pow(400.0, v));  // 20 Hz -> 8 kHz
  } else {
    kind = Kind::Lowpass;
    freq = static_cast<float>(20000.0 * std::pow(80.0 / 20000.0, -v));  // 20 kHz -> 80 Hz
  }
  if (kind != kind_) resetState();  // Chromium BiquadProcessor::SetType resets the filter on a type change
  kind_ = kind;
  freq_ = freq;
  computeCoeffs();
}

namespace {
// Lowpass / highpass coefficients as Chromium computes them (biquad.cc,
// SetLowpassParams / SetHighpassParams): dsp::webAudioBiquad's formulas,
// except that the linear resonance 10^(Q/20) is rounded to FLOAT. Pinned by
// Chromium's renders: the golden filter sweeps (strip/filter_sweep,
// master/filter_sweep) null bit-exactly with it; a double resonance leaves
// 1-ulp flips that the low-cutoff recursions grow to -110 dBFS.
dsp::BiquadCoeffs chromiumPass(bool high, double sampleRate, double frequency, double qDb) noexcept {
  const double nyquist = 0.5 * sampleRate;
  double f = nyquist > 0 ? frequency / nyquist : 0.0;
  if (f < 0) f = 0;
  if (f > 1) f = 1;
  if (f == 1) return high ? dsp::BiquadCoeffs{0, 0, 0, 0, 0} : dsp::BiquadCoeffs{1, 0, 0, 0, 0};
  if (f <= 0) return high ? dsp::BiquadCoeffs{1, 0, 0, 0, 0} : dsp::BiquadCoeffs{0, 0, 0, 0, 0};
  const double res = static_cast<double>(static_cast<float>(std::pow(10.0, qDb / 20.0)));
  const double theta = kPi * f;
  const double alpha = std::sin(theta) / (2 * res);
  const double cosw = std::cos(theta);
  const double beta = high ? (1 + cosw) / 2 : (1 - cosw) / 2;
  return dsp::detail::normalized(beta, high ? -2 * beta : 2 * beta, beta, 1 + alpha, -2 * cosw, 1 - alpha);
}
}  // namespace

void DjFilter::computeCoeffs() noexcept {
  const double q = static_cast<double>(0.9f);  // the AudioParam holds a float
  switch (kind_) {
    case Kind::Neutral:
      k_ = dsp::webAudioBiquad(dsp::BiquadType::Peaking, sampleRate_, 1000.0, q, 0.0);
      break;
    case Kind::Highpass:
      k_ = chromiumPass(true, sampleRate_, static_cast<double>(freq_), q);
      break;
    case Kind::Lowpass:
      k_ = chromiumPass(false, sampleRate_, static_cast<double>(freq_), q);
      break;
  }
}

void DjFilter::addStatic(Cascade& c) noexcept {
  if (kind_ == Kind::Neutral && s_[0].transparent() && s_[1].transparent())
    c.addIdentity(s_);  // peaking 0 dB, transparent state: filtering returns x exactly
  else
    c.addBiquad(&k_, s_);
}

void DjFilter::process(float* l, float* r, int n) noexcept {
  Cascade c;
  addStatic(c);
  c.run(l, r, n);
}

// ---------------------------------------------------------------------------
// Gain helpers
// ---------------------------------------------------------------------------
void applyGain(AParam& p, const float* srcL, const float* srcR, float* dstL, float* dstR, int n, int64_t f0,
               float* scratch) noexcept {
  if (p.idle()) {
    const float g = p.value();
    if (g == 1.0f) {
      if (dstL != srcL) std::memcpy(dstL, srcL, sizeof(float) * static_cast<size_t>(n));
      if (dstR != srcR) std::memcpy(dstR, srcR, sizeof(float) * static_cast<size_t>(n));
      return;
    }
    for (int i = 0; i < n; i++) {
      dstL[i] = srcL[i] * g;
      dstR[i] = srcR[i] * g;
    }
    return;
  }
  p.fill(scratch, n, f0);
  for (int i = 0; i < n; i++) {
    dstL[i] = srcL[i] * scratch[i];
    dstR[i] = srcR[i] * scratch[i];
  }
}

void addGain(AParam& p, const float* srcL, const float* srcR, float* dstL, float* dstR, int n, int64_t f0,
             float* scratch) noexcept {
  if (p.idle()) {
    const float g = p.value();
    if (g == 0.0f) return;
    if (g == 1.0f) {
      addInto(srcL, srcR, dstL, dstR, n);
      return;
    }
    for (int i = 0; i < n; i++) {
      dstL[i] += srcL[i] * g;
      dstR[i] += srcR[i] * g;
    }
    return;
  }
  p.fill(scratch, n, f0);
  for (int i = 0; i < n; i++) {
    dstL[i] += srcL[i] * scratch[i];
    dstR[i] += srcR[i] * scratch[i];
  }
}

void addInto(const float* srcL, const float* srcR, float* dstL, float* dstR, int n) noexcept {
  for (int i = 0; i < n; i++) {
    dstL[i] += srcL[i];
    dstR[i] += srcR[i];
  }
}

namespace {
inline void advance(AParam& p, int n, int64_t f0) noexcept {
  if (!p.idle()) p.fill(nullptr, n, f0);
}
}  // namespace

// ---------------------------------------------------------------------------
// Channel strip
// ---------------------------------------------------------------------------
void ChannelStrip::prepare(double sampleRate, int maxFrames, double meterWindowSec) {
  sampleRate_ = sampleRate;
  AParam* params[] = {&trim_, &fader_, &xf, &dry, &cue, &color, &noise, &pad, &send[0], &send[1], &send[2], &send[3]};
  for (AParam* p : params) {
    p->prepare(sampleRate);
    p->reset(p->target());  // a rate change ends running automations at their targets
  }
  eq_[0].prepare(dsp::BiquadType::Lowshelf, 200.0f, 1.0f, sampleRate);
  eq_[1].prepare(dsp::BiquadType::Peaking, 1000.0f, 0.9f, sampleRate);
  eq_[2].prepare(dsp::BiquadType::Highshelf, 8000.0f, 1.0f, sampleRate);
  filter_.prepare(sampleRate);
  for (auto& b : eq_) b.resetState();
  filter_.resetState();
  meter_.prepare(sampleRate, meterWindowSec, 128);
  scratch_.assign(static_cast<size_t>(maxFrames > 0 ? maxFrames : 1), 0.0f);
}

void ChannelStrip::resetDefaults() noexcept {
  trim_.reset(1.0f);                            // 4^0
  fader_.reset(static_cast<float>(0.85 * 0.85));  // engine.js: fader.gain.value = volume * volume
  xf.reset(1.0f);
  dry.reset(1.0f);
  cue.reset(0.0f);
  color.reset(0.0f);
  noise.reset(0.0f);
  pad.reset(0.0f);
  for (auto& s : send) s.reset(0.0f);
  for (auto& b : eq_) {
    b.snapGainDb(0.0f);
    b.resetState();
  }
  filter_.set(0.0);
  filter_.resetState();
  meter_.reset();
}

void ChannelStrip::setTrim(double v, int64_t frame) noexcept {
  trim_.setTarget(static_cast<float>(std::pow(4.0, v)), kKnobTau, frame);
}

void ChannelStrip::setEq(int band, double v, int64_t frame) noexcept {
  if (band < 0 || band > 2) return;
  const double db = v >= 0 ? v * 6 : v * 40;
  eq_[band].setGainDb(static_cast<float>(db), frame);
}

void ChannelStrip::setVolume(double v, int64_t frame) noexcept {
  fader_.setTarget(static_cast<float>(v * v), kKnobTau, frame);
}

void ChannelStrip::front(const float* inL, const float* inR, float* l, float* r, int n, int64_t f0) noexcept {
  float* s = scratch_.data();
  if (!inL || !inR) {
    std::memset(l, 0, sizeof(float) * static_cast<size_t>(n));
    std::memset(r, 0, sizeof(float) * static_cast<size_t>(n));
    advance(trim_, n, f0);
  } else {
    applyGain(trim_, inL, inR, l, r, n, f0, s);
  }
  if (eq_[0].gainParam().idle() && eq_[1].gainParam().idle() && eq_[2].gainParam().idle()) {
    // no EQ automation: the four filters as one fused cascade (same results)
    Cascade c;
    for (auto& b : eq_) b.addStatic(c);
    filter_.addStatic(c);
    c.run(l, r, n);
    return;
  }
  // an EQ knob is moving: per-frame coefficients for that band (Chromium's
  // sample-accurate path), each filter in turn
  for (auto& b : eq_) b.process(l, r, n, f0, s);
  filter_.process(l, r, n);
}

void ChannelStrip::back(const float* l, const float* r, float* xfL, float* xfR, int n, int64_t f0,
                        const StripBuses& b) noexcept {
  float* s = scratch_.data();
  meter_.process(l, r, n);
  // pre-fader taps of `post`
  if (b.cueL) addGain(cue, l, r, b.cueL, b.cueR, n, f0, s);
  else advance(cue, n, f0);
  if (b.colorL) addGain(color, l, r, b.colorL, b.colorR, n, f0, s);
  else if (!b.colorFrozen) advance(color, n, f0);
  // fader input = post + Color noise (the shared mono source, upmixed L = R)
  if (b.noise && !noise.constantAt(0.0f)) {
    const float* nz = b.noise;
    if (noise.idle()) {
      const float g = noise.value();
      for (int i = 0; i < n; i++) {
        const float x = nz[i] * g;
        xfL[i] = l[i] + x;
        xfR[i] = r[i] + x;
      }
    } else {
      noise.fill(s, n, f0);
      for (int i = 0; i < n; i++) {
        const float x = nz[i] * s[i];
        xfL[i] = l[i] + x;
        xfR[i] = r[i] + x;
      }
    }
    applyGain(fader_, xfL, xfR, xfL, xfR, n, f0, s);
  } else {
    advance(noise, n, f0);
    applyGain(fader_, l, r, xfL, xfR, n, f0, s);
  }
  // crossfader side gain
  applyGain(xf, xfL, xfR, xfL, xfR, n, f0, s);
  // FX sends and the pad send tap xf (before dryOut: the wet is never cut)
  for (int u = 0; u < kNumFxUnits; u++) {
    if (b.fxL[u]) addGain(send[u], xfL, xfR, b.fxL[u], b.fxR[u], n, f0, s);
    else if (!b.fxFrozen[u]) advance(send[u], n, f0);
  }
  if (b.padL) addGain(pad, xfL, xfR, b.padL, b.padR, n, f0, s);
  else if (!b.padFrozen) advance(pad, n, f0);
  // dryOut -> master sum
  if (b.dryL) addGain(dry, xfL, xfR, b.dryL, b.dryR, n, f0, s);
  else advance(dry, n, f0);
}

}  // namespace mixer_detail
}  // namespace om
