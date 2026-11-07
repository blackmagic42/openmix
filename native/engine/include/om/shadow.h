// Shadow decoder (owner: decoder): a native decode of a file the renderer
// already decoded with Chromium, compared with Chromium's reference window,
// to measure how the two timelines differ — offset (cross-correlation,
// sub-sample), length and RMS difference — so that a switch to native
// decoding can be decided on measurements (gate: >= 99 % of the library
// within 1 ms). MP3 decoders are known to differ by up to ~51 ms (encoder
// delay handling). It is NEVER used for playback.
//
// It never runs in the engine process: Media Foundation loads third-party
// codecs, so main runs each job in a short-lived, below-normal
// "engine-host.js --shadow" process (om_shadow_run() of the C API), one file
// per process. The pipeline is portable (WAV reader for the tests); only the
// Media Foundation reader is Windows code (src/decoder/win/, om_shadow_mf).
// SPEC.md §7.4.
#pragma once

#include <atomic>
#include <cstdint>
#include <memory>
#include <string>
#include <vector>

namespace om {

enum class DecodeError : uint8_t {
  None = 0,
  Unsupported,  // format / codec not supported by this reader
  NotFound,     // no such file
  Io,           // read error, truncated or corrupt file
  Cancelled,    // the job's cancel flag was raised
  OutOfMemory,
  Internal,
  Mismatch      // decoded, but the comparison is meaningless (silent window, low correlation, offset beyond the search)
};
const char* decodeErrorName(DecodeError e) noexcept;  // "unsupported", "notFound", "io", ..., "mismatch"

// One job: the reference window cut by the renderer from Chromium's decode.
struct ShadowJob {
  uint32_t loadId = 0;
  std::string pathUtf8;          // the file the renderer decoded
  int refRate = 0;               // rate of the reference (Chromium's decode rate)
  int64_t refFrames = 0;         // length of the whole reference decode
  int64_t windowStart = 0;       // first frame of the window in the reference
  std::vector<float> left, right;  // the window (normally the middle 30 s)
};

struct ShadowReport {
  uint32_t loadId = 0;
  bool ok = false;
  DecodeError error = DecodeError::None;
  std::string message;
  double offsetMs = 0;       // native timeline minus Chromium timeline (+ = native audio later)
  double lengthDiffMs = 0;   // native length minus reference length
  double rmsDiffDb = 0;      // RMS of (native aligned - reference) relative to the reference RMS
  double correlation = 0;    // normalized correlation at the best offset (0..1)
  int fileRate = 0;
  int fileChannels = 0;
  double decodeMs = 0;       // wall time of the native decode and comparison
  // diagnostics
  double lagFrames = 0;      // the offset in reference frames
  int64_t nativeFrames = 0;  // frames of the whole native decode (file rate)
  int64_t keptFrames = 0;    // frames kept around the window (file rate): the memory the job used
  bool within1ms() const noexcept { return ok && offsetMs > -1.0 && offsetMs < 1.0; }
};

// The report as the JSON text om_shadow_run() delivers: {"loadId","ok",
// "error"?,"offsetMs","lengthDiffMs","rmsDiffDb","correlation","fileRate",
// "fileChannels","decodeMs","lagFrames","nativeFrames","keptFrames"}
// (non-finite numbers as null).
std::string shadowReportJson(const ShadowReport& r);

// Streaming reader of an audio file: interleaved float frames at the file's
// rate, folded to stereo with the Web Audio "speakers" rules (what
// Chromium's AudioBuffer would hold).
class IAudioFileReader {
 public:
  virtual ~IAudioFileReader() = default;
  virtual int sampleRate() const noexcept = 0;
  virtual int sourceChannels() const noexcept = 0;
  // Reads up to maxFrames stereo frames into `interleaved`; 0 = end of file
  // (or error: see error()).
  virtual int64_t read(float* interleaved, int64_t maxFrames) = 0;
  virtual DecodeError error() const noexcept = 0;
  virtual std::string message() const = 0;
};

// Portable WAV reader (PCM 8/16/24/32-bit, float32/64, WAVE_FORMAT_EXTENSIBLE;
// RIFF, RF64 and BW64), streaming: the tests and the golden decodes. Integer
// samples are converted like Chromium's (FFmpeg) decoder: s / 2^(bits-1)
// (8-bit: (u - 128) / 128). Non-ASCII paths are supported (UTF-8 in).
std::unique_ptr<IAudioFileReader> openWavReader(const std::string& pathUtf8, DecodeError* err, std::string* message);
// Media Foundation source reader (Windows, om_shadow_mf): streaming decode
// to float at the file's own rate and channel count, folded to stereo.
// Starts Media Foundation (MFStartup) for the life of the reader: only the
// shadow process and the tests call it. nullptr with Unsupported where no
// system decoder is built.
std::unique_ptr<IAudioFileReader> openSystemReader(const std::string& pathUtf8, DecodeError* err,
                                                   std::string* message);
// Media Foundation is usable on this machine (passive check: MFStartup /
// MFShutdown). Only the shadow process and the tests call it.
bool mediaFoundationAvailable(std::string* err);

// The whole job: streams `reader` to the end (counting frames), keeps only
// the window +- (maxOffsetMs + margins + the resampler's half-length),
// resamples only that span to the reference rate, then compares. `cancel`
// may be null; when it is raised the job stops with Cancelled.
ShadowReport runShadowJob(const ShadowJob& job, IAudioFileReader& reader, const std::atomic<bool>* cancel,
                          double maxOffsetMs = 200.0);
// Comparison of a native span (mono, at the reference rate, whose frame 0 is
// reference frame `nativeStart`) with the job's window (mono (L+R)/2):
// coarse search on x8 decimated mono over +-maxOffsetMs, full-rate
// refinement +-16 frames, parabolic sub-sample interpolation, then the
// native span is shifted by the fractional offset (windowed sinc) and the
// RMS difference and the correlation are measured over the window.
// nativeTotalFrames: length of the whole native decode in reference frames
// (for lengthDiffMs).
ShadowReport compareWindow(const ShadowJob& job, const float* nativeMono, int64_t nativeFrames, int64_t nativeStart,
                           int64_t nativeTotalFrames, double maxOffsetMs = 200.0);
// Offset finder on one shared timeline: index k of `ref` and of `sig` is the
// same instant. Only ref[windowStart, windowStart + windowFrames) is used
// (it must lie inside [0, refFrames)); sig samples outside [0, sigFrames)
// count as silence. Returns the lag (fractional frames, |lag| <= maxLag)
// such that sig[k + lag] ~= ref[k] over the window (+ = sig is later), and
// the normalized correlation at the best integer lag in *correlation.
// maxLag > 32: coarse search on x8 decimated signals (FFT correlation), then
// full-rate refinement +-16 frames; otherwise a direct full-rate search.
double findOffsetFrames(const float* refMono, int64_t refFrames, const float* sigMono, int64_t sigFrames,
                        int64_t windowStart, int64_t windowFrames, int64_t maxLag, double* correlation);

}  // namespace om
