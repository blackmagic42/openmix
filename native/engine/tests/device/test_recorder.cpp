// Tests of the mix recorder (owner: device): WAV 24-bit / 16-bit / float
// headers and the RF64 + ds64 layout past 4 GiB, the repair plan, name
// sanitizing, a file readable while it is being recorded (header patched
// every second), push() allocation-free inside rt::Scope, dropped frames
// when the writer stalls, a non-ASCII folder (CreateFileW from UTF-16 on
// Windows), a write error finalized and reported once, one file across a
// device rate change (resampled on the writer thread), never overwriting an existing file, TPDF
// dither, and listRecordings() repairing crash-left headers without ever
// deleting or truncating anything. Files go to a scratch folder under the
// system temp folder (removed by the test itself). SPEC.md §14.
#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <functional>
#include <iterator>
#include <set>
#include <string>
#include <thread>
#include <vector>

#include "../../src/device/test_hooks.h"
#include "../../src/device/wav.h"
#include "../om_test.h"
#include "om/recorder.h"
#include "om/rt.h"

using namespace om;
namespace fs = std::filesystem;

namespace {

std::string u8(const fs::path& p) {
  const std::u8string s = p.u8string();
  return std::string(reinterpret_cast<const char*>(s.data()), s.size());
}
fs::path fromU8(const std::string& s) {
  return fs::path(std::u8string(reinterpret_cast<const char8_t*>(s.data()), s.size()));
}

// The test's own scratch folder (removed at the end of the test).
struct TempDir {
  fs::path p;
  explicit TempDir(const std::string& tag) {
    static int counter = 0;
    const auto t = std::chrono::steady_clock::now().time_since_epoch().count();
    p = fs::temp_directory_path() / ("om-device-test-" + tag + "-" + std::to_string(t % 1000000007) + "-" +
                                     std::to_string(counter++));
    std::error_code ec;
    fs::create_directories(p, ec);
  }
  ~TempDir() {
    std::error_code ec;
    fs::remove_all(p, ec);
  }
  std::string str() const { return u8(p); }
};

// Resets the fault injection whatever the test outcome.
struct HookGuard {
  ~HookGuard() {
    dev::testhooks::recFailAfterBytes = -1;
    dev::testhooks::recWriterStall = false;
  }
};

std::vector<uint8_t> readBytes(const std::string& pathUtf8) {
  std::ifstream f(fromU8(pathUtf8), std::ios::binary);
  return std::vector<uint8_t>((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
}

void writeBytes(const fs::path& p, const std::string& bytes) {
  std::ofstream f(p, std::ios::binary);
  f.write(bytes.data(), static_cast<std::streamsize>(bytes.size()));
}

bool parseFile(const std::string& pathUtf8, dev::WavInfo& wi, size_t* size = nullptr) {
  const std::vector<uint8_t> b = readBytes(pathUtf8);
  if (size) *size = b.size();
  std::string err;
  return dev::parseWavHeader(b.data(), b.size(), wi, &err);
}

// Test signal: L = 0.5 sin(1 kHz), R = -0.3 sin(440 Hz).
float sigL(int64_t n, int rate) { return static_cast<float>(0.5 * std::sin(2 * 3.14159265358979 * 1000.0 * n / rate)); }
float sigR(int64_t n, int rate) { return static_cast<float>(-0.3 * std::sin(2 * 3.14159265358979 * 440.0 * n / rate)); }

void pushSignal(Recorder& rec, int64_t& pos, int64_t frames, int block, int rate) {
  std::vector<float> l(static_cast<size_t>(block)), r(static_cast<size_t>(block));
  for (int64_t done = 0; done < frames; done += block) {
    const int n = static_cast<int>(std::min<int64_t>(block, frames - done));
    for (int i = 0; i < n; i++) {
      l[static_cast<size_t>(i)] = sigL(pos + i, rate);
      r[static_cast<size_t>(i)] = sigR(pos + i, rate);
    }
    rec.push(l.data(), r.data(), n);
    pos += n;
  }
}

bool waitFor(const std::function<bool()>& pred, int ms) {
  const auto end = std::chrono::steady_clock::now() + std::chrono::milliseconds(ms);
  while (std::chrono::steady_clock::now() < end) {
    if (pred()) return true;
    std::this_thread::sleep_for(std::chrono::milliseconds(10));
  }
  return pred();
}

uint32_t u16at(const std::string& s, size_t o) {
  return static_cast<uint32_t>(static_cast<uint8_t>(s[o]) | (static_cast<uint8_t>(s[o + 1]) << 8));
}
uint32_t u32at(const std::string& s, size_t o) {
  uint32_t v = 0;
  for (int i = 3; i >= 0; i--) v = (v << 8) | static_cast<uint8_t>(s[o + i]);
  return v;
}
uint64_t u64at(const std::string& s, size_t o) { return u32at(s, o) | (static_cast<uint64_t>(u32at(s, o + 4)) << 32); }

bool parseStr(const std::string& h, dev::WavInfo& wi) {
  std::string err;
  return dev::parseWavHeader(reinterpret_cast<const uint8_t*>(h.data()), h.size(), wi, &err);
}

std::string applied(std::string h, const std::vector<dev::WavPatch>& patches) {
  for (const dev::WavPatch& p : patches) h.replace(static_cast<size_t>(p.offset), p.bytes.size(), p.bytes);
  return h;
}

bool endsWith(const std::string& s, const std::string& tail) {
  return s.size() >= tail.size() && s.compare(s.size() - tail.size(), tail.size(), tail) == 0;
}

}  // namespace

OM_TEST(recorder_wav_header_and_rf64) {
  const std::string h = wavHeader(RecFormat::S24, 48000, 2, 6000);
  OM_CHECK(h.size() == 80);
  OM_CHECK(h.compare(0, 4, "RIFF") == 0 && h.compare(8, 4, "WAVE") == 0 && h.compare(12, 4, "JUNK") == 0);
  OM_CHECK(u32at(h, 4) == 80 - 8 + 6000 && u32at(h, 16) == 28);
  OM_CHECK(h.compare(48, 4, "fmt ") == 0 && u32at(h, 52) == 16 && u16at(h, 56) == 1 && u16at(h, 58) == 2);
  OM_CHECK(u32at(h, 60) == 48000 && u32at(h, 64) == 288000 && u16at(h, 68) == 6 && u16at(h, 70) == 24);
  OM_CHECK(h.compare(72, 4, "data") == 0 && u32at(h, 76) == 6000);
  const std::string f = wavHeader(RecFormat::F32, 44100, 2, 8000);
  OM_CHECK(f.size() == 94 && u32at(f, 52) == 18 && u16at(f, 56) == 3 && u16at(f, 70) == 32);
  OM_CHECK(f.compare(74, 4, "fact") == 0 && u32at(f, 82) == 1000 && f.compare(86, 4, "data") == 0 && u32at(f, 90) == 8000);
  const std::string s16 = wavHeader(RecFormat::S16, 48000, 2, 400);
  OM_CHECK(s16.size() == 80 && u16at(s16, 68) == 4 && u16at(s16, 70) == 16);
  // RF64 past 4 GiB: ds64 takes the JUNK placeholder's place, 32-bit sizes are 0xFFFFFFFF.
  const uint64_t big = 6ull * 900000000ull;  // 5.4 GB
  const std::string r = wavHeader(RecFormat::S24, 48000, 2, big);
  OM_CHECK(r.size() == 80 && r.compare(0, 4, "RF64") == 0 && u32at(r, 4) == 0xFFFFFFFFu && r.compare(12, 4, "ds64") == 0);
  OM_CHECK(u64at(r, 20) == 72 + big && u64at(r, 28) == big && u64at(r, 36) == big / 6 && u32at(r, 44) == 0);
  OM_CHECK(u32at(r, 76) == 0xFFFFFFFFu);
  const uint64_t edge = 0xFFFFFFFFull - 72;  // the RIFF size field still fits
  OM_CHECK(wavHeader(RecFormat::S24, 48000, 2, edge).compare(0, 4, "RIFF") == 0);
  OM_CHECK(wavHeader(RecFormat::S24, 48000, 2, edge + 1).compare(0, 4, "RF64") == 0);
  // Parsing back.
  dev::WavInfo wi;
  OM_CHECK(parseStr(r, wi) && wi.rf64 && wi.dataBytes == big && wi.dataOffset == 80 && wi.ds64Pos == 12);
  OM_CHECK(wi.channels == 2 && wi.sampleRate == 48000 && wi.blockAlign == 6 && wi.formatTag == 1 && wi.riffSize == 72 + big);
  OM_CHECK(parseStr(f, wi) && wi.formatTag == 3 && wi.dataOffset == 94 && wi.factPos == 74 && wi.junkPos == 12);
  // Repair plans: a crash-left header (0 bytes) fixed to the file length,
  // rounded down to whole frames, equal to a clean header of that size.
  dev::WavInfo crash;
  OM_CHECK(parseStr(wavHeader(RecFormat::S24, 48000, 2, 0), crash));
  std::vector<dev::WavPatch> patches;
  uint64_t data = 0;
  OM_CHECK(dev::wavRepairPlan(crash, 80 + 6003, patches, &data) && data == 6000 && patches.size() == 2);
  OM_CHECK(applied(wavHeader(RecFormat::S24, 48000, 2, 0), patches) == wavHeader(RecFormat::S24, 48000, 2, 6000));
  OM_CHECK(dev::wavRepairPlan(crash, 80 + big, patches, &data) && data == big);  // RF64 through the placeholder
  OM_CHECK(applied(wavHeader(RecFormat::S24, 48000, 2, 0), patches) == wavHeader(RecFormat::S24, 48000, 2, big));
  dev::WavInfo good;
  OM_CHECK(parseStr(wavHeader(RecFormat::S24, 48000, 2, 6000), good));
  OM_CHECK(dev::wavRepairPlan(good, 6080, patches, &data) && patches.empty() && data == 6000);
  dev::WavInfo fc;
  OM_CHECK(parseStr(wavHeader(RecFormat::F32, 44100, 2, 0), fc));
  OM_CHECK(dev::wavRepairPlan(fc, 94 + 8000, patches, &data));
  OM_CHECK(applied(wavHeader(RecFormat::F32, 44100, 2, 0), patches) == wavHeader(RecFormat::F32, 44100, 2, 8000));
  // A big file without a placeholder cannot become RF64: left as it is.
  std::string plain = wavHeader(RecFormat::S24, 48000, 2, 0);
  plain.replace(12, 4, "LIST");
  dev::WavInfo noJunk;
  OM_CHECK(parseStr(plain, noJunk) && noJunk.junkPos == 0);
  OM_CHECK(!dev::wavRepairPlan(noJunk, 80 + big, patches, &data));
}

OM_TEST(recorder_names_sanitized) {
  OM_CHECK(Recorder::sanitizeName("a/b\\c:d*e?f\"g<h>i|j") == "a_b_c_d_e_f_g_h_i_j");
  OM_CHECK(Recorder::sanitizeName("  Friday set.WAV  ") == "Friday set");
  OM_CHECK(Recorder::sanitizeName("CON") == "_CON" && Recorder::sanitizeName("nul.txt") == "_nul.txt");
  OM_CHECK(Recorder::sanitizeName("").rfind("OpenMix ", 0) == 0);
  OM_CHECK(Recorder::sanitizeName("...").rfind("OpenMix ", 0) == 0);
  OM_CHECK(Recorder::sanitizeName("tab\there") == "tab here");
  OM_CHECK(Recorder::sanitizeName("bad\xFFutf8") == "bad_utf8");
  OM_CHECK(Recorder::sanitizeName("Été 日本語 ✓") == "Été 日本語 ✓");
  std::string longName;
  for (int i = 0; i < 150; i++) longName += "é";
  const std::string cut = Recorder::sanitizeName(longName);
  OM_CHECK(cut.size() == 200);  // 100 characters, never half of one
}

OM_TEST(recorder_wav24_readable_while_recording) {
  TempDir td("mid");
  Recorder rec;
  std::string path, err;
  OM_CHECK(rec.start(td.str(), "Mid test", RecFormat::S24, 48000, &path, &err));
  OM_CHECK(endsWith(path, "Mid test.wav"));
  int64_t pos = 0;
  pushSignal(rec, pos, 72000, 256, 48000);  // 1.5 s
  // The header is patched every second: the file is a valid WAV, with
  // audio, while the recording goes on.
  dev::WavInfo wi;
  OM_CHECK(waitFor([&] { return parseFile(path, wi) && wi.dataBytes >= 48000 * 6; }, 4000));
  OM_CHECK(rec.status().active);
  omtest::Wav w;
  OM_CHECK(omtest::readWav(path, w, &err));
  OM_CHECK(w.sampleRate == 48000 && w.channels == 2 && w.frames() >= 48000);
  double maxErr = 0;
  for (int64_t i = 0; i < w.frames(); i++) {
    maxErr = std::max(maxErr, std::fabs(w.samples[static_cast<size_t>(2 * i)] - static_cast<double>(sigL(i, 48000))));
    maxErr = std::max(maxErr, std::fabs(w.samples[static_cast<size_t>(2 * i + 1)] - static_cast<double>(sigR(i, 48000))));
  }
  OM_CHECK(maxErr < 1.6 / 8388608.0);  // TPDF (< 1 LSB) + rounding (0.5 LSB)
  pushSignal(rec, pos, 24000, 256, 48000);  // 0.5 s more
  const RecStatus st = rec.stop();
  OM_CHECK(!st.active && st.error.empty() && st.droppedFrames == 0 && st.path == path && st.part == 1);
  OM_CHECK_NEAR(st.seconds, pos / 48000.0, 1e-9);
  OM_CHECK(st.bytes == 80 + static_cast<uint64_t>(pos) * 6);
  OM_CHECK(omtest::readWav(path, w, &err) && w.frames() == pos);
  std::printf("[INFO] recorder wav24: %lld frames, max error %.2f LSB (24-bit)\n", static_cast<long long>(pos),
              maxErr * 8388608.0);
}

OM_TEST(recorder_push_is_realtime_safe) {
  TempDir td("rt");
  Recorder rec;
  std::vector<float> l(128, 0.1f), r(128, -0.1f);
  {
    rt::Scope rts;  // inactive: returns at once
    rec.push(l.data(), r.data(), 128);
  }
  std::string path, err;
  OM_CHECK(rec.start(td.str(), "rt", RecFormat::S24, 48000, &path, &err));
  const auto t0 = std::chrono::steady_clock::now();
  {
    rt::Scope rts;  // the runner fails the test on any allocation / free in here
    for (int i = 0; i < 2000; i++) rec.push(l.data(), r.data(), 128);
  }
  const double ns = std::chrono::duration<double, std::nano>(std::chrono::steady_clock::now() - t0).count() / 2000;
  const RecStatus st = rec.stop();
  OM_CHECK(st.droppedFrames == 0 && st.error.empty());
  OM_CHECK_NEAR(st.seconds, 2000 * 128 / 48000.0, 1e-9);
  std::printf("[INFO] recorder push: %.0f ns per 128-frame block (audio thread)\n", ns);
}

OM_TEST(recorder_counts_dropped_frames_when_the_writer_stalls) {
  HookGuard g;
  TempDir td("stall");
  dev::testhooks::recWriterStall = true;  // a disk that does not keep up
  Recorder rec;
  std::string path, err;
  OM_CHECK(rec.start(td.str(), "Stall", RecFormat::S24, 48000, &path, &err));
  int64_t pos = 0;
  pushSignal(rec, pos, 1200 * 480, 480, 48000);  // 12 s, more than the ring holds
  const uint64_t fit = (524288 / 480) * 480;     // whole blocks only
  const uint64_t expectDrop = 1200 * 480 - fit;
  OM_CHECK(rec.status().droppedFrames == expectDrop);
  dev::testhooks::recWriterStall = false;
  const RecStatus st = rec.stop();
  OM_CHECK(st.droppedFrames == expectDrop && st.error.empty());
  OM_CHECK_NEAR(st.seconds, fit / 48000.0, 1e-9);
  dev::WavInfo wi;
  size_t size = 0;
  OM_CHECK(parseFile(path, wi, &size) && wi.dataBytes == fit * 6 && size == 80 + fit * 6);
  std::printf("[INFO] recorder ring: %.2f s at 48 kHz (%.2f s at 192 kHz); %llu frames dropped as expected\n",
              524288 / 48000.0, 524288 / 192000.0, static_cast<unsigned long long>(st.droppedFrames));
}

OM_TEST(recorder_non_ascii_folder) {
  TempDir td("utf8");
  const std::string dir = td.str() + "/OpenMix tést 日本語 ✓/recordings";
  Recorder rec;
  std::string path, err;
  OM_CHECK(rec.start(dir, "Mix été ✓", RecFormat::S24, 48000, &path, &err));
  OM_CHECK(path.find("Mix été ✓.wav") != std::string::npos);
  int64_t pos = 0;
  pushSignal(rec, pos, 12000, 480, 48000);
  const RecStatus st = rec.stop();
  OM_CHECK(st.error.empty());
  OM_CHECK_NEAR(st.seconds, 0.25, 1e-9);
  OM_CHECK(fs::exists(fromU8(path)));
  dev::WavInfo wi;
  size_t size = 0;
  OM_CHECK(parseFile(path, wi, &size) && wi.dataBytes == 72000 && size == 80 + 72000);
  const std::vector<RecFileInfo> list = Recorder::listRecordings(dir, true);
  OM_CHECK(list.size() == 1 && list[0].path == path && !list[0].repaired);
  OM_CHECK_NEAR(list[0].seconds, 0.25, 1e-9);
}

OM_TEST(recorder_write_error_finalizes_and_reports_once) {
  HookGuard g;
  TempDir td("full");
  dev::testhooks::recFailAfterBytes = 48000 * 6 / 2;  // the disk is "full" after 0.5 s
  Recorder rec;
  std::string path, err;
  OM_CHECK(rec.start(td.str(), "Full", RecFormat::S24, 48000, &path, &err));
  int64_t pos = 0;
  pushSignal(rec, pos, 48000, 480, 48000);
  OM_CHECK(waitFor([&] { return !rec.status().active; }, 3000));
  OM_CHECK(rec.takeError());   // reported once (rec.status {active:false, error})
  OM_CHECK(!rec.takeError());
  RecStatus st = rec.status();
  OM_CHECK(!st.active && st.error.find("space") != std::string::npos);
  pushSignal(rec, pos, 4800, 480, 48000);  // after the error: ignored
  st = rec.stop();
  OM_CHECK(!st.error.empty());
  // What was written is a valid, finalized file.
  dev::WavInfo wi;
  size_t size = 0;
  OM_CHECK(parseFile(path, wi, &size));
  OM_CHECK(wi.dataBytes > 0 && wi.dataBytes <= 144000 && wi.dataBytes % 6 == 0 && size == 80 + wi.dataBytes);
}

// A device rate change during a recording (review round of 7 Nov 2026,
// process / IPC #1): the user never loses part of a set to a second file.
// The recording stays ONE file at its original rate; the writer thread
// resamples the new device rate to it, and back at the original rate the
// audio is written as is. Never overwrites an existing file either.
OM_TEST(recorder_rate_change_keeps_one_file_resampled_and_never_overwrites) {
  TempDir td("cont");
  {
    // A plain new name: still "<name>.wav" after the change, no "(2)" file.
    Recorder rec;
    std::string path, err;
    OM_CHECK(rec.start(td.str(), "Set", RecFormat::S24, 48000, &path, &err) && endsWith(path, "Set.wav"));
    int64_t pos = 0;
    pushSignal(rec, pos, 4800, 480, 48000);
    OM_CHECK(rec.continueAtRate(44100, &err));
    OM_CHECK(rec.status().path == path && rec.status().part == 1 && rec.status().active);
    rec.stop();
    OM_CHECK(!fs::exists(td.p / "Set (2).wav"));
  }
  // A file with the requested name exists: never overwritten.
  writeBytes(td.p / "Busy.wav", "not mine");
  Recorder rec;
  std::string path, err;
  OM_CHECK(rec.start(td.str(), "Busy", RecFormat::S24, 48000, &path, &err));
  OM_CHECK(endsWith(path, "Busy (2).wav"));
  // 0.3 s at 48 kHz, 0.2 s at 44.1 kHz, 0.1 s at 48 kHz again: the signal
  // is continuous in time (the same sines at each device rate)
  int64_t pos = 0;
  pushSignal(rec, pos, 14400, 480, 48000);
  OM_CHECK(rec.continueAtRate(44100, &err));
  RecStatus st = rec.status();
  OM_CHECK(st.active && st.part == 1 && st.path == path && st.error.empty());
  int64_t pos2 = 13230;  // 0.3 s at 44.1 kHz
  pushSignal(rec, pos2, 8820, 420, 44100);
  OM_CHECK(rec.continueAtRate(48000, &err));
  int64_t pos3 = 24000;  // 0.5 s at 48 kHz
  pushSignal(rec, pos3, 4800, 480, 48000);
  st = rec.stop();
  OM_CHECK(st.error.empty() && st.part == 1 && st.path == path && st.droppedFrames == 0);
  OM_CHECK_NEAR(st.seconds, 0.6, 1e-9);  // 14400 + ceil(8820 x 48000 / 44100) = 9600 + 4800 frames at 48 kHz
  const std::vector<uint8_t> mine = readBytes(u8(td.p / "Busy.wav"));
  OM_CHECK(std::string(mine.begin(), mine.end()) == "not mine");
  OM_CHECK(!fs::exists(td.p / "Busy (3).wav"));
  omtest::Wav a;
  OM_CHECK(omtest::readWav(path, a, &err) && a.sampleRate == 48000 && a.channels == 2 && a.frames() == 28800);
  // 48 kHz parts: the signal as pushed (24-bit + TPDF dither); the 44.1 kHz
  // part: the same sines at 48 kHz, time-aligned (the resampler's filter
  // edges at the two joins excepted: 200 frames each side)
  double worstExact = 0, worstResampled = 0;
  for (int64_t n = 0; n < a.frames(); n++) {
    const double l = a.samples[static_cast<size_t>(2 * n)], r = a.samples[static_cast<size_t>(2 * n + 1)];
    const double e = std::max(std::fabs(l - sigL(n, 48000)), std::fabs(r - sigR(n, 48000)));
    if (n < 14400 || n >= 24000) worstExact = std::max(worstExact, e);
    else if (n >= 14400 + 200 && n < 24000 - 200) worstResampled = std::max(worstResampled, e);
  }
  std::printf("  [info] one file across 48 -> 44.1 -> 48 kHz: %lld frames, worst error %.2e (48 kHz parts), "
              "%.2e (resampled part)\n",
              static_cast<long long>(a.frames()), worstExact, worstResampled);
  OM_CHECK(worstExact < 1e-6);       // 24-bit quantization + dither
  OM_CHECK(worstResampled < 1e-3);   // -60 dB at worst (Kaiser windowed sinc, 1 kHz / 440 Hz in the passband)
}

OM_TEST(recorder_lists_and_repairs_crash_left_files) {
  TempDir td("list");
  std::string audio(12000 * 6, '\0');
  for (size_t i = 0; i < audio.size(); i++) audio[i] = static_cast<char>((i * 7) & 0xFF);
  // Crash before the first header patch: the header still says 0 bytes.
  writeBytes(td.p / "crash.wav", wavHeader(RecFormat::S24, 48000, 2, 0) + audio);
  // A partial frame at the end.
  writeBytes(td.p / "odd.wav", wavHeader(RecFormat::S24, 48000, 2, 0) + audio.substr(0, 4800 * 6) + "xyz");
  // A clean recording.
  {
    Recorder rec;
    std::string path, err;
    OM_CHECK(rec.start(td.str(), "good", RecFormat::S24, 48000, &path, &err));
    int64_t pos = 0;
    pushSignal(rec, pos, 4800, 480, 48000);
    rec.stop();
  }
  writeBytes(td.p / "notes.txt", "hello");
  writeBytes(td.p / "garbage.wav", "this is not a wav file at all");
  std::vector<RecFileInfo> list = Recorder::listRecordings(td.str(), true);
  OM_CHECK(list.size() == 3);
  auto find = [&](const std::string& name) -> const RecFileInfo* {
    for (const RecFileInfo& f : list)
      if (endsWith(f.path, name)) return &f;
    return nullptr;
  };
  const RecFileInfo* crash = find("crash.wav");
  const RecFileInfo* odd = find("odd.wav");
  const RecFileInfo* good = find("good.wav");
  OM_CHECK(crash && odd && good);
  OM_CHECK(crash->repaired && crash->bytes == 80 + 72000);
  OM_CHECK_NEAR(crash->seconds, 0.25, 1e-9);
  OM_CHECK(odd->repaired && odd->bytes == 80 + 28800 + 3);  // never truncated
  OM_CHECK_NEAR(odd->seconds, 0.1, 1e-9);
  OM_CHECK(!good->repaired);
  OM_CHECK_NEAR(good->seconds, 0.1, 1e-9);
  dev::WavInfo wi;
  OM_CHECK(parseFile(crash->path, wi) && wi.dataBytes == 72000);
  omtest::Wav w;
  std::string err;
  OM_CHECK(omtest::readWav(crash->path, w, &err) && w.frames() == 12000);
  // Repaired once: the second listing finds consistent headers.
  list = Recorder::listRecordings(td.str(), true);
  OM_CHECK(list.size() == 3);
  for (const RecFileInfo& f : list) OM_CHECK(!f.repaired);
  // Nothing deleted.
  int files = 0;
  for (const auto& e : fs::directory_iterator(td.p)) files += e.is_regular_file() ? 1 : 0;
  OM_CHECK(files == 5);
  // Listing without repair reports the length but leaves the header alone.
  writeBytes(td.p / "crash2.wav", wavHeader(RecFormat::S24, 48000, 2, 0) + audio);
  list = Recorder::listRecordings(td.str(), false);
  const RecFileInfo* c2 = find("crash2.wav");
  OM_CHECK(c2 && !c2->repaired);
  OM_CHECK_NEAR(c2->seconds, 0.25, 1e-9);
  OM_CHECK(parseFile(c2->path, wi) && wi.dataBytes == 0);
}

OM_TEST(recorder_float_exact_and_16bit_tpdf) {
  TempDir td("fmt");
  std::string path, err;
  {
    Recorder rec;
    OM_CHECK(rec.start(td.str(), "float", RecFormat::F32, 48000, &path, &err));
    int64_t pos = 0;
    pushSignal(rec, pos, 4800, 480, 48000);
    OM_CHECK(rec.stop().error.empty());
    omtest::Wav w;
    OM_CHECK(omtest::readWav(path, w, &err) && w.frames() == 4800);
    bool exact = true;
    for (int64_t i = 0; i < 4800; i++)
      exact = exact && w.samples[static_cast<size_t>(2 * i)] == sigL(i, 48000) && w.samples[static_cast<size_t>(2 * i + 1)] == sigR(i, 48000);
    OM_CHECK(exact);
  }
  {
    // TPDF dither linearizes: a constant 0.25 LSB comes out as 0.25 LSB on
    // average (plain rounding would give 0), with +-1 LSB of noise.
    Recorder rec;
    OM_CHECK(rec.start(td.str(), "s16", RecFormat::S16, 48000, &path, &err));
    std::vector<float> l(480, 0.25f / 32768.0f), r(480, -0.25f / 32768.0f);
    for (int b = 0; b < 100; b++) rec.push(l.data(), r.data(), 480);
    OM_CHECK(rec.stop().error.empty());
    omtest::Wav w;
    OM_CHECK(omtest::readWav(path, w, &err) && w.frames() == 48000);
    double sumL = 0, sumR = 0;
    std::set<int> values;
    for (int64_t i = 0; i < w.frames(); i++) {
      sumL += w.samples[static_cast<size_t>(2 * i)] * 32768.0;
      sumR += w.samples[static_cast<size_t>(2 * i + 1)] * 32768.0;
      values.insert(static_cast<int>(std::lround(w.samples[static_cast<size_t>(2 * i)] * 32768.0)));
    }
    OM_CHECK_NEAR(sumL / 48000, 0.25, 0.03);
    OM_CHECK_NEAR(sumR / 48000, -0.25, 0.03);
    OM_CHECK(values.size() >= 2 && *values.begin() >= -1 && *values.rbegin() <= 1);
  }
}
