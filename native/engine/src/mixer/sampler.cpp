// Sampler of the native mixer (owner: mixer): 32 slots of handed-off sounds
// played by 16 voices into the post bus, like app.js's
// createBufferSource().start() -> samplerGain (1) -> engine.postBus.
// Playback = Chromium's AudioBufferSourceNode at playbackRate 1: exact copy
// when the sound's rate is the device rate, else linear interpolation at
// rate fileRate / deviceRate (position accumulated in double) with its
// end-of-buffer rule (the last frame extrapolates the last two). Click-free edges
// (intentional, SPEC.md §20): stop = 2 ms fade, stealing the oldest voice
// when all 16 are busy = 5 ms fade (fading voices use extra voice slots so
// they never delay a new trigger). A trigger whose sound has no data yet is
// ARMED: it starts at the first block where chunk 0 is ready, at most
// kArmedStartMaxSec (sample clock) after the trigger, else it is dropped and
// counted. Detaching a slot's buffer ends its voices at once (the buffer is
// retired right after). Real-time safe. SPEC.md §10.9.
#include "om/sampler.h"

#include <algorithm>
#include <cmath>

namespace om {

namespace {
constexpr int kExtraVoices = 8;  // fading tails of stopped / stolen voices
constexpr int kVoiceSlots = kMaxSamplerVoices + kExtraVoices;
constexpr double kStopFadeSec = 0.002;
constexpr double kStealFadeSec = 0.005;

enum class VoiceState : uint8_t { Free = 0, Armed, Playing, Fading };

struct Voice {
  VoiceState state = VoiceState::Free;
  uint32_t id = 0;
  int slot = -1;
  const TrackBuffer* tb = nullptr;
  double pos = 0.0;      // read position, source frames
  double rate = 1.0;     // source frames per output frame
  float gain = 1.0f;
  int fadeLeft = 0;      // Fading: frames left; gain = fadeLeft / fadeLen (exact, ends on its last frame)
  int fadeLen = 1;
  SampleTime armedAt = 0.0;
  uint64_t order = 0;    // trigger order: the oldest voice has the smallest
  int64_t cacheChunk = -1;  // last chunk checked for readiness
  bool cacheReady = false;
};
}  // namespace

struct Sampler::Impl {
  const TrackBuffer* slots[kMaxSamplerSlots] = {};
  Voice voices[kVoiceSlots];
  uint32_t dropped = 0;
  uint64_t counter = 0;
  double deviceRate = 48000.0;
  int stopFrames = 96;    // 2 ms
  int stealFrames = 240;  // 5 ms

  void startFade(Voice& v, int frames) noexcept {
    if (v.state == VoiceState::Armed) {
      v = Voice();
      return;
    }
    if (v.state == VoiceState::Playing) {
      v.state = VoiceState::Fading;
      v.fadeLen = frames;
      v.fadeLeft = frames;
    } else if (v.state == VoiceState::Fading && frames < v.fadeLeft) {
      // a shorter fade requested while fading: continue from the current gain, end sooner
      const float g = static_cast<float>(v.fadeLeft) / static_cast<float>(v.fadeLen);
      v.fadeLen = std::max(1, static_cast<int>(static_cast<float>(frames) / std::max(g, 1e-6f)));
      v.fadeLeft = frames;
    }
  }

  // Starts an armed voice when its sound's first chunk is there.
  bool tryStart(Voice& v) noexcept {
    const TrackBuffer* tb = (v.slot >= 0 && v.slot < kMaxSamplerSlots) ? slots[v.slot] : nullptr;
    if (!tb) return false;
    if (tb->frames <= 0) {  // an empty sound ends at once
      v = Voice();
      return true;
    }
    if (!tb->chunkReady(0)) return false;
    v.state = VoiceState::Playing;
    v.tb = tb;
    v.pos = 0.0;
    v.rate = deviceRate > 0 ? static_cast<double>(tb->sampleRate) / deviceRate : 1.0;
    v.cacheChunk = -1;
    v.cacheReady = false;
    return true;
  }

  // Frame idx of the voice's sound, silence where the chunk has not arrived.
  inline void fetch(Voice& v, int64_t idx, float& l, float& r) const noexcept {
    const int64_t c = idx >> TrackBuffer::kChunkShift;
    if (c != v.cacheChunk) {
      v.cacheChunk = c;
      v.cacheReady = v.tb->chunkReady(c);
    }
    if (v.cacheReady) {
      v.tb->frame(idx, l, r);
    } else {
      l = 0.0f;
      r = 0.0f;
    }
  }

  void renderVoice(Voice& v, float* l, float* r, int n) noexcept {
    const TrackBuffer& tb = *v.tb;
    const int64_t length = tb.frames;
    const bool fading = v.state == VoiceState::Fading;
    for (int i = 0; i < n; i++) {
      if (v.pos >= static_cast<double>(length)) {
        v = Voice();
        return;
      }
      float sl, sr;
      if (v.rate == 1.0) {
        // playbackRate 1 at an integer position: exact copy
        fetch(v, static_cast<int64_t>(v.pos), sl, sr);
      } else {
        // AudioBufferSourceNode linear interpolation (Chromium RenderFromBuffer)
        const int64_t i1 = static_cast<int64_t>(v.pos);
        const double frac = v.pos - static_cast<double>(i1);
        float l1, r1;
        fetch(v, i1, l1, r1);
        if (i1 + 1 < length) {
          float l2, r2;
          fetch(v, i1 + 1, l2, r2);
          sl = static_cast<float>((1.0 - frac) * l1 + frac * l2);
          sr = static_cast<float>((1.0 - frac) * r1 + frac * r2);
        } else if (i1 >= 1) {
          // past the last frame: linear extrapolation from the last two frames
          float l0, r0;
          fetch(v, i1 - 1, l0, r0);
          sl = static_cast<float>(static_cast<double>(l1) + (static_cast<double>(l1) - l0) * frac);
          sr = static_cast<float>(static_cast<double>(r1) + (static_cast<double>(r1) - r0) * frac);
        } else {
          sl = l1;
          sr = r1;
        }
      }
      float g = v.gain;
      if (fading) {
        g *= static_cast<float>(v.fadeLeft) / static_cast<float>(v.fadeLen);
        v.fadeLeft--;
      }
      if (g == 1.0f) {
        l[i] += sl;
        r[i] += sr;
      } else {
        l[i] += sl * g;
        r[i] += sr * g;
      }
      v.pos += v.rate;
      if (fading && v.fadeLeft <= 0) {
        v = Voice();
        return;
      }
    }
  }
};

Sampler::Sampler() : impl_(std::make_unique<Impl>()) {}
Sampler::~Sampler() = default;

void Sampler::prepare(double sampleRate, int) {
  Impl& m = *impl_;
  m.deviceRate = sampleRate > 0 ? sampleRate : 48000.0;
  m.stopFrames = std::max(1, static_cast<int>(std::lround(kStopFadeSec * m.deviceRate)));
  m.stealFrames = std::max(1, static_cast<int>(std::lround(kStealFadeSec * m.deviceRate)));
  for (auto& v : m.voices) {
    if (v.state == VoiceState::Playing || v.state == VoiceState::Fading)
      v.rate = static_cast<double>(v.tb->sampleRate) / m.deviceRate;
  }
}

const TrackBuffer* Sampler::attach(int slot, const TrackBuffer* tb) noexcept {
  if (slot < 0 || slot >= kMaxSamplerSlots) return tb;
  Impl& m = *impl_;
  const TrackBuffer* old = m.slots[slot];
  if (old && old != tb) {
    // the previous buffer is retired right after: its voices end now
    for (auto& v : m.voices)
      if ((v.state == VoiceState::Playing || v.state == VoiceState::Fading) && v.tb == old) v = Voice();
  }
  m.slots[slot] = tb;
  return old;
}

void Sampler::play(int slot, uint32_t voice, float gain, const BlockClock& clk) noexcept {
  if (slot < 0 || slot >= kMaxSamplerSlots) return;
  Impl& m = *impl_;
  // one id = one source: a reused id ends its previous voice
  for (auto& v : m.voices)
    if (v.state != VoiceState::Free && v.id == voice) m.startFade(v, m.stopFrames);
  // 16 voices at most: steal the oldest one
  int active = 0;
  Voice* oldest = nullptr;
  for (auto& v : m.voices) {
    if (v.state != VoiceState::Armed && v.state != VoiceState::Playing) continue;
    active++;
    if (!oldest || v.order < oldest->order) oldest = &v;
  }
  if (active >= kMaxSamplerVoices && oldest) m.startFade(*oldest, m.stealFrames);
  // a free slot (else the oldest fading tail is cut)
  Voice* slotV = nullptr;
  for (auto& v : m.voices)
    if (v.state == VoiceState::Free) {
      slotV = &v;
      break;
    }
  if (!slotV) {
    for (auto& v : m.voices)
      if (v.state == VoiceState::Fading && (!slotV || v.order < slotV->order)) slotV = &v;
    if (!slotV) return;  // cannot happen: at most 16 voices are armed or playing
  }
  Voice& v = *slotV;
  v = Voice();
  v.state = VoiceState::Armed;
  v.id = voice;
  v.slot = slot;
  v.gain = gain;
  v.order = ++m.counter;
  v.armedAt = clk.sampleTime;
  m.tryStart(v);
}

void Sampler::stop(uint32_t voice) noexcept {
  Impl& m = *impl_;
  for (auto& v : m.voices)
    if (v.state != VoiceState::Free && v.id == voice) m.startFade(v, m.stopFrames);
}

void Sampler::stopAll() noexcept {
  for (auto& v : impl_->voices) v = Voice();
}

bool Sampler::loaded(int slot) const noexcept {
  return slot >= 0 && slot < kMaxSamplerSlots && impl_->slots[slot] != nullptr;
}

int Sampler::activeVoices() const noexcept {
  int n = 0;
  for (const auto& v : impl_->voices)
    if (v.state == VoiceState::Armed || v.state == VoiceState::Playing) n++;
  return n;
}

uint32_t Sampler::droppedTriggers() const noexcept { return impl_->dropped; }

void Sampler::render(float* l, float* r, int n, const BlockClock& clk) noexcept {
  Impl& m = *impl_;
  for (auto& v : m.voices) {
    if (v.state == VoiceState::Armed) {
      if (!m.tryStart(v)) {
        if (clk.sampleTime - v.armedAt >= kArmedStartMaxSec) {
          v = Voice();
          m.dropped++;
        }
        continue;
      }
      if (v.state == VoiceState::Free) continue;
    }
    if (v.state == VoiceState::Playing || v.state == VoiceState::Fading) m.renderVoice(v, l, r, n);
  }
}

}  // namespace om
