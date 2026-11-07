// Windows side of the portable device code's platform seam (owner: device,
// library om_device_wasapi): the NULL pacer's high-resolution waitable timer
// (CREATE_WAITABLE_TIMER_HIGH_RESOLUTION, ~0.5 ms, no timeBeginPeriod; a
// plain waitable timer on older systems) and the recorder's files, opened
// with CreateFileW from the UTF-16 path (profiles with non-ASCII names),
// "create new" so nothing is ever overwritten, shared for reading so a
// recording can be read (or copied) while it is written. SPEC.md §8.6, §14.
#include <windows.h>

#include "../platform.h"
#include "com_util.h"

#ifndef CREATE_WAITABLE_TIMER_HIGH_RESOLUTION
#define CREATE_WAITABLE_TIMER_HIGH_RESOLUTION 0x00000002
#endif

namespace om {
namespace dev {
namespace plat {

namespace {

class WinTimer final : public PacerTimer {
 public:
  WinTimer() {
    timer_ = CreateWaitableTimerExW(nullptr, nullptr, CREATE_WAITABLE_TIMER_HIGH_RESOLUTION, TIMER_ALL_ACCESS);
    if (!timer_) {
      timer_ = CreateWaitableTimerExW(nullptr, nullptr, 0, TIMER_ALL_ACCESS);
      kind_ = "waitable-timer";
    }
    wake_ = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  }
  ~WinTimer() override {
    if (timer_) CloseHandle(timer_);
    if (wake_) CloseHandle(wake_);
  }
  bool ok() const { return timer_ && wake_; }
  bool waitUntil(EngineTime t) noexcept override {
    const double ahead = t - EngineClock::now();
    if (ahead <= 0) return WaitForSingleObject(wake_, 0) != WAIT_OBJECT_0;
    LARGE_INTEGER due;
    due.QuadPart = -static_cast<LONGLONG>(ahead * 1e7);  // relative, 100-ns units
    if (due.QuadPart == 0) due.QuadPart = -1;
    if (!SetWaitableTimer(timer_, &due, 0, nullptr, nullptr, FALSE)) {
      Sleep(static_cast<DWORD>(ahead * 1000.0));
      return true;
    }
    HANDLE h[2] = {wake_, timer_};
    const DWORD w = WaitForMultipleObjects(2, h, FALSE, INFINITE);
    if (w == WAIT_OBJECT_0) {
      CancelWaitableTimer(timer_);
      return false;
    }
    return true;
  }
  void wake() noexcept override { SetEvent(wake_); }
  const char* kind() const noexcept override { return kind_; }

 private:
  HANDLE timer_ = nullptr;
  HANDLE wake_ = nullptr;
  const char* kind_ = "waitable-timer-hr";
};

// "/" -> "\", and the \\?\ prefix for long absolute paths.
std::wstring nativePath(const std::string& utf8Path) {
  std::wstring w = win::utf16(utf8Path);
  for (wchar_t& c : w)
    if (c == L'/') c = L'\\';
  const bool absDrive = w.size() > 2 && w[1] == L':' && w[2] == L'\\';
  if (absDrive && w.size() >= MAX_PATH - 12 && w.rfind(L"\\\\?\\", 0) != 0) w = L"\\\\?\\" + w;
  return w;
}

class WinFile final : public File {
 public:
  WinFile(HANDLE h, uint64_t end) : h_(h), end_(end) {}
  ~WinFile() override { CloseHandle(h_); }
  bool append(const void* p, size_t n) noexcept override {
    if (!writeAt(end_, p, n)) return false;
    return true;
  }
  bool writeAt(uint64_t off, const void* p, size_t n) noexcept override {
    const auto* b = static_cast<const uint8_t*>(p);
    while (n > 0) {
      const DWORD chunk = static_cast<DWORD>(n > (1u << 30) ? (1u << 30) : n);
      OVERLAPPED ov{};
      ov.Offset = static_cast<DWORD>(off & 0xFFFFFFFFu);
      ov.OffsetHigh = static_cast<DWORD>(off >> 32);
      DWORD wr = 0;
      if (!WriteFile(h_, b, chunk, &wr, &ov)) {
        err_ = GetLastError();
        return false;
      }
      if (wr != chunk) {
        err_ = ERROR_DISK_FULL;
        return false;
      }
      off += wr;
      b += wr;
      n -= wr;
      if (off > end_) end_ = off;
    }
    return true;
  }
  bool readAt(uint64_t off, void* p, size_t n, size_t* got) noexcept override {
    OVERLAPPED ov{};
    ov.Offset = static_cast<DWORD>(off & 0xFFFFFFFFu);
    ov.OffsetHigh = static_cast<DWORD>(off >> 32);
    DWORD rd = 0;
    const BOOL ok = ReadFile(h_, p, static_cast<DWORD>(n), &rd, &ov);
    if (got) *got = rd;
    if (!ok) err_ = GetLastError();
    return ok && rd > 0;
  }
  bool flush() noexcept override {
    if (!FlushFileBuffers(h_)) {
      err_ = GetLastError();
      return false;
    }
    return true;
  }
  uint64_t size() noexcept override {
    LARGE_INTEGER s;
    if (GetFileSizeEx(h_, &s)) return static_cast<uint64_t>(s.QuadPart);
    return end_;
  }
  std::string lastError() const override { return win::win32ErrorText(err_); }

 private:
  HANDLE h_;
  uint64_t end_;
  DWORD err_ = 0;
};

}  // namespace

std::unique_ptr<PacerTimer> makePacerTimer() {
  auto t = std::make_unique<WinTimer>();
  if (!t->ok()) return nullptr;
  return t;
}

std::unique_ptr<File> openFile(const std::string& pathUtf8, OpenMode mode, std::string* err, bool* exists) {
  if (exists) *exists = false;
  const std::wstring w = nativePath(pathUtf8);
  if (w.empty()) {
    if (err) *err = "invalid path";
    return nullptr;
  }
  DWORD access = GENERIC_READ;
  DWORD share = FILE_SHARE_READ;
  DWORD disp = OPEN_EXISTING;
  switch (mode) {
    case OpenMode::CreateNew:
      access |= GENERIC_WRITE;
      disp = CREATE_NEW;  // never overwrites
      break;
    case OpenMode::ReadWrite:
      access |= GENERIC_WRITE;
      break;
    case OpenMode::ReadOnly:
      share |= FILE_SHARE_WRITE;  // a recording being written can be read
      break;
  }
  HANDLE h = CreateFileW(w.c_str(), access, share, nullptr, disp, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (h == INVALID_HANDLE_VALUE) {
    const DWORD e = GetLastError();
    if (exists && (e == ERROR_FILE_EXISTS || e == ERROR_ALREADY_EXISTS)) *exists = true;
    if (err) *err = win::win32ErrorText(e) + ": " + pathUtf8;
    return nullptr;
  }
  LARGE_INTEGER s{};
  GetFileSizeEx(h, &s);
  return std::make_unique<WinFile>(h, static_cast<uint64_t>(s.QuadPart));
}

bool makeDirectories(const std::string& dirUtf8, std::string* err) {
  std::wstring w = nativePath(dirUtf8);
  while (w.size() > 3 && w.back() == L'\\') w.pop_back();
  if (w.empty()) {
    if (err) *err = "invalid folder";
    return false;
  }
  const DWORD a = GetFileAttributesW(w.c_str());
  if (a != INVALID_FILE_ATTRIBUTES && (a & FILE_ATTRIBUTE_DIRECTORY)) return true;
  // Create every missing level after the root ("C:\", "\\server\share\", "\\?\C:\").
  size_t start = 0;
  if (w.rfind(L"\\\\?\\", 0) == 0) start = 4;
  if (w.size() > start + 2 && w[start + 1] == L':') {
    start += 3;
  } else if (w.rfind(L"\\\\", 0) == 0) {
    const size_t server = w.find(L'\\', 2);
    const size_t share = server == std::wstring::npos ? server : w.find(L'\\', server + 1);
    start = share == std::wstring::npos ? w.size() : share + 1;
  }
  for (size_t pos = w.find(L'\\', start);; pos = w.find(L'\\', pos + 1)) {
    const std::wstring part = pos == std::wstring::npos ? w : w.substr(0, pos);
    if (!part.empty() && !CreateDirectoryW(part.c_str(), nullptr)) {
      const DWORD e = GetLastError();
      if (e != ERROR_ALREADY_EXISTS && e != ERROR_ACCESS_DENIED) {
        if (err) *err = win::win32ErrorText(e) + ": " + dirUtf8;
        return false;
      }
    }
    if (pos == std::wstring::npos) break;
  }
  const DWORD b = GetFileAttributesW(w.c_str());
  if (b == INVALID_FILE_ATTRIBUTES || !(b & FILE_ATTRIBUTE_DIRECTORY)) {
    if (err) *err = "cannot create " + dirUtf8;
    return false;
  }
  return true;
}

bool pathExists(const std::string& pathUtf8) {
  return GetFileAttributesW(nativePath(pathUtf8).c_str()) != INVALID_FILE_ATTRIBUTES;
}

std::vector<std::string> listFiles(const std::string& dirUtf8) {
  std::vector<std::string> out;
  std::wstring w = nativePath(dirUtf8);
  if (w.empty()) return out;
  if (w.back() != L'\\') w += L'\\';
  w += L'*';
  WIN32_FIND_DATAW fd;
  HANDLE h = FindFirstFileExW(w.c_str(), FindExInfoBasic, &fd, FindExSearchNameMatch, nullptr, 0);
  if (h == INVALID_HANDLE_VALUE) return out;
  do {
    if (!(fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY)) out.push_back(win::utf8(fd.cFileName));
  } while (FindNextFileW(h, &fd));
  FindClose(h);
  return out;
}

char pathSeparator() noexcept { return '\\'; }

}  // namespace plat
}  // namespace dev
}  // namespace om
