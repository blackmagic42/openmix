// WAV / RF64 headers of the recorder (owner: device): the fixed-size header
// patched in place while recording (JUNK placeholder turned into ds64 past
// 4 GiB), the chunk parser and the repair plan for crash-left files.
// Portable. SPEC.md §14.
#include "wav.h"

#include <cstring>

namespace om {
namespace dev {

namespace {

void put16(std::string& s, size_t off, uint32_t v) {
  s[off] = static_cast<char>(v & 0xFF);
  s[off + 1] = static_cast<char>((v >> 8) & 0xFF);
}
void put32(std::string& s, size_t off, uint32_t v) {
  for (int i = 0; i < 4; i++) s[off + i] = static_cast<char>((v >> (8 * i)) & 0xFF);
}
void put64(std::string& s, size_t off, uint64_t v) {
  for (int i = 0; i < 8; i++) s[off + i] = static_cast<char>((v >> (8 * i)) & 0xFF);
}
void putId(std::string& s, size_t off, const char* id) { std::memcpy(&s[off], id, 4); }
std::string bytes32(uint32_t v) {
  std::string s(4, '\0');
  put32(s, 0, v);
  return s;
}
uint32_t get16(const uint8_t* p) { return static_cast<uint32_t>(p[0] | (p[1] << 8)); }
uint32_t get32(const uint8_t* p) {
  return static_cast<uint32_t>(p[0]) | (static_cast<uint32_t>(p[1]) << 8) | (static_cast<uint32_t>(p[2]) << 16) |
         (static_cast<uint32_t>(p[3]) << 24);
}
uint64_t get64(const uint8_t* p) { return static_cast<uint64_t>(get32(p)) | (static_cast<uint64_t>(get32(p + 4)) << 32); }

}  // namespace

int wavHeaderBytes(SampleFormat fmt) noexcept { return fmt == SampleFormat::F32 ? 94 : 80; }

std::string makeWavHeader(SampleFormat fmt, int sampleRate, int channels, uint64_t dataBytes) {
  const bool isF = fmt == SampleFormat::F32;
  const int hb = wavHeaderBytes(fmt);
  const int bps = bytesPerSample(fmt);
  const uint32_t blockAlign = static_cast<uint32_t>(channels * bps);
  const uint64_t frames = blockAlign ? dataBytes / blockAlign : 0;
  const uint64_t riff64 = static_cast<uint64_t>(hb) - 8 + dataBytes;
  const bool rf64 = riff64 > kRiffMax;
  std::string h(static_cast<size_t>(hb), '\0');
  putId(h, 0, rf64 ? "RF64" : "RIFF");
  put32(h, 4, rf64 ? 0xFFFFFFFFu : static_cast<uint32_t>(riff64));
  putId(h, 8, "WAVE");
  putId(h, 12, rf64 ? "ds64" : "JUNK");
  put32(h, 16, 28);
  if (rf64) {
    put64(h, 20, riff64);
    put64(h, 28, dataBytes);
    put64(h, 36, frames);
    put32(h, 44, 0);  // table length
  }
  putId(h, 48, "fmt ");
  put32(h, 52, isF ? 18 : 16);
  put16(h, 56, isF ? 3 : 1);  // WAVE_FORMAT_IEEE_FLOAT / WAVE_FORMAT_PCM
  put16(h, 58, static_cast<uint32_t>(channels));
  put32(h, 60, static_cast<uint32_t>(sampleRate));
  put32(h, 64, static_cast<uint32_t>(sampleRate) * blockAlign);
  put16(h, 68, blockAlign);
  put16(h, 70, static_cast<uint32_t>(bps * 8));
  size_t pos = 72;
  if (isF) {
    put16(h, 72, 0);  // cbSize
    pos = 74;
    putId(h, pos, "fact");
    put32(h, pos + 4, 4);
    put32(h, pos + 8, rf64 ? 0xFFFFFFFFu : static_cast<uint32_t>(frames > kRiffMax ? kRiffMax : frames));
    pos += 12;
  }
  putId(h, pos, "data");
  put32(h, pos + 4, rf64 ? 0xFFFFFFFFu : static_cast<uint32_t>(dataBytes));
  return h;
}

bool parseWavHeader(const uint8_t* p, size_t n, WavInfo& out, std::string* err) {
  auto bad = [&](const char* why) {
    if (err) *err = why;
    return false;
  };
  out = WavInfo();
  if (n < 12) return bad("too short");
  const bool riff = std::memcmp(p, "RIFF", 4) == 0;
  const bool rf64 = std::memcmp(p, "RF64", 4) == 0;
  if ((!riff && !rf64) || std::memcmp(p + 8, "WAVE", 4) != 0) return bad("not a WAV file");
  out.rf64 = rf64;
  out.riffSize = get32(p + 4);
  uint64_t ds64Riff = 0, ds64Data = 0;
  bool haveFmt = false;
  size_t pos = 12;
  while (pos + 8 <= n) {
    const uint8_t* c = p + pos;
    const uint32_t size = get32(c + 4);
    if (std::memcmp(c, "ds64", 4) == 0 && pos + 8 + 16 <= n) {
      out.ds64Pos = pos;
      ds64Riff = get64(c + 8);
      ds64Data = get64(c + 16);
    } else if (std::memcmp(c, "JUNK", 4) == 0 && size == 28 && pos == 12) {
      out.junkPos = pos;
    } else if (std::memcmp(c, "fmt ", 4) == 0 && pos + 8 + 16 <= n) {
      out.formatTag = static_cast<int>(get16(c + 8));
      out.channels = static_cast<int>(get16(c + 10));
      out.sampleRate = static_cast<int>(get32(c + 12));
      out.blockAlign = static_cast<int>(get16(c + 20));
      out.bitsPerSample = static_cast<int>(get16(c + 22));
      if (out.formatTag == 0xFFFE && size >= 40 && pos + 8 + 26 <= n) out.formatTag = static_cast<int>(get16(c + 32));
      haveFmt = true;
    } else if (std::memcmp(c, "fact", 4) == 0) {
      out.factPos = pos;
    } else if (std::memcmp(c, "data", 4) == 0) {
      out.dataChunkPos = pos;
      out.dataOffset = pos + 8;
      out.dataBytes = (rf64 && size == 0xFFFFFFFFu && out.ds64Pos) ? ds64Data : size;
      break;
    }
    const uint64_t next = static_cast<uint64_t>(pos) + 8 + size + (size & 1u);
    if (next <= pos || next > n + 0ull) {
      // A chunk running past what we read: only acceptable for "data".
      return bad("truncated header");
    }
    pos = static_cast<size_t>(next);
  }
  if (!haveFmt || out.dataOffset == 0) return bad("no fmt / data chunk");
  if (out.channels <= 0 || out.sampleRate <= 0 || out.blockAlign <= 0) return bad("invalid fmt chunk");
  if (out.formatTag != 1 && out.formatTag != 3) return bad("unsupported WAV format");
  if (rf64 && out.ds64Pos) out.riffSize = ds64Riff;
  return true;
}

bool wavRepairPlan(const WavInfo& info, uint64_t fileSize, std::vector<WavPatch>& patches, uint64_t* dataBytes) {
  patches.clear();
  uint64_t actual = fileSize > info.dataOffset ? fileSize - info.dataOffset : 0;
  if (info.blockAlign > 0) actual -= actual % static_cast<uint64_t>(info.blockAlign);
  if (dataBytes) *dataBytes = actual;
  const uint64_t frames = info.blockAlign > 0 ? actual / static_cast<uint64_t>(info.blockAlign) : 0;
  const uint64_t riff64 = info.dataOffset - 8 + actual;
  const bool needRf64 = riff64 > kRiffMax;
  if (!needRf64 && !info.rf64) {
    if (info.dataBytes == actual && info.riffSize == riff64) return true;  // consistent
    patches.push_back({4, bytes32(static_cast<uint32_t>(riff64))});
    patches.push_back({info.dataChunkPos + 4, bytes32(static_cast<uint32_t>(actual))});
    if (info.factPos && info.formatTag == 3) patches.push_back({info.factPos + 8, bytes32(static_cast<uint32_t>(frames))});
    return true;
  }
  // RF64: the 64-bit sizes go into ds64 (our JUNK placeholder, or an existing ds64).
  const uint64_t ds = info.ds64Pos ? info.ds64Pos : info.junkPos;
  if (!ds) return false;
  if (info.rf64 && info.ds64Pos && info.dataBytes == actual && info.riffSize == riff64) return true;
  std::string id = "RF64";
  patches.push_back({0, id});
  patches.push_back({4, bytes32(0xFFFFFFFFu)});
  std::string d(36, '\0');
  std::memcpy(&d[0], "ds64", 4);
  put32(d, 4, 28);
  put64(d, 8, riff64);
  put64(d, 16, actual);
  put64(d, 24, frames);
  put32(d, 32, 0);
  patches.push_back({ds, d});
  patches.push_back({info.dataChunkPos + 4, bytes32(0xFFFFFFFFu)});
  if (info.factPos && info.formatTag == 3) patches.push_back({info.factPos + 8, bytes32(0xFFFFFFFFu)});
  return true;
}

}  // namespace dev
}  // namespace om
