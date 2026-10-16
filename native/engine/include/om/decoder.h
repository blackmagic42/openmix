// Turns audio files into TrackBuffers on worker threads (owner: decoder):
// Media Foundation source reader -> float -> stereo -> resampler to the
// device rate -> int16 with TPDF dither and headroom gain; optional timeline
// alignment against an excerpt of the renderer's own decode (so the beat
// grids computed in the UI land on the same samples); stems (decode, merge
// bass+other, align to the track); sampler sounds; progress and cancel.
// See SPEC.md §7.
#pragma once

#include <atomic>
#include <cstdint>
#include <memory>
#include <string>
#include <vector>

#include "om/media.h"

namespace om {

enum class DecodeError : uint8_t { None = 0, Unsupported, NotFound, Io, Cancelled, OutOfMemory, Internal };
const char* decodeErrorName(DecodeError e) noexcept;  // protocol codes: "unsupported", "notFound", ...

// Excerpt of the renderer's decode used to align the native timeline to it.
struct AlignRef {
  std::vector<float> mono;  // 0.5 * (L + R) at sampleRate
  int sampleRate = 0;
  double startSec = 0;      // track time of mono[0]
};

enum class DecodeKind : uint8_t { Track = 0, Stems, Sample };

struct DecodeRequest {
  uint64_t id = 0;                      // unique job id chosen by the caller
  DecodeKind kind = DecodeKind::Track;
  std::string path;                     // UTF-8 (Track, Sample)
  std::string stemPaths[kNumStems];     // Stems: vocals, drums, bass, other (other is merged into bass)
  int targetRate = 48000;               // device rate
  std::shared_ptr<const AlignRef> ref;  // Track: optional timeline alignment
  // Stems: align to this track (the caller keeps it alive until the job ends).
  const TrackBuffer* alignTo = nullptr;
  double maxSeconds = 0;                // Sample: cap the length (0 = whole file)
};

struct DecodeResult {
  uint64_t id = 0;
  DecodeKind kind = DecodeKind::Track;
  DecodeError error = DecodeError::None;
  std::string message;
  std::unique_ptr<TrackBuffer> track;   // Track, Sample
  std::unique_ptr<StemSet> stems;       // Stems
  double alignLagSec = kNaN;            // shift applied by the alignment (NaN = not aligned)
  double alignScore = 0;                // normalized correlation of the alignment (0..1)
  int sourceRate = 0;
  int sourceChannels = 0;
  double decodeMs = 0;
};

// Job queue with worker threads (below-normal priority, background I/O).
class Decoder {
 public:
  explicit Decoder(int threads = 1);
  ~Decoder();
  Decoder(const Decoder&) = delete;
  Decoder& operator=(const Decoder&) = delete;

  void submit(DecodeRequest req);     // any non-real-time thread
  void cancel(uint64_t id);           // pending or running job (result: Cancelled)
  bool poll(DecodeResult& out);       // control thread: true when a job has finished
  float progress(uint64_t id) const;  // 0..1, -1 = unknown job
  void shutdown();                    // cancels everything and joins the workers

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

// ---- building blocks, exposed for tests ------------------------------------
struct PcmF32 {
  std::vector<float> interleaved;  // stereo
  int sampleRate = 0;
  int64_t frames() const noexcept { return static_cast<int64_t>(interleaved.size() / 2); }
};

// Media Foundation decode of a whole file to float stereo at its native rate
// (mono duplicated, > 2 channels downmixed with ITU coefficients).
DecodeError decodeFileF32(const std::string& pathUtf8, PcmF32& out, const std::atomic<bool>* cancel,
                          std::atomic<float>* progress, std::string* message);

// Quantizes float stereo to an int16 TrackBuffer: TPDF dither, and when the
// peak exceeds full scale the samples are scaled down and `gain` restores the
// level at playback (no clipping of hot masters).
std::unique_ptr<TrackBuffer> toTrackBuffer(const float* interleavedStereo, int64_t frames, int sampleRate);

// Lag (frames) such that sig[k + lag] ~= ref[k] (coarse decimated search then
// exact refinement, port of app.js alignStems). score = normalized correlation.
int64_t findLagFrames(const float* ref, int64_t refFrames, const float* sig, int64_t sigFrames,
                      int64_t refStartInSig, int64_t maxLag, double* score);

// Drops `lag` frames at the start (lag > 0) or prepends -lag frames of silence (lag < 0).
void shiftFrames(TrackBuffer& tb, int64_t lag);

// Media Foundation is usable on this machine (passive check: MFStartup / MFShutdown).
bool mediaFoundationAvailable(std::string* err);

}  // namespace om
