// VST3 inserts processed with the audio callback (owner: decoder, library
// om_vst), portable part: the four per-deck worker threads and their
// lock-free handoff (begin() hands the block over, end() spins at most until
// the callback deadline: on time = the plugin output, late = the
// latency-aligned dry, a call that never returns = hung), the dry lines
// sized for the 1 s latency cap (every dry path is delayed by the plugin
// latency, so timing never jumps), dry/wet mix with the Web engine's 10 ms
// smoothing, the re-prime after a gap in the plugin's input stream (its next
// L output frames, which would carry misplaced audio, are replaced by the
// latency-aligned dry), transport, events, non-blocking status (and the
// lock-free insert state of the snapshot), and the control side
// (load / unload / state / latency changes) that keeps a worker out of its
// plugin while the VST host thread works on it. The Win32 host thread, the
// SDK loading, state, editors and the SEH guard live in src/vst/win/
// (stand-ins in src/vst/none/). SPEC.md §13.
#include "om/vst_insert.h"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstring>
#include <mutex>
#include <thread>
#include <vector>

#if defined(_M_X64) || defined(_M_IX86) || defined(__x86_64__) || defined(__i386__)
#include <immintrin.h>
#define OM_CPU_RELAX() _mm_pause()
#elif defined(__aarch64__)
#define OM_CPU_RELAX() __asm__ __volatile__("yield")
#else
#define OM_CPU_RELAX() ((void)0)
#endif

#include "om/dsp.h"
#include "om/om_state.h"
#include "om/rt.h"
#include "vst_backend.h"

namespace om {

namespace {

constexpr uint32_t kIdle = 0, kReady = 1, kRunning = 2, kDone = 3;
// A process() call that has not returned after 2 s = hung. A plugin that
// always returns, however late, is never hung: its late blocks play the
// latency-aligned dry and are counted (lateBlocks, vst.late, insert LATE).
constexpr int64_t kHungNs = 2'000'000'000;
constexpr int64_t kLateEventPeriodNs = 1'000'000'000;  // vst.late at most once per second per deck
constexpr double kMixTau = 0.01;                   // vst.js: mix.setTargetAtTime(mix, now, 0.01)

inline int64_t steadyNs() noexcept {
  using namespace std::chrono;
  return duration_cast<nanoseconds>(steady_clock::now().time_since_epoch()).count();
}

// One deck's worker: a real-time thread that runs the plugin's process() on
// the block the callback handed it. Shared between the slot and the thread
// (an abandoned worker, stuck in a hung plugin, keeps its context alive).
struct WorkerCtx {
  explicit WorkerCtx(int d)
      : deck(d), inL(kMaxBlockFrames), inR(kMaxBlockFrames), outL(kMaxBlockFrames), outR(kMaxBlockFrames) {}
  int deck;
  std::atomic<uint32_t> state{kIdle};  // Idle -> Ready (audio) -> Running -> Done (worker) -> Idle (audio)
  std::atomic<uint32_t> wake{0};       // bumped to wake the worker (Ready, quit)
  std::atomic<bool> quit{false};
  // the block: written by the audio thread before Ready, read by the worker
  IVstProcessor* proc = nullptr;
  VstProcessBlock block;
  std::vector<float> inL, inR, outL, outR;
  // the result: written by the worker before Done
  VstProcessResult result = VstProcessResult::Ok;
  std::atomic<int64_t> runStartNs{0};  // 0 = not inside process()
  std::atomic<int64_t> maxNs{0}, totalNs{0};
  std::atomic<uint64_t> calls{0}, pluginAllocs{0};
  std::thread thread;
};

void workerMain(std::shared_ptr<WorkerCtx> w) {
  void* token = vstbk::prepareWorkerThread(w->deck);
  dsp::flushDenormals();
  {
    rt::Scope rts;  // engine code on this thread follows the real-time rules (plugin code is lifted below)
    for (;;) {
      const uint32_t seq = w->wake.load(std::memory_order_acquire);
      if (w->state.load(std::memory_order_acquire) == kReady) {
        w->state.store(kRunning, std::memory_order_relaxed);
        const int64_t t0 = steadyNs();
        w->runStartNs.store(t0, std::memory_order_relaxed);
        const uint64_t a0 = rt::pluginAllocations();
        VstProcessResult res = VstProcessResult::Crashed;
        {
          dsp::FpEnvGuard fp;   // the worker's FTZ | DAZ comes back whatever the plugin did
          rt::PluginScope plugin;
          struct Call {
            IVstProcessor* p;
            const VstProcessBlock* b;
            VstProcessResult r;
          } call{w->proc, &w->block, VstProcessResult::Crashed};
          uint32_t code = 0;
          if (call.p &&
              vstbk::guardedCall([](void* c) {
                auto* k = static_cast<Call*>(c);
                k->r = k->p->process(*k->b);
              }, &call, &code))
            res = call.r;
        }
        const int64_t dur = steadyNs() - t0;
        w->runStartNs.store(0, std::memory_order_relaxed);
        w->pluginAllocs.fetch_add(rt::pluginAllocations() - a0, std::memory_order_relaxed);
        w->totalNs.fetch_add(dur, std::memory_order_relaxed);
        w->calls.fetch_add(1, std::memory_order_relaxed);
        if (dur > w->maxNs.load(std::memory_order_relaxed)) w->maxNs.store(dur, std::memory_order_relaxed);
        w->result = res;
        w->state.store(kDone, std::memory_order_release);
        continue;
      }
      if (w->quit.load(std::memory_order_acquire)) break;
      w->wake.wait(seq, std::memory_order_acquire);
    }
  }
  vstbk::releaseWorkerThread(token);
}

void startWorker(const std::shared_ptr<WorkerCtx>& w) {
  w->quit.store(false);
  w->thread = std::thread(workerMain, w);
}

void stopWorker(WorkerCtx& w, bool join) {
  w.quit.store(true, std::memory_order_release);
  w.wake.fetch_add(1, std::memory_order_release);
  w.wake.notify_all();
  if (w.thread.joinable()) {
    if (join) w.thread.join();
    else w.thread.detach();
  }
}

// The deck's pre-insert signal of the last second (and a bit): what the
// latency-aligned dry is read from.
struct DryLine {
  explicit DryLine(double rate) {
    const int64_t need = static_cast<int64_t>(std::ceil(kMaxInsertLatencySec * rate)) + 2 * kMaxBlockFrames + 1;
    size = 1;
    while (size < need) size <<= 1;
    mask = size - 1;
    l.reset(new float[static_cast<size_t>(size)]());
    r.reset(new float[static_cast<size_t>(size)]());
  }
  void write(int64_t pos, const float* a, const float* b, int n) noexcept {
    for (int i = 0; i < n;) {
      const int64_t at = (pos + i) & mask;
      const int run = static_cast<int>(std::min<int64_t>(n - i, size - at));
      std::memcpy(l.get() + at, a + i, static_cast<size_t>(run) * sizeof(float));
      std::memcpy(r.get() + at, b + i, static_cast<size_t>(run) * sizeof(float));
      i += run;
    }
  }
  // frames [pos, pos + n): silence before the line's first frame (pos < 0)
  void read(int64_t pos, int n, float* a, float* b) const noexcept {
    int i = 0;
    for (; i < n && pos + i < 0; i++) a[i] = b[i] = 0.0f;
    while (i < n) {
      const int64_t at = (pos + i) & mask;
      const int run = static_cast<int>(std::min<int64_t>(n - i, size - at));
      std::memcpy(a + i, l.get() + at, static_cast<size_t>(run) * sizeof(float));
      std::memcpy(b + i, r.get() + at, static_cast<size_t>(run) * sizeof(float));
      i += run;
    }
  }
  int64_t size = 0, mask = 0;
  std::unique_ptr<float[]> l, r;
};

struct Slot {
  int deck = 0;
  // ---- control side (vst-ops and VST host threads): short sections, never across a backend call ----
  std::mutex ctl;
  int busy = 0;         // beginOp() nesting: the worker is kept out of the plugin
  bool loaded = false;
  void* inst = nullptr;                   // backend instance (VST3 plugin)
  std::shared_ptr<IVstProcessor> owned;   // attached processor (tests, built-in inserts)
  IVstProcessor* procCtl = nullptr;
  std::shared_ptr<WorkerCtx> worker;
  std::unique_ptr<DryLine> dry;
  // ---- shared (atomics) ----
  std::atomic<uint32_t> gen{1};  // bumped whenever proc / worker / latency / dry line change
  std::atomic<IVstProcessor*> proc{nullptr};
  std::atomic<WorkerCtx*> workerRaw{nullptr};
  std::atomic<DryLine*> dryRaw{nullptr};
  std::atomic<int> latency{0};
  std::atomic<bool> hasPlugin{false};
  std::atomic<bool> enabled{false};  // the audio thread may hand blocks to the worker
  std::atomic<bool> handing{false};  // the audio thread is inside a handoff (handshake with beginOp)
  std::atomic<bool> reprime{false};  // endOp(): the host thread worked on the plugin (its input history has a gap)
  std::atomic<uint32_t> installs{0};  // bumped by every install (a new plugin's history starts empty: no re-prime)
  std::atomic<bool> crashed{false}, hung{false}, latencyRefused{false}, disabled{false};
  std::atomic<uint8_t> events{0};
  std::atomic<bool> latencyChanged{false};
  std::atomic<uint64_t> processed{0}, late{0}, busySkips{0}, errors{0};
  std::atomic<float> mixShown{1.0f};
  std::atomic<bool> lastLate{false};  // the last block played the dry because the plugin was late or busy (insertState)
  // ---- audio thread only ----
  uint32_t aGen = 0;
  IVstProcessor* aProc = nullptr;
  WorkerCtx* aWorker = nullptr;
  DryLine* aDry = nullptr;
  bool aHasPlugin = false, aHealthy = false;
  int aLatency = 0;
  double aMix = 1.0, aMixTarget = 1.0;
  VstTransport transport;
  bool handed = false;
  bool blockLate = false, aLastLate = false;  // this block / the published lastLate
  bool awaitingLate = false;  // a block of the current install came back late and has not finished yet
  int64_t blockPos = 0;  // dry-line position of the current block's first frame
  int64_t dryPos = 0;    // frames written to the dry line
  int64_t lastHandNs = 0;
  int64_t lastLateEventNs = INT64_MIN / 4;
  int64_t contFrames = 0;
  bool hungSignalled = false, crashedSignalled = false;
  // Re-prime: a block the plugin never got (busy worker, the host thread working
  // on it, a new instance after kReloadComponent) leaves its next L output
  // frames built from a history with a gap; they are replaced by the
  // latency-aligned dry, which is exactly what the deck expects there.
  uint32_t aInstalls = 0;
  int64_t nextHandPos = -1;           // dry-line position of the plugin's next input frame (-1: no history yet)
  IVstProcessor* handProc = nullptr;  // the processor that got the last block
  int handLatency = 0;                // the latency then (a latency change moves the deck: no re-prime)
  int64_t primeLeft = 0;              // plugin output frames still to replace
  int blockPrime = 0;                 // frames of the current block replaced (begin -> end)
  std::vector<float> scratchL = std::vector<float>(kMaxBlockFrames), scratchR = std::vector<float>(kMaxBlockFrames);
};

int capFrames(double rate) noexcept { return static_cast<int>(std::floor(kMaxInsertLatencySec * rate + 1e-9)); }

const char kB64[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

}  // namespace

std::string base64Encode(const std::string& in) {
  std::string out;
  out.reserve((in.size() + 2) / 3 * 4);
  size_t i = 0;
  for (; i + 2 < in.size(); i += 3) {
    const uint32_t v = (static_cast<uint8_t>(in[i]) << 16) | (static_cast<uint8_t>(in[i + 1]) << 8) | static_cast<uint8_t>(in[i + 2]);
    out += kB64[(v >> 18) & 63];
    out += kB64[(v >> 12) & 63];
    out += kB64[(v >> 6) & 63];
    out += kB64[v & 63];
  }
  if (i < in.size()) {
    const bool two = i + 1 < in.size();
    const uint32_t v = (static_cast<uint8_t>(in[i]) << 16) | (two ? static_cast<uint8_t>(in[i + 1]) << 8 : 0);
    out += kB64[(v >> 18) & 63];
    out += kB64[(v >> 12) & 63];
    out += two ? kB64[(v >> 6) & 63] : '=';
    out += '=';
  }
  return out;
}

bool base64Decode(const std::string& text, std::string& out) {
  out.clear();
  out.reserve(text.size() / 4 * 3);
  uint32_t acc = 0;
  int bits = 0, pad = 0;
  for (char c : text) {
    int v;
    if (c >= 'A' && c <= 'Z') v = c - 'A';
    else if (c >= 'a' && c <= 'z') v = c - 'a' + 26;
    else if (c >= '0' && c <= '9') v = c - '0' + 52;
    else if (c == '+' || c == '-') v = 62;
    else if (c == '/' || c == '_') v = 63;
    else if (c == '=') {
      pad++;
      continue;
    } else if (c == '\r' || c == '\n' || c == ' ' || c == '\t') {
      continue;
    } else {
      return false;
    }
    if (pad) return false;  // data after padding
    acc = (acc << 6) | static_cast<uint32_t>(v);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out += static_cast<char>((acc >> bits) & 0xFF);
    }
  }
  return pad <= 2;
}

// ===========================================================================
struct VstHost::Impl final : public vstbk::SlotControl {
  Slot slots[kNumDecks];
  std::unique_ptr<vstbk::Backend> backend;              // vst-ops side
  std::atomic<vstbk::Backend*> backendRaw{nullptr};     // status() (any thread): never freed before ~VstHost
  std::vector<std::unique_ptr<vstbk::Backend>> oldBackends;
  std::mutex life;  // start / stop / reconfigure
  std::atomic<bool> runningFlag{false};
  std::atomic<double> rate{48000.0};
  int maxBlock = kMaxBlockFrames;
  VstTimeouts timeouts;                    // vst-ops thread
  std::atomic<uint32_t> quiesceMs{2000};   // read by beginOp() on the vst-ops and VST host threads
  VstHostOptions options;
  uintptr_t owner = 0;
  std::mutex graveM;
  std::vector<std::shared_ptr<WorkerCtx>> graveWorkers;       // abandoned workers (stuck in a hung plugin)
  std::vector<std::shared_ptr<IVstProcessor>> graveProcs;     // processors such a worker may still run
  std::vector<std::unique_ptr<DryLine>> graveDry;             // replaced dry lines (the audio thread may hold one)
  std::vector<std::shared_ptr<WorkerCtx>> stoppedWorkers;     // joined at stop(), kept for the audio thread's pointers
  // The device rate seen by the audio thread (frames of a callback / its
  // period): load() re-setups the host when the core did not call start() /
  // reconfigure() with the device rate.
  std::atomic<int> detectedRate{0};
  // ---- audio thread ----
  int64_t deadlineNs = 0;
  float deadlineFrac = 0.35f;
  double aRate = 48000.0;
  double mixCoef = 0.0;  // per-sample smoothing factor (tau 10 ms)
  int64_t aFramesSince = 0;  // deck 0's frames since the previous startCallback
  double aLastPeriod = 0.0;

  Impl() {
    for (int d = 0; d < kNumDecks; d++) {
      Slot& s = slots[d];
      s.deck = d;
      s.worker = std::make_shared<WorkerCtx>(d);
      s.workerRaw.store(s.worker.get());
      s.dry = std::make_unique<DryLine>(48000.0);
      s.dryRaw.store(s.dry.get());
    }
    mixCoef = std::exp(-1.0 / (kMixTau * 48000.0));
    (void)steadyNs();
  }

  int cap() const noexcept { return capFrames(rate.load()); }

  // ---- SlotControl ----
  bool beginOp(int d) override {
    Slot& s = slots[d];
    WorkerCtx* w;
    {
      std::lock_guard<std::mutex> lk(s.ctl);
      s.busy++;
      s.enabled.store(false, std::memory_order_seq_cst);
      w = s.worker.get();
    }
    // (the audio thread either saw enabled == false, or is still handing a
    // block, which then shows in the worker state below)
    while (s.handing.load(std::memory_order_seq_cst)) std::this_thread::yield();
    const int64_t t0 = steadyNs();
    for (;;) {
      const uint32_t st = w->state.load(std::memory_order_acquire);
      if (st != kReady && st != kRunning) return true;
      if (steadyNs() - t0 > static_cast<int64_t>(quiesceMs.load()) * 1'000'000) return false;
      std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
  }

  void endOp(int d) override {
    Slot& s = slots[d];
    std::lock_guard<std::mutex> lk(s.ctl);
    if (s.busy > 0) s.busy--;
    s.reprime.store(true, std::memory_order_release);  // (the plugin missed blocks, or the host reset it)
    refreshEnabledLocked(s);
  }

  void setLatency(int d, void* inst, int latency) override {
    Slot& s = slots[d];
    std::lock_guard<std::mutex> lk(s.ctl);
    if (!s.loaded || (s.inst != inst && static_cast<void*>(s.procCtl) != inst)) return;
    applyLatencyLocked(s, latency);
  }

  void markCrashed(int d, void* inst) override {
    Slot& s = slots[d];
    std::lock_guard<std::mutex> lk(s.ctl);
    if (!s.loaded || s.inst != inst) return;
    if (!s.crashed.exchange(true)) s.events.fetch_or(kVstCrashed);
    refreshEnabledLocked(s);
  }

  void markDisabled(int d, void* inst) override {
    Slot& s = slots[d];
    std::lock_guard<std::mutex> lk(s.ctl);
    if (!s.loaded || s.inst != inst) return;
    s.disabled.store(true);
    refreshEnabledLocked(s);
  }

  void replaceInstance(int d, void* oldInst, void* newInst, IVstProcessor* proc, int latency) override {
    Slot& s = slots[d];
    std::lock_guard<std::mutex> lk(s.ctl);
    if (!s.loaded || s.inst != oldInst) return;
    s.inst = newInst;
    s.procCtl = proc;
    s.proc.store(proc, std::memory_order_release);
    s.gen.fetch_add(1, std::memory_order_seq_cst);
    applyLatencyLocked(s, latency);
  }

  // ---- control helpers (caller holds s.ctl) ----
  void refreshEnabledLocked(Slot& s) {
    const bool on = s.loaded && s.procCtl && s.busy == 0 && !s.crashed.load() && !s.hung.load() &&
                    !s.latencyRefused.load() && !s.disabled.load();
    s.enabled.store(on, std::memory_order_seq_cst);
  }

  void applyLatencyLocked(Slot& s, int latency) {
    if (latency < 0) latency = 0;
    if (latency > cap()) {
      // refused: bypassed with the latency the deck already compensates (no jump)
      s.latencyRefused.store(true);
      s.events.fetch_or(kVstLatency);
    } else {
      s.latencyRefused.store(false);
      if (latency != s.latency.load()) {
        s.latency.store(latency, std::memory_order_release);
        s.gen.fetch_add(1, std::memory_order_seq_cst);
      }
    }
    s.latencyChanged.store(true);
    refreshEnabledLocked(s);
  }

  void installLocked(Slot& s, void* inst, std::shared_ptr<IVstProcessor> owned, IVstProcessor* proc, int latency) {
    s.loaded = true;
    s.inst = inst;
    s.owned = std::move(owned);
    s.procCtl = proc;
    s.crashed.store(false);
    s.hung.store(false);
    s.latencyRefused.store(false);
    s.disabled.store(false);
    s.processed.store(0);
    s.late.store(0);
    s.busySkips.store(0);
    s.errors.store(0);
    WorkerCtx& w = *s.worker;  // idle: nothing was handed to it since the slot was emptied
    w.maxNs.store(0);
    w.totalNs.store(0);
    w.calls.store(0);
    w.pluginAllocs.store(0);
    s.proc.store(proc, std::memory_order_release);
    s.latency.store(latency, std::memory_order_release);
    s.hasPlugin.store(true, std::memory_order_release);
    s.latencyChanged.store(true);
    s.reprime.store(false, std::memory_order_release);
    s.installs.fetch_add(1, std::memory_order_release);
    s.gen.fetch_add(1, std::memory_order_seq_cst);
    refreshEnabledLocked(s);
  }

  bool ensureStarted(std::string* err) {
    if (runningFlag.load()) return true;
    return startImpl(rate.load(), maxBlock, err);
  }

  bool startImpl(double r, int mb, std::string* err) {
    std::unique_lock<std::mutex> lk(life);
    if (runningFlag.load()) {
      lk.unlock();
      if (r != rate.load()) reconfigureImpl(r, mb);
      return true;
    }
    if (!(r >= 8000.0 && r <= 768000.0)) {
      if (err) *err = "bad sample rate";
      return false;
    }
    rate.store(r);
    maxBlock = std::clamp(mb, 16, kMaxBlockFrames);
    resizeDryLocked(r);
    for (Slot& s : slots) {
      std::lock_guard<std::mutex> sl(s.ctl);
      if (!s.worker->thread.joinable()) startWorker(s.worker);
    }
    std::unique_ptr<vstbk::Backend> b = vstbk::createBackend();
    b->setTimeouts(timeouts);
    b->setOptions(options);
    if (owner) b->setOwnerWindow(owner);
    std::string e;
    const bool ok = b->start(this, r, maxBlock, &e);
    if (ok) {
      backend = std::move(b);
      backendRaw.store(backend.get(), std::memory_order_release);
    } else {
      oldBackends.push_back(std::move(b));
      if (err) *err = e.empty() ? "cannot start the VST host" : e;
    }
    runningFlag.store(true);  // the workers run (attached processors work) even without a plugin backend
    return ok;
  }

  // New dry lines when the rate needs longer ones (the old ones stay alive:
  // the audio thread may still hold a pointer until its next startCallback).
  void resizeDryLocked(double r) {
    for (Slot& s : slots) {
      const int64_t need = static_cast<int64_t>(std::ceil(kMaxInsertLatencySec * r)) + 2 * kMaxBlockFrames + 1;
      std::lock_guard<std::mutex> sl(s.ctl);
      if (s.dry && s.dry->size >= need) continue;
      auto line = std::make_unique<DryLine>(r);
      s.dryRaw.store(line.get(), std::memory_order_release);
      {
        std::lock_guard<std::mutex> g(graveM);
        if (s.dry) graveDry.push_back(std::move(s.dry));
      }
      s.dry = std::move(line);
      s.gen.fetch_add(1, std::memory_order_seq_cst);
    }
  }

  void reconfigureImpl(double r, int mb) {
    {
      std::lock_guard<std::mutex> lk(life);
      rate.store(r);
      maxBlock = std::clamp(mb, 16, kMaxBlockFrames);
      resizeDryLocked(r);
    }
    for (int d = 0; d < kNumDecks; d++) {
      Slot& s = slots[d];
      void* inst;
      {
        std::lock_guard<std::mutex> lk(s.ctl);
        inst = s.loaded ? s.inst : nullptr;
        if (!inst || s.crashed.load() || s.hung.load()) continue;
      }
      if (!backend) continue;
      if (!beginOp(d)) {
        markHungCtl(s);
        endOp(d);
        continue;
      }
      int lat = 0;
      std::string err;
      if (backend->reconfigure(d, inst, r, maxBlock, &lat, err)) setLatency(d, inst, lat);
      endOp(d);
    }
  }

  void markHungCtl(Slot& s) {
    if (!s.hung.exchange(true)) s.events.fetch_or(kVstHung);
    std::lock_guard<std::mutex> lk(s.ctl);
    refreshEnabledLocked(s);
  }

  void unloadImpl(int d) {
    Slot& s = slots[d];
    {
      std::lock_guard<std::mutex> lk(s.ctl);
      if (!s.loaded) return;
    }
    const bool idle = beginOp(d);
    void* inst;
    std::shared_ptr<IVstProcessor> owned;
    std::shared_ptr<WorkerCtx> abandoned;
    bool abandon;
    {
      std::lock_guard<std::mutex> lk(s.ctl);
      inst = s.inst;
      owned = std::move(s.owned);
      abandon = !idle || s.crashed.load() || s.hung.load();
      if (abandon) {
        // The worker may still be inside the plugin (hung): it is left there.
        // A worker that ran faulting plugin code (crashed) is retired too,
        // never reused for the next plugin. The deck gets a fresh worker.
        abandoned = std::move(s.worker);
        s.worker = std::make_shared<WorkerCtx>(d);
        s.workerRaw.store(s.worker.get(), std::memory_order_release);
        if (runningFlag.load()) startWorker(s.worker);
      }
      s.inst = nullptr;
      s.procCtl = nullptr;
      s.loaded = false;
      s.proc.store(nullptr, std::memory_order_release);
      s.hasPlugin.store(false, std::memory_order_release);
      s.latency.store(0, std::memory_order_release);
      s.crashed.store(false);
      s.hung.store(false);
      s.latencyRefused.store(false);
      s.disabled.store(false);
      s.latencyChanged.store(true);
      s.gen.fetch_add(1, std::memory_order_seq_cst);
    }
    if (abandoned) {
      // An idle worker (not inside the plugin) ends at once: joined. One that
      // may be stuck in a hung plugin is detached. Either way its context
      // stays alive for the audio thread's pointer (grave).
      stopWorker(*abandoned, idle);
      std::lock_guard<std::mutex> g(graveM);
      graveWorkers.push_back(std::move(abandoned));
      if (owned && !idle) graveProcs.push_back(std::move(owned));  // a stuck worker may still run it
    }
    if (inst && backend) backend->unload(d, inst, abandon);
    endOp(d);
    // (an attached processor whose worker was idle is released here)
  }

  // ---- audio thread helpers ----
  void adopt(Slot& s) noexcept {
    const uint32_t g = s.gen.load(std::memory_order_acquire);
    if (g != s.aGen) {
      s.aGen = g;
      s.aProc = s.proc.load(std::memory_order_acquire);
      s.aWorker = s.workerRaw.load(std::memory_order_acquire);
      DryLine* line = s.dryRaw.load(std::memory_order_acquire);
      if (line != s.aDry) {
        s.aDry = line;
        s.dryPos = 0;
        s.nextHandPos = -1;  // (a new dry line holds no history to re-prime from)
      }
      const bool had = s.aHasPlugin;
      s.aHasPlugin = s.hasPlugin.load(std::memory_order_acquire);
      if (s.aHasPlugin && !had) {
        s.contFrames = 0;
        s.hungSignalled = false;
        s.crashedSignalled = false;
      }
      const uint32_t inst = s.installs.load(std::memory_order_acquire);
      if (!s.aHasPlugin || inst != s.aInstalls) {
        // a new plugin starts with an empty history (as at load): nothing to re-prime
        s.aInstalls = inst;
        s.nextHandPos = -1;
        s.primeLeft = 0;
        s.handProc = nullptr;
        s.awaitingLate = false;  // (a late result left by the previous plugin is never this one's)
        s.aLastLate = false;  // (insertState: a new plugin is not late)
        s.lastLate.store(false, std::memory_order_relaxed);
      }
      const int L = s.latency.load(std::memory_order_acquire);
      if (L != s.aLatency) {
        s.aLatency = L;
        s.events.fetch_or(kVstLatency);
      }
    }
    s.aHealthy = s.aHasPlugin && s.aProc && s.aWorker && !s.crashed.load(std::memory_order_relaxed) &&
                 !s.hung.load(std::memory_order_relaxed) && !s.latencyRefused.load(std::memory_order_relaxed) &&
                 !s.disabled.load(std::memory_order_relaxed);
  }

  void markHungRt(Slot& s) noexcept {
    s.hung.store(true);
    if (!s.hungSignalled) {
      s.hungSignalled = true;
      s.events.fetch_or(kVstHung);
    }
    s.aHealthy = false;
  }

  void markCrashedRt(Slot& s) noexcept {
    s.crashed.store(true);
    if (!s.crashedSignalled) {
      s.crashedSignalled = true;
      s.events.fetch_or(kVstCrashed);
    }
    s.aHealthy = false;
  }

  void advanceMix(Slot& s, int n) noexcept {
    if (s.aMix == s.aMixTarget) return;
    s.aMix = s.aMixTarget + (s.aMix - s.aMixTarget) * std::pow(mixCoef, n);
    if (std::fabs(s.aMix - s.aMixTarget) < 1e-6) s.aMix = s.aMixTarget;
  }
};

// ===========================================================================
VstHost::VstHost() : impl_(std::make_unique<Impl>()) {}

VstHost::~VstHost() { stop(); }

bool VstHost::start(double sampleRate, int maxBlockFrames, std::string* err) {
  return impl_->startImpl(sampleRate, maxBlockFrames, err);
}

void VstHost::stop() {
  Impl& m = *impl_;
  if (!m.runningFlag.load()) return;
  for (int d = 0; d < kNumDecks; d++) m.unloadImpl(d);
  std::lock_guard<std::mutex> lk(m.life);
  if (m.backend) {
    m.backend->stop();
    m.backendRaw.store(nullptr, std::memory_order_release);
    m.oldBackends.push_back(std::move(m.backend));  // (a status() call may still read it)
  }
  for (Slot& s : m.slots) {
    std::lock_guard<std::mutex> sl(s.ctl);
    stopWorker(*s.worker, true);
    // a fresh (not started) context: the old one stays alive for the audio thread's pointer
    m.stoppedWorkers.push_back(s.worker);
    s.worker = std::make_shared<WorkerCtx>(s.deck);
    s.workerRaw.store(s.worker.get(), std::memory_order_release);
    s.gen.fetch_add(1, std::memory_order_seq_cst);
  }
  m.runningFlag.store(false);
}

bool VstHost::running() const noexcept { return impl_->runningFlag.load(); }
double VstHost::sampleRate() const noexcept { return impl_->rate.load(); }

void VstHost::setTimeouts(const VstTimeouts& t) {
  impl_->timeouts = t;
  impl_->quiesceMs.store(std::max<uint32_t>(50, t.quiesce));
  if (impl_->backend) impl_->backend->setTimeouts(t);
}

void VstHost::setOptions(const VstHostOptions& o) {
  impl_->options = o;
  if (impl_->backend) impl_->backend->setOptions(o);
}

void VstHost::setOwnerWindow(uintptr_t hwnd) {
  impl_->owner = hwnd;
  if (impl_->backend) impl_->backend->setOwnerWindow(hwnd);
}

void VstHost::reconfigure(double sampleRate, int maxBlockFrames) {
  if (!impl_->runningFlag.load()) {
    impl_->rate.store(sampleRate);
    impl_->maxBlock = std::clamp(maxBlockFrames, 16, kMaxBlockFrames);
    return;
  }
  impl_->reconfigureImpl(sampleRate, maxBlockFrames);
}

VstLoadResult VstHost::load(int deck, const std::string& path, const std::string& uid, const std::string& stateBase64) {
  Impl& m = *impl_;
  VstLoadResult r;
  if (deck < 0 || deck >= kNumDecks) {
    r.error = "bad deck";
    return r;
  }
  std::string err;
  if (!m.ensureStarted(&err) || !m.backend) {
    r.error = err.empty() ? "VST host not started" : err;
    r.code = "stopped";
    return r;
  }
  // (the device runs at another rate than the host was set up for: re-setup first)
  const int det = m.detectedRate.load();
  if (det > 0 && det != static_cast<int>(std::llround(m.rate.load()))) m.reconfigureImpl(det, m.maxBlock);
  m.unloadImpl(deck);
  vstbk::LoadOut lo = m.backend->load(deck, path, uid, m.rate.load(), m.maxBlock);
  if (!lo.result.ok || !lo.proc) return lo.result;
  int latency = lo.result.latency;
  if (!stateBase64.empty()) {
    std::string blob, e;
    int lat = -1;
    if (base64Decode(stateBase64, blob) && m.backend->setState(deck, lo.inst, blob, e, &lat)) {
      lo.result.stateRestored = true;
      if (lat >= 0) latency = lat;
    }
  }
  if (latency > m.cap()) {
    m.backend->unload(deck, lo.inst, false);
    VstLoadResult f;
    f.error = "the plugin latency (" + std::to_string(latency) + " samples) is above the 1 s limit";
    f.code = "latency";
    f.name = lo.result.name;
    f.latency = latency;
    return f;
  }
  {
    Slot& s = m.slots[deck];
    std::lock_guard<std::mutex> lk(s.ctl);
    m.installLocked(s, lo.inst, nullptr, lo.proc, latency);
  }
  lo.result.latency = latency;
  return lo.result;
}

void VstHost::unload(int deck) {
  if (deck < 0 || deck >= kNumDecks) return;
  impl_->unloadImpl(deck);
}

bool VstHost::setState(int deck, const std::string& stateBase64) {
  Impl& m = *impl_;
  if (deck < 0 || deck >= kNumDecks || !m.backend) return false;
  std::string blob;
  if (!base64Decode(stateBase64, blob)) return false;
  Slot& s = m.slots[deck];
  void* inst;
  {
    std::lock_guard<std::mutex> lk(s.ctl);
    inst = s.loaded ? s.inst : nullptr;
    if (!inst || s.crashed.load() || s.hung.load()) return false;
  }
  if (!m.beginOp(deck)) {  // the plugin's process() never runs while its state is replaced
    m.markHungCtl(s);
    m.endOp(deck);
    return false;
  }
  int lat = -1;
  std::string err;
  const bool ok = m.backend->setState(deck, inst, blob, err, &lat);
  if (ok && lat >= 0) m.setLatency(deck, inst, lat);
  m.endOp(deck);
  return ok;
}

std::string VstHost::getState(int deck) {
  Impl& m = *impl_;
  if (deck < 0 || deck >= kNumDecks || !m.backend) return {};
  Slot& s = m.slots[deck];
  void* inst;
  {
    std::lock_guard<std::mutex> lk(s.ctl);
    inst = s.loaded ? s.inst : nullptr;
    if (!inst || s.crashed.load() || s.hung.load()) return {};
  }
  std::string blob, err;
  if (!m.backend->getState(deck, inst, blob, err)) return {};
  return base64Encode(blob);
}

std::string VstHost::openEditor(int deck, uintptr_t ownerHwnd) {
  Impl& m = *impl_;
  if (deck < 0 || deck >= kNumDecks) return "bad deck";
  if (!m.backend) return "VST host not started";
  Slot& s = m.slots[deck];
  void* inst;
  {
    std::lock_guard<std::mutex> lk(s.ctl);
    inst = s.loaded ? s.inst : nullptr;
    if (!inst) return s.loaded ? "this insert has no editor" : "no plugin loaded";
    if (s.crashed.load() || s.hung.load()) return "the plugin crashed";
  }
  return m.backend->openEditor(deck, inst, ownerHwnd ? ownerHwnd : m.owner);
}

void VstHost::closeEditor(int deck) {
  Impl& m = *impl_;
  if (deck < 0 || deck >= kNumDecks || !m.backend) return;
  Slot& s = m.slots[deck];
  void* inst;
  {
    std::lock_guard<std::mutex> lk(s.ctl);
    inst = s.loaded ? s.inst : nullptr;
  }
  if (inst) m.backend->closeEditor(deck, inst);
}

VstLoadResult VstHost::attachProcessor(int deck, std::shared_ptr<IVstProcessor> proc, int latency, const std::string& name) {
  Impl& m = *impl_;
  VstLoadResult r;
  if (deck < 0 || deck >= kNumDecks || !proc) {
    r.error = "bad arguments";
    return r;
  }
  std::string err;
  m.ensureStarted(&err);  // (the workers run even without a plugin backend)
  if (latency < 0) latency = 0;
  if (latency > m.cap()) {
    r.error = "the latency (" + std::to_string(latency) + " samples) is above the 1 s limit";
    r.code = "latency";
    r.name = name;
    r.latency = latency;
    return r;
  }
  m.unloadImpl(deck);
  IVstProcessor* raw = proc.get();
  {
    Slot& s = m.slots[deck];
    std::lock_guard<std::mutex> lk(s.ctl);
    m.installLocked(s, nullptr, std::move(proc), raw, latency);
  }
  r.ok = true;
  r.name = name;
  r.latency = latency;
  r.inputs = r.outputs = 2;
  return r;
}

void VstHost::setProcessorLatency(int deck, int latency) {
  Impl& m = *impl_;
  if (deck < 0 || deck >= kNumDecks) return;
  Slot& s = m.slots[deck];
  IVstProcessor* p;
  {
    std::lock_guard<std::mutex> lk(s.ctl);
    p = s.procCtl;
    if (!s.loaded || s.inst || !p) return;
  }
  // what a plugin's kLatencyChanged goes through: the worker kept out, then the new latency
  if (!m.beginOp(deck)) {
    m.markHungCtl(s);
    m.endOp(deck);
    return;
  }
  m.setLatency(deck, p, latency);
  m.endOp(deck);
}

VstSlotStatus VstHost::status(int deck) const {
  VstSlotStatus st;
  if (deck < 0 || deck >= kNumDecks) return st;
  Impl& m = *impl_;
  Slot& s = m.slots[deck];
  WorkerCtx* w = s.workerRaw.load(std::memory_order_acquire);
  const int64_t t0 = w ? w->runStartNs.load(std::memory_order_relaxed) : 0;
  const bool stuck = t0 != 0 && steadyNs() - t0 > kHungNs;
  st.loaded = s.hasPlugin.load();
  st.crashed = s.crashed.load();
  st.hung = s.hung.load() || (st.loaded && stuck);
  st.latencyRefused = s.latencyRefused.load();
  st.active = st.loaded && s.enabled.load() && !st.crashed && !st.hung;
  st.mix = s.mixShown.load();
  st.bypassed = st.loaded && (st.mix <= 0.0f || st.latencyRefused || s.disabled.load());
  st.latency = s.latency.load();
  st.latencyChanged = s.latencyChanged.exchange(false);
  st.processed = s.processed.load();
  st.lateBlocks = s.late.load();
  st.busySkips = s.busySkips.load();
  st.processErrors = s.errors.load();
  if (w) {
    const uint64_t calls = w->calls.load();
    st.maxProcessMs = w->maxNs.load() / 1e6;
    st.avgProcessMs = calls ? (w->totalNs.load() / 1e6) / static_cast<double>(calls) : 0.0;
    st.pluginAllocs = w->pluginAllocs.load();
  }
  if (vstbk::Backend* b = m.backendRaw.load(std::memory_order_acquire)) {
    st.editorOpen = b->editorOpen(deck);
    st.busy = b->busy();
    st.dialog = st.busy && b->dialog();
  }
  return st;
}

uint8_t VstHost::insertState(int deck, uint64_t* lateBlocks) const noexcept {
  if (lateBlocks) *lateBlocks = 0;
  if (deck < 0 || deck >= kNumDecks) return OM_INSERT_NONE;
  const Slot& s = impl_->slots[deck];
  if (!s.hasPlugin.load(std::memory_order_acquire)) return OM_INSERT_NONE;
  if (lateBlocks) *lateBlocks = s.late.load(std::memory_order_relaxed);
  if (s.crashed.load(std::memory_order_relaxed)) return OM_INSERT_CRASHED;
  const WorkerCtx* w = s.workerRaw.load(std::memory_order_acquire);
  const int64_t t0 = w ? w->runStartNs.load(std::memory_order_relaxed) : 0;
  if (s.hung.load(std::memory_order_relaxed) || (t0 != 0 && steadyNs() - t0 > kHungNs)) return OM_INSERT_HUNG;
  if (s.mixShown.load(std::memory_order_relaxed) <= 0.0f || s.latencyRefused.load(std::memory_order_relaxed) ||
      s.disabled.load(std::memory_order_relaxed))
    return OM_INSERT_BYPASSED;
  if (s.lastLate.load(std::memory_order_relaxed)) return OM_INSERT_LATE;
  return OM_INSERT_ACTIVE;
}

// ---- audio thread ------------------------------------------------------------
void VstHost::startCallback(double periodSeconds) noexcept {
  Impl& m = *impl_;
  const int64_t now = steadyNs();
  const double period = periodSeconds > 0 ? periodSeconds : 0.0;
  m.deadlineNs = now + static_cast<int64_t>(m.deadlineFrac * period * 1e9);
  if (m.aLastPeriod > 0.0 && m.aFramesSince > 0) {
    const double det = static_cast<double>(m.aFramesSince) / m.aLastPeriod;
    if (det >= 8000.0 && det <= 768000.0) m.detectedRate.store(static_cast<int>(std::llround(det)), std::memory_order_relaxed);
  }
  m.aFramesSince = 0;
  m.aLastPeriod = period;
  const double r = m.rate.load(std::memory_order_relaxed);
  if (r != m.aRate && r > 0) {
    m.aRate = r;
    m.mixCoef = std::exp(-1.0 / (kMixTau * r));
  }
  for (Slot& s : m.slots) m.adopt(s);
}

void VstHost::setDeadline(float f) noexcept { impl_->deadlineFrac = clampv(f, 0.1f, 0.6f); }

void VstHost::setMix(int deck, float mix) noexcept {
  if (deck < 0 || deck >= kNumDecks) return;
  Slot& s = impl_->slots[deck];
  const float v = (mix >= 0.0f) ? (mix <= 1.0f ? mix : 1.0f) : 0.0f;  // (NaN -> 0)
  s.aMixTarget = v;
  s.mixShown.store(v, std::memory_order_relaxed);
}

void VstHost::setTransport(int deck, const VstTransport& t) noexcept {
  if (deck < 0 || deck >= kNumDecks) return;
  impl_->slots[deck].transport = t;
}

bool VstHost::begin(int deck, const float* l, const float* r, int frames) noexcept {
  if (deck < 0 || deck >= kNumDecks || frames <= 0 || !l || !r) return false;
  Impl& m = *impl_;
  Slot& s = m.slots[deck];
  const int n = frames < kMaxBlockFrames ? frames : kMaxBlockFrames;
  if (deck == 0) m.aFramesSince += frames;
  s.handed = false;
  s.blockLate = false;
  s.blockPrime = 0;
  // the dry line always follows the deck (a plugin loaded later finds a valid history)
  s.blockPos = s.dryPos;
  if (s.aDry) {
    s.aDry->write(s.dryPos, l, r, n);
    s.dryPos += n;
  }
  if (!s.aHasPlugin && s.aLatency == 0) return false;
  if (s.aHealthy) {
    WorkerCtx& w = *s.aWorker;
    uint32_t st = w.state.load(std::memory_order_acquire);
    if (st == kDone) {
      // A late block finished in the background: its audio is discarded (the
      // dry played), but a crash it reported still disables the slot (only a
      // block of this install: a result left by a previous plugin is dropped).
      const bool crashedLate = s.awaitingLate && w.result == VstProcessResult::Crashed;
      s.awaitingLate = false;
      w.state.store(kIdle, std::memory_order_relaxed);
      st = kIdle;
      if (crashedLate) {
        m.markCrashedRt(s);
        s.contFrames += n;
        return true;
      }
    }
    if (st == kIdle) {
      s.handing.store(true, std::memory_order_seq_cst);
      if (s.enabled.load(std::memory_order_seq_cst) && s.gen.load(std::memory_order_seq_cst) == s.aGen) {
        // a gap in the plugin's input stream, same latency: re-prime
        const bool hostWorked = s.reprime.exchange(false, std::memory_order_acq_rel);
        if (s.nextHandPos >= 0 && s.handLatency == s.aLatency &&
            (hostWorked || s.blockPos != s.nextHandPos || s.handProc != s.aProc))
          s.primeLeft = s.aLatency;
        s.blockPrime = static_cast<int>(s.primeLeft < n ? s.primeLeft : n);
        s.primeLeft -= s.blockPrime;
        s.nextHandPos = s.blockPos + n;
        s.handProc = s.aProc;
        s.handLatency = s.aLatency;
        std::memcpy(w.inL.data(), l, static_cast<size_t>(n) * sizeof(float));
        std::memcpy(w.inR.data(), r, static_cast<size_t>(n) * sizeof(float));
        w.proc = s.aProc;
        VstProcessBlock& b = w.block;
        b.inL = w.inL.data();
        b.inR = w.inR.data();
        b.outL = w.outL.data();
        b.outR = w.outR.data();
        b.frames = n;
        b.sampleRate = m.aRate;
        b.transport = s.transport;
        b.continuousFrames = s.contFrames;
        s.lastHandNs = steadyNs();
        b.systemTimeNs = s.lastHandNs;
        w.state.store(kReady, std::memory_order_release);
        w.wake.fetch_add(1, std::memory_order_release);
        w.wake.notify_one();
        s.handed = true;
      }
      s.handing.store(false, std::memory_order_seq_cst);
    } else {
      // still on an earlier block (late, or a call that does not return)
      s.busySkips.fetch_add(1, std::memory_order_relaxed);
      s.blockLate = true;
      if (steadyNs() - s.lastHandNs > kHungNs) m.markHungRt(s);
    }
  }
  s.contFrames += n;
  return true;
}

void VstHost::end(int deck, float* l, float* r, int frames) noexcept {
  if (deck < 0 || deck >= kNumDecks || frames <= 0 || !l || !r) return;
  Impl& m = *impl_;
  Slot& s = m.slots[deck];
  const int n = frames < kMaxBlockFrames ? frames : kMaxBlockFrames;
  float* wetL = nullptr;
  float* wetR = nullptr;
  if (s.handed) {
    s.handed = false;
    WorkerCtx& w = *s.aWorker;
    uint32_t st = w.state.load(std::memory_order_acquire);
    while (st != kDone) {  // the one sanctioned wait: a bounded spin, no kernel call (SPEC.md §3.2)
      if (steadyNs() >= m.deadlineNs) break;
      OM_CPU_RELAX();
      st = w.state.load(std::memory_order_acquire);
    }
    if (st == kDone) {
      const VstProcessResult res = w.result;
      w.state.store(kIdle, std::memory_order_relaxed);
      if (res == VstProcessResult::Ok) {
        s.processed.fetch_add(1, std::memory_order_relaxed);
        wetL = w.outL.data();
        wetR = w.outR.data();
      } else if (res == VstProcessResult::Error) {
        s.errors.fetch_add(1, std::memory_order_relaxed);
      } else {
        m.markCrashedRt(s);
      }
    } else {
      // Late: the dry plays. Not hung: a call that returns after the deadline
      // is seen finished by the next begin(); one that never returns is
      // caught there by the 2 s rule (SPEC.md §13.2).
      s.late.fetch_add(1, std::memory_order_relaxed);
      s.blockLate = true;
      s.awaitingLate = true;
      const int64_t now = steadyNs();
      if (now - s.lastLateEventNs >= kLateEventPeriodNs) {
        s.lastLateEventNs = now;
        s.events.fetch_or(kVstLate);
      }
    }
  }
  if (s.blockLate != s.aLastLate) {  // published for insertState() only when it changes
    s.aLastLate = s.blockLate;
    s.lastLate.store(s.blockLate, std::memory_order_relaxed);
  }
  // The dry, delayed by the plugin latency (what the deck's read-ahead expects).
  float* dl = s.scratchL.data();
  float* dr = s.scratchR.data();
  if (s.aDry) {
    s.aDry->read(s.blockPos - s.aLatency, n, dl, dr);
  } else {
    std::memset(dl, 0, static_cast<size_t>(n) * sizeof(float));
    std::memset(dr, 0, static_cast<size_t>(n) * sizeof(float));
  }
  if (!wetL) {
    std::memcpy(l, dl, static_cast<size_t>(n) * sizeof(float));
    std::memcpy(r, dr, static_cast<size_t>(n) * sizeof(float));
    m.advanceMix(s, n);
    return;
  }
  if (s.blockPrime > 0) {
    // re-prime: the plugin's first output frames of this block come from a
    // history with a gap; the latency-aligned dry instead (the worker's
    // buffer belongs to the audio thread until the next handoff)
    std::memcpy(wetL, dl, static_cast<size_t>(s.blockPrime) * sizeof(float));
    std::memcpy(wetR, dr, static_cast<size_t>(s.blockPrime) * sizeof(float));
  }
  if (s.aMix == s.aMixTarget && s.aMix == 1.0) {  // plugin output as is (bit-exact)
    std::memcpy(l, wetL, static_cast<size_t>(n) * sizeof(float));
    std::memcpy(r, wetR, static_cast<size_t>(n) * sizeof(float));
    return;
  }
  if (s.aMix == s.aMixTarget && s.aMix == 0.0) {  // bypass: the latency-aligned dry
    std::memcpy(l, dl, static_cast<size_t>(n) * sizeof(float));
    std::memcpy(r, dr, static_cast<size_t>(n) * sizeof(float));
    return;
  }
  double mix = s.aMix;
  const double target = s.aMixTarget, k = m.mixCoef;
  for (int i = 0; i < n; i++) {
    mix = target + (mix - target) * k;
    if (std::fabs(mix - target) < 1e-6) mix = target;
    const float g = static_cast<float>(mix);
    l[i] = wetL[i] * g + dl[i] * (1.0f - g);
    r[i] = wetR[i] * g + dr[i] * (1.0f - g);
  }
  s.aMix = mix;
}

int VstHost::latencyFrames(int deck) const noexcept {
  if (deck < 0 || deck >= kNumDecks) return 0;
  return impl_->slots[deck].aLatency;
}

uint8_t VstHost::takeEvents(int deck) noexcept {
  if (deck < 0 || deck >= kNumDecks) return 0;
  return impl_->slots[deck].events.exchange(0);
}

std::vector<VstPluginInfo> scanVstPlugins(const std::vector<std::string>& paths) {
  std::vector<VstPluginInfo> all;
  try {
    for (const VstScanResult& r : vstbk::scan(paths, VstTimeouts()))
      all.insert(all.end(), r.plugins.begin(), r.plugins.end());
  } catch (...) {
  }
  return all;
}

std::vector<VstScanResult> scanVstPluginsDetailed(const std::vector<std::string>& paths, const VstTimeouts& t) {
  try {
    return vstbk::scan(paths, t);
  } catch (...) {
    return {};
  }
}

bool vstSdkAvailable(std::string* version) { return vstbk::sdkAvailable(version); }
bool vstFaultGuardAvailable() noexcept { return vstbk::faultGuardAvailable(); }

}  // namespace om
