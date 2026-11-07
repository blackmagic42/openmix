// Flat C interface of libopenmix (owner: host): om_engine.h implemented on
// top of om::Engine, plus the engine-less helpers (device list, VST scan for
// the scan process, shadow decode for the shadow process). No C++ exception
// crosses this boundary. The om_state layout is asserted here (no implicit
// padding: a later out-of-process engine shares it). SPEC.md §6.
#include "om/om_engine.h"

#include <cstddef>
#include <cstdio>
#include <cstring>
#include <exception>
#include <new>
#include <string>

#include "om/device.h"
#include "om/engine.h"
#include "om/json.h"
#include "om/shadow.h"
#include "om/vst_insert.h"

// Fixed C layout of the state (SPEC.md §15.5): explicit padding only.
// om_config grows only at its end (struct_size tells the fields a caller knows).
static_assert(offsetof(om_config, owner_window) == 64, "om_config: protocol-2 fields appended at the end");
static_assert(sizeof(om_deck_state) == 176, "om_deck_state layout changed");
static_assert(sizeof(om_sync_state) == 152, "om_sync_state layout changed");
static_assert(sizeof(om_mixer_state) == 64, "om_mixer_state layout changed");
static_assert(sizeof(om_device_state) == 56, "om_device_state layout changed");
static_assert(sizeof(om_health_state) == 48, "om_health_state layout changed");
static_assert(sizeof(om_state) == 1064, "om_state layout changed");

struct om_engine {
  om::Engine engine;
  om_event_fn fn = nullptr;
  void* user = nullptr;
  explicit om_engine(const om::EngineOptions& o) : engine(o) {}
};

namespace {

void copyErr(char* err, size_t len, const std::string& msg) {
  if (!err || !len) return;
  const size_t n = msg.size() < len - 1 ? msg.size() : len - 1;
  std::memcpy(err, msg.data(), n);
  err[n] = '\0';
}

om_result fromPcm(om::PcmError e) {
  switch (e) {
    case om::PcmError::None: return OM_OK;
    case om::PcmError::NotFound: return OM_ERR_NOT_FOUND;
    case om::PcmError::OutOfMemory: return OM_ERR_NOMEM;
    case om::PcmError::Range:
    case om::PcmError::Duplicate: return OM_ERR_RANGE;
    case om::PcmError::Incomplete:
    case om::PcmError::Aborted: return OM_ERR_STATE;
    default: return OM_ERR_INVALID;
  }
}

}  // namespace

extern "C" {

void om_config_init(om_config* cfg) {
  if (!cfg) return;
  std::memset(cfg, 0, sizeof(*cfg));
  cfg->struct_size = sizeof(om_config);
  cfg->null_sample_rate = 48000;
  cfg->null_block_frames = 256;
  cfg->null_channels = 4;
  cfg->null_latency_frames = 256;
  cfg->state_hz = 60;
  cfg->heartbeat_ms = 250;
  cfg->stall_ms = 500;
  cfg->stalled_ms = 2000;
  cfg->loss_retry_ms = 2000;
}

const char* om_version(void) { return om::engineVersion(); }
int32_t om_protocol_version(void) { return OM_PROTOCOL_VERSION; }

om_engine* om_engine_create(const om_config* cfg, char* err, size_t err_len) {
  om_config c;
  om_config_init(&c);
  if (cfg) {
    if (cfg->struct_size < sizeof(uint32_t) || cfg->struct_size > sizeof(om_config)) {
      copyErr(err, err_len, "om_config.struct_size mismatch");
      return nullptr;
    }
    std::memcpy(&c, cfg, cfg->struct_size);
  }
  om::EngineOptions o;
  o.nullDevice = c.null_device != 0;
  o.nullConfig.sampleRate = c.null_sample_rate > 0 ? c.null_sample_rate : 48000;
  o.nullConfig.blockFrames = c.null_block_frames > 0 ? c.null_block_frames : 256;
  o.nullConfig.channels = c.null_channels > 0 ? c.null_channels : 4;
  o.nullConfig.latencyFrames = c.null_latency_frames >= 0 ? c.null_latency_frames : 256;
  o.nullConfig.realtime = c.null_realtime != 0;
  o.manual = c.manual != 0;
  o.stateHz = c.state_hz > 0 ? c.state_hz : 60;
  o.heartbeatMs = c.heartbeat_ms > 0 ? c.heartbeat_ms : 250;
  o.stallMs = c.stall_ms > 0 ? c.stall_ms : 500;
  o.stalledMs = c.stalled_ms > 0 ? c.stalled_ms : 2000;
  o.lossRetryMs = c.loss_retry_ms > 0 ? c.loss_retry_ms : 2000;
  o.maxPcmBytes = c.max_pcm_bytes;
  o.ownerWindow = static_cast<uintptr_t>(c.owner_window);
  if (c.data_dir) o.dataDir = c.data_dir;
  try {
    return new om_engine(o);
  } catch (const std::exception& ex) {
    copyErr(err, err_len, ex.what());
  } catch (...) {
    copyErr(err, err_len, "engine creation failed");
  }
  return nullptr;
}

void om_engine_destroy(om_engine* e) {
  if (!e) return;
  try {
    e->engine.stop();
  } catch (...) {
  }
  delete e;
}

om_result om_engine_start(om_engine* e, char* err, size_t err_len) {
  if (!e) return OM_ERR_INVALID;
  try {
    std::string msg;
    if (!e->engine.start(&msg)) {
      copyErr(err, err_len, msg.empty() ? "engine failed to start" : msg);
      return OM_ERR_DEVICE;
    }
    return OM_OK;
  } catch (const std::exception& ex) {
    copyErr(err, err_len, ex.what());
    return OM_ERR_INTERNAL;
  }
}

void om_engine_stop(om_engine* e) {
  if (!e) return;
  try {
    e->engine.stop();
  } catch (...) {
  }
}

void om_engine_set_event_callback(om_engine* e, om_event_fn fn, void* user) {
  if (!e) return;
  e->fn = fn;
  e->user = user;
  if (!fn) {
    e->engine.setEventSink(nullptr);
    return;
  }
  e->engine.setEventSink([fn, user](std::string_view json) { fn(user, json.data(), json.size()); });
}

om_result om_engine_set_policy(om_engine* e, const char* json, size_t len, char* err, size_t err_len) {
  if (!e || !json) return OM_ERR_INVALID;
  try {
    om::EnginePolicy p;
    std::string msg;
    if (!om::parsePolicy(std::string_view(json, len), p, &msg)) {
      copyErr(err, err_len, msg);
      return OM_ERR_INVALID;
    }
    e->engine.setPolicy(p);
    return OM_OK;
  } catch (...) {
    copyErr(err, err_len, "policy failed");
    return OM_ERR_INTERNAL;
  }
}

om_result om_engine_command(om_engine* e, const char* json, size_t len, char* err, size_t err_len) {
  if (!e || !json) return OM_ERR_INVALID;
  try {
    std::string msg;
    switch (e->engine.command(std::string_view(json, len), &msg)) {
      case om::CommandResult::Ok: return OM_OK;
      case om::CommandResult::Full:
        copyErr(err, err_len, msg.empty() ? "full" : msg);
        return OM_ERR_FULL;
      default:
        copyErr(err, err_len, msg);
        return OM_ERR_INVALID;
    }
  } catch (const std::bad_alloc&) {
    copyErr(err, err_len, "out of memory");
    return OM_ERR_NOMEM;
  } catch (const std::exception& ex) {
    copyErr(err, err_len, ex.what());
    return OM_ERR_INTERNAL;
  }
}

om_result om_engine_read_state(om_engine* e, om_state* out) {
  if (!e || !out) return OM_ERR_INVALID;
  return e->engine.readState(*out) ? OM_OK : OM_ERR_STATE;
}

double om_engine_now(const om_engine* e) { return e ? e->engine.now() : 0.0; }

om_result om_pcm_begin(om_engine* e, const om_pcm_desc* d) {
  if (!e || !d || d->struct_size < sizeof(om_pcm_desc)) return OM_ERR_INVALID;
  om::PcmDesc p;
  p.loadId = d->load_id;
  p.kind = d->kind == OM_PCM_STEM ? om::PcmKind::Stem : (d->kind == OM_PCM_SAMPLE ? om::PcmKind::Sample : om::PcmKind::Track);
  if (d->format != OM_PCM_S16 && d->format != OM_PCM_F32) return OM_ERR_INVALID;
  p.format = d->format == OM_PCM_F32 ? om::PcmFormat::F32 : om::PcmFormat::S16;
  p.sourceChannels = d->source_channels;
  p.sampleRate = d->sample_rate;
  p.frames = d->frames;
  p.headroom = d->headroom;
  p.peak = d->peak;
  try {
    return fromPcm(e->engine.pcmBegin(p));
  } catch (...) {
    return OM_ERR_NOMEM;
  }
}

om_result om_pcm_write(om_engine* e, uint32_t load_id, int64_t offset_frames, int32_t frames, int32_t channels,
                       const float* planar) {
  if (!e || !planar) return OM_ERR_INVALID;
  try {
    return fromPcm(e->engine.pcmWrite(load_id, offset_frames, frames, channels, planar));
  } catch (...) {
    return OM_ERR_NOMEM;
  }
}

om_result om_pcm_end(om_engine* e, uint32_t load_id) {
  if (!e) return OM_ERR_INVALID;
  try {
    return fromPcm(e->engine.pcmEnd(load_id));
  } catch (...) {
    return OM_ERR_INTERNAL;
  }
}

void om_pcm_abort(om_engine* e, uint32_t load_id) {
  if (e) e->engine.pcmAbort(load_id);
}

om_result om_engine_pump(om_engine* e) {
  if (!e) return OM_ERR_INVALID;
  try {
    e->engine.pump();
    return OM_OK;
  } catch (...) {
    return OM_ERR_INTERNAL;
  }
}

int32_t om_engine_render(om_engine* e, float* out, int32_t frames) {
  if (!e || frames <= 0) return 0;
  return e->engine.render(out, frames);
}

om_result om_list_output_devices(om_event_fn fn, void* user) {
  if (!fn) return OM_ERR_INVALID;
  try {
    std::string err;
    const auto list = om::enumerateOutputDevices(&err);
    om::json::Value arr = om::json::Value::array();
    for (const auto& d : list) {
      om::json::Value o = om::json::Value::object();
      o.set("id", om::json::Value::string(d.id));
      o.set("name", om::json::Value::string(d.name));
      o.set("nameIndex", om::json::Value::number(d.nameIndex));
      o.set("channels", om::json::Value::number(d.channels));
      o.set("channelMask", om::json::Value::number(d.channelMask));
      o.set("sampleRate", om::json::Value::number(d.sampleRate));
      o.set("isDefault", om::json::Value::boolean(d.isDefault));
      o.set("isDefaultComms", om::json::Value::boolean(d.isDefaultComms));
      o.set("sharedMinPeriodFrames", om::json::Value::number(d.sharedMinPeriodFrames));
      o.set("sharedFundamentalFrames", om::json::Value::number(d.sharedFundamentalFrames));
      arr.push(std::move(o));
    }
    om::json::Value root = om::json::Value::object();
    root.set("devices", std::move(arr));
    if (!err.empty()) root.set("error", om::json::Value::string(err));
    const std::string text = om::json::stringify(root);
    fn(user, text.data(), text.size());
    return OM_OK;
  } catch (...) {
    return OM_ERR_INTERNAL;
  }
}

om_result om_vst_scan(const char* paths_json, size_t len, om_event_fn fn, void* user) {
  if (!paths_json || !fn) return OM_ERR_INVALID;
  try {
    om::json::Value v;
    std::string err;
    if (!om::json::parse(std::string_view(paths_json, len), v, &err) || !v.isArray()) return OM_ERR_INVALID;
    std::vector<std::string> paths;
    for (size_t i = 0; i < v.size(); i++)
      if (v.at(i).isString()) paths.push_back(v.at(i).asString());
    const auto results = om::scanVstPluginsDetailed(paths);
    om::json::Value arr = om::json::Value::array();
    for (const auto& r : results) {
      // Flat array of plugins as before (plus how each was found); files that
      // failed the scan add one entry with the reason (V22) and no uid.
      for (const auto& p : r.plugins) {
        om::json::Value o = om::json::Value::object();
        o.set("path", om::json::Value::string(p.path));
        o.set("name", om::json::Value::string(p.name));
        o.set("vendor", om::json::Value::string(p.vendor));
        o.set("uid", om::json::Value::string(p.uid));
        o.set("subCategories", om::json::Value::string(p.subCategories));
        o.set("source", om::json::Value::string(r.source));
        arr.push(std::move(o));
      }
      if (!r.error.empty() || r.crashed || r.timedOut) {
        om::json::Value o = om::json::Value::object();
        o.set("path", om::json::Value::string(r.path));
        o.set("error", om::json::Value::string(r.error));
        o.set("crashed", om::json::Value::boolean(r.crashed));
        o.set("timedOut", om::json::Value::boolean(r.timedOut));
        o.set("source", om::json::Value::string(r.source));
        arr.push(std::move(o));
      }
    }
    const std::string text = om::json::stringify(arr);
    fn(user, text.data(), text.size());
    return OM_OK;
  } catch (...) {
    return OM_ERR_INTERNAL;
  }
}

om_result om_shadow_run(const char* job_json, size_t len, const float* left, const float* right, int64_t frames,
                        om_event_fn fn, void* user) {
  if (!job_json || !fn || !left || !right || frames <= 0) return OM_ERR_INVALID;
  try {
    om::json::Value v;
    std::string err;
    if (!om::json::parse(std::string_view(job_json, len), v, &err) || !v.isObject() || !v["path"].isString())
      return OM_ERR_INVALID;
    om::ShadowJob job;
    job.loadId = static_cast<uint32_t>(v["loadId"].asNumber(0));
    job.pathUtf8 = v["path"].asString();
    job.refRate = static_cast<int>(v["rate"].asNumber(0));
    job.refFrames = static_cast<int64_t>(v["frames"].asNumber(0));
    job.windowStart = static_cast<int64_t>(v["windowStart"].asNumber(0));
    if (job.refRate <= 0) return OM_ERR_INVALID;
    job.left.assign(left, left + frames);
    job.right.assign(right, right + frames);
    om::ShadowReport rep;
    om::DecodeError de = om::DecodeError::None;
    std::string msg;
    std::unique_ptr<om::IAudioFileReader> reader = om::openSystemReader(job.pathUtf8, &de, &msg);
    if (!reader) {
      rep.loadId = job.loadId;
      rep.error = de;
      rep.message = msg;
    } else {
      rep = om::runShadowJob(job, *reader, nullptr);
    }
    const std::string text = om::shadowReportJson(rep);  // the decoder owns the report format
    fn(user, text.data(), text.size());
    return OM_OK;
  } catch (...) {
    return OM_ERR_INTERNAL;
  }
}

}  // extern "C"
