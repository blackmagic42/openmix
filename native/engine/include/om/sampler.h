// SAMPLER of app.js: 10 one-shot pads shared by the 4 decks, each a
// TrackBuffer decoded by the decoder; pressing a pad restarts its sound
// (short fade on retrigger); voices are mixed into the post bus, after the
// master volume, like samplerGain -> engine.postBus (owner: mixer).
#pragma once

#include <memory>

#include "om/common.h"
#include "om/media.h"

namespace om {

class Sampler {
 public:
  Sampler();
  ~Sampler();
  void prepare(double sampleRate, int maxBlockFrames);  // control thread
  // Audio thread. Returns the previous buffer of the slot (to retire).
  const TrackBuffer* attach(int slot, const TrackBuffer* tb) noexcept;
  void play(int slot, float gain) noexcept;  // restart from the beginning
  void stop(int slot) noexcept;              // 5 ms fade out
  bool loaded(int slot) const noexcept;
  // ADDS the active voices into l / r (n <= kMaxBlockFrames).
  void render(float* l, float* r, int n) noexcept;

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

}  // namespace om
