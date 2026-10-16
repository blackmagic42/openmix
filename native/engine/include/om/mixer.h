// The native mixer (owner: mixer): per-deck channel strips (TRIM, 3-band EQ,
// DJ filter or Color FX send, VST insert, fader, crossfader, PFL cue send,
// FX dry cut, noise), FX sends and returns (4 panel units, 4 pad units,
// master FX, Color FX bus), master bus (volume, compensated dry, master
// filter, limiter), sampler, peak/RMS meters and the routing of master and
// cue to the device channels. Same curves as engine.js. SPEC.md §9.
//
// Threading: prepare() on the control thread with the audio stopped;
// everything else on the audio thread (RT-safe, no allocation).
#pragma once

#include <memory>

#include "om/color_fx.h"
#include "om/common.h"
#include "om/fx.h"
#include "om/limiter.h"
#include "om/meter.h"
#include "om/sampler.h"

namespace om {

// One deck's pre-TRIM signal for the block (output of Deck::render).
struct DeckInput {
  const float* l = nullptr;
  const float* r = nullptr;
};

// Device channel indexes (-1 = not routed). engine.js _wireOutput: master on
// 1/2; cue on 3/4 when the device has >= 4 channels and no separate phones card.
struct OutputRouting {
  int masterL = 0, masterR = 1;
  int cueL = -1, cueR = -1;
};

struct MixerSnapshot {
  float deckPeak[kNumDecks] = {0, 0, 0, 0};  // post filter/insert, pre-fader (engine.js meterPeak)
  float deckRms[kNumDecks] = {0, 0, 0, 0};
  float deckDry[kNumDecks] = {1, 1, 1, 1};   // current FX dry-cut gain
  float masterPeak = 0;                      // after the master filter, before the limiter (masterPeak)
  float masterRms = 0;
  float gainReductionDb = 0;                 // limiter
  bool masterClip = false;                   // masterPeak >= 1 during the window
  float cuePeak = 0;
  float dryComp = 1;                         // master-FX dry compensation
};

class Mixer {
 public:
  Mixer();
  ~Mixer();
  Mixer(const Mixer&) = delete;
  Mixer& operator=(const Mixer&) = delete;

  // ---- setup (control thread, audio stopped) ----------------------------------
  // Prepares strips, FX units, Color FX, sampler, limiter and meters.
  void prepare(double sampleRate, int maxBlockFrames);
  void setInsert(IInsert* insert) noexcept;  // VST inserts (nullptr = none)

  // ---- parameters (audio thread) ----------------------------------------------
  void setRouting(const OutputRouting& r) noexcept;
  void setDeckVolume(int d, float v) noexcept;          // 0..1, gain v^2 (tau 10 ms)
  void setDeckTrim(int d, float v) noexcept;            // -1..1 -> 4^v (+-12 dB)
  void setDeckEq(int d, EqBand b, float v) noexcept;    // -1 = kill (-40 dB) .. +1 = +6 dB
  void setDeckColor(int d, float v) noexcept;           // engine.setDeckColor: filter / color send / noise
  void setDeckPfl(int d, bool on) noexcept;             // engine.setCuePfl
  void setCrossfader(float x) noexcept;                 // 0..1, "mix" curve
  void setXfSide(int d, XfSide s) noexcept;             // default A, B, A, B
  void setMasterVolume(float v) noexcept;               // masterGain + fxReturn (tau 10 ms)
  void setMasterFilter(float v) noexcept;               // -1..1 like the deck filter
  void setColorType(ColorType t) noexcept;              // re-applies every deck's knob
  void setColorEnabled(bool on) noexcept;
  void setFxAssign(uint16_t bits) noexcept;             // fxAssign matrix + updateFxSends ramps (tau 15 ms)
  void setPadFx(int d, bool on, FxType type, float beats, float level) noexcept;  // engine.setPadFx
  void setPadDryHold(int d, float dry) noexcept;        // deck._padDryHold (NaN = none)

  // FX units and helpers owned by the mixer (targets of fx.set / sampler.*)
  FxUnit& fx(FxUnitId id) noexcept;
  FxUnit& panelFx(int u) noexcept;
  FxUnit& padFx(int d) noexcept;
  FxUnit& masterFx() noexcept;
  ColorFx& colorFx() noexcept;
  Sampler& sampler() noexcept;

  // ---- processing (audio thread) ----------------------------------------------
  // Runs the whole mix for one block (frames <= kMaxBlockFrames).
  void process(const DeckInput in[kNumDecks], int frames, const BlockClock& clk) noexcept;
  // Writes master and cue into the device buffer according to the routing
  // (all other channels zeroed).
  void writeOutput(float* interleaved, int frames, int channels) const noexcept;
  // Planar buses of the last process() (valid until the next one).
  const float* masterL() const noexcept;  // post-limiter (what is recorded)
  const float* masterR() const noexcept;
  const float* cueL() const noexcept;
  const float* cueR() const noexcept;

  // ---- views (audio thread) -----------------------------------------------------
  MixView mixView() const noexcept;
  void fxRackView(FxRackView& v) const noexcept;
  float deckVolume(int d) const noexcept;
  void snapshot(MixerSnapshot& s) const noexcept;

 private:
  struct Impl;  // layout belongs to the mixer owner
  std::unique_ptr<Impl> impl_;
};

}  // namespace om
