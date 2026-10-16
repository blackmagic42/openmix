// Node-API binding of the native engine (openmix_engine.node), loaded by
// engine-host.js inside the Electron utility process (owner: host).
//   version()                 -> "0.1.0-skeleton"
//   create({ onEvent, nullDevice, stateHz, dataDir }) -> true (throws on error)
//   send(json, blob?)         -> queues one command (blob: ArrayBuffer / TypedArray / Buffer)
//   destroy()                 -> stops the engine, releases the event callback
// Events reach JavaScript through a thread-safe function: onEvent(json, blob?).
// SPEC.md §17.2.
#include <napi.h>

#include <memory>
#include <string>
#include <utility>
#include <vector>

#include "om/engine.h"

namespace {

struct EventPayload {
  std::string json;
  std::vector<uint8_t> blob;
};

std::unique_ptr<om::Engine> gEngine;
Napi::ThreadSafeFunction gEvents;
bool gHasEvents = false;

void releaseEngine() {
  if (gEngine) {
    gEngine->stop();
    gEngine.reset();
  }
  if (gHasEvents) {
    gEvents.Release();
    gHasEvents = false;
  }
}

Napi::Value Version(const Napi::CallbackInfo& info) { return Napi::String::New(info.Env(), om::engineVersion()); }

Napi::Value Create(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (gEngine) {
    Napi::Error::New(env, "engine already created").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  om::EngineOptions opt;
  Napi::Function onEvent;
  if (info.Length() > 0 && info[0].IsObject()) {
    Napi::Object o = info[0].As<Napi::Object>();
    if (o.Has("onEvent") && o.Get("onEvent").IsFunction()) onEvent = o.Get("onEvent").As<Napi::Function>();
    if (o.Has("nullDevice")) opt.nullDevice = o.Get("nullDevice").ToBoolean().Value();
    if (o.Has("stateHz") && o.Get("stateHz").IsNumber()) opt.stateHz = o.Get("stateHz").As<Napi::Number>().Int32Value();
    if (o.Has("dataDir") && o.Get("dataDir").IsString()) opt.dataDir = o.Get("dataDir").As<Napi::String>().Utf8Value();
  }
  if (!onEvent.IsEmpty()) {
    gEvents = Napi::ThreadSafeFunction::New(env, onEvent, "openmix-engine-events", 0, 1);
    gHasEvents = true;
  }
  gEngine = std::make_unique<om::Engine>(opt);
  gEngine->setEventSink([](std::string json, std::vector<uint8_t> blob) {
    if (!gHasEvents) return;
    auto* p = new EventPayload{std::move(json), std::move(blob)};
    const napi_status st = gEvents.NonBlockingCall(p, [](Napi::Env e, Napi::Function fn, EventPayload* data) {
      if (data->blob.empty()) {
        fn.Call({Napi::String::New(e, data->json)});
      } else {
        fn.Call({Napi::String::New(e, data->json),
                 Napi::Buffer<uint8_t>::Copy(e, data->blob.data(), data->blob.size())});
      }
      delete data;
    });
    if (st != napi_ok) delete p;
  });
  std::string err;
  if (!gEngine->start(&err)) {
    releaseEngine();
    Napi::Error::New(env, err.empty() ? "engine failed to start" : err).ThrowAsJavaScriptException();
    return env.Undefined();
  }
  return Napi::Boolean::New(env, true);
}

Napi::Value Send(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!gEngine) {
    Napi::Error::New(env, "engine not created").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "send(json: string, blob?)").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  std::vector<uint8_t> blob;
  if (info.Length() > 1) {
    if (info[1].IsArrayBuffer()) {
      Napi::ArrayBuffer ab = info[1].As<Napi::ArrayBuffer>();
      const uint8_t* d = static_cast<const uint8_t*>(ab.Data());
      blob.assign(d, d + ab.ByteLength());
    } else if (info[1].IsTypedArray()) {
      Napi::TypedArray ta = info[1].As<Napi::TypedArray>();
      const uint8_t* d = static_cast<const uint8_t*>(ta.ArrayBuffer().Data()) + ta.ByteOffset();
      blob.assign(d, d + ta.ByteLength());
    }
  }
  gEngine->post(info[0].As<Napi::String>().Utf8Value(), std::move(blob));
  return env.Undefined();
}

Napi::Value Destroy(const Napi::CallbackInfo& info) {
  releaseEngine();
  return info.Env().Undefined();
}

Napi::Object ModuleInit(Napi::Env env, Napi::Object exports) {
  exports.Set("version", Napi::Function::New(env, Version));
  exports.Set("create", Napi::Function::New(env, Create));
  exports.Set("send", Napi::Function::New(env, Send));
  exports.Set("destroy", Napi::Function::New(env, Destroy));
  env.AddCleanupHook([]() { releaseEngine(); });
  return exports;
}

}  // namespace

NODE_API_MODULE(openmix_engine, ModuleInit)
