// Mix recorder: the audio thread pushes the post-limiter master into a
// lock-free ring, a writer thread writes it to a WAV file (RF64 beyond 4 GB),
// patching the header regularly so a crash still leaves a playable file
// (owner: device). See SPEC.md §13.
#pragma once

#include <cstdint>
#include <memory>
#include <string>

#include "om/common.h"

namespace om {

enum class RecFormat : uint8_t { S16 = 0, S24 = 1, F32 = 2 };

struct RecStatus {
  bool active = false;
  std::string path;            // UTF-8
  double seconds = 0;          // audio written so far
  uint64_t bytes = 0;          // file size so far
  uint64_t droppedFrames = 0;  // ring overflow (disk too slow): should stay 0
  std::string error;
};

class Recorder {
 public:
  Recorder();
  ~Recorder();
  Recorder(const Recorder&) = delete;
  Recorder& operator=(const Recorder&) = delete;

  // Control thread: creates the file and starts the writer thread.
  bool start(const std::string& pathUtf8, RecFormat fmt, int sampleRate, std::string* err);
  // Audio thread: one block of the master (RT-safe, never blocks).
  void push(const float* l, const float* r, int frames) noexcept;
  // Control thread: drains the ring, finalizes the header, closes the file.
  RecStatus stop();
  RecStatus status() const;
  bool active() const noexcept;

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

}  // namespace om
