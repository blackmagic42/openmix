// Channel strip of one deck and the filters it shares with the master bus
// (owner: mixer, private header). engine.js Deck nodes, in order:
//   TRIM 4^v -> EQ lowshelf 200 Hz / peaking 1 kHz Q 0.9 / highshelf 8 kHz
//   (v >= 0 ? 6v : 40v dB) -> FILTER (dead zone 0.04, HPF 20*400^v,
//   LPF 20000*(80/20000)^-v, Q 0.9 dB, set instantly) -> [insert, by the
//   mixer] -> post taps (PFL cue send, meter, Color send) -> fader v^2
//   (+ Color noise) -> crossfader gain -> FX sends / pad send -> dryOut.
// Every gain is an AParam (Chromium setTargetAtTime values, aparam.h); the
// EQ biquads recompute their coefficients PER FRAME while their gain
// moves, exactly like Chromium's BiquadFilterNode under automation; the
// biquads use Chromium's direct form I (double state, float output fed
// back). A filter whose coefficients are exactly transparent (EQ band at
// 0 dB, FILTER in its dead zone) is bypassed once its state is transparent
// too: the output is then bit-identical to filtering. Real-time safe after
// prepare().
#pragma once

#include <cstdint>
#include <vector>

#include "aparam.h"
#include "om/common.h"
#include "om/dsp.h"
#include "om/meter.h"

namespace om {
namespace mixer_detail {

// ---------------------------------------------------------------------------
// Biquad building blocks (Chromium Biquad::Process, direct form I)
// ---------------------------------------------------------------------------
struct BiquadState {
  double x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  bool transparent() const noexcept { return y1 == x1 && y2 == x2; }
};

// Constant coefficients, in place.
void biquadBlock(const dsp::BiquadCoeffs& k, BiquadState& s, float* x, int n) noexcept;
// Identity filter (coefficients b == a): keeps the history only. Valid when
// the state is transparent (then filtering would return x exactly).
void biquadIdentity(BiquadState& s, const float* x, int n) noexcept;
// Chromium's end-of-quantum flush: a silent input with a subnormal tail.
void biquadFlush(BiquadState& s) noexcept;

// A series of up to 4 stereo biquads with constant coefficients over one
// block (EQ low -> mid -> high -> FILTER; the master filter). Each biquad
// stage computes exactly what biquadBlock() would (same operations, same
// order, same float rounding), but all stages and both channels advance
// sample by sample in one loop, so the CPU overlaps their recursions instead
// of waiting on one long dependency chain per filter and channel (~4x
// faster for two active EQ bands). Identity stages (transparent bypass) only
// keep their input history, taken from their neighbour: bit-identical to
// running every filter one after the other.
class Cascade {
 public:
  static constexpr int kMaxStages = 4;
  void addBiquad(const dsp::BiquadCoeffs* k, BiquadState* stereo) noexcept {
    k_[nb_] = k;
    s_[nb_] = stereo;
    nb_++;
  }
  // `stereo` (L, R) passes its input through; its history follows it.
  void addIdentity(BiquadState* stereo) noexcept {
    id_[ni_] = stereo;
    src_[ni_] = nb_ - 1;  // the biquad stage feeding it (-1 = the cascade input)
    ni_++;
  }
  // Runs the stages in order, in place, then flushes the biquad states.
  void run(float* l, float* r, int n) noexcept;

 private:
  const dsp::BiquadCoeffs* k_[kMaxStages] = {};
  BiquadState* s_[kMaxStages] = {};
  BiquadState* id_[kMaxStages] = {};
  int src_[kMaxStages] = {};
  int nb_ = 0;
  int ni_ = 0;
};

// One EQ band with its smoothed gain (dB).
class EqFilter {
 public:
  void prepare(dsp::BiquadType type, float frequency, float q, double sampleRate) noexcept;
  void setGainDb(float db, int64_t frame) noexcept { gain_.setTarget(db, 0.01, frame); }
  void snapGainDb(float db) noexcept;
  void resetState() noexcept { s_[0] = s_[1] = BiquadState(); }
  // In place; `scratch` holds n floats.
  void process(float* l, float* r, int n, int64_t f0, float* scratch) noexcept;
  // Gain idle (no automation): adds this band to a cascade (identity when
  // 0 dB with a transparent state, else a biquad) — what process() does.
  void addStatic(Cascade& c) noexcept;
  // Coefficients for a gain, bit-identical to dsp::webAudioBiquad (cached sin/cos).
  dsp::BiquadCoeffs coeffs(double gainDb) const noexcept;
  float gainDb() const noexcept { return gain_.value(); }
  const AParam& gainParam() const noexcept { return gain_; }
  const BiquadState& state(int ch) const noexcept { return s_[ch & 1]; }

 private:
  dsp::BiquadType type_ = dsp::BiquadType::Peaking;
  double sampleRate_ = 48000.0;
  double frequency_ = 1000.0;   // Hz (float value of the AudioParam)
  double q_ = 1.0;
  double f_ = 0.0;              // normalized frequency (0..1)
  double sinw0_ = 0.0, cosw0_ = 1.0;
  AParam gain_;
  dsp::BiquadCoeffs k_{};
  float kGain_ = 0.0f;
  bool kValid_ = false;
  BiquadState s_[2];
};

// engine.js Deck._applyBiquad / AudioEngine.setMasterFilter: peaking 1 kHz
// 0 dB (transparent) in the dead zone, else highpass / lowpass; changes are
// instant, and a change of filter TYPE resets the filter state (Chromium
// BiquadProcessor::SetType).
class DjFilter {
 public:
  enum class Kind : uint8_t { Neutral, Highpass, Lowpass };
  void prepare(double sampleRate) noexcept;
  void set(double v) noexcept;             // knob -1..1
  void resetState() noexcept { s_[0] = s_[1] = BiquadState(); }
  void process(float* l, float* r, int n) noexcept;
  void addStatic(Cascade& c) noexcept;     // what process() does, as a cascade stage
  Kind kind() const noexcept { return kind_; }
  float frequency() const noexcept { return freq_; }
  const dsp::BiquadCoeffs& coeffs() const noexcept { return k_; }

 private:
  void computeCoeffs() noexcept;
  double sampleRate_ = 48000.0;
  Kind kind_ = Kind::Neutral;
  float freq_ = 1000.0f;
  dsp::BiquadCoeffs k_{};
  BiquadState s_[2];
};

// ---------------------------------------------------------------------------
// Gain helpers over AParam values (scratch: n floats)
// ---------------------------------------------------------------------------
// dst = src * param (in place allowed)
void applyGain(AParam& p, const float* srcL, const float* srcR, float* dstL, float* dstR, int n, int64_t f0,
               float* scratch) noexcept;
// dst += src * param
void addGain(AParam& p, const float* srcL, const float* srcR, float* dstL, float* dstR, int n, int64_t f0,
             float* scratch) noexcept;
// dst += src
void addInto(const float* srcL, const float* srcR, float* dstL, float* dstR, int n) noexcept;

// Where the strip's taps and sends go for one block (nullptr = not routed).
// A FROZEN send is a GainNode that nothing pulls in engine.js (the Color bus
// in the "filter" / "noise" modes, the input of a disabled FX unit or pad
// unit): Chromium does not process it, so its automation stands still
// until it is pulled again (aparam.h). Its bus is never routed then.
struct StripBuses {
  float* cueL = nullptr;
  float* cueR = nullptr;
  float* colorL = nullptr;
  float* colorR = nullptr;
  float* fxL[kNumFxUnits] = {nullptr, nullptr, nullptr, nullptr};
  float* fxR[kNumFxUnits] = {nullptr, nullptr, nullptr, nullptr};
  float* padL = nullptr;
  float* padR = nullptr;
  float* dryL = nullptr;          // the master sum (input of masterGain)
  float* dryR = nullptr;
  const float* noise = nullptr;   // the shared Color "noise" source for this block (mono)
  bool colorFrozen = false;
  bool fxFrozen[kNumFxUnits] = {false, false, false, false};
  bool padFrozen = false;
};

class ChannelStrip {
 public:
  static constexpr double kKnobTau = 0.01;     // engine.js setTargetAtTime(..., 0.01)
  static constexpr double kSendTau = 0.015;    // updateFxSends
  static constexpr double kDryTau = 0.02;      // dry cut
  static constexpr double kPadOnTau = 0.01;    // setPadFx on
  static constexpr double kPadOffTau = 0.02;   // setPadFx off

  // Allocates the scratch buffers (control thread); keeps the settings.
  void prepare(double sampleRate, int maxFrames, double meterWindowSec);
  // engine.js defaults (Deck constructor + AudioEngine wiring), snapped,
  // filter states and meter cleared. Real-time safe.
  void resetDefaults() noexcept;

  // ---- engine.js setters (knob values); frame = the next frame to render ----
  void setTrim(double v, int64_t frame) noexcept;
  void setEq(int band, double v, int64_t frame) noexcept;   // 0 low, 1 mid, 2 high
  void setFilter(double v) noexcept { filter_.set(v); }
  void setVolume(double v, int64_t frame) noexcept;

  // Gains driven by the AudioEngine side (each = one engine.js GainNode).
  AParam xf;                     // d.xf (crossfader side gain)
  AParam dry;                    // d.dryOut (FX dry cut)
  AParam cue;                    // d.cueSend (PFL)
  AParam color;                  // d.colorSend
  AParam noise;                  // d.noiseGain
  AParam send[kNumFxUnits];      // d.fxSends[u]
  AParam pad;                    // d.padFxSend

  // Phase 1: input (pre-TRIM) -> TRIM -> EQ -> FILTER into l / r (the
  // buffers the insert reads and writes). Null input = silence.
  void front(const float* inL, const float* inR, float* l, float* r, int n, int64_t f0) noexcept;
  // Phase 2 (after the insert): taps and sends of `post` (l / r), fader,
  // crossfader, dry. `xfL` / `xfR`: n floats of work space.
  void back(const float* l, const float* r, float* xfL, float* xfR, int n, int64_t f0, const StripBuses& b) noexcept;

  const MeterWindow& meter() const noexcept { return meter_; }
  MeterWindow& meter() noexcept { return meter_; }
  const AParam& trimParam() const noexcept { return trim_; }
  const AParam& faderParam() const noexcept { return fader_; }
  const EqFilter& eqBand(int b) const noexcept { return eq_[b]; }
  const DjFilter& filter() const noexcept { return filter_; }

 private:
  double sampleRate_ = 48000.0;
  AParam trim_;
  EqFilter eq_[3];
  DjFilter filter_;
  AParam fader_;
  MeterWindow meter_;
  std::vector<float> scratch_;   // per-frame gain values
};

}  // namespace mixer_detail
}  // namespace om
