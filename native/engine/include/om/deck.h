// One DJ deck of the native engine (owner: deck). Everything engine.js does
// BEFORE the channel strip (before TRIM): sample-accurate transport over an
// immutable int16 TrackBuffer, varispeed with high-quality interpolation,
// pre-roll, loops, seeks with latency compensation, CDJ cue, scratch
// (position-following, audible), V.BRAKE / BACKSPIN, ROLL and slip, stems
// with per-stem gains, KEY and KEYLOCK through the WSOLA transposer with the
// gapless route switch of engine.js _switchRoute. SPEC.md §8.
//
// Threading: prepare() on the control thread while the audio is stopped;
// everything else on the audio thread (RT-safe, noexcept, no allocation).
// Pointers passed to attach*() are borrowed; the previous pointer is returned
// so the core can retire it (media.h ownership rule).
#pragma once

#include <cstdint>
#include <memory>

#include "om/common.h"
#include "om/deck_control.h"
#include "om/media.h"

namespace om {

// Deck fields published in every state snapshot (SPEC.md §15.4 "state.decks[i]").
struct DeckSnapshot {
  bool loaded = false;
  uint64_t gen = 0;              // load generation of the attached track
  double duration = 0;
  double pos = 0;                // HEARD position (s) at `at`
  EngineTime at = 0;             // presentTime of the block the position belongs to
  double rate = 0;               // d(pos)/d(engine time): tempo when playing, scratch speed, 0 when still
  bool playing = false;
  bool scratching = false;
  bool spinning = false;
  bool settled = true;           // IDeckControl::transportSettled
  double tempo = 1.0;
  bool looping = false;
  double loopStart = 0, loopEnd = 0;
  double loopBeats = kNaN;       // engine.js _loopBeats (NaN = null)
  double cuePoint = 0;
  int keyShift = 0;
  bool keylock = false;
  bool routedWsola = false;
  double procLat = 0;            // seconds of read-ahead (WSOLA + insert latency)
  bool stemsReady = false;
  bool stemsOn = false;
  float stemGains[kNumStems] = {1, 1, 1, 1};
  bool rolling = false;
  double rollBeats = 0;
  bool slip = false;
  EngineTime endedAt = kNaN;
};

class Deck final : public IDeckControl {
 public:
  explicit Deck(int index);
  ~Deck() override;
  Deck(const Deck&) = delete;
  Deck& operator=(const Deck&) = delete;

  int index() const noexcept { return index_; }

  // ---- setup (control thread, audio stopped) ----------------------------------
  // Allocates every real-time buffer (WSOLA rings, position history, scratch
  // and roll state) for this device rate and maximum block size.
  void prepare(double deviceRate, int maxBlockFrames);

  // ---- media (audio thread) ------------------------------------------------------
  // engine.js loadTrack() state reset (stop, position 0, cue 0, tempo 1, loop
  // off, roll off, stems off and dropped, key 0; KEYLOCK is kept).
  void reset() noexcept;
  const TrackBuffer* attachTrack(const TrackBuffer* tb, uint64_t gen) noexcept;  // nullptr = unload
  const BeatGrid* attachGrid(const BeatGrid* g) noexcept;
  const StemSet* attachStems(const StemSet* s) noexcept;  // stems become READY (not on)
  void setGlobalGridOffset(double sec) noexcept;
  void setInsertLatency(int frames) noexcept;              // VST plugin latency (joins procLat)

  // ---- transport (audio thread). `at` = UI issue time (engine clock, 0 = now) ----
  void play(EngineTime at, const BlockClock& clk) noexcept;
  void pause(EngineTime at, const BlockClock& clk) noexcept;
  // Heard position t at time `at`: while playing the target is advanced by
  // (presentTime - at) * tempo so a jump computed from currentTime() is exact.
  void seek(double t, EngineTime at, const BlockClock& clk) noexcept;
  void cueButton(EngineTime at, const BlockClock& clk) noexcept;  // engine.js Deck.cue()
  void setCuePoint(double t) noexcept;
  void setKey(int semitones) noexcept;     // -7..+7
  void setKeylock(bool on) noexcept;
  void setLoop(double start, double end) noexcept;
  void exitLoop() noexcept;
  void setLoopBeats(double beats) noexcept;  // NaN = null
  void setSlip(bool on) noexcept;
  void scratch(ScratchPhase phase, double t, EngineTime at, const BlockClock& clk) noexcept;
  void spin(SpinKind kind, const BlockClock& clk) noexcept;  // None = stopSpinSound()
  void setStemsOn(bool on) noexcept;                         // engine.js loadStems (gains back to 1)
  void setStemGain(Stem s, float gain, float tauSec) noexcept;

  // ---- render (audio thread) ---------------------------------------------------
  // Writes the deck's pre-TRIM stereo output for this block.
  void render(float* l, float* r, int frames, const BlockClock& clk) noexcept;
  // True once after a natural end of track (engine.js onended), with its time.
  bool takeEnded(EngineTime& at) noexcept;

  // ---- queries (audio thread) ----------------------------------------------------
  void snapshot(DeckSnapshot& s) const noexcept;
  double heardPositionAt(EngineTime t) const noexcept;
  double procLatencySec() const noexcept;
  int keyShift() const noexcept;
  bool keylock() const noexcept;
  double cuePoint() const noexcept;
  bool looping() const noexcept;
  uint64_t gen() const noexcept;

  // ---- IDeckControl ----------------------------------------------------------------
  bool loaded() const noexcept override;
  bool playing() const noexcept override;
  double duration() const noexcept override;
  double heardPosition() const noexcept override;
  bool transportSettled() const noexcept override;
  double tempo() const noexcept override;
  void setTempo(double r) noexcept override;
  void seekHeard(double t) noexcept override;
  bool routedThroughWsola() const noexcept override;
  const BeatGrid* grid() const noexcept override;
  EngineTime endedAt() const noexcept override;
  bool startRoll(double beats, double mix) noexcept override;
  void setRollMix(double mix) noexcept override;
  void stopRoll(bool immediate) noexcept override;
  bool rolling(double* beats) const noexcept override;

 private:
  // Private layout belongs to the deck owner (pimpl keeps this header stable).
  struct Impl;
  int index_;
  std::unique_ptr<Impl> impl_;
};

}  // namespace om
