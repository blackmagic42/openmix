// Engine side of the PCM handoff (owner: decoder). The DEFAULT way audio
// enters the engine: the renderer decodes with Chromium (decodeAudioData,
// as for the analysis today, so every cached cue and beat grid stays on the
// same timeline) and sends float32 PLANAR chunks of TrackBuffer::kChunkFrames
// frames; this store allocates the TrackBuffer at "pcm.begin", folds each
// chunk to stereo (Web Audio "speakers" rules), converts it (int16 with a
// per-track or per-chunk headroom gain and TPDF dither, or float32 for
// hi-res sources), publishes it, tracks completion and memory, and keeps the
// objects alive while decks, stem sets and the sampler use them.
// SPEC.md §5, §7.3. There is no JavaScript twin of the conversion.
//
// Threading: every PcmStore method may be called from any NON-real-time
// thread (the host JS thread for begin / write / end / abort, the control
// thread for acquire / release / GC / freePending); an internal mutex
// serializes the registry, chunk conversion runs outside it (several
// writers, on the same stream or on different ones, convert in parallel).
// Memory is freed ONLY by freePending() (control thread), and no method
// frees anything (not even a registry node) while holding the mutex: a
// dropped stream stays in the registry, marked dead, until freePending()
// unlinks it into storage reserved beforehand and frees it after unlocking.
// The host JS thread and the audio thread never run VirtualFree. The audio
// thread never calls the store: it reads TrackBuffers through raw pointers.
#pragma once

#include <atomic>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>
#include <vector>

#include "om/common.h"
#include "om/media.h"

namespace om {

constexpr int kPcmMaxChannels = 8;
constexpr int kPcmMinRate = 8000;
constexpr int kPcmMaxRate = 384000;
constexpr int64_t kPcmMaxFrames = int64_t(1) << 33;  // ~49.7 h at 48 kHz (the memory limit refuses earlier)
constexpr size_t kPcmMaxStreams = 512;               // live streams (decks, stems, sampler, in flight)
constexpr double kPcmGcAgeSec = 120.0;               // streams never attached are collected after this

struct PcmDesc {
  uint32_t loadId = 0;        // chosen by the JS proxy, unique per connection, > 0
  PcmKind kind = PcmKind::Track;
  PcmFormat format = PcmFormat::S16;  // storage format (the wire is always float32)
  int sourceChannels = 2;     // 1..8: channels of the decoded source (folded to stereo)
  int sampleRate = 0;         // Chromium decode rate, 8..384 kHz
  int64_t frames = 0;         // 1 .. kPcmMaxFrames
  float headroom = 0.0f;      // S16: the track's max(1, peak) (>= 1, finite), or 0 = per-chunk headroom
  float peak = 0.0f;          // source peak (diagnostics)
};

enum class PcmError : uint8_t {
  None = 0,
  Invalid,      // bad descriptor / arguments
  Exists,       // loadId already begun in this epoch
  NotFound,     // unknown loadId (or a stream of an older epoch)
  OutOfMemory,  // allocation failed, store limit reached, or too many streams
  Range,        // chunk offset / size / channel count does not describe one chunk of this buffer
  Duplicate,    // chunk already received (or being written by another writer)
  Incomplete,   // end() before every chunk arrived
  Aborted
};
const char* pcmErrorName(PcmError e) noexcept;  // "invalid", "exists", "notFound", ...

struct PcmInfo {
  uint32_t loadId = 0;
  uint32_t epoch = 0;
  PcmKind kind = PcmKind::Track;
  PcmFormat format = PcmFormat::S16;
  int sampleRate = 0;
  int64_t frames = 0;
  int64_t chunksReady = 0, chunks = 0;
  bool ended = false;     // end() succeeded
  bool attached = false;  // acquired at least once
  int users = 0;          // attachments (decks, stem sets, sampler slots)
  size_t bytes = 0;
  float headroom = 0.0f;  // given per-track headroom (0 = per-chunk)
  uint64_t clipped = 0;   // samples clamped because they exceeded the given per-track headroom
};

// Store-wide counters (diagnostics, tests).
struct PcmStoreStats {
  size_t streams = 0;          // live streams
  uint64_t bytes = 0;          // live PCM (== bytes())
  size_t pendingFree = 0;      // dropped streams waiting for freePending()
  uint64_t pendingBytes = 0;   // their PCM
  uint64_t freedBuffers = 0;   // streams freed by freePending() so far
  uint64_t collected = 0;      // streams dropped by collectGarbage() so far
  uint64_t refused = 0;        // begin() refused for memory / stream limits
  uint64_t clipped = 0;        // samples clamped over every stream so far
  uint64_t chunksWritten = 0;  // chunks converted so far
};

class PcmStore {
 public:
  // maxBytes: refuse begin() beyond this much live PCM (0 = no limit).
  explicit PcmStore(uint64_t maxBytes = 0);
  ~PcmStore();
  PcmStore(const PcmStore&) = delete;
  PcmStore& operator=(const PcmStore&) = delete;

  // ---- epochs (hello {reset}, SPEC.md §7.3) ----
  uint32_t epoch() const noexcept;
  // Starts a new epoch: streams of older epochs that are not attached are
  // aborted at once; attached ones are dropped when released. loadIds of the
  // new epoch never collide with them.
  uint32_t newEpoch();

  // ---- data path (host JS thread) ----
  PcmError begin(const PcmDesc& d);
  // One chunk of float32 planar samples (channel c at planar + c * frames):
  // offsetFrames is a multiple of TrackBuffer::kChunkFrames, frames is
  // exactly that chunk's length (the last one may be shorter), channels in
  // 1..8. Chunks may arrive in any order (the proxy sends the region around
  // the play position first). The conversion runs outside the store's mutex.
  PcmError write(uint32_t loadId, int64_t offsetFrames, int frames, int channels, const float* planar);
  // Declares the stream complete; Incomplete when chunks are missing.
  PcmError end(uint32_t loadId);
  // Drops a stream that is not attached; an attached one is dropped when released.
  void abort(uint32_t loadId);

  // ---- attachments (control side) ----
  // The object to attach (nullptr when unknown in the current epoch).
  // acquire() counts one more user; release() one less (by the buffer's
  // storeKey, so it works across epochs); a stream with no user left is
  // dropped (its memory goes to the pending-free list).
  std::shared_ptr<TrackBuffer> acquire(uint32_t loadId);
  void release(const TrackBuffer* tb);
  std::shared_ptr<const TrackBuffer> peek(uint32_t loadId) const;  // no user count

  bool info(uint32_t loadId, PcmInfo& out) const;
  PcmStoreStats stats() const;
  uint64_t bytes() const noexcept;      // live PCM (published as om_state.pcm_bytes)
  size_t count() const;                 // live streams
  // Control thread, periodically (every second): drops streams that were
  // never attached and have been seen by this function for more than
  // `maxAgeSec` (a renderer that went away mid-load). Ages are measured from
  // the first call that saw the stream, on the caller's clock (`now`), so
  // the store does not depend on the clock's origin. Returns the number of
  // streams dropped.
  size_t collectGarbage(EngineTime now, double maxAgeSec = kPcmGcAgeSec);
  // Control thread only: frees the memory of every dropped stream (outside
  // the mutex). Returns the number of streams freed. A stream that a writer
  // is still converting is freed by a later call.
  size_t freePending();

 private:
  struct Entry;
  using Map = std::unordered_map<uint64_t, std::shared_ptr<Entry>>;
  static uint64_t key(uint32_t epoch, uint32_t loadId) noexcept { return (uint64_t(epoch) << 32) | loadId; }
  // Caller holds m_. Marks a live entry dead (its bytes leave bytes_); no
  // allocation, no free.
  void dropLocked(Entry& e) noexcept;
  // Caller holds m_. The live entry of `k`, or nullptr.
  Entry* liveLocked(uint64_t k) const noexcept;

  mutable std::mutex m_;
  Map entries_;                       // live AND dead entries (dead ones are unlinked by freePending)
  std::shared_ptr<Entry> displaced_;  // dead entries pushed out of their map slot by a new begin() (intrusive list)
  uint64_t maxBytes_ = 0;
  std::atomic<uint64_t> bytes_{0};
  std::atomic<uint32_t> epoch_{1};
  size_t live_ = 0;                   // guarded by m_
  size_t dead_ = 0;                   // guarded by m_ (in entries_ or displaced_)
  uint64_t deadBytes_ = 0;            // guarded by m_
  std::atomic<uint64_t> freed_{0}, collected_{0}, refused_{0}, clippedTotal_{0}, chunks_{0};
};

// ---- conversions (the only implementation: the renderer sends float32) ------
// Headroom gain of a source whose absolute peak is `peak`: max(1, peak).
float headroomFor(float peak) noexcept;
// Absolute peak of planar stereo float data (NaN samples ignored).
float peakOf(const float* l, const float* r, int64_t frames) noexcept;
// Folds `channels` planar channels (channel c at planar + c * frames) to
// stereo with the Web Audio "speakers" rules (SPEC.md §5): 1 = duplicated,
// 2 = as is, 4 = quad (L, R, SL, SR), 6 = 5.1 (L, R, C, LFE, SL, SR; LFE
// dropped), others = the first two channels.
void downmixToStereo(const float* planar, int channels, int64_t frames, float* l, float* r) noexcept;
// Deterministic dither seed of chunk `chunk` of stream `loadId` (the result
// never depends on the order chunks arrive in). Never 0.
uint32_t ditherSeed(uint32_t loadId, int64_t chunk) noexcept;
// Float stereo (planar) -> interleaved int16, the SPEC.md §7.3 algorithm:
//   x = seed || 0x9E3779B9 (xorshift32: x ^= x << 13; x ^= x >> 17; x ^= x << 5)
//   rand() = x / 2^32; scale = 32767 / headroom
//   per frame, L then R: d = rand() - rand() (first draw minus second),
//   s = floor(v * scale + d + 0.5), clamped to [-32768, 32767].
// NaN samples become 0. headroom < 1 counts as 1.
void quantizeS16(const float* l, const float* r, int64_t frames, float headroom, uint32_t seed,
                 int16_t* out) noexcept;
// Number of samples of planar stereo data whose magnitude exceeds `headroom`
// (the samples quantizeS16 clamps beyond the dither's 1 LSB).
uint64_t countOver(const float* l, const float* r, int64_t frames, float headroom) noexcept;

}  // namespace om
