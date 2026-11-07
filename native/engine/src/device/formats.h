// Sample formats of the device layer (owner: device, private header): the
// endpoint formats the WASAPI backend negotiates (f32, s32, s24 in a 32-bit
// container, s24 packed, s16), the formats the recorder writes, and the
// real-time conversion from the engine's float32 with TPDF dither for the
// 16- and 24-bit integer formats. Portable (no platform header).
// SPEC.md §5, §8.2, §14.
#pragma once

#include <cstddef>
#include <cstdint>

namespace om {
namespace dev {

enum class SampleFormat : uint8_t { F32 = 0, S32 = 1, S24in32 = 2, S24 = 3, S16 = 4 };

// "f32", "s32", "s24" (24 in 32), "s24p" (packed 3 bytes), "s16"
const char* sampleFormatName(SampleFormat f) noexcept;
int bytesPerSample(SampleFormat f) noexcept;   // container size: 4, 4, 4, 3, 2
int validBits(SampleFormat f) noexcept;        // 32, 32, 24, 24, 16
inline bool isFloat(SampleFormat f) noexcept { return f == SampleFormat::F32; }

struct StreamFormat {
  int sampleRate = 0;
  int channels = 0;
  uint32_t channelMask = 0;  // SPEAKER_* bits (0 = unspecified)
  SampleFormat format = SampleFormat::F32;
  int blockAlign() const noexcept { return channels * bytesPerSample(format); }
  bool operator==(const StreamFormat& o) const noexcept {
    return sampleRate == o.sampleRate && channels == o.channels && channelMask == o.channelMask && format == o.format;
  }
  bool operator!=(const StreamFormat& o) const noexcept { return !(*this == o); }
};

// Default WAVEFORMATEXTENSIBLE channel mask for a channel count (stereo,
// quad, 5.1, 7.1...; the first n speaker bits otherwise).
uint32_t defaultChannelMask(int channels) noexcept;

// TPDF dither source: xorshift32, two uniforms per value, triangular in
// (-1, 1) LSB. Deterministic for a given seed. RT-safe.
class Tpdf {
 public:
  explicit Tpdf(uint32_t seed = 0x2545F491u) noexcept : s_(seed ? seed : 1u) {}
  void seed(uint32_t s) noexcept { s_ = s ? s : 1u; }
  float next() noexcept {
    return uniform() - uniform();
  }

 private:
  float uniform() noexcept {
    s_ ^= s_ << 13;
    s_ ^= s_ >> 17;
    s_ ^= s_ << 5;
    return static_cast<float>(s_ >> 8) * (1.0f / 16777216.0f);  // [0, 1), 24-bit resolution
  }
  uint32_t s_;
};

// Interleaved float32 (nominal [-1, 1]) -> `fmt`, little-endian. 16- and
// 24-bit integers get TPDF dither (scale 2^(bits-1), clamped); s32 is
// rounded without dither (float has 24 bits of mantissa); f32 is copied.
// `samples` = frames * channels. RT-safe (no allocation).
void convertFromFloat(const float* in, void* out, size_t samples, SampleFormat fmt, Tpdf& dither) noexcept;
// `fmt` -> float32 (tests, header repair checks). RT-safe.
void convertToFloat(const void* in, float* out, size_t samples, SampleFormat fmt) noexcept;

}  // namespace dev
}  // namespace om
