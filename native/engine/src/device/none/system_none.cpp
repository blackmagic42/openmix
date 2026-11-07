// Stand-ins of the device backend where none is built yet (owner: device,
// library om_device_none): portable builds (OM_PORTABLE_ONLY, macOS / Linux
// CI). No system device (the core stays on the NULL device), no endpoint,
// no notifications, thread policy as no-ops; the NULL pacer sleeps on a
// condition variable; the recorder's files go through std::filesystem and
// fstream (UTF-8 paths, also non-ASCII ones on Windows). Everything lives in
// this one translation unit on purpose: om_device (portable) calls the
// platform seam, and with single-pass linkers the seam is pulled in together
// with createSystemDevice(), which every user of the device layer
// references. CoreAudio / miniaudio replace this later. SPEC.md §1, §18.5.
#include <chrono>
#include <condition_variable>
#include <filesystem>
#include <fstream>
#include <mutex>

#include "../platform.h"
#include "om/device.h"

namespace om {

std::unique_ptr<AudioDevice> createSystemDevice() { return nullptr; }

std::unique_ptr<DeviceWatcher> createDeviceWatcher(DeviceEventFn, std::string* err) {
  if (err) *err = "no audio backend in this build";
  return nullptr;
}

std::vector<DeviceInfo> enumerateOutputDevices(std::string* err) {
  if (err) *err = "no audio backend in this build";
  return {};
}

bool deviceApiAvailable(std::string* err) {
  if (err) *err = "no audio backend in this build";
  return false;
}

void* promoteAudioThread(const char*, std::string*) { return nullptr; }
void demoteAudioThread(void*) {}
void raiseServiceThreadPriority() noexcept {}
bool disableProcessPowerThrottling(std::string*) { return true; }

bool queryAudioThreadPolicy(void*, ThreadPolicyInfo& out) {
  out = ThreadPolicyInfo();  // supported = false: nothing to verify here
  return true;
}

bool queryProcessPowerThrottling(bool* throttlingOff, std::string* err) {
  if (throttlingOff) *throttlingOff = false;
  if (err) *err = "no power throttling in this build";
  return false;
}

namespace dev {
namespace plat {

namespace fs = std::filesystem;

namespace {

fs::path toPath(const std::string& utf8) {
  return fs::path(std::u8string(reinterpret_cast<const char8_t*>(utf8.data()), utf8.size()));
}

std::string fromPath(const fs::path& p) {
  const std::u8string s = p.u8string();
  return std::string(reinterpret_cast<const char*>(s.data()), s.size());
}

class SleepTimer final : public PacerTimer {
 public:
  bool waitUntil(EngineTime t) noexcept override {
    const double ahead = t - EngineClock::now();
    std::unique_lock<std::mutex> lk(m_);
    if (ahead > 0) {
      const auto deadline = std::chrono::steady_clock::now() +
                            std::chrono::duration_cast<std::chrono::steady_clock::duration>(std::chrono::duration<double>(ahead));
      cv_.wait_until(lk, deadline, [&] { return woken_; });
    }
    if (woken_) {
      woken_ = false;
      return false;
    }
    return true;
  }
  void wake() noexcept override {
    {
      std::lock_guard<std::mutex> lk(m_);
      woken_ = true;
    }
    cv_.notify_all();
  }
  const char* kind() const noexcept override { return "sleep"; }

 private:
  std::mutex m_;
  std::condition_variable cv_;
  bool woken_ = false;
};

class StdFile final : public File {
 public:
  StdFile(std::fstream f, uint64_t end) : f_(std::move(f)), end_(end) {}
  bool append(const void* p, size_t n) noexcept override {
    if (!seekWrite(end_)) return false;
    f_.write(static_cast<const char*>(p), static_cast<std::streamsize>(n));
    if (!f_) return setErr("write failed");
    end_ += n;
    return true;
  }
  bool writeAt(uint64_t off, const void* p, size_t n) noexcept override {
    if (!seekWrite(off)) return false;
    f_.write(static_cast<const char*>(p), static_cast<std::streamsize>(n));
    if (!f_) return setErr("write failed");
    if (off + n > end_) end_ = off + n;
    // A positioned write is a header patch (once a second): hand everything
    // buffered so far to the OS, so the file is readable while recording.
    f_.flush();
    return f_ ? true : setErr("flush failed");
  }
  bool readAt(uint64_t off, void* p, size_t n, size_t* got) noexcept override {
    f_.clear();
    f_.seekg(static_cast<std::streamoff>(off));
    f_.read(static_cast<char*>(p), static_cast<std::streamsize>(n));
    const std::streamsize g = f_.gcount();
    if (got) *got = g > 0 ? static_cast<size_t>(g) : 0;
    f_.clear();
    return g > 0;
  }
  bool flush() noexcept override {
    f_.flush();
    return f_ ? true : setErr("flush failed");
  }
  uint64_t size() noexcept override { return end_; }
  std::string lastError() const override { return err_; }

 private:
  bool seekWrite(uint64_t off) {
    f_.clear();
    f_.seekp(static_cast<std::streamoff>(off));
    return f_ ? true : setErr("seek failed");
  }
  bool setErr(const char* what) {
    err_ = what;
    return false;
  }
  std::fstream f_;
  uint64_t end_ = 0;
  std::string err_;
};

}  // namespace

std::unique_ptr<PacerTimer> makePacerTimer() { return std::make_unique<SleepTimer>(); }

std::unique_ptr<File> openFile(const std::string& pathUtf8, OpenMode mode, std::string* err, bool* exists) {
  if (exists) *exists = false;
  const fs::path p = toPath(pathUtf8);
  std::error_code ec;
  if (mode == OpenMode::CreateNew) {
    if (fs::exists(p, ec)) {
      if (exists) *exists = true;
      if (err) *err = "file exists";
      return nullptr;
    }
    std::ofstream create(p, std::ios::binary | std::ios::out);
    if (!create) {
      if (err) *err = "cannot create " + pathUtf8;
      return nullptr;
    }
    create.close();
  }
  std::ios::openmode om = std::ios::binary | std::ios::in;
  if (mode != OpenMode::ReadOnly) om |= std::ios::out;
  std::fstream f(p, om);
  if (!f) {
    if (err) *err = "cannot open " + pathUtf8;
    return nullptr;
  }
  const uint64_t size = fs::file_size(p, ec);
  return std::make_unique<StdFile>(std::move(f), ec ? 0 : size);
}

bool makeDirectories(const std::string& dirUtf8, std::string* err) {
  std::error_code ec;
  const fs::path p = toPath(dirUtf8);
  if (fs::is_directory(p, ec)) return true;
  fs::create_directories(p, ec);
  if (ec && !fs::is_directory(p)) {
    if (err) *err = "cannot create " + dirUtf8 + ": " + ec.message();
    return false;
  }
  return true;
}

bool pathExists(const std::string& pathUtf8) {
  std::error_code ec;
  return fs::exists(toPath(pathUtf8), ec);
}

std::vector<std::string> listFiles(const std::string& dirUtf8) {
  std::vector<std::string> out;
  std::error_code ec;
  for (fs::directory_iterator it(toPath(dirUtf8), ec), end; !ec && it != end; it.increment(ec)) {
    if (it->is_regular_file(ec)) out.push_back(fromPath(it->path().filename()));
  }
  return out;
}

char pathSeparator() noexcept {
#ifdef _WIN32
  return '\\';
#else
  return '/';
#endif
}

}  // namespace plat
}  // namespace dev

}  // namespace om
