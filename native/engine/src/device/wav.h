// WAV / RF64 headers of the recorder (owner: device, private header). Our
// files always reserve a 28-byte JUNK chunk right after "WAVE" that becomes
// the "ds64" chunk when the data passes 4 GiB (EBU Tech 3306), so the header
// has a fixed size and is patched in place every second:
//   PCM 16/24:  RIFF | JUNK(28) | fmt (16) | data            -> 80 bytes
//   float32:    RIFF | JUNK(28) | fmt (18) | fact(4) | data  -> 94 bytes
// Also the parser and the repair plan used by listRecordings() for files a
// crash left with stale sizes (the data runs to the end of the file).
// Portable. SPEC.md §14.
#pragma once

#include <cstdint>
#include <string>
#include <vector>

#include "formats.h"

namespace om {
namespace dev {

constexpr uint64_t kRiffMax = 0xFFFFFFFFull;
int wavHeaderBytes(SampleFormat fmt) noexcept;  // 80 (PCM) or 94 (float)
// Our header for `dataBytes` of audio: RIFF while the RIFF size fits in 32
// bits, RF64 + ds64 beyond. fmt: S16, S24 (packed) or F32.
std::string makeWavHeader(SampleFormat fmt, int sampleRate, int channels, uint64_t dataBytes);

struct WavInfo {
  bool rf64 = false;
  int formatTag = 0;        // 1 PCM, 3 IEEE float (WAVE_FORMAT_EXTENSIBLE resolved)
  int channels = 0;
  int sampleRate = 0;
  int bitsPerSample = 0;
  int blockAlign = 0;
  uint64_t riffSize = 0;    // from the header (ds64 when RF64)
  uint64_t dataBytes = 0;   // from the header (ds64 when RF64)
  uint64_t dataOffset = 0;  // first audio byte
  uint64_t dataChunkPos = 0;
  uint64_t junkPos = 0;     // 28-byte JUNK placeholder (0 = none)
  uint64_t ds64Pos = 0;     // ds64 chunk (0 = none)
  uint64_t factPos = 0;     // fact chunk (0 = none)
};
// Parses the first `n` bytes of a file. False when it is not a WAV we can read.
bool parseWavHeader(const uint8_t* p, size_t n, WavInfo& out, std::string* err);

struct WavPatch {
  uint64_t offset;
  std::string bytes;
};
// Size fields of a file of `fileSize` bytes whose data runs to the end of the
// file (rounded down to whole frames). Fills `patches` (empty: the header
// already matches) and *dataBytes. False when the file needs RF64 but has no
// placeholder to hold the ds64 chunk (left as it is).
bool wavRepairPlan(const WavInfo& info, uint64_t fileSize, std::vector<WavPatch>& patches, uint64_t* dataBytes);

}  // namespace dev
}  // namespace om
