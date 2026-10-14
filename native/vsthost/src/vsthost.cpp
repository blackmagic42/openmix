// OpenMix VST3 host — Node-API module (Windows).
//
// Hosts VST3 effect plugins as INSERTS on the decks. The audio itself never
// crosses JavaScript: each insert slot shares a ring buffer (a
// SharedArrayBuffer) with an AudioWorklet in the page. The worklet writes
// 128-frame blocks in, this module's real-time thread runs the plugin on
// them and writes the processed blocks out; the worklet plays them back a
// fixed number of blocks later. That fixed latency is reported to the
// engine, which reads the track that much ahead so the beat grid stays in
// sync (the same mechanism as the keylock transposer).
//
// Threads:
//  - the HOST thread: a Win32 message loop. Every VST3 call except
//    process() is made from it (the SDK requires a single "UI" thread),
//    and the plugin editors live there.
//  - the AUDIO thread: MMCSS "Pro Audio" priority, wakes every 0.5 ms
//    (high-resolution waitable timer) and processes whatever blocks the
//    worklets have written.
//  - the calling JS thread (a Web Worker with Node) only posts tasks to the
//    host thread and waits for their result.
//
// Shared ring layout (per slot), see RING_* below:
//   Int32 header[16]: [0] blocks written by the worklet, [1] blocks
//   processed here, [2] flags, [3] underruns (worklet), [4] block frames,
//   [5] ring blocks, [6] channels; Float32 header[8] = deck BPM (0 = none)
//   then the input ring and the output ring (ringBlocks × 2 ch × frames).

#define NOMINMAX
#include <windows.h>
#include <avrt.h>
#include <napi.h>

#include <atomic>
#include <cstring>
#include <deque>
#include <functional>
#include <future>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "public.sdk/source/vst/hosting/module.h"
#include "public.sdk/source/vst/hosting/hostclasses.h"
#include "public.sdk/source/vst/hosting/plugprovider.h"
#include "public.sdk/source/vst/hosting/processdata.h"
#include "public.sdk/source/vst/hosting/parameterchanges.h"

#include "public.sdk/source/common/memorystream.h"
#include "pluginterfaces/base/ibstream.h"
#include "pluginterfaces/gui/iplugview.h"
#include "pluginterfaces/vst/ivstaudioprocessor.h"
#include "pluginterfaces/vst/ivsteditcontroller.h"
#include "pluginterfaces/vst/ivstprocesscontext.h"
#include "pluginterfaces/vst/vstspeaker.h"

using namespace Steinberg;
using namespace Steinberg::Vst;

namespace {

constexpr int MAX_SLOTS = 8;
constexpr int RING_HDR_INTS = 16;
constexpr int H_IN = 0, H_OUT = 1, H_FLAGS = 2, H_UNDER = 3, H_FRAMES = 4, H_BLOCKS = 5, H_CH = 6, H_BPM = 8;
constexpr UINT WM_OM_TASK = WM_APP + 1;

// ---------------------------------------------------------------------------
// Atomic access to the shared ring header (plain int32 in shared memory)
// ---------------------------------------------------------------------------
inline int32_t loadAcq(volatile int32_t* p) {
  int32_t v = *p;
  MemoryBarrier();
  return v;
}
inline void storeRel(volatile int32_t* p, int32_t v) {
  MemoryBarrier();
  *p = v;
  MemoryBarrier();
}

// ---------------------------------------------------------------------------
// Host thread: Win32 message loop + task queue (message-only window, so
// tasks still run while a plugin shows a modal dialog)
// ---------------------------------------------------------------------------
class HostThread {
 public:
  void start() {
    std::promise<void> ready;
    auto fut = ready.get_future();
    thread_ = std::thread([this, &ready] { run(ready); });
    fut.wait();
  }

  void stop() {
    if (!thread_.joinable()) return;
    call([] { PostQuitMessage(0); });
    thread_.join();
  }

  // Runs f on the host thread and returns its result (blocks the caller)
  template <class F>
  auto call(F f) -> decltype(f()) {
    using R = decltype(f());
    if (GetCurrentThreadId() == tid_) return f();
    auto task = std::make_shared<std::packaged_task<R()>>(std::move(f));
    auto fut = task->get_future();
    {
      std::lock_guard<std::mutex> lk(m_);
      q_.push_back([task] { (*task)(); });
    }
    PostMessageW(hwnd_, WM_OM_TASK, 0, 0);
    return fut.get();
  }

 private:
  static LRESULT CALLBACK wndProc(HWND h, UINT msg, WPARAM wp, LPARAM lp) {
    if (msg == WM_OM_TASK) {
      auto* self = reinterpret_cast<HostThread*>(GetWindowLongPtrW(h, GWLP_USERDATA));
      if (self) self->drain();
      return 0;
    }
    return DefWindowProcW(h, msg, wp, lp);
  }

  void drain() {
    for (;;) {
      std::function<void()> f;
      {
        std::lock_guard<std::mutex> lk(m_);
        if (q_.empty()) return;
        f = std::move(q_.front());
        q_.pop_front();
      }
      f();
    }
  }

  void run(std::promise<void>& ready) {
    tid_ = GetCurrentThreadId();
    OleInitialize(nullptr);  // some plugin editors use drag & drop / COM
    WNDCLASSW wc{};
    wc.lpfnWndProc = wndProc;
    wc.hInstance = GetModuleHandleW(nullptr);
    wc.lpszClassName = L"OpenMixVstHostTasks";
    RegisterClassW(&wc);
    hwnd_ = CreateWindowExW(0, wc.lpszClassName, L"", 0, 0, 0, 0, 0, HWND_MESSAGE, nullptr, wc.hInstance, nullptr);
    SetWindowLongPtrW(hwnd_, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(this));
    ready.set_value();
    MSG msg;
    while (GetMessageW(&msg, nullptr, 0, 0) > 0) {
      TranslateMessage(&msg);
      DispatchMessageW(&msg);
    }
    DestroyWindow(hwnd_);
    OleUninitialize();
  }

  std::thread thread_;
  DWORD tid_ = 0;
  HWND hwnd_ = nullptr;
  std::mutex m_;
  std::deque<std::function<void()>> q_;
};

// ---------------------------------------------------------------------------
// Parameter edits from the plugin's editor → audio thread
// ---------------------------------------------------------------------------
class ComponentHandler : public IComponentHandler {
 public:
  ParameterChangeTransfer* transfer = nullptr;
  std::atomic<bool> latencyChanged{false};

  tresult PLUGIN_API beginEdit(ParamID) override { return kResultOk; }
  tresult PLUGIN_API performEdit(ParamID id, ParamValue v) override {
    if (transfer) transfer->addChange(id, v, 0);
    return kResultOk;
  }
  tresult PLUGIN_API endEdit(ParamID) override { return kResultOk; }
  tresult PLUGIN_API restartComponent(int32 flags) override {
    if (flags & kLatencyChanged) latencyChanged = true;
    return kResultOk;
  }
  tresult PLUGIN_API queryInterface(const TUID iid, void** obj) override {
    if (FUnknownPrivate::iidEqual(iid, IComponentHandler::iid) || FUnknownPrivate::iidEqual(iid, FUnknown::iid)) {
      *obj = static_cast<IComponentHandler*>(this);
      return kResultOk;
    }
    *obj = nullptr;
    return kNoInterface;
  }
  uint32 PLUGIN_API addRef() override { return 1; }
  uint32 PLUGIN_API release() override { return 1; }
};

struct Slot;

// Editor window frame: lets the plugin resize its own window
class PlugFrame : public IPlugFrame {
 public:
  HWND hwnd = nullptr;
  tresult PLUGIN_API resizeView(IPlugView* view, ViewRect* r) override {
    if (!hwnd || !r) return kResultFalse;
    RECT rc{0, 0, r->getWidth(), r->getHeight()};
    AdjustWindowRectEx(&rc, GetWindowLongW(hwnd, GWL_STYLE), FALSE, GetWindowLongW(hwnd, GWL_EXSTYLE));
    SetWindowPos(hwnd, nullptr, 0, 0, rc.right - rc.left, rc.bottom - rc.top, SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE);
    if (view) view->onSize(r);
    return kResultTrue;
  }
  tresult PLUGIN_API queryInterface(const TUID iid, void** obj) override {
    if (FUnknownPrivate::iidEqual(iid, IPlugFrame::iid) || FUnknownPrivate::iidEqual(iid, FUnknown::iid)) {
      *obj = static_cast<IPlugFrame*>(this);
      return kResultOk;
    }
    *obj = nullptr;
    return kNoInterface;
  }
  uint32 PLUGIN_API addRef() override { return 1; }
  uint32 PLUGIN_API release() override { return 1; }
};

// ---------------------------------------------------------------------------
// One insert slot (one per deck)
// ---------------------------------------------------------------------------
struct Slot {
  std::mutex lock;                 // held by the host thread while (un)loading
  std::atomic<bool> active{false};
  std::atomic<bool> crashed{false};

  VST3::Hosting::Module::Ptr module;
  IPtr<PlugProvider> provider;
  IPtr<IComponent> component;
  IPtr<IAudioProcessor> processor;
  IPtr<IEditController> controller;
  HostProcessData data;
  ParameterChanges inChanges;
  ParameterChangeTransfer transfer;
  ComponentHandler handler;
  ProcessContext context{};
  int32 inCh = 2, outCh = 2;
  int32 latency = 0;
  std::string name;

  // shared ring
  volatile int32_t* hdr = nullptr;
  float* inRing = nullptr;
  float* outRing = nullptr;
  int32_t frames = 128, blocks = 0;
  uint32_t processed = 0;
  Napi::Reference<Napi::Value> ringRef;  // keeps the SharedArrayBuffer alive

  // editor
  IPtr<IPlugView> view;
  PlugFrame frame;
  HWND editor = nullptr;
};

HostThread gHost;
std::thread gAudio;
std::atomic<bool> gRunning{false};
double gSampleRate = 48000;
int32 gBlock = 128;
Slot gSlots[MAX_SLOTS];
IPtr<HostApplication> gHostApp;

// A crash inside a plugin must not take OpenMix down with it: process() is
// called under SEH; an access violation disables the slot instead.
int safeProcess(IAudioProcessor* p, ProcessData* d) {
  __try {
    return p->process(*d) == kResultOk ? 1 : 0;
  } __except (EXCEPTION_EXECUTE_HANDLER) {
    return -1;
  }
}

void processBlock(Slot& s, int idx) {
  const int32_t F = s.frames;
  float* in = s.inRing + static_cast<size_t>(idx) * 2 * F;
  float* out = s.outRing + static_cast<size_t>(idx) * 2 * F;
  auto& ins = s.data.inputs[0];
  auto& outs = s.data.outputs[0];
  // input: stereo → bus channels (mono bus = average)
  if (s.inCh >= 2) {
    std::memcpy(ins.channelBuffers32[0], in, F * sizeof(float));
    std::memcpy(ins.channelBuffers32[1], in + F, F * sizeof(float));
    for (int32 c = 2; c < s.inCh; c++) std::memset(ins.channelBuffers32[c], 0, F * sizeof(float));
  } else if (s.inCh == 1) {
    for (int32_t i = 0; i < F; i++) ins.channelBuffers32[0][i] = 0.5f * (in[i] + in[F + i]);
  }
  // tempo of the deck for tempo-synced effects (delays, LFOs…)
  float bpm;
  std::memcpy(&bpm, const_cast<int32_t*>(&s.hdr[H_BPM]), sizeof(float));
  s.context.sampleRate = gSampleRate;
  s.context.state = ProcessContext::kPlaying | ProcessContext::kSystemTimeValid;
  if (bpm > 20.f && bpm < 400.f) {
    s.context.state |= ProcessContext::kTempoValid | ProcessContext::kTimeSigValid | ProcessContext::kProjectTimeMusicValid;
    s.context.tempo = bpm;
    s.context.timeSigNumerator = 4;
    s.context.timeSigDenominator = 4;
    s.context.projectTimeMusic = static_cast<double>(s.context.projectTimeSamples) / gSampleRate * bpm / 60.0;
  }
  s.inChanges.clearQueue();
  s.transfer.transferChangesTo(s.inChanges);
  s.data.numSamples = F;
  int r = safeProcess(s.processor, &s.data);
  s.context.projectTimeSamples += F;
  if (r < 0) {
    s.crashed = true;
    s.active = false;
    std::memcpy(out, in, 2 * F * sizeof(float));
    return;
  }
  // output: bus channels → stereo
  if (s.outCh >= 2) {
    std::memcpy(out, outs.channelBuffers32[0], F * sizeof(float));
    std::memcpy(out + F, outs.channelBuffers32[1], F * sizeof(float));
  } else if (s.outCh == 1) {
    std::memcpy(out, outs.channelBuffers32[0], F * sizeof(float));
    std::memcpy(out + F, outs.channelBuffers32[0], F * sizeof(float));
  }
}

bool serviceSlot(Slot& s) {
  if (!s.active || !s.hdr) return false;
  std::unique_lock<std::mutex> lk(s.lock, std::try_to_lock);
  if (!lk.owns_lock() || !s.active) return false;
  bool did = false;
  int32_t written = loadAcq(&s.hdr[H_IN]);
  // way behind (stalled plugin, sleep…): skip to the present
  if (static_cast<int32_t>(written - s.processed) > s.blocks - 2) s.processed = static_cast<uint32_t>(written) - 1;
  while (static_cast<int32_t>(written - static_cast<int32_t>(s.processed)) > 0) {
    processBlock(s, static_cast<int>(s.processed % static_cast<uint32_t>(s.blocks)));
    s.processed++;
    storeRel(&s.hdr[H_OUT], static_cast<int32_t>(s.processed));
    did = true;
    if (!s.active) break;
  }
  return did;
}

void audioLoop() {
  DWORD taskIndex = 0;
  HANDLE mmcss = AvSetMmThreadCharacteristicsW(L"Pro Audio", &taskIndex);
  if (!mmcss) SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_TIME_CRITICAL);
  HANDLE timer = CreateWaitableTimerExW(nullptr, nullptr, CREATE_WAITABLE_TIMER_HIGH_RESOLUTION, TIMER_ALL_ACCESS);
  if (!timer) timer = CreateWaitableTimerW(nullptr, TRUE, nullptr);
  while (gRunning) {
    bool did = false;
    for (auto& s : gSlots) did |= serviceSlot(s);
    if (!did) {
      LARGE_INTEGER due;
      due.QuadPart = -5000;  // 0.5 ms (100 ns units, relative)
      SetWaitableTimer(timer, &due, 0, nullptr, nullptr, FALSE);
      WaitForSingleObject(timer, 5);
    }
  }
  CloseHandle(timer);
  if (mmcss) AvRevertMmThreadCharacteristics(mmcss);
}

// ---------------------------------------------------------------------------
// Plugin lifecycle (host thread only)
// ---------------------------------------------------------------------------
void closeEditorOnHost(Slot& s) {
  if (s.view) {
    s.view->setFrame(nullptr);
    s.view->removed();
    s.view = nullptr;
  }
  if (s.editor) {
    HWND h = s.editor;
    s.editor = nullptr;
    s.frame.hwnd = nullptr;
    DestroyWindow(h);
  }
}

void unloadOnHost(Slot& s) {
  closeEditorOnHost(s);
  std::lock_guard<std::mutex> lk(s.lock);
  s.active = false;
  if (s.processor) {
    s.processor->setProcessing(false);
  }
  if (s.component) s.component->setActive(false);
  s.data.unprepare();
  s.processor = nullptr;
  s.controller = nullptr;
  s.component = nullptr;
  s.provider = nullptr;  // terminates and disconnects component/controller
  s.module = nullptr;
  s.name.clear();
  s.latency = 0;
  s.crashed = false;
}

std::string loadOnHost(Slot& s, const std::string& path, const std::string& uid) {
  unloadOnHost(s);
  std::string err;
  auto module = VST3::Hosting::Module::create(path, err);
  if (!module) return err.empty() ? "cannot load module" : err;
  auto factory = module->getFactory();
  VST3::Hosting::ClassInfo chosen;
  bool found = false;
  for (auto& ci : factory.classInfos()) {
    if (ci.category() != kVstAudioEffectClass) continue;
    if (uid.empty() || ci.ID().toString() == uid) {
      chosen = ci;
      found = true;
      break;
    }
  }
  if (!found) return "no audio effect in this plugin";
  IPtr<PlugProvider> provider = owned(new PlugProvider(factory, chosen, true));
  if (!provider->initialize()) return "plugin failed to initialize";
  IPtr<IComponent> component = provider->getComponentPtr();
  IPtr<IEditController> controller = provider->getControllerPtr();
  FUnknownPtr<IAudioProcessor> processor(component);
  if (!component || !processor) return "not an audio processor";

  // stereo in, stereo out (main buses only; side-chains stay off)
  SpeakerArrangement stereoIn = SpeakerArr::kStereo, stereoOut = SpeakerArr::kStereo;
  int32 nIn = component->getBusCount(kAudio, kInput);
  int32 nOut = component->getBusCount(kAudio, kOutput);
  if (nOut < 1) return "plugin has no audio output";
  std::vector<SpeakerArrangement> inArr(nIn, SpeakerArr::kStereo), outArr(nOut, SpeakerArr::kStereo);
  processor->setBusArrangements(nIn ? inArr.data() : nullptr, nIn, outArr.data(), nOut);
  for (int32 i = 0; i < nIn; i++) component->activateBus(kAudio, kInput, i, i == 0);
  for (int32 i = 0; i < nOut; i++) component->activateBus(kAudio, kOutput, i, i == 0);
  BusInfo bi{};
  s.inCh = (nIn && component->getBusInfo(kAudio, kInput, 0, bi) == kResultOk) ? bi.channelCount : 0;
  s.outCh = component->getBusInfo(kAudio, kOutput, 0, bi) == kResultOk ? bi.channelCount : 2;

  ProcessSetup setup{kRealtime, kSample32, gBlock, gSampleRate};
  if (processor->setupProcessing(setup) != kResultOk) return "plugin refused the sample rate / block size";
  if (controller) {
    s.handler.transfer = &s.transfer;
    controller->setComponentHandler(&s.handler);
  }
  int32 nParams = controller ? controller->getParameterCount() : 0;
  s.transfer.setMaxParameters(std::max<int32>(nParams, 16));
  s.inChanges.setMaxParameters(std::max<int32>(nParams, 16));

  {
    std::lock_guard<std::mutex> lk(s.lock);
    s.module = module;
    s.provider = provider;
    s.component = component;
    s.controller = controller;
    s.processor = processor;
    s.data.prepare(*component, gBlock, kSample32);
    s.data.inputParameterChanges = &s.inChanges;
    s.data.processContext = &s.context;
    s.context = ProcessContext{};
    s.name = chosen.name();
    component->setActive(true);
    processor->setProcessing(true);
    s.latency = static_cast<int32>(processor->getLatencySamples());
    s.crashed = false;
    s.active = s.hdr != nullptr;
  }
  return "";
}

// Editor window
LRESULT CALLBACK editorProc(HWND h, UINT msg, WPARAM wp, LPARAM lp) {
  auto* s = reinterpret_cast<Slot*>(GetWindowLongPtrW(h, GWLP_USERDATA));
  switch (msg) {
    case WM_SIZE:
      if (s && s->view && s->view->canResize() == kResultTrue) {
        ViewRect r(0, 0, LOWORD(lp), HIWORD(lp));
        s->view->onSize(&r);
      }
      return 0;
    case WM_CLOSE:
      if (s) closeEditorOnHost(*s);
      else DestroyWindow(h);
      return 0;
  }
  return DefWindowProcW(h, msg, wp, lp);
}

std::string openEditorOnHost(Slot& s, HWND owner) {
  if (!s.controller) return "no plugin loaded";
  if (s.editor) {
    ShowWindow(s.editor, SW_SHOWNORMAL);
    SetForegroundWindow(s.editor);
    return "";
  }
  IPtr<IPlugView> view = owned(s.controller->createView(ViewType::kEditor));
  if (!view) return "this plugin has no editor";
  if (view->isPlatformTypeSupported(kPlatformTypeHWND) != kResultTrue) return "editor not supported on Windows";
  static bool registered = false;
  if (!registered) {
    WNDCLASSW wc{};
    wc.lpfnWndProc = editorProc;
    wc.hInstance = GetModuleHandleW(nullptr);
    wc.hCursor = LoadCursor(nullptr, IDC_ARROW);
    wc.hbrBackground = reinterpret_cast<HBRUSH>(GetStockObject(BLACK_BRUSH));
    wc.lpszClassName = L"OpenMixVstEditor";
    RegisterClassW(&wc);
    registered = true;
  }
  ViewRect vr{};
  if (view->getSize(&vr) != kResultTrue || vr.getWidth() <= 0) vr = ViewRect(0, 0, 640, 400);
  DWORD style = WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX;
  if (view->canResize() == kResultTrue) style |= WS_THICKFRAME | WS_MAXIMIZEBOX;
  RECT rc{0, 0, vr.getWidth(), vr.getHeight()};
  AdjustWindowRectEx(&rc, style, FALSE, 0);
  std::string utf8 = s.name + " \xE2\x80\x94 OpenMix";
  std::wstring title(MultiByteToWideChar(CP_UTF8, 0, utf8.c_str(), -1, nullptr, 0), L'\0');
  MultiByteToWideChar(CP_UTF8, 0, utf8.c_str(), -1, title.data(), static_cast<int>(title.size()));
  HWND h = CreateWindowExW(0, L"OpenMixVstEditor", title.c_str(), style, CW_USEDEFAULT, CW_USEDEFAULT,
                           rc.right - rc.left, rc.bottom - rc.top, owner, nullptr, GetModuleHandleW(nullptr), nullptr);
  if (!h) return "cannot create the editor window";
  SetWindowLongPtrW(h, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(&s));
  s.editor = h;
  s.frame.hwnd = h;
  view->setFrame(&s.frame);
  if (view->attached(h, kPlatformTypeHWND) != kResultTrue) {
    view->setFrame(nullptr);
    s.editor = nullptr;
    DestroyWindow(h);
    return "the editor refused to open";
  }
  s.view = view;
  ShowWindow(h, SW_SHOWNORMAL);
  return "";
}

// State = component state + controller state, framed with 32-bit lengths
std::string getStateOnHost(Slot& s) {
  if (!s.component) return "";
  MemoryStream comp, ctrl;
  s.component->getState(&comp);
  if (s.controller) s.controller->getState(&ctrl);
  std::string out;
  auto put = [&out](MemoryStream& m) {
    uint32_t n = static_cast<uint32_t>(m.getSize());
    out.append(reinterpret_cast<const char*>(&n), 4);
    out.append(m.getData(), n);
  };
  put(comp);
  put(ctrl);
  return out;
}

bool setStateOnHost(Slot& s, const std::string& blob) {
  if (!s.component || blob.size() < 8) return false;
  uint32_t n1;
  std::memcpy(&n1, blob.data(), 4);
  if (4 + n1 + 4 > blob.size()) return false;
  uint32_t n2;
  std::memcpy(&n2, blob.data() + 4 + n1, 4);
  if (8 + n1 + n2 > blob.size()) return false;
  std::lock_guard<std::mutex> lk(s.lock);
  MemoryStream comp(const_cast<char*>(blob.data() + 4), n1);
  s.component->setState(&comp);
  if (s.controller) {
    MemoryStream comp2(const_cast<char*>(blob.data() + 4), n1);
    s.controller->setComponentState(&comp2);
    if (n2) {
      MemoryStream ctrl(const_cast<char*>(blob.data() + 8 + n1), n2);
      s.controller->setState(&ctrl);
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------
struct Found {
  std::string path, name, vendor, uid, subCategories;
};

std::vector<Found> scanOnHost(const std::vector<std::string>& paths) {
  std::vector<Found> out;
  for (auto& p : paths) {
    std::string err;
    auto module = VST3::Hosting::Module::create(p, err);
    if (!module) continue;
    auto factory = module->getFactory();
    for (auto& ci : factory.classInfos()) {
      if (ci.category() != kVstAudioEffectClass) continue;
      out.push_back({p, ci.name(), ci.vendor(), ci.ID().toString(), ci.subCategoriesString()});
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// JavaScript API
// ---------------------------------------------------------------------------
Slot* slotArg(const Napi::CallbackInfo& info) {
  int i = info[0].As<Napi::Number>().Int32Value();
  if (i < 0 || i >= MAX_SLOTS) {
    Napi::RangeError::New(info.Env(), "bad slot").ThrowAsJavaScriptException();
    return nullptr;
  }
  return &gSlots[i];
}

Napi::Value Init(const Napi::CallbackInfo& info) {
  auto opts = info[0].As<Napi::Object>();
  if (gRunning) return Napi::Boolean::New(info.Env(), true);
  gSampleRate = opts.Get("sampleRate").As<Napi::Number>().DoubleValue();
  gBlock = opts.Get("blockSize").As<Napi::Number>().Int32Value();
  gHost.start();
  gHost.call([] {
    gHostApp = owned(new HostApplication());
    PluginContextFactory::instance().setPluginContext(gHostApp);
    return 0;
  });
  gRunning = true;
  gAudio = std::thread(audioLoop);
  return Napi::Boolean::New(info.Env(), true);
}

Napi::Value Scan(const Napi::CallbackInfo& info) {
  auto arr = info[0].As<Napi::Array>();
  std::vector<std::string> paths;
  for (uint32_t i = 0; i < arr.Length(); i++) paths.push_back(arr.Get(i).As<Napi::String>().Utf8Value());
  auto found = gHost.call([paths] { return scanOnHost(paths); });
  auto out = Napi::Array::New(info.Env(), found.size());
  for (size_t i = 0; i < found.size(); i++) {
    auto o = Napi::Object::New(info.Env());
    o.Set("path", found[i].path);
    o.Set("name", found[i].name);
    o.Set("vendor", found[i].vendor);
    o.Set("uid", found[i].uid);
    o.Set("subCategories", found[i].subCategories);
    out.Set(static_cast<uint32_t>(i), o);
  }
  return out;
}

// attach(slot, Int32Array over the shared ring)
Napi::Value Attach(const Napi::CallbackInfo& info) {
  Slot* s = slotArg(info);
  if (!s) return info.Env().Undefined();
  auto ta = info[1].As<Napi::TypedArray>();
  auto i32 = info[1].As<Napi::Int32Array>();
  int32_t* base = i32.Data();
  int32_t frames = base[H_FRAMES], blocks = base[H_BLOCKS];
  size_t need = (RING_HDR_INTS + static_cast<size_t>(blocks) * 2 * frames * 2) * 4;
  if (frames != gBlock || blocks < 4 || ta.ByteLength() < need) {
    Napi::Error::New(info.Env(), "bad ring buffer").ThrowAsJavaScriptException();
    return info.Env().Undefined();
  }
  std::lock_guard<std::mutex> lk(s->lock);
  s->ringRef = Napi::Persistent(info[1]);
  s->hdr = base;
  s->frames = frames;
  s->blocks = blocks;
  s->inRing = reinterpret_cast<float*>(base + RING_HDR_INTS);
  s->outRing = s->inRing + static_cast<size_t>(blocks) * 2 * frames;
  s->processed = static_cast<uint32_t>(loadAcq(&base[H_IN]));
  storeRel(&base[H_OUT], static_cast<int32_t>(s->processed));
  s->active = s->processor != nullptr;
  return Napi::Boolean::New(info.Env(), true);
}

Napi::Value Load(const Napi::CallbackInfo& info) {
  Slot* s = slotArg(info);
  if (!s) return info.Env().Undefined();
  std::string path = info[1].As<Napi::String>().Utf8Value();
  std::string uid = info.Length() > 2 && info[2].IsString() ? info[2].As<Napi::String>().Utf8Value() : "";
  std::string err = gHost.call([s, path, uid] { return loadOnHost(*s, path, uid); });
  auto o = Napi::Object::New(info.Env());
  o.Set("ok", err.empty());
  if (!err.empty()) {
    o.Set("error", err);
    return o;
  }
  o.Set("name", s->name);
  o.Set("latency", s->latency);
  o.Set("inputs", s->inCh);
  o.Set("outputs", s->outCh);
  return o;
}

Napi::Value Unload(const Napi::CallbackInfo& info) {
  Slot* s = slotArg(info);
  if (!s) return info.Env().Undefined();
  gHost.call([s] {
    unloadOnHost(*s);
    return 0;
  });
  return Napi::Boolean::New(info.Env(), true);
}

Napi::Value OpenEditor(const Napi::CallbackInfo& info) {
  Slot* s = slotArg(info);
  if (!s) return info.Env().Undefined();
  HWND owner = nullptr;
  if (info.Length() > 1 && info[1].IsBigInt()) {
    bool lossless;
    owner = reinterpret_cast<HWND>(static_cast<uintptr_t>(info[1].As<Napi::BigInt>().Uint64Value(&lossless)));
  }
  std::string err = gHost.call([s, owner] { return openEditorOnHost(*s, owner); });
  auto o = Napi::Object::New(info.Env());
  o.Set("ok", err.empty());
  if (!err.empty()) o.Set("error", err);
  return o;
}

Napi::Value CloseEditor(const Napi::CallbackInfo& info) {
  Slot* s = slotArg(info);
  if (!s) return info.Env().Undefined();
  gHost.call([s] {
    closeEditorOnHost(*s);
    return 0;
  });
  return Napi::Boolean::New(info.Env(), true);
}

Napi::Value GetState(const Napi::CallbackInfo& info) {
  Slot* s = slotArg(info);
  if (!s) return info.Env().Undefined();
  std::string blob = gHost.call([s] { return getStateOnHost(*s); });
  return Napi::Buffer<char>::Copy(info.Env(), blob.data(), blob.size());
}

Napi::Value SetState(const Napi::CallbackInfo& info) {
  Slot* s = slotArg(info);
  if (!s) return info.Env().Undefined();
  auto buf = info[1].As<Napi::Buffer<char>>();
  std::string blob(buf.Data(), buf.Length());
  bool ok = gHost.call([s, blob] { return setStateOnHost(*s, blob); });
  return Napi::Boolean::New(info.Env(), ok);
}

Napi::Value Status(const Napi::CallbackInfo& info) {
  Slot* s = slotArg(info);
  if (!s) return info.Env().Undefined();
  auto o = Napi::Object::New(info.Env());
  o.Set("loaded", s->processor != nullptr);
  o.Set("active", s->active.load());
  o.Set("crashed", s->crashed.load());
  o.Set("editorOpen", s->editor != nullptr);
  o.Set("processed", static_cast<double>(s->processed));
  bool latChanged = s->handler.latencyChanged.exchange(false);
  if (latChanged && s->processor) s->latency = static_cast<int32>(s->processor->getLatencySamples());
  o.Set("latency", s->latency);
  o.Set("latencyChanged", latChanged);
  return o;
}

Napi::Value Shutdown(const Napi::CallbackInfo& info) {
  if (!gRunning) return info.Env().Undefined();
  for (auto& s : gSlots) {
    gHost.call([&s] {
      unloadOnHost(s);
      return 0;
    });
    s.ringRef.Reset();
    s.hdr = nullptr;
  }
  gRunning = false;
  if (gAudio.joinable()) gAudio.join();
  gHost.call([] {
    PluginContextFactory::instance().setPluginContext(nullptr);
    gHostApp = nullptr;
    return 0;
  });
  gHost.stop();
  return info.Env().Undefined();
}

Napi::Object ModuleInit(Napi::Env env, Napi::Object exports) {
  exports.Set("init", Napi::Function::New(env, Init));
  exports.Set("scan", Napi::Function::New(env, Scan));
  exports.Set("attach", Napi::Function::New(env, Attach));
  exports.Set("load", Napi::Function::New(env, Load));
  exports.Set("unload", Napi::Function::New(env, Unload));
  exports.Set("openEditor", Napi::Function::New(env, OpenEditor));
  exports.Set("closeEditor", Napi::Function::New(env, CloseEditor));
  exports.Set("getState", Napi::Function::New(env, GetState));
  exports.Set("setState", Napi::Function::New(env, SetState));
  exports.Set("status", Napi::Function::New(env, Status));
  exports.Set("shutdown", Napi::Function::New(env, Shutdown));
  exports.Set("ringHeaderInts", Napi::Number::New(env, RING_HDR_INTS));
  return exports;
}

}  // namespace

NODE_API_MODULE(openmix_vsthost, ModuleInit)
