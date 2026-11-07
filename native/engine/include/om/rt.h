// Real-time discipline helpers: marks the code that runs on the audio thread
// (the device callback and everything it calls) and counts the heap
// allocations AND frees made there. The counters are fed by a replaced
// global operator new / delete:
//  - in every test executable (tests/om_test_main.cpp),
//  - in openmix_engine.node when built with OM_RT_TRAP=1
//    (src/node/rt_trap.cpp), which then also reports "diag" events.
// Release builds pay one thread-local increment per callback, nothing else.
// Direct malloc / HeapAlloc calls are invisible here: the RT lint of
// tools/build-engine.js catches them (SPEC.md §18.6).
//
// FROZEN FOUNDATION (maintainer: host). Header-only.
//
// Rules inside an rt::Scope (SPEC.md §3.2): no allocation, no free, no lock
// (only try_lock and the lock-free SPSC queues), no I/O, no logging, no
// exceptions, no system call that can block.
#pragma once

#include <atomic>
#include <cstddef>
#include <cstdint>

namespace om {
namespace rt {

namespace detail {
inline thread_local int tDepth = 0;    // > 0: inside an rt::Scope
inline thread_local int tPlugin = 0;   // > 0: inside an rt::PluginScope (plugin code)
inline std::atomic<uint64_t> gAllocViolations{0};
inline std::atomic<uint64_t> gAllocViolationBytes{0};
inline std::atomic<uint64_t> gFreeViolations{0};
inline std::atomic<uint64_t> gPluginAllocs{0};
inline std::atomic<uint64_t> gPluginFrees{0};
// Set to true (at static initialization) by the translation unit that
// replaces operator new / delete: tests/om_test_main.cpp or
// src/node/rt_trap.cpp.
inline std::atomic<bool> gTrapInstalled{false};
}  // namespace detail

// Marks the calling thread as real-time for the lifetime of the object
// (nesting allowed). The core opens one in its render callback; module tests
// open one around the code they check.
class Scope {
 public:
  Scope() noexcept { ++detail::tDepth; }
  ~Scope() noexcept { --detail::tDepth; }
  Scope(const Scope&) = delete;
  Scope& operator=(const Scope&) = delete;
};

// Temporarily lifts the real-time mark (only for code that is allowed to
// allocate although called from an rt::Scope, e.g. test fixtures).
class Unscoped {
 public:
  Unscoped() noexcept : saved_(detail::tDepth) { detail::tDepth = 0; }
  ~Unscoped() noexcept { detail::tDepth = saved_; }
  Unscoped(const Unscoped&) = delete;
  Unscoped& operator=(const Unscoped&) = delete;

 private:
  int saved_;
};

// Around every call into plugin code (VST deck workers, VST host thread):
// lifts the real-time mark and counts the plugin's own allocations and frees
// separately — they are the plugin's business (reported in vst.status), not
// engine violations (SPEC.md §13.4).
class PluginScope {
 public:
  PluginScope() noexcept : saved_(detail::tDepth) {
    detail::tDepth = 0;
    ++detail::tPlugin;
  }
  ~PluginScope() noexcept {
    --detail::tPlugin;
    detail::tDepth = saved_;
  }
  PluginScope(const PluginScope&) = delete;
  PluginScope& operator=(const PluginScope&) = delete;

 private:
  int saved_;
};

inline bool inRealtime() noexcept { return detail::tDepth > 0; }

// Called by the replaced operator new. Counts the allocation when the
// calling thread is inside an rt::Scope (or a PluginScope).
inline void onAllocation(size_t bytes) noexcept {
  if (detail::tDepth > 0) {
    detail::gAllocViolations.fetch_add(1, std::memory_order_relaxed);
    detail::gAllocViolationBytes.fetch_add(bytes, std::memory_order_relaxed);
  } else if (detail::tPlugin > 0) {
    detail::gPluginAllocs.fetch_add(1, std::memory_order_relaxed);
  }
}

// Called by the replaced operator delete with a NON-NULL pointer. Freeing
// on the audio thread takes the heap lock and, for the last reference of a
// big buffer, runs VirtualFree for milliseconds: it is a violation like an
// allocation (SPEC.md §3.2).
inline void onDeallocation(const void* p) noexcept {
  if (!p) return;
  if (detail::tDepth > 0) {
    detail::gFreeViolations.fetch_add(1, std::memory_order_relaxed);
  } else if (detail::tPlugin > 0) {
    detail::gPluginFrees.fetch_add(1, std::memory_order_relaxed);
  }
}

// Violations seen inside rt::Scope since the start (or the last reset).
inline uint64_t allocViolations() noexcept { return detail::gAllocViolations.load(std::memory_order_relaxed); }
inline uint64_t freeViolations() noexcept { return detail::gFreeViolations.load(std::memory_order_relaxed); }
inline uint64_t violations() noexcept { return allocViolations() + freeViolations(); }
inline uint64_t violationBytes() noexcept { return detail::gAllocViolationBytes.load(std::memory_order_relaxed); }
inline uint64_t pluginAllocations() noexcept { return detail::gPluginAllocs.load(std::memory_order_relaxed); }
inline uint64_t pluginFrees() noexcept { return detail::gPluginFrees.load(std::memory_order_relaxed); }
inline void resetViolations() noexcept {
  detail::gAllocViolations.store(0, std::memory_order_relaxed);
  detail::gAllocViolationBytes.store(0, std::memory_order_relaxed);
  detail::gFreeViolations.store(0, std::memory_order_relaxed);
}

// True when this binary has an allocation hook installed (tests, trap .node).
inline bool trapInstalled() noexcept { return detail::gTrapInstalled.load(std::memory_order_relaxed); }

}  // namespace rt
}  // namespace om
