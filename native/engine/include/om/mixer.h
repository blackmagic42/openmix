// The native mixer (owner: mixer): per-deck channel strips exactly like
// engine.js (TRIM, 3-band EQ, DJ filter, VST insert point in two phases,
// `post` taps for the PFL cue send, the meter and the Color FX send, fader,
// Color "noise", crossfader, FX sends, FX dry cut), the FX returns (panel,
// pad and master units, Color FX bus), the master bus (master volume, dry
// compensation, post bus, master filter, limiter), the sampler, the meters
// and the routing of master and cue to the device channels. Same curves,
// constants and AudioParam time constants as engine.js. SPEC.md §10.
//
// The mixer does NOT own the FX units: the core creates them (om::FxUnit,
// om::ColorFx) and attaches them by pointer (FX seam, SPEC.md §10.3); the
// mixer keeps every unit's parameters in its own mirror, so a unit attached
// later gets them at once, and the mixer tests attach fakes.
//
// Threading: prepare() on the control thread with the audio stopped;
// everything else on the audio thread (RT-safe, no allocation, no free, no
// lock).
#pragma once

#include <memory>

#include "om/common.h"
#include "om/limiter.h"
#include "om/meter.h"
#include "om/om_state.h"
#include "om/sampler.h"

namespace om {

// One deck's pre-TRIM signal for the block (output of Deck::render).
struct DeckInput {
  const float* l = nullptr;
  const float* r = nullptr;
};

// Device channel indexes (-1 = not routed). engine.js _wireOutput: master on
// 1/2; cue on 3/4 when the device has >= 4 channels and no separate phones
// card; otherwise the cue bus reaches no output of the main device.
struct OutputRouting {
  int masterL = 0, masterR = 1;
  int cueL = -1, cueR = -1;
};

class Mixer {
 public:
  Mixer();
  ~Mixer();
  Mixer(const Mixer&) = delete;
  Mixer& operator=(const Mixer&) = delete;

  // ---- setup (control thread, audio stopped) ----------------------------------
  // Prepares strips, sampler, limiter, meters and the unit mirrors; keeps
  // every parameter value. The FX units are prepared by their creator.
  void prepare(double sampleRate, int maxBlockFrames);
  void setInsert(IInsert* insert) noexcept;  // VST inserts (nullptr = none)

  // ---- FX units (audio thread; also before the device starts) -------------------
  // Attaches the processor of a unit (nullptr = detach). The unit receives the
  // mirrored parameters at once. Returns the previous pointer (to retire).
  IFxProcessor* attachFx(FxUnitId id, IFxProcessor* unit) noexcept;
  IColorProcessor* attachColor(IColorProcessor* color) noexcept;
  // fx.set: updates the unit's mirror (mask = FxField bits) and forwards to
  // the attached unit; for the master unit it is also engine.js ensureMasterFx().
  void setFx(FxUnitId id, uint8_t mask, FxType type, bool enabled, float level, float beats) noexcept;
  void ensureMasterFx() noexcept;                       // engine.js ensureMasterFx(): the unit exists (logically)
  bool fxRequested(FxUnitId id) const noexcept;         // engine.js padFx[i] / masterFx != null
  // Every block, from the sync engine; forwarded to ENABLED units only (app.js
  // calls setBeatDur on enabled units only: a re-enabled unit glides from its
  // stale beat duration, SPEC.md §11.1).
  void setFxBeatClock(FxUnitId id, const BeatClock& bc) noexcept;
  // fx.assign: the LIVE engine.js fxAssign matrix, bit (unit * 4 + deck):
  // dry cut, fxRackView (fxRefDeck, ROLL).
  void setFxAssign(uint16_t assignBits) noexcept;
  // fx.sends = engine.js updateFxSends(): latches, NOW, send(d -> u) = unit u
  // enabled AND live-assigned to d; each send ramps (tau 15 ms) to it
  // (enabling a unit later does not open its sends until the next call).
  void updateFxSends() noexcept;
  // engine.js setPadFx(i, preset): on = setType/setBeatsMult/setLevel/setEnabled(true)
  // + pad send to 1 (tau 10 ms); off = pad send to 0 (tau 20 ms) + setEnabled(false).
  void setPadFx(int d, bool on, FxType type, float beats, float level) noexcept;

  // ---- parameters (audio thread). Smoothing = engine.js setTargetAtTime taus ----
  void setRouting(const OutputRouting& r) noexcept;
  void setDeckVolume(int d, float v) noexcept;          // 0..1 -> fader gain v^2 (tau 10 ms)
  void setDeckTrim(int d, float v) noexcept;            // -1..1 -> 4^v (+-12 dB, tau 10 ms)
  void setDeckEq(int d, EqBand b, float v) noexcept;    // -1..1 -> v >= 0 ? 6v : 40v dB (tau 10 ms)
  void setDeckColor(int d, float v) noexcept;           // engine.setDeckColor: filter / color send / noise
  void setDeckPfl(int d, bool on) noexcept;             // engine.setCuePfl (tau 10 ms)
  void setXfSide(int d, XfSide s) noexcept;             // default A, B, A, B
  void setPadDryHold(int d, float dry) noexcept;        // deck._padDryHold (NaN = null)
  void setCrossfader(float x) noexcept;                 // 0..1, "mix" curve (tau 10 ms)
  void setMasterVolume(float v) noexcept;               // masterGain AND fxReturn (tau 10 ms)
  void setMasterFilter(float v) noexcept;               // -1..1 like the deck filter (dead zone 0.04)
  void setColorType(ColorType t) noexcept;              // re-applies every deck's knob, forwards to the color unit
  void setColorEnabled(bool on) noexcept;               // re-applies every deck's knob
  // engine.js defaults for everything above (hello {reset}); units stay attached.
  void resetToDefaults() noexcept;

  Sampler& sampler() noexcept;                          // the mixer owns the sampler

  // ---- processing (audio thread) ----------------------------------------------
  // Runs the whole mix for one (sub-)block (frames <= kMaxBlockFrames): every
  // strip up to the FILTER, IInsert::begin() for every deck, the decks
  // without an active insert and the sampler, IInsert::end() for the others,
  // post taps, buses, limiter (SPEC.md §10.6). The FX units must have
  // received their beat clocks for this block.
  void process(const DeckInput in[kNumDecks], int frames, const BlockClock& clk) noexcept;
  // Writes master and cue into the device buffer according to the routing
  // (all other channels zeroed).
  void writeOutput(float* interleaved, int frames, int channels) const noexcept;
  // Planar buses of the last process() (valid until the next one).
  const float* masterL() const noexcept;  // post-limiter: what is heard and recorded
  const float* masterR() const noexcept;
  const float* cueL() const noexcept;     // headphone bus (pre-fader PFL sum)
  const float* cueR() const noexcept;
  // Latency of the master chain (limiter look-ahead), in frames: the core
  // adds it to presentTime so heard positions match the master output.
  int masterLatencyFrames() const noexcept;

  // ---- views (audio thread) -----------------------------------------------------
  MixView mixView() const noexcept;
  void fxRackView(FxRackView& v) const noexcept;       // from the mirrors (live assign matrix)
  float deckVolume(int d) const noexcept;
  // Meters and dry gain of deck d for its om_deck_state (peak, rms, dry).
  void deckMeters(int d, float& peak, float& rms, float& dry) const noexcept;
  void snapshot(om_mixer_state& s) const noexcept;

 private:
  struct Impl;  // layout belongs to the mixer owner
  std::unique_ptr<Impl> impl_;
};

}  // namespace om
