// Default backends of the core and device helpers (owner: host): thin
// adapters exposing the real modules (SecondaryOutput, Recorder, VstHost)
// through the seams of engine.h, the routing rule of engine.js _wireOutput,
// the configured-endpoint match used when a lost device comes back, and the
// JSON of device statuses and device lists. SPEC.md §8, §13, §14, §15.
#include "backends.h"

#include <cmath>
#include <cstring>

namespace om {
namespace core {

namespace {

class PhonesAdapter final : public IPhonesOutput {
 public:
  bool open(const DeviceConfig& cfg, int mainSampleRate, int mainPeriodFrames, std::string* err) override {
    return out_.open(cfg, mainSampleRate, mainPeriodFrames, err);
  }
  void close() override { out_.close(); }
  void push(const float* l, const float* r, int frames, EngineTime t) noexcept override { out_.push(l, r, frames, t); }
  bool active() const noexcept override { return out_.active(); }
  DeviceStatus status() const override { return out_.status(); }
  void setEventHandler(DeviceEventFn fn) override { out_.setEventHandler(std::move(fn)); }

 private:
  SecondaryOutput out_;
};

class RecorderAdapter final : public IRecorder {
 public:
  bool start(const std::string& dir, const std::string& name, RecFormat fmt, int sampleRate, std::string* pathOut,
             std::string* err) override {
    return rec_.start(dir, name, fmt, sampleRate, pathOut, err);
  }
  void push(const float* l, const float* r, int frames) noexcept override { rec_.push(l, r, frames); }
  bool continueAtRate(int sampleRate, std::string* err) override { return rec_.continueAtRate(sampleRate, err); }
  RecStatus stop() override { return rec_.stop(); }
  RecStatus status() const override { return rec_.status(); }
  bool active() const noexcept override { return rec_.active(); }
  bool takeError() noexcept override { return rec_.takeError(); }
  std::vector<RecFileInfo> list(const std::string& dir, bool repair) override { return Recorder::listRecordings(dir, repair); }

 private:
  Recorder rec_;
};

class VstAdapter final : public IVstHost {
 public:
  bool start(double sampleRate, int maxBlockFrames, std::string* err) override { return host_.start(sampleRate, maxBlockFrames, err); }
  void stop() override { host_.stop(); }
  bool running() const noexcept override { return host_.running(); }
  void reconfigure(double sampleRate, int maxBlockFrames) override { host_.reconfigure(sampleRate, maxBlockFrames); }
  void setOwnerWindow(uintptr_t hwnd) override { host_.setOwnerWindow(hwnd); }
  VstLoadResult load(int deck, const std::string& path, const std::string& uid, const std::string& stateBase64) override {
    return host_.load(deck, path, uid, stateBase64);
  }
  void unload(int deck) override { host_.unload(deck); }
  bool setState(int deck, const std::string& stateBase64) override { return host_.setState(deck, stateBase64); }
  std::string getState(int deck) override { return host_.getState(deck); }
  std::string openEditor(int deck, uintptr_t ownerHwnd) override { return host_.openEditor(deck, ownerHwnd); }
  void closeEditor(int deck) override { host_.closeEditor(deck); }
  VstSlotStatus status(int deck) const override { return host_.status(deck); }
  uint8_t insertState(int deck, uint64_t* lateBlocks) const noexcept override { return host_.insertState(deck, lateBlocks); }
  void startCallback(double periodSeconds) noexcept override { host_.startCallback(periodSeconds); }
  void setDeadline(float f) noexcept override { host_.setDeadline(f); }
  void setMix(int deck, float mix) noexcept override { host_.setMix(deck, mix); }
  void setTransport(int deck, const VstTransport& t) noexcept override { host_.setTransport(deck, t); }
  uint8_t takeEvents(int deck) noexcept override { return host_.takeEvents(deck); }
  bool begin(int deck, const float* l, const float* r, int frames) noexcept override { return host_.begin(deck, l, r, frames); }
  void end(int deck, float* l, float* r, int frames) noexcept override { host_.end(deck, l, r, frames); }
  int latencyFrames(int deck) const noexcept override { return host_.latencyFrames(deck); }

 private:
  VstHost host_;
};

bool sameText(const std::string& a, const std::string& b) {
  if (a.size() != b.size()) return false;
  for (size_t i = 0; i < a.size(); i++) {
    char x = a[i], y = b[i];
    if (x >= 'A' && x <= 'Z') x = static_cast<char>(x - 'A' + 'a');
    if (y >= 'A' && y <= 'Z') y = static_cast<char>(y - 'A' + 'a');
    if (x != y) return false;
  }
  return true;
}

}  // namespace

std::unique_ptr<IPhonesOutput> makeDefaultPhones() { return std::make_unique<PhonesAdapter>(); }
std::unique_ptr<IRecorder> makeDefaultRecorder() { return std::make_unique<RecorderAdapter>(); }
std::unique_ptr<IVstHost> makeDefaultVstHost() { return std::make_unique<VstAdapter>(); }

Routing outputRouting(int channels, bool phonesSet) noexcept {
  Routing r;
  if (channels < 2) r.masterR = -1;  // mono endpoint: master L only (rare)
  if (channels <= 0) r.masterL = -1;
  if (channels >= 4 && !phonesSet) {
    r.cueL = 2;  // engine.js _wireOutput: a DJ controller is a 4-channel card, cue on 3/4
    r.cueR = 3;
  }
  return r;
}

std::string matchConfiguredEndpoint(const DeviceConfig& cfg, const std::vector<DeviceInfo>& list) {
  if (cfg.followDefault) {
    for (const auto& d : list)
      if (d.active && (cfg.role == DeviceRole::Communications ? d.isDefaultComms : d.isDefault)) return d.id;
    return {};
  }
  if (!cfg.id.empty()) {
    for (const auto& d : list)
      if (d.active && d.id == cfg.id) return d.id;
    if (cfg.name.empty()) return {};
  }
  if (!cfg.name.empty()) {
    std::string first;
    for (const auto& d : list) {
      if (!d.active || d.name != cfg.name) continue;
      if (d.nameIndex == cfg.nameIndex) return d.id;
      if (first.empty()) first = d.id;
    }
    if (!first.empty()) return first;
    for (const auto& d : list)
      if (d.active && sameText(d.name, cfg.name)) return d.id;
  }
  return {};
}

json::Value deviceStatusJson(const DeviceStatus& st) {
  using json::Value;
  Value f = Value::object();
  f.set("mode", Value::string(deviceModeName(st.mode)));
  f.set("id", Value::string(st.id));
  f.set("name", Value::string(st.name));
  f.set("sampleRate", Value::number(st.sampleRate));
  f.set("channels", Value::number(st.channels));
  f.set("channelMask", Value::number(st.channelMask));
  f.set("periodFrames", Value::number(st.periodFrames));
  f.set("bufferFrames", Value::number(st.bufferFrames));
  f.set("periodSteps", Value::number(st.periodSteps));
  f.set("latencyMs", Value::number(st.outputLatencyMs));
  f.set("jitterMs", Value::number(st.presentJitterMs));
  f.set("format", Value::string(st.sampleFormat));
  f.set("running", Value::boolean(st.running));
  f.set("lost", Value::boolean(st.lost));
  f.set("fellBack", Value::boolean(st.fellBack));
  if (!st.fallbackReason.empty()) f.set("fallbackReason", Value::string(st.fallbackReason));
  f.set("raw", Value::boolean(st.raw));
  f.set("glitches", Value::number(static_cast<double>(st.glitches)));
  return f;
}

json::Value deviceInfoJson(const DeviceInfo& d) {
  using json::Value;
  Value o = Value::object();
  o.set("id", Value::string(d.id));
  o.set("name", Value::string(d.name));
  o.set("nameIndex", Value::number(d.nameIndex));
  o.set("channels", Value::number(d.channels));
  o.set("channelMask", Value::number(d.channelMask));
  o.set("sampleRate", Value::number(d.sampleRate));
  o.set("active", Value::boolean(d.active));
  o.set("isDefault", Value::boolean(d.isDefault));
  o.set("isDefaultComms", Value::boolean(d.isDefaultComms));
  o.set("defaultPeriodMs", Value::number(d.defaultPeriodMs));
  o.set("minPeriodMs", Value::number(d.minPeriodMs));
  o.set("sharedMinPeriodFrames", Value::number(d.sharedMinPeriodFrames));
  o.set("sharedDefaultPeriodFrames", Value::number(d.sharedDefaultPeriodFrames));
  o.set("sharedFundamentalFrames", Value::number(d.sharedFundamentalFrames));
  return o;
}

bool parseDeviceConfig(const json::Value& b, DeviceConfig& out, std::string* err) {
  auto bad = [&](const char* why) {
    if (err) *err = why;
    return false;
  };
  DeviceConfig c;
  if (b.has("deviceId") && !b["deviceId"].isNull()) {
    if (!b["deviceId"].isString()) return bad("\"deviceId\" must be a string");
    c.id = b["deviceId"].asString();
  }
  if (b.has("name") && !b["name"].isNull()) {
    if (!b["name"].isString()) return bad("\"name\" must be a string");
    c.name = b["name"].asString();
  }
  if (b.has("nameIndex")) {
    const double v = b["nameIndex"].asNumber(-1);
    if (!b["nameIndex"].isNumber() || v < 0 || v > 255 || v != std::floor(v)) return bad("\"nameIndex\" must be an integer >= 0");
    c.nameIndex = static_cast<int>(v);
  }
  if (b.has("role")) {
    const std::string& r = b["role"].asString();
    if (r == "console") c.role = DeviceRole::Console;
    else if (r == "communications") c.role = DeviceRole::Communications;
    else return bad("\"role\" must be console or communications");
  }
  if (b.has("followDefault")) {
    if (!b["followDefault"].isBool()) return bad("\"followDefault\" must be a boolean");
    c.followDefault = b["followDefault"].asBool();
  } else if (c.id.empty() && c.name.empty()) {
    c.followDefault = true;  // no endpoint named: the user chose "Default" (Chromium "" / "default")
  }
  if (b.has("mode")) {
    if (!b["mode"].isString() || !outputModeFromName(b["mode"].asString().c_str(), c.mode))
      return bad("\"mode\" must be shared, lowlatency or exclusive");
  }
  if (b.has("periodFrames")) {
    const double v = b["periodFrames"].asNumber(-1);
    if (!b["periodFrames"].isNumber() || v < 0 || v > 16384 || v != std::floor(v)) return bad("\"periodFrames\" must be 0..16384");
    c.periodFrames = static_cast<int>(v);
  }
  if (b.has("sampleRate")) {
    const double v = b["sampleRate"].asNumber(-1);
    if (!b["sampleRate"].isNumber() || !(v == 0 || (v >= 8000 && v <= 384000))) return bad("\"sampleRate\" must be 0 or 8000..384000");
    c.sampleRate = static_cast<int>(v);
  }
  if (b.has("raw")) {
    if (!b["raw"].isBool()) return bad("\"raw\" must be a boolean");
    c.raw = b["raw"].asBool();
  }
  out = std::move(c);
  return true;
}

}  // namespace core
}  // namespace om
