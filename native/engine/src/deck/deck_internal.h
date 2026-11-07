// Private building blocks of the deck (owner: deck), shared by deck.cpp,
// interpolator.cpp and the deck tests (tests/deck include this header):
//  - KRateTarget: AudioParam.setTargetAtTime on a k-rate parameter exactly as
//    Chromium evaluates it (the WSOLA "ratio" of pitch-worklet.js),
//  - ARateTarget: the same on an a-rate parameter (GainNode gains: roll and
//    stem gains),
//  - FadeRamp: the deck's click-free fades and crossfades,
//  - LoopFrames + readChromium(): the read pointer of Chromium's
//    AudioBufferSourceNode (RenderFromBuffer) over a TrackBuffer.
// Every rule here was checked bit for bit against renders made by Chromium
// itself (tests/deck/goldens, SPEC.md §18.4); the comments say which golden.
// Real-time safe: no allocation, noexcept.
#pragma once

#include <cmath>
#include <cstdint>

#include "om/common.h"
#include "om/interpolator.h"
#include "om/media.h"

namespace om {
namespace deckimpl {

// ---------------------------------------------------------------------------
// k-rate setTargetAtTime (Chromium AudioParamTimeline, measured on the
// wsola_target golden: 0 mismatches over 1500 quanta):
//  - one value per 128-frame quantum, float arithmetic:
//      v += (target - v) * dtc,  dtc = float(1 - exp(-1 / (controlRate * float(tau)))),
//    controlRate = sampleRate / 128;
//  - an event issued at a quantum boundary (engine.js: setTargetAtTime(x,
//    ctx.currentTime, tau)) shows from the NEXT quantum: the quantum it was
//    issued at still follows the previous target;
//  - convergence: after the step, v snaps to the target when
//    |target - v| < exp(-10) * |target|, or when more than 10 time constants
//    have passed since the event (v == 0 targets: |v| < 1e-20... unused here).
// ---------------------------------------------------------------------------
class KRateTarget {
 public:
  void reset(float v, double sampleRate, double tauSec) noexcept {
    value_ = v;
    latest_ = v;
    eff_ = v;
    latestT_ = -1e300;
    effT_ = -1e300;
    tauF_ = static_cast<float>(tauSec);
    const double controlRate = sampleRate / kRenderQuantum;
    dtc_ = static_cast<float>(1.0 - std::exp(-1.0 / (controlRate * static_cast<double>(tauF_))));
  }
  // A new setTargetAtTime(target, now, tau) event issued at time `now` (seconds,
  // sample clock); it shows from the quantum after the next step() (see above).
  // Every call is a new event (its 10-tau clock restarts), as in Chromium.
  void setTarget(float target, double now) noexcept {
    latest_ = target;
    latestT_ = now;
  }
  // Value of the quantum starting at time `qTime` (call once per quantum, in order).
  float step(double qTime) noexcept {
    if (effT_ > -1e299) {
      value_ = value_ + (eff_ - value_) * dtc_;
      if (std::fabs(eff_ - value_) < kConverge * std::fabs(eff_) || qTime > effT_ + 10.0 * static_cast<double>(tauF_)) {
        value_ = eff_;
      }
    }
    eff_ = latest_;
    effT_ = latestT_;
    return value_;
  }
  float value() const noexcept { return value_; }
  float target() const noexcept { return latest_; }
  // Jump (AudioParam.value = v): used when a fresh trajectory must start at v.
  void jump(float v) noexcept {
    value_ = v;
    latest_ = v;
    eff_ = v;
    latestT_ = -1e300;
    effT_ = -1e300;
  }

  static constexpr float kConverge = 4.539992976248485e-05f;  // exp(-10)

 private:
  float value_ = 1, latest_ = 1, eff_ = 1;
  double latestT_ = -1e300, effT_ = -1e300;
  float tauF_ = 0.02f;
  float dtc_ = 0.1248f;
};

// ---------------------------------------------------------------------------
// a-rate setTargetAtTime (GainNode gain): one float step per sample,
// dtc = float(1 - exp(-1 / (sampleRate * float(tau)))), snap when
// |target - v| < exp(-10) * |target| (or |v| < 1e-7 toward 0).
// ---------------------------------------------------------------------------
class ARateTarget {
 public:
  void reset(float v) noexcept {
    value_ = v;
    target_ = v;
    active_ = false;
  }
  void setTarget(float target, double tauSec, double sampleRate) noexcept {
    target_ = target;
    if (!(tauSec > 0) || !(sampleRate > 0)) {
      value_ = target;
      active_ = false;
      return;
    }
    dtc_ = static_cast<float>(1.0 - std::exp(-1.0 / (sampleRate * static_cast<double>(static_cast<float>(tauSec)))));
    active_ = value_ != target_;
  }
  // AudioParam.value = v (immediate).
  void jump(float v) noexcept { reset(v); }
  bool moving() const noexcept { return active_; }
  float value() const noexcept { return value_; }
  float target() const noexcept { return target_; }
  // n per-sample values (n >= 1).
  void render(float* out, int n) noexcept {
    if (!active_) {
      for (int i = 0; i < n; i++) out[i] = value_;
      return;
    }
    for (int i = 0; i < n; i++) {
      out[i] = value_;
      value_ = value_ + (target_ - value_) * dtc_;
      if (converged()) {
        value_ = target_;
        active_ = false;
        for (int k = i + 1; k < n; k++) out[k] = value_;
        return;
      }
    }
  }
  // Advances n samples without output.
  void skip(int n) noexcept {
    for (int i = 0; i < n && active_; i++) {
      value_ = value_ + (target_ - value_) * dtc_;
      if (converged()) {
        value_ = target_;
        active_ = false;
      }
    }
  }

 private:
  bool converged() const noexcept {
    if (target_ == 0.0f) return std::fabs(value_) < 1e-7f;
    return std::fabs(target_ - value_) < KRateTarget::kConverge * std::fabs(target_);
  }
  float value_ = 1, target_ = 1, dtc_ = 1;
  bool active_ = false;
};

// ---------------------------------------------------------------------------
// Fade ramp of the deck's click-free edges (2 ms stop, 5 ms jump, 6 ms
// route crossfades), per sample, RAISED-COSINE shaped: v = a + (b - a) *
// (1 - cos(pi k / n)) / 2. Two complementary ramps still sum to exactly the
// same total as linear ones (identical signals cross without any change),
// but the gain slope is continuous at both ends: a linear ramp's corners put
// a -50 dBFS kink on a full-scale signal, this shape does not. The cosine
// runs on a rotation recurrence (no libm call per sample).
// ---------------------------------------------------------------------------
class FadeRamp {
 public:
  void set(float v) noexcept {
    value_ = v;
    left_ = 0;
  }
  void rampTo(float target, int frames) noexcept {
    if (frames <= 0) {
      value_ = target;
      left_ = 0;
      return;
    }
    from_ = value_;
    target_ = target;
    left_ = frames;
    // cos(pi k / n) for k = 0, 1, ...: c_{k+1} = 2 cos(pi / n) c_k - c_{k-1}
    k2_ = 2.0 * std::cos(kPi / frames);
    cPrev_ = std::cos(-kPi / frames);
    c_ = 1.0;
  }
  bool moving() const noexcept { return left_ > 0; }
  float value() const noexcept { return value_; }
  // Gain of the next sample, then advances.
  float next() noexcept {
    const float v = value_;
    if (left_ > 0) {
      const double c = k2_ * c_ - cPrev_;
      cPrev_ = c_;
      c_ = c;
      if (--left_ == 0) {
        value_ = target_;
      } else {
        value_ = static_cast<float>(from_ + (static_cast<double>(target_) - from_) * 0.5 * (1.0 - c));
      }
    }
    return v;
  }

 private:
  float value_ = 1, target_ = 1;
  double from_ = 1, k2_ = 0, c_ = 1, cPrev_ = 1;
  int left_ = 0;
};

// ---------------------------------------------------------------------------
// Chromium AudioBufferSourceNode read pointer (RenderFromBuffer), checked bit
// for bit on the abs_* goldens (rates != 1, 44.1 kHz buffers in a 48 kHz
// context, loop seams across chunk boundaries, end of buffer, rate steps):
//  - start offset ROUNDED to the nearest buffer frame (round(offset * rate));
//  - increment = (bufferRate / contextRate) * float(playbackRate), ACCUMULATED
//    per frame (virtual_read_index += rate), never recomputed as pos0 + k*inc;
//  - sample = float((1 - f) * s[i] + f * s[i2]) in double;
//  - i2 = i + 1, except at the buffer end: looping -> (unsigned)(pos + 1 -
//    loopLength); not looping -> extrapolation from the LAST TWO frames
//    (i = len - 2, i2 = len - 1, f = pos - (len - 2)) (abs_end golden);
//  - loop: virtualEnd = min(loopEnd * rate, len), loopLength = virtualEnd -
//    loopStart * rate (doubles, not rounded); after each increment
//    "if (pos >= virtualEnd) pos -= loopLength"; the frame after loopEnd is
//    read for the interpolation (not wrapped) while it is inside the buffer;
//  - not looping: pos >= len -> finished (silence from that frame on).
// Deck additions (no Chromium equivalent): positions < 0 read as silence
// (pre-roll: frame -1 counts as 0 for the interpolation), frames of chunks not
// received yet read as silence (SPEC.md §9.1).
// ---------------------------------------------------------------------------
struct LoopFrames {
  bool on = false;
  double virtualEnd = 0;  // min(loopEnd * rate, len) when on, else len
  double length = 0;      // virtualEnd - loopStart * rate when on, else len
  double start = 0;       // loopStart * rate

  static LoopFrames of(const TrackBuffer& tb, bool looping, double startSec, double endSec) noexcept {
    LoopFrames lf;
    const double len = static_cast<double>(tb.frames);
    lf.virtualEnd = len;
    lf.length = len;
    if (looping && (startSec != 0 || endSec != 0) && startSec >= 0 && endSec > 0 && startSec < endSec) {
      const double ls = startSec * tb.sampleRate;
      const double le = endSec * tb.sampleRate;
      lf.on = true;
      lf.start = ls;
      lf.virtualEnd = le < len ? le : len;
      lf.length = lf.virtualEnd - ls;
    } else if (looping) {
      // Chromium: loop with loopStart == loopEnd == 0 = the whole buffer
      lf.on = true;
      lf.start = 0;
    }
    return lf;
  }
};

// Frame i of tb as float (s16 through its chunk's scale), 0 when outside the
// buffer or in a chunk not received yet.
inline void fetch(const TrackBuffer& tb, int64_t i, float& l, float& r) noexcept { tb.frameChecked(i, l, r); }

// One interpolated frame at position p (Chromium rules above; the caller has
// already handled "finished"). Used by the per-frame paths.
inline void sampleAt(const TrackBuffer& tb, double p, const LoopFrames& loop, float& outL, float& outR) noexcept {
  const int64_t len = tb.frames;
  if (!loop.on && p >= static_cast<double>(len)) {  // Chromium has finished there: silence
    outL = outR = 0.0f;
    return;
  }
  double fi = std::floor(p);
  int64_t i = static_cast<int64_t>(fi);
  double f = p - fi;
  int64_t i2 = i + 1;
  if (i2 >= len) {
    if (loop.on) {
      i2 = static_cast<int64_t>(p + 1 - loop.length);
    } else if (len >= 2) {
      i = len - 2;
      i2 = len - 1;
      f = p - static_cast<double>(len - 2);
    } else {
      i2 = i;
    }
  }
  float l1, r1, l2, r2;
  fetch(tb, i, l1, r1);
  fetch(tb, i2, l2, r2);
  outL = static_cast<float>((1.0 - f) * l1 + f * l2);
  outR = static_cast<float>((1.0 - f) * r1 + f * r2);
}

// Renders n frames from position `pos` (source frames) advancing by `inc`
// (> 0) with Chromium's loop/end rules; writes the position of each output
// frame to posOut (optional). Sets `finished` (and returns its frame index)
// when the end of a non-looping buffer is reached: that frame and the next
// ones are silence. Returns n when it did not finish in this call. Qualities
// other than Linear (dev A/B) keep the position, loop and end rules and only
// change the kernel.
int readChromium(const TrackBuffer& tb, double& pos, double inc, const LoopFrames& loop, int n, float* outL,
                 float* outR, double* posOut, bool& finished, InterpQuality q = InterpQuality::Linear) noexcept;

// One frame at fractional position pos with the given kernel (missing frames
// = silence; Linear: Chromium's formula without its end rules). rate = |speed|
// (the sinc's anti-aliasing cutoff).
void kernelRead(const TrackBuffer& tb, InterpQuality q, double pos, double rate, float& l, float& r) noexcept;

}  // namespace deckimpl
}  // namespace om
