// Runner of the engine's module tests + the global allocation counter used
// by RtAllocGuard to prove that real-time code never allocates (owner: host).
#include <malloc.h>

#include <cstdlib>
#include <cstring>
#include <new>

#include "om_test.h"

// ---------------------------------------------------------------------------
// Allocation counting (per thread)
// ---------------------------------------------------------------------------
namespace {
thread_local size_t tAllocations = 0;
}

void* operator new(size_t n) {
  ++tAllocations;
  if (void* p = std::malloc(n ? n : 1)) return p;
  throw std::bad_alloc();
}
void* operator new[](size_t n) {
  ++tAllocations;
  if (void* p = std::malloc(n ? n : 1)) return p;
  throw std::bad_alloc();
}
void* operator new(size_t n, const std::nothrow_t&) noexcept {
  ++tAllocations;
  return std::malloc(n ? n : 1);
}
void* operator new[](size_t n, const std::nothrow_t&) noexcept {
  ++tAllocations;
  return std::malloc(n ? n : 1);
}
void* operator new(size_t n, std::align_val_t a) {
  ++tAllocations;
  if (void* p = _aligned_malloc(n ? n : 1, static_cast<size_t>(a))) return p;
  throw std::bad_alloc();
}
void* operator new[](size_t n, std::align_val_t a) {
  ++tAllocations;
  if (void* p = _aligned_malloc(n ? n : 1, static_cast<size_t>(a))) return p;
  throw std::bad_alloc();
}
void operator delete(void* p) noexcept { std::free(p); }
void operator delete[](void* p) noexcept { std::free(p); }
void operator delete(void* p, size_t) noexcept { std::free(p); }
void operator delete[](void* p, size_t) noexcept { std::free(p); }
void operator delete(void* p, std::align_val_t) noexcept { _aligned_free(p); }
void operator delete[](void* p, std::align_val_t) noexcept { _aligned_free(p); }
void operator delete(void* p, size_t, std::align_val_t) noexcept { _aligned_free(p); }
void operator delete[](void* p, size_t, std::align_val_t) noexcept { _aligned_free(p); }

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

bool envFlag(const char* name) {
  char* v = nullptr;
  size_t len = 0;
  if (_dupenv_s(&v, &len, name) != 0 || !v) return false;
  const bool on = std::strcmp(v, "1") == 0;
  std::free(v);
  return on;
}

RtAllocGuard::RtAllocGuard() : start_(tAllocations) {}
RtAllocGuard::~RtAllocGuard() = default;
size_t RtAllocGuard::count() const { return tAllocations - start_; }

}  // namespace omtest

int main(int argc, char** argv) {
  using namespace omtest;
  const char* filter = argc > 1 ? argv[1] : nullptr;
  const bool strict = envFlag("OM_TEST_STRICT");
  int pass = 0, failed = 0, todos = 0, skipped = 0;
  for (const TestCase& t : registry()) {
    if (filter && !std::strstr(t.name, filter)) continue;
    try {
      t.fn();
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
