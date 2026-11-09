// One DJ deck of the native engine (owner: deck). Everything engine.js does
// BEFORE the channel strip (before TRIM): a sample-exact read pointer over
// the PCM handed off by the renderer (int16 with per-chunk scales or float32
// TrackBuffer, any sample rate), varispeed with LINEAR interpolation exactly
// like Chromium's AudioBufferSourceNode (Hermite / sinc later, behind an
// A/B), armed starts that wait for their data, pre-roll, loops, seeks and
// hot cues with latency compensation and no scheduling lead, scratch as a
// continuous read pointer that plays real reverse audio, V.BRAKE / BACKSPIN,
// ROLL, stems with per-stem gains, KEY and KEYLOCK through the WSOLA port of
// pitch-worklet.js read straight from the track (primed, so PLAY and hot
// cues start at once; fed on the deck's own 128-frame quantum grid), the
// heard-position bookkeeping with its segments, and the sticky end latch.
// SPEC.md §4.4, §9.
//
// Threading: the constructor and prepare() on the control thread while the
// audio is stopped; everything else on the audio thread (RT-safe, noexcept,
// no allocation, no free). Pointers passed to attach*() are borrowed; the
// previous pointer is returned so the core can retire it (media.h ownership
// rule): the deck never reads a returned buffer again (a fade-out that needs
// it is rendered before it is returned). Re-attaching the same TrackBuffer
// returns it (the core holds one PCM user per attachment).
//
// Parity (proved against Chromium's own renders, tests/deck goldens): the
// read pointer is bit-exact with AudioBufferSourceNode (rates != 1, buffer
// rate != device rate, loop seams, end of buffer), the WSOLA output with
// pitch-worklet.js, the ratio smoothing with the k-rate AudioParam. Native
// differences (SPEC.md §20): no scheduling lead, primed WSOLA (PLAY / hot
// cue audio on the first frame of the block), 2 / 5 / 6 ms raised-cosine
// fades and crossfades, armed starts, signed scratch pointer.
#pragma once

#include <cstdint>
#include <memory>

#include "om/common.h"
#include "om/deck_control.h"
#include "om/interpolator.h"
#include "om/media.h"
#include "om/om_state.h"

namespace om {

// Source of the WSOLA ratio under keylock (dev A/B, SPEC.md §9.4).
enum class KeylockRatioSource : uint8_t {
  Worklet = 0,     // pitch-worklet.js: the current 1/tempo (parity, default)
  InputTempo = 1,  // the tempo that produced the input each grain reads (no pitch blip on tempo steps)
};

class Deck final : public IDeckControl {
 public:
  explicit Deck(int index);
  ~Deck() override;
  Deck(const Deck&) = delete;
  Deck& operator=(const Deck&) = delete;

  int index() const noexcept { return index_; }

  // ---- setup (control thread, audio stopped) ----------------------------------
  // The constructor allocates the rate-independent buffers (the two WSOLA
  // instances of the A/B crossfades, the per-voice input histories that
  // cover the WSOLA lag, the prime history); prepare() the ones that depend
  // on the device rate (the heard-position history sized for
  // kMaxInsertLatencySec of plugin latency). Keeps the transport state: a
  // playing deck restarts at its position on the new device (new segment).
  void prepare(double deviceRate, int maxBlockFrames);

  // ---- media (audio thread) ------------------------------------------------------
  // engine.js loadTrack() reset: stop (2 ms fade), position 0, cue 0, tempo 1,
  // loop off, _loopBeats null, roll off, stems off and dropped, key 0, new
  // segment. KEYLOCK is kept, and so is the natural-end timestamp (engine.js
  // _endedAt: only play() clears it; the auto-master's "ended < 2 s" rule).
  // Sent by the core right before attachTrack().
  void resetForLoad() noexcept;
  // No loop and loopStart = loopEnd = 0, as on a new engine.js page: the
  // core's hello {reset} (resetForLoad keeps the bounds like engine.js
  // loadTrack, and app.js's RELOOP reuses them).
  void clearLoopBounds() noexcept;
  // No natural end on record (endedAt / endedAtSample NaN), as on a new
  // engine.js page: the core's hello {reset}. ended_count is kept (sticky).
  void clearEnded() noexcept;
  // nullptr = unload. Returns the previous buffer (to retire).
  const TrackBuffer* attachTrack(const TrackBuffer* tb) noexcept;
  // nullptr = no grid. Returns the previous grid (to retire).
  const BeatGrid* attachGrid(const BeatGrid* g) noexcept;
  // Stems become READY (not on). Returns the previous set (to retire).
  const StemSet* attachStems(const StemSet* s) noexcept;
  void setGlobalGridOffset(double sec) noexcept;        // engine.js GLOBAL_GRID_OFFSET (roll slices)
  void setInsertLatency(int frames) noexcept;           // VST plugin latency (<= kMaxInsertLatencySec): joins the read-ahead
  void setInterpolation(InterpQuality q) noexcept;      // Linear (default, Chromium parity) / later A/B
  void setKeylockRatioSource(KeylockRatioSource s) noexcept;  // dev A/B, Worklet by default
  // Keylock precision (the engine's keylock.precision, OFF by default): the
  // WSOLA grains are aligned to a fraction of a sample (Wsola::setFineAlign)
  // in both instances of the deck. Off = pitch-worklet.js bit for bit. Kept
  // by resetForLoad() (a setting, not transport state); SPEC.md §9.4.
  void setKeylockPrecision(bool on) noexcept;
  bool keylockPrecision() const noexcept;

  // ---- transport (audio thread) ----------------------------------------------------
  // `at` = engine time when the UI issued the command (0 = unknown): a
  // position computed by the UI from currentTime() at `at` is made exact at
  // the block's presentTime (target advanced by (presentTime - at) * tempo
  // while playing), the way engine.js compensated its 30 ms scheduling lead.
  // play() from stop is ARMED: it starts at the first block where the chunk
  // under the position (and the WSOLA prime history when routed) is ready,
  // at most kArmedStartMaxSec later on the sample clock (SPEC.md §9.1).
  void play(EngineTime at, const BlockClock& clk) noexcept;    // engine.js play(): restarts at 0 when at the end
  void pause(EngineTime at, const BlockClock& clk) noexcept;   // engine.js pause() (+ roll stopped)
  void seek(double t, EngineTime at, const BlockClock& clk) noexcept;  // engine.js seek() incl. loop exit rule
  void setCuePoint(double t) noexcept;                  // stored for the snapshot (the JS proxy decides cue())
  void setKey(int semitones) noexcept;                  // -7..+7 (engine.js setKey)
  void setKeylock(bool on) noexcept;                    // engine.js setKeylock
  void setLoop(double start, double end) noexcept;      // engine.js setLoop (ignored when shorter than 10 ms)
  void exitLoop() noexcept;                             // engine.js exitLoop
  void setLoopBeats(double beats) noexcept;             // engine.js _loopBeats (NaN = null)
  // Scratch (engine.js scrubStart / scrubMove / scrubEnd): Move gives the
  // target position t at UI time `at`; the read pointer follows the target
  // path continuously (signed speed: real reverse audio), bypassing the
  // WSOLA transposer like engine.js scrubIn. Still = silence.
  void scratch(ScratchPhase phase, double t, EngineTime at, const BlockClock& clk) noexcept;
  // V.BRAKE / BACKSPIN sound (engine.js spinSound / stopSpinSound with
  // SpinKind::None). The transport is not moved (app.js resumes it).
  void spin(SpinKind kind, const BlockClock& clk) noexcept;
  void setStemsOn(bool on) noexcept;                    // engine.js loadStems (gains back to 1) / stems off
  void setStemGain(Stem s, float gain, float tauSec) noexcept;  // stemGains[s].gain.setTargetAtTime(gain, now, tau)

  // ---- render (audio thread) ---------------------------------------------------
  // Writes the deck's pre-TRIM stereo output for this (sub-)block. Any
  // frame count: the WSOLA ratio still changes only on the deck's own
  // 128-frame quantum grid (the remainder is carried over).
  void render(float* l, float* r, int frames, const BlockClock& clk) noexcept;

  // ---- queries (audio thread) ----------------------------------------------------
  // Fills the deck part of the state: positions at `t`, segment, end latch,
  // armed flag (the mixer adds peak / rms / dry, the core the insert state).
  void snapshot(om_deck_state& s, EngineTime t) const noexcept;
  // Track position heard at engine time `when` within the current block
  // (exact mapping: tempo changes, WSOLA lag, read-ahead, loops). The core
  // uses it for the plugin transport at the insert input position (§13.3).
  double positionAt(EngineTime when) const noexcept;
  double procLatencySec() const noexcept;
  int keyShift() const noexcept;
  bool keylock() const noexcept;
  double cuePoint() const noexcept;
  bool looping() const noexcept;
  bool armed() const noexcept;
  uint32_t loadId() const noexcept;
  uint32_t endedCount() const noexcept;                 // sticky end latch (om_deck_state.ended_count)

  // ---- IDeckControl (sync engine) ----------------------------------------------------
  bool loaded() const noexcept override;
  bool playing() const noexcept override;
  double duration() const noexcept override;
  double heardPosition() const noexcept override;
  bool transportSettled() const noexcept override;
  double tempo() const noexcept override;
  void setTempo(double r) noexcept override;            // also the UI "deck.tempo" command (core adds followMaster)
  void seekHeard(double t) noexcept override;
  bool routedThroughWsola() const noexcept override;
  const BeatGrid* grid() const noexcept override;
  SampleTime endedAtSample() const noexcept override;
  bool startRoll(double beats, double mix) noexcept override;
  void setRollMix(double mix) noexcept override;
  void stopRoll(bool immediate) noexcept override;
  bool rolling(double* beats) const noexcept override;

 private:
  struct Impl;  // private layout belongs to the deck owner (pimpl keeps this header stable)
  int index_;
  std::unique_ptr<Impl> impl_;
};

}  // namespace om
