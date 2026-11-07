// Sample format names and conversions of the device layer (owner: device):
// float32 -> f32 / s32 / s24-in-32 / s24 packed / s16 with TPDF dither for
// 16 and 24 bits, and back to float for the tests. Used on the audio thread
// by the WASAPI backend (exclusive integer formats) and on the recorder's
// writer thread. Portable. SPEC.md §5, §8.2, §14.
#include "formats.h"

#include <cmath>
#include <cstring>

namespace om {
namespace dev {

const char* sampleFormatName(SampleFormat f) noexcept {
  switch (f) {
    case SampleFormat::F32: return "f32";
    case SampleFormat::S32: return "s32";
    case SampleFormat::S24in32: return "s24";
    case SampleFormat::S24: return "s24p";
    case SampleFormat::S16: return "s16";
  }
  return "f32";
}

int bytesPerSample(SampleFormat f) noexcept {
  switch (f) {
    case SampleFormat::F32:
    case SampleFormat::S32:
    case SampleFormat::S24in32: return 4;
    case SampleFormat::S24: return 3;
    case SampleFormat::S16: return 2;
  }
  return 4;
}

int validBits(SampleFormat f) noexcept {
  switch (f) {
    case SampleFormat::F32:
    case SampleFormat::S32: return 32;
    case SampleFormat::S24in32:
    case SampleFormat::S24: return 24;
    case SampleFormat::S16: return 16;
  }
  return 32;
}

uint32_t defaultChannelMask(int channels) noexcept {
  switch (channels) {
    case 1: return 0x4;      // front center
    case 2: return 0x3;      // FL FR
    case 3: return 0x7;      // FL FR FC
    case 4: return 0x33;     // FL FR BL BR (KSAUDIO_SPEAKER_QUAD)
    case 5: return 0x37;     // FL FR FC BL BR
    case 6: return 0x3F;     // 5.1 (FL FR FC LFE BL BR)
    case 7: return 0x13F;    // 6.1
    case 8: return 0x63F;    // 7.1 surround (FL FR FC LFE BL BR SL SR)
    default: break;
  }
  if (channels <= 0) return 0;
  if (channels >= 32) return 0xFFFFFFFFu;
  return (1u << channels) - 1u;
}

namespace {

// In double: at 24 bits a float near full scale has only half-LSB resolution.
inline int32_t ditherRound(float x, double scale, double lo, double hi, Tpdf& d) noexcept {
  double v = static_cast<double>(x) * scale + static_cast<double>(d.next());
  if (!(v == v)) v = 0.0;  // NaN -> silence
  v = std::floor(v + 0.5);
  if (v < lo) v = lo;
  if (v > hi) v = hi;
  return static_cast<int32_t>(v);
}

}  // namespace

void convertFromFloat(const float* in, void* out, size_t samples, SampleFormat fmt, Tpdf& dither) noexcept {
  switch (fmt) {
    case SampleFormat::F32:
      std::memcpy(out, in, samples * sizeof(float));
      return;
    case SampleFormat::S16: {
      auto* o = static_cast<int16_t*>(out);
      for (size_t i = 0; i < samples; i++) o[i] = static_cast<int16_t>(ditherRound(in[i], 32768.0, -32768.0, 32767.0, dither));
      return;
    }
    case SampleFormat::S24: {
      auto* o = static_cast<uint8_t*>(out);
      for (size_t i = 0; i < samples; i++) {
        const int32_t s = ditherRound(in[i], 8388608.0, -8388608.0, 8388607.0, dither);
        o[3 * i] = static_cast<uint8_t>(s & 0xFF);
        o[3 * i + 1] = static_cast<uint8_t>((s >> 8) & 0xFF);
        o[3 * i + 2] = static_cast<uint8_t>((s >> 16) & 0xFF);
      }
      return;
    }
    case SampleFormat::S24in32: {
      auto* o = static_cast<int32_t*>(out);
      for (size_t i = 0; i < samples; i++) {
        const int32_t s = ditherRound(in[i], 8388608.0, -8388608.0, 8388607.0, dither);
        o[i] = static_cast<int32_t>(static_cast<uint32_t>(s) << 8);  // left-justified in the 32-bit container
      }
      return;
    }
    case SampleFormat::S32: {
      auto* o = static_cast<int32_t*>(out);
      for (size_t i = 0; i < samples; i++) {
        double v = static_cast<double>(in[i]) * 2147483648.0;
        if (!(v == v)) v = 0.0;
        v = std::floor(v + 0.5);
        if (v < -2147483648.0) v = -2147483648.0;
        if (v > 2147483647.0) v = 2147483647.0;
        o[i] = static_cast<int32_t>(v);
      }
      return;
    }
  }
}

void convertToFloat(const void* in, float* out, size_t samples, SampleFormat fmt) noexcept {
  switch (fmt) {
    case SampleFormat::F32:
      std::memcpy(out, in, samples * sizeof(float));
      return;
    case SampleFormat::S16: {
      const auto* p = static_cast<const int16_t*>(in);
      for (size_t i = 0; i < samples; i++) out[i] = p[i] * (1.0f / 32768.0f);
      return;
    }
    case SampleFormat::S24: {
      const auto* p = static_cast<const uint8_t*>(in);
      for (size_t i = 0; i < samples; i++) {
        const uint32_t u = (uint32_t(p[3 * i]) << 8) | (uint32_t(p[3 * i + 1]) << 16) | (uint32_t(p[3 * i + 2]) << 24);
        out[i] = static_cast<float>(static_cast<int32_t>(u) >> 8) * (1.0f / 8388608.0f);
      }
      return;
    }
    case SampleFormat::S24in32: {
      const auto* p = static_cast<const int32_t*>(in);
      for (size_t i = 0; i < samples; i++) out[i] = static_cast<float>(p[i] >> 8) * (1.0f / 8388608.0f);
      return;
    }
    case SampleFormat::S32: {
      const auto* p = static_cast<const int32_t*>(in);
      for (size_t i = 0; i < samples; i++) out[i] = static_cast<float>(p[i] / 2147483648.0);
      return;
    }
  }
}

}  // namespace dev
}  // namespace om
