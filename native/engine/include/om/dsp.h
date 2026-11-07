// DSP building blocks shared by the mixer and the FX units: biquads with the
// exact Web Audio (Chromium) coefficient formulas, a parameter smoother that
// behaves like AudioParam.setTargetAtTime, LFOs, white noise, the WaveShaper
// "crush" curve and the StereoPannerNode law of engine.js, plus the
// floating-point environment of real-time threads (flush-to-zero, and the
// guard that restores it around plugin calls).
//
// FROZEN FOUNDATION (maintainer: host). Header-only, allocation-free and
// real-time safe. Matching Chromium matters: the native engine must sound
// like the Web engine (same EQ, filter, echo and pan curves). Portable: the
// FP-environment code is guarded per architecture (x86/x64: MXCSR; arm64:
// FPCR; others: no-op).
#pragma once

#include <cmath>
#include <cstdint>

#if defined(_M_X64) || defined(_M_IX86) || defined(__x86_64__) || defined(__i386__)
#define OM_FPENV_X86 1
#include <xmmintrin.h>
#elif defined(_M_ARM64) || defined(__aarch64__)
#define OM_FPENV_ARM64 1
#if defined(_MSC_VER) && !defined(__clang__)
#include <intrin.h>
#endif
#endif

#include "om/common.h"

namespace om {
namespace dsp {

// ---------------------------------------------------------------------------
// Biquads (Web Audio BiquadFilterNode)
// ---------------------------------------------------------------------------
enum class BiquadType : uint8_t { Lowpass, Highpass, Bandpass, Lowshelf, Highshelf, Peaking, Notch, Allpass };

// Normalized coefficients (a0 == 1): y = b0 x + b1 x1 + b2 x2 - a1 y1 - a2 y2
struct BiquadCoeffs {
  double b0 = 1, b1 = 0, b2 = 0, a1 = 0, a2 = 0;
};

namespace detail {
inline BiquadCoeffs normalized(double b0, double b1, double b2, double a0, double a1, double a2) noexcept {
  const double k = 1.0 / a0;
  return BiquadCoeffs{b0 * k, b1 * k, b2 * k, a1 * k, a2 * k};
}
}  // namespace detail

// Coefficients exactly as Chromium computes them (third_party/blink/.../biquad.cc,
// BSD-3; the Web Audio spec formulas):
//  - frequency in Hz (clamped to [0, Nyquist]),
//  - q: for LOWPASS / HIGHPASS it is a resonance in DECIBELS (Web Audio spec:
//    alpha = sin(w0) / (2 * 10^(Q/20))) — e.g. engine.js filter Q 0.9 means
//    +0.9 dB at the cutoff; for bandpass / peaking / notch / allpass it is a
//    plain Q (alpha = sin(w0) / (2Q)); unused by the shelves (slope S = 1),
//  - gainDb: peaking and shelves only (A = 10^(gain/40)).
// Chromium recomputes the coefficients once per render quantum when the
// parameters are static, and PER SAMPLE while an AudioParam automation
// (setTargetAtTime...) is running: callers that want exact parity update the
// coefficients per sample while their smoothers move (or per <= 32 samples
// when a test shows the difference stays below the null-test tolerance).
inline BiquadCoeffs webAudioBiquad(BiquadType type, double sampleRate, double frequency, double q, double gainDb) noexcept {
  const double nyquist = 0.5 * sampleRate;
  double f = nyquist > 0 ? frequency / nyquist : 0.0;  // normalized cutoff 0..1
  if (f < 0) f = 0;
  if (f > 1) f = 1;
  const double A = std::pow(10.0, gainDb / 40.0);
  switch (type) {
    case BiquadType::Lowpass: {
      if (f == 1) return BiquadCoeffs{1, 0, 0, 0, 0};
      if (f <= 0) return BiquadCoeffs{0, 0, 0, 0, 0};
      const double res = std::pow(10.0, q / 20.0);
      const double theta = kPi * f;
      const double alpha = std::sin(theta) / (2 * res);
      const double cosw = std::cos(theta);
      const double beta = (1 - cosw) / 2;
      return detail::normalized(beta, 2 * beta, beta, 1 + alpha, -2 * cosw, 1 - alpha);
    }
    case BiquadType::Highpass: {
      if (f == 1) return BiquadCoeffs{0, 0, 0, 0, 0};
      if (f <= 0) return BiquadCoeffs{1, 0, 0, 0, 0};
      const double res = std::pow(10.0, q / 20.0);
      const double theta = kPi * f;
      const double alpha = std::sin(theta) / (2 * res);
      const double cosw = std::cos(theta);
      const double beta = (1 + cosw) / 2;
      return detail::normalized(beta, -2 * beta, beta, 1 + alpha, -2 * cosw, 1 - alpha);
    }
    case BiquadType::Bandpass: {
      const double qq = q > 0 ? q : 0;
      if (f > 0 && f < 1) {
        if (qq > 0) {
          const double w0 = kPi * f;
          const double alpha = std::sin(w0) / (2 * qq);
          const double k = std::cos(w0);
          return detail::normalized(alpha, 0, -alpha, 1 + alpha, -2 * k, 1 - alpha);
        }
        return BiquadCoeffs{1, 0, 0, 0, 0};
      }
      return BiquadCoeffs{0, 0, 0, 0, 0};
    }
    case BiquadType::Lowshelf: {
      if (f == 1) return BiquadCoeffs{A * A, 0, 0, 0, 0};
      if (f <= 0) return BiquadCoeffs{1, 0, 0, 0, 0};
      const double w0 = kPi * f;
      const double alpha = 0.5 * std::sin(w0) * std::sqrt(2.0);  // slope S = 1
      const double k = std::cos(w0);
      const double k2 = 2 * std::sqrt(A) * alpha;
      const double ap = A + 1, am = A - 1;
      return detail::normalized(A * (ap - am * k + k2), 2 * A * (am - ap * k), A * (ap - am * k - k2),
                                ap + am * k + k2, -2 * (am + ap * k), ap + am * k - k2);
    }
    case BiquadType::Highshelf: {
      if (f == 1) return BiquadCoeffs{1, 0, 0, 0, 0};
      if (f <= 0) return BiquadCoeffs{A * A, 0, 0, 0, 0};
      const double w0 = kPi * f;
      const double alpha = 0.5 * std::sin(w0) * std::sqrt(2.0);
      const double k = std::cos(w0);
      const double k2 = 2 * std::sqrt(A) * alpha;
      const double ap = A + 1, am = A - 1;
      return detail::normalized(A * (ap + am * k + k2), -2 * A * (am + ap * k), A * (ap + am * k - k2),
                                ap - am * k + k2, 2 * (am - ap * k), ap - am * k - k2);
    }
    case BiquadType::Peaking: {
      const double qq = q > 0 ? q : 0;
      if (f > 0 && f < 1) {
        if (qq > 0) {
          const double w0 = kPi * f;
          const double alpha = std::sin(w0) / (2 * qq);
          const double k = std::cos(w0);
          return detail::normalized(1 + alpha * A, -2 * k, 1 - alpha * A, 1 + alpha / A, -2 * k, 1 - alpha / A);
        }
        return BiquadCoeffs{A * A, 0, 0, 0, 0};
      }
      return BiquadCoeffs{1, 0, 0, 0, 0};
    }
    case BiquadType::Notch: {
      const double qq = q > 0 ? q : 0;
      if (f > 0 && f < 1) {
        if (qq > 0) {
          const double w0 = kPi * f;
          const double alpha = std::sin(w0) / (2 * qq);
          const double k = std::cos(w0);
          return detail::normalized(1, -2 * k, 1, 1 + alpha, -2 * k, 1 - alpha);
        }
        return BiquadCoeffs{0, 0, 0, 0, 0};
      }
      return BiquadCoeffs{1, 0, 0, 0, 0};
    }
    case BiquadType::Allpass: {
      const double qq = q > 0 ? q : 0;
      if (f > 0 && f < 1) {
        if (qq > 0) {
          const double w0 = kPi * f;
          const double alpha = std::sin(w0) / (2 * qq);
          const double k = std::cos(w0);
          return detail::normalized(1 - alpha, -2 * k, 1 + alpha, 1 + alpha, -2 * k, 1 - alpha);
        }
        return BiquadCoeffs{-1, 0, 0, 0, 0};
      }
      return BiquadCoeffs{1, 0, 0, 0, 0};
    }
  }
  return BiquadCoeffs{};
}

// Magnitude response in dB at `frequency` (tests, UI curves).
inline double magnitudeDb(const BiquadCoeffs& c, double frequency, double sampleRate) noexcept {
  const double w = 2 * kPi * frequency / sampleRate;
  const double cr1 = std::cos(w), ci1 = -std::sin(w);         // z^-1
  const double cr2 = std::cos(2 * w), ci2 = -std::sin(2 * w);  // z^-2
  const double nr = c.b0 + c.b1 * cr1 + c.b2 * cr2, ni = c.b1 * ci1 + c.b2 * ci2;
  const double dr = 1 + c.a1 * cr1 + c.a2 * cr2, di = c.a1 * ci1 + c.a2 * ci2;
  const double num = nr * nr + ni * ni, den = dr * dr + di * di;
  return 10.0 * std::log10((num > 1e-300 ? num : 1e-300) / (den > 1e-300 ? den : 1e-300));
}

// Stereo biquad, direct form I exactly like Chromium's Biquad::Process():
// double coefficients and state, the output computed in double then rounded
// to float, and that FLOAT value fed back as y1 (Chromium writes
// `float y = b0 * x + ...; y1 = y;`). Bit-for-bit parity matters for the
// null tests against the Web engine (SPEC.md §10.1).
class StereoBiquad {
 public:
  void setCoeffs(const BiquadCoeffs& c) noexcept { c_ = c; }
  const BiquadCoeffs& coeffs() const noexcept { return c_; }
  void reset() noexcept {
    for (auto& s : s_) s = State{};
  }
  void process(float* l, float* r, int n) noexcept {
    run(s_[0], l, n);
    run(s_[1], r, n);
  }
  void processMono(float* x, int n) noexcept { run(s_[0], x, n); }

 private:
  struct State {
    double x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  };
  void run(State& s, float* x, int n) const noexcept {
    const double b0 = c_.b0, b1 = c_.b1, b2 = c_.b2, a1 = c_.a1, a2 = c_.a2;
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
    // Chromium: avoid a stream of subnormals when the input went silent
    if (x1 == 0.0 && x2 == 0.0 && (y1 != 0.0 || y2 != 0.0) && std::fabs(y1) < 1.17549435e-38 &&
        std::fabs(y2) < 1.17549435e-38) {
      y1 = 0;
      y2 = 0;
    }
    s.x1 = x1;
    s.x2 = x2;
    s.y1 = y1;
    s.y2 = y2;
  }
  BiquadCoeffs c_{};
  State s_[2]{};
};

// ---------------------------------------------------------------------------
// AudioParam.setTargetAtTime(target, now, tau) emulation, per sample:
//   v(t) = target + (v0 - target) * exp(-(t - t0) / tau)
// ---------------------------------------------------------------------------
class Smoother {
 public:
  explicit Smoother(double v = 0) noexcept : v_(v), target_(v) {}
  void reset(double v) noexcept {
    v_ = v;
    target_ = v;
    coef_ = 1;
  }
  // tauSec <= 0 jumps immediately (AudioParam.value = x).
  void setTarget(double target, double tauSec, double sampleRate) noexcept {
    target_ = target;
    if (tauSec <= 0 || sampleRate <= 0) {
      v_ = target;
      coef_ = 1;
    } else {
      coef_ = 1.0 - std::exp(-1.0 / (tauSec * sampleRate));
    }
  }
  double next() noexcept {
    v_ += (target_ - v_) * coef_;
    return v_;
  }
  // Advances n samples at once (exact closed form) and returns the new value.
  double advance(int n) noexcept {
    if (n <= 0) return v_;
    v_ = target_ + (v_ - target_) * std::pow(1.0 - coef_, n);
    if (std::fabs(v_ - target_) < 1e-12) v_ = target_;
    return v_;
  }
  double value() const noexcept { return v_; }
  double target() const noexcept { return target_; }
  bool settled(double eps = 1e-6) const noexcept { return std::fabs(v_ - target_) <= eps; }

 private:
  double v_ = 0, target_ = 0, coef_ = 1;
};

// ---------------------------------------------------------------------------
// White noise (xorshift32), uniform in [-1, 1) — engine.js Math.random()*2-1
// ---------------------------------------------------------------------------
class WhiteNoise {
 public:
  explicit WhiteNoise(uint32_t seed = 0x9E3779B9u) noexcept : s_(seed ? seed : 1u) {}
  void seed(uint32_t s) noexcept { s_ = s ? s : 1u; }
  float next() noexcept {
    s_ ^= s_ << 13;
    s_ ^= s_ >> 17;
    s_ ^= s_ << 5;
    return static_cast<float>(static_cast<int32_t>(s_)) * (1.0f / 2147483648.0f);
  }
  // Uniform in [0, 1) (Math.random()).
  double uniform() noexcept { return 0.5 * (static_cast<double>(next()) + 1.0); }

 private:
  uint32_t s_;
};

// ---------------------------------------------------------------------------
// LFO with an explicit phase (0..1), so beat-synced effects can lock it to the
// grid. Shapes follow OscillatorNode: sine, square (+1 first half), triangle, saw.
// ---------------------------------------------------------------------------
enum class LfoShape : uint8_t { Sine, Square, Triangle, Saw };

class Lfo {
 public:
  void setShape(LfoShape s) noexcept { shape_ = s; }
  void setFrequency(double hz, double sampleRate) noexcept { inc_ = sampleRate > 0 ? hz / sampleRate : 0; }
  void setPhase(double ph01) noexcept { ph_ = ph01 - std::floor(ph01); }
  double phase() const noexcept { return ph_; }
  double value() const noexcept { return shapeAt(ph_); }
  double next() noexcept {
    const double v = shapeAt(ph_);
    ph_ += inc_;
    if (ph_ >= 1.0) ph_ -= std::floor(ph_);
    return v;
  }
  double shapeAt(double ph) const noexcept {
    switch (shape_) {
      case LfoShape::Sine:
        return std::sin(2 * kPi * ph);
      case LfoShape::Square:
        return ph < 0.5 ? 1.0 : -1.0;
      case LfoShape::Triangle:
        return ph < 0.25 ? 4 * ph : (ph < 0.75 ? 2 - 4 * ph : 4 * ph - 4);
      case LfoShape::Saw:
        return ph < 0.5 ? 2 * ph : 2 * ph - 2;
    }
    return 0;
  }

 private:
  LfoShape shape_ = LfoShape::Sine;
  double ph_ = 0, inc_ = 0;
};

// ---------------------------------------------------------------------------
// engine.js crushCurve(steps) played through a WaveShaperNode (2048 points,
// oversample 'none'): input clamped to [-1, 1], linear interpolation between
// curve points, curve[i] = round(x_i * steps) / steps. The lookup runs in
// float like Chromium's vectorized kernel (virtual index (x + 1) * 1023.5,
// truncation, v1 + f * (v2 - v1)), as fx::shape does (src/fx/fx_dsp.h).
// ---------------------------------------------------------------------------
inline float crushShape(float x, int steps) noexcept {
  constexpr int n = 2048;
  auto curve = [steps](int i) noexcept {
    const double xi = (static_cast<double>(i) / (n - 1)) * 2.0 - 1.0;
    return jsRound(xi * steps) / steps;
  };
  float v = (x + 1.0f) * 1023.5f;
  if (!(v > 0.0f)) v = 0.0f;  // (also NaN)
  if (v > 2047.0f) v = 2047.0f;
  const int k = static_cast<int>(v);
  const int k2 = k + 1 < n ? k + 1 : n - 1;
  const float fr = v - static_cast<float>(k);
  const float c1 = static_cast<float>(curve(k)), c2 = static_cast<float>(curve(k2));
  return c1 + fr * (c2 - c1);
}

// ---------------------------------------------------------------------------
// StereoPannerNode law for a STEREO input (Web Audio spec), pan in [-1, 1].
// ---------------------------------------------------------------------------
inline void stereoPan(float inL, float inR, float pan, float& outL, float& outR) noexcept {
  const float p = pan < -1 ? -1.f : (pan > 1 ? 1.f : pan);
  const double x = p <= 0 ? p + 1.0 : p;
  const float gL = static_cast<float>(std::cos(x * kPi / 2));
  const float gR = static_cast<float>(std::sin(x * kPi / 2));
  if (p <= 0) {
    outL = inL + inR * gL;
    outR = inR * gR;
  } else {
    outL = inL * gL;
    outR = inR + inL * gR;
  }
}

// ---------------------------------------------------------------------------
// Floating-point environment of real-time threads.
// ---------------------------------------------------------------------------
// The thread's FP control word: MXCSR on x86/x64, FPCR on arm64, 0 elsewhere.
inline uint64_t fpControl() noexcept {
#if defined(OM_FPENV_X86)
  return _mm_getcsr();
#elif defined(OM_FPENV_ARM64) && defined(_MSC_VER) && !defined(__clang__)
  return static_cast<uint64_t>(_ReadStatusReg(0x5A20));  // ARM64_FPCR (S3_3_C4_C4_0)
#elif defined(OM_FPENV_ARM64)
  uint64_t v;
  __asm__ __volatile__("mrs %0, fpcr" : "=r"(v));
  return v;
#else
  return 0;
#endif
}
inline void setFpControl(uint64_t v) noexcept {
#if defined(OM_FPENV_X86)
  _mm_setcsr(static_cast<unsigned int>(v));
#elif defined(OM_FPENV_ARM64) && defined(_MSC_VER) && !defined(__clang__)
  _WriteStatusReg(0x5A20, static_cast<__int64>(v));
#elif defined(OM_FPENV_ARM64)
  __asm__ __volatile__("msr fpcr, %0" : : "r"(v));
#else
  (void)v;
#endif
}

// Flush-to-zero (+ denormals-are-zero on x86) for the calling thread: call
// once at the start of every real-time thread (audio, phones, VST deck
// workers).
inline void flushDenormals() noexcept {
#if defined(OM_FPENV_X86)
  setFpControl(fpControl() | 0x8040u);          // MXCSR FTZ (bit 15) | DAZ (bit 6)
#elif defined(OM_FPENV_ARM64)
  setFpControl(fpControl() | (uint64_t(1) << 24));  // FPCR.FZ
#endif
}

// Saves the FP control word and restores it when leaving the scope. Every
// call into plugin code runs inside one: plugins may change FTZ/DAZ or the
// rounding mode (SPEC.md §13.4).
class FpEnvGuard {
 public:
  FpEnvGuard() noexcept : saved_(fpControl()) {}
  ~FpEnvGuard() noexcept {
    if (fpControl() != saved_) setFpControl(saved_);
  }
  FpEnvGuard(const FpEnvGuard&) = delete;
  FpEnvGuard& operator=(const FpEnvGuard&) = delete;

 private:
  uint64_t saved_;
};

}  // namespace dsp
}  // namespace om
