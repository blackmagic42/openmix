// Helpers of the core tests (owner: host): an om::Engine on fake backends
// with an event log, JSON lookups of replies and events, PCM handoff of
// test tones. SPEC.md §18.3.
#pragma once

#include <algorithm>
#include <cstdio>
#include <functional>
#include <memory>
#include <string>
#include <vector>

#include "fakes.h"
#include "om/engine.h"
#include "om/json.h"
#include "om/om_engine.h"

namespace omtest {

struct TestEngine {
  FakeBackends fb;   // declared first: outlives the engine (its lambdas point here)
  EventLog log;
  std::unique_ptr<om::Engine> e;
  bool started = false;
  std::string startError;

  explicit TestEngine(bool manual = true, const std::function<void(om::EngineOptions&)>& tweak = {}) {
    om::EngineOptions o;
    o.manual = manual;
    o.nullDevice = true;
    o.backends = fb.make();
    if (tweak) tweak(o);
    e = std::make_unique<om::Engine>(o);
    e->setEventSink([this](std::string_view j) { log.add(j); });
    started = e->start(&startError);
  }
  ~TestEngine() {
    if (e) e->stop();
  }
  om::CommandResult cmd(const std::string& json, std::string* err = nullptr) {
    std::string local;
    return e->command(json, err ? err : &local);
  }
  // The reply event with this id (null when none yet).
  om::json::Value reply(int id) { return find("reply", [id](const om::json::Value& v) { return v["id"].asNumber(-1) == id; }); }
  // The last event `ev` accepted by `pred`.
  om::json::Value find(const char* ev, const std::function<bool(const om::json::Value&)>& pred = {}) {
    const std::vector<std::string> all = log.snapshot();
    for (auto it = all.rbegin(); it != all.rend(); ++it) {
      om::json::Value v;
      std::string err;
      if (!om::json::parse(*it, v, &err)) continue;
      if (v["ev"].asString() != ev) continue;
      if (!pred || pred(v)) return v;
    }
    return om::json::Value();
  }
  int countEvents(const char* ev, const std::function<bool(const om::json::Value&)>& pred = {}) {
    int n = 0;
    for (const std::string& s : log.snapshot()) {
      om::json::Value v;
      std::string err;
      if (!om::json::parse(s, v, &err) || v["ev"].asString() != ev) continue;
      if (!pred || pred(v)) n++;
    }
    return n;
  }
  // A track of `frames` frames handed off as float32 planar chunks (constant
  // tone values), stored as s16 with headroom 1.
  bool handoff(uint32_t loadId, int64_t frames, float value = 0.25f, int rate = 48000) {
    om::PcmDesc d;
    d.loadId = loadId;
    d.kind = om::PcmKind::Track;
    d.format = om::PcmFormat::S16;
    d.sourceChannels = 2;
    d.sampleRate = rate;
    d.frames = frames;
    d.headroom = 1.0f;
    if (e->pcmBegin(d) != om::PcmError::None) return false;
    for (int64_t off = 0; off < frames; off += om::TrackBuffer::kChunkFrames) {
      const int n = static_cast<int>(std::min<int64_t>(om::TrackBuffer::kChunkFrames, frames - off));
      std::vector<float> planar(static_cast<size_t>(n) * 2, value);
      if (e->pcmWrite(loadId, off, n, 2, planar.data()) != om::PcmError::None) return false;
    }
    return e->pcmEnd(loadId) == om::PcmError::None;
  }
  om_state state() {
    om_state s{};
    e->readState(s);
    return s;
  }
};

inline std::string num(double v) {
  char b[64];
  std::snprintf(b, sizeof(b), "%.17g", v);
  return b;
}

}  // namespace omtest
