// Private DSP helpers of the fx module (owner: fx): the Web Audio pieces the
// FX units are made of, reproduced the way Chromium computes them so the
// native effects null against golden renders of engine.js (SPEC.md §11.1):
//  - Param: an AudioParam driven by `.value =` and setTargetAtTime (the value
//    used for a sample is the current one, then one exponential step; float
//    values; converged like Chromium, bit-exact against its renders);
//  - delay-line reads with DelayNode's linear interpolation;
//  - biquad ticks with Chromium's arithmetic (double state, float output fed
//    back), one sample at a time for feedback loops and per-sample
//    coefficients;
//  - the OscillatorNode phase accumulator (double read index in table units,
//    float increment) and the band-limited, normalized "square" PeriodicWave
//    tables with Chromium's table selection and 2/3/5-point interpolation;
//  - the WaveShaperNode curve of engine.js crushCurve(steps).
// Real-time safe except where marked "control thread".
#pragma once

#include <cmath>
#include <cstdint>
#include <memory>
#include <vector>

#include "om/common.h"
#include "om/dsp.h"

namespace om {
namespace fx {

// ---------------------------------------------------------------------------
// AudioParam with `.value =` and setTargetAtTime, computed like Chromium's
// AudioParamTimeline::ProcessSetTarget so that automations are bit-exact:
// values are produced per 128-frame render quantum (aligned on the owner's
// frame counter, i.e. the context timeline in the golden renders), in FLOAT:
// the first value of a quantum is one exponential step from the last value
// computed (or the closed form at the event's own frame), the rest by
// Chromium's 4-step unrolled recursion (c0 = 1 - exp(-1 / (rate * tau)),
// c1 = c0 (2 - c0), c2 = c0 ((c0 - 3) c0 + 3), c3 = c0 (c0 ((4 - c0) c0 - 6)
// + 4)); the event converges (the target is output) once 10 time constants
// have passed since it started, or when |target - v| < exp(-10) |v|. A param
// whose node is not processed is not computed: a running event resumes from
// its last value (one step, and converged at once if 10 time constants went
// by); an event first computed late starts there (value unchanged).
// ---------------------------------------------------------------------------
class Param {
 public:
  static constexpr int kQuantum = 128;
  // AudioParam.value = v (immediate, static).
  void set(double v) noexcept {
    v_ = target_ = last_ = static_cast<float>(v);
    active_ = false;
    cacheQ_ = -1;
  }
  // setTargetAtTime(target, t, tau) where t is the time of frame `frame`
  // (the next frame the owner will process).
  void setTarget(double target, double tau, double sampleRate, int64_t frame) noexcept {
    target_ = static_cast<float>(target);
    const float tauF = static_cast<float>(tau);
    if (!(tauF > 0) || !(sampleRate > 0)) {
      v_ = last_ = target_;
      active_ = false;
      cacheQ_ = -1;
      return;
    }
    sr_ = sampleRate;
    tau_ = tauF;
    const float c0 = static_cast<float>(1.0 - std::exp(-1.0 / (sampleRate * static_cast<double>(tauF))));
    c_[0] = c0;
    c_[1] = c0 * (2 - c0);
    c_[2] = c0 * ((c0 - 3) * c0 + 3);
    c_[3] = c0 * (c0 * ((4 - c0) * c0 - 6) + 4);
    started_ = false;  // starts at the first frame it is computed (see fill)
    active_ = true;
    // The event replaces the automation from `frame` on: values already
    // computed for that quantum stay valid before it (both kernels' values
    // for a per-channel param, atKernel).
    if (cacheQ_ >= 0 && frame >= cacheQ_ * kQuantum && frame < (cacheQ_ + 1) * kQuantum) {
      const int off = static_cast<int>(frame - cacheQ_ * kQuantum);
      const bool pair = pairQ_ == cacheQ_;
      const float rStart = pair && off > 0 ? valsR_[off - 1] : v_;
      fill(cacheQ_, off);
      if (pair) fillSecond(cacheQ_, off, true, rStart);
    } else {
      cacheQ_ = -1;
    }
  }
  // Value at `frame` (any order within a quantum; quanta in increasing order).
  // A quantum is computed from the first frame of it that is processed: its
  // start under continuous processing (Chromium always renders whole quanta),
  // or the frame where a node resumes in the middle of one (native blocks).
  float at(int64_t frame) noexcept {
    if (!active_ && cacheQ_ < 0) return last_ = v_;
    const int64_t q = floorDiv(frame);
    if (q != cacheQ_) {
      if (!active_) {
        cacheQ_ = -1;
        return last_ = v_;
      }
      fill(q, static_cast<int>(frame - q * kQuantum));
    }
    return last_ = vals_[frame - q * kQuantum];
  }
  // Value at `frame` for channel `ch` (0 left, 1 right) of a param that its
  // node pulls once PER CHANNEL: Chromium's DelayNode, where each channel's
  // AudioDelayDSPKernel computes the delayTime automation itself. On a stereo
  // signal an automation therefore advances twice per render quantum: the
  // left channel takes the first 128 values of the recursion, the right one
  // the next 128 (one step on from the left's last value), and the next
  // quantum continues from the right's last value; on the event's own start
  // quantum both channels start from the event's initial value (measured:
  // with the right channel continuing from the left there, both channels
  // came 127 steps early). A setTargetAtTime
  // glide of a stereo DelayNode thus runs at twice its nominal speed with the
  // right channel ahead (measured: dsp-parity campaign, goldens/fxunit
  // echo_l1_b0.25 / echo_l1_b1 / echo_l1_b0.5_bd0.468; a mono signal would
  // take one kernel, the native engine is always stereo). Use either at() or
  // atKernel() for one param, not both.
  float atKernel(int64_t frame, int ch) noexcept {
    if (!active_ && cacheQ_ < 0) return last_ = v_;
    const int64_t q = floorDiv(frame);
    if (q != cacheQ_) {
      if (!active_) {
        cacheQ_ = -1;
        return last_ = v_;
      }
      const int from = static_cast<int>(frame - q * kQuantum);
      const bool fresh = !started_;
      const float initial = from == 0 ? v_ : last_;  // what fill() starts a fresh event from
      fill(q, from);
      fillSecond(q, from, fresh, fresh ? initial : v_);
    }
    const int i = static_cast<int>(frame - q * kQuantum);
    if (ch == 0) return last_ = vals_[i];
    return valsR_[i];
  }
  // Jumps to the target (rate change with the audio stopped).
  void settle() noexcept {
    v_ = last_ = target_;
    active_ = false;
    cacheQ_ = -1;
  }
  double value() const noexcept { return last_; }  // the last value used (AudioParam.value)
  double target() const noexcept { return target_; }
  bool moving() const noexcept { return active_; }

 private:
  static int64_t floorDiv(int64_t f) noexcept { return f >= 0 ? f / kQuantum : -((-f + kQuantum - 1) / kQuantum); }
  void fill(int64_t q, int from) noexcept {
    const int64_t f0 = q * kQuantum + from;
    float value;
    if (!started_) {
      // First frame this event is computed: its own start, or later when its
      // node was not processed at that time (measured: Chromium then starts
      // it there, value unchanged, its 10-tau clock from there).
      const float in = from == 0 ? v_ : last_;
      value = static_cast<float>(static_cast<double>(target_) + static_cast<double>(in - target_) * 1.0);  // exp(0)
      startTime_ = static_cast<double>(f0) / sr_;
      started_ = true;
    } else {
      value = v_ + (target_ - v_) * c_[0];  // one step from the last value (also after a pause)
    }
    // Chromium's convergence, measured (make_fx_goldens.js --probe-param):
    // more than 10 time constants since the event started, or within exp(-10)
    // of the target (relative; absolute for a target of 0).
    constexpr float kThreshold = 4.539992976248485e-05f;  // exp(-10)
    const double now = static_cast<double>(f0) / sr_;
    const bool converged = now > startTime_ + 10.0 * static_cast<double>(tau_) ||
                           (target_ != 0 && std::fabs(target_ - value) < kThreshold * std::fabs(value)) ||
                           (target_ == 0 && std::fabs(value) < kThreshold);
    if (converged) {
      for (int i = from; i < kQuantum; i++) vals_[i] = target_;
      v_ = target_;
      active_ = false;
    } else {
      int i = from;
      const int trunc = from + ((kQuantum - from) / 4) * 4;
      for (; i < trunc; i += 4) {
        const float delta = target_ - value;
        vals_[i] = value + delta * 0.0f;
        vals_[i + 1] = value + delta * c_[0];
        vals_[i + 2] = value + delta * c_[1];
        vals_[i + 3] = value + delta * c_[2];
        value += delta * c_[3];
      }
      for (; i < kQuantum; i++) {
        vals_[i] = value;
        value += (target_ - value) * c_[0];
      }
      v_ = vals_[kQuantum - 1];
    }
    cacheQ_ = q;
  }
  // The second channel kernel's pass over the same quantum (atKernel): one
  // step on from `start` (the first pass's last value), or `start` itself at
  // the event's own start (then the event's initial value), same
  // convergence rules.
  void fillSecond(int64_t q, int from, bool eventStart, float start) noexcept {
    pairQ_ = q;
    if (!active_) {  // the first pass converged: the target
      for (int i = from; i < kQuantum; i++) valsR_[i] = target_;
      return;
    }
    const int64_t f0 = q * kQuantum + from;
    float value = eventStart ? start : start + (target_ - start) * c_[0];
    constexpr float kThreshold = 4.539992976248485e-05f;  // exp(-10)
    const double now = static_cast<double>(f0) / sr_;
    const bool converged = now > startTime_ + 10.0 * static_cast<double>(tau_) ||
                           (target_ != 0 && std::fabs(target_ - value) < kThreshold * std::fabs(value)) ||
                           (target_ == 0 && std::fabs(value) < kThreshold);
    if (converged) {
      for (int i = from; i < kQuantum; i++) valsR_[i] = target_;
      v_ = target_;
      active_ = false;
      return;
    }
    int i = from;
    const int trunc = from + ((kQuantum - from) / 4) * 4;
    for (; i < trunc; i += 4) {
      const float delta = target_ - value;
      valsR_[i] = value + delta * 0.0f;
      valsR_[i + 1] = value + delta * c_[0];
      valsR_[i + 2] = value + delta * c_[1];
      valsR_[i + 3] = value + delta * c_[2];
      value += delta * c_[3];
    }
    for (; i < kQuantum; i++) {
      valsR_[i] = value;
      value += (target_ - value) * c_[0];
    }
    v_ = valsR_[kQuantum - 1];  // the next quantum continues from the second pass
  }
  float v_ = 0;       // Chromium's last computed value (the quantum's last value)
  float target_ = 0;
  float last_ = 0;    // the last value returned
  float c_[4] = {0, 0, 0, 0};
  float tau_ = 0;
  double sr_ = 48000, startTime_ = 0;
  bool started_ = false;
  bool active_ = false;
  int64_t cacheQ_ = -1;
  int64_t pairQ_ = -1;      // quantum whose second-kernel values are in valsR_
  float vals_[kQuantum] = {};
  float valsR_[kQuantum] = {};  // atKernel: the right channel's values
};

// ---------------------------------------------------------------------------
// Delay lines (Chromium DelayNode buffers): `count` stereo lines sharing one
// write index; line l, channel c at mem + (2 l + c) * len. `w` is the slot of
// the CURRENT sample (written after the reads of a feedback loop, or before
// them like Chromium when nothing depends on the output); `valid` counts the
// frames written since the last clear (older slots read as zero, so a clear
// is O(1) on the audio thread).
//
// Chromium computes a DelayNode's read position in SINGLE precision
// (AudioDelayDSPKernel's vector path, used for every rendering in current
// Chromium, measured: a 0.9029-frame fraction is read as 29/32 at buffer
// positions above 2^18): desired = delayTime * rate, position = writeIndex +
// (bufferLength - desired), wrapped, factor = position - floor(position),
// output = s1 + factor * (s2 - s1). The rounding depends on Chromium's buffer
// length (128 + ceil(maxDelayTime * rate)) and write index (0 when the node
// is created, + 1 per processed frame), kept here as vlen / vw, so a line can
// be shorter than Chromium's buffer (the color echoes) and still read the
// same samples with the same weights.
// ---------------------------------------------------------------------------
inline int chromiumDelayBufferLength(double maxDelaySec, double sampleRate) noexcept {
  return 128 + static_cast<int>(std::ceil(maxDelaySec * sampleRate));
}

struct Lines {
  float* mem = nullptr;
  int len = 0;        // physical frames per line
  int count = 0;
  int w = 0;          // physical slot of the current sample
  int vlen = 0;       // Chromium's buffer length
  int vw = 0;         // Chromium's write index of the current sample
  int64_t valid = 0;
  float* line(int l, int c) const noexcept { return mem + static_cast<size_t>(2 * l + c) * static_cast<size_t>(len); }
  void advance() noexcept {
    if (++w == len) w = 0;
    if (++vw == vlen) vw = 0;
    if (valid < len) valid++;
  }
};

// Where a read at `desired` frames lands (shared by both channels and by
// every line of a chain): physical slots of the two samples, factor, age of
// the first one (frames back from the current sample, >= 1 for delays >= 1).
struct Tap {
  int p1, p2;
  float f;
  int age1;
};
inline Tap chromiumTap(const Lines& L, float desired) noexcept {
  const float vlenF = static_cast<float>(L.vlen);
  float rp = static_cast<float>(L.vw) + (vlenF - desired);
  if (rp >= vlenF) rp -= vlenF;
  if (rp < 0) rp += vlenF;
  int i1 = static_cast<int>(rp);
  if (i1 >= L.vlen) i1 -= L.vlen;
  const float f = rp - static_cast<float>(i1);
  int k1 = L.vw - i1;
  if (k1 < 0) k1 += L.vlen;
  if (k1 >= L.len) k1 = L.len - 1;  // (never: lines hold the longest delay)
  int p1 = L.w - k1;
  if (p1 < 0) p1 += L.len;
  int p2 = p1 + 1;
  if (p2 >= L.len) p2 = 0;
  return Tap{p1, p2, f, k1};
}
inline float readTap(const float* buf, const Tap& t) noexcept {
  const float s1 = buf[t.p1];
  return s1 + t.f * (buf[t.p2] - s1);
}
// Same, honouring `valid` (after an O(1) clear). Age 0 is the current slot.
inline float readTapValid(const float* buf, const Tap& t, int64_t valid) noexcept {
  const float s1 = (t.age1 == 0 || t.age1 <= valid) ? buf[t.p1] : 0.0f;
  const int age2 = t.age1 - 1;
  const float s2 = (age2 <= 0 || age2 <= valid) ? buf[t.p2] : 0.0f;
  return s1 + t.f * (s2 - s1);
}

// ---------------------------------------------------------------------------
// One biquad channel, Chromium arithmetic (see dsp::StereoBiquad).
// ---------------------------------------------------------------------------
struct BiquadState {
  double x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  void reset() noexcept { x1 = x2 = y1 = y2 = 0; }
  // Chromium's end-of-quantum guard against a stream of subnormals.
  void flushTiny() noexcept {
    if (x1 == 0.0 && x2 == 0.0 && (y1 != 0.0 || y2 != 0.0) && std::fabs(y1) < 1.17549435e-38 &&
        std::fabs(y2) < 1.17549435e-38) {
      y1 = 0;
      y2 = 0;
    }
  }
};
inline float biquadTick(const dsp::BiquadCoeffs& c, BiquadState& s, float in) noexcept {
  const float y = static_cast<float>(c.b0 * in + c.b1 * s.x1 + c.b2 * s.x2 - c.a1 * s.y1 - c.a2 * s.y2);
  s.x2 = s.x1;
  s.x1 = in;
  s.y2 = s.y1;
  s.y1 = y;
  return y;
}

// ---------------------------------------------------------------------------
// OscillatorNode (Chromium PeriodicWave): phase in table units.
// ---------------------------------------------------------------------------
// PeriodicWave size for a context rate (2048 / 4096 / 16384).
int periodicWaveSize(double sampleRate) noexcept;

struct OscPhase {
  int size = 4096;            // table size N
  float rateScale = 0;        // N / rate (float), Chromium rate_scale_
  double invSize = 1.0 / 4096;
  void prepare(double sampleRate) noexcept {
    size = periodicWaveSize(sampleRate);
    rateScale = static_cast<float>(size) / static_cast<float>(sampleRate);
    invSize = 1.0 / size;
  }
  float increment(float hz) const noexcept { return hz * rateScale; }
  double wrap(double vri) const noexcept { return vri - std::floor(vri * invSize) * size; }
  // sin(2 pi phase) of the "sine" type (Chromium's table differs by < 3e-7).
  float sine(double vri) const noexcept { return static_cast<float>(std::sin(2.0 * kPi * vri * invSize)); }
};

// Chromium OscillatorHandler interpolation (DoInterpolation) at read index
// `vri` (table units) for a phase increment `incr`: linear from 0.3, 3-point
// Lagrange from 0.16, else 5-point, then the blend of the two band-limited
// tables of the fundamental (`tif` toward `lower`).
float chromiumInterpolate(const float* higher, const float* lower, unsigned mask, double vri, float incr,
                          float tif) noexcept;

// The built-in "sine" type for one rate (control thread: get(); immutable
// afterwards). Every band-limited range of a sine holds the same table:
// Chromium's own at its three sizes, 2048 / 4096 / 16384 points
// (chromium_sine4096.inc, chromium_sine_tables.inc; single-precision FFT
// rounding included), sin() rounded to float otherwise.
class SineTable {
 public:
  static std::shared_ptr<const SineTable> get(double sampleRate);
  float sample(double vri, float incr) const noexcept;
  int size() const noexcept { return size_; }
  bool chromiumData() const noexcept { return chromium_; }
  const float* data() const noexcept { return table_.data(); }

 private:
  int size_ = 4096;
  float invRateScale_ = 0, lowest_ = 0;
  unsigned numberOfRanges_ = 0;
  bool chromium_ = false;
  std::vector<float> table_;
  friend std::shared_ptr<const SineTable> buildSineTable(double sampleRate);
};

// Band-limited, normalized tables of the built-in "square" type for one rate
// (control thread: get() builds or reuses them; immutable afterwards).
class SquareTables {
 public:
  // Tables covering fundamentals up to `maxHz` (and one range more).
  static std::shared_ptr<const SquareTables> get(double sampleRate, float maxHz);
  // Chromium OscillatorHandler interpolation at read index `vri` (table
  // units) for a phase increment `incr` (table units per sample).
  float sample(double vri, float incr) const noexcept;
  int size() const noexcept { return size_; }
  int ranges() const noexcept { return static_cast<int>(tables_.size()); }
  const float* table(int r) const noexcept { return tables_[static_cast<size_t>(r)].data(); }

 private:
  int size_ = 4096;
  float rateScale_ = 0, invRateScale_ = 0, lowest_ = 0;
  unsigned numberOfRanges_ = 0;  // Chromium NumberOfRanges() (the tables kept may be fewer)
  std::vector<std::vector<float>> tables_;
  friend std::shared_ptr<const SquareTables> buildSquareTables(double sampleRate, float maxHz);
};

// ---------------------------------------------------------------------------
// WaveShaperNode with engine.js crushCurve(steps) (2048 points, no
// oversampling): Chromium's curve lookup with linear interpolation, in FLOAT
// like its vectorized WaveShaperDSPKernel::WaveShaperCurveValues: virtual
// index = (x + 1) * (0.5 * (length - 1)), clipped to [0, length - 1];
// index = truncation; factor = virtual index - index; output = v1 + factor *
// (v2 - v1), v2 = the next point (the last one at the end). The older
// double-precision formula left half-ulp index errors that the crush steps
// turned into -98 to -103 dBFS residuals against the golden renders
// (fx/crush_l09, fx/color_crush; dsp-parity campaign, 7 Nov 2026).
// ---------------------------------------------------------------------------
constexpr int kCurveLength = 2048;
void makeCrushCurve(int steps, float* curve) noexcept;  // curve[kCurveLength]
inline float shape(const float* curve, float input) noexcept {
  constexpr float kScale = 0.5f * static_cast<float>(kCurveLength - 1);  // 1023.5, exact in float
  constexpr float kLast = static_cast<float>(kCurveLength - 1);
  float v = (input + 1.0f) * kScale;
  if (!(v > 0.0f)) v = 0.0f;  // (also NaN)
  if (v > kLast) v = kLast;
  const int i1 = static_cast<int>(v);
  const int i2 = i1 + 1 < kCurveLength ? i1 + 1 : kCurveLength - 1;
  const float f = v - static_cast<float>(i1);
  const float v1 = curve[i1];
  return v1 + f * (curve[i2] - v1);
}

}  // namespace fx
}  // namespace om
