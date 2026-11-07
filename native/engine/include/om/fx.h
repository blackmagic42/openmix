// Beat FX unit of the native engine (owner: fx): port of engine.js FxUnit —
// one effect at a time among 18 types (17 DSP effects + ROLL, which the
// deck plays: the unit then outputs silence), LEVEL = wet gain AND intensity
// inside the effect (feedbacks, sweep depth, flanger feedback), beat
// fraction (1/4 .. 32 beats) following the reference deck's beat duration
// with the engine.js smoothing (delay times tau 80 ms, LFO rates tau 50-100
// ms, 0.05 % threshold), modulations phase-locked to the beat clock
// (replaces alignTo / fxTick re-alignment). Used for the 4 panel units, the
// pad units and the master FX. Implements IFxProcessor (common.h): the
// mixer drives it through that seam. SPEC.md §11.
//
// Web Audio details that are part of the sound and are reproduced (proven by
// null tests against golden renders of engine.js, SPEC.md §18.4): DelayNode
// linear interpolation; BiquadFilterNode formulas (om/dsp.h) with per-sample
// coefficients under modulation; ConvolverNode normalization
// (om/convolver.h); WaveShaperNode curve lookup; StereoPannerNode law;
// OscillatorNode phase accumulation and Chromium's band-limited, normalized
// "square" (TRANS); AudioParam setTargetAtTime; a node that is not routed is
// not processed (its state and its AudioParam automations stay frozen).
//
// Deliberate difference from Chromium (SPEC.md §20): Chromium processes a
// feedback cycle through a DelayNode one render quantum late, so every echo
// repeat of the Web engine lands 128 frames (2.67 ms at 48 kHz) later than the
// previous one. The native delay family (echo, delay, pingpong, lowcut,
// spiral, upecho, downecho, helix; mtdelay has no cycle) is drift-free: every
// repeat lands on its beat within one sample. The 128-frame quantum is kept
// only where it shapes the sound: the flanger's feedback.
//
// Memory (SPEC.md §11.5): like engine.js, chains are built lazily.
// prepare() allocates only what engine.js's FxUnit constructor builds and
// is cheap or default (echo line, flanger, phaser, trans, pan, filter, robot,
// crush). The other chains (isLazy()) are created on the CONTROL thread by
// makeChain() (zeroed memory) and handed to the unit on the audio thread by
// attachChain() through an AttachFxChain command; until then the unit outputs
// silence for that type. A unit owns its chains once attached and frees them
// in its destructor (control thread): they live as long as the unit, keeping
// their frozen state across type switches like engine.js's `_lazy` map.
//
// Threading: construction, prepare(), makeChain() and destruction on the
// control thread; everything else on the audio thread (RT-safe, no
// allocation, no free).
#pragma once

#include <cstddef>
#include <memory>

#include "om/common.h"
#include "om/convolver.h"

namespace om {

// Memory of one lazily built chain (delay lines, filter states, reverb
// state). Opaque: defined by the fx module. Shared by FxUnit and ColorFx.
class FxChain;
struct FxChainDeleter {
  void operator()(FxChain* c) const noexcept;  // control thread only
};
using FxChainPtr = std::unique_ptr<FxChain, FxChainDeleter>;

class FxUnit final : public IFxProcessor {
 public:
  FxUnit();
  ~FxUnit() override;  // frees the attached chains (control thread)
  FxUnit(const FxUnit&) = delete;
  FxUnit& operator=(const FxUnit&) = delete;

  // ---- control thread ------------------------------------------------------------
  // Allocates the always-present parts for this rate. `reverbKernel` is the
  // shared 2.2 s impulse (makeImpulse(2.2, 2.5) normalized) used when the
  // reverb chain is made. Keeps the parameters; re-prepares attached chains
  // (zeroed, for the new rate; they are born again on their next use).
  void prepare(double sampleRate, int maxBlockFrames, std::shared_ptr<const ConvolverKernel> reverbKernel);
  // Types whose memory is created on first use: delay, pingpong, lowcut,
  // spiral, upecho, downecho, helix, mtdelay, reverb.
  static bool isLazy(FxType t) noexcept;
  // Zeroed memory of `t`'s chain for this unit's rate (nullptr when `t` is
  // not lazy or out of memory).
  FxChainPtr makeChain(FxType t) const;
  // Bytes allocated by this unit: the always-present parts plus the attached
  // chains (the shared reverb kernel and oscillator tables excluded).
  size_t memoryBytes() const noexcept;

  // ---- audio thread ----------------------------------------------------------------
  // Hands `chain` (made by makeChain(t)) to the unit, which owns it from then
  // on. Returns nullptr when taken, or `chain` itself when the slot was
  // already filled (the caller retires it: the audio thread never frees).
  FxChain* attachChain(FxType t, FxChain* chain) noexcept;
  bool hasChain(FxType t) const noexcept;
  // Forgets every delay line / reverb history in O(1) (the lines then read as
  // silence until overwritten); parameters are kept.
  void reset() noexcept;

  // IFxProcessor
  void setType(FxType t) noexcept override;       // engine.js setType: re-route (the old chain's output is cut)
  // engine.js setEnabled: disabled = input and output disconnected, no
  // output at all; the chains' internal state is kept frozen (not
  // processed) like a disconnected Web Audio cycle.
  void setEnabled(bool on) noexcept override;
  void setLevel(float v) noexcept override;       // 0..1: wet tau 20 ms, feedbacks / depths tau 50 ms
  void setBeatsMult(float m) noexcept override;   // beat fraction (engine.js setBeatsMult)
  // Every block, from the sync engine: beat duration (engine.js setBeatDur,
  // same 0.05 % threshold; applied whether or not the unit is enabled, so a
  // chain is always born and resumed on the current tempo) and beat position
  // (LFO phase lock: valid && playing).
  void setBeatClock(const BeatClock& bc) noexcept override;
  float wetGain() const noexcept override;        // current smoothed wet gain (engine.js u.wet.gain.value)
  // Processes the unit's send bus and writes its WET output (wet gain
  // applied). Silence when disabled, for "roll", and while the current
  // type's chain is not attached. In-place (in == out) allowed.
  void process(const float* inL, const float* inR, float* outL, float* outR, int n) noexcept override;

  FxType type() const noexcept;
  bool enabled() const noexcept;
  float level() const noexcept;
  float beatsMult() const noexcept;
  double modPeriodBeats() const noexcept;   // engine.js modPeriodBeats (0 = no modulation)
  // engine.js _timeNow(): clamp(beatDur * beatsMult, 0.02, 3.9), the time the
  // delay lines glide to (tau 80 ms) and lazy chains are born with.
  double delayTimeSec() const noexcept;
  double beatDuration() const noexcept;     // engine.js beatDur (after the 0.05 % rule)

  // ---- probes for tests (audio thread or stopped) ----------------------------------
  double lineDelaySec() const noexcept;     // current smoothed delay time of the current type's lines (0: none)
  double feedbackGain() const noexcept;     // current smoothed feedback of the current type (0: none)
  double lfoRateHz() const noexcept;        // current smoothed LFO rate of the current modulation type
  double lfoPhase() const noexcept;         // its phase, 0..1 (0 = start of the modulation cycle)
  bool lfoLocked() const noexcept;          // phase-locked to the beat clock

 private:
  struct Impl;  // layout belongs to the fx owner
  std::unique_ptr<Impl> impl_;
};

}  // namespace om
