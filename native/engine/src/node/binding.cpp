// Node-API binding of the native engine (openmix_engine.node), loaded by
// engine-host.js inside the Electron utility process (owner: host). A THIN
// layer over the flat C API (om_engine.h): no engine logic here.
//
//   version() -> string            protocol() -> number
//   create(options, onEvent) -> Engine     (onEvent(jsonText) on the JS thread)
//     options: { nullDevice, manual, nullRealtime, stateHz, heartbeatMs, stallMs, stalledMs,
//                lossRetryMs, dataDir, maxPcmBytes, nullSampleRate, nullBlockFrames, nullChannels,
//                ownerHwnd (decimal string or number: the main window owning plugin editors) }
//   Engine#start()                          throws on failure
//   Engine#setPolicy(jsonText) -> null | "error"      (engine-host.js only: main's trusted paths)
//   Engine#command(jsonText) -> null | "full" | "error message"   (never blocks)
//   Engine#pcmBegin({ loadId, kind, format, sourceChannels, sampleRate, frames, headroom, peak }) -> code
//   Engine#pcmWrite(loadId, offsetFrames, frames, channels, Float32Array planar) -> code
//   Engine#pcmEnd(loadId) -> code      Engine#pcmAbort(loadId)
//   Engine#now() -> number             Engine#stop()    Engine#destroy()
//   listDevices() -> jsonText
//   vstScan(pathsJsonText) -> jsonText                      (scan process only)
//   shadowRun(jobJsonText, Float32Array left, Float32Array right) -> jsonText  (shadow process only)
// Codes are om_result values (0 = OM_OK).
// Events: "state" events are COALESCED in one latest-state slot (at most one
// JS call pending for them, so a busy JS thread gets the newest state, not a
// burst of stale ones); other events are queued in order, bounded at 4096
// (overflow reported once as a "diag" event). SPEC.md §6.3.
#include <napi.h>

#include <atomic>
#include <cstring>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

#include "om/om_engine.h"

namespace {

constexpr int kMaxQueuedEvents = 4096;

class EngineWrap : public Napi::ObjectWrap<EngineWrap> {
 public:
  static Napi::Function Define(Napi::Env env) {
    return DefineClass(env, "Engine",
                       {InstanceMethod("start", &EngineWrap::Start), InstanceMethod("stop", &EngineWrap::Stop),
                        InstanceMethod("destroy", &EngineWrap::Destroy), InstanceMethod("command", &EngineWrap::Command),
                        InstanceMethod("setPolicy", &EngineWrap::SetPolicy),
                        InstanceMethod("pcmBegin", &EngineWrap::PcmBegin), InstanceMethod("pcmWrite", &EngineWrap::PcmWrite),
                        InstanceMethod("pcmEnd", &EngineWrap::PcmEnd), InstanceMethod("pcmAbort", &EngineWrap::PcmAbort),
                        InstanceMethod("now", &EngineWrap::Now)});
  }

  explicit EngineWrap(const Napi::CallbackInfo& info) : Napi::ObjectWrap<EngineWrap>(info) {
    Napi::Env env = info.Env();
    om_config cfg;
    om_config_init(&cfg);
    if (info.Length() > 0 && info[0].IsObject()) {
      Napi::Object o = info[0].As<Napi::Object>();
      auto num = [&](const char* k, int32_t& out) {
        if (o.Has(k) && o.Get(k).IsNumber()) out = o.Get(k).As<Napi::Number>().Int32Value();
      };
      auto flag = [&](const char* k, int32_t& out) {
        if (o.Has(k)) out = o.Get(k).ToBoolean().Value() ? 1 : 0;
      };
      flag("nullDevice", cfg.null_device);
      flag("manual", cfg.manual);
      flag("nullRealtime", cfg.null_realtime);
      num("stateHz", cfg.state_hz);
      num("heartbeatMs", cfg.heartbeat_ms);
      num("stallMs", cfg.stall_ms);
      num("stalledMs", cfg.stalled_ms);
      num("lossRetryMs", cfg.loss_retry_ms);
      num("nullSampleRate", cfg.null_sample_rate);
      num("nullBlockFrames", cfg.null_block_frames);
      num("nullChannels", cfg.null_channels);
      if (o.Has("maxPcmBytes") && o.Get("maxPcmBytes").IsNumber())
        cfg.max_pcm_bytes = static_cast<uint64_t>(o.Get("maxPcmBytes").As<Napi::Number>().DoubleValue());
      if (o.Has("dataDir") && o.Get("dataDir").IsString()) dataDir_ = o.Get("dataDir").As<Napi::String>().Utf8Value();
      if (o.Has("ownerHwnd")) {
        // HWND from main (win.getNativeWindowHandle() read as a 64-bit integer, sent as a decimal string)
        const Napi::Value h = o.Get("ownerHwnd");
        if (h.IsString()) {
          uint64_t v = 0;
          for (char c : h.As<Napi::String>().Utf8Value()) {
            if (c < '0' || c > '9') {
              v = 0;
              break;
            }
            v = v * 10 + static_cast<uint64_t>(c - '0');
          }
          cfg.owner_window = v;
        } else if (h.IsNumber()) {
          cfg.owner_window = static_cast<uint64_t>(h.As<Napi::Number>().Int64Value());
        } else if (h.IsBigInt()) {
          bool lossless = false;
          cfg.owner_window = h.As<Napi::BigInt>().Uint64Value(&lossless);
        }
      }
    }
    cfg.data_dir = dataDir_.empty() ? nullptr : dataDir_.c_str();
    char err[256] = {0};
    engine_ = om_engine_create(&cfg, err, sizeof(err));
    if (!engine_) {
      Napi::Error::New(env, err[0] ? err : "engine creation failed").ThrowAsJavaScriptException();
      return;
    }
    if (info.Length() > 1 && info[1].IsFunction()) {
      tsfn_ = Napi::ThreadSafeFunction::New(env, info[1].As<Napi::Function>(), "openmix-engine-events", 0, 1);
      hasTsfn_ = true;
      om_engine_set_event_callback(engine_, &EngineWrap::OnEvent, this);
    }
  }

  ~EngineWrap() override { Release(); }

 private:
  // Shared between the engine threads (producers) and the JS-thread
  // callbacks; captured by every queued call, so it outlives the wrap.
  struct EventSlots {
    std::mutex m;
    std::string latestState;     // the newest "state" event not delivered yet
    bool statePending = false;   // a JS call for the state slot is queued
    std::atomic<int> queued{0};  // other events queued
    std::atomic<uint32_t> dropped{0};
  };

  // Engine threads (control, ops, vst-ops), one call at a time.
  static void OnEvent(void* user, const char* json, size_t len) {
    auto* self = static_cast<EngineWrap*>(user);
    if (!self->hasTsfn_) return;
    std::shared_ptr<EventSlots> slots = self->slots_;
    static const char kState[] = "{\"ev\":\"state\"";
    const bool isState = len >= sizeof(kState) - 1 && std::memcmp(json, kState, sizeof(kState) - 1) == 0;
    if (isState) {
      {
        std::lock_guard<std::mutex> lk(slots->m);
        slots->latestState.assign(json, len);
        if (slots->statePending) return;  // the queued call will deliver this newer state
        slots->statePending = true;
      }
      const napi_status st = self->tsfn_.NonBlockingCall([slots](Napi::Env env, Napi::Function fn) {
        std::string text;
        {
          std::lock_guard<std::mutex> lk(slots->m);
          text.swap(slots->latestState);
          slots->statePending = false;
        }
        if (env != nullptr && fn != nullptr && !text.empty()) fn.Call({Napi::String::New(env, text)});
      });
      if (st != napi_ok) {
        std::lock_guard<std::mutex> lk(slots->m);
        slots->statePending = false;
      }
      return;
    }
    if (slots->queued.load() >= kMaxQueuedEvents) {
      slots->dropped++;
      return;
    }
    slots->queued++;
    const napi_status st = self->tsfn_.NonBlockingCall([slots, text = std::string(json, len)](Napi::Env env, Napi::Function fn) {
      slots->queued--;
      if (env == nullptr || fn == nullptr) return;
      fn.Call({Napi::String::New(env, text)});
      const uint32_t lost = slots->dropped.exchange(0);
      if (lost) {
        const std::string diag = "{\"ev\":\"diag\",\"kind\":\"events-dropped\",\"count\":" + std::to_string(lost) + "}";
        fn.Call({Napi::String::New(env, diag)});
      }
    });
    if (st != napi_ok) slots->queued--;
  }

  void Release() {
    if (engine_) {
      om_engine_set_event_callback(engine_, nullptr, nullptr);
      om_engine_destroy(engine_);  // joins the engine threads: no callback after this
      engine_ = nullptr;
    }
    if (hasTsfn_) {
      hasTsfn_ = false;
      tsfn_.Release();
    }
  }

  bool Alive(const Napi::CallbackInfo& info) {
    if (engine_) return true;
    Napi::Error::New(info.Env(), "engine destroyed").ThrowAsJavaScriptException();
    return false;
  }

  Napi::Value Start(const Napi::CallbackInfo& info) {
    if (!Alive(info)) return info.Env().Undefined();
    char err[256] = {0};
    if (om_engine_start(engine_, err, sizeof(err)) != OM_OK)
      Napi::Error::New(info.Env(), err[0] ? err : "engine failed to start").ThrowAsJavaScriptException();
    return info.Env().Undefined();
  }

  Napi::Value Stop(const Napi::CallbackInfo& info) {
    if (engine_) om_engine_stop(engine_);
    return info.Env().Undefined();
  }

  Napi::Value Destroy(const Napi::CallbackInfo& info) {
    Release();
    return info.Env().Undefined();
  }

  Napi::Value Command(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (!Alive(info)) return env.Undefined();
    if (info.Length() < 1 || !info[0].IsString()) {
      Napi::TypeError::New(env, "command(jsonText)").ThrowAsJavaScriptException();
      return env.Undefined();
    }
    const std::string text = info[0].As<Napi::String>().Utf8Value();
    char err[512] = {0};
    const om_result r = om_engine_command(engine_, text.data(), text.size(), err, sizeof(err));
    if (r == OM_OK) return env.Null();
    if (r == OM_ERR_FULL) return Napi::String::New(env, "full");
    return Napi::String::New(env, err[0] ? err : "invalid command");
  }

  Napi::Value SetPolicy(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (!Alive(info)) return env.Undefined();
    if (info.Length() < 1 || !info[0].IsString()) {
      Napi::TypeError::New(env, "setPolicy(jsonText)").ThrowAsJavaScriptException();
      return env.Undefined();
    }
    const std::string text = info[0].As<Napi::String>().Utf8Value();
    char err[256] = {0};
    if (om_engine_set_policy(engine_, text.data(), text.size(), err, sizeof(err)) == OM_OK) return env.Null();
    return Napi::String::New(env, err[0] ? err : "invalid policy");
  }

  Napi::Value PcmBegin(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (!Alive(info)) return env.Undefined();
    if (info.Length() < 1 || !info[0].IsObject()) {
      Napi::TypeError::New(env, "pcmBegin(desc)").ThrowAsJavaScriptException();
      return env.Undefined();
    }
    Napi::Object o = info[0].As<Napi::Object>();
    auto num = [&](const char* k, double def) {
      return o.Has(k) && o.Get(k).IsNumber() ? o.Get(k).As<Napi::Number>().DoubleValue() : def;
    };
    auto str = [&](const char* k) { return o.Has(k) && o.Get(k).IsString() ? o.Get(k).As<Napi::String>().Utf8Value() : std::string(); };
    om_pcm_desc d;
    std::memset(&d, 0, sizeof(d));
    d.struct_size = sizeof(d);
    d.load_id = static_cast<uint32_t>(num("loadId", 0));
    const std::string kind = str("kind");
    d.kind = kind == "stem" ? OM_PCM_STEM : (kind == "sample" ? OM_PCM_SAMPLE : OM_PCM_TRACK);
    d.format = str("format") == "f32" ? OM_PCM_F32 : OM_PCM_S16;
    d.source_channels = static_cast<int32_t>(num("sourceChannels", 2));
    d.sample_rate = static_cast<int32_t>(num("sampleRate", 0));
    d.frames = static_cast<int64_t>(num("frames", -1));
    d.headroom = static_cast<float>(num("headroom", 0));
    d.peak = static_cast<float>(num("peak", 0));
    return Napi::Number::New(env, om_pcm_begin(engine_, &d));
  }

  Napi::Value PcmWrite(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (!Alive(info)) return env.Undefined();
    if (info.Length() < 5 || !info[0].IsNumber() || !info[1].IsNumber() || !info[2].IsNumber() || !info[3].IsNumber()) {
      Napi::TypeError::New(env, "pcmWrite(loadId, offsetFrames, frames, channels, Float32Array)").ThrowAsJavaScriptException();
      return env.Undefined();
    }
    const float* data = nullptr;
    size_t bytes = 0;
    if (info[4].IsTypedArray() && info[4].As<Napi::TypedArray>().TypedArrayType() == napi_float32_array) {
      Napi::Float32Array fa = info[4].As<Napi::Float32Array>();
      data = fa.Data();
      bytes = fa.ByteLength();
    } else if (info[4].IsArrayBuffer()) {
      Napi::ArrayBuffer ab = info[4].As<Napi::ArrayBuffer>();
      data = static_cast<const float*>(ab.Data());
      bytes = ab.ByteLength();
    } else {
      Napi::TypeError::New(env, "pcmWrite: data must be a Float32Array (planar)").ThrowAsJavaScriptException();
      return env.Undefined();
    }
    const uint32_t loadId = info[0].As<Napi::Number>().Uint32Value();
    const int64_t offset = info[1].As<Napi::Number>().Int64Value();
    const int32_t frames = info[2].As<Napi::Number>().Int32Value();
    const int32_t channels = info[3].As<Napi::Number>().Int32Value();
    if (frames <= 0 || channels <= 0 || bytes < static_cast<size_t>(frames) * static_cast<size_t>(channels) * sizeof(float))
      return Napi::Number::New(env, OM_ERR_RANGE);
    return Napi::Number::New(env, om_pcm_write(engine_, loadId, offset, frames, channels, data));
  }

  Napi::Value PcmEnd(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (!Alive(info)) return env.Undefined();
    if (info.Length() < 1 || !info[0].IsNumber()) {
      Napi::TypeError::New(env, "pcmEnd(loadId)").ThrowAsJavaScriptException();
      return env.Undefined();
    }
    return Napi::Number::New(env, om_pcm_end(engine_, info[0].As<Napi::Number>().Uint32Value()));
  }

  Napi::Value PcmAbort(const Napi::CallbackInfo& info) {
    if (engine_ && info.Length() > 0 && info[0].IsNumber()) om_pcm_abort(engine_, info[0].As<Napi::Number>().Uint32Value());
    return info.Env().Undefined();
  }

  Napi::Value Now(const Napi::CallbackInfo& info) {
    return Napi::Number::New(info.Env(), engine_ ? om_engine_now(engine_) : 0.0);
  }

  om_engine* engine_ = nullptr;
  std::string dataDir_;
  Napi::ThreadSafeFunction tsfn_;
  bool hasTsfn_ = false;
  std::shared_ptr<EventSlots> slots_ = std::make_shared<EventSlots>();
};

void CollectText(void* user, const char* json, size_t len) { static_cast<std::string*>(user)->assign(json, len); }

Napi::Value Version(const Napi::CallbackInfo& info) { return Napi::String::New(info.Env(), om_version()); }
Napi::Value Protocol(const Napi::CallbackInfo& info) { return Napi::Number::New(info.Env(), om_protocol_version()); }

Napi::Value ListDevices(const Napi::CallbackInfo& info) {
  std::string out;
  om_list_output_devices(&CollectText, &out);
  return Napi::String::New(info.Env(), out);
}

Napi::Value VstScan(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "vstScan(pathsJsonText)").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  const std::string paths = info[0].As<Napi::String>().Utf8Value();
  std::string out = "[]";
  om_vst_scan(paths.data(), paths.size(), &CollectText, &out);
  return Napi::String::New(env, out);
}

Napi::Value ShadowRun(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 3 || !info[0].IsString() || !info[1].IsTypedArray() || !info[2].IsTypedArray() ||
      info[1].As<Napi::TypedArray>().TypedArrayType() != napi_float32_array ||
      info[2].As<Napi::TypedArray>().TypedArrayType() != napi_float32_array) {
    Napi::TypeError::New(env, "shadowRun(jobJsonText, Float32Array left, Float32Array right)").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  const std::string job = info[0].As<Napi::String>().Utf8Value();
  Napi::Float32Array l = info[1].As<Napi::Float32Array>();
  Napi::Float32Array r = info[2].As<Napi::Float32Array>();
  const size_t frames = l.ElementLength() < r.ElementLength() ? l.ElementLength() : r.ElementLength();
  std::string out = "{\"ok\":false,\"error\":\"invalid job\"}";
  om_shadow_run(job.data(), job.size(), l.Data(), r.Data(), static_cast<int64_t>(frames), &CollectText, &out);
  return Napi::String::New(env, out);
}

Napi::Object ModuleInit(Napi::Env env, Napi::Object exports) {
  exports.Set("version", Napi::Function::New(env, Version));
  exports.Set("protocol", Napi::Function::New(env, Protocol));
  exports.Set("listDevices", Napi::Function::New(env, ListDevices));
  exports.Set("vstScan", Napi::Function::New(env, VstScan));
  exports.Set("shadowRun", Napi::Function::New(env, ShadowRun));
  Napi::Function ctor = EngineWrap::Define(env);
  exports.Set("Engine", ctor);
  // create(options, onEvent) -> new Engine(options, onEvent)
  exports.Set("create", Napi::Function::New(env, [](const Napi::CallbackInfo& info) -> Napi::Value {
                Napi::Function c = info.This().As<Napi::Object>().Get("Engine").As<Napi::Function>();
                std::vector<napi_value> args;
                for (size_t i = 0; i < info.Length(); i++) args.push_back(info[i]);
                return c.New(args);
              }));
  return exports;
}

}  // namespace

NODE_API_MODULE(openmix_engine, ModuleInit)
