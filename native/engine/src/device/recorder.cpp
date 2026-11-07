// Mix recorder (owner: device): lock-free ring from the audio thread (>= 2 s
// at any rate up to 192 kHz), writer thread (above normal priority), WAV /
// RF64 file 24-bit by default (16-bit and float32 optional) with TPDF dither,
// header patched every second (crash-safe: the file is always playable),
// files in <dataDir>/recordings never deleted and never overwritten (unique
// names, created with "create new"), ONE file per recording whatever the
// device does (a device re-opened at another rate is resampled to the
// recording's rate on the writer thread, never on the audio thread), write
// errors finalized and reported (takeError), and the listing (with header
// repair) of unsaved recordings. Portable; the file is opened through the
// platform seam (CreateFileW from the UTF-16 path on Windows,
// std::filesystem elsewhere). SPEC.md §14.
#include "om/recorder.h"

#include <algorithm>
#include <chrono>
#include <condition_variable>
#include <cstring>
#include <ctime>
#include <mutex>
#include <thread>

#include "om/device.h"
#include "om/resampler.h"
#include "formats.h"
#include "platform.h"
#include "ring.h"
#include "test_hooks.h"
#include "wav.h"

namespace om {

const char* recFormatName(RecFormat f) noexcept {
  switch (f) {
    case RecFormat::S16: return "wav16";
    case RecFormat::S24: return "wav24";
    case RecFormat::F32: return "wavf32";
  }
  return "wav24";
}

bool recFormatFromName(const char* n, RecFormat& out) noexcept {
  if (!n) return false;
  if (std::strcmp(n, "wav16") == 0) out = RecFormat::S16;
  else if (std::strcmp(n, "wav24") == 0) out = RecFormat::S24;
  else if (std::strcmp(n, "wavf32") == 0) out = RecFormat::F32;
  else return false;
  return true;
}

namespace {

dev::SampleFormat sampleFormatOf(RecFormat f) noexcept {
  switch (f) {
    case RecFormat::S16: return dev::SampleFormat::S16;
    case RecFormat::S24: return dev::SampleFormat::S24;
    case RecFormat::F32: return dev::SampleFormat::F32;
  }
  return dev::SampleFormat::S24;
}

constexpr int kChannels = 2;
constexpr size_t kRingFrames = size_t(1) << 19;  // 524288 frames: 2.7 s at 192 kHz, 10.9 s at 48 kHz
constexpr size_t kChunkFrames = 8192;            // frames converted and written per write call
constexpr size_t kMaxNameChars = 100;

// Decodes one UTF-8 sequence at s[i]; returns its length (0 = invalid).
size_t utf8Len(const std::string& s, size_t i) {
  const unsigned char c = static_cast<unsigned char>(s[i]);
  size_t n = c < 0x80 ? 1 : (c >> 5) == 0x6 ? 2 : (c >> 4) == 0xE ? 3 : (c >> 3) == 0x1E ? 4 : 0;
  if (n == 0 || i + n > s.size()) return 0;
  for (size_t k = 1; k < n; k++)
    if ((static_cast<unsigned char>(s[i + k]) & 0xC0) != 0x80) return 0;
  if (n == 2 && c < 0xC2) return 0;  // overlong
  return n;
}

bool iequalsAscii(const std::string& a, const char* b) {
  const size_t n = std::strlen(b);
  if (a.size() != n) return false;
  for (size_t i = 0; i < n; i++) {
    char x = a[i], y = b[i];
    if (x >= 'a' && x <= 'z') x = static_cast<char>(x - 32);
    if (y >= 'a' && y <= 'z') y = static_cast<char>(y - 32);
    if (x != y) return false;
  }
  return true;
}

bool endsWithWav(const std::string& s) {
  if (s.size() < 4) return false;
  return iequalsAscii(s.substr(s.size() - 4), ".WAV");
}

}  // namespace

// The rules of SPEC.md §14: no path separator, nothing Windows refuses in a
// file name, <= 100 characters, never empty, never a device name.
std::string Recorder::sanitizeName(const std::string& in) {
  std::string out;
  size_t chars = 0;
  for (size_t i = 0; i < in.size() && chars < kMaxNameChars;) {
    const size_t n = utf8Len(in, i);
    if (n == 0) {  // invalid UTF-8 byte
      out += '_';
      i++;
      chars++;
      continue;
    }
    if (n == 1) {
      const char c = in[i];
      const unsigned char u = static_cast<unsigned char>(c);
      if (u < 0x20 || u == 0x7F || std::strchr("<>:\"/\\|?*", c)) {
        out += (u < 0x20 || u == 0x7F) ? ' ' : '_';
      } else {
        out += c;
      }
    } else {
      out.append(in, i, n);
    }
    i += n;
    chars++;
  }
  // Windows drops trailing dots and spaces; a ".wav" the user typed is ours
  // to add; leading spaces are confusing.
  auto trimEnd = [&out] {
    while (!out.empty() && (out.back() == ' ' || out.back() == '.')) out.pop_back();
  };
  trimEnd();
  if (endsWithWav(out)) out.resize(out.size() - 4);
  trimEnd();
  size_t lead = 0;
  while (lead < out.size() && out[lead] == ' ') lead++;
  out.erase(0, lead);
  if (out.empty()) return Recorder::defaultName();
  // Reserved device names (with or without an extension).
  const std::string stem = out.substr(0, out.find('.'));
  static const char* const kReserved[] = {"CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6",
                                          "COM7", "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7",
                                          "LPT8", "LPT9"};
  for (const char* r : kReserved)
    if (iequalsAscii(stem, r)) return "_" + out;
  return out;
}

struct Recorder::Impl {
  // ---- current recording (ops thread; the writer reads it while it runs) ----
  std::string dir, base;
  RecFormat recFmt = RecFormat::S24;
  dev::SampleFormat fmt = dev::SampleFormat::S24;
  int rate = 48000;    // the file's rate (the device rate at start), never changes
  int inRate = 48000;  // the rate of what the audio thread pushes (the device's)
  int suffix = 1;  // " (n)" of the current file (1 = none)
  std::unique_ptr<dev::plat::File> file;
  uint64_t dataBytes = 0;  // writer thread while it runs
  // Device rate != file rate: the writer resamples (polyphase windowed sinc,
  // streaming; null when the rates are equal). Writer thread while it runs,
  // the ops thread while it is stopped.
  std::unique_ptr<Resampler> rs;
  std::vector<float> rsOut;
  // ---- audio thread -> writer ----
  dev::StereoRing ring;
  std::atomic<bool> active{false};
  // A write error is being finalized: the audio thread already stopped
  // pushing (active false), status() still shows the recording active until
  // the error is published (error + errorFlag, under sm).
  std::atomic<bool> failing{false};
  std::atomic<uint64_t> dropped{0};
  // ---- writer ----
  std::thread writer;
  std::mutex wm;
  std::condition_variable wcv;
  bool stopReq = false;
  dev::Tpdf dither;
  std::vector<uint8_t> conv;
  // ---- status (any thread) ----
  mutable std::mutex sm;
  std::string path, error;
  int part = 1;                          // always 1: one file per recording
  std::atomic<uint64_t> framesCur{0};    // frames written to the file (at its rate)
  std::atomic<int> rateCur{48000};       // the file's rate
  std::atomic<uint64_t> bytesCur{0};
  std::atomic<bool> errorFlag{false};

  std::string joinPath(const std::string& name) const {
    std::string p = dir;
    if (!p.empty() && p.back() != '/' && p.back() != '\\') p += dev::plat::pathSeparator();
    return p + name;
  }

  // Creates the first free "<base>.wav" / "<base> (k).wav" with k >= startSuffix.
  bool openUnique(int startSuffix, std::string* pathOut, std::string* err) {
    for (int k = std::max(1, startSuffix); k < 10000; k++) {
      const std::string name = k == 1 ? base : base + " (" + std::to_string(k) + ")";
      const std::string p = joinPath(name + ".wav");
      bool exists = false;
      std::string e;
      auto f = dev::plat::openFile(p, dev::plat::OpenMode::CreateNew, &e, &exists);
      if (f) {
        file = std::move(f);
        suffix = k;
        *pathOut = p;
        return true;
      }
      if (!exists) {
        if (err) *err = e.empty() ? "cannot create " + p : e;
        return false;
      }
    }
    if (err) *err = "no free file name for " + base;
    return false;
  }

  bool writeHeader(std::string* err) {
    const std::string h = dev::makeWavHeader(fmt, rate, kChannels, dataBytes);
    if (!file->writeAt(0, h.data(), h.size())) {
      if (err) *err = "write error: " + file->lastError();
      return false;
    }
    return true;
  }

  // Converts and appends interleaved stereo frames at the file's rate, in
  // chunks of kChunkFrames. False on a write error (*err says why).
  bool writeFrames(const float* p, size_t frames, std::string* err) {
    const int bps = dev::bytesPerSample(fmt);
    while (frames > 0) {
      const size_t n = std::min(frames, kChunkFrames);
      const size_t bytes = n * kChannels * static_cast<size_t>(bps);
      dev::convertFromFloat(p, conv.data(), n * kChannels, fmt, dither);
      const int64_t failAt = dev::testhooks::recFailAfterBytes.load(std::memory_order_relaxed);
      if (failAt >= 0 && dataBytes + bytes > static_cast<uint64_t>(failAt)) {
        if (err) *err = "write error: there is not enough space on the disk (simulated)";
        return false;
      }
      if (!file->append(conv.data(), bytes)) {
        if (err) *err = "write error: " + file->lastError();
        return false;
      }
      dataBytes += bytes;
      framesCur.fetch_add(n, std::memory_order_relaxed);
      bytesCur.store(static_cast<uint64_t>(dev::wavHeaderBytes(fmt)) + dataBytes, std::memory_order_relaxed);
      p += n * kChannels;
      frames -= n;
    }
    return true;
  }

  // Writes what the ring holds (resampled to the file's rate when the device
  // runs at another one). False on a write error (*err says why).
  bool drain(std::string* err) {
    for (;;) {
      const size_t avail = ring.available();
      if (avail == 0) return true;
      const uint64_t r = ring.readIndex();
      const float* sp = nullptr;
      const size_t n = ring.span(r, std::min(avail, kChunkFrames), &sp);
      if (rs) {
        rsOut.clear();  // (keeps its capacity)
        rs->process(sp, static_cast<int64_t>(n), rsOut, false);
        if (!writeFrames(rsOut.data(), rsOut.size() / kChannels, err)) return false;
      } else if (!writeFrames(sp, n, err)) {
        return false;
      }
      ring.consumeTo(r + n);
    }
  }

  // The resampler's last output frames (its filter tail), at the end of the
  // audio of one device rate. False on a write error.
  bool flushResampler(std::string* err) {
    if (!rs) return true;
    rsOut.clear();
    rs->process(nullptr, 0, rsOut, true);
    return writeFrames(rsOut.data(), rsOut.size() / kChannels, err);
  }

  // Patches the header with what was written, flushes, closes.
  void finalizeFile() {
    if (!file) return;
    std::string ignored;
    writeHeader(&ignored);
    file->flush();
    file.reset();
  }

  // Whoever sees status().active turn false after a write error also sees
  // the error (status().error, takeError()), and whoever takes the error
  // sees the recording inactive: both are published in one critical
  // section, after the file is finalized.
  void fail(const std::string& why) {
    failing.store(true, std::memory_order_release);
    active.store(false, std::memory_order_release);  // the audio thread stops pushing
    finalizeFile();  // keep what was written playable
    {
      std::lock_guard<std::mutex> lk(sm);
      error = why;
      errorFlag.store(true, std::memory_order_release);
      failing.store(false, std::memory_order_release);
    }
  }

  void writerLoop() {
    raiseServiceThreadPriority();  // "above normal" (SPEC.md §3.1)
    using clock = std::chrono::steady_clock;
    auto lastPatch = clock::now();
    uint64_t patched = dataBytes;
    for (;;) {
      bool stopping;
      {
        std::unique_lock<std::mutex> lk(wm);
        wcv.wait_for(lk, std::chrono::milliseconds(50), [&] { return stopReq; });
        stopping = stopReq;
      }
      if (!stopping && dev::testhooks::recWriterStall.load(std::memory_order_relaxed)) continue;
      std::string err;
      if (!drain(&err)) {
        fail(err);
        return;
      }
      const auto now = clock::now();
      if (dataBytes != patched && now - lastPatch >= std::chrono::seconds(1)) {
        // Header patched every second: a crash still leaves a playable file.
        if (!writeHeader(&err)) {
          fail(err);
          return;
        }
        patched = dataBytes;
        lastPatch = now;
      }
      if (stopping) return;
    }
  }

  void startWriter() {
    {
      std::lock_guard<std::mutex> lk(wm);
      stopReq = false;
    }
    writer = std::thread([this] { writerLoop(); });
  }

  void stopWriter() {
    if (!writer.joinable()) return;
    {
      std::lock_guard<std::mutex> lk(wm);
      stopReq = true;
    }
    wcv.notify_all();
    writer.join();
  }

  double seconds() const {
    const int r = rateCur.load(std::memory_order_relaxed);
    return r > 0 ? static_cast<double>(framesCur.load(std::memory_order_relaxed)) / r : 0.0;
  }
};

std::string wavHeader(RecFormat fmt, int sampleRate, int channels, uint64_t dataBytes) {
  return dev::makeWavHeader(sampleFormatOf(fmt), sampleRate, channels, dataBytes);
}

Recorder::Recorder() : impl_(std::make_unique<Impl>()) {}

Recorder::~Recorder() {
  if (impl_->writer.joinable() || impl_->file) stop();
}

bool Recorder::start(const std::string& dirUtf8, const std::string& name, RecFormat fmt, int sampleRate,
                     std::string* pathOut, std::string* err) {
  Impl& m = *impl_;
  if (pathOut) pathOut->clear();
  if (m.active.load() || m.writer.joinable() || m.file) {
    if (err) *err = "already recording";
    return false;
  }
  if (dirUtf8.empty()) {
    if (err) *err = "no recordings folder";
    return false;
  }
  if (sampleRate < 8000 || sampleRate > 384000) {
    if (err) *err = "invalid sample rate";
    return false;
  }
  if (!dev::plat::makeDirectories(dirUtf8, err)) return false;
  if (!m.ring.allocated() && !m.ring.allocate(kRingFrames)) {
    if (err) *err = "out of memory (recording ring)";
    return false;
  }
  m.dir = dirUtf8;
  m.base = Recorder::sanitizeName(name);
  m.recFmt = fmt;
  m.fmt = sampleFormatOf(fmt);
  m.rate = sampleRate;
  m.inRate = sampleRate;
  m.rs.reset();
  m.dataBytes = 0;
  m.conv.assign(kChunkFrames * kChannels * 4, 0);
  m.dither.seed(0x2545F491u);
  std::string path;
  if (!m.openUnique(1, &path, err)) return false;
  if (!m.writeHeader(err)) {
    m.file.reset();
    return false;
  }
  {
    std::lock_guard<std::mutex> lk(m.sm);
    m.path = path;
    m.error.clear();
    m.part = 1;
  }
  m.framesCur = 0;
  m.rateCur = sampleRate;
  m.bytesCur = static_cast<uint64_t>(dev::wavHeaderBytes(m.fmt));
  m.dropped = 0;
  m.errorFlag = false;
  m.failing = false;
  m.ring.consumeTo(m.ring.writeIndex());  // anything left from a previous run
  m.startWriter();
  m.active.store(true, std::memory_order_release);
  if (pathOut) *pathOut = path;
  return true;
}

void Recorder::push(const float* l, const float* r, int frames) noexcept {
  Impl& m = *impl_;
  if (frames <= 0 || !m.active.load(std::memory_order_acquire)) return;
  if (!m.ring.push(l, r, static_cast<size_t>(frames))) m.dropped.fetch_add(static_cast<uint64_t>(frames), std::memory_order_relaxed);
}

bool Recorder::continueAtRate(int sampleRate, std::string* err) {
  Impl& m = *impl_;
  if (!m.active.load() || !m.file) {
    if (err) *err = "not recording";
    return false;
  }
  if (sampleRate < 8000 || sampleRate > 384000) {
    if (err) *err = "invalid sample rate";
    return false;
  }
  // The audio is stopped while the device is re-prepared: what the ring
  // holds is the old rate's audio, written (resampled if need be) by the
  // writer as it stops; then the old resampler's tail.
  m.stopWriter();
  if (!m.file) {  // the writer failed meanwhile: the error is already reported
    if (err) *err = "recording stopped by a write error";
    return false;
  }
  std::string why;
  if (!m.flushResampler(&why)) {
    m.fail(why);
    if (err) *err = why;
    return false;
  }
  // The same file goes on at its own rate: the new device rate is resampled
  // to it on the writer thread (the user never loses part of a set to a
  // second file). Back at the file's rate: no resampler.
  m.inRate = sampleRate;
  m.rs.reset();
  if (sampleRate != m.rate) m.rs = std::make_unique<Resampler>(sampleRate, m.rate, kChannels);
  m.startWriter();
  return true;
}

RecStatus Recorder::stop() {
  Impl& m = *impl_;
  m.active.store(false, std::memory_order_release);
  m.stopWriter();   // drains what the ring holds
  if (m.file) {     // (null when the writer already finalized after an error)
    std::string why;
    if (!m.flushResampler(&why)) m.fail(why);
  }
  m.rs.reset();
  m.finalizeFile(); // no-op when the writer (or the flush) already finalized after an error
  return status();
}

RecStatus Recorder::status() const {
  const Impl& m = *impl_;
  RecStatus s;
  {
    std::lock_guard<std::mutex> lk(m.sm);
    // (inside the lock: a write error is either not published yet, and the
    // recording still shows active, or published with its error)
    s.active = m.active.load(std::memory_order_acquire) || m.failing.load(std::memory_order_acquire);
    s.path = m.path;
    s.part = m.part;
    s.error = m.error;
  }
  s.seconds = m.seconds();
  s.bytes = m.bytesCur.load(std::memory_order_relaxed);
  s.droppedFrames = m.dropped.load(std::memory_order_relaxed);
  return s;
}

bool Recorder::active() const noexcept { return impl_->active.load(std::memory_order_acquire); }

bool Recorder::takeError() noexcept { return impl_->errorFlag.exchange(false, std::memory_order_acq_rel); }

std::vector<RecFileInfo> Recorder::listRecordings(const std::string& dirUtf8, bool repair) {
  std::vector<RecFileInfo> out;
  if (dirUtf8.empty()) return out;
  std::vector<std::string> names = dev::plat::listFiles(dirUtf8);
  std::sort(names.begin(), names.end());
  for (const std::string& name : names) {
    if (!endsWithWav(name)) continue;
    std::string p = dirUtf8;
    if (!p.empty() && p.back() != '/' && p.back() != '\\') p += dev::plat::pathSeparator();
    p += name;
    bool writable = false;
    std::unique_ptr<dev::plat::File> f;
    if (repair) {
      f = dev::plat::openFile(p, dev::plat::OpenMode::ReadWrite, nullptr);
      writable = f != nullptr;  // fails for a file being recorded (shared for reading only)
    }
    if (!f) f = dev::plat::openFile(p, dev::plat::OpenMode::ReadOnly, nullptr);
    if (!f) continue;
    const uint64_t size = f->size();
    std::vector<uint8_t> head(static_cast<size_t>(std::min<uint64_t>(size, 65536)));
    size_t got = 0;
    if (head.empty() || !f->readAt(0, head.data(), head.size(), &got)) continue;
    dev::WavInfo wi;
    if (!dev::parseWavHeader(head.data(), got, wi, nullptr)) continue;
    std::vector<dev::WavPatch> patches;
    uint64_t dataBytes = wi.dataBytes;
    const bool plan = dev::wavRepairPlan(wi, size, patches, &dataBytes);
    RecFileInfo info;
    info.path = p;
    info.bytes = size;
    if (plan && !patches.empty() && writable) {
      bool ok = true;
      for (const dev::WavPatch& w : patches) ok = ok && f->writeAt(w.offset, w.bytes.data(), w.bytes.size());
      ok = ok && f->flush();
      info.repaired = ok;
    }
    const double bytesPerSec = static_cast<double>(wi.sampleRate) * wi.blockAlign;
    info.seconds = bytesPerSec > 0 ? static_cast<double>(dataBytes) / bytesPerSec : 0.0;
    out.push_back(std::move(info));
  }
  return out;
}

std::string Recorder::defaultName() {
  const std::time_t now = std::time(nullptr);
  std::tm tmv{};
#ifdef _WIN32
  localtime_s(&tmv, &now);
#else
  localtime_r(&now, &tmv);
#endif
  char buf[64];
  std::strftime(buf, sizeof(buf), "OpenMix %Y-%m-%d %Hh%M", &tmv);
  return buf;
}

}  // namespace om
