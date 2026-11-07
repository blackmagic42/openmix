// Media Foundation source reader, Windows (owner: decoder, library
// om_shadow_mf): streams a file as float stereo at its own rate
// (MFCreateSourceReaderFromURL; compressed formats decoded to
// MFAudioFormat_Float at the decoder's native rate and channel count,
// uncompressed PCM / float taken as stored and converted here like
// Chromium's decoder; mono duplicated, > 2 channels folded with the Web
// Audio "speakers" rules). Used ONLY by the shadow process
// (engine-host.js --shadow) and the tests: Media Foundation loads
// third-party decoder MFTs and must never start in the engine process. The
// reader starts Media Foundation (reference counted) for its own life.
// SPEC.md §7.4.
#include <windows.h>
#include <mfapi.h>
#include <mferror.h>
#include <mfidl.h>
#include <mfreadwrite.h>

#include <algorithm>
#include <cstdio>
#include <cstring>
#include <mutex>
#include <string>
#include <vector>

#include "om/pcm.h"
#include "om/shadow.h"

namespace om {

namespace {

// Minimal COM pointer (no WRL dependency).
template <class T>
class Com {
 public:
  Com() = default;
  ~Com() { reset(); }
  Com(const Com&) = delete;
  Com& operator=(const Com&) = delete;
  T** put() {
    reset();
    return &p_;
  }
  T* get() const { return p_; }
  T* operator->() const { return p_; }
  explicit operator bool() const { return p_ != nullptr; }
  void reset() {
    if (p_) p_->Release();
    p_ = nullptr;
  }

 private:
  T* p_ = nullptr;
};

std::wstring widen(const std::string& s) {
  if (s.empty()) return std::wstring();
  const int n = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, s.data(), static_cast<int>(s.size()), nullptr, 0);
  if (n <= 0) return std::wstring();
  std::wstring w(static_cast<size_t>(n), L'\0');
  MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, s.data(), static_cast<int>(s.size()), w.data(), n);
  return w;
}

std::string hrText(const char* what, HRESULT hr) {
  char b[96];
  std::snprintf(b, sizeof b, "%s (0x%08lX)", what, static_cast<unsigned long>(hr));
  return b;
}

// Process-wide Media Foundation start, reference counted.
std::mutex gMfLock;
int gMfUsers = 0;

bool mfAcquire() {
  std::lock_guard<std::mutex> lk(gMfLock);
  if (gMfUsers == 0 && FAILED(MFStartup(MF_VERSION, MFSTARTUP_LITE))) return false;
  gMfUsers++;
  return true;
}

void mfRelease() {
  std::lock_guard<std::mutex> lk(gMfLock);
  if (gMfUsers > 0 && --gMfUsers == 0) MFShutdown();
}

class MfReader final : public IAudioFileReader {
 public:
  ~MfReader() override {
    reader_.reset();
    if (mf_) mfRelease();
    if (comInit_ && GetCurrentThreadId() == comThread_) CoUninitialize();
  }

  bool open(const std::string& pathUtf8, DecodeError& e, std::string& m) {
    const std::wstring w = widen(pathUtf8);
    if (w.empty()) return fail(e, m, DecodeError::NotFound, "bad path");
    const DWORD attr = GetFileAttributesW(w.c_str());
    if (attr == INVALID_FILE_ATTRIBUTES) {
      const DWORD le = GetLastError();
      return fail(e, m, (le == ERROR_FILE_NOT_FOUND || le == ERROR_PATH_NOT_FOUND) ? DecodeError::NotFound : DecodeError::Io,
                  "file not found");
    }
    if (attr & FILE_ATTRIBUTE_DIRECTORY) return fail(e, m, DecodeError::Io, "not a regular file");
    const HRESULT hrCo = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    if (SUCCEEDED(hrCo)) {
      comInit_ = true;
      comThread_ = GetCurrentThreadId();
    }  // (RPC_E_CHANGED_MODE: an STA thread; the synchronous source reader works there too)
    if (!mfAcquire()) return fail(e, m, DecodeError::Unsupported, "MFStartup failed");
    mf_ = true;
    Com<IMFAttributes> attrs;
    if (FAILED(MFCreateAttributes(attrs.put(), 1))) return fail(e, m, DecodeError::Internal, "MFCreateAttributes failed");
    HRESULT hr = MFCreateSourceReaderFromURL(w.c_str(), attrs.get(), reader_.put());
    if (FAILED(hr)) {
      const bool unsupported = hr == MF_E_UNSUPPORTED_BYTESTREAM_TYPE || hr == MF_E_UNSUPPORTED_FORMAT ||
                               hr == MF_E_INVALIDMEDIATYPE || hr == MF_E_UNSUPPORTED_SCHEME;
      const bool missing = hr == HRESULT_FROM_WIN32(ERROR_FILE_NOT_FOUND) || hr == HRESULT_FROM_WIN32(ERROR_PATH_NOT_FOUND);
      return fail(e, m, missing ? DecodeError::NotFound : (unsupported ? DecodeError::Unsupported : DecodeError::Io),
                  hrText("cannot open the file with Media Foundation", hr));
    }
    const DWORD audio = static_cast<DWORD>(MF_SOURCE_READER_FIRST_AUDIO_STREAM);
    reader_->SetStreamSelection(static_cast<DWORD>(MF_SOURCE_READER_ALL_STREAMS), FALSE);
    hr = reader_->SetStreamSelection(audio, TRUE);
    if (FAILED(hr)) return fail(e, m, DecodeError::Unsupported, "no audio stream");
    Com<IMFMediaType> native;
    GUID nativeSub{};
    if (SUCCEEDED(reader_->GetNativeMediaType(audio, 0, native.put()))) {
      UINT32 ch = 0;
      if (SUCCEEDED(native->GetUINT32(MF_MT_AUDIO_NUM_CHANNELS, &ch))) srcChannels_ = static_cast<int>(ch);
      native->GetGUID(MF_MT_SUBTYPE, &nativeSub);
    }
    // Uncompressed sources (WAV...): the samples as stored, converted here
    // like Chromium's decoder (s / 2^(bits-1); Media Foundation's own
    // int32 -> float conversion truncates to 24 bits). Compressed sources:
    // the decoder's float output.
    hr = E_FAIL;
    if (native && (nativeSub == MFAudioFormat_PCM || nativeSub == MFAudioFormat_Float))
      hr = reader_->SetCurrentMediaType(audio, nullptr, native.get());
    if (FAILED(hr)) {
      Com<IMFMediaType> partial;
      if (FAILED(MFCreateMediaType(partial.put()))) return fail(e, m, DecodeError::Internal, "MFCreateMediaType failed");
      partial->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Audio);
      partial->SetGUID(MF_MT_SUBTYPE, MFAudioFormat_Float);
      hr = reader_->SetCurrentMediaType(audio, nullptr, partial.get());
      if (FAILED(hr)) return fail(e, m, DecodeError::Unsupported, hrText("no float decoder for this file", hr));
    }
    if (!readFormat(e, m)) return false;
    if (srcChannels_ <= 0) srcChannels_ = channels_;
    return true;
  }

  int sampleRate() const noexcept override { return rate_; }
  int sourceChannels() const noexcept override { return srcChannels_; }
  DecodeError error() const noexcept override { return err_; }
  std::string message() const override { return msg_; }

  int64_t read(float* out, int64_t maxFrames) override {
    if (err_ != DecodeError::None || !out || maxFrames <= 0) return 0;
    while (pendingFrames() == 0 && !eos_) {
      if (!pull()) return 0;
    }
    const int64_t n = std::min<int64_t>(maxFrames, pendingFrames());
    if (n <= 0) return 0;
    const size_t frames = static_cast<size_t>(n);
    const unsigned char* src = pend_.data() + pendPos_ * frameBytes();
    planar_.resize(frames * static_cast<size_t>(channels_));
    const size_t stride = frameBytes();
    for (int c = 0; c < channels_; c++) {
      float* dst = planar_.data() + static_cast<size_t>(c) * frames;
      const unsigned char* p = src + static_cast<size_t>(c) * bytes_;
      for (size_t i = 0; i < frames; i++, p += stride) dst[i] = sample(p);
    }
    l_.resize(frames);
    r_.resize(frames);
    downmixToStereo(planar_.data(), channels_, n, l_.data(), r_.data());
    for (size_t i = 0; i < frames; i++) {
      out[2 * i] = l_[i];
      out[2 * i + 1] = r_[i];
    }
    pendPos_ += frames;
    if (pendPos_ * frameBytes() >= pend_.size()) {
      pend_.clear();
      pendPos_ = 0;
    }
    return n;
  }

 private:
  static bool fail(DecodeError& e, std::string& m, DecodeError what, const std::string& why) {
    e = what;
    m = why;
    return false;
  }

  bool readFormat(DecodeError& e, std::string& m) {
    Com<IMFMediaType> type;
    const DWORD audio = static_cast<DWORD>(MF_SOURCE_READER_FIRST_AUDIO_STREAM);
    if (FAILED(reader_->GetCurrentMediaType(audio, type.put()))) return fail(e, m, DecodeError::Internal, "no media type");
    GUID sub{};
    UINT32 rate = 0, ch = 0, bits = 0;
    type->GetGUID(MF_MT_SUBTYPE, &sub);
    type->GetUINT32(MF_MT_AUDIO_SAMPLES_PER_SECOND, &rate);
    type->GetUINT32(MF_MT_AUDIO_NUM_CHANNELS, &ch);
    type->GetUINT32(MF_MT_AUDIO_BITS_PER_SAMPLE, &bits);
    const bool isFloat = sub == MFAudioFormat_Float && (bits == 32 || bits == 64);
    const bool isPcm = sub == MFAudioFormat_PCM && (bits == 8 || bits == 16 || bits == 24 || bits == 32);
    if ((!isFloat && !isPcm) || rate == 0 || ch == 0 || ch > 64)
      return fail(e, m, DecodeError::Unsupported, "unexpected decoder output format");
    rate_ = static_cast<int>(rate);
    channels_ = static_cast<int>(ch);
    float_ = isFloat;
    bytes_ = static_cast<int>(bits / 8);
    return true;
  }

  size_t frameBytes() const noexcept { return static_cast<size_t>(channels_) * static_cast<size_t>(bytes_); }

  int64_t pendingFrames() const noexcept {
    return frameBytes() ? static_cast<int64_t>(pend_.size() / frameBytes()) - static_cast<int64_t>(pendPos_) : 0;
  }

  // One stored sample as float, converted like Chromium's (FFmpeg) decoder.
  float sample(const unsigned char* p) const noexcept {
    if (float_) {
      if (bytes_ == 4) {
        float f;
        std::memcpy(&f, p, 4);
        return f;
      }
      double d;
      std::memcpy(&d, p, 8);
      return static_cast<float>(d);
    }
    switch (bytes_) {
      case 1: return (static_cast<int>(p[0]) - 128) * (1.0f / 128.0f);
      case 2: return static_cast<float>(static_cast<int16_t>(p[0] | (p[1] << 8))) * (1.0f / 32768.0f);
      case 3: {
        const int32_t v = static_cast<int32_t>((static_cast<uint32_t>(p[0]) << 8) | (static_cast<uint32_t>(p[1]) << 16) |
                                               (static_cast<uint32_t>(p[2]) << 24)) >> 8;
        return static_cast<float>(v) * (1.0f / 8388608.0f);
      }
      default: {
        int32_t v;
        std::memcpy(&v, p, 4);
        return static_cast<float>(v) * (1.0f / 2147483648.0f);
      }
    }
  }

  // One ReadSample: appends its frames to pend_ (false = error, err_ set).
  bool pull() {
    DWORD index = 0, flags = 0;
    LONGLONG ts = 0;
    Com<IMFSample> sample;
    const HRESULT hr =
        reader_->ReadSample(static_cast<DWORD>(MF_SOURCE_READER_FIRST_AUDIO_STREAM), 0, &index, &flags, &ts, sample.put());
    if (FAILED(hr)) {
      err_ = DecodeError::Io;
      msg_ = hrText("decode error", hr);
      return false;
    }
    if (flags & MF_SOURCE_READERF_ERROR) {
      err_ = DecodeError::Io;
      msg_ = "decode error";
      return false;
    }
    if (flags & MF_SOURCE_READERF_CURRENTMEDIATYPECHANGED) {
      // (pull() runs only when nothing is pending: no frame of the old layout is left)
      const int oldRate = rate_;
      DecodeError e = DecodeError::None;
      std::string m;
      if (!readFormat(e, m)) {
        err_ = e;
        msg_ = m;
        return false;
      }
      if (rate_ != oldRate) {
        err_ = DecodeError::Unsupported;
        msg_ = "the sample rate changes inside the file";
        return false;
      }
    }
    if (flags & MF_SOURCE_READERF_ENDOFSTREAM) eos_ = true;
    if (!sample) return true;
    Com<IMFMediaBuffer> buffer;
    if (FAILED(sample->ConvertToContiguousBuffer(buffer.put()))) {
      err_ = DecodeError::Io;
      msg_ = "cannot read a decoded buffer";
      return false;
    }
    BYTE* data = nullptr;
    DWORD len = 0;
    if (FAILED(buffer->Lock(&data, nullptr, &len))) {
      err_ = DecodeError::Io;
      msg_ = "cannot lock a decoded buffer";
      return false;
    }
    const size_t bytes = len / frameBytes() * frameBytes();  // whole frames only
    if (pendPos_) {
      pend_.erase(pend_.begin(), pend_.begin() + static_cast<std::ptrdiff_t>(pendPos_ * frameBytes()));
      pendPos_ = 0;
    }
    const size_t at = pend_.size();
    pend_.resize(at + bytes);
    std::memcpy(pend_.data() + at, data, bytes);
    buffer->Unlock();
    return true;
  }

  Com<IMFSourceReader> reader_;
  bool mf_ = false, comInit_ = false, eos_ = false, float_ = true;
  DWORD comThread_ = 0;
  int rate_ = 0, channels_ = 0, srcChannels_ = 0, bytes_ = 4;
  std::vector<unsigned char> pend_;  // decoded interleaved frames (decoder layout) not returned yet
  size_t pendPos_ = 0;               // frames of pend_ already returned
  std::vector<float> planar_, l_, r_;
  DecodeError err_ = DecodeError::None;
  std::string msg_;
};

}  // namespace

std::unique_ptr<IAudioFileReader> openSystemReader(const std::string& pathUtf8, DecodeError* err, std::string* message) {
  auto r = std::make_unique<MfReader>();
  DecodeError e = DecodeError::None;
  std::string m;
  bool ok = false;
  try {
    ok = r->open(pathUtf8, e, m);
  } catch (...) {
    e = DecodeError::Internal;
    m = "Media Foundation reader failed";
  }
  if (err) *err = ok ? DecodeError::None : e;
  if (message) *message = ok ? std::string() : m;
  if (!ok) return nullptr;
  return r;
}

bool mediaFoundationAvailable(std::string* err) {
  const HRESULT hrInit = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  const bool needUninit = SUCCEEDED(hrInit);
  const bool ok = mfAcquire();
  if (ok) mfRelease();
  if (needUninit) CoUninitialize();
  if (!ok && err) *err = "MFStartup failed";
  return ok;
}

}  // namespace om
