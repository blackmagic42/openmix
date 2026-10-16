// NULL audio device: renders the engine into memory with a virtual clock, for
// tests and offline renders — it never touches a sound card (owner: device).
// The offline pump works; the real-time pacer thread is still a TODO.
#include <cstring>
#include <thread>

#include "om/device.h"

namespace om {

struct NullDevice::Pacer {
  std::thread thread;  // TODO(device): real-time pacing (waitable timer, one block per period)
};

NullDevice::NullDevice(const NullDeviceConfig& cfg) : cfg_(cfg) {}

NullDevice::~NullDevice() { close(); }

bool NullDevice::open(const DeviceConfig&, IRenderCallback* cb, std::string* err) {
  if (!cb) {
    if (err) *err = "no render callback";
    return false;
  }
  if (cfg_.sampleRate <= 0 || cfg_.channels <= 0 || cfg_.blockFrames <= 0 || cfg_.blockFrames > kMaxBlockFrames) {
    if (err) *err = "invalid NULL device configuration";
    return false;
  }
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
  if (cfg_.realtime) {
    if (err) *err = "NULL device real-time pacing not implemented yet";
    return false;
  }
  started_ = true;
  return true;
}

void NullDevice::stop() { started_ = false; }

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
  return s;
}

void NullDevice::setEventHandler(DeviceEventFn) {}

EngineTime NullDevice::virtualTime() const noexcept {
  return static_cast<double>(frame_.load()) / cfg_.sampleRate;
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
