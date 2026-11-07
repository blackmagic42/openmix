// Beat FX unit (owner: fx): the 17 DSP effect types of engine.js FxUnit plus
// ROLL (silent here, the deck plays it), level-dependent feedbacks and
// depths, beat-synced delay times and LFOs phase-locked to the beat clock,
// chains built lazily off the audio thread (makeChain / attachChain).
// SPEC.md §11. Graphs and constants are engine.js's (src/js/engine.js
// FxUnit, buildEchoLoop); the Web Audio node behaviours come from fx_dsp.h.
//
// Routing model (engine.js _route): only the selected chain is processed
// while the unit is enabled; every other chain, and every chain while the
// unit is disabled, is frozen like a Web Audio cycle that nothing pulls
// (its lines, filter states, oscillator phases AND AudioParam automations
// stand still). Only the wet GainNode, always connected to the output, keeps
// following its automation. A frame counter (all frames handed to
// process(), processed or not) is the unit's timeline: AudioParam events and
// render quanta are placed on it like on the AudioContext's.
//
// Echo timing (SPEC.md §20): feedback loops here are drift-free (each repeat
// lands k * delay after the input, within a sample), unlike Chromium which
// adds one 128-frame render quantum per trip around a DelayNode cycle. The
// flanger keeps that quantum in its feedback path: it is part of its sound.
#include <algorithm>
#include <cmath>
#include <cstring>
#include <new>

#include "fx_chain.h"
#include "fx_dsp.h"
#include "om/fx.h"

namespace om {

void FxChainDeleter::operator()(FxChain* c) const noexcept { delete c; }

namespace {

constexpr double kLineSeconds = 4.0;     // engine.js createDelay(4)
constexpr double kFlangerMaxSec = 0.05;  // engine.js createDelay(0.05)
constexpr int kFbQuantum = 128;          // Chromium: a DelayNode cycle is processed one render quantum late
constexpr float kTransMaxHz = 24.0f;     // highest TRANS rate (engine.js clamp)
constexpr float kRobotHz = 35.0f;
constexpr float kPhaserHz[4] = {350.0f, 700.0f, 1100.0f, 1600.0f};

enum LfoIndex : int { kLfoTrans = 0, kLfoFlanger, kLfoPhaser, kLfoPan, kLfoFilter, kNumLfos };

int lfoIndexOf(FxType t) noexcept {
  switch (t) {
    case FxType::Trans: return kLfoTrans;
    case FxType::Flanger: return kLfoFlanger;
    case FxType::Phaser: return kLfoPhaser;
    case FxType::Pan: return kLfoPan;
    case FxType::Filter: return kLfoFilter;
    default: return -1;
  }
}
// engine.js _applyTime: oscillator frequency = clamp(k / t, lo, hi)
void lfoRateLaw(int i, double& k, double& lo, double& hi) noexcept {
  switch (i) {
    case kLfoTrans: k = 1.0; lo = 0.25; hi = 24.0; break;
    case kLfoFlanger: k = 0.125; lo = 0.05; hi = 4.0; break;
    case kLfoPhaser: k = 0.25; lo = 0.05; hi = 6.0; break;
    default: k = 0.5; lo = 0.05; hi = 8.0; break;  // pan, filter
  }
}
double lfoTau(int i) noexcept { return i == kLfoTrans ? 0.05 : 0.1; }
// engine.js constructor: oscillator frequency .value
double lfoDefaultHz(int i) noexcept {
  switch (i) {
    case kLfoTrans: return 4.0;
    case kLfoFlanger: return 0.25;
    case kLfoPhaser: return 0.4;
    case kLfoPan: return 1.0;
    default: return 0.5;  // filter
  }
}

// engine.js chains: feedback base, lines, loop filter, output tap.
struct ChainSpec {
  double fbBase;
  int lines;
  bool hasFilter;
  dsp::BiquadType filter;
  float freq, q;
  bool outFilter;  // output = the filter (else the delay)
};
ChainSpec chainSpec(FxType t) noexcept {
  using BT = dsp::BiquadType;
  switch (t) {
    case FxType::Echo: return {0.45, 1, true, BT::Highpass, 120.0f, 1.0f, false};     // echoHp, default Q 1
    case FxType::Delay: return {0.22, 1, false, BT::Highpass, 0, 0, false};
    case FxType::PingPong: return {0.42, 2, false, BT::Highpass, 0, 0, false};
    case FxType::LowCut: return {0.5, 1, true, BT::Highpass, 700.0f, 1.0f, false};    // output = the delay
    case FxType::Spiral: return {0.72, 1, true, BT::Bandpass, 900.0f, 0.9f, true};
    case FxType::UpEcho: return {0.5, 1, true, BT::Highpass, 500.0f, 1.0f, true};
    case FxType::DownEcho: return {0.5, 1, true, BT::Lowpass, 1200.0f, 1.0f, true};
    case FxType::Helix: return {0.97, 1, false, BT::Highpass, 0, 0, false};
    case FxType::MtDelay: return {0.0, 3, false, BT::Highpass, 0, 0, false};
    default: return {0.0, 0, false, BT::Highpass, 0, 0, false};
  }
}

inline void zero2(float* l, float* r, int n) noexcept {
  std::memset(l, 0, sizeof(float) * static_cast<size_t>(n));
  std::memset(r, 0, sizeof(float) * static_cast<size_t>(n));
}

// StereoPannerNode, stereo input (Chromium PanToTargetValue /
// PanWithSampleAccurateValues: double gains, float result).
struct PanGains {
  bool left = true;  // pan <= 0
  double gL = 1, gR = 0;
  explicit PanGains(float pan) noexcept {
    const float p = pan < -1.0f ? -1.0f : (pan > 1.0f ? 1.0f : pan);
    left = p <= 0;
    const double rad = static_cast<double>(left ? p + 1.0f : p) * (kPi / 2);
    gL = std::cos(rad);
    gR = std::sin(rad);
  }
  void apply(float inL, float inR, float& outL, float& outR) const noexcept {
    if (left) {
      outL = static_cast<float>(inL + inR * gL);
      outR = static_cast<float>(inR * gR);
    } else {
      outL = static_cast<float>(inL * gL);
      outR = static_cast<float>(inR + inL * gR);
    }
  }
};

// Allpass / bandpass coefficients with Chromium's formulas (om/dsp.h without
// the unused gain term), for per-sample updates.
inline dsp::BiquadCoeffs bandCoeffs(bool allpass, double sr, double freq, double q) noexcept {
  const double nyquist = 0.5 * sr;
  double f = freq / nyquist;
  f = f < 0 ? 0 : (f > 1 ? 1 : f);
  if (!(f > 0 && f < 1)) return allpass ? dsp::BiquadCoeffs{1, 0, 0, 0, 0} : dsp::BiquadCoeffs{0, 0, 0, 0, 0};
  if (!(q > 0)) return allpass ? dsp::BiquadCoeffs{-1, 0, 0, 0, 0} : dsp::BiquadCoeffs{1, 0, 0, 0, 0};
  const double w0 = kPi * f;
  const double alpha = std::sin(w0) / (2 * q);
  const double k = std::cos(w0);
  const double inv = 1.0 / (1 + alpha);
  if (allpass) return dsp::BiquadCoeffs{(1 - alpha) * inv, -2 * k * inv, (1 + alpha) * inv, -2 * k * inv, (1 - alpha) * inv};
  return dsp::BiquadCoeffs{alpha * inv, 0, -alpha * inv, -2 * k * inv, (1 - alpha) * inv};
}

inline float clampDelay(float d, float maxSec) noexcept { return d < 0 ? 0 : (d > maxSec ? maxSec : d); }

struct LfoState {
  fx::Param rate;     // OscillatorNode.frequency (Hz)
  double vri = 0;     // phase in table units (free-running; kept continuous while locked)
  bool locked = false;
  double lockP = 0;   // modulation period (beats) of the lock
  double boundary = kNaN;  // beat position where the lock starts (engine.js nextBoundaryAt)
};

}  // namespace

struct FxUnit::Impl {
  // engine.js FxUnit fields
  FxType type = FxType::Echo;
  bool enabled = false;
  float level = 0.0f;
  float beatsMult = 0.5f;
  double beatDur = 0.5;
  BeatClock clock;
  int64_t sinceClock = 0;  // frames processed since the last setBeatClock
  int64_t frame = 0;       // the unit's timeline: frames handed to process() since prepare()
  // rate
  double sr = 48000;
  float srF = 48000.0f;
  int maxBlock = kMaxBlockFrames;
  bool prepared = false;
  std::shared_ptr<const ConvolverKernel> reverbKernel;
  // chains: [Echo] made by the constructor / prepare(), lazy ones attached (all owned)
  FxChain* chains[kNumFxTypes] = {};
  // always-present parts
  fx::Param wet;
  std::vector<float> flMem;  // flanger DelayNode(0.05)
  fx::Lines fl;
  float flRing[2][kFbQuantum] = {};  // the flanger output one quantum ago
  int flRingPos = 0;
  fx::Param flFb;                    // flFb.gain
  fx::BiquadState ph[4][2];          // phaser stages
  fx::BiquadState bp[2];             // filter (fxbp)
  fx::Param depth;                   // fxbpLfoGain.gain
  LfoState lfo[kNumLfos];
  int activeLfo = -1;
  fx::OscPhase osc;
  double robotVri = 0;
  std::shared_ptr<const fx::SquareTables> square;
  std::shared_ptr<const fx::SineTable> sine;  // Chromium's sine table (LFOs, robot)
  float crush[fx::kCurveLength] = {};
  const PanGains panL{-0.85f}, panR{0.85f};  // ping-pong panners

  double timeNow() const noexcept { return clampv(beatDur * static_cast<double>(beatsMult), 0.02, 3.9); }
  double fbFor(double base) const noexcept { return std::min(0.97, base * (0.55 + 0.45 * level)); }

  void applyTime() noexcept {
    const double t = timeNow();
    for (FxChain* c : chains)
      if (c && c->born && c->lines.count > 0) c->delay.setTarget(t, 0.08, sr, frame);
    for (int i = 0; i < kNumLfos; i++) {
      double k, lo, hi;
      lfoRateLaw(i, k, lo, hi);
      lfo[i].rate.setTarget(clampv(k / t, lo, hi), lfoTau(i), sr, frame);
    }
  }

  // Lazily built chains are born when first routed (engine.js _chain).
  void birth(FxChain& c) noexcept {
    if (c.born) return;
    c.delay.set(timeNow());
    c.fb.set(fbFor(c.fbBase));
    c.born = true;
  }
  // engine.js _route(): the selected chain is built (born) at the moment the
  // unit is routed to it, i.e. in setType / setEnabled, before any later
  // _applyTime or setLevel; a chain whose memory arrives later is born when
  // it is attached.
  void route() noexcept {
    if (!enabled || !prepared) return;
    FxChain* c = chains[static_cast<int>(type)];
    if (c && c->lines.count > 0) birth(*c);
  }

  // The wet GainNode is always processed (connected to the output).
  void touchWet(int64_t f0, int n) noexcept {
    for (int i = 0; i < n; i++) wet.at(f0 + i);
  }

  // ---- delay family ----------------------------------------------------------------
  // The delay time of each channel (Chromium's DelayNode computes its
  // delayTime automation once per channel kernel: fx::Param::atKernel), as
  // Chromium's single-precision read taps; one tap when both are equal.
  struct StereoTap {
    fx::Tap l, r;
  };
  StereoTap delayTaps(FxChain& c, const fx::Lines& L, int64_t f) noexcept {
    const float maxSec = static_cast<float>(kLineSeconds);
    const float dl = clampDelay(c.delay.atKernel(f, 0), maxSec) * srF;
    const float dr = clampDelay(c.delay.atKernel(f, 1), maxSec) * srF;
    const fx::Tap tl = fx::chromiumTap(L, dl);
    return {tl, dr == dl ? tl : fx::chromiumTap(L, dr)};
  }

  void processLoop(FxChain& c, bool outFilter, const float* inL, const float* inR, float* outL, float* outR, int n,
                   int64_t f0) noexcept {
    fx::Lines& L = c.lines;
    float* bl = L.line(0, 0);
    float* br = L.line(0, 1);
    for (int i = 0; i < n; i++) {
      const int64_t f = f0 + i;
      const StereoTap tp = delayTaps(c, L, f);
      const float g = c.fb.at(f);
      const float xl = inL[i], xr = inR[i];
      float yl, yr;
      if (L.valid >= L.len) {
        yl = fx::readTap(bl, tp.l);
        yr = fx::readTap(br, tp.r);
      } else {
        yl = fx::readTapValid(bl, tp.l, L.valid);
        yr = fx::readTapValid(br, tp.r, L.valid);
      }
      float zl = yl, zr = yr;  // loop filter output
      if (c.hasFilter) {
        zl = fx::biquadTick(c.filterCoeffs, c.filter[0], yl);
        zr = fx::biquadTick(c.filterCoeffs, c.filter[1], yr);
      }
      bl[L.w] = xl + g * zl;
      br[L.w] = xr + g * zr;
      L.advance();
      const float wg = wet.at(f);
      outL[i] = (outFilter ? zl : yl) * wg;
      outR[i] = (outFilter ? zr : yr) * wg;
    }
    c.filter[0].flushTiny();
    c.filter[1].flushTiny();
  }

  void processPingPong(FxChain& c, const float* inL, const float* inR, float* outL, float* outR, int n, int64_t f0) noexcept {
    fx::Lines& L = c.lines;
    float* ll = L.line(0, 0);
    float* lr = L.line(0, 1);
    float* rl = L.line(1, 0);
    float* rr = L.line(1, 1);
    const bool checked = L.valid < L.len;
    for (int i = 0; i < n; i++) {
      const int64_t f = f0 + i;
      const float g = c.fb.at(f);
      const StereoTap tp = delayTaps(c, L, f);  // both DelayNodes carry the same automation
      float a0, a1, b0, b1;  // L line output (l, r), R line output (l, r)
      if (!checked) {
        a0 = fx::readTap(ll, tp.l);
        a1 = fx::readTap(lr, tp.r);
        b0 = fx::readTap(rl, tp.l);
        b1 = fx::readTap(rr, tp.r);
      } else {
        a0 = fx::readTapValid(ll, tp.l, L.valid);
        a1 = fx::readTapValid(lr, tp.r, L.valid);
        b0 = fx::readTapValid(rl, tp.l, L.valid);
        b1 = fx::readTapValid(rr, tp.r, L.valid);
      }
      ll[L.w] = inL[i] + g * b0;  // R -> fb -> L
      lr[L.w] = inR[i] + g * b1;
      rl[L.w] = a0;               // L -> R
      rr[L.w] = a1;
      L.advance();
      float pl0, pl1, pr0, pr1;
      panL.apply(a0, a1, pl0, pl1);
      panR.apply(b0, b1, pr0, pr1);
      const float wg = wet.at(f);
      outL[i] = (pl0 + pr0) * wg;
      outR[i] = (pl1 + pr1) * wg;
    }
  }

  void processMtDelay(FxChain& c, const float* inL, const float* inR, float* outL, float* outR, int n, int64_t f0) noexcept {
    fx::Lines& L = c.lines;
    float* d[3][2] = {{L.line(0, 0), L.line(0, 1)}, {L.line(1, 0), L.line(1, 1)}, {L.line(2, 0), L.line(2, 1)}};
    const bool checked = L.valid < L.len;
    for (int i = 0; i < n; i++) {
      const int64_t f = f0 + i;
      const StereoTap st = delayTaps(c, L, f);
      const fx::Tap tp[2] = {st.l, st.r};
      const float x[2] = {inL[i], inR[i]};
      float y[3][2];
      for (int k = 0; k < 3; k++)
        for (int ch = 0; ch < 2; ch++)
          y[k][ch] = checked ? fx::readTapValid(d[k][ch], tp[ch], L.valid) : fx::readTap(d[k][ch], tp[ch]);
      for (int ch = 0; ch < 2; ch++) {
        d[0][ch][L.w] = x[ch];     // d1 <- input
        d[1][ch][L.w] = y[0][ch];  // d2 <- d1
        d[2][ch][L.w] = y[1][ch];  // d3 <- d2
      }
      L.advance();
      const float wg = wet.at(f);
      for (int ch = 0; ch < 2; ch++) {
        const float s = 0.8f * y[0][ch] + 0.55f * y[1][ch] + 0.35f * y[2][ch];
        (ch == 0 ? outL : outR)[i] = s * wg;
      }
    }
  }

  // ---- LFOs ----------------------------------------------------------------------
  // Per-block driver of the current modulation's oscillator: free-running
  // like the engine.js OscillatorNode (phase frozen while not routed), or
  // phase-locked to the beat clock: phase = frac(beatPos / P), starting at
  // the next grid boundary (engine.js nextBoundaryAt: a multiple of P beats
  // under 1 beat, else of min(P, 4)) and kept every sample afterwards.
  struct LfoDriver {
    Impl& m;
    LfoState& L;
    int64_t f0;
    int i = 0;
    bool clockOk = false;
    double peff = 0;
    double bp = 0, bpStep = 0;  // beat position of the current sample, per sample
    float lockIncr = 0;
    LfoDriver(Impl& mm, int li, int64_t at, int64_t frame0) noexcept : m(mm), L(mm.lfo[li]), f0(frame0) {
      const BeatClock& bc = m.clock;
      const double P = periodBeats(li);
      clockOk = bc.valid && bc.playing && bc.beatsPerSec > 0 && std::isfinite(bc.beatPos) && P > 0 && std::isfinite(P);
      if (!clockOk) {
        L.locked = false;
        L.boundary = kNaN;
        return;
      }
      // Period of the lock: P when the engine.js rate is not clamped, else
      // the period the clamped rate gives at this beat duration.
      double k, lo, hi;
      lfoRateLaw(li, k, lo, hi);
      const double rawT = m.beatDur * static_cast<double>(m.beatsMult);
      const double t = m.timeNow();
      const double raw = k / t;
      const double rate = clampv(raw, lo, hi);
      peff = (t == rawT && rate == raw) ? P : 1.0 / (rate * m.beatDur);
      if (L.locked && std::fabs(peff - L.lockP) > 1e-9 * peff) {
        L.locked = false;
        L.boundary = kNaN;
      }
      bp = bc.beatPos + bc.beatsPerSec * static_cast<double>(at) / m.sr;
      bpStep = bc.beatsPerSec / m.sr;
      if (!L.locked) {
        const double G = P < 1 ? P : std::min(P, 4.0);
        if (std::isnan(L.boundary) || bp < L.boundary - G) L.boundary = std::ceil(bp / G + 1e-6) * G;
      }
      lockIncr = m.osc.increment(static_cast<float>(bc.beatsPerSec / peff));
    }
    double periodBeats(int li) const noexcept {
      const double mm = m.beatsMult;
      switch (li) {
        case kLfoTrans: return mm;
        case kLfoFlanger: return 8 * mm;
        case kLfoPhaser: return 4 * mm;
        default: return 2 * mm;
      }
    }
    // Phase (table units) and increment of this sample, then advance.
    void step(double& vri, float& incr) noexcept {
      const float f = L.rate.at(f0 + i++);
      incr = m.osc.increment(f);
      if (clockOk) {
        if (!L.locked && bp >= L.boundary) {
          L.locked = true;
          L.lockP = peff;
        }
        if (L.locked) {
          double cycles = bp / L.lockP;
          cycles -= std::floor(cycles);
          vri = cycles * m.osc.size;
          incr = lockIncr;
        } else {
          vri = L.vri;
        }
        bp += bpStep;
      } else {
        vri = L.vri;
      }
      L.vri = m.osc.wrap(vri + incr);
    }
    float sine() noexcept {
      double v;
      float inc;
      step(v, inc);
      return m.sine ? m.sine->sample(v, inc) : m.osc.sine(v);
    }
    float squareWave() noexcept {
      double v;
      float inc;
      step(v, inc);
      return m.square ? m.square->sample(v, inc) : (v < 0.5 * m.osc.size ? 1.0f : -1.0f);
    }
  };

  void processFlanger(const float* inL, const float* inR, float* outL, float* outR, int n, int64_t at, int64_t f0) noexcept {
    LfoDriver drv(*this, kLfoFlanger, at, f0);
    float* b[2] = {fl.line(0, 0), fl.line(0, 1)};
    const bool checked = fl.valid < fl.len;
    for (int i = 0; i < n; i++) {
      const int64_t f = f0 + i;
      const float lfoV = drv.sine();
      // delayTime = 0.004 (intrinsic) + flLfoGain output (0.0022 * LFO)
      const float desired = clampDelay(0.004f + lfoV * 0.0022f, static_cast<float>(kFlangerMaxSec)) * srF;
      const float g = flFb.at(f);
      const fx::Tap tp = fx::chromiumTap(fl, desired);
      const float x[2] = {inL[i], inR[i]};
      float y[2];
      for (int ch = 0; ch < 2; ch++) {
        // Chromium order: the quantum's input (with the feedback of one
        // quantum ago) is written, then the delayed signal is read.
        b[ch][fl.w] = x[ch] + g * flRing[ch][flRingPos];
        y[ch] = checked ? fx::readTapValid(b[ch], tp, fl.valid) : fx::readTap(b[ch], tp);
        flRing[ch][flRingPos] = y[ch];
      }
      flRingPos = (flRingPos + 1) & (kFbQuantum - 1);
      fl.advance();
      const float wg = wet.at(f);
      outL[i] = y[0] * wg;
      outR[i] = y[1] * wg;
    }
  }

  void processPhaser(const float* inL, const float* inR, float* outL, float* outR, int n, int64_t at, int64_t f0) noexcept {
    LfoDriver drv(*this, kLfoPhaser, at, f0);
    const double q = static_cast<double>(0.6f);
    for (int i = 0; i < n; i++) {
      const float lfoV = drv.sine();
      const float fm = lfoV * 280.0f;  // phLfoGain
      float l = inL[i], r = inR[i];
      for (int s = 0; s < 4; s++) {
        const float freq = kPhaserHz[s] + fm;
        const dsp::BiquadCoeffs c = bandCoeffs(true, sr, static_cast<double>(freq), q);
        l = fx::biquadTick(c, ph[s][0], l);
        r = fx::biquadTick(c, ph[s][1], r);
      }
      const float wg = wet.at(f0 + i);
      outL[i] = l * wg;
      outR[i] = r * wg;
    }
    for (auto& st : ph) {
      st[0].flushTiny();
      st[1].flushTiny();
    }
  }

  void processFilter(const float* inL, const float* inR, float* outL, float* outR, int n, int64_t at, int64_t f0) noexcept {
    LfoDriver drv(*this, kLfoFilter, at, f0);
    const double q = static_cast<double>(1.4f);
    for (int i = 0; i < n; i++) {
      const int64_t f = f0 + i;
      const float lfoV = drv.sine();
      const float dep = depth.at(f);
      const float freq = 800.0f + lfoV * dep;  // fxbp.frequency = 800 + fxbpLfoGain
      const dsp::BiquadCoeffs c = bandCoeffs(false, sr, static_cast<double>(freq), q);
      const float l = fx::biquadTick(c, bp[0], inL[i]);
      const float r = fx::biquadTick(c, bp[1], inR[i]);
      const float wg = wet.at(f);
      outL[i] = l * wg;
      outR[i] = r * wg;
    }
    bp[0].flushTiny();
    bp[1].flushTiny();
  }

  void processTrans(const float* inL, const float* inR, float* outL, float* outR, int n, int64_t at, int64_t f0) noexcept {
    LfoDriver drv(*this, kLfoTrans, at, f0);
    for (int i = 0; i < n; i++) {
      const float sq = drv.squareWave();
      const float g = 0.5f + sq * 0.5f;  // trConst (0.5) + trOscGain (0.5 * square)
      const float wg = wet.at(f0 + i);
      outL[i] = (inL[i] * g) * wg;
      outR[i] = (inR[i] * g) * wg;
    }
  }

  void processPan(const float* inL, const float* inR, float* outL, float* outR, int n, int64_t at, int64_t f0) noexcept {
    LfoDriver drv(*this, kLfoPan, at, f0);
    for (int i = 0; i < n; i++) {
      const float lfoV = drv.sine();
      float l, r;
      PanGains(lfoV * 0.9f).apply(inL[i], inR[i], l, r);  // panLfoGain 0.9
      const float wg = wet.at(f0 + i);
      outL[i] = l * wg;
      outR[i] = r * wg;
    }
  }

  void processRobot(const float* inL, const float* inR, float* outL, float* outR, int n, int64_t f0) noexcept {
    const float incr = osc.increment(kRobotHz);
    for (int i = 0; i < n; i++) {
      const float s = sine ? sine->sample(robotVri, incr) : osc.sine(robotVri);
      robotVri = osc.wrap(robotVri + incr);
      const float wg = wet.at(f0 + i);
      outL[i] = (inL[i] * s) * wg;
      outR[i] = (inR[i] * s) * wg;
    }
  }

  void processCrush(const float* inL, const float* inR, float* outL, float* outR, int n, int64_t f0) noexcept {
    for (int i = 0; i < n; i++) {
      const float l = fx::shape(crush, inL[i]);
      const float r = fx::shape(crush, inR[i]);
      const float wg = wet.at(f0 + i);
      outL[i] = l * wg;
      outR[i] = r * wg;
    }
  }

  void processReverb(FxChain& c, const float* inL, const float* inR, float* outL, float* outR, int n, int64_t f0) noexcept {
    if (!c.reverb) {
      zero2(outL, outR, n);
      touchWet(f0, n);
      return;
    }
    c.reverb->process(inL, inR, outL, outR, n);
    for (int i = 0; i < n; i++) {
      const float wg = wet.at(f0 + i);
      outL[i] *= wg;
      outR[i] *= wg;
    }
  }

  // Memory of a chain for this rate (control thread). False: out of memory.
  bool setupChain(FxChain& c, FxType t) {
    c.type = static_cast<uint8_t>(t);
    c.color = false;
    c.sampleRate = sr;
    c.born = false;
    if (t == FxType::Reverb) {
      if (!c.reverb) c.reverb = std::make_unique<Convolver>();
      c.reverb->prepare(reverbKernel, maxBlock);
      return true;
    }
    const ChainSpec s = chainSpec(t);
    const int len = fx::chromiumDelayBufferLength(kLineSeconds, sr);  // createDelay(4)
    c.allocLines(s.lines, len, len);
    c.fbBase = s.fbBase;
    c.hasFilter = s.hasFilter;
    if (s.hasFilter)
      c.filterCoeffs = dsp::webAudioBiquad(s.filter, sr, static_cast<double>(s.freq), static_cast<double>(s.q), 0.0);
    c.filter[0].reset();
    c.filter[1].reset();
    return true;
  }
};

FxUnit::FxUnit() : impl_(std::make_unique<Impl>()) {
  Impl& m = *impl_;
  // engine.js constructor values
  m.wet.set(0.0);
  m.flFb.set(0.4);
  m.depth.set(650.0);
  for (int i = 0; i < kNumLfos; i++) m.lfo[i].rate.set(lfoDefaultHz(i));
  auto* echo = new FxChain();
  echo->type = static_cast<uint8_t>(FxType::Echo);
  echo->fbBase = 0.45;
  echo->delay.set(0.25);  // echoDelay.delayTime.value = 0.25
  echo->fb.set(0.45);     // echoFb.gain.value = 0.45 (raw until the first setLevel)
  echo->born = true;
  m.chains[static_cast<int>(FxType::Echo)] = echo;
}

FxUnit::~FxUnit() {
  for (FxChain*& c : impl_->chains) {
    FxChainDeleter()(c);
    c = nullptr;
  }
}

void FxUnit::prepare(double sampleRate, int maxBlockFrames, std::shared_ptr<const ConvolverKernel> reverbKernel) {
  Impl& m = *impl_;
  m.prepared = false;
  m.sr = sampleRate > 0 ? sampleRate : 48000.0;
  m.srF = static_cast<float>(m.sr);
  m.maxBlock = maxBlockFrames > 0 ? maxBlockFrames : kMaxBlockFrames;
  m.reverbKernel = std::move(reverbKernel);
  m.frame = 0;
  m.osc.prepare(m.sr);
  m.square = fx::SquareTables::get(m.sr, kTransMaxHz);
  m.sine = fx::SineTable::get(m.sr);
  fx::makeCrushCurve(8, m.crush);
  // The echo line (engine.js builds it in the constructor) and the attached
  // lazy chains, for this rate.
  for (int t = 0; t < kNumFxTypes; t++) {
    FxChain* c = m.chains[t];
    if (!c) continue;
    const bool wasBorn = c->born;
    m.setupChain(*c, static_cast<FxType>(t));
    if (t == static_cast<int>(FxType::Echo)) c->born = wasBorn;  // the echo exists from the start
    c->delay.settle();
    c->fb.settle();
  }
  const int flLen = fx::chromiumDelayBufferLength(kFlangerMaxSec, m.sr);  // createDelay(0.05)
  m.flMem.assign(static_cast<size_t>(2 * flLen), 0.0f);
  m.fl.mem = m.flMem.data();
  m.fl.len = flLen;
  m.fl.count = 1;
  m.fl.w = 0;
  m.fl.vlen = flLen;
  m.fl.vw = 0;
  m.fl.valid = flLen;
  std::memset(m.flRing, 0, sizeof(m.flRing));
  m.flRingPos = 0;
  for (auto& st : m.ph) st[0].reset(), st[1].reset();
  m.bp[0].reset();
  m.bp[1].reset();
  for (auto& l : m.lfo) {
    l.rate.settle();
    l.vri = 0;
    l.locked = false;
    l.boundary = kNaN;
  }
  m.activeLfo = -1;
  m.robotVri = 0;
  m.wet.settle();
  m.flFb.settle();
  m.depth.settle();
  m.prepared = true;
  m.route();
}

bool FxUnit::isLazy(FxType t) noexcept {
  switch (t) {
    case FxType::Delay:
    case FxType::PingPong:
    case FxType::LowCut:
    case FxType::Spiral:
    case FxType::UpEcho:
    case FxType::DownEcho:
    case FxType::Helix:
    case FxType::MtDelay:
    case FxType::Reverb:
      return true;
    default:
      return false;
  }
}

FxChainPtr FxUnit::makeChain(FxType t) const {
  if (!isLazy(t)) return nullptr;
  FxChainPtr c(new (std::nothrow) FxChain());
  if (!c) return nullptr;
  try {
    if (!impl_->setupChain(*c, t)) return nullptr;
  } catch (...) {
    return nullptr;  // out of memory: the type stays silent
  }
  return c;
}

size_t FxUnit::memoryBytes() const noexcept {
  const Impl& m = *impl_;
  size_t b = sizeof(Impl) + m.flMem.capacity() * sizeof(float);
  for (const FxChain* c : m.chains)
    if (c) b += c->bytes();
  return b;
}

FxChain* FxUnit::attachChain(FxType t, FxChain* chain) noexcept {
  Impl& m = *impl_;
  if (!chain || !isLazy(t)) return chain;
  FxChain*& slot = m.chains[static_cast<int>(t)];
  if (slot) return chain;  // already filled: the caller retires it
  if (chain->color || chain->type != static_cast<uint8_t>(t) || chain->sampleRate != m.sr) return chain;
  slot = chain;
  if (m.type == t) m.route();  // routed already: engine.js would have built it then
  return nullptr;
}

bool FxUnit::hasChain(FxType t) const noexcept { return !isLazy(t) || impl_->chains[static_cast<int>(t)] != nullptr; }

void FxUnit::reset() noexcept {
  Impl& m = *impl_;
  for (FxChain* c : m.chains)
    if (c) c->clear();
  m.fl.valid = 0;
  std::memset(m.flRing, 0, sizeof(m.flRing));
  for (auto& st : m.ph) st[0].reset(), st[1].reset();
  m.bp[0].reset();
  m.bp[1].reset();
}

void FxUnit::setType(FxType t) noexcept {
  if (static_cast<int>(t) < 0 || static_cast<int>(t) >= kNumFxTypes) return;
  impl_->type = t;
  impl_->route();
}

void FxUnit::setEnabled(bool on) noexcept {
  impl_->enabled = on;
  impl_->route();
}

void FxUnit::setLevel(float v) noexcept {
  Impl& m = *impl_;
  if (std::isnan(v)) return;
  m.level = clampv(v, 0.0f, 1.0f);
  m.wet.setTarget(m.level, 0.02, m.sr, m.frame);
  // The intensity also acts inside the effect (engine.js setLevel).
  for (FxChain* c : m.chains)
    if (c && c->born && c->fbBase > 0) c->fb.setTarget(m.fbFor(c->fbBase), 0.05, m.sr, m.frame);
  m.depth.setTarget(650.0 * (0.35 + 0.65 * m.level), 0.05, m.sr, m.frame);
  m.flFb.setTarget(0.15 + 0.5 * m.level, 0.05, m.sr, m.frame);
}

void FxUnit::setBeatsMult(float mult) noexcept {
  Impl& m = *impl_;
  if (!std::isfinite(mult)) return;
  m.beatsMult = mult;
  m.applyTime();
}

void FxUnit::setBeatClock(const BeatClock& bc) noexcept {
  Impl& m = *impl_;
  m.clock = bc;
  m.sinceClock = 0;
  const double sec = bc.beatDur;
  if (!(sec > 0) || !std::isfinite(sec)) return;
  // engine.js setBeatDur: 0.05 % threshold (an echo off by half a percent drifts every repeat)
  if (std::fabs(sec - m.beatDur) < m.beatDur * 0.0005) return;
  m.beatDur = sec;
  m.applyTime();
}

float FxUnit::wetGain() const noexcept { return static_cast<float>(impl_->wet.value()); }

void FxUnit::process(const float* inL, const float* inR, float* outL, float* outR, int n) noexcept {
  Impl& m = *impl_;
  if (n <= 0) return;
  const int64_t at = m.sinceClock;
  const int64_t f0 = m.frame;
  m.sinceClock += n;
  m.frame += n;
  if (!m.prepared || !m.enabled) {
    zero2(outL, outR, n);
    m.touchWet(f0, n);
    m.activeLfo = -1;
    return;
  }
  const FxType t = m.type;
  // A modulation that becomes routed re-aligns (engine.js fxTick on a new key).
  const int li = lfoIndexOf(t);
  if (li != m.activeLfo) {
    if (li >= 0) {
      m.lfo[li].locked = false;
      m.lfo[li].boundary = kNaN;
    }
    m.activeLfo = li;
  }
  FxChain* c = m.chains[static_cast<int>(t)];
  switch (t) {
    case FxType::Echo:
    case FxType::Delay:
    case FxType::LowCut:
    case FxType::Spiral:
    case FxType::UpEcho:
    case FxType::DownEcho:
    case FxType::Helix:
    case FxType::PingPong:
    case FxType::MtDelay: {
      if (!c || c->lines.count <= 0) break;  // memory not attached yet: silence
      m.birth(*c);
      if (t == FxType::PingPong)
        m.processPingPong(*c, inL, inR, outL, outR, n, f0);
      else if (t == FxType::MtDelay)
        m.processMtDelay(*c, inL, inR, outL, outR, n, f0);
      else
        m.processLoop(*c, chainSpec(t).outFilter, inL, inR, outL, outR, n, f0);
      return;
    }
    case FxType::Reverb:
      if (!c) break;
      m.processReverb(*c, inL, inR, outL, outR, n, f0);
      return;
    case FxType::Flanger: m.processFlanger(inL, inR, outL, outR, n, at, f0); return;
    case FxType::Phaser: m.processPhaser(inL, inR, outL, outR, n, at, f0); return;
    case FxType::Trans: m.processTrans(inL, inR, outL, outR, n, at, f0); return;
    case FxType::Pan: m.processPan(inL, inR, outL, outR, n, at, f0); return;
    case FxType::Filter: m.processFilter(inL, inR, outL, outR, n, at, f0); return;
    case FxType::Robot: m.processRobot(inL, inR, outL, outR, n, f0); return;
    case FxType::Crush: m.processCrush(inL, inR, outL, outR, n, f0); return;
    case FxType::Roll:  // the deck plays the roll; engine.js routes the unit to a muted gain
    default: break;
  }
  zero2(outL, outR, n);
  m.touchWet(f0, n);
}

FxType FxUnit::type() const noexcept { return impl_->type; }
bool FxUnit::enabled() const noexcept { return impl_->enabled; }
float FxUnit::level() const noexcept { return impl_->level; }
float FxUnit::beatsMult() const noexcept { return impl_->beatsMult; }
double FxUnit::beatDuration() const noexcept { return impl_->beatDur; }

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

double FxUnit::delayTimeSec() const noexcept { return impl_->timeNow(); }  // engine.js _timeNow

double FxUnit::lineDelaySec() const noexcept {
  const FxChain* c = impl_->chains[static_cast<int>(impl_->type)];
  return c && c->born && c->lines.count > 0 ? c->delay.value() : 0.0;
}

double FxUnit::feedbackGain() const noexcept {
  const Impl& m = *impl_;
  if (m.type == FxType::Flanger) return m.flFb.value();
  const FxChain* c = m.chains[static_cast<int>(m.type)];
  return c && c->born && c->fbBase > 0 ? c->fb.value() : 0.0;
}

double FxUnit::lfoRateHz() const noexcept {
  const int li = lfoIndexOf(impl_->type);
  if (impl_->type == FxType::Robot) return kRobotHz;
  return li >= 0 ? impl_->lfo[li].rate.value() : 0.0;
}

double FxUnit::lfoPhase() const noexcept {
  const Impl& m = *impl_;
  if (m.type == FxType::Robot) return m.robotVri / m.osc.size;
  const int li = lfoIndexOf(m.type);
  return li >= 0 ? m.lfo[li].vri / m.osc.size : 0.0;
}

bool FxUnit::lfoLocked() const noexcept {
  const int li = lfoIndexOf(impl_->type);
  return li >= 0 && impl_->lfo[li].locked;
}

}  // namespace om
