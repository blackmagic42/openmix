// "OM Spy": a VST3 test plugin for the inline host's tests (owner: decoder).
// Not part of OpenMix: built only for tests/vst (tests/vst/spy/CMakeLists.txt
// -> om-spy.vst3, passed with OM_TEST_VST_SPY). A single-component effect
// that delays its input by its own latency (so the host's compensation can
// be checked to the sample) and reports what a real plugin sees from the
// host through getState(): the whole FP control word (MXCSR) at each
// process() entry and on the host thread, the ProcessContext (also as a
// per-block log), non-null parameter / event lists, IComponentHandler2, the
// host name, the order of the host's setup calls, the controller
// synchronised with the component state on a fresh load, activation cycles.
// setState() takes commands that make it behave like plugins in the field:
//   "LAT:n"          new latency + restartComponent(kLatencyChanged)
//   "SILENTLAT:n"    a restored preset changing the latency without telling
//   "IO:1|2"         output bus channels + kIoChanged
//   "RELOAD"         kReloadComponent
//   "RTLAT:n"        the next process() changes the latency and calls
//                    restartComponent(kLatencyChanged) from the audio thread
//   "RESTART:f"      restartComponent(f), any flags
//   "PARAMS:n"       n parameters from now on + kParamTitlesChanged
//   "EDITS:n"        performEdit on n distinct parameters (as its editor would)
//   "SLEEP:ms[:k]"   the next k process() calls (default 1) take ms milliseconds
//   "CRASH"          the next process() call faults (access violation)
//   "LOG:n"          getState returns the last n per-block records (0: the report)
//   "SEQ:0"          clears the recorded call order
// Like plugins that never restore what they changed, every process() leaves
// MXCSR changed (FTZ / DAZ off, rounding toward zero) and every setState()
// leaves the host thread's MXCSR changed (rounding down, FTZ / DAZ on): the
// host must put both back. Its latency scales with the sample rate (64 at
// 48 kHz). The factory also lists an instrument, an offline-only effect and
// an instrument-effect (vocoder-like) class, for the scan's class filter.
// Report version 2 (spyVersion=2).
#include <windows.h>
#include <xmmintrin.h>

#include <atomic>
#include <cstdio>
#include <cstring>
#include <mutex>
#include <string>
#include <vector>

#include "pluginterfaces/base/ibstream.h"
#include "pluginterfaces/base/ipluginbase.h"
#include "pluginterfaces/vst/ivstaudioprocessor.h"
#include "pluginterfaces/vst/ivstcomponent.h"
#include "pluginterfaces/vst/ivsteditcontroller.h"
#include "pluginterfaces/vst/ivstevents.h"
#include "pluginterfaces/vst/ivsthostapplication.h"
#include "pluginterfaces/vst/ivstparameterchanges.h"
#include "pluginterfaces/vst/ivstprocesscontext.h"

using namespace Steinberg;
using namespace Steinberg::Vst;

namespace {

std::atomic<int> gInstances{0};

const TUID kCid = INLINE_UID(0x0E5A1F00, 0x51534F4D, 0x53505921, 0x00000001);
const TUID kCidSynth = INLINE_UID(0x0E5A1F00, 0x51534F4D, 0x53505921, 0x00000002);
const TUID kCidOffline = INLINE_UID(0x0E5A1F00, 0x51534F4D, 0x53505921, 0x00000003);
const TUID kCidVocoder = INLINE_UID(0x0E5A1F00, 0x51534F4D, 0x53505921, 0x00000004);

void spinMs(double ms) {
  LARGE_INTEGER f, a, b;
  QueryPerformanceFrequency(&f);
  QueryPerformanceCounter(&a);
  const double ticks = ms * 1e-3 * static_cast<double>(f.QuadPart);
  do {
    QueryPerformanceCounter(&b);
  } while (static_cast<double>(b.QuadPart - a.QuadPart) < ticks);
}

// One process() call, as the plugin saw it.
struct BlockRecord {
  int64 cont = 0, proj = 0, sys = 0;
  double tempo = 0, ppq = 0, bar = 0;
  uint32 state = 0, csr = 0;
  float firstIn = 0;
  int32 frames = 0;
};

class Spy : public IComponent, public IAudioProcessor, public IEditController {
 public:
  Spy() : bufL(kSize, 0.0f), bufR(kSize, 0.0f), log(kLog) { gInstances++; }
  ~Spy() {
    if (handler) handler->release();
  }

  tresult PLUGIN_API queryInterface(const TUID iid, void** obj) override {
    if (FUnknownPrivate::iidEqual(iid, FUnknown::iid) || FUnknownPrivate::iidEqual(iid, IPluginBase::iid) ||
        FUnknownPrivate::iidEqual(iid, IComponent::iid))
      *obj = static_cast<IComponent*>(this);
    else if (FUnknownPrivate::iidEqual(iid, IAudioProcessor::iid))
      *obj = static_cast<IAudioProcessor*>(this);
    else if (FUnknownPrivate::iidEqual(iid, IEditController::iid))
      *obj = static_cast<IEditController*>(this);
    else {
      *obj = nullptr;
      return kNoInterface;
    }
    addRef();
    return kResultOk;
  }
  uint32 PLUGIN_API addRef() override { return ++ref; }
  uint32 PLUGIN_API release() override {
    const int32 r = --ref;
    if (r == 0) delete this;
    return static_cast<uint32>(r);
  }

  // IPluginBase
  tresult PLUGIN_API initialize(FUnknown* context) override {
    note("init");
    hostCsrBase = _mm_getcsr();
    if (context) {
      IHostApplication* app = nullptr;
      if (context->queryInterface(IHostApplication::iid, reinterpret_cast<void**>(&app)) == kResultOk && app) {
        String128 name{};
        if (app->getName(name) == kResultOk) {
          hostName.clear();
          for (int i = 0; i < 128 && name[i]; i++) hostName += (name[i] > 32 && name[i] < 127) ? static_cast<char>(name[i]) : '_';
        }
        app->release();
      }
    }
    return kResultOk;
  }
  tresult PLUGIN_API terminate() override { return kResultOk; }

  // IComponent
  tresult PLUGIN_API getControllerClassId(TUID) override { return kNotImplemented; }
  tresult PLUGIN_API setIoMode(IoMode) override { return kResultOk; }
  int32 PLUGIN_API getBusCount(MediaType type, BusDirection) override { return type == kAudio ? 1 : 0; }
  tresult PLUGIN_API getBusInfo(MediaType type, BusDirection dir, int32 index, BusInfo& bus) override {
    if (type != kAudio || index != 0) return kInvalidArgument;
    bus.mediaType = kAudio;
    bus.direction = dir;
    bus.channelCount = dir == kOutput ? outChannels : 2;
    bus.busType = kMain;
    bus.flags = BusInfo::kDefaultActive;
    return kResultOk;
  }
  tresult PLUGIN_API getRoutingInfo(RoutingInfo&, RoutingInfo&) override { return kNotImplemented; }
  tresult PLUGIN_API activateBus(MediaType, BusDirection dir, int32, TBool state) override {
    note(dir == kInput ? (state ? "busIn1" : "busIn0") : (state ? "busOut1" : "busOut0"));
    return kResultOk;
  }
  tresult PLUGIN_API setActive(TBool state) override {
    note(state ? "act1" : "act0");
    if (state) activations++;
    else deactivations++;
    return kResultOk;
  }
  tresult PLUGIN_API setState(IBStream* s) override {
    const unsigned csr = _mm_getcsr();
    hostCsrAtSet = csr;
    if ((csr & ~0x3Fu) != (hostCsrBase & ~0x3Fu)) hostCsrBad++;  // (bits 0-5: sticky exception flags, not control)
    note("setState");
    char b[512] = {};
    int32 n = 0;
    if (s) s->read(b, sizeof b - 1, &n);
    const std::string cmd(b, b + (n > 0 ? n : 0));
    auto restart = [this](int32 flags) {
      if (handler) handler->restartComponent(flags);
    };
    auto arg = [&cmd](size_t at) { return std::atoi(cmd.c_str() + at); };
    if (cmd.rfind("LAT:", 0) == 0) {
      setLatency(arg(4));
      restart(kLatencyChanged);
    } else if (cmd.rfind("SILENTLAT:", 0) == 0) {
      setLatency(arg(10));
    } else if (cmd.rfind("IO:", 0) == 0) {
      outChannels = arg(3) == 1 ? 1 : 2;
      restart(kIoChanged);
    } else if (cmd == "RELOAD") {
      restart(kReloadComponent);
    } else if (cmd.rfind("RTLAT:", 0) == 0) {
      rtLatency.store(arg(6));
    } else if (cmd.rfind("RESTART:", 0) == 0) {
      restart(arg(8));
    } else if (cmd.rfind("PARAMS:", 0) == 0) {
      paramCount.store(arg(7) < 0 ? 0 : arg(7));
      restart(kParamTitlesChanged);
    } else if (cmd.rfind("EDITS:", 0) == 0) {
      for (int i = 0; i < arg(6) && handler; i++) handler->performEdit(static_cast<ParamID>(1000 + i), 0.5);
    } else if (cmd.rfind("SLEEP:", 0) == 0) {
      const char* k = std::strchr(cmd.c_str() + 6, ':');
      sleepMs.store(arg(6));
      sleepCalls.store(k ? std::atoi(k + 1) : 1);
    } else if (cmd == "CRASH") {
      crashNext.store(true);
    } else if (cmd.rfind("LOG:", 0) == 0) {
      logDump.store(arg(4) < 0 ? 0 : (arg(4) > kLog / 2 ? kLog / 2 : arg(4)));
    } else if (cmd.rfind("SEQ:", 0) == 0) {
      std::lock_guard<std::mutex> lk(seqM);
      seq.clear();
    } else if (cmd.rfind("calls=", 0) == 0) {
      // our own report given back (a reload restores the previous state): keep the latency
      const char* l = std::strstr(cmd.c_str(), " latency=");
      if (l) latencyAt48k = static_cast<int>(std::atoi(l + 9) * 48000.0 / rate);
    }
    // like a plugin that changes the FP environment and never puts it back
    _mm_setcsr((csr & ~0x6000u) | 0x2000u | 0x8040u);
    return kResultOk;
  }
  tresult PLUGIN_API getState(IBStream* s) override {
    const unsigned csr = _mm_getcsr();
    hostCsrAtGet = csr;
    if ((csr & ~0x3Fu) != (hostCsrBase & ~0x3Fu)) hostCsrBad++;
    if (!s) return kResultOk;
    std::string text;
    const int dump = logDump.load();
    if (dump > 0) {
      // the last `dump` records (the ring is twice as long: never overwritten while read)
      const int64 count = logCount.load(std::memory_order_acquire);
      const int64 first = count > dump ? count - dump : 0;
      char line[256];
      text = "LOG\n";
      for (int64 i = first; i < count; i++) {
        const BlockRecord& r = log[static_cast<size_t>(i % kLog)];
        std::snprintf(line, sizeof line, "%lld %lld %u %.9f %.12f %.9f %lld %lld %.9g %d %u\n", static_cast<long long>(i),
                      static_cast<long long>(r.cont), r.state, r.tempo, r.ppq, r.bar, static_cast<long long>(r.proj),
                      static_cast<long long>(r.sys), static_cast<double>(r.firstIn), r.frames, r.csr);
        text += line;
      }
    } else {
      char t[1400];
      std::string order;
      {
        std::lock_guard<std::mutex> lk(seqM);
        order = seq.empty() ? "-" : seq;
      }
      std::snprintf(t, sizeof t,
                    "calls=%d ftzDazAtEntry=%d nullLists=%d activations=%d deactivations=%d compStateSync=%d handler2=%d "
                    "state=%u tempo=%.6f ppq=%.9f bar=%.6f proj=%lld cont=%lld sys=%lld latency=%d rate=%.0f out=%d "
                    "instances=%d spyVersion=2 mxcsrBad=%d mxcsrFirst=%u mxcsrLast=%u hostCsrBase=%u hostCsrAtSet=%u "
                    "hostCsrAtGet=%u hostCsrBad=%d edits=%d params=%d host=%s seq=",
                    calls.load(), ftzOk.load(), nullLists.load(), activations.load(), deactivations.load(), compState.load(),
                    hasHandler2 ? 1 : 0, ctxState, tempo, ppq, bar, static_cast<long long>(proj), static_cast<long long>(cont),
                    static_cast<long long>(sys), latency(), rate, outChannels, gInstances.load(), mxcsrBad.load(),
                    mxcsrFirst.load(), mxcsrLast.load(), hostCsrBase, hostCsrAtSet, hostCsrAtGet, hostCsrBad.load(),
                    edits.load(), paramCount.load(), hostName.empty() ? "-" : hostName.c_str());
      text = t;
      text += order;
    }
    int32 w = 0;
    s->write(text.data(), static_cast<int32>(text.size()), &w);
    return kResultOk;
  }

  // IAudioProcessor
  tresult PLUGIN_API setBusArrangements(SpeakerArrangement*, int32, SpeakerArrangement*, int32) override {
    note("arr");
    return kResultTrue;
  }
  tresult PLUGIN_API getBusArrangement(BusDirection dir, int32, SpeakerArrangement& arr) override {
    arr = (dir == kOutput && outChannels == 1) ? SpeakerArr::kMono : SpeakerArr::kStereo;
    return kResultOk;
  }
  tresult PLUGIN_API canProcessSampleSize(int32 s) override {
    note("canss");
    return s == kSample32 ? kResultTrue : kResultFalse;
  }
  uint32 PLUGIN_API getLatencySamples() override {
    note("lat");
    return static_cast<uint32>(latency());
  }
  tresult PLUGIN_API setupProcessing(ProcessSetup& setup) override {
    note("setup");
    rate = setup.sampleRate;
    return kResultOk;
  }
  tresult PLUGIN_API setProcessing(TBool state) override {
    note(state ? "proc1" : "proc0");
    return kResultOk;
  }
  tresult PLUGIN_API process(ProcessData& d) override {
    const unsigned csr = _mm_getcsr();
    const int c = calls++;
    if ((csr & 0x8040u) == 0x8040u) ftzOk++;
    if ((csr & ~0x3Fu) != 0x9FC0u) mxcsrBad++;  // FTZ | DAZ | every exception masked | round to nearest
    if (c == 0) mxcsrFirst = csr;
    mxcsrLast = csr;
    if (crashNext.exchange(false)) {
      volatile int* p = nullptr;
      *p = 42;
    }
    if (sleepCalls.load() > 0) {
      sleepCalls--;
      spinMs(sleepMs.load());
    }
    const int rt = rtLatency.exchange(-1);
    if (rt >= 0) {
      setLatency(rt);
      if (handler) handler->restartComponent(kLatencyChanged);  // from the audio thread, as some plugins do
    }
    if (!d.inputParameterChanges || !d.outputParameterChanges || !d.inputEvents || !d.outputEvents) nullLists++;
    if (d.inputParameterChanges) {
      int points = 0;
      for (int32 i = 0; i < d.inputParameterChanges->getParameterCount(); i++)
        if (IParamValueQueue* q = d.inputParameterChanges->getParameterData(i)) points += q->getPointCount();
      edits += points;
    }
    BlockRecord rec;
    rec.csr = csr;
    rec.frames = d.numSamples;
    if (d.processContext) {
      const ProcessContext& ctx = *d.processContext;
      ctxState = ctx.state;
      tempo = ctx.tempo;
      ppq = ctx.projectTimeMusic;
      bar = ctx.barPositionMusic;
      proj = ctx.projectTimeSamples;
      cont = ctx.continousTimeSamples;
      sys = ctx.systemTime;
      rec.cont = ctx.continousTimeSamples;
      rec.proj = ctx.projectTimeSamples;
      rec.sys = ctx.systemTime;
      rec.tempo = ctx.tempo;
      rec.ppq = ctx.projectTimeMusic;
      rec.bar = ctx.barPositionMusic;
      rec.state = ctx.state;
    }
    if (d.numInputs < 1 || d.numOutputs < 1) {
      pushRecord(rec);
      return kResultOk;
    }
    const int L = latency();
    const float* inL = d.inputs[0].channelBuffers32[0];
    const float* inR = d.inputs[0].channelBuffers32[1];
    rec.firstIn = d.numSamples > 0 ? inL[0] : 0.0f;
    for (int32 i = 0; i < d.numSamples; i++, pos++) {
      bufL[pos & kMask] = inL[i];
      bufR[pos & kMask] = inR[i];
      const float l = pos >= L ? bufL[(pos - L) & kMask] : 0.0f;
      const float r = pos >= L ? bufR[(pos - L) & kMask] : 0.0f;
      if (outChannels == 1) {
        d.outputs[0].channelBuffers32[0][i] = 0.5f * (l + r);
      } else {
        d.outputs[0].channelBuffers32[0][i] = l;
        d.outputs[0].channelBuffers32[1][i] = r;
      }
    }
    pushRecord(rec);
    _mm_setcsr((csr & ~0x8040u) | 0x6000u);  // leaves FTZ / DAZ off and rounding toward zero
    return kResultOk;
  }
  uint32 PLUGIN_API getTailSamples() override { return 0; }

  // IEditController (single component)
  tresult PLUGIN_API setComponentState(IBStream*) override {
    note("csync");
    compState++;
    return kResultOk;
  }
  int32 PLUGIN_API getParameterCount() override { return paramCount.load(); }
  tresult PLUGIN_API getParameterInfo(int32 index, ParameterInfo& info) override {
    if (index < 0 || index >= paramCount.load()) return kInvalidArgument;
    std::memset(&info, 0, sizeof info);
    info.id = static_cast<ParamID>(1000 + index);
    info.flags = ParameterInfo::kCanAutomate;
    const char* t = "Spy param";
    for (int i = 0; t[i]; i++) info.title[i] = static_cast<char16>(t[i]);
    return kResultOk;
  }
  tresult PLUGIN_API getParamStringByValue(ParamID, ParamValue, String128) override { return kNotImplemented; }
  tresult PLUGIN_API getParamValueByString(ParamID, TChar*, ParamValue&) override { return kNotImplemented; }
  ParamValue PLUGIN_API normalizedParamToPlain(ParamID, ParamValue v) override { return v; }
  ParamValue PLUGIN_API plainParamToNormalized(ParamID, ParamValue v) override { return v; }
  ParamValue PLUGIN_API getParamNormalized(ParamID) override { return 0; }
  tresult PLUGIN_API setParamNormalized(ParamID, ParamValue) override { return kResultOk; }
  tresult PLUGIN_API setComponentHandler(IComponentHandler* h) override {
    if (h) note("handler");
    if (handler) handler->release();
    handler = h;
    if (handler) {
      handler->addRef();
      void* h2 = nullptr;
      if (handler->queryInterface(IComponentHandler2::iid, &h2) == kResultOk && h2) {
        hasHandler2 = true;
        static_cast<IComponentHandler2*>(h2)->release();
      }
    }
    return kResultOk;
  }
  IPlugView* PLUGIN_API createView(FIDString) override { return nullptr; }

 private:
  int latency() const { return static_cast<int>(latencyAt48k * rate / 48000.0 + 0.5); }
  void setLatency(int n) { latencyAt48k = static_cast<int>(n * 48000.0 / rate + 0.5); }
  // the host's lifecycle calls, in order ("seq=a,b,c")
  void note(const char* what) {
    std::lock_guard<std::mutex> lk(seqM);
    if (seq.size() > 3000) seq.erase(0, seq.size() - 2000);
    if (!seq.empty()) seq += ',';
    seq += what;
  }
  void pushRecord(const BlockRecord& r) {
    const int64 i = logCount.load(std::memory_order_relaxed);
    log[static_cast<size_t>(i % kLog)] = r;
    logCount.store(i + 1, std::memory_order_release);
  }

  static constexpr int64 kSize = int64(1) << 18, kMask = kSize - 1;
  static constexpr int kLog = 16384;
  std::atomic<int32> ref{1};
  IComponentHandler* handler = nullptr;
  bool hasHandler2 = false;
  int latencyAt48k = 64;
  double rate = 48000;
  int outChannels = 2;
  std::vector<float> bufL, bufR;
  int64 pos = 0;
  std::atomic<int> calls{0}, ftzOk{0}, nullLists{0}, activations{0}, deactivations{0}, compState{0};
  std::atomic<int> mxcsrBad{0}, hostCsrBad{0}, edits{0}, paramCount{0};
  std::atomic<unsigned> mxcsrFirst{0}, mxcsrLast{0};
  unsigned hostCsrBase = 0, hostCsrAtSet = 0, hostCsrAtGet = 0;
  std::atomic<int> rtLatency{-1}, sleepMs{0}, sleepCalls{0}, logDump{0};
  std::atomic<bool> crashNext{false};
  uint32 ctxState = 0;
  double tempo = 0, ppq = 0, bar = 0;
  int64 proj = 0, cont = 0, sys = 0;
  std::vector<BlockRecord> log;
  std::atomic<int64> logCount{0};
  std::mutex seqM;
  std::string seq;
  std::string hostName;
};

struct ClassDef {
  const TUID* cid;
  const char* name;
  const char* subCategories;
};
const ClassDef kClasses[] = {
    {&kCid, "OM Spy", "Fx|Delay"},
    {&kCidSynth, "OM Spy Synth", "Instrument|Synth"},
    {&kCidOffline, "OM Spy Offline", "Fx|OnlyOfflineProcess"},
    {&kCidVocoder, "OM Spy Vocoder", "Instrument|Fx"},
};
constexpr int32 kNumClasses = static_cast<int32>(sizeof(kClasses) / sizeof(kClasses[0]));

class Factory : public IPluginFactory2 {
 public:
  tresult PLUGIN_API queryInterface(const TUID iid, void** obj) override {
    if (FUnknownPrivate::iidEqual(iid, IPluginFactory2::iid) || FUnknownPrivate::iidEqual(iid, IPluginFactory::iid) ||
        FUnknownPrivate::iidEqual(iid, FUnknown::iid)) {
      *obj = static_cast<IPluginFactory2*>(this);
      return kResultOk;
    }
    *obj = nullptr;
    return kNoInterface;
  }
  uint32 PLUGIN_API addRef() override { return 1; }
  uint32 PLUGIN_API release() override { return 1; }
  tresult PLUGIN_API getFactoryInfo(PFactoryInfo* info) override {
    std::memset(info, 0, sizeof(*info));
    std::strcpy(info->vendor, "OpenMix tests");
    info->flags = PFactoryInfo::kUnicode;
    return kResultOk;
  }
  int32 PLUGIN_API countClasses() override { return kNumClasses; }
  tresult PLUGIN_API getClassInfo(int32 index, PClassInfo* info) override {
    if (index < 0 || index >= kNumClasses) return kInvalidArgument;
    std::memset(info, 0, sizeof(*info));
    std::memcpy(info->cid, *kClasses[index].cid, sizeof(TUID));
    info->cardinality = PClassInfo::kManyInstances;
    std::strcpy(info->category, kVstAudioEffectClass);
    std::strcpy(info->name, kClasses[index].name);
    return kResultOk;
  }
  tresult PLUGIN_API getClassInfo2(int32 index, PClassInfo2* info) override {
    if (index < 0 || index >= kNumClasses) return kInvalidArgument;
    std::memset(info, 0, sizeof(*info));
    std::memcpy(info->cid, *kClasses[index].cid, sizeof(TUID));
    info->cardinality = PClassInfo::kManyInstances;
    std::strcpy(info->category, kVstAudioEffectClass);
    std::strcpy(info->name, kClasses[index].name);
    std::strcpy(info->subCategories, kClasses[index].subCategories);
    std::strcpy(info->vendor, "OpenMix tests");
    std::strcpy(info->version, "2.0.0");
    std::strcpy(info->sdkVersion, kVstVersionString);
    return kResultOk;
  }
  tresult PLUGIN_API createInstance(FIDString cid, FIDString iid, void** obj) override {
    bool known = false;
    for (const ClassDef& c : kClasses) known = known || std::memcmp(cid, *c.cid, sizeof(TUID)) == 0;
    if (!known) {
      *obj = nullptr;
      return kNoInterface;
    }
    auto* p = new Spy();
    const tresult r = p->queryInterface(iid, obj);
    p->release();
    return r;
  }
};
Factory gFactory;

}  // namespace

extern "C" __declspec(dllexport) IPluginFactory* PLUGIN_API GetPluginFactory() { return &gFactory; }
extern "C" __declspec(dllexport) bool PLUGIN_API InitDll() { return true; }
extern "C" __declspec(dllexport) bool PLUGIN_API ExitDll() { return true; }
