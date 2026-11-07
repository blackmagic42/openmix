// Runner of the engine's module tests + the global allocation hook (owner:
// host): every heap allocation is counted per thread (RtAllocGuard) and fed
// to om::rt::onAllocation, every free to om::rt::onDeallocation, so code
// running inside an om::rt::Scope (the audio callback, module render
// functions under test) is caught when it allocates OR frees. Also the
// golden-reference helpers (WAV reader, residual). Portable. SPEC.md §18.
#include <cstdlib>
#include <cstring>
#include <exception>
#include <fstream>
#include <iterator>
#include <new>

#ifdef _WIN32
#include <malloc.h>
#include <windows.h>
#endif
#ifdef _MSC_VER
#include <crtdbg.h>
#endif

#include "om/rt.h"
#include "om_test.h"

// ---------------------------------------------------------------------------
// Allocation counting (per thread) + real-time trap
// ---------------------------------------------------------------------------
namespace {
thread_local size_t tAllocations = 0;
const bool kTrapInstalled = (om::rt::detail::gTrapInstalled.store(true), true);

inline void counted(size_t n) noexcept {
  ++tAllocations;
  om::rt::onAllocation(n);
}

void* alignedAlloc(size_t n, size_t a) noexcept {
#ifdef _WIN32
  return _aligned_malloc(n ? n : 1, a);
#else
  void* p = nullptr;
  if (a < sizeof(void*)) a = sizeof(void*);
  return posix_memalign(&p, a, n ? n : 1) == 0 ? p : nullptr;
#endif
}
void alignedFree(void* p) noexcept {
#ifdef _WIN32
  _aligned_free(p);
#else
  std::free(p);
#endif
}
}  // namespace

void* operator new(size_t n) {
  counted(n);
  if (void* p = std::malloc(n ? n : 1)) return p;
  throw std::bad_alloc();
}
void* operator new[](size_t n) {
  counted(n);
  if (void* p = std::malloc(n ? n : 1)) return p;
  throw std::bad_alloc();
}
void* operator new(size_t n, const std::nothrow_t&) noexcept {
  counted(n);
  return std::malloc(n ? n : 1);
}
void* operator new[](size_t n, const std::nothrow_t&) noexcept {
  counted(n);
  return std::malloc(n ? n : 1);
}
void* operator new(size_t n, std::align_val_t a) {
  counted(n);
  if (void* p = alignedAlloc(n, static_cast<size_t>(a))) return p;
  throw std::bad_alloc();
}
void* operator new[](size_t n, std::align_val_t a) {
  counted(n);
  if (void* p = alignedAlloc(n, static_cast<size_t>(a))) return p;
  throw std::bad_alloc();
}
void operator delete(void* p) noexcept {
  om::rt::onDeallocation(p);
  std::free(p);
}
void operator delete[](void* p) noexcept {
  om::rt::onDeallocation(p);
  std::free(p);
}
void operator delete(void* p, size_t) noexcept {
  om::rt::onDeallocation(p);
  std::free(p);
}
void operator delete[](void* p, size_t) noexcept {
  om::rt::onDeallocation(p);
  std::free(p);
}
void operator delete(void* p, std::align_val_t) noexcept {
  om::rt::onDeallocation(p);
  alignedFree(p);
}
void operator delete[](void* p, std::align_val_t) noexcept {
  om::rt::onDeallocation(p);
  alignedFree(p);
}
void operator delete(void* p, size_t, std::align_val_t) noexcept {
  om::rt::onDeallocation(p);
  alignedFree(p);
}
void operator delete[](void* p, size_t, std::align_val_t) noexcept {
  om::rt::onDeallocation(p);
  alignedFree(p);
}

namespace omtest {

std::vector<TestCase>& registry() {
  static std::vector<TestCase> r;
  return r;
}

namespace {
std::string gTodo, gSkip, gFail;
}

void fail(const char* expr, const char* file, int line, const std::string& detail) {
  const char* base = std::strrchr(file, '\\');
  if (!base) base = std::strrchr(file, '/');
  gFail = std::string(expr) + " (" + (base ? base + 1 : file) + ":" + std::to_string(line) + ")";
  if (!detail.empty()) gFail += " - " + detail;
  throw FailSignal();
}

void todo(const std::string& what) {
  gTodo = what;
  throw TodoSignal();
}

void skip(const std::string& why) {
  gSkip = why;
  throw SkipSignal();
}

std::string envString(const char* name) {
#ifdef _MSC_VER
  char* v = nullptr;
  size_t len = 0;
  if (_dupenv_s(&v, &len, name) != 0 || !v) return std::string();
  std::string s(v);
  std::free(v);
  return s;
#else
  const char* v = std::getenv(name);
  return v ? std::string(v) : std::string();
#endif
}

bool envFlag(const char* name) { return envString(name) == "1"; }

RtAllocGuard::RtAllocGuard() : start_(tAllocations) {}
RtAllocGuard::~RtAllocGuard() = default;
size_t RtAllocGuard::count() const { return tAllocations - start_; }

// ---- golden references ------------------------------------------------------------
std::string goldenPath(const std::string& relative) {
  const std::string dir = envString("OM_GOLDEN_DIR");
  if (dir.empty()) return std::string();
  const char last = dir.back();
  return dir + ((last == '/' || last == '\\') ? "" : "/") + relative;
}

bool readWav(const std::string& path, Wav& out, std::string* err) {
  auto bad = [&](const char* why) {
    if (err) *err = path + ": " + why;
    return false;
  };
  std::ifstream f(path, std::ios::binary);
  if (!f) return bad("cannot open");
  std::vector<unsigned char> d((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
  auto u16 = [&](size_t o) { return static_cast<uint32_t>(d[o] | (d[o + 1] << 8)); };
  auto u32 = [&](size_t o) { return static_cast<uint32_t>(d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (uint32_t(d[o + 3]) << 24)); };
  if (d.size() < 12 || (std::memcmp(d.data(), "RIFF", 4) != 0 && std::memcmp(d.data(), "RF64", 4) != 0) ||
      std::memcmp(d.data() + 8, "WAVE", 4) != 0)
    return bad("not a WAV file");
  int fmtTag = 0, bits = 0;
  size_t dataOff = 0, dataLen = 0;
  uint64_t ds64Data = 0;
  for (size_t o = 12; o + 8 <= d.size();) {
    const uint32_t len = u32(o + 4);
    if (std::memcmp(d.data() + o, "fmt ", 4) == 0 && o + 24 <= d.size()) {
      fmtTag = static_cast<int>(u16(o + 8));
      out.channels = static_cast<int>(u16(o + 10));
      out.sampleRate = static_cast<int>(u32(o + 12));
      bits = static_cast<int>(u16(o + 22));
      if (fmtTag == 0xFFFE && o + 34 <= d.size()) fmtTag = static_cast<int>(u16(o + 32));  // WAVE_FORMAT_EXTENSIBLE
    } else if (std::memcmp(d.data() + o, "ds64", 4) == 0 && o + 24 <= d.size()) {
      ds64Data = static_cast<uint64_t>(u32(o + 16)) | (static_cast<uint64_t>(u32(o + 20)) << 32);
    } else if (std::memcmp(d.data() + o, "data", 4) == 0) {
      dataOff = o + 8;
      dataLen = (len == 0xFFFFFFFFu && ds64Data) ? static_cast<size_t>(ds64Data) : len;
      break;
    }
    o += 8 + len + (len & 1);
  }
  if (!dataOff || out.channels <= 0) return bad("no fmt / data chunk");
  if (dataOff + dataLen > d.size()) dataLen = d.size() - dataOff;
  const int bytes = bits / 8;
  if (bytes <= 0) return bad("bad sample size");
  const size_t n = dataLen / static_cast<size_t>(bytes);
  out.samples.resize(n);
  for (size_t i = 0; i < n; i++) {
    const unsigned char* p = d.data() + dataOff + i * static_cast<size_t>(bytes);
    if (fmtTag == 3 && bits == 32) {
      float v;
      std::memcpy(&v, p, 4);
      out.samples[i] = v;
    } else if (fmtTag == 1 && bits == 16) {
      out.samples[i] = static_cast<int16_t>(p[0] | (p[1] << 8)) / 32768.0f;
    } else if (fmtTag == 1 && bits == 24) {
      const int32_t v = static_cast<int32_t>((uint32_t(p[0]) << 8) | (uint32_t(p[1]) << 16) | (uint32_t(p[2]) << 24)) >> 8;
      out.samples[i] = v / 8388608.0f;
    } else if (fmtTag == 1 && bits == 32) {
      int32_t v;
      std::memcpy(&v, p, 4);
      out.samples[i] = static_cast<float>(v / 2147483648.0);
    } else {
      return bad("unsupported sample format");
    }
  }
  return true;
}

double residualDb(const float* a, const float* b, size_t n) {
  double m = 0;
  for (size_t i = 0; i < n; i++) {
    const double e = std::fabs(static_cast<double>(a[i]) - static_cast<double>(b[i]));
    if (e > m) m = e;
  }
  return m > 0 ? 20.0 * std::log10(m) : -400.0;
}

}  // namespace omtest

int main(int argc, char** argv) {
  using namespace omtest;
  (void)kTrapInstalled;
#ifdef _WIN32
  // Shared PC, unattended runs: a crash or a failed CRT check must end the
  // test with an error, never open a dialog that waits for a click.
  SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX | SEM_NOOPENFILEERRORBOX);
#endif
#ifdef _MSC_VER
  for (int type : {_CRT_WARN, _CRT_ERROR, _CRT_ASSERT}) {
    _CrtSetReportMode(type, _CRTDBG_MODE_FILE);
    _CrtSetReportFile(type, _CRTDBG_FILE_STDERR);
    (void)type;  // Release: the _CrtSet* calls compile out (C4189)
  }
  _set_abort_behavior(0, _WRITE_ABORT_MSG | _CALL_REPORTFAULT);
#endif
  const char* filter = argc > 1 ? argv[1] : nullptr;
  const bool strict = envFlag("OM_TEST_STRICT");
  int pass = 0, failed = 0, todos = 0, skipped = 0;
  for (const TestCase& t : registry()) {
    if (filter && !std::strstr(t.name, filter)) continue;
    om::rt::resetViolations();
    try {
      t.fn();
      if (om::rt::violations() != 0) {
        std::printf("[FAIL] %s: %llu allocation(s) and %llu free(s) inside an rt::Scope\n", t.name,
                    static_cast<unsigned long long>(om::rt::allocViolations()),
                    static_cast<unsigned long long>(om::rt::freeViolations()));
        failed++;
        continue;
      }
      std::printf("[PASS] %s\n", t.name);
      pass++;
    } catch (const FailSignal&) {
      std::printf("[FAIL] %s: %s\n", t.name, gFail.c_str());
      failed++;
    } catch (const TodoSignal&) {
      std::printf("[TODO] %s: %s\n", t.name, gTodo.c_str());
      todos++;
    } catch (const SkipSignal&) {
      std::printf("[SKIP] %s: %s\n", t.name, gSkip.c_str());
      skipped++;
    } catch (const std::exception& e) {
      std::printf("[FAIL] %s: exception: %s\n", t.name, e.what());
      failed++;
    } catch (...) {
      std::printf("[FAIL] %s: unknown exception\n", t.name);
      failed++;
    }
  }
  std::printf("\n%d passed, %d failed, %d todo, %d skipped%s\n", pass, failed, todos, skipped,
              strict ? " (strict: todo counts as failure)" : "");
  std::fflush(stdout);
  return (failed > 0 || (strict && todos > 0)) ? 1 : 0;
}
