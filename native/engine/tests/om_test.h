// Minimal test framework of the engine's module tests (no download, no
// external library). Each test executable = om_test_main.cpp + the module's
// tests/<module>/*.cpp (owner: host; frozen once the modules start).
//
//   OM_TEST(name) { OM_CHECK(x == 1); OM_CHECK_NEAR(a, b, 1e-6); }
//   OM_TODO("what remains to implement");   // pending acceptance test
//   OM_SKIP("why");                         // not applicable here
//   omtest::RtAllocGuard g;  ...  OM_CHECK(g.count() == 0);  // RT-safety
//
// Exit code 1 on any failure. With OM_TEST_STRICT=1 in the environment, TODO
// tests also fail (used at integration time). argv[1] = substring filter.
#pragma once

#include <cmath>
#include <cstddef>
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
bool envFlag(const char* name);  // environment variable set to "1"

// Counts heap allocations (operator new) made by THIS thread while alive.
class RtAllocGuard {
 public:
  RtAllocGuard();
  ~RtAllocGuard();
  size_t count() const;

 private:
  size_t start_;
};

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
