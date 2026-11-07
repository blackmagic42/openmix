// Minimal test framework of the engine's module tests (owner: host; frozen
// once the modules start): no download, no external library. Each test
// executable = om_test_main.cpp + the module's tests/<module>/*.cpp, linked
// with its module only (and om_json).
//
//   OM_TEST(name) { OM_CHECK(x == 1); OM_CHECK_NEAR(a, b, 1e-6); }
//   OM_TODO("what remains to implement");   // pending acceptance test
//   OM_SKIP("why");                         // not applicable here
//   { om::rt::Scope rt; deck.render(...); } // any allocation OR free inside fails the test
//   omtest::RtAllocGuard g;  ...  OM_CHECK(g.count() == 0);  // per-thread count
//   Golden renders of the Web engine (SPEC.md §18.4), when OM_GOLDEN_DIR is set:
//     std::string p = omtest::goldenPath("mixer/eq_low_sweep.wav");   // "" -> OM_SKIP
//     omtest::Wav w; omtest::readWav(p, w, &err);
//     OM_CHECK(omtest::residualDb(ours.data(), w.samples.data(), n) < -80.0);
//
// Exit code 1 on any failure. With OM_TEST_STRICT=1 in the environment, TODO
// tests also fail (used at integration time). argv[1] = substring filter.
// Tests are SILENT by construction: NULL device or offline buffers only;
// real-device smoke tests are opt-in (OM_TEST_REAL_DEVICE=1), shared mode,
// gain 0, 5 s max, never exclusive mode. Portable (Windows, macOS, Linux).
#pragma once

#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <string>
#include <vector>

namespace omtest {

struct TestCase {
  const char* name;
  void (*fn)();
  const char* file;
  int line;
};

std::vector<TestCase>& registry();

struct Registrar {
  Registrar(const char* name, void (*fn)(), const char* file, int line) { registry().push_back({name, fn, file, line}); }
};

// Signals thrown to end a test early (tests are not real-time code).
struct FailSignal {};
struct TodoSignal {};
struct SkipSignal {};

[[noreturn]] void fail(const char* expr, const char* file, int line, const std::string& detail = std::string());
[[noreturn]] void todo(const std::string& what);
[[noreturn]] void skip(const std::string& why);
bool envFlag(const char* name);            // environment variable set to "1"
std::string envString(const char* name);   // "" when unset

// Counts heap allocations (operator new) made by THIS thread while alive.
class RtAllocGuard {
 public:
  RtAllocGuard();
  ~RtAllocGuard();
  size_t count() const;

 private:
  size_t start_;
};

// ---- golden references (SPEC.md §18.4) ----------------------------------------
struct Wav {
  int sampleRate = 0;
  int channels = 0;
  std::vector<float> samples;  // interleaved
  int64_t frames() const { return channels ? static_cast<int64_t>(samples.size() / channels) : 0; }
};
// Path of a golden file under OM_GOLDEN_DIR ("" when the variable is unset).
std::string goldenPath(const std::string& relative);
// Reads a WAV (PCM 16/24/32-bit or float32, RIFF or RF64) into floats.
bool readWav(const std::string& path, Wav& out, std::string* err);
// Residual of a against b in dBFS: 20 log10(max |a - b|) (-inf -> -400).
double residualDb(const float* a, const float* b, size_t n);

}  // namespace omtest

#define OM_TEST(name)                                                              \
  static void name();                                                              \
  static omtest::Registrar name##_registrar(#name, &name, __FILE__, __LINE__);     \
  static void name()

#define OM_CHECK(cond)                                         \
  do {                                                         \
    if (!(cond)) omtest::fail(#cond, __FILE__, __LINE__);      \
  } while (0)

#define OM_CHECK_NEAR(a, b, eps)                                                               \
  do {                                                                                         \
    const double om_a_ = static_cast<double>(a);                                               \
    const double om_b_ = static_cast<double>(b);                                               \
    if (!(std::fabs(om_a_ - om_b_) <= static_cast<double>(eps)))                               \
      omtest::fail(#a " ~= " #b, __FILE__, __LINE__,                                           \
                   std::to_string(om_a_) + " vs " + std::to_string(om_b_) + " (eps " #eps ")"); \
  } while (0)

#define OM_TODO(what) omtest::todo(what)
#define OM_SKIP(why) omtest::skip(why)
