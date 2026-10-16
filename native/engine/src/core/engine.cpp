// Engine core: threads, queues, command dispatch, render callback, state
// publication, retired-object disposal, device lifecycle (owner: host).
// SKELETON: start() succeeds but nothing runs yet; commands are dropped.
// SPEC.md §14.
#include <mutex>

#include "om/engine.h"

namespace om {

struct Engine::Impl {
  EngineOptions opt;
  EventSink sink;
  std::mutex sinkLock;
  bool running = false;
};

Engine::Engine(const EngineOptions& opt) : impl_(std::make_unique<Impl>()) {
  impl_->opt = opt;
  (void)EngineClock::now();  // starts the engine clock on a non-real-time thread
}

Engine::~Engine() { stop(); }

bool Engine::start(std::string*) {
  impl_->running = true;  // TODO(host): control / decoder / VST threads, NULL device
  return true;
}

void Engine::stop() { impl_->running = false; }

bool Engine::running() const noexcept { return impl_->running; }

void Engine::post(std::string, std::vector<uint8_t>) {}  // TODO(host): inbound queue + control thread

void Engine::setEventSink(EventSink sink) {
  std::lock_guard<std::mutex> lk(impl_->sinkLock);
  impl_->sink = std::move(sink);
}

void Engine::pumpControl() {}

int Engine::renderOffline(int, float*) { return 0; }

EngineTime Engine::now() const noexcept { return EngineClock::now(); }

const char* engineVersion() noexcept { return "0.1.0-skeleton"; }

}  // namespace om
