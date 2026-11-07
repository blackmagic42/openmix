// Platform seam of the portable device code (owner: device, private
// header): what the NULL device's pacer and the recorder need from the OS,
// implemented in win/platform_win.cpp (high-resolution waitable timer,
// CreateFileW from UTF-16 paths) and in none/system_none.cpp (a plain
// sleep, std::filesystem + fstream). Paths are UTF-8 everywhere in the API.
// SPEC.md §1, §8.6, §14.
#pragma once

#include <cstddef>
#include <cstdint>
#include <memory>
#include <string>
#include <vector>

#include "om/common.h"

namespace om {
namespace dev {
namespace plat {

// Sleeps until an engine time (EngineClock), interruptible by wake().
class PacerTimer {
 public:
  virtual ~PacerTimer() = default;
  // Returns false when woken (wake()) before the time; true at the time.
  virtual bool waitUntil(EngineTime t) noexcept = 0;
  virtual void wake() noexcept = 0;     // any thread
  virtual const char* kind() const noexcept = 0;
};
std::unique_ptr<PacerTimer> makePacerTimer();

// A file opened for the recorder (one thread at a time).
class File {
 public:
  virtual ~File() = default;
  virtual bool append(const void* p, size_t n) noexcept = 0;               // at the end of what was written
  virtual bool writeAt(uint64_t off, const void* p, size_t n) noexcept = 0;  // does not move the end
  virtual bool readAt(uint64_t off, void* p, size_t n, size_t* got) noexcept = 0;
  virtual bool flush() noexcept = 0;
  virtual uint64_t size() noexcept = 0;
  virtual std::string lastError() const = 0;
};
enum class OpenMode : uint8_t {
  CreateNew,      // fails when the file exists (never overwrites); readers may open it while it is written
  ReadWrite,      // existing file (header repair)
  ReadOnly
};
// *exists (optional) is set when CreateNew failed because the file exists.
std::unique_ptr<File> openFile(const std::string& pathUtf8, OpenMode mode, std::string* err, bool* exists = nullptr);
bool makeDirectories(const std::string& dirUtf8, std::string* err);
bool pathExists(const std::string& pathUtf8);
// Names (UTF-8) of the regular files in a folder (not recursive).
std::vector<std::string> listFiles(const std::string& dirUtf8);
char pathSeparator() noexcept;  // '\\' on Windows, '/' elsewhere

}  // namespace plat
}  // namespace dev
}  // namespace om
