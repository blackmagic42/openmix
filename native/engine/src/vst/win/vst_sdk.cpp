// VST3 SDK side of the inline host, Windows (owner: decoder, library om_vst
// with OM_WITH_VST). Port of the HARDENED native/vsthost/src/vsthost.cpp
// (security round of 19-20 Oct 2026), without its Node-API layer, its
// shared ring and its polling audio thread: process() now runs on the deck
// workers of the portable shell (src/vst/vst_insert.cpp) through
// Inst::process(); everything else is the hardened host:
//  - the HOST thread: a Win32 message loop + task queue (message-only
//    window, OleInitialize). Every VST3 call except process() runs there;
//    tasks run only from the top of its loop, never from inside plugin code
//    (a plugin's own modal loop holds them back); callers wait with the
//    time-outs (load 60 s, editor 30 s, state 10 s, short 5 s) and wait for
//    a plugin window that waits for the user up to 600 s; a stalled host
//    thread makes new calls fail at once;
//  - CachedModule (a plugin DLL stays loaded until the process ends),
//    preloading with the plugin's own folder in the DLL search path,
//    UTF-8 -> wide paths (non-ASCII user folders), bundle layouts, DLL load
//    errors described in UTF-8 with their code (32-bit plugins);
//  - PlugProvider loading of the chosen audio effect class, stereo buses,
//    the VST3 setup order of the SDK's states (component handler, controller
//    synchronised with the component state, canProcessSampleSize and
//    setBusArrangements [Initialized], setupProcessing, then activateBus
//    [Setup Done], setActive, setProcessing) with checked results, non-null
//    parameter changes and event lists on both sides, IComponentHandler2;
//  - restartComponent: kLatencyChanged / kIoChanged deactivate and
//    reactivate the plugin (the VST3 rule) with the deck worker kept out,
//    then re-compensate the deck; kReloadComponent re-creates the plugin
//    with its state; kParamTitlesChanged grows the parameter queues off the
//    audio thread; the other flags are acknowledged;
//  - editors: a frame per view, sized by the plugin (resizeView,
//    checkSizeConstraint), DPI-aware (content scale, or a DPI-unaware frame
//    that Windows enlarges), keyboard passed on to the plugin's window,
//    reopened where it was closed, owned by OpenMix's window;
//  - state: component + controller state framed with 32-bit lengths (the
//    blobs the Web engine saved restore unchanged), the plugin's latency
//    re-read after a restore;
//  - safety: SEH around every plugin call; a fault abandons the plugin
//    (never called again, never freed); windows a crashed plugin left
//    disabled or on screen are put right (recoverWindows); dispatch faults
//    are attributed by module / window; dsp::FpEnvGuard around every call;
//  - scanning (separate process): moduleinfo.json first, else the module
//    loaded on a thread of its own with a time-out; instruments and
//    offline-only classes are not offered as inserts.
// SPEC.md §13.
#include <windows.h>
#include <ole2.h>
#include <malloc.h>

#include <algorithm>
#include <atomic>
#include <cctype>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <cstring>
#include <cwchar>
#include <deque>
#include <filesystem>
#include <fstream>
#include <functional>
#include <future>
#include <iterator>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <type_traits>
#include <vector>

#pragma warning(push, 0)
#include "pluginterfaces/base/ibstream.h"
#include "pluginterfaces/base/keycodes.h"
#include "pluginterfaces/gui/iplugview.h"
#include "pluginterfaces/gui/iplugviewcontentscalesupport.h"
#include "pluginterfaces/vst/ivstaudioprocessor.h"
#include "pluginterfaces/vst/ivsteditcontroller.h"
#include "pluginterfaces/vst/ivstprocesscontext.h"
#include "pluginterfaces/vst/vstspeaker.h"
#include "pluginterfaces/vst/vsttypes.h"
#include "public.sdk/source/common/memorystream.h"
#include "public.sdk/source/vst/hosting/eventlist.h"
#include "public.sdk/source/vst/hosting/hostclasses.h"
#include "public.sdk/source/vst/hosting/module.h"
#include "public.sdk/source/vst/hosting/parameterchanges.h"
#include "public.sdk/source/vst/hosting/plugprovider.h"
#include "public.sdk/source/vst/hosting/processdata.h"
#include "public.sdk/source/vst/moduleinfo/moduleinfoparser.h"
#pragma warning(pop)

#include "../vst_backend.h"
#include "om/dsp.h"

namespace om {
namespace vstbk {
namespace {

using namespace Steinberg;
using namespace Steinberg::Vst;

constexpr int kMaxSlots = 32;  // 8 VstHost instances x 4 decks
constexpr UINT WM_OM_TASK = WM_APP + 1;     // a task was queued
constexpr UINT WM_OM_PING = WM_APP + 2;     // the host thread answers again
constexpr UINT WM_OM_CRASHED = WM_APP + 3;  // wParam = slot whose plugin faulted
constexpr UINT WM_OM_RESTART = WM_APP + 4;  // wParam = slot whose plugin called restartComponent
constexpr UINT WM_OM_CLOSE = WM_APP + 5;    // wParam = slot whose editor window was closed
constexpr unsigned kEventKinds = 3;         // WM_OM_CRASHED ... WM_OM_CLOSE

// Time-outs (ms), set by VstHost::setTimeouts (process-wide, like the
// hardened host's).
struct Timeouts {
  std::atomic<DWORD> load{60000};
  std::atomic<DWORD> editor{30000};
  std::atomic<DWORD> scan{30000};
  std::atomic<DWORD> state{10000};
  std::atomic<DWORD> shortOp{5000};
  std::atomic<DWORD> quiesce{2000};
  std::atomic<DWORD> dialog{600000};
};
Timeouts gTimeouts;

// Test options: editors off-screen without activation; a pretended scale
std::atomic<bool> gEditorsOffscreen{false};
std::atomic<float> gEditorScale{0.f};
std::atomic<HWND> gOwner{nullptr};  // OpenMix's window (editors' owner; re-enabled after a crashed modal dialog)

// ---------------------------------------------------------------------------
// SEH guard: runs plugin code and catches a hardware fault (access
// violation, stack overflow, an exception the plugin let escape...). The
// __try lives in a function without C++ objects (MSVC rule); C++ locals in
// the guarded code are not destroyed after a fault, so no lock may be held
// across guarded code.
// ---------------------------------------------------------------------------
struct Fault {
  DWORD code = 0;
  void* address = nullptr;
};

int captureFault(EXCEPTION_POINTERS* ep, Fault* f) {
  if (f && ep && ep->ExceptionRecord) {
    f->code = ep->ExceptionRecord->ExceptionCode;
    f->address = ep->ExceptionRecord->ExceptionAddress;
  }
  return EXCEPTION_EXECUTE_HANDLER;
}

int sehRun(void (*fn)(void*), void* ctx, Fault* f) {
  __try {
    fn(ctx);
    return 1;
  } __except (captureFault(GetExceptionInformation(), f)) {
    return 0;
  }
}

// Set on a thread whenever a fault was caught there (the host thread then
// puts its windows right from the top of its loop: see recoverWindows)
thread_local bool tFaultCaught = false;

template <class F>
bool guarded(F&& f, Fault* fault = nullptr) {
  using Fn = std::remove_reference_t<F>;
  Fault local;
  Fault* out = fault ? fault : &local;
  void* ctx = const_cast<void*>(static_cast<const void*>(std::addressof(f)));
  int ok;
  {
    dsp::FpEnvGuard fp;  // plugins may change MXCSR (FTZ / DAZ, rounding): put back after every call
    ok = sehRun([](void* c) { (*static_cast<Fn*>(c))(); }, ctx, out);
  }
  if (!ok) {
    tFaultCaught = true;
    if (out->code == EXCEPTION_STACK_OVERFLOW) _resetstkoflw();
  }
  return ok != 0;
}

HMODULE moduleOf(const void* addr) {
  HMODULE m = nullptr;
  if (addr) {
    GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                       static_cast<LPCWSTR>(addr), &m);
  }
  return m;
}

std::wstring widen(const std::string& s) {
  if (s.empty()) return std::wstring();
  const int n = MultiByteToWideChar(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), nullptr, 0);
  std::wstring w(static_cast<size_t>(n > 0 ? n : 0), L'\0');
  if (n > 0) MultiByteToWideChar(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), w.data(), n);
  return w;
}

std::filesystem::path pathFromUtf8(const std::string& s) {
  return std::filesystem::path(std::u8string(reinterpret_cast<const char8_t*>(s.data()), s.size()));
}

std::string utf8Of(const std::filesystem::path& p) {
  const std::u8string u = p.u8string();
  return std::string(u.begin(), u.end());
}

// ---------------------------------------------------------------------------
// Per-monitor DPI (Windows 10 1607+), looked up at run time.
// ---------------------------------------------------------------------------
struct DpiApi {
  decltype(&SetThreadDpiAwarenessContext) setThreadCtx = nullptr;
  decltype(&GetThreadDpiAwarenessContext) threadCtx = nullptr;
  decltype(&GetWindowDpiAwarenessContext) windowCtx = nullptr;
  decltype(&GetAwarenessFromDpiAwarenessContext) awareness = nullptr;
  decltype(&GetDpiForWindow) forWindow = nullptr;
  decltype(&AdjustWindowRectExForDpi) adjust = nullptr;
  DpiApi() {
    HMODULE u = GetModuleHandleW(L"user32.dll");
    if (!u) return;
    setThreadCtx = reinterpret_cast<decltype(setThreadCtx)>(GetProcAddress(u, "SetThreadDpiAwarenessContext"));
    threadCtx = reinterpret_cast<decltype(threadCtx)>(GetProcAddress(u, "GetThreadDpiAwarenessContext"));
    windowCtx = reinterpret_cast<decltype(windowCtx)>(GetProcAddress(u, "GetWindowDpiAwarenessContext"));
    awareness = reinterpret_cast<decltype(awareness)>(GetProcAddress(u, "GetAwarenessFromDpiAwarenessContext"));
    forWindow = reinterpret_cast<decltype(forWindow)>(GetProcAddress(u, "GetDpiForWindow"));
    adjust = reinterpret_cast<decltype(adjust)>(GetProcAddress(u, "AdjustWindowRectExForDpi"));
  }
};

const DpiApi& dpiApi() {
  static const DpiApi api;
  return api;
}

UINT windowDpi(HWND h) {
  UINT v = (h && dpiApi().forWindow) ? dpiApi().forWindow(h) : 0;
  return v ? v : 96;
}

int windowAwareness(HWND h) {
  const DpiApi& d = dpiApi();
  if (!h || !d.windowCtx || !d.awareness) return -1;
  return static_cast<int>(d.awareness(d.windowCtx(h)));
}

SIZE frameSizeFor(HWND h, int w, int ht) {
  RECT rc{0, 0, w, ht};
  const DWORD style = static_cast<DWORD>(GetWindowLongW(h, GWL_STYLE));
  const DWORD ex = static_cast<DWORD>(GetWindowLongW(h, GWL_EXSTYLE));
  if (dpiApi().adjust) dpiApi().adjust(&rc, style, FALSE, ex, windowDpi(h));
  else AdjustWindowRectEx(&rc, style, FALSE, ex);
  return {rc.right - rc.left, rc.bottom - rc.top};
}

class DpiScope {
 public:
  explicit DpiScope(HWND h) {
    const DpiApi& d = dpiApi();
    if (h && d.setThreadCtx && d.windowCtx) prev_ = d.setThreadCtx(d.windowCtx(h));
  }
  explicit DpiScope(DPI_AWARENESS_CONTEXT ctx) {
    if (ctx && dpiApi().setThreadCtx) prev_ = dpiApi().setThreadCtx(ctx);
  }
  ~DpiScope() {
    if (prev_) dpiApi().setThreadCtx(prev_);
  }
  DpiScope(const DpiScope&) = delete;
  DpiScope& operator=(const DpiScope&) = delete;

 private:
  DPI_AWARENESS_CONTEXT prev_ = nullptr;
};

void onHostEvent(UINT msg, int slot);

const wchar_t kEditorClass[] = L"OpenMixVstEditor";

BOOL CALLBACK findShownWindow(HWND w, LPARAM found) {
  if (!IsWindowVisible(w)) return TRUE;
  wchar_t cls[64] = {};
  if (GetClassNameW(w, cls, 64) && !wcscmp(cls, kEditorClass)) return TRUE;
  *reinterpret_cast<bool*>(found) = true;
  return FALSE;
}

bool pluginWindowShown(DWORD tid = GetCurrentThreadId()) {
  bool found = false;
  if (tid) EnumThreadWindows(tid, findShownWindow, reinterpret_cast<LPARAM>(&found));
  return found;
}

struct OtherWindowScan {
  DWORD pid = 0, skipTid = 0;
  bool found = false;
};

BOOL CALLBACK findOtherThreadWindow(HWND w, LPARAM p) {
  auto* scan = reinterpret_cast<OtherWindowScan*>(p);
  if (!IsWindowVisible(w)) return TRUE;
  DWORD pid = 0;
  const DWORD tid = GetWindowThreadProcessId(w, &pid);
  if (pid != scan->pid || tid == scan->skipTid) return TRUE;
  wchar_t cls[64] = {};
  if (GetClassNameW(w, cls, 64) && !wcscmp(cls, kEditorClass)) return TRUE;
  scan->found = true;
  return FALSE;
}

// A window of this process shown by a thread other than the host thread (a
// plugin's own UI thread: a licence dialog while its call waits for it). In
// the engine host process no other window exists (the renderer draws the UI).
bool otherThreadWindowShown(DWORD hostTid) {
  OtherWindowScan scan;
  scan.pid = GetCurrentProcessId();
  scan.skipTid = hostTid;
  EnumWindows(findOtherThreadWindow, reinterpret_cast<LPARAM>(&scan));
  return scan.found;
}

constexpr DWORD kWaitSliceMs = 250;
constexpr DWORD kWaitTickMs = 1000;

// ---------------------------------------------------------------------------
// Host thread: Win32 message loop + task queue (message-only window). See
// the hardened vsthost.cpp for the reasoning (unchanged): tasks run one
// after another and only from the top of the loop; a caller never waits
// longer than its time-out except for a plugin window that waits for the
// user (patient callers, up to gTimeouts.dialog).
// ---------------------------------------------------------------------------
class HostThread {
 public:
  enum Result { kDone, kTimeout, kBusy, kStopped, kFault };

  struct Wait {
    bool patient = false;
    std::function<bool(bool dialog, bool running)> tick;
  };

  struct Job {
    std::function<void(Job&)> fn;
    std::mutex m;
    std::condition_variable cv;
    int state = 0;  // 0 queued, 1 running, 2 finished, 3 skipped
    bool faulted = false;
    bool abandoned = false;
    bool committed = false;
    bool commit() {
      std::lock_guard<std::mutex> lk(m);
      if (abandoned) return false;
      committed = true;
      return true;
    }
  };

  using FaultHandler = void (*)(const Fault&, HWND);
  using Hook = void (*)();

  ~HostThread() {
    if (thread_.joinable()) thread_.detach();  // lives as long as the process
  }

  bool start(FaultHandler onFault, Hook onIdle, Hook onRecover) {
    std::lock_guard<std::mutex> lk(startM_);
    if (hwnd_) return true;
    if (thread_.joinable()) thread_.join();
    onFault_ = onFault;
    onIdle_ = onIdle;
    onRecover_ = onRecover;
    std::promise<void> ready;
    auto fut = ready.get_future();
    thread_ = std::thread([this, &ready] { run(ready); });
    fut.wait();
    return hwnd_ != nullptr;
  }

  HWND hwnd() const { return hwnd_; }
  DWORD tid() const { return tid_; }
  bool stalled() const { return stalled_.load(); }
  bool onThread() const { return GetCurrentThreadId() == tid_; }

  bool dialogOpen() const {
    const ULONGLONG t = lastPump_.load();
    return t != 0 && GetTickCount64() - t < kPumpFreshMs && pluginWindowShown(tid_);
  }
  bool waitsForUser() const { return dialogOpen() || otherThreadWindowShown(tid_); }

  void wake() {
    if (hwnd_) PostMessageW(hwnd_, WM_OM_PING, 0, 0);
  }

  template <class F>
  Result call(F f, DWORD ms, const Wait* wait = nullptr) {
    auto job = std::make_shared<Job>();
    job->fn = std::move(f);
    if (onThread()) {
      job->state = 1;
      const int outer = depth_++;
      bool ok = guarded([&] { job->fn(*job); });
      depth_ = outer;
      return ok ? kDone : kFault;
    }
    if (!hwnd_) return kStopped;
    if (stalled_.load()) return kBusy;
    {
      std::lock_guard<std::mutex> lk(m_);
      q_.push_back(job);
    }
    if (!PostMessageW(hwnd_, WM_OM_TASK, 0, 0)) {
      std::lock_guard<std::mutex> lk(job->m);
      job->state = 3;
      return kStopped;
    }
    const bool patient = wait && wait->patient;
    const ULONGLONG t0 = GetTickCount64();
    ULONGLONG lastTick = t0;
    ULONGLONG since = t0;
    bool sawDialog = false;
    std::unique_lock<std::mutex> lk(job->m);
    for (;;) {
      const ULONGLONG waited = GetTickCount64() - since;
      const ULONGLONG left = waited < ms ? ms - waited : 0;
      const DWORD slice =
          static_cast<DWORD>(std::max<ULONGLONG>(1, std::min<ULONGLONG>(kWaitSliceMs, left ? left : kWaitSliceMs)));
      if (job->cv.wait_for(lk, std::chrono::milliseconds(slice), [&] { return job->state == 2; })) break;
      const ULONGLONG now = GetTickCount64();
      const bool running = job->state == 1;
      const bool dialog = patient && (dialogOpen() || otherThreadWindowShown(tid_));
      if (dialog || sawDialog) since = now;
      sawDialog = dialog;
      bool giveUp = now - since >= ms || (patient && now - t0 >= std::max<ULONGLONG>(ms, gTimeouts.dialog.load()));
      if (!giveUp && wait && wait->tick && now - lastTick >= kWaitTickMs) {
        lastTick = now;
        lk.unlock();
        const bool go = wait->tick(dialog, running);
        lk.lock();
        if (job->state == 2) break;
        giveUp = !go;
      }
      if (giveUp) {
        if (job->committed) {
          job->cv.wait(lk, [&] { return job->state == 2; });
          break;
        }
        if (job->state == 0) job->state = 3;
        job->abandoned = true;
        lk.unlock();
        stalled_ = true;
        wake();
        return kTimeout;
      }
      ping();
    }
    return job->faulted ? kFault : kDone;
  }

  static LRESULT CALLBACK wndProc(HWND h, UINT msg, WPARAM wp, LPARAM lp);

 private:
  static constexpr DWORD kPumpFreshMs = 1500;
  static constexpr DWORD kPingLostMs = 1000;

  void notePump() {
    if (pluginWindowShown()) lastPump_ = GetTickCount64();
  }

  void ping() {
    const ULONGLONG now = GetTickCount64();
    if (pingPending_.load() && now - pingAt_.load() < kPingLostMs) return;
    pingAt_ = now;
    pingPending_ = true;
    if (!PostMessageW(hwnd_, WM_OM_PING, 0, 0)) pingPending_ = false;
  }

  void resetDpi() {
    if (dpiCtx_ && dpiApi().setThreadCtx) dpiApi().setThreadCtx(dpiCtx_);
  }

  void drain() {
    if (depth_ > 0) {
      heldTasks_++;
      return;
    }
    for (;;) {
      std::shared_ptr<Job> job;
      {
        std::lock_guard<std::mutex> lk(m_);
        if (q_.empty()) return;
        job = q_.front();
        q_.pop_front();
      }
      {
        std::lock_guard<std::mutex> lk(job->m);
        if (job->state == 3) continue;
        job->state = 1;
      }
      depth_ = 1;
      bool ok = guarded([&] { job->fn(*job); });
      depth_ = 0;
      lastPump_ = 0;
      resetDpi();
      {
        std::lock_guard<std::mutex> lk(job->m);
        job->faulted = !ok;
        job->state = 2;
      }
      job->cv.notify_all();
      flushEvents();
      stalled_ = false;
      pingPending_ = false;
    }
  }

  void event(UINT msg, WPARAM slot) {
    const unsigned kind = msg - WM_OM_CRASHED;
    if (kind >= kEventKinds || slot >= static_cast<WPARAM>(kMaxSlots)) return;
    if (depth_ > 0) {
      events_[kind] |= 1u << slot;
      notePump();
      return;
    }
    depth_ = 1;
    onHostEvent(msg, static_cast<int>(slot));
    depth_ = 0;
  }

  void flushEvents() {
    for (int round = 0; round < 4 && depth_ == 0; round++) {
      bool any = false;
      for (unsigned kind = 0; kind < kEventKinds; kind++) {
        uint32_t bits = events_[kind];
        events_[kind] = 0;
        for (unsigned i = 0; bits; i++, bits >>= 1) {
          if (!(bits & 1)) continue;
          any = true;
          event(WM_OM_CRASHED + kind, i);
        }
      }
      if (!any) return;
    }
  }

  void run(std::promise<void>& ready) {
    tid_ = GetCurrentThreadId();
    if (dpiApi().threadCtx) dpiCtx_ = dpiApi().threadCtx();
    OleInitialize(nullptr);  // some plugin editors use drag & drop / COM
    WNDCLASSW wc{};
    wc.lpfnWndProc = wndProc;
    wc.hInstance = GetModuleHandleW(nullptr);
    wc.lpszClassName = L"OpenMixVstHostTasks";
    RegisterClassW(&wc);
    hwnd_ = CreateWindowExW(0, wc.lpszClassName, L"", 0, 0, 0, 0, 0, HWND_MESSAGE, nullptr, wc.hInstance, nullptr);
    if (hwnd_) SetWindowLongPtrW(hwnd_, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(this));
    ready.set_value();
    if (!hwnd_) return;
    for (;;) {
      MSG msg{};
      BOOL got = 0;
      Fault fault;
      bool ok = guarded(
          [&] {
            depth_ = 1;
            got = GetMessageW(&msg, nullptr, 0, 0);
            if (got > 0) {
              if (msg.hwnd == hwnd_) depth_ = 0;
              TranslateMessage(&msg);
              DispatchMessageW(&msg);
            }
          },
          &fault);
      depth_ = 0;
      lastPump_ = 0;
      resetDpi();
      if (!ok && onFault_) {
        depth_ = 1;
        guarded([&] { onFault_(fault, msg.hwnd); });
        depth_ = 0;
        resetDpi();
      }
      if (got < 0) Sleep(1);
      guarded([&] { flushEvents(); });
      depth_ = 0;
      if (onIdle_) {
        depth_ = 1;
        guarded([&] { onIdle_(); });
        depth_ = 0;
        lastPump_ = 0;
        resetDpi();
      }
      guarded([&] { drain(); });
      depth_ = 0;
      if (tFaultCaught && onRecover_) {
        tFaultCaught = false;
        guarded([&] { onRecover_(); });
        tFaultCaught = false;
      }
      stalled_ = false;
      pingPending_ = false;
    }
  }

  std::mutex startM_;
  std::thread thread_;
  DWORD tid_ = 0;
  HWND hwnd_ = nullptr;
  std::mutex m_;
  std::deque<std::shared_ptr<Job>> q_;
  std::atomic<bool> stalled_{false};
  std::atomic<bool> pingPending_{false};
  std::atomic<ULONGLONG> pingAt_{0};
  std::atomic<ULONGLONG> lastPump_{0};
  FaultHandler onFault_ = nullptr;
  Hook onIdle_ = nullptr;
  Hook onRecover_ = nullptr;
  int depth_ = 0;
  uint32_t events_[kEventKinds] = {};
  DPI_AWARENESS_CONTEXT dpiCtx_ = nullptr;
  std::atomic<uint32_t> heldTasks_{0};
  std::atomic<uint32_t> heldPings_{0};
};

HostThread& host() {
  static HostThread* h = new HostThread();  // never destroyed (the thread outlives static destruction)
  return *h;
}

const HostThread::Wait& patientWait() {
  static const HostThread::Wait w{true, nullptr};
  return w;
}

// ---------------------------------------------------------------------------
// Parameter edits from the plugin's editor -> the deck worker; restart
// requests -> the host thread (IComponentHandler + IComponentHandler2).
// performEdit may come from any thread of the plugin (its UI thread, a
// thread of its own, even its process()): the transfer ring is single-
// producer, so producers are serialized by a tiny spin lock (never held
// across anything but the copy into the ring).
// ---------------------------------------------------------------------------
std::atomic<int32_t> gRestartFlags[kMaxSlots];

class ComponentHandler : public IComponentHandler, public IComponentHandler2 {
 public:
  ParameterChangeTransfer* transfer = nullptr;
  int slot = -1;
  std::atomic<bool> dirty{false};

  tresult PLUGIN_API beginEdit(ParamID) override { return kResultOk; }
  tresult PLUGIN_API performEdit(ParamID id, ParamValue v) override {
    if (!transfer) return kResultFalse;
    lockEdits();
    transfer->addChange(id, v, 0);
    unlockEdits();
    return kResultOk;
  }
  // Holds the producers back (any thread) while the transfer ring is resized.
  void lockEdits() {
    while (lock_.test_and_set(std::memory_order_acquire)) std::this_thread::yield();
  }
  void unlockEdits() { lock_.clear(std::memory_order_release); }
  tresult PLUGIN_API endEdit(ParamID) override { return kResultOk; }
  tresult PLUGIN_API restartComponent(int32 flags) override {
    // handled from the top of the host thread's loop (any thread may call this)
    if (slot >= 0 && slot < kMaxSlots) {
      gRestartFlags[slot].fetch_or(flags);
      if (host().hwnd()) PostMessageW(host().hwnd(), WM_OM_RESTART, static_cast<WPARAM>(slot), 0);
    }
    return kResultOk;
  }
  // IComponentHandler2
  tresult PLUGIN_API setDirty(TBool state) override {
    dirty = state != 0;
    return kResultOk;
  }
  tresult PLUGIN_API requestOpenEditor(FIDString) override { return kResultFalse; }  // (the UI opens editors)
  tresult PLUGIN_API startGroupEdit() override { return kResultOk; }
  tresult PLUGIN_API finishGroupEdit() override { return kResultOk; }

  tresult PLUGIN_API queryInterface(const TUID _iid, void** obj) override {
    if (FUnknownPrivate::iidEqual(_iid, IComponentHandler::iid) || FUnknownPrivate::iidEqual(_iid, FUnknown::iid)) {
      *obj = static_cast<IComponentHandler*>(this);
      return kResultOk;
    }
    if (FUnknownPrivate::iidEqual(_iid, IComponentHandler2::iid)) {
      *obj = static_cast<IComponentHandler2*>(this);
      return kResultOk;
    }
    *obj = nullptr;
    return kNoInterface;
  }
  uint32 PLUGIN_API addRef() override { return 1; }
  uint32 PLUGIN_API release() override { return 1; }

 private:
  std::atomic_flag lock_ = ATOMIC_FLAG_INIT;
};

// Editor window frame: lets the plugin resize its own window (the host
// resizes the window, then calls onSize in the same call).
class PlugFrame : public IPlugFrame {
 public:
  HWND hwnd = nullptr;
  bool resizing = false;
  bool resized = false;

  tresult PLUGIN_API resizeView(IPlugView* view, ViewRect* r) override {
    if (!hwnd || !r || r->getWidth() <= 0 || r->getHeight() <= 0) return kInvalidArgument;
    resized = true;
    if (resizing) {
      pending_ = *r;
      hasPending_ = true;
      return kResultTrue;
    }
    resizing = true;
    ViewRect want = *r;
    for (int round = 0; round < 4; round++) {
      {
        DpiScope dpi(hwnd);
        SIZE sz = frameSizeFor(hwnd, std::min<int32>(want.getWidth(), 16384), std::min<int32>(want.getHeight(), 16384));
        SetWindowPos(hwnd, nullptr, 0, 0, sz.cx, sz.cy, SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE);
      }
      hasPending_ = false;
      if (view) view->onSize(&want);
      if (!hasPending_) break;
      want = pending_;
    }
    resizing = false;
    return kResultTrue;
  }
  tresult PLUGIN_API queryInterface(const TUID _iid, void** obj) override {
    if (FUnknownPrivate::iidEqual(_iid, IPlugFrame::iid) || FUnknownPrivate::iidEqual(_iid, FUnknown::iid)) {
      *obj = static_cast<IPlugFrame*>(this);
      return kResultOk;
    }
    *obj = nullptr;
    return kNoInterface;
  }
  uint32 PLUGIN_API addRef() override { return 1; }
  uint32 PLUGIN_API release() override { return 1; }

 private:
  ViewRect pending_;
  bool hasPending_ = false;
};

class OpenMixHostApplication : public HostApplication {
 public:
  tresult PLUGIN_API getName(String128 name) override {
    static const char16 kName[] = u"OpenMix";
    std::memcpy(name, kName, sizeof(kName));
    return kResultTrue;
  }
};

int safeProcess(IAudioProcessor* p, ProcessData* d, DWORD* faultCode);

// ---------------------------------------------------------------------------
// One loaded plugin. Created and destroyed on the host thread; its deck
// worker runs process() through IVstProcessor while the shell lets it. A
// crashed or hung plugin's Inst is never freed.
// ---------------------------------------------------------------------------
struct Inst final : public IVstProcessor {
  VST3::Hosting::Module::Ptr module;
  IPtr<PlugProvider> provider;
  IPtr<IComponent> component;
  IPtr<IAudioProcessor> processor;
  IPtr<IEditController> controller;
  HostProcessData data;
  ParameterChanges inChanges, outChanges;
  ParameterChangeTransfer transfer;
  EventList inEvents, outEvents;
  ComponentHandler handler;
  ProcessContext context{};
  int32 inCh = 2, outCh = 2;
  int32 latency = 0;
  int32 paramCapacity = 16;  // parameters the queues and the transfer ring are sized for
  bool processing = false;
  double rate = 48000;
  int32 maxBlock = 2048;
  HMODULE hmod = nullptr;
  HMODULE dll = nullptr;
  std::string name, path, uid;
  int slot = -1;
  std::atomic<bool> crashed{false};
  // editor (host thread)
  IPtr<IPlugView> view;
  IPtr<IPlugViewContentScaleSupport> scale;
  PlugFrame frame;
  HWND editor = nullptr;
  HWND lastFocus = nullptr;
  bool focusing = false;
  bool resizable = false;

  // Deck worker.
  VstProcessResult process(const VstProcessBlock& b) override {
    // A plugin that faulted is never called again, also when its crashed
    // result came back after the deadline (discarded by the shell)
    if (crashed.load(std::memory_order_relaxed)) return VstProcessResult::Crashed;
    const int32 n = std::min<int32>(b.frames, maxBlock);
    if (data.numInputs > 0) {
      AudioBusBuffers& ins = data.inputs[0];
      if (inCh >= 2) {
        std::memcpy(ins.channelBuffers32[0], b.inL, static_cast<size_t>(n) * sizeof(float));
        std::memcpy(ins.channelBuffers32[1], b.inR, static_cast<size_t>(n) * sizeof(float));
        for (int32 c = 2; c < inCh; c++) std::memset(ins.channelBuffers32[c], 0, static_cast<size_t>(n) * sizeof(float));
      } else if (inCh == 1) {
        for (int32 i = 0; i < n; i++) ins.channelBuffers32[0][i] = 0.5f * (b.inL[i] + b.inR[i]);
      }
      ins.silenceFlags = 0;
    }
    // transport at the insert INPUT position (SPEC.md §13.3)
    context.sampleRate = rate;
    context.state = ProcessContext::kContTimeValid | ProcessContext::kSystemTimeValid;
    context.projectTimeSamples = b.transport.samplePos;
    context.continousTimeSamples = b.continuousFrames;
    context.systemTime = b.systemTimeNs;
    if (b.transport.playing) context.state |= ProcessContext::kPlaying;
    if (b.transport.tempoBpm > 0.0) {
      context.state |= ProcessContext::kTempoValid | ProcessContext::kTimeSigValid |
                       ProcessContext::kProjectTimeMusicValid | ProcessContext::kBarPositionValid;
      context.tempo = b.transport.tempoBpm;
      context.timeSigNumerator = 4;
      context.timeSigDenominator = 4;
      context.projectTimeMusic = b.transport.beatPos;
      context.barPositionMusic = b.transport.barStartBeat;
    }
    inChanges.clearQueue();
    transfer.transferChangesTo(inChanges);
    outChanges.clearQueue();
    inEvents.clear();
    outEvents.clear();
    data.numSamples = n;
    for (int32 i = 0; i < data.numOutputs; i++) data.outputs[i].silenceFlags = 0;
    DWORD fault = 0;
    const int r = safeProcess(processor, &data, &fault);
    if (r < 0) {
      // The guard page of a stack overflow is put back here, outside the
      // __except block (the CRT rule): the worker's stack stays protected,
      // and the shell gives the deck a fresh worker anyway at the unload.
      if (fault == EXCEPTION_STACK_OVERFLOW) _resetstkoflw();
      // never called again; the host thread abandons its editor
      crashed = true;
      if (host().hwnd()) PostMessageW(host().hwnd(), WM_OM_CRASHED, static_cast<WPARAM>(slot), 0);
      return VstProcessResult::Crashed;
    }
    if (data.numOutputs > 0) {
      AudioBusBuffers& outs = data.outputs[0];
      if (outCh >= 2) {
        std::memcpy(b.outL, outs.channelBuffers32[0], static_cast<size_t>(n) * sizeof(float));
        std::memcpy(b.outR, outs.channelBuffers32[1], static_cast<size_t>(n) * sizeof(float));
      } else if (outCh == 1) {
        std::memcpy(b.outL, outs.channelBuffers32[0], static_cast<size_t>(n) * sizeof(float));
        std::memcpy(b.outR, outs.channelBuffers32[0], static_cast<size_t>(n) * sizeof(float));
      }
    }
    return r == 1 ? VstProcessResult::Ok : VstProcessResult::Error;
  }
};

int safeProcess(IAudioProcessor* p, ProcessData* d, DWORD* faultCode) {
  __try {
    return p->process(*d) == kResultOk ? 1 : 0;
  } __except (*faultCode = GetExceptionCode(), EXCEPTION_EXECUTE_HANDLER) {
    return -1;
  }
}

// ---------------------------------------------------------------------------
// Slots (process-wide: 8 hosts x 4 decks)
// ---------------------------------------------------------------------------
struct BSlot {
  int index = 0;
  Inst* inst = nullptr;            // host thread
  SlotControl* ctl = nullptr;      // the shell of the VstHost using this slot
  int deck = 0;
  std::atomic<bool> editorOpen{false};
  POINT editorPos{};
  bool editorPosValid = false;
  std::string editorPath;
  HWND closeReq = nullptr;
};

BSlot gSlots[kMaxSlots];
// Unloads the host thread could not run when asked (stalled by another
// plugin): done from the top of its loop once it answers (the hardened
// host's releaseLater). A crashed / hung plugin is abandoned, not freed.
std::atomic<Inst*> gPendingRelease[kMaxSlots];
std::atomic<bool> gPendingAbandon[kMaxSlots];
std::mutex gSlotAlloc;
bool gGroupUsed[kMaxSlots / kNumDecks] = {};
IPtr<HostApplication> gHostApp;
std::atomic<bool> gHostStarted{false};
std::vector<Inst*> gAbandoned;  // host thread
std::atomic<uint32_t> gRecoveries{0}, gWindowsClosed{0};

struct SlotIndexInit {
  SlotIndexInit() {
    for (int i = 0; i < kMaxSlots; i++) {
      gSlots[i].index = i;
      gRestartFlags[i].store(0);
      gPendingRelease[i].store(nullptr);
      gPendingAbandon[i].store(false);
    }
  }
} gSlotIndexInit;

// ---------------------------------------------------------------------------
// Plugin lifecycle (host thread only)
// ---------------------------------------------------------------------------
void abandonEditor(BSlot& s, Inst* in) {
  if (!in) return;
  in->view.take();  // never released
  in->scale.take();
  in->frame.hwnd = nullptr;
  in->lastFocus = nullptr;
  HWND h = in->editor;
  in->editor = nullptr;
  s.editorOpen = false;
  if (h) {
    SetWindowLongPtrW(h, GWLP_USERDATA, 0);
    guarded([&] { DestroyWindow(h); });
  }
}

void abandonInst(BSlot& s, Inst* in) {
  if (!in) return;
  in->crashed = true;
  abandonEditor(s, in);
  in->processor.take();
  in->controller.take();
  in->component.take();
  in->provider.take();
  new VST3::Hosting::Module::Ptr(std::move(in->module));  // keeps the DLL loaded
  gAbandoned.push_back(in);
}

void markCrashed(BSlot& s, Inst* in) {
  if (!in) return;
  in->crashed = true;
  if (s.ctl) s.ctl->markCrashed(s.deck, in);
}

bool closeEditorOf(BSlot& s, Inst* in, bool crashed) {
  if (!in || (!in->editor && !in->view)) return true;
  if (crashed) {
    abandonEditor(s, in);
    return true;
  }
  RECT wr;
  if (in->editor && !IsIconic(in->editor) && GetWindowRect(in->editor, &wr)) {
    s.editorPos = {wr.left, wr.top};
    s.editorPosValid = true;
    s.editorPath = in->path;
  }
  bool ok = guarded([&] {
    in->scale = nullptr;
    if (in->view) {
      in->view->setFrame(nullptr);
      in->view->removed();
      in->view = nullptr;
    }
  });
  if (!ok) {
    abandonEditor(s, in);
    return false;
  }
  HWND h = in->editor;
  in->editor = nullptr;
  in->frame.hwnd = nullptr;
  in->lastFocus = nullptr;
  s.editorOpen = false;
  if (h) {
    SetWindowLongPtrW(h, GWLP_USERDATA, 0);
    guarded([&] { DestroyWindow(h); });
  }
  return true;
}

void closeEditorOnHost(BSlot& s) {
  Inst* in = s.inst;
  if (in && !closeEditorOf(s, in, in->crashed.load())) markCrashed(s, in);
}

void destroyInst(BSlot& s, Inst* in) {
  if (!in) return;
  if (!closeEditorOf(s, in, false)) {
    abandonInst(s, in);
    return;
  }
  bool ok = guarded([&] {
    if (in->processing) {
      in->processor->setProcessing(false);
      in->component->setActive(false);
      in->processing = false;
    }
  });
  if (!ok) {
    abandonInst(s, in);
    return;
  }
  in->data.unprepare();
  ok = guarded([&] {
    if (in->controller) in->controller->setComponentHandler(nullptr);
    in->processor = nullptr;
    in->controller = nullptr;
    in->component = nullptr;
    in->provider = nullptr;  // terminates and disconnects component / controller
    in->module = nullptr;    // (the DLL stays loaded: see CachedModule)
  });
  if (!ok) {
    abandonInst(s, in);
    return;
  }
  delete in;
}

// From the top of the host loop (and before a load): the deferred unloads.
void releasePending() {
  for (int k = 0; k < kMaxSlots; k++) {
    Inst* in = gPendingRelease[k].exchange(nullptr);
    if (!in) continue;
    BSlot& s = gSlots[k];
    if (s.inst == in) s.inst = nullptr;
    if (gPendingAbandon[k].load() || in->crashed) abandonInst(s, in);
    else destroyInst(s, in);
  }
}

std::string normalizeUid(const std::string& u) {
  std::string out;
  for (char c : u) {
    if (std::isxdigit(static_cast<unsigned char>(c))) out.push_back(static_cast<char>(std::toupper(static_cast<unsigned char>(c))));
  }
  return out;
}

// A plugin's DLL: the file itself (VST 3.0 layout) or, in a bundle,
// Contents/x86_64-win/<name>.vst3 (handing the SDK's loader the DLL itself
// spares it the bundle path, which it mis-converts with non-ASCII folders).
std::string pluginDll(const std::string& path) {
  try {
    const std::filesystem::path p = pathFromUtf8(path);
    std::error_code ec;
    if (!std::filesystem::is_directory(p, ec)) return path;
    const std::filesystem::path dll = p / "Contents" / "x86_64-win" / p.filename();
    if (!std::filesystem::is_regular_file(dll, ec)) return path;
    return utf8Of(dll);
  } catch (...) {
    return path;
  }
}

// Loads a plugin's DLL with its own folder in the DLL search path, so the
// libraries it ships next to itself are found. Returns that extra
// reference (freed once the SDK has loaded the module), or nullptr with the
// system error in *error. Runs DllMain.
HMODULE preloadDll(const std::string& dll, DWORD* error) {
  std::wstring w;
  try {
    w = pathFromUtf8(dll).lexically_normal().wstring();
  } catch (...) {
    return nullptr;
  }
  HMODULE m = LoadLibraryExW(w.c_str(), nullptr, LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_DEFAULT_DIRS);
  if (!m) m = LoadLibraryExW(w.c_str(), nullptr, LOAD_WITH_ALTERED_SEARCH_PATH);
  if (!m && error) *error = GetLastError();
  return m;
}

// Why a plugin's DLL did not load, in UTF-8 with the system's own words and
// the error code. (The SDK's message is the system text in the ANSI code
// page: garbled in a UTF-8 JSON reply on a non-English Windows.)
std::string dllLoadError(DWORD code) {
  wchar_t buf[512] = {};
  std::string sys;
  const DWORD n = FormatMessageW(FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_IGNORE_INSERTS, nullptr, code, 0, buf, 511, nullptr);
  if (n > 0) {
    const int len = WideCharToMultiByte(CP_UTF8, 0, buf, static_cast<int>(n), nullptr, 0, nullptr, nullptr);
    if (len > 0) {
      sys.resize(static_cast<size_t>(len));
      WideCharToMultiByte(CP_UTF8, 0, buf, static_cast<int>(n), sys.data(), len, nullptr, nullptr);
    }
    while (!sys.empty() && (sys.back() == '\n' || sys.back() == '\r' || sys.back() == ' ' || sys.back() == '.')) sys.pop_back();
  }
  const char* what = code == ERROR_BAD_EXE_FORMAT ? "not a 64-bit Windows plugin (32-bit, another architecture or not a DLL)"
                     : code == ERROR_MOD_NOT_FOUND ? "a library the plugin needs is missing"
                                                   : "the plugin's DLL could not be loaded";
  return std::string(what) + " (error " + std::to_string(code) + (sys.empty() ? "" : ": " + sys) + ")";
}

VST3::Hosting::Module::Ptr loadModule(const std::string& path, std::string& err) {
  const std::string dll = pluginDll(path);
  DWORD loadError = 0;
  HMODULE pre = preloadDll(dll, &loadError);
  auto module = VST3::Hosting::Module::create(dll, err);
  if (pre) FreeLibrary(pre);  // (the SDK's own reference keeps it loaded)
  if (!module && !pre && loadError) err = dllLoadError(loadError);
  return module;
}

// An insert class of a plugin file is offered unless it is an instrument
// (without Fx) or meant for offline processing only.
bool insertClass(const std::string& category, const std::string& subs) {
  if (category != kVstAudioEffectClass) return false;
  if (subs.find(PlugType::kOnlyOfflineProcess) != std::string::npos) return false;
  const bool instrument = subs.find("Instrument") != std::string::npos;
  const bool fx = subs.find("Fx") != std::string::npos;
  return !instrument || fx;
}

struct CachedModule {
  VST3::Hosting::Module::Ptr module;
  std::vector<VstPluginInfo> classes;
};
std::mutex gModulesLock;

std::map<std::wstring, CachedModule>& loadedModules() {
  static auto* modules = new std::map<std::wstring, CachedModule>();  // never destroyed (see the hardened host)
  return *modules;
}

std::wstring moduleKey(const std::string& path) {
  std::wstring k;
  try {
    k = pathFromUtf8(pluginDll(path)).lexically_normal().wstring();
  } catch (...) {
    k = widen(path);
  }
  if (!k.empty()) CharLowerBuffW(k.data(), static_cast<DWORD>(k.size()));
  return k;
}

void zeroBuffers(HostProcessData& d, int32 frames) {
  for (int32 i = 0; i < d.numInputs; i++)
    for (int32 c = 0; c < d.inputs[i].numChannels; c++)
      if (d.inputs[i].channelBuffers32 && d.inputs[i].channelBuffers32[c])
        std::memset(d.inputs[i].channelBuffers32[c], 0, static_cast<size_t>(frames) * sizeof(float));
  for (int32 i = 0; i < d.numOutputs; i++)
    for (int32 c = 0; c < d.outputs[i].numChannels; c++)
      if (d.outputs[i].channelBuffers32 && d.outputs[i].channelBuffers32[c])
        std::memset(d.outputs[i].channelBuffers32[c], 0, static_cast<size_t>(frames) * sizeof(float));
}

bool okOrNotImpl(tresult r) { return r == kResultOk || r == kNotImplemented; }

// Bus arrangements: stereo in, stereo out ([Initialized | Setup Done]). "" = ok.
std::string arrangeBuses(Inst& in) {
  const int32 nIn = in.component->getBusCount(kAudio, kInput);
  const int32 nOut = in.component->getBusCount(kAudio, kOutput);
  if (nOut < 1) return "plugin has no audio output";
  std::vector<SpeakerArrangement> inArr(static_cast<size_t>(std::max(nIn, 0)), SpeakerArr::kStereo),
      outArr(static_cast<size_t>(nOut), SpeakerArr::kStereo);
  if (in.processor->setBusArrangements(nIn ? inArr.data() : nullptr, nIn, outArr.data(), nOut) != kResultTrue) {
    // refused stereo: the plugin's own arrangement is used (a mono bus gets the
    // average, a mono output is duplicated)
    SpeakerArrangement a = 0;
    if (in.processor->getBusArrangement(kOutput, 0, a) != kResultOk || SpeakerArr::getChannelCount(a) < 1)
      return "the plugin refused the stereo bus arrangement";
  }
  return "";
}

// Main buses on, side-chains off ([Setup Done]: after setupProcessing), then
// the channel counts of the main buses. "" = ok.
std::string activateBuses(Inst& in) {
  const int32 nIn = in.component->getBusCount(kAudio, kInput);
  const int32 nOut = in.component->getBusCount(kAudio, kOutput);
  if (nOut < 1) return "plugin has no audio output";
  for (int32 i = 0; i < nIn; i++) in.component->activateBus(kAudio, kInput, i, i == 0);
  for (int32 i = 0; i < nOut; i++) {
    const tresult r = in.component->activateBus(kAudio, kOutput, i, i == 0);
    if (i == 0 && !okOrNotImpl(r) && r != kResultTrue) return "the plugin refused to activate its output";
  }
  BusInfo bi{};
  in.inCh = (nIn && in.component->getBusInfo(kAudio, kInput, 0, bi) == kResultOk) ? bi.channelCount : 0;
  in.outCh = in.component->getBusInfo(kAudio, kOutput, 0, bi) == kResultOk ? bi.channelCount : 2;
  if (in.outCh < 1) return "plugin has no audio output";
  return "";
}

// Creates and starts the plugin (runs under SEH). "" = ready.
std::string createInst(Inst& in, const std::string& path, const std::string& uid) {
  std::string err;
  const std::wstring key = moduleKey(path);
  {
    std::lock_guard<std::mutex> lk(gModulesLock);
    auto it = loadedModules().find(key);
    if (it != loadedModules().end()) in.module = it->second.module;
  }
  if (!in.module) {
    auto module = loadModule(path, err);
    if (!module) return err.empty() ? "cannot load module" : err;
    std::vector<VstPluginInfo> classes;
    for (auto& ci : module->getFactory().classInfos()) {
      if (insertClass(ci.category(), ci.subCategoriesString()))
        classes.push_back({path, ci.name(), ci.vendor(), ci.ID().toString(), ci.subCategoriesString()});
    }
    std::lock_guard<std::mutex> lk(gModulesLock);
    loadedModules()[key] = {module, std::move(classes)};
    in.module = module;
  }
  auto factory = in.module->getFactory();
  if (factory.get()) in.dll = in.hmod = moduleOf(*reinterpret_cast<void* const*>(factory.get().get()));
  VST3::Hosting::ClassInfo chosen;
  bool found = false;
  const std::string want = normalizeUid(uid);
  for (auto& ci : factory.classInfos()) {
    if (ci.category() != kVstAudioEffectClass) continue;
    if (want.empty() ? insertClass(ci.category(), ci.subCategoriesString()) : normalizeUid(ci.ID().toString()) == want) {
      chosen = ci;
      found = true;
      break;
    }
  }
  if (!found) return "no audio effect in this plugin";
  in.uid = chosen.ID().toString();
  in.provider = owned(new PlugProvider(factory, chosen, true));
  if (!in.provider->initialize()) return "plugin failed to initialize";
  in.component = in.provider->getComponentPtr();
  in.controller = in.provider->getControllerPtr();
  FUnknownPtr<IAudioProcessor> processor(in.component);
  if (!in.component || !processor) return "not an audio processor";
  in.processor = processor;
  if (HMODULE m = moduleOf(*reinterpret_cast<void* const*>(in.component.get()))) in.hmod = m;

  // 1. the component handler, and a fresh controller following the component's state
  if (in.controller) {
    in.handler.transfer = &in.transfer;
    in.handler.slot = in.slot;
    in.controller->setComponentHandler(&in.handler);
    auto* st = new MemoryStream();
    if (in.component->getState(st) == kResultOk) {
      int64 pos = 0;
      st->seek(0, IBStream::kIBSeekSet, &pos);
      in.controller->setComponentState(st);
    }
    st->release();
  }
  // 2. 32-bit float processing, bus arrangements [Initialized]
  if (in.processor->canProcessSampleSize(kSample32) != kResultTrue) return "the plugin cannot process 32-bit float";
  std::string e = arrangeBuses(in);
  if (!e.empty()) return e;
  // 3. setupProcessing, then the buses activated [Setup Done], buffers (aux
  // buffers zeroed: some plugins read inactive buses)
  ProcessSetup setup{kRealtime, kSample32, in.maxBlock, in.rate};
  if (in.processor->setupProcessing(setup) != kResultOk) return "plugin refused the sample rate / block size";
  e = activateBuses(in);
  if (!e.empty()) return e;
  const int32 nParams = in.controller ? in.controller->getParameterCount() : 0;
  in.paramCapacity = std::max<int32>(nParams, 16);
  in.transfer.setMaxParameters(in.paramCapacity);
  in.inChanges.setMaxParameters(in.paramCapacity);
  in.outChanges.setMaxParameters(in.paramCapacity);
  if (!in.data.prepare(*in.component, in.maxBlock, kSample32)) return "cannot allocate the plugin's buffers";
  zeroBuffers(in.data, in.maxBlock);
  in.data.inputParameterChanges = &in.inChanges;
  in.data.outputParameterChanges = &in.outChanges;
  in.data.inputEvents = &in.inEvents;
  in.data.outputEvents = &in.outEvents;
  in.data.processContext = &in.context;
  in.context = ProcessContext{};
  in.name = chosen.name();
  // 4. active, processing
  const tresult act = in.component->setActive(true);
  if (!okOrNotImpl(act) && act != kResultTrue) return "the plugin refused to activate";
  in.processor->setProcessing(true);  // (kNotImplemented is common)
  in.processing = true;
  in.latency = static_cast<int32>(in.processor->getLatencySamples());
  return "";
}

// Deactivates and reactivates a plugin (the VST3 rule after a latency or I/O
// change, a restored state, a new rate), then re-reads its latency. The deck
// worker is kept out by the caller. ioChanged: re-reads the buses and
// re-prepares the buffers. setup: a new rate / block size. false = fault;
// *disable = the plugin can no longer run as an insert.
bool reactivate(Inst& in, bool ioChanged, const ProcessSetup* setup, bool* disable) {
  if (disable) *disable = false;
  bool off = false;
  const bool ok = guarded([&] {
    if (in.processing) {
      in.processor->setProcessing(false);
      in.component->setActive(false);
      in.processing = false;
    }
    if (setup && in.processor->setupProcessing(*const_cast<ProcessSetup*>(setup)) != kResultOk) {
      off = true;
      return;
    }
    if (ioChanged || setup) {
      if (ioChanged && (!arrangeBuses(in).empty() || !activateBuses(in).empty())) {
        off = true;
        return;
      }
      in.data.unprepare();
      if (!in.data.prepare(*in.component, in.maxBlock, kSample32)) {
        off = true;
        return;
      }
      zeroBuffers(in.data, in.maxBlock);
      in.data.inputParameterChanges = &in.inChanges;
      in.data.outputParameterChanges = &in.outChanges;
      in.data.inputEvents = &in.inEvents;
      in.data.outputEvents = &in.outEvents;
      in.data.processContext = &in.context;
    }
    in.component->setActive(true);
    in.processor->setProcessing(true);
    in.processing = true;
    in.latency = static_cast<int32>(in.processor->getLatencySamples());
  });
  if (disable) *disable = off;
  return ok;
}

// kParamTitlesChanged: the parameter count may have grown. The parameter
// queues and the edit transfer ring grow here (host thread, the deck worker
// kept out by the caller, editors' performEdit held back, pending edits
// kept), so that process() never allocates in the SDK's queue classes on the
// audio side. false = fault.
bool growParamQueues(Inst& in) {
  int32 n = 0;
  if (!guarded([&] { n = in.controller ? in.controller->getParameterCount() : 0; })) return false;
  n = std::max<int32>(n, 16);
  if (n <= in.paramCapacity) return true;
  struct Edit {
    ParamID id;
    ParamValue value;
    int32 offset;
  };
  std::vector<Edit> pending;
  pending.reserve(static_cast<size_t>(in.paramCapacity) * 2);
  in.handler.lockEdits();
  Edit e{};
  while (in.transfer.getNextChange(e.id, e.value, e.offset)) pending.push_back(e);
  in.transfer.setMaxParameters(n);
  in.transfer.removeChanges();  // (emptied above: the indices start over in the new ring)
  for (const Edit& p : pending) in.transfer.addChange(p.id, p.value, p.offset);
  in.handler.unlockEdits();
  in.inChanges.setMaxParameters(n);
  in.outChanges.setMaxParameters(n);
  in.paramCapacity = n;
  return true;
}

// ---------------------------------------------------------------------------
// State = component state + controller state, framed with 32-bit lengths.
// ---------------------------------------------------------------------------
bool getStateOnHost(BSlot& s, Inst* in, std::string& out, std::string& err) {
  if (!in || !in->component) {
    err = "no plugin loaded";
    return false;
  }
  if (in->crashed) {
    err = "the plugin crashed";
    return false;
  }
  auto* comp = new MemoryStream();
  auto* ctrl = new MemoryStream();
  bool ok = guarded([&] {
    in->component->getState(comp);
    if (in->controller) in->controller->getState(ctrl);
  });
  if (!ok) {
    markCrashed(s, in);  // (the streams may still be referenced by the faulty plugin: leaked)
    abandonEditor(s, in);
    err = "the plugin crashed";
    return false;
  }
  auto put = [&out](MemoryStream& m) {
    const uint32_t n = static_cast<uint32_t>(m.getSize());
    out.append(reinterpret_cast<const char*>(&n), 4);
    out.append(m.getData(), n);
  };
  out.clear();
  put(*comp);
  put(*ctrl);
  comp->release();
  ctrl->release();
  return true;
}

// The caller kept the deck worker out. *latency: after the restore (the
// plugin is deactivated / reactivated when its latency changed, V05).
bool setStateOnHost(BSlot& s, Inst* in, const std::string& blob, std::string& err, int* latency) {
  if (latency) *latency = -1;
  if (blob.size() < 8) {
    err = "bad state";
    return false;
  }
  uint32_t n1;
  std::memcpy(&n1, blob.data(), 4);
  if (4ull + n1 + 4 > blob.size()) {
    err = "bad state";
    return false;
  }
  uint32_t n2;
  std::memcpy(&n2, blob.data() + 4 + n1, 4);
  if (8ull + n1 + n2 > blob.size()) {
    err = "bad state";
    return false;
  }
  if (!in || !in->component) {
    err = "no plugin loaded";
    return false;
  }
  if (in->crashed) {
    err = "the plugin crashed";
    return false;
  }
  auto* comp = new MemoryStream(const_cast<char*>(blob.data() + 4), n1);
  auto* comp2 = new MemoryStream(const_cast<char*>(blob.data() + 4), n1);
  auto* ctrl = new MemoryStream(const_cast<char*>(blob.data() + 8 + n1), n2);
  tresult r = kResultOk;
  int32 lat = 0;
  bool ok = guarded([&] {
    r = in->component->setState(comp);
    if (in->controller) {
      in->controller->setComponentState(comp2);
      if (n2) in->controller->setState(ctrl);
    }
    lat = static_cast<int32>(in->processor->getLatencySamples());
  });
  if (!ok) {
    markCrashed(s, in);
    abandonEditor(s, in);
    err = "the plugin crashed";
    return false;
  }
  comp->release();
  comp2->release();
  ctrl->release();
  if (lat != in->latency) {
    // a restored preset changed the latency: deactivate / reactivate, re-read it
    bool disable = false;
    if (!reactivate(*in, false, nullptr, &disable)) {
      markCrashed(s, in);
      abandonEditor(s, in);
      err = "the plugin crashed";
      return false;
    }
  }
  if (latency) *latency = in->latency;
  if (r != kResultOk && r != kResultTrue) {
    err = "the plugin refused the state";
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// restartComponent, from the top of the host loop.
// ---------------------------------------------------------------------------
void reloadOnHost(BSlot& s, Inst* in) {
  std::string blob, err;
  if (!getStateOnHost(s, in, blob, err)) return;  // (crashed: handled)
  auto* fresh = new Inst();
  fresh->slot = s.index;
  fresh->path = in->path;
  fresh->rate = in->rate;
  fresh->maxBlock = in->maxBlock;
  if (!guarded([&] { err = createInst(*fresh, in->path, in->uid); })) {
    abandonInst(s, fresh);
    return;  // the old instance keeps running
  }
  if (!err.empty()) {
    destroyInst(s, fresh);
    return;
  }
  int lat = fresh->latency;
  setStateOnHost(s, fresh, blob, err, &lat);
  if (s.ctl) s.ctl->replaceInstance(s.deck, in, fresh, fresh, fresh->latency);
  s.inst = fresh;
  destroyInst(s, in);
}

void onRestart(int index) {
  if (index < 0 || index >= kMaxSlots) return;
  BSlot& s = gSlots[index];
  const int32 flags = gRestartFlags[index].exchange(0);
  Inst* in = s.inst;
  if (!in || in->crashed || !s.ctl) return;
  if (!(flags & (kLatencyChanged | kIoChanged | kReloadComponent | kParamTitlesChanged)))
    return;  // values, MIDI CC assignments...: acknowledged
  SlotControl* ctl = s.ctl;
  const int deck = s.deck;
  if (!ctl->beginOp(deck)) {  // its process() does not return: it cannot be touched
    ctl->endOp(deck);
    return;
  }
  if (!(flags & kReloadComponent) && (flags & kParamTitlesChanged) && !growParamQueues(*in)) {
    markCrashed(s, in);
    abandonEditor(s, in);
    ctl->endOp(deck);
    return;
  }
  if (flags & kReloadComponent) {
    reloadOnHost(s, in);
  } else if (!(flags & (kLatencyChanged | kIoChanged))) {
    // (only the parameter queues needed work)
  } else {
    bool disable = false;
    if (!reactivate(*in, (flags & kIoChanged) != 0, nullptr, &disable)) {
      markCrashed(s, in);
      abandonEditor(s, in);
    } else if (disable) {
      ctl->markDisabled(deck, in);
    } else {
      ctl->setLatency(deck, in, in->latency);
    }
  }
  ctl->endOp(deck);
}

// ---------------------------------------------------------------------------
// Editor window (host thread)
// ---------------------------------------------------------------------------
void editorFault(BSlot& s) {
  markCrashed(s, s.inst);
  if (host().hwnd()) PostMessageW(host().hwnd(), WM_OM_CRASHED, static_cast<WPARAM>(s.index), 0);
}

struct VstKey {
  char16 ch = 0;
  int16 code = 0;
  int16 mods = 0;
};

bool vstKey(WPARAM vk, LPARAM lp, VstKey& k) {
  static const struct {
    UINT vk;
    int16 code;
  } kMap[] = {{VK_BACK, KEY_BACK}, {VK_TAB, KEY_TAB}, {VK_CLEAR, KEY_CLEAR}, {VK_PAUSE, KEY_PAUSE},
              {VK_ESCAPE, KEY_ESCAPE}, {VK_SPACE, KEY_SPACE}, {VK_PRIOR, KEY_PAGEUP}, {VK_NEXT, KEY_PAGEDOWN},
              {VK_END, KEY_END}, {VK_HOME, KEY_HOME}, {VK_LEFT, KEY_LEFT}, {VK_UP, KEY_UP},
              {VK_RIGHT, KEY_RIGHT}, {VK_DOWN, KEY_DOWN}, {VK_SELECT, KEY_SELECT}, {VK_PRINT, KEY_PRINT},
              {VK_SNAPSHOT, KEY_SNAPSHOT}, {VK_INSERT, KEY_INSERT}, {VK_DELETE, KEY_DELETE}, {VK_HELP, KEY_HELP},
              {VK_MULTIPLY, KEY_MULTIPLY}, {VK_ADD, KEY_ADD}, {VK_SEPARATOR, KEY_SEPARATOR},
              {VK_SUBTRACT, KEY_SUBTRACT}, {VK_DECIMAL, KEY_DECIMAL}, {VK_DIVIDE, KEY_DIVIDE},
              {VK_NUMLOCK, KEY_NUMLOCK}, {VK_SCROLL, KEY_SCROLL}, {VK_SHIFT, KEY_SHIFT},
              {VK_CONTROL, KEY_CONTROL}, {VK_MENU, KEY_ALT}, {VK_APPS, KEY_CONTEXTMENU},
              {VK_MEDIA_PLAY_PAUSE, KEY_MEDIA_PLAY}, {VK_MEDIA_STOP, KEY_MEDIA_STOP},
              {VK_MEDIA_PREV_TRACK, KEY_MEDIA_PREV}, {VK_MEDIA_NEXT_TRACK, KEY_MEDIA_NEXT},
              {VK_VOLUME_UP, KEY_VOLUME_UP}, {VK_VOLUME_DOWN, KEY_VOLUME_DOWN},
              {VK_LWIN, KEY_SUPER}, {VK_RWIN, KEY_SUPER}};
  k = VstKey{};
  if (GetKeyState(VK_SHIFT) < 0) k.mods |= kShiftKey;
  if (GetKeyState(VK_MENU) < 0) k.mods |= kAlternateKey;
  if (GetKeyState(VK_CONTROL) < 0) k.mods |= kCommandKey;
  if (GetKeyState(VK_LWIN) < 0 || GetKeyState(VK_RWIN) < 0) k.mods |= kControlKey;
  if (vk == VK_RETURN) {
    k.code = static_cast<int16>((lp & (1 << 24)) ? KEY_ENTER : KEY_RETURN);  // (extended: the keypad's)
    return true;
  }
  if (vk >= VK_NUMPAD0 && vk <= VK_NUMPAD9) k.code = static_cast<int16>(KEY_NUMPAD0 + (vk - VK_NUMPAD0));
  else if (vk >= VK_F1 && vk <= VK_F12) k.code = static_cast<int16>(KEY_F1 + (vk - VK_F1));
  else if (vk >= VK_F13 && vk <= VK_F24) k.code = static_cast<int16>(KEY_F13 + (vk - VK_F13));
  for (const auto& m : kMap) {
    if (k.code || m.vk != vk) continue;
    k.code = m.code;
    if (vk == VK_SPACE) k.ch = u' ';
  }
  if (k.code) return true;
  BYTE state[256];
  if (!GetKeyboardState(state)) return false;
  state[VK_CONTROL] = state[VK_LCONTROL] = state[VK_RCONTROL] = 0;
  state[VK_MENU] = state[VK_LMENU] = state[VK_RMENU] = 0;
  WCHAR buf[4];
  const int n = ToUnicode(static_cast<UINT>(vk), static_cast<UINT>((lp >> 16) & 0xFF), state, buf, 4, 0x4);
  if (n != 1 || buf[0] < 0x20) return false;
  k.ch = static_cast<char16>(buf[0]);
  return true;
}

LRESULT CALLBACK editorProc(HWND h, UINT msg, WPARAM wp, LPARAM lp) {
  auto* s = reinterpret_cast<BSlot*>(GetWindowLongPtrW(h, GWLP_USERDATA));
  Inst* in = s ? s->inst : nullptr;
  if (!s || !in || in->editor != h || in->crashed) {
    if (msg == WM_CLOSE) {
      DestroyWindow(h);
      return 0;
    }
    return DefWindowProcW(h, msg, wp, lp);
  }
  IPlugView* view = in->view;
  switch (msg) {
    case WM_SIZE:
      if (view && in->resizable && !in->frame.resizing && wp != SIZE_MINIMIZED) {
        ViewRect r(0, 0, LOWORD(lp), HIWORD(lp));
        if (!guarded([&] { view->onSize(&r); })) editorFault(*s);
      }
      return 0;
    case WM_SIZING: {
      auto* r = reinterpret_cast<RECT*>(lp);
      if (!view || !in->resizable || !r) break;
      const SIZE nc = frameSizeFor(h, 0, 0);
      ViewRect vr(0, 0, std::max<LONG>(1, r->right - r->left - nc.cx), std::max<LONG>(1, r->bottom - r->top - nc.cy));
      if (!guarded([&] { view->checkSizeConstraint(&vr); })) {
        editorFault(*s);
        return TRUE;
      }
      const LONG w = std::max<LONG>(1, vr.getWidth()) + nc.cx, ht = std::max<LONG>(1, vr.getHeight()) + nc.cy;
      if (wp == WMSZ_LEFT || wp == WMSZ_TOPLEFT || wp == WMSZ_BOTTOMLEFT) r->left = r->right - w;
      else r->right = r->left + w;
      if (wp == WMSZ_TOP || wp == WMSZ_TOPLEFT || wp == WMSZ_TOPRIGHT) r->top = r->bottom - ht;
      else r->bottom = r->top + ht;
      return TRUE;
    }
    case WM_DPICHANGED: {
      const RECT* to = reinterpret_cast<const RECT*>(lp);
      in->frame.resized = false;
      if (view && in->scale) {
        IPlugViewContentScaleSupport* css = in->scale;
        const float factor = LOWORD(wp) / 96.f;
        if (!guarded([&] { css->setContentScaleFactor(factor); })) {
          editorFault(*s);
          return 0;
        }
      }
      RECT cr;
      GetClientRect(h, &cr);
      const SIZE sz = frameSizeFor(h, cr.right, cr.bottom);
      UINT flags = SWP_NOZORDER | SWP_NOACTIVATE;
      if (in->frame.resized) flags |= SWP_NOSIZE;
      if (!to) flags |= SWP_NOMOVE;
      SetWindowPos(h, nullptr, to ? to->left : 0, to ? to->top : 0, sz.cx, sz.cy, flags);
      return 0;
    }
    case WM_ACTIVATE: {
      const bool on = LOWORD(wp) != WA_INACTIVE;
      if (!on) {
        HWND f = GetFocus();
        if (f && IsChild(h, f)) in->lastFocus = f;
      }
      if (view && !guarded([&] { view->onFocus(on); })) {
        editorFault(*s);
        return 0;
      }
      break;
    }
    case WM_SETFOCUS: {
      if (in->focusing) return 0;
      HWND to = in->lastFocus && IsWindow(in->lastFocus) && IsChild(h, in->lastFocus) ? in->lastFocus : GetWindow(h, GW_CHILD);
      if (to && IsWindowVisible(to) && IsWindowEnabled(to)) {
        in->focusing = true;
        SetFocus(to);
        in->focusing = false;
      }
      return 0;
    }
    case WM_KEYDOWN:
    case WM_SYSKEYDOWN:
    case WM_KEYUP:
    case WM_SYSKEYUP: {
      VstKey k;
      if (view && vstKey(wp, lp, k)) {
        const bool down = msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN;
        tresult r = kResultFalse;
        if (!guarded([&] { r = down ? view->onKeyDown(k.ch, k.code, k.mods) : view->onKeyUp(k.ch, k.code, k.mods); })) {
          editorFault(*s);
          return 0;
        }
        if (r == kResultTrue) return 0;
      }
      break;
    }
    case WM_CLOSE:
      s->closeReq = h;
      PostMessageW(host().hwnd(), WM_OM_CLOSE, static_cast<WPARAM>(s->index), 0);
      return 0;
    case WM_DESTROY:
      in->editor = nullptr;
      in->frame.hwnd = nullptr;
      in->lastFocus = nullptr;
      s->editorOpen = false;
      s->closeReq = h;
      PostMessageW(host().hwnd(), WM_OM_CLOSE, static_cast<WPARAM>(s->index), 0);
      break;
  }
  return DefWindowProcW(h, msg, wp, lp);
}

void registerEditorClass() {
  static bool registered = false;
  if (registered) return;
  WNDCLASSW wc{};
  wc.lpfnWndProc = editorProc;
  wc.hInstance = GetModuleHandleW(nullptr);
  wc.hCursor = LoadCursor(nullptr, IDC_ARROW);
  wc.hbrBackground = reinterpret_cast<HBRUSH>(GetStockObject(BLACK_BRUSH));
  wc.lpszClassName = kEditorClass;
  registered = RegisterClassW(&wc) != 0 || GetLastError() == ERROR_CLASS_ALREADY_EXISTS;
}

POINT editorAnchor(const BSlot& s, const Inst& in, HWND owner, bool& remembered) {
  const bool offscreen = gEditorsOffscreen.load();
  remembered = false;
  if (s.editorPosValid && s.editorPath == in.path &&
      (offscreen || MonitorFromPoint({s.editorPos.x + 40, s.editorPos.y + 10}, MONITOR_DEFAULTTONULL))) {
    remembered = true;
    return s.editorPos;
  }
  if (offscreen) return {-30000, -30000};
  RECT r;
  if (owner && !IsIconic(owner) && GetWindowRect(owner, &r)) return {(r.left + r.right) / 2, (r.top + r.bottom) / 2};
  MONITORINFO mi{};
  mi.cbSize = sizeof(mi);
  if (GetMonitorInfoW(MonitorFromPoint({0, 0}, MONITOR_DEFAULTTOPRIMARY), &mi))
    return {(mi.rcWork.left + mi.rcWork.right) / 2, (mi.rcWork.top + mi.rcWork.bottom) / 2};
  return {200, 200};
}

void sizeEditor(HWND h, const ViewRect& vr) {
  DpiScope dpi(h);
  const SIZE sz = frameSizeFor(h, std::min<int32>(vr.getWidth(), 16384), std::min<int32>(vr.getHeight(), 16384));
  SetWindowPos(h, nullptr, 0, 0, sz.cx, sz.cy, SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE);
}

void moveEditor(HWND h, POINT at, bool remembered) {
  RECT wr;
  if (!GetWindowRect(h, &wr)) return;
  const LONG w = wr.right - wr.left, ht = wr.bottom - wr.top;
  LONG x = remembered ? at.x : at.x - w / 2, y = remembered ? at.y : at.y - ht / 2;
  MONITORINFO mi{};
  mi.cbSize = sizeof(mi);
  if (!gEditorsOffscreen.load() && GetMonitorInfoW(MonitorFromPoint(at, MONITOR_DEFAULTTONEAREST), &mi)) {
    const RECT& wa = mi.rcWork;
    x = std::max(wa.left, std::min(x, wa.right - w));
    y = std::max(wa.top, std::min(y, wa.bottom - ht));
  }
  SetWindowPos(h, nullptr, x, y, 0, 0, SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);
}

// "" = open
std::string openEditorOnHost(BSlot& s, Inst* in, HWND owner) {
  if (!in) return "no plugin loaded";
  if (in->crashed) return "the plugin crashed";
  const bool offscreen = gEditorsOffscreen.load();
  if (in->editor) {
    ShowWindow(in->editor, IsIconic(in->editor) ? SW_RESTORE : (offscreen ? SW_SHOWNA : SW_SHOW));
    if (!offscreen) SetForegroundWindow(in->editor);
    return "";
  }
  if (!in->controller) return "this plugin has no editor";
  IPtr<IPlugView> view;
  IPtr<IPlugViewContentScaleSupport> css;
  std::string err;
  bool ok = guarded([&] {
    view = owned(in->controller->createView(ViewType::kEditor));
    if (!view) {
      err = "this plugin has no editor";
      return;
    }
    if (view->isPlatformTypeSupported(kPlatformTypeHWND) != kResultTrue) {
      err = "editor not supported on Windows";
      view = nullptr;
      return;
    }
    css = FUnknownPtr<IPlugViewContentScaleSupport>(view);
  });
  auto crashed = [&] {
    view.take();
    css.take();
    markCrashed(s, in);
    return std::string("the plugin crashed");
  };
  auto failed = [&](HWND h, const char* error) {
    if (!guarded([&] {
          if (h) DestroyWindow(h);
          css = nullptr;
          view = nullptr;
        }))
      return crashed();
    return std::string(error);
  };
  if (!ok) return crashed();
  if (!err.empty()) return err;
  registerEditorClass();
  const std::string utf8 = in->name + " \xE2\x80\x94 OpenMix deck " + std::to_string(s.deck + 1);
  const std::wstring title = widen(utf8);
  const DWORD style = WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_CLIPCHILDREN | (owner ? 0 : WS_MINIMIZEBOX);
  bool remembered = false;
  const POINT at = editorAnchor(s, *in, owner, remembered);
  auto createFrame = [&] {
    return CreateWindowExW(0, kEditorClass, title.c_str(), style, at.x, at.y, 1, 1, owner, nullptr,
                           GetModuleHandleW(nullptr), nullptr);
  };
  HWND h = createFrame();
  if (!h) return failed(nullptr, "cannot create the editor window");
  const float forced = gEditorScale.load();
  const float factor = forced > 0.f ? forced : windowDpi(h) / 96.f;
  bool scaled = false;
  if (!guarded([&] { scaled = css && css->setContentScaleFactor(factor) == kResultTrue; })) {
    DestroyWindow(h);
    return crashed();
  }
  if (!scaled && std::abs(factor - 1.f) > 0.01f && windowAwareness(h) == DPI_AWARENESS_PER_MONITOR_AWARE &&
      dpiApi().setThreadCtx) {
    DestroyWindow(h);
    {
      DpiScope dpi(DPI_AWARENESS_CONTEXT_UNAWARE);
      h = createFrame();
    }
    if (!h) return failed(nullptr, "cannot create the editor window");
  }
  ViewRect vr{};
  bool resizable = false;
  if (!guarded([&] {
        if (view->getSize(&vr) != kResultTrue || vr.getWidth() <= 0 || vr.getHeight() <= 0) vr = ViewRect(0, 0, 640, 400);
        resizable = view->canResize() == kResultTrue;
      })) {
    DestroyWindow(h);
    return crashed();
  }
  if (resizable) {
    SetWindowLongW(h, GWL_STYLE, static_cast<LONG>(style | WS_THICKFRAME));
    SetWindowPos(h, nullptr, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED);
  }
  sizeEditor(h, vr);
  moveEditor(h, at, remembered);
  SetWindowLongPtrW(h, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(&s));
  in->editor = h;
  in->frame.hwnd = h;
  in->frame.resized = false;
  in->resizable = resizable;
  in->lastFocus = nullptr;
  in->focusing = false;
  tresult attached = kResultFalse;
  ok = guarded([&] {
    DpiScope dpi(h);
    view->setFrame(&in->frame);
    attached = view->attached(h, kPlatformTypeHWND);
    if (attached != kResultTrue) view->setFrame(nullptr);
  });
  if (!ok) {
    in->view = std::move(view);
    in->scale = std::move(css);
    markCrashed(s, in);
    abandonEditor(s, in);
    return "the plugin crashed";
  }
  if (attached != kResultTrue) {
    in->editor = nullptr;
    in->frame.hwnd = nullptr;
    SetWindowLongPtrW(h, GWLP_USERDATA, 0);
    return failed(h, "the editor refused to open");
  }
  in->view = std::move(view);
  if (scaled) {
    in->scale = std::move(css);
  } else if (!guarded([&] { css = nullptr; })) {
    css.take();
    markCrashed(s, in);
    abandonEditor(s, in);
    return "the plugin crashed";
  }
  s.editorOpen = true;
  if (in->frame.resized && !remembered) moveEditor(h, at, false);
  if (!guarded([&] { ShowWindow(h, offscreen ? SW_SHOWNA : SW_SHOWNORMAL); }) || in->crashed) {
    markCrashed(s, in);
    abandonEditor(s, in);
    return "the plugin crashed";
  }
  return "";
}

// ---------------------------------------------------------------------------
// Faults and events from the top of the host loop
// ---------------------------------------------------------------------------
void onDispatchFault(const Fault& f, HWND hwnd) {
  HMODULE m = moduleOf(f.address);
  HWND root = hwnd ? GetAncestor(hwnd, GA_ROOT) : nullptr;
  for (auto& s : gSlots) {
    Inst* in = s.inst;
    if (!in) continue;
    if ((m && (in->hmod == m || in->dll == m)) || (root && in->editor == root)) {
      markCrashed(s, in);
      abandonEditor(s, in);
    }
  }
}

void onHostEvent(UINT msg, int index) {
  if (index < 0 || index >= kMaxSlots) return;
  BSlot& s = gSlots[index];
  switch (msg) {
    case WM_OM_CRASHED:
      if (s.inst && s.inst->crashed) abandonEditor(s, s.inst);
      break;
    case WM_OM_RESTART:
      onRestart(index);
      break;
    case WM_OM_CLOSE: {
      HWND closed = s.closeReq;
      s.closeReq = nullptr;
      if (s.inst && (!s.inst->editor || s.inst->editor == closed)) closeEditorOnHost(s);
      break;
    }
  }
}

INT_PTR CALLBACK inertDialogProc(HWND, UINT, WPARAM, LPARAM) { return FALSE; }

struct DeadWindowScan {
  std::vector<HMODULE> dead;
  std::vector<HWND> found;
};

bool deadWindow(HWND w, const DeadWindowScan& scan, bool& dialog) {
  wchar_t cls[64] = {};
  GetClassNameW(w, cls, 64);
  if (!wcscmp(cls, kEditorClass)) return false;
  dialog = !wcscmp(cls, L"#32770");
  const void* proc = reinterpret_cast<const void*>(GetWindowLongPtrW(w, dialog ? DWLP_DLGPROC : GWLP_WNDPROC));
  const HMODULE m = moduleOf(proc);
  return m && std::find(scan.dead.begin(), scan.dead.end(), m) != scan.dead.end();
}

void detachWindow(HWND w, bool dialog) {
  if (dialog) SetWindowLongPtrW(w, DWLP_DLGPROC, reinterpret_cast<LONG_PTR>(&inertDialogProc));
  else SetWindowLongPtrW(w, GWLP_WNDPROC, reinterpret_cast<LONG_PTR>(&DefWindowProcW));
}

BOOL CALLBACK findDeadWindow(HWND w, LPARAM p) {
  auto* scan = reinterpret_cast<DeadWindowScan*>(p);
  bool dialog = false;
  if (IsWindowVisible(w) && w != host().hwnd() && deadWindow(w, *scan, dialog)) scan->found.push_back(w);
  return TRUE;
}

BOOL CALLBACK detachDeadChild(HWND w, LPARAM p) {
  bool dialog = false;
  if (deadWindow(w, *reinterpret_cast<DeadWindowScan*>(p), dialog)) detachWindow(w, dialog);
  return TRUE;
}

// After a fault was caught on the host thread: windows a crashed plugin
// disabled (OpenMix's, an editor) are enabled again; its windows left on
// screen are detached from its code and destroyed.
void recoverWindows() {
  gRecoveries++;
  HWND owner = gOwner.load();
  if (owner && IsWindow(owner) && !IsWindowEnabled(owner)) EnableWindow(owner, TRUE);
  DeadWindowScan scan;
  std::vector<HMODULE> healthy;
  auto add = [](std::vector<HMODULE>& v, const Inst* in) {
    if (in->hmod) v.push_back(in->hmod);
    if (in->dll && in->dll != in->hmod) v.push_back(in->dll);
  };
  for (auto& s : gSlots) {
    Inst* in = s.inst;
    if (!in) continue;
    if (in->crashed) {
      add(scan.dead, in);
      continue;
    }
    add(healthy, in);
    if (in->editor && IsWindow(in->editor) && !IsWindowEnabled(in->editor)) EnableWindow(in->editor, TRUE);
  }
  for (const Inst* in : gAbandoned) add(scan.dead, in);
  scan.dead.erase(std::remove_if(scan.dead.begin(), scan.dead.end(),
                                 [&](HMODULE m) { return std::find(healthy.begin(), healthy.end(), m) != healthy.end(); }),
                  scan.dead.end());
  if (scan.dead.empty()) return;
  EnumThreadWindows(GetCurrentThreadId(), findDeadWindow, reinterpret_cast<LPARAM>(&scan));
  for (HWND w : scan.found) {
    bool dialog = false;
    deadWindow(w, scan, dialog);
    detachWindow(w, dialog);
    EnumChildWindows(w, detachDeadChild, reinterpret_cast<LPARAM>(&scan));
  }
  for (HWND w : scan.found) {
    if (!IsWindow(w)) continue;
    DestroyWindow(w);
    gWindowsClosed++;
  }
}

LRESULT CALLBACK HostThread::wndProc(HWND h, UINT msg, WPARAM wp, LPARAM lp) {
  auto* self = reinterpret_cast<HostThread*>(GetWindowLongPtrW(h, GWLP_USERDATA));
  switch (msg) {
    case WM_OM_TASK:
      if (self) {
        if (self->depth_ > 0) self->notePump();
        self->drain();
      }
      return 0;
    case WM_OM_PING:
      if (!self) return 0;
      self->pingPending_ = false;
      if (self->depth_ == 0) {
        self->stalled_ = false;
      } else {
        self->heldPings_++;
        self->notePump();
      }
      return 0;
    case WM_OM_CRASHED:
    case WM_OM_RESTART:
    case WM_OM_CLOSE:
      if (self) self->event(msg, wp);
      return 0;
  }
  return DefWindowProcW(h, msg, wp, lp);
}

bool startHost(std::string* err) {
  if (gHostStarted.load()) return true;
  static std::mutex m;
  std::lock_guard<std::mutex> lk(m);
  if (gHostStarted.load()) return true;
  if (!host().start(onDispatchFault, releasePending, recoverWindows)) {
    if (err) *err = "cannot start the VST host thread";
    return false;
  }
  auto r = host().call(
      [](HostThread::Job&) {
        gHostApp = owned(new OpenMixHostApplication());
        PluginContextFactory::instance().setPluginContext(gHostApp);
      },
      gTimeouts.shortOp.load() * 2);
  if (r != HostThread::kDone) {
    if (err) *err = "the VST host thread does not answer";
    return false;
  }
  gHostStarted = true;
  return true;
}

struct CallFailure {
  const char* error;
  const char* code;
};

CallFailure callFailure(HostThread::Result r) {
  switch (r) {
    case HostThread::kTimeout: return {"the plugin is not responding", "timeout"};
    case HostThread::kBusy: return {"a VST plugin is not responding", "busy"};
    case HostThread::kFault: return {"the plugin crashed", "crashed"};
    default: return {"VST host not started", "stopped"};
  }
}

// ---------------------------------------------------------------------------
// Scanning — one module per call, on a thread of its own.
// ---------------------------------------------------------------------------
// A bundle's Contents/Resources/moduleinfo.json, resolved from the UTF-8
// path (the SDK's getModuleInfoPath converts through the ANSI code page and
// misses bundles under non-ASCII folders).
bool moduleInfoFile(const std::string& path, std::filesystem::path& out) {
  std::error_code ec;
  const std::filesystem::path p = pathFromUtf8(path);
  if (!std::filesystem::is_directory(p, ec)) return false;
  out = p / "Contents" / "Resources" / "moduleinfo.json";
  return std::filesystem::is_regular_file(out, ec);
}

bool scanModuleInfo(const std::string& path, std::vector<VstPluginInfo>& out) {
  try {
    std::filesystem::path file;
    if (!moduleInfoFile(path, file)) return false;
    std::ifstream f(file, std::ios::binary);
    if (!f) return false;
    std::string text((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
    if (text.empty() || text.size() > (4u << 20)) return false;
    auto info = Steinberg::ModuleInfoLib::parseJson(text, nullptr);
    if (!info) return false;
    std::vector<VstPluginInfo> list;
    for (auto& c : info->classes) {
      std::string subs;
      for (auto& sc : c.subCategories) subs += (subs.empty() ? "" : "|") + sc;
      if (!insertClass(c.category, subs)) continue;
      std::string uid = normalizeUid(c.cid);
      if (uid.size() != 32) return false;  // unusable description: load the module instead
      list.push_back({path, c.name, c.vendor.empty() ? info->factoryInfo.vendor : c.vendor, uid, subs});
    }
    out = std::move(list);
    return true;
  } catch (...) {
    return false;
  }
}

struct ScanJob {
  std::mutex m;
  std::condition_variable cv;
  bool done = false;
  VstScanResult result;
};

void scanThread(std::shared_ptr<ScanJob> job, std::string path) {
  HRESULT ole = OleInitialize(nullptr);
  VstScanResult r;
  r.path = path;
  r.source = "module";
  auto* holder = new VST3::Hosting::Module::Ptr();
  std::vector<VstPluginInfo> found;
  std::string error;
  bool ok = guarded([&] {
    std::string err;
    *holder = loadModule(path, err);
    if (!*holder) {
      error = err.empty() ? "cannot load module" : err;
      return;
    }
    auto factory = (*holder)->getFactory();
    for (auto& ci : factory.classInfos()) {
      if (!insertClass(ci.category(), ci.subCategoriesString())) continue;
      found.push_back({path, ci.name(), ci.vendor(), ci.ID().toString(), ci.subCategoriesString()});
    }
  });
  if (ok) ok = guarded([&] { holder->reset(); });  // ExitDll + FreeLibrary
  if (ok) delete holder;                            // (a faulty module stays loaded)
  r.crashed = !ok;
  if (ok) {
    r.plugins = std::move(found);
    r.error = std::move(error);
  } else {
    r.error = "the plugin crashed while loading";
  }
  if (SUCCEEDED(ole) && ok) OleUninitialize();
  {
    std::lock_guard<std::mutex> lk(job->m);
    job->result = std::move(r);
    job->done = true;
  }
  job->cv.notify_all();
}

VstScanResult scanOne(const std::string& path, DWORD timeoutMs) {
  VstScanResult r;
  r.path = path;
  {
    std::error_code ec;
    if (!std::filesystem::exists(pathFromUtf8(path), ec)) {
      r.error = "file not found";
      return r;
    }
  }
  if (scanModuleInfo(path, r.plugins)) {
    r.source = "moduleinfo";
    return r;
  }
  {
    std::lock_guard<std::mutex> lk(gModulesLock);
    auto it = loadedModules().find(moduleKey(path));
    if (it != loadedModules().end()) {
      r.plugins = it->second.classes;
      for (auto& p : r.plugins) p.path = path;
      r.source = "loaded";
      return r;
    }
  }
  auto job = std::make_shared<ScanJob>();
  try {
    std::thread(scanThread, job, path).detach();
  } catch (...) {
    r.error = "cannot start the scan";
    return r;
  }
  // patient: a licence / nag window of the module waits for the user (up to
  // the dialog time-out); only the module's own time counts toward timeoutMs
  const ULONGLONG t0 = GetTickCount64();
  ULONGLONG since = t0;
  bool sawDialog = false;
  std::unique_lock<std::mutex> lk(job->m);
  for (;;) {
    const ULONGLONG waited = GetTickCount64() - since;
    const ULONGLONG left = waited < timeoutMs ? timeoutMs - waited : 0;
    const DWORD slice =
        static_cast<DWORD>(std::max<ULONGLONG>(1, std::min<ULONGLONG>(kWaitSliceMs, left ? left : kWaitSliceMs)));
    if (job->cv.wait_for(lk, std::chrono::milliseconds(slice), [&] { return job->done; })) break;
    const ULONGLONG now = GetTickCount64();
    const bool dialog = otherThreadWindowShown(host().tid());
    if (dialog || sawDialog) since = now;
    sawDialog = dialog;
    if (now - since >= timeoutMs || now - t0 >= std::max<ULONGLONG>(timeoutMs, gTimeouts.dialog.load())) {
      r.timedOut = true;
      r.source = "module";
      r.error = "the plugin did not respond";
      return r;  // the module's thread is left behind
    }
  }
  return std::move(job->result);
}

// ---------------------------------------------------------------------------
// The backend of one VstHost
// ---------------------------------------------------------------------------
class SdkBackend final : public Backend {
 public:
  ~SdkBackend() override { release(); }

  bool start(SlotControl* ctl, double, int, std::string* err) override {
    if (!startHost(err)) return false;
    std::lock_guard<std::mutex> lk(gSlotAlloc);
    for (int g = 0; g < kMaxSlots / kNumDecks; g++) {
      if (gGroupUsed[g]) continue;
      gGroupUsed[g] = true;
      base_ = g * kNumDecks;
      for (int d = 0; d < kNumDecks; d++) {
        BSlot& s = gSlots[base_ + d];
        s.ctl = ctl;
        s.deck = d;
        s.editorOpen = false;
        s.editorPosValid = false;
      }
      return true;
    }
    if (err) *err = "too many VST hosts";
    return false;
  }

  void stop() override {
    if (base_ < 0) return;
    // (the shell unloaded every deck before; whatever is left is abandoned)
    const int base = base_;
    auto started = std::make_shared<std::atomic<bool>>(false);
    const auto r = host().call(
        [base, started](HostThread::Job&) {
          started->store(true);
          for (int d = 0; d < kNumDecks; d++) {
            BSlot& s = gSlots[base + d];
            if (s.inst) abandonInst(s, s.inst);
            s.inst = nullptr;
            s.ctl = nullptr;
          }
        },
        gTimeouts.shortOp.load() * 2);
    if (r != HostThread::kDone && !started->load()) {
      // a stalled host thread: what is left is abandoned from the top of its loop once it answers
      for (int d = 0; d < kNumDecks; d++) {
        BSlot& s = gSlots[base + d];
        if (Inst* in = s.inst) {
          gPendingAbandon[s.index].store(true);
          gPendingRelease[s.index].store(in);
        }
      }
      host().wake();
    }
    release();
  }

  void setTimeouts(const VstTimeouts& t) override {
    gTimeouts.load = std::max<DWORD>(50, t.load);
    gTimeouts.editor = std::max<DWORD>(50, t.editor);
    gTimeouts.scan = std::max<DWORD>(50, t.scan);
    gTimeouts.state = std::max<DWORD>(50, t.state);
    gTimeouts.shortOp = std::max<DWORD>(50, t.shortOp);
    gTimeouts.quiesce = std::max<DWORD>(50, t.quiesce);
    gTimeouts.dialog = std::max<DWORD>(50, t.dialog);
  }

  void setOptions(const VstHostOptions& o) override {
    gEditorsOffscreen = o.editorsOffscreen;
    gEditorScale = (o.editorScale >= 0.5f && o.editorScale <= 4.0f) ? o.editorScale : 0.f;
  }

  void setOwnerWindow(uintptr_t hwnd) override {
    HWND h = reinterpret_cast<HWND>(hwnd);
    if (h && IsWindow(h)) gOwner = h;
  }

  LoadOut load(int deck, const std::string& path, const std::string& uid, double sampleRate, int maxBlockFrames) override {
    LoadOut out;
    if (base_ < 0) {
      out.result.error = "VST host not started";
      out.result.code = "stopped";
      return out;
    }
    {
      std::error_code ec;
      if (!std::filesystem::exists(pathFromUtf8(path), ec)) {
        out.result.error = "plugin file not found";
        out.result.code = "notFound";
        return out;
      }
    }
    BSlot* s = &gSlots[base_ + deck];
    auto res = std::make_shared<LoadOut>();
    auto r = host().call(
        [s, path, uid, sampleRate, maxBlockFrames, res](HostThread::Job& job) {
          LoadOut& o = *res;
          releasePending();
          if (s->inst) {
            o.result.error = "the deck already has a plugin";
            o.result.code = "load_failed";
            return;
          }
          Inst* in = new Inst();
          in->slot = s->index;
          in->handler.slot = s->index;
          in->path = path;
          in->rate = sampleRate;
          in->maxBlock = std::max(16, maxBlockFrames);
          gRestartFlags[s->index].store(0);
          std::string err;
          if (!guarded([&] { err = createInst(*in, path, uid); })) {
            abandonInst(*s, in);
            o.result.error = "the plugin crashed while loading";
            o.result.code = "crashed";
            return;
          }
          if (!err.empty()) {
            destroyInst(*s, in);
            o.result.error = err;
            o.result.code = "load_failed";
            return;
          }
          if (!job.commit()) {  // the caller gave up (time-out): undo
            destroyInst(*s, in);
            o.result.error = "the plugin is not responding";
            o.result.code = "timeout";
            return;
          }
          s->inst = in;
          o.result.ok = true;
          o.result.name = in->name;
          o.result.latency = in->latency;
          o.result.inputs = in->inCh;
          o.result.outputs = in->outCh;
          o.proc = in;
          o.inst = in;
        },
        gTimeouts.load.load(), &patientWait());
    if (r == HostThread::kDone) return *res;
    const CallFailure f = callFailure(r);
    out.result.error = r == HostThread::kFault ? "the plugin crashed while loading" : f.error;
    out.result.code = f.code;
    return out;
  }

  void unload(int deck, void* inst, bool abandon) override {
    if (base_ < 0 || !inst) return;
    BSlot* s = &gSlots[base_ + deck];
    Inst* in = static_cast<Inst*>(inst);
    auto started = std::make_shared<std::atomic<bool>>(false);
    const auto r = host().call(
        [s, in, abandon, started](HostThread::Job&) {
          started->store(true);
          if (s->inst == in) s->inst = nullptr;
          if (abandon || in->crashed) abandonInst(*s, in);
          else destroyInst(*s, in);
        },
        gTimeouts.shortOp.load() * 2, &patientWait());
    if (r != HostThread::kDone && !started->load()) {
      // never ran (stalled host thread: the task was skipped or not queued): later, from the top of its loop
      gPendingAbandon[s->index].store(abandon);
      gPendingRelease[s->index].store(in);
      host().wake();
    }
  }

  bool getState(int deck, void* inst, std::string& blob, std::string& err) override {
    if (base_ < 0 || !inst) return false;
    BSlot* s = &gSlots[base_ + deck];
    Inst* in = static_cast<Inst*>(inst);
    auto out = std::make_shared<std::pair<bool, std::string>>(false, std::string());
    auto e = std::make_shared<std::string>();
    auto r = host().call([s, in, out, e](HostThread::Job&) { out->first = getStateOnHost(*s, in, out->second, *e); },
                         gTimeouts.state.load(), &patientWait());
    if (r != HostThread::kDone) {
      err = callFailure(r).error;
      return false;
    }
    err = *e;
    if (out->first) blob = std::move(out->second);
    return out->first;
  }

  bool setState(int deck, void* inst, const std::string& blob, std::string& err, int* latency) override {
    if (latency) *latency = -1;
    if (base_ < 0 || !inst) return false;
    BSlot* s = &gSlots[base_ + deck];
    Inst* in = static_cast<Inst*>(inst);
    auto b = std::make_shared<std::string>(blob);
    struct Out {
      bool ok = false;
      std::string err;
      int latency = -1;
    };
    auto out = std::make_shared<Out>();
    auto r = host().call([s, in, b, out](HostThread::Job&) { out->ok = setStateOnHost(*s, in, *b, out->err, &out->latency); },
                         gTimeouts.state.load(), &patientWait());
    if (r != HostThread::kDone) {
      err = callFailure(r).error;
      return false;
    }
    err = out->err;
    if (latency) *latency = out->latency;
    return out->ok;
  }

  std::string openEditor(int deck, void* inst, uintptr_t owner) override {
    if (base_ < 0 || !inst) return "VST host not started";
    BSlot* s = &gSlots[base_ + deck];
    Inst* in = static_cast<Inst*>(inst);
    HWND o = reinterpret_cast<HWND>(owner);
    if (o && !IsWindow(o)) o = nullptr;
    if (o) gOwner = o;
    auto res = std::make_shared<std::string>();
    auto r = host().call([s, in, o, res](HostThread::Job&) { *res = openEditorOnHost(*s, in, o); }, gTimeouts.editor.load(),
                         &patientWait());
    if (r != HostThread::kDone) return callFailure(r).error;
    return *res;
  }

  void closeEditor(int deck, void* inst) override {
    if (base_ < 0 || !inst) return;
    BSlot* s = &gSlots[base_ + deck];
    Inst* in = static_cast<Inst*>(inst);
    host().call(
        [s, in](HostThread::Job&) {
          if (s->inst == in && !closeEditorOf(*s, in, in->crashed.load())) markCrashed(*s, in);
        },
        gTimeouts.shortOp.load(), &patientWait());
  }

  bool reconfigure(int deck, void* inst, double sampleRate, int maxBlockFrames, int* latency, std::string& err) override {
    if (base_ < 0 || !inst) return false;
    BSlot* s = &gSlots[base_ + deck];
    Inst* in = static_cast<Inst*>(inst);
    struct Out {
      bool ok = false;
      int latency = 0;
      std::string err;
    };
    auto out = std::make_shared<Out>();
    auto r = host().call(
        [s, in, sampleRate, maxBlockFrames, out](HostThread::Job&) {
          if (in->crashed) {
            out->err = "the plugin crashed";
            return;
          }
          in->rate = sampleRate;
          in->maxBlock = std::max(16, maxBlockFrames);
          ProcessSetup setup{kRealtime, kSample32, in->maxBlock, in->rate};
          bool disable = false;
          if (!reactivate(*in, false, &setup, &disable)) {
            markCrashed(*s, in);
            abandonEditor(*s, in);
            out->err = "the plugin crashed";
            return;
          }
          if (disable) {
            if (s->ctl) s->ctl->markDisabled(s->deck, in);
            out->err = "the plugin refused the new sample rate";
            return;
          }
          out->ok = true;
          out->latency = in->latency;
        },
        gTimeouts.state.load(), &patientWait());
    if (r != HostThread::kDone) {
      err = callFailure(r).error;
      return false;
    }
    err = out->err;
    if (latency) *latency = out->latency;
    return out->ok;
  }

  bool editorOpen(int deck) const noexcept override { return base_ >= 0 && gSlots[base_ + deck].editorOpen.load(); }
  bool busy() const noexcept override { return host().stalled(); }
  bool dialog() const noexcept override { return host().waitsForUser(); }

 private:
  void release() {
    if (base_ < 0) return;
    std::lock_guard<std::mutex> lk(gSlotAlloc);
    gGroupUsed[base_ / kNumDecks] = false;
    base_ = -1;
  }
  int base_ = -1;
};

}  // namespace

std::unique_ptr<Backend> createBackend() { return std::make_unique<SdkBackend>(); }

std::vector<VstScanResult> scan(const std::vector<std::string>& paths, const VstTimeouts& t) {
  std::vector<VstScanResult> out;
  for (const std::string& p : paths) out.push_back(scanOne(p, std::max<DWORD>(100, t.scan)));
  return out;
}

bool sdkAvailable(std::string* version) {
  IPtr<HostApplication> app = owned(new HostApplication());
  if (version) *version = kVstVersionString;
  return app != nullptr;
}

}  // namespace vstbk
}  // namespace om
