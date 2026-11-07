// Allocation trap of openmix_engine.node in trap builds (owner: host):
// replaces the global operator new / delete of the module so that every
// heap allocation AND every free made inside an om::rt::Scope (the audio
// callback) is counted, and plugin code inside an om::rt::PluginScope is
// counted apart; the core reports violations as "diag" events (kinds
// "rt-alloc" / "rt-free") and in om_state.health. Compiled into the .node
// only when OM_RT_TRAP is ON (never into the test executables, whose runner
// has its own hook). Exempt from the RT lint: it is the trap. SPEC.md §3.2.
#include <malloc.h>

#include <cstdlib>
#include <new>

#include "om/rt.h"

namespace {
const bool kInstalled = (om::rt::detail::gTrapInstalled.store(true), true);
}

void* operator new(size_t n) {
  om::rt::onAllocation(n);
  if (void* p = std::malloc(n ? n : 1)) return p;
  throw std::bad_alloc();
}
void* operator new[](size_t n) {
  om::rt::onAllocation(n);
  if (void* p = std::malloc(n ? n : 1)) return p;
  throw std::bad_alloc();
}
void* operator new(size_t n, const std::nothrow_t&) noexcept {
  om::rt::onAllocation(n);
  return std::malloc(n ? n : 1);
}
void* operator new[](size_t n, const std::nothrow_t&) noexcept {
  om::rt::onAllocation(n);
  return std::malloc(n ? n : 1);
}
void* operator new(size_t n, std::align_val_t a) {
  om::rt::onAllocation(n);
  if (void* p = _aligned_malloc(n ? n : 1, static_cast<size_t>(a))) return p;
  throw std::bad_alloc();
}
void* operator new[](size_t n, std::align_val_t a) {
  om::rt::onAllocation(n);
  if (void* p = _aligned_malloc(n ? n : 1, static_cast<size_t>(a))) return p;
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
  _aligned_free(p);
}
void operator delete[](void* p, std::align_val_t) noexcept {
  om::rt::onDeallocation(p);
  _aligned_free(p);
}
void operator delete(void* p, size_t, std::align_val_t) noexcept {
  om::rt::onDeallocation(p);
  _aligned_free(p);
}
void operator delete[](void* p, size_t, std::align_val_t) noexcept {
  om::rt::onDeallocation(p);
  _aligned_free(p);
}
