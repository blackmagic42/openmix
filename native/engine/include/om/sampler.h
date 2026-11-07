// SAMPLER of app.js (owner: mixer): sounds handed off by the renderer
// (TrackBuffers of kind Sample, the whole bank handed off when the engine is
// ready and again on each pad assignment) registered in slots, played by
// voices. The JS proxy maps app.js's sampler code (createBufferSource /
// start / stop on engine.ctx, connected to engine.postBus) to sampler.play /
// sampler.stop: each started source is one voice id. Voices are mixed into
// the post bus (before the master filter and the limiter, after the master
// volume), like samplerGain -> engine.postBus. A voice whose first chunk has
// not arrived is ARMED for at most kArmedStartMaxSec, then dropped and
// counted. SPEC.md §10.9.
#pragma once

#include <cstdint>
#include <memory>

#include "om/common.h"
#include "om/media.h"

namespace om {

class Sampler {
 public:
  Sampler();
  ~Sampler();
  Sampler(const Sampler&) = delete;
  Sampler& operator=(const Sampler&) = delete;

  void prepare(double sampleRate, int maxBlockFrames);  // control thread
  // Audio thread. Registers (or clears with nullptr) the sound of a slot;
  // returns the previous buffer of the slot (to retire). Voices playing the
  // previous buffer are stopped first.
  const TrackBuffer* attach(int slot, const TrackBuffer* tb) noexcept;
  // Starts `voice` (an id chosen by the JS proxy) on the sound of `slot`
  // from its beginning, at playback rate 1 (buffer rate / device rate,
  // linear interpolation like AudioBufferSourceNode). Armed while the slot's
  // first chunk is missing (<= kArmedStartMaxSec on the sample clock). When
  // all voices are busy the oldest one is stolen (5 ms fade).
  void play(int slot, uint32_t voice, float gain, const BlockClock& clk) noexcept;
  void stop(uint32_t voice) noexcept;       // AudioBufferSourceNode.stop(): ends the voice (2 ms fade)
  void stopAll() noexcept;                  // hello {reset}
  bool loaded(int slot) const noexcept;
  int activeVoices() const noexcept;
  uint32_t droppedTriggers() const noexcept;  // armed voices that never got their data (om_mixer_state.sampler_dropped)
  // ADDS the active voices into l / r (n <= kMaxBlockFrames).
  void render(float* l, float* r, int n, const BlockClock& clk) noexcept;

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

}  // namespace om
