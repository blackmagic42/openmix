// Mix recorder (owner: device): the audio thread pushes the post-limiter
// master (what engine.js fed to its MediaRecorder) into a lock-free ring, a
// writer thread streams it to a WAV file (24-bit by default, RF64 beyond
// 4 GiB) and patches the header every second, so a crash still leaves a
// playable file. Replaces MediaRecorder (WebM/Opus held in memory until
// Stop). Files live in <dataDir>/recordings and are never deleted by the
// engine or the app (SPEC.md §14). Paths are UTF-8 in the API; on Windows
// the file is opened with CreateFileW from the UTF-16 path.
#pragma once

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

#include "om/common.h"

namespace om {

enum class RecFormat : uint8_t { S16 = 0, S24 = 1, F32 = 2 };
const char* recFormatName(RecFormat f) noexcept;           // "wav16", "wav24", "wavf32"
bool recFormatFromName(const char* n, RecFormat& out) noexcept;

struct RecStatus {
  bool active = false;
  std::string path;            // UTF-8, the recording's file
  int part = 1;                // always 1: one file per recording (a device rate change is resampled into it)
  double seconds = 0;          // audio written so far
  uint64_t bytes = 0;          // size of the file so far
  uint64_t droppedFrames = 0;  // ring overflow (disk too slow): should stay 0
  std::string error;           // write error: the file was finalized and recording stopped
};

// A WAV found in the recordings folder (unsaved recordings, SPEC.md §14).
struct RecFileInfo {
  std::string path;            // UTF-8
  uint64_t bytes = 0;
  double seconds = 0;
  bool repaired = false;       // the header did not match the file length (crash): fixed
};

class Recorder {
 public:
  Recorder();
  ~Recorder();
  Recorder(const Recorder&) = delete;
  Recorder& operator=(const Recorder&) = delete;

  // Ops thread: creates <dir>/<name>.wav (folder created, name sanitized:
  // no path separator, <= 100 characters, made unique with " (2)", " (3)"...)
  // and starts the writer thread. TPDF dither when writing 16/24-bit.
  // *pathOut receives the file path (UTF-8).
  bool start(const std::string& dirUtf8, const std::string& name, RecFormat fmt, int sampleRate,
             std::string* pathOut, std::string* err);
  // Audio thread: one block of the master (RT-safe, never blocks, drops and
  // counts when the ring is full).
  void push(const float* l, const float* r, int frames) noexcept;
  // Ops thread, device re-opened at another rate (the audio is stopped): the
  // SAME file goes on at its original rate; from now on the writer thread
  // resamples what the audio thread pushes (`sampleRate`) to it (om::Resampler,
  // never on the audio thread). The path does not change.
  bool continueAtRate(int sampleRate, std::string* err);
  // Ops thread: drains the ring, finalizes the header, closes the file.
  RecStatus stop();
  RecStatus status() const;   // non-blocking (rec.status is answered inline)
  bool active() const noexcept;
  // True once after the writer hit an error (disk full, removed drive): the
  // file was finalized and recording stopped; status().error says why.
  bool takeError() noexcept;

  // Ops thread: every WAV in `dirUtf8` (the recordings folder), headers of
  // crash-left files repaired to the file length when `repair` is true.
  static std::vector<RecFileInfo> listRecordings(const std::string& dirUtf8, bool repair);
  // "OpenMix YYYY-MM-DD HHhMM" for the local time now.
  static std::string defaultName();
  // The file-name rules start() applies: no path separator nor character
  // Windows refuses, <= 100 characters, a trailing ".wav" dropped, never
  // empty (defaultName()), never a device name (CON, NUL, COM1...).
  static std::string sanitizeName(const std::string& name);

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

// WAV header helpers, exposed for the tests (canonical PCM / IEEE float,
// RF64 + ds64 when the data exceeds 4 GiB). Fixed size: 80 bytes (PCM) or
// 94 (float, with a fact chunk); a 28-byte JUNK chunk after "WAVE" becomes
// "ds64" past 4 GiB, so the header is patched in place.
std::string wavHeader(RecFormat fmt, int sampleRate, int channels, uint64_t dataBytes);

}  // namespace om
