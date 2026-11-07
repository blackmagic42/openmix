// NULL audio device: renders the engine into memory with a virtual clock, for
// tests and offline renders — it never touches a sound card (owner: device).
// Its real-time pacer (one block per period on a schedule anchored to the
// engine clock; a high-resolution waitable timer on Windows, a plain sleep
// elsewhere, through the platform seam) serves silent soak tests AND stands
// in, silently, for a lost device while the transport keeps running
// (SPEC.md §8.4, §8.6). The pacer thread is an audio thread (MMCSS, FTZ/DAZ,
// rt::Scope around each block); callbackTime is the block's scheduled time,
// never the wake-up time, so presentTime is exact and jitter-free.
#include <algorithm>
#include <cstring>
#include <thread>

#include "om/device.h"
#include "om/dsp.h"
#include "om/rt.h"
#include "platform.h"
#include "timing.h"

namespace om {

struct NullDevice::Pacer {
  std::thread thread;
  std::unique_ptr<dev::plat::PacerTimer> timer;
  std::atomic<bool> run{false};
  // statistics (written by the pacer thread, read after / during the run)
  std::atomic<uint64_t> blocks{0};
  std::atomic<uint64_t> lateBlocks{0};
  std::atomic<uint64_t> resyncs{0};
  dev::JitterWindow late;   // lateness of each block's start
};

NullDevice::NullDevice(const NullDeviceConfig& cfg) : cfg_(cfg) {}

NullDevice::~NullDevice() { close(); }

bool NullDevice::open(const DeviceConfig&, IRenderCallback* cb, std::string* err) {
  if (!cb) {
    if (err) *err = "no render callback";
    return false;
  }
  if (cfg_.sampleRate <= 0 || cfg_.channels <= 0 || cfg_.channels > kMaxOutputChannels || cfg_.blockFrames <= 0 ||
      cfg_.blockFrames > kMaxBlockFrames || cfg_.latencyFrames < 0) {
    if (err) *err = "invalid NULL device configuration";
    return false;
  }
  if (started_) stop();
  cb_ = cb;
  frame_ = 0;
  scratch_.assign(static_cast<size_t>(cfg_.blockFrames) * cfg_.channels, 0.0f);
  open_ = true;
  return true;
}

bool NullDevice::start(std::string* err) {
  if (!open_) {
    if (err) *err = "device not open";
    return false;
  }
  if (started_) return true;
  if (!cfg_.realtime) {
    started_ = true;
    return true;
  }
  if (!pacer_) pacer_ = std::make_unique<Pacer>();
  Pacer& p = *pacer_;
  if (!p.timer) p.timer = dev::plat::makePacerTimer();
  if (!p.timer) {
    if (err) *err = "no pacing timer";
    return false;
  }
  p.blocks = 0;
  p.lateBlocks = 0;
  p.resyncs = 0;
  p.late.reset(1.0);
  p.run = true;
  started_ = true;
  // Engine clock initialised here (non-real-time thread) before the pacer uses it.
  const EngineTime t0 = EngineClock::now() + static_cast<double>(cfg_.blockFrames) / cfg_.sampleRate;
  p.thread = std::thread([this, t0] {
    Pacer& pc = *pacer_;
    void* mm = promoteAudioThread("Pro Audio", nullptr);
    dsp::flushDenormals();
    const double rate = cfg_.sampleRate;
    const double blockSec = cfg_.blockFrames / rate;
    const double latency = cfg_.latencyFrames / rate;
    const size_t samples = scratch_.size();
    EngineTime origin = t0;
    uint64_t k = 0;
    while (pc.run.load(std::memory_order_acquire)) {
      const EngineTime due = origin + static_cast<double>(k) * blockSec;
      if (!pc.timer->waitUntil(due)) continue;  // woken: re-check run
      rt::Scope rts;
      const EngineTime now = EngineClock::now();
      double lateSec = now - due;
      if (lateSec > 0.5) {
        // Far behind (machine suspended, debugger): restart the schedule
        // instead of bursting hundreds of blocks.
        pc.resyncs.fetch_add(1, std::memory_order_relaxed);
        origin = now - static_cast<double>(k) * blockSec;
        lateSec = 0;
      }
      if (lateSec > blockSec) pc.lateBlocks.fetch_add(1, std::memory_order_relaxed);
      pc.late.add(lateSec > 0 ? lateSec : 0.0, now);
      BlockClock clk;
      clk.frame = frame_.load(std::memory_order_relaxed);
      clk.frames = cfg_.blockFrames;
      clk.sampleRate = rate;
      clk.callbackTime = origin + static_cast<double>(k) * blockSec;
      clk.presentTime = clk.callbackTime + latency;
      std::memset(scratch_.data(), 0, samples * sizeof(float));
      cb_->render(scratch_.data(), cfg_.blockFrames, cfg_.channels, clk);
      frame_.fetch_add(cfg_.blockFrames, std::memory_order_relaxed);
      pc.blocks.fetch_add(1, std::memory_order_relaxed);
      k++;
    }
    demoteAudioThread(mm);
  });
  return true;
}

void NullDevice::stop() {
  if (pacer_ && pacer_->thread.joinable()) {
    pacer_->run = false;
    if (pacer_->timer) pacer_->timer->wake();
    pacer_->thread.join();
  }
  started_ = false;
}

void NullDevice::close() {
  stop();
  open_ = false;
  cb_ = nullptr;
}

DeviceStatus NullDevice::status() const {
  DeviceStatus s;
  s.mode = open_ ? DeviceMode::Null : DeviceMode::Closed;
  s.name = "NULL";
  s.sampleRate = cfg_.sampleRate;
  s.channels = cfg_.channels;
  s.periodFrames = cfg_.blockFrames;
  s.bufferFrames = cfg_.blockFrames;
  s.outputLatencyMs = 1000.0 * cfg_.latencyFrames / cfg_.sampleRate;
  s.sampleFormat = "f32";
  s.running = started_.load();
  if (pacer_) {
    s.callbacks = pacer_->blocks.load(std::memory_order_relaxed);
    s.glitches = pacer_->lateBlocks.load(std::memory_order_relaxed);
  }
  return s;
}

void NullDevice::setEventHandler(DeviceEventFn) {}  // the NULL device never changes

EngineTime NullDevice::virtualTime() const noexcept {
  return static_cast<double>(frame_.load()) / cfg_.sampleRate;
}

NullDevice::PacerStats NullDevice::pacerStats() const {
  PacerStats st;
  if (!pacer_) return st;
  st.blocks = pacer_->blocks.load(std::memory_order_relaxed);
  st.lateBlocks = pacer_->lateBlocks.load(std::memory_order_relaxed);
  st.resyncs = pacer_->resyncs.load(std::memory_order_relaxed);
  if (!started_.load()) {  // the run histogram is only read once the pacer thread stopped
    st.p99LateMs = pacer_->late.totalP99Ms();
    st.maxLateMs = pacer_->late.totalMaxMs();
  } else {
    st.p99LateMs = pacer_->late.windowP99Ms();
    st.maxLateMs = pacer_->late.windowMaxMs();
  }
  st.timer = pacer_->timer ? pacer_->timer->kind() : "";
  return st;
}

int NullDevice::pump(int blocks, float* sink) {
  if (!open_ || !started_ || !cb_ || cfg_.realtime) return 0;
  const size_t blockSamples = static_cast<size_t>(cfg_.blockFrames) * cfg_.channels;
  for (int b = 0; b < blocks; b++) {
    BlockClock clk;
    clk.frame = frame_.load();
    clk.frames = cfg_.blockFrames;
    clk.sampleRate = cfg_.sampleRate;
    clk.callbackTime = static_cast<double>(clk.frame) / cfg_.sampleRate;
    clk.presentTime = clk.callbackTime + static_cast<double>(cfg_.latencyFrames) / cfg_.sampleRate;
    float* out = sink ? sink + b * blockSamples : scratch_.data();
    std::memset(out, 0, blockSamples * sizeof(float));
    cb_->render(out, cfg_.blockFrames, cfg_.channels, clk);
    frame_ += cfg_.blockFrames;
  }
  return blocks;
}

}  // namespace om
