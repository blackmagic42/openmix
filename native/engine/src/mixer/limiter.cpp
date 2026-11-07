// Master safety limiter of the native mixer (owner: mixer): a port of
// Chromium's DynamicsCompressorKernel (third_party/blink/renderer/platform/
// audio/dynamics_compressor_kernel.cc) driven like the DynamicsCompressorNode
// of engine.js (threshold -3 dB, knee 0, ratio 12, attack 2 ms, release
// 150 ms; Chromium's fixed 6 ms pre-delay, release zones, post gain 0 dB and
// effect blend 1). Same float arithmetic, same 32-frame divisions (carried
// over between calls, so any block size gives the samples a 128-frame
// render quantum would), same detector, adaptive release, makeup gain and
// metering. Fast paths only where the result is provably identical
// (input below the threshold, compressor fully released). SPEC.md §10.7.
//
// The port keeps the license of the original code:
/*
 * Copyright (C) 2011 Google Inc. All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions
 * are met:
 *
 * 1.  Redistributions of source code must retain the above copyright
 *     notice, this list of conditions and the following disclaimer.
 * 2.  Redistributions in binary form must reproduce the above copyright
 *     notice, this list of conditions and the following disclaimer in the
 *     documentation and/or other materials provided with the distribution.
 * 3.  Neither the name of Apple Computer, Inc. ("Apple") nor the names of
 *     its contributors may be used to endorse or promote products derived
 *     from this software without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY APPLE AND ITS CONTRIBUTORS "AS IS" AND ANY
 * EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL APPLE OR ITS CONTRIBUTORS BE LIABLE FOR ANY
 * DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
 * (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
 * LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
 * ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
 * (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF
 * THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */
#include "om/limiter.h"

#include <algorithm>
#include <cfloat>
#include <cmath>
#include <cstring>

namespace om {

namespace {
constexpr int kMaxPreDelayFrames = 1024;
constexpr int kMaxPreDelayFramesMask = kMaxPreDelayFrames - 1;
constexpr int kDefaultPreDelayFrames = 256;
constexpr int kDivisionFrames = 32;
constexpr float kUninitialized = -1.0f;
constexpr float kMeteringReleaseTimeConstant = 0.325f;
constexpr float kSatReleaseTime = 0.0025f;
constexpr float kSpacingDb = 5.0f;
constexpr float kReleaseZone1 = 0.09f;
constexpr float kReleaseZone2 = 0.16f;
constexpr float kReleaseZone3 = 0.42f;
constexpr float kReleaseZone4 = 0.98f;
constexpr float kPiOverTwoFloat = static_cast<float>(3.14159265358979323846 / 2);
constexpr float kPostGainDb = 0.0f;   // DynamicsCompressor kParamPostGain
constexpr float kEffectBlend = 1.0f;  // kParamEffectBlend

// audio_utilities
inline float linearToDecibels(float linear) noexcept { return 20.0f * std::log10(linear); }
inline float decibelsToLinear(float decibels) noexcept { return std::pow(10.0f, 0.05f * decibels); }
inline float flushDenormal(float v) noexcept { return std::fabs(v) < FLT_MIN ? 0.0f : v; }
inline bool gremlin(float v) noexcept { return std::isnan(v) || std::isinf(v); }

// Static curve of the kernel (UpdateStaticCurveParameters and friends).
struct Curve {
  float dbThreshold = kUninitialized, dbKnee = kUninitialized, ratio = kUninitialized;
  float linearThreshold = kUninitialized, slope = kUninitialized;
  float kneeThresholdDb = kUninitialized, kneeThreshold = kUninitialized, yKneeThresholdDb = kUninitialized;
  float k = kUninitialized;

  // Exponential curve for the knee: 1st derivative matched at the linear
  // threshold, asymptotically approaching linearThreshold + 1 / k.
  float kneeCurve(float x, float kk) const noexcept {
    if (x < linearThreshold) return x;
    return linearThreshold + (1 - std::exp(-kk * (x - linearThreshold))) / kk;
  }
  // Full compression curve with a constant ratio after the knee.
  float saturate(float x, float kk) const noexcept {
    if (x < kneeThreshold) return kneeCurve(x, kk);
    const float xDb = linearToDecibels(x);
    const float yDb = yKneeThresholdDb + slope * (xDb - kneeThresholdDb);
    return decibelsToLinear(yDb);
  }
  // Approximate 1st derivative with input and output in dB (= 1 / ratio).
  float slopeAt(float x, float kk) const noexcept {
    if (x < linearThreshold) return 1;
    const float x2 = static_cast<float>(x * 1.001);
    const float xDb = linearToDecibels(x);
    const float x2Db = linearToDecibels(x2);
    const float yDb = linearToDecibels(kneeCurve(x, kk));
    const float y2Db = linearToDecibels(kneeCurve(x2, kk));
    return (y2Db - yDb) / (x2Db - xDb);
  }
  float kAtSlope(float desiredSlope) const noexcept {
    const float xDb = dbThreshold + dbKnee;
    const float x = decibelsToLinear(xDb);
    float minK = 0.1f;
    float maxK = 10000.0f;
    float kk = 5.0f;
    for (int i = 0; i < 15; ++i) {
      // a high value for k approaches a slope of 0 faster
      const float s = slopeAt(x, kk);
      if (s < desiredSlope)
        maxK = kk;  // k too high
      else
        minK = kk;  // k too low
      kk = std::sqrt(minK * maxK);  // geometric mean
    }
    return kk;
  }
  float update(float threshold, float knee, float r) noexcept {
    if (threshold != dbThreshold || knee != dbKnee || r != ratio) {
      dbThreshold = threshold;
      linearThreshold = decibelsToLinear(threshold);
      dbKnee = knee;
      ratio = r;
      slope = 1 / ratio;
      const float kk = kAtSlope(1 / ratio);
      kneeThresholdDb = threshold + knee;
      kneeThreshold = decibelsToLinear(kneeThresholdDb);
      yKneeThresholdDb = linearToDecibels(kneeCurve(kneeThreshold, kk));
      k = kk;
    }
    return k;
  }
};

// Everything the kernel derives from the parameters at the top of Process().
struct Derived {
  float k = 0;
  float masterLinearGain = 1;
  float attackFrames = 1;
  float satReleaseFrames = 1;
  float a = 0, b = 0, c = 0, d = 0, e = 0;  // adaptive release polynomial
  float dryMix = 0, wetMix = 1;
  unsigned preDelayFrames = 0;
  float satReleaseRateUnity = 0;   // sat release rate when attenuation == 1 (input under the threshold)
  float postWarpUnity = 1;         // sin(pi/2 * 1)
  float dbRealGainUnity = 0;
};

Derived derive(Curve& curve, const LimiterParams& p, float sampleRate) noexcept {
  Derived dv;
  dv.dryMix = 1 - kEffectBlend;
  dv.wetMix = kEffectBlend;
  dv.k = curve.update(p.thresholdDb, p.kneeDb, p.ratio);
  // makeup gain, with Chromium's empirical/perceptual tuning
  const float fullRangeGain = curve.saturate(1, dv.k);
  float fullRangeMakeupGain = 1 / fullRangeGain;
  fullRangeMakeupGain = std::pow(fullRangeMakeupGain, 0.6f);
  dv.masterLinearGain = decibelsToLinear(kPostGainDb) * fullRangeMakeupGain;
  const float attackTime = std::max(0.001f, p.attackSec);
  dv.attackFrames = attackTime * sampleRate;
  const float releaseFrames = sampleRate * p.releaseSec;
  dv.satReleaseFrames = kSatReleaseTime * sampleRate;
  // 4th-order polynomial through the release zones (y1 : x == 0 ... y4 : x == 3)
  const float y1 = releaseFrames * kReleaseZone1;
  const float y2 = releaseFrames * kReleaseZone2;
  const float y3 = releaseFrames * kReleaseZone3;
  const float y4 = releaseFrames * kReleaseZone4;
  dv.a = 0.9999999999999998f * y1 + 1.8432219684323923e-16f * y2 - 1.9373394351676423e-16f * y3 +
         8.824516011816245e-18f * y4;
  dv.b = -1.5788320352845888f * y1 + 2.3305837032074286f * y2 - 0.9141194204840429f * y3 +
         0.1623677525612032f * y4;
  dv.c = 0.5334142869106424f * y1 - 1.272736789213631f * y2 + 0.9258856042207512f * y3 -
         0.18656310191776226f * y4;
  dv.d = 0.08783463138207234f * y1 - 0.1694162967925622f * y2 + 0.08588057951595272f * y3 -
         0.00429891410546283f * y4;
  dv.e = -0.042416883008123074f * y1 + 0.1115693827987602f * y2 - 0.09764676325265872f * y3 +
         0.028494263462021576f * y4;
  unsigned frames = static_cast<unsigned>(p.preDelaySec * sampleRate);
  if (frames > kMaxPreDelayFrames - 1) frames = kMaxPreDelayFrames - 1;
  dv.preDelayFrames = frames;
  // values of the per-frame path for the two common states (bit-identical shortcuts)
  {
    const float attenuationDb = std::max(2.0f, -linearToDecibels(1.0f));
    dv.satReleaseRateUnity = decibelsToLinear(attenuationDb / dv.satReleaseFrames) - 1;
    dv.postWarpUnity = std::sin(kPiOverTwoFloat * 1.0f);
    dv.dbRealGainUnity = linearToDecibels(dv.postWarpUnity);
  }
  return dv;
}
}  // namespace

struct Limiter::Impl {
  Params p;
  float sampleRate = 48000.0f;
  Curve curve;
  Derived dv;
  float meteringReleaseK = 0;

  // kernel state (DynamicsCompressorKernel::Reset)
  float detectorAverage = 0;
  float compressorGain = 1;
  float meteringGain = 1;
  float maxAttackCompressionDiffDb = -1;
  unsigned lastPreDelayFrames = kDefaultPreDelayFrames;
  int readIndex = 0;
  int writeIndex = kDefaultPreDelayFrames;
  float delay[2][kMaxPreDelayFrames] = {};

  // the 32-frame division in progress (carried over between calls)
  int divPos = 0;
  float envelopeRate = 0;
  float scaledDesiredGain = 0;

  void resetKernel() noexcept {
    detectorAverage = 0;
    compressorGain = 1;
    meteringGain = 1;
    std::memset(delay, 0, sizeof(delay));
    readIndex = 0;
    writeIndex = kDefaultPreDelayFrames;
    lastPreDelayFrames = kDefaultPreDelayFrames;  // a fresh kernel: the first process() sets the real pre-delay
    maxAttackCompressionDiffDb = -1;
    divPos = 0;
  }

  void setPreDelay() noexcept {
    const unsigned frames = dv.preDelayFrames;
    if (lastPreDelayFrames != frames) {
      lastPreDelayFrames = frames;
      std::memset(delay, 0, sizeof(delay));
      readIndex = 0;
      writeIndex = static_cast<int>(frames);
    }
  }

  // Start of a division: desired gain and envelope rate.
  void beginDivision() noexcept {
    if (gremlin(detectorAverage)) detectorAverage = 1;
    const float desiredGain = detectorAverage;
    // pre-warp so that we get desiredGain after the sin() warp below
    scaledDesiredGain = std::asin(desiredGain) / kPiOverTwoFloat;
    const bool isReleasing = scaledDesiredGain > compressorGain;
    float compressionDiffDb = linearToDecibels(compressorGain / scaledDesiredGain);
    if (isReleasing) {
      maxAttackCompressionDiffDb = -1;
      if (gremlin(compressionDiffDb)) compressionDiffDb = -1;
      // adaptive release: more compression releases faster; -12 -> 0 dB mapped to 0 -> 3
      float x = compressionDiffDb;
      x = std::clamp(x, -12.0f, 0.0f);
      x = 0.25f * (x + 12);
      const float x2 = x * x;
      const float x3 = x2 * x;
      const float x4 = x2 * x2;
      const float releaseFrames = dv.a + dv.b * x + dv.c * x2 + dv.d * x3 + dv.e * x4;
      const float dbPerFrame = kSpacingDb / releaseFrames;
      envelopeRate = decibelsToLinear(dbPerFrame);
    } else {
      if (gremlin(compressionDiffDb)) compressionDiffDb = 1;
      // as long as we are attacking, use the largest compression difference seen so far
      if (maxAttackCompressionDiffDb == -1 || maxAttackCompressionDiffDb < compressionDiffDb)
        maxAttackCompressionDiffDb = compressionDiffDb;
      const float effAttenDiffDb = std::max(0.5f, maxAttackCompressionDiffDb);
      const float x = 0.25f / effAttenDiffDb;
      envelopeRate = 1 - std::pow(x, 1 / dv.attackFrames);
    }
  }

  void run(float* l, float* r, int n) noexcept {
    setPreDelay();
    const float satReleaseFrames = dv.satReleaseFrames;
    const float linearThreshold = curve.linearThreshold;
    const float kk = dv.k;
    float* dl = delay[0];
    float* dr = delay[1];
    for (int i = 0; i < n; i++) {
      if (divPos == 0) beginDivision();
      // pre-delay the signal; the compression amount comes from the undelayed input
      const float ul = l[i];
      const float ur = r[i];
      dl[writeIndex] = ul;
      dr[writeIndex] = ur;
      float compressorInput = 0;
      const float al = ul > 0 ? ul : -ul;
      if (compressorInput < al) compressorInput = al;
      const float ar = ur > 0 ? ur : -ur;
      if (compressorInput < ar) compressorInput = ar;
      const float absInput = compressorInput > 0 ? compressorInput : -compressorInput;

      float satReleaseRate;
      float attenuation;
      if (absInput < linearThreshold && curve.kneeThreshold >= linearThreshold) {
        // saturate(x) == x below the threshold: attenuation 1, attenuationDb max(2, -0)
        attenuation = 1;
        satReleaseRate = dv.satReleaseRateUnity;
      } else {
        const float shapedInput = curve.saturate(absInput, kk);
        attenuation = absInput <= 0.0001f ? 1 : shapedInput / absInput;
        float attenuationDb = -linearToDecibels(attenuation);
        attenuationDb = std::max(2.0f, attenuationDb);
        const float dbPerFrame = attenuationDb / satReleaseFrames;
        satReleaseRate = decibelsToLinear(dbPerFrame) - 1;
      }
      const bool isRelease = attenuation > detectorAverage;
      const float rate = isRelease ? satReleaseRate : 1;
      detectorAverage += (attenuation - detectorAverage) * rate;
      detectorAverage = std::min(1.0f, detectorAverage);
      if (gremlin(detectorAverage)) detectorAverage = 1;

      // exponential approach to the desired gain
      if (envelopeRate < 1) {
        compressorGain += (scaledDesiredGain - compressorGain) * envelopeRate;  // attack
      } else {
        compressorGain *= envelopeRate;  // release: exponentially up to 1
        compressorGain = std::min(1.0f, compressorGain);
      }

      // warp the gain to smooth sharp exponential transitions
      float postWarp, dbRealGain;
      if (compressorGain == 1.0f) {
        postWarp = dv.postWarpUnity;
        dbRealGain = dv.dbRealGainUnity;
      } else {
        postWarp = std::sin(kPiOverTwoFloat * compressorGain);
        dbRealGain = linearToDecibels(postWarp);
      }
      const float totalGain = dv.dryMix + dv.wetMix * dv.masterLinearGain * postWarp;

      // metering: instant attack, kMeteringReleaseTimeConstant release
      if (dbRealGain < meteringGain)
        meteringGain = dbRealGain;
      else
        meteringGain += (dbRealGain - meteringGain) * meteringReleaseK;

      l[i] = dl[readIndex] * totalGain;
      r[i] = dr[readIndex] * totalGain;
      readIndex = (readIndex + 1) & kMaxPreDelayFramesMask;
      writeIndex = (writeIndex + 1) & kMaxPreDelayFramesMask;

      if (++divPos == kDivisionFrames) {
        divPos = 0;
        detectorAverage = flushDenormal(detectorAverage);
        compressorGain = flushDenormal(compressorGain);
      }
    }
    // Not in Chromium: a non-finite input (or an absurd one, ~1e30) could leave
    // a NaN in the state for good; start again from rest instead.
    if (!(std::fabs(compressorGain) <= 1.0e30f && std::fabs(detectorAverage) <= 1.0e30f &&
          std::fabs(meteringGain) <= 1.0e30f))
      resetKernel();
  }
};

Limiter::Limiter() : impl_(std::make_unique<Impl>()) {}
Limiter::~Limiter() = default;

void Limiter::prepare(double sampleRate, const Params& p) {
  Impl& m = *impl_;
  m.p = p;
  m.sampleRate = static_cast<float>(sampleRate);
  m.curve = Curve();
  m.dv = derive(m.curve, p, m.sampleRate);
  m.meteringReleaseK =
      static_cast<float>(1.0 - std::exp(-1.0 / (static_cast<double>(m.sampleRate) * kMeteringReleaseTimeConstant)));
  m.resetKernel();
}

void Limiter::reset() noexcept { impl_->resetKernel(); }

void Limiter::process(float* l, float* r, int n) noexcept {
  if (n > 0) impl_->run(l, r, n);
}

float Limiter::gainReductionDb() const noexcept { return impl_->meteringGain; }

double Limiter::makeupGainDb() const noexcept { return 20.0 * std::log10(static_cast<double>(impl_->dv.masterLinearGain)); }

int Limiter::latencyFrames() const noexcept { return static_cast<int>(impl_->dv.preDelayFrames); }

double Limiter::staticCurveDb(double inputDb, const Params& p) {
  // steady state of a constant-level input: the detector settles on the
  // attenuation, the compressor gain on asin(att) / (pi/2), whose sin() warp
  // gives the attenuation back; the makeup gain applies on top.
  Curve curve;
  const Derived dv = derive(curve, p, 48000.0f);
  const float x = static_cast<float>(std::pow(10.0, inputDb / 20.0));
  const float attenuation = x <= 0.0001f ? 1.0f : curve.saturate(x, dv.k) / x;
  return 20.0 * std::log10(static_cast<double>(x) * attenuation * dv.masterLinearGain);
}

}  // namespace om
