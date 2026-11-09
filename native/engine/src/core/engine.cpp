// Engine core (owner: host): module ownership; command intake (parse on the
// caller's thread, atomic batches with queue reservation, routing to inline
// / ops / vst-ops / audio, lazy FX unit and chain requests); the device
// render callback (command dispatch with sample-exact "when" splitting and
// "applied" confirmations, contiguous ack, sync tick, beat clocks, VST
// transport and insert latency, decks, two-phase mixer, recorder and phones
// taps, snapshot publication with segments, end latch, device fields and
// health counters, retired backlog); the control thread (woken by the audio
// thread's events, retired objects and memory frees, FX allocation with
// preparation generations, state events only when new, heartbeat, end-latch
// events, overflow diagnostics, stall watchdog, power throttling re-check);
// the ops thread (device lifecycle: list / open / phones / close with role,
// name + nameIndex, default following, modes, period policy and raw
// streams, rate changes that re-prepare every module, routing of master and
// cue, fallback replies, device events, loss -> NULL pacer -> restore of the
// configured endpoint, stall restarts, recordings and their events,
// shutdown); the vst-ops thread (plugins, base64 states, owner window);
// offline / manual mode. SPEC.md §3, §6, §8, §13, §14.
#include "om/engine.h"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <cstring>
#include <deque>
#include <mutex>
#include <semaphore>
#include <thread>
#include <vector>

#include "backends.h"
#include "om/color_fx.h"
#include "om/convolver.h"
#include "om/deck.h"
#include "om/fx.h"
#include "om/json.h"
#include "om/mixer.h"
#include "om/protocol.h"
#include "om/rt.h"
#include "om/spsc_queue.h"
#include "om/sync.h"
#include "om/triple_buffer.h"

namespace om {

namespace {
constexpr int kPendingMax = 64;        // scheduled ("when") commands waiting on the audio thread
constexpr int kRetireBacklog = 256;    // retired objects waiting for room in retQ
constexpr int kCommandsPerCallback = 512;
constexpr uint32_t kFxReverbSeed = 0x0F00D5EDu;
constexpr uint32_t kColorReverbSeed = 0x0C0102EDu;
constexpr int kCbNone = 0, kCbNull = 1, kCbSystem = 2;  // which device may render (Impl::activeCb)

FxUnitId unitOfSlot(int slot) noexcept {
  if (slot < kNumFxUnits) return panelUnit(slot);
  if (slot < kNumFxUnits + kNumDecks) return padUnit(slot - kNumFxUnits);
  return masterUnit();
}

double secondsSince(std::chrono::steady_clock::time_point t0) {
  return std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
}

// Paces an offline NULL device in real time (one block per period) when the
// device has no real-time mode of its own. Portable: a plain thread and a
// steady clock; on Windows the default timer resolution makes it render in
// short bursts, which is fine for a silent stand-in (block counts and the
// sample clock stay exact over time). Falls back to the present after a long
// hiccup instead of bursting to catch up.
class NullPacer {
 public:
  NullPacer(NullDevice* dev, double rate, int blockFrames) : dev_(dev) {
    period_ = std::chrono::duration<double>(blockFrames / rate);
    thread_ = std::thread([this] { loop(); });
  }
  ~NullPacer() {
    {
      std::lock_guard<std::mutex> lk(m_);
      run_ = false;
    }
    cv_.notify_all();
    if (thread_.joinable()) thread_.join();
  }
  NullPacer(const NullPacer&) = delete;
  NullPacer& operator=(const NullPacer&) = delete;

 private:
  void loop() {
    using clock = std::chrono::steady_clock;
    const auto step = std::chrono::duration_cast<clock::duration>(period_);
    auto next = clock::now();
    for (;;) {
      {
        std::unique_lock<std::mutex> lk(m_);
        if (!run_) return;
      }
      dev_->pump(1, nullptr);
      next += step;
      const auto nowt = clock::now();
      if (nowt - next > std::chrono::milliseconds(200)) next = nowt;  // long hiccup: resynchronize
      std::unique_lock<std::mutex> lk(m_);
      cv_.wait_until(lk, next, [this] { return !run_; });
    }
  }
  NullDevice* dev_;
  std::chrono::duration<double> period_{};
  std::mutex m_;
  std::condition_variable cv_;
  bool run_ = true;
  std::thread thread_;
};
}  // namespace

struct Engine::Impl {
  EngineOptions opt;

  // ---- modules ----
  std::unique_ptr<Deck> decks[kNumDecks];
  Mixer mixer;
  SyncEngine sync;
  PcmStore pcm;
  std::unique_ptr<IVstHost> vst;
  std::unique_ptr<IRecorder> recorder;
  std::unique_ptr<IPhonesOutput> phones;
  // FX units: panel units created at start, pad / master units on first use
  // (control thread). The core owns them; the mixer holds raw pointers.
  std::unique_ptr<FxUnit> fxUnits[kNumFxSlots];
  std::atomic<FxUnit*> unitPtr[kNumFxSlots];
  std::unique_ptr<ColorFx> colorFx;
  std::shared_ptr<const ConvolverKernel> fxReverbKernel, colorReverbKernel;
  // Module preparation (start, device rate changes on the ops thread) vs FX
  // allocation (control thread). Chains carry the generation they were made
  // for: the audio thread refuses a chain made before a re-preparation.
  std::mutex prepM;
  std::atomic<uint32_t> prepGen{1};
  uint32_t audioGen = 1;  // audio thread's view; written only while no device renders
  std::atomic<double> sampleRate{48000};
  std::atomic<int> channels{4};
  bool prepared = false;

  // ---- queues ----
  SpscQueue<RtCommand> cmdQ{4096};
  SpscQueue<RtEvent> evQ{4096};
  SpscQueue<Retired> retQ{4096};
  std::mutex producerM;  // serializes the producers of cmdQ (caller thread, control, ops, vst-ops)
  std::mutex deferredM;  // attach / routing commands that found the queue full (kept in order)
  std::vector<RtCommand> deferredPushes;
  TripleBuffer<om_state> state;
  std::mutex stateM;     // serializes the readers of `state`
  om_state lastState{};

  // ---- policy (trusted, from main) ----
  std::mutex policyM;
  EnginePolicy policy;

  // ---- control side ----
  std::mutex controlM;   // control-side tables: grids, FX requests
  std::vector<double> lastBeats[kNumDecks];
  bool unitRequested[kNumFxSlots] = {};
  uint32_t chainRequested[kNumFxSlots] = {};
  uint32_t colorChainRequested = 0;
  struct ControlJob {
    enum Kind : uint8_t { MakeUnit, MakeChain, MakeColorChain } kind;
    int slot;
    uint8_t type;
  };
  std::deque<ControlJob> controlJobs;     // guarded by controlM
  std::mutex sinkM;
  EventSink sink;
  std::thread control;
  std::atomic<bool> runControl{false};
  std::atomic<bool> started{false};
  // Wakes the control thread: released by the audio thread when it pushed
  // events or retired objects (non-blocking), by the command intake for FX
  // allocations, by stop(). wakePending bounds the count.
  std::counting_semaphore<1 << 20> wake{0};
  std::atomic<bool> wakePending{false};
  // Engine time at which the next "state" is due (armed by the control
  // thread after each state): the audio thread wakes the control thread on
  // the first block at or after it (precise ~stateHz whatever the OS timer
  // resolution), +inf when disarmed.
  std::atomic<double> stateDueAt{1e300};
  // Maximum rate of "state": written by engine.config on the JS thread, read
  // by the control thread (opt.stateHz is only its start value).
  std::atomic<int> stateHz{60};
  EngineTime nextStateAt = 0, nextHbAt = 0, nextGcAt = 0, nextThrottleAt = 0, nextDiagAt = 0;
  uint64_t lastEmittedBlock = 0;  // block 0 = nothing published yet: no state before the first block
  uint64_t watchBlock = ~uint64_t(0);
  EngineTime watchSince = 0, stallAt = 0;
  int stallPhase = 0;  // 0 ok, 1 stall reported + restart requested, 2 "stalled" reported
  uint32_t lastEndedCount[kNumDecks] = {};
  uint64_t xrunEvents = 0;    // callback overruns seen by the control thread
  std::chrono::steady_clock::time_point lastIteration{};
  EngineTime lastVstLate[kNumDecks] = {-1e9, -1e9, -1e9, -1e9};
  uint32_t vstLateCount[kNumDecks] = {};

  // ---- ops and vst-ops threads (blocking jobs) ----
  struct Job {
    enum Kind : uint8_t { Command = 0, UnloadAllVst, VstReconfigure, OutputEvent, PhonesEvent, StallRestart, FinishRecording } kind = Command;
    ParsedCommand pc;
    DeviceEventInfo ev;
    uint64_t gen = 0;          // output / phones generation an event belongs to
    bool fromWatcher = false;  // process-wide endpoint notification (DeviceWatcher)
    double rate = 0;
  };
  std::mutex opsM, vstM;
  std::condition_variable opsCv, vstCv;
  std::deque<Job> opsQ, vstQ;
  std::thread opsThread, vstThread;
  std::atomic<bool> runJobs{false};

  // ---- output devices (owned by the ops thread; start() / stop() when it is not running) ----
  struct Callback final : IRenderCallback {
    Impl* impl = nullptr;
    int id = kCbNone;
    void render(float* out, int frames, int ch, const BlockClock& clk) noexcept override {
      impl->deviceRender(id, out, frames, ch, clk);
    }
  };
  Callback nullCb, sysCb;
  std::atomic<int> activeCb{kCbNone};       // the device allowed to render
  std::atomic<bool> inRender{false};        // a render is running (never two at once)
  std::unique_ptr<NullDevice> nullDev;      // current NULL device (offline in manual mode)
  std::unique_ptr<NullPacer> pacer;         // core pacer when the NULL device has no real-time mode
  bool nullPaced = false;                   // the NULL device renders in real time
  std::unique_ptr<AudioDevice> sysDev;      // open system output (or a test fake)
  // Endpoint notifications for the whole process (Added, StateChanged,
  // DefaultChanged, FormatChanged). Without a watcher, the lost output is
  // kept (stopped, closed) so that its own notifications report the
  // endpoint's return; the periodic re-check covers everything else.
  std::unique_ptr<DeviceWatcher> watcher;
  std::unique_ptr<AudioDevice> lostDev;
  std::string lostId;                       // endpoint that was open when the output was lost
  std::vector<std::string> presentAtLoss;   // endpoints present then: never "the device coming back"
  DeviceConfig configured;                  // what device.open asked for (kept while lost)
  bool haveConfigured = false;              // a system output is wanted
  bool lost = false;                        // ... and is gone: NULL pacer until it is back
  uint64_t outputGen = 0;                   // bumps at every system output (stale events are ignored)
  DeviceStatus sysStatus;                   // last status of the system output
  int lastPeriodSteps = 0;
  EngineTime nextOpsTickAt = 0, nextLossRetryAt = 0;
  // headphones card
  DeviceConfig phonesCfg;
  bool phonesSet = false;                   // a headphones card is configured
  bool phonesLost = false;
  uint64_t phonesGen = 0;
  // Cached status for device.status (inline: never touches a device).
  std::mutex statusM;
  json::Value statusCache;
  // Device fields of the snapshot (written by the ops thread, read by the audio thread).
  std::atomic<int> devMode{static_cast<int>(DeviceMode::Closed)};
  std::atomic<int> devPeriod{0};
  std::atomic<bool> devLost{false}, devFellBack{false}, devPhones{false}, devCueRouted{false};
  std::atomic<uint32_t> devPeriodSteps{0};
  std::atomic<float> devJitterMs{0.0f};
  std::atomic<uint64_t> devGlitches{0};
  std::atomic<bool> audioExpected{false};   // a started device should be producing blocks (stall watchdog)
  std::atomic<double> manualNow{0.0};       // engine clock in manual mode (= sample clock)

  // ---- counters written by non-audio threads, copied into the snapshot ----
  std::atomic<uint32_t> batchesRejected{0};
  std::atomic<uint32_t> stalls{0};
  std::atomic<bool> throttlingOff{false};

  // ---- stats (any thread, relaxed) ----
  std::atomic<uint64_t> stFxUnits{0}, stFxChains{0}, stColorChains{0}, stUnitsAttached{0}, stChainsAttached{0},
      stChainsDropped{0}, stPrepares{0}, stOutputOpens{0}, stStallRestarts{0}, stUnhandled{0}, stIterations{0},
      stBlocks{0};
  std::atomic<double> stMaxGapMs{0.0};
  std::atomic<int> stRouting[4] = {{0}, {1}, {-1}, {-1}};

  // ---- audio thread only ----
  uint32_t ack = 0;
  uint32_t epochAudio = 1;
  uint64_t block = 0;
  SampleTime sampleClock = 0;
  std::vector<float> deckBuf;  // kNumDecks * 2 * kMaxBlockFrames
  RtCommand pending[kPendingMax];
  int pendingCount = 0;
  Retired backlog[kRetireBacklog];
  int backlogCount = 0;
  uint32_t eventsLost = 0, retiredLost = 0, pendingFull = 0;
  std::atomic<float> maxLoad{0.0f};  // reset by the state emitter
  uint64_t overruns = 0;
  int insertLatency[kNumDecks] = {};
  bool pushedThisBlock = false;

  explicit Impl(const EngineOptions& o) : opt(o), pcm(o.maxPcmBytes) {
    (void)EngineClock::now();  // starts the engine clock on a non-real-time thread
    stateHz.store(o.stateHz, std::memory_order_relaxed);
    for (auto& p : unitPtr) p.store(nullptr);
    for (int d = 0; d < kNumDecks; d++) decks[d] = std::make_unique<Deck>(d);
    IDeckControl* ctl[kNumDecks];
    for (int d = 0; d < kNumDecks; d++) ctl[d] = decks[d].get();
    sync.attachDecks(ctl);
    lastState.struct_size = sizeof(om_state);
    for (int u = 0; u < kNumFxUnits; u++) unitRequested[u] = true;
    nullCb.impl = this;
    nullCb.id = kCbNull;
    sysCb.impl = this;
    sysCb.id = kCbSystem;
    vst = opt.backends.createVstHost ? opt.backends.createVstHost() : core::makeDefaultVstHost();
    recorder = opt.backends.createRecorder ? opt.backends.createRecorder() : core::makeDefaultRecorder();
    phones = opt.backends.createPhones ? opt.backends.createPhones() : core::makeDefaultPhones();
    statusCache = json::Value::object();
  }

  ~Impl() {
    // Objects still travelling to the audio thread are owned by their commands.
    for (const RtCommand& c : deferredPushes) disposeUndelivered(c);
    RtCommand c;
    while (cmdQ.pop(c)) disposeUndelivered(c);
    for (int i = 0; i < pendingCount; i++) disposeUndelivered(pending[i]);
    pendingCount = 0;
    drainRetired();
    for (int i = 0; i < backlogCount; i++) releaseRetired(backlog[i]);
    backlogCount = 0;
  }

  // ------------------------------------------------------------------------
  // Events
  // ------------------------------------------------------------------------
  void emit(const std::string& json) {
    std::lock_guard<std::mutex> lk(sinkM);
    if (sink) sink(json);
  }
  void reply(const ParsedCommand& pc, bool ok, const json::Value& fields = json::Value(), std::string_view err = {}) {
    if (pc.id >= 0 && pc.spec->replies) emit(replyJson(pc.id, ok, fields, err));
  }
  void replyCode(const ParsedCommand& pc, std::string_view err, const char* code) {
    json::Value f = json::Value::object();
    f.set("code", json::Value::string(code));
    reply(pc, false, f, err);
  }
  void wakeControl() noexcept {
    if (!wakePending.exchange(true, std::memory_order_acq_rel)) wake.release();
  }

  // ------------------------------------------------------------------------
  // Setup
  // ------------------------------------------------------------------------
  // Allocates every module for `rate`. Called with no device rendering:
  // from start() (no thread yet) or from the ops thread between the stop of
  // one device and the start of the next, with prepM held.
  void prepareModules(double rate) {
    sampleRate.store(rate);
    for (auto& d : decks) d->prepare(rate, kMaxBlockFrames);
    mixer.prepare(rate, kMaxBlockFrames);
    mixer.setInsert(vst.get());
    deckBuf.assign(static_cast<size_t>(kNumDecks) * 2 * kMaxBlockFrames, 0.0f);
    const int irate = static_cast<int>(rate);
    fxReverbKernel = ConvolverKernel::build(makeImpulse(2.2, 2.5, irate, kFxReverbSeed), kMaxBlockFrames);
    colorReverbKernel = ConvolverKernel::build(makeImpulse(2.8, 2.2, irate, kColorReverbSeed), kMaxBlockFrames);
    for (int u = 0; u < kNumFxSlots; u++) {
      if (u < kNumFxUnits && !fxUnits[u]) {
        fxUnits[u] = std::make_unique<FxUnit>();
        stFxUnits++;
      }
      if (!fxUnits[u]) continue;
      fxUnits[u]->prepare(rate, kMaxBlockFrames, fxReverbKernel);
      unitPtr[u].store(fxUnits[u].get(), std::memory_order_release);
      mixer.attachFx(unitOfSlot(u), fxUnits[u].get());  // no device renders now
    }
    if (!colorFx) colorFx = std::make_unique<ColorFx>();
    colorFx->prepare(rate, kMaxBlockFrames, colorReverbKernel);
    mixer.attachColor(colorFx.get());
    prepared = true;
    stPrepares++;
  }

  // A device at another rate: re-prepares every module (no device renders),
  // invalidates the chains still travelling, re-requests the chains that
  // were wanted but not attached, continues a recording in a new file and
  // reconfigures the plugins. Ops thread.
  void reprepare(double rate) {
    {
      std::lock_guard<std::mutex> lk(prepM);
      prepareModules(rate);
      const uint32_t g = prepGen.load() + 1;
      prepGen.store(g);
      audioGen = g;
      std::lock_guard<std::mutex> lc(controlM);
      for (int s = 0; s < kNumFxSlots; s++) {
        FxUnit* u = fxUnits[s].get();
        if (!u) continue;
        for (int t = 0; t < kNumFxTypes; t++) {
          if (!(chainRequested[s] & (1u << t)) || u->hasChain(static_cast<FxType>(t))) continue;
          controlJobs.push_back({ControlJob::MakeChain, s, static_cast<uint8_t>(t)});
        }
      }
      if (colorFx) {
        for (int t = 0; t < kNumColorTypes; t++) {
          if (!(colorChainRequested & (1u << t)) || colorFx->hasChain(static_cast<ColorType>(t))) continue;
          controlJobs.push_back({ControlJob::MakeColorChain, 0, static_cast<uint8_t>(t)});
        }
      }
    }
    wakeControl();
    if (recorder->active()) {
      std::string err;
      const bool ok = recorder->continueAtRate(static_cast<int>(rate), &err);
      emitRecStatus(ok ? std::string() : (err.empty() ? std::string("recording could not continue") : err));
    }
    Job j;
    j.kind = Job::VstReconfigure;
    j.rate = rate;
    queueJob(vstM, vstQ, vstCv, std::move(j));
  }

  // ------------------------------------------------------------------------
  // Pushes from non-JS threads (control, ops, vst-ops): in order, deferred
  // when the queue is full (the control thread retries).
  // ------------------------------------------------------------------------
  void pushInternal(const RtCommand& c) {
    std::lock_guard<std::mutex> lk(producerM);
    {
      std::lock_guard<std::mutex> ld(deferredM);
      if (!deferredPushes.empty()) {
        deferredPushes.push_back(c);
        return;
      }
    }
    if (!cmdQ.push(c)) {
      std::lock_guard<std::mutex> ld(deferredM);
      deferredPushes.push_back(c);
    }
  }

  void retryDeferred() {
    std::lock_guard<std::mutex> lk(producerM);
    std::lock_guard<std::mutex> ld(deferredM);
    if (deferredPushes.empty()) return;
    size_t i = 0;
    while (i < deferredPushes.size() && cmdQ.push(deferredPushes[i])) i++;
    deferredPushes.erase(deferredPushes.begin(), deferredPushes.begin() + static_cast<std::ptrdiff_t>(i));
  }

  bool deferredEmpty() {
    std::lock_guard<std::mutex> ld(deferredM);
    return deferredPushes.empty();
  }

  void disposeUndelivered(const RtCommand& c) {
    switch (c.type) {
      case Cmd::AttachFxChain:
      case Cmd::AttachColorChain: FxChainDeleter()(static_cast<FxChain*>(const_cast<void*>(c.u.attach.ptr))); break;
      case Cmd::AttachGrid: delete static_cast<const BeatGrid*>(c.u.attach.ptr); break;
      case Cmd::AttachStems:
        if (const auto* set = static_cast<const StemSet*>(c.u.attach.ptr)) {
          for (const TrackBuffer* tb : set->stems)
            if (tb) pcm.release(tb);
          delete set;
        }
        break;
      case Cmd::AttachTrack:
      case Cmd::AttachSample:
        if (c.u.attach.ptr) pcm.release(static_cast<const TrackBuffer*>(c.u.attach.ptr));
        break;
      default: break;
    }
  }

  void pushRouting(const core::Routing& r) {
    RtCommand c;
    c.type = Cmd::SetRouting;
    c.u.routing.masterL = static_cast<int8_t>(r.masterL);
    c.u.routing.masterR = static_cast<int8_t>(r.masterR);
    c.u.routing.cueL = static_cast<int8_t>(r.cueL);
    c.u.routing.cueR = static_cast<int8_t>(r.cueR);
    pushInternal(c);
    devCueRouted.store(r.cueL >= 0 || (phonesSet && phones->active()));
  }
  void applyRouting() { pushRouting(core::outputRouting(channels.load(), phonesSet)); }

  // ------------------------------------------------------------------------
  // Command intake (caller thread; producerM held for the whole message)
  // ------------------------------------------------------------------------
  // Room was reserved for the whole message before running any of it.
  bool pushLocked(const RtCommand& c) { return cmdQ.push(c); }

  static BeatGrid* buildGrid(const json::Value& g, bool loadRule, const std::vector<double>* keepBeats) {
    auto* grid = new BeatGrid();
    grid->bpm = g["bpm"].asNumber(0.0);
    if (!(grid->bpm > 0) || !std::isfinite(grid->bpm)) grid->bpm = 0.0;
    grid->beatOffset = g["beatOffset"].isNumber() ? g["beatOffset"].asNumber(kNaN) : kNaN;
    grid->gridShift = g["gridShift"].asNumber(0.0);
    if (!std::isfinite(grid->gridShift)) grid->gridShift = 0.0;
    grid->barAnchor = static_cast<int>(g["barAnchor"].asNumber(0.0));
    const json::Value& b = g["beats"];
    if (b.isArray()) {
      grid->beats.reserve(b.size());
      for (size_t i = 0; i < b.size(); i++) grid->beats.push_back(b.at(i).asNumber(0.0));
      // engine.js loadTrack: a beat list needs more than 2 entries to be used
      if (loadRule && grid->beats.size() <= 2) grid->beats.clear();
    } else if (!g.has("beats") && keepBeats) {
      grid->beats = *keepBeats;  // "beats" omitted in deck.grid = unchanged
    }
    return grid;
  }

  // FX memory requests (SPEC.md §11.5): the first selection of a lazy chain,
  // a pad unit or the master unit queues its creation to the control thread.
  void requestFxMemory(const RtCommand& c) {
    bool queued = false;
    {
      std::lock_guard<std::mutex> lk(controlM);
      auto ensureUnit = [&](int slot) {
        if (unitRequested[slot]) return;
        unitRequested[slot] = true;
        controlJobs.push_back({ControlJob::MakeUnit, slot, 0});
        queued = true;
      };
      auto ensureChain = [&](int slot, FxType t) {
        if (!FxUnit::isLazy(t)) return;
        const uint32_t bit = 1u << static_cast<int>(t);
        if (chainRequested[slot] & bit) return;
        chainRequested[slot] |= bit;
        controlJobs.push_back({ControlJob::MakeChain, slot, static_cast<uint8_t>(t)});
        queued = true;
      };
      switch (c.type) {
        case Cmd::FxSet: {
          const int slot = fxSlotIndex(c.u.fx.unit);
          ensureUnit(slot);
          if (c.u.fx.mask & kFxType) ensureChain(slot, static_cast<FxType>(c.u.fx.type));
          break;
        }
        case Cmd::FxPad:
          if (c.u.fxPad.on && c.deck >= 0) {
            const int slot = fxSlotIndex(padUnit(c.deck));
            ensureUnit(slot);
            ensureChain(slot, static_cast<FxType>(c.u.fxPad.type));
          }
          break;
        case Cmd::ColorTypeSet: {
          const auto t = static_cast<ColorType>(c.u.color.type);
          const uint32_t bit = 1u << c.u.color.type;
          if (ColorFx::isLazy(t) && !(colorChainRequested & bit)) {
            colorChainRequested |= bit;
            controlJobs.push_back({ControlJob::MakeColorChain, 0, c.u.color.type});
            queued = true;
          }
          break;
        }
        default:
          return;
      }
    }
    if (queued) wakeControl();
  }

  json::Value recStatusJson(const RecStatus& st) {
    json::Value f = json::Value::object();
    f.set("active", json::Value::boolean(st.active));
    f.set("path", json::Value::string(st.path));
    f.set("part", json::Value::number(st.part));
    f.set("seconds", json::Value::number(st.seconds));
    f.set("bytes", json::Value::number(static_cast<double>(st.bytes)));
    f.set("dropped", json::Value::number(static_cast<double>(st.droppedFrames)));
    if (!st.error.empty()) f.set("error", json::Value::string(st.error));
    return f;
  }
  void emitRecStatus(const std::string& error) {
    RecStatus st = recorder->status();
    if (!error.empty()) st.error = error;
    emit(eventJson("rec.status", recStatusJson(st)));
  }

  void handleInline(const ParsedCommand& pc) {
    const json::Value& b = pc.body;
    const int d = pc.rt.deck;
    switch (pc.spec->cmd) {
      case Cmd::Hello: {
        uint32_t ep = pcm.epoch();
        if (b["reset"].asBool(false)) {
          // Renderer reload: new PCM epoch, everything back to engine.js
          // defaults, ack back to 0, plugins unloaded (SPEC.md §15.3).
          ep = pcm.newEpoch();
          RtCommand c;
          c.type = Cmd::EngineReset;
          c.u.reset.epoch = ep;
          pushLocked(c);
          {
            std::lock_guard<std::mutex> lk(controlM);
            for (auto& v : lastBeats) v.clear();
          }
          Job j;
          j.kind = Job::UnloadAllVst;
          queueJob(vstM, vstQ, vstCv, std::move(j));
          // A recording left running by the previous page is finalized on the
          // ops thread (which owns the recorder), before any command of the
          // new page reaches it; the JS proxy also checks at connect.
          Job rj;
          rj.kind = Job::FinishRecording;
          queueJob(opsM, opsQ, opsCv, std::move(rj));
        }
        json::Value f = json::Value::object();
        f.set("engine", json::Value::string(engineVersion()));
        f.set("protocol", json::Value::number(kProtocolVersion));
        f.set("sampleRate", json::Value::number(sampleRate.load()));
        f.set("channels", json::Value::number(channels.load()));
        f.set("chunkFrames", json::Value::number(static_cast<double>(TrackBuffer::kChunkFrames)));
        f.set("epoch", json::Value::number(ep));
        reply(pc, true, f);
        return;
      }
      case Cmd::EngineConfig:
        if (b["stateHz"].isNumber())
          stateHz.store(clampv(static_cast<int>(b["stateHz"].asNumber(60)), 1, 240), std::memory_order_relaxed);
        if (b["vstDeadline"].isNumber()) {
          RtCommand c;
          c.type = Cmd::SetVstDeadline;
          c.u.deadline.fraction = static_cast<float>(clampv(b["vstDeadline"].asNumber(0.35), 0.1, 0.6));
          pushLocked(c);
        }
        reply(pc, true);
        return;
      case Cmd::ClockPing: {
        json::Value f = json::Value::object();
        f.set("t0", b["t0"]);
        f.set("te", json::Value::number(now()));
        emit(eventJson("clock.pong", f));
        return;
      }
      case Cmd::DeviceStatus: {
        json::Value f = json::Value::object();
        {
          std::lock_guard<std::mutex> lk(statusM);
          f.set("status", statusCache);  // cached by the ops thread: never touches a device here
        }
        reply(pc, true, f);
        return;
      }
      case Cmd::RecStatus:
        reply(pc, true, recStatusJson(recorder->status()));
        return;
      case Cmd::VstStatus: {
        const VstSlotStatus st = vst->status(d);
        json::Value f = json::Value::object();
        f.set("loaded", json::Value::boolean(st.loaded));
        f.set("active", json::Value::boolean(st.active));
        f.set("bypassed", json::Value::boolean(st.bypassed));
        f.set("crashed", json::Value::boolean(st.crashed));
        f.set("hung", json::Value::boolean(st.hung));
        f.set("editorOpen", json::Value::boolean(st.editorOpen));
        f.set("latency", json::Value::number(st.latency));
        f.set("latencyChanged", json::Value::boolean(st.latencyChanged));
        f.set("processed", json::Value::number(static_cast<double>(st.processed)));
        f.set("lateBlocks", json::Value::number(static_cast<double>(st.lateBlocks)));
        f.set("busySkips", json::Value::number(static_cast<double>(st.busySkips)));
        f.set("processErrors", json::Value::number(static_cast<double>(st.processErrors)));
        f.set("maxProcessMs", json::Value::number(st.maxProcessMs));
        f.set("avgProcessMs", json::Value::number(st.avgProcessMs));
        f.set("latencyRefused", json::Value::boolean(st.latencyRefused));
        f.set("busy", json::Value::boolean(st.busy));
        f.set("dialog", json::Value::boolean(st.dialog));
        f.set("pluginAllocs", json::Value::number(static_cast<double>(st.pluginAllocs)));
        f.set("mix", json::Value::number(st.mix));
        reply(pc, true, f);
        return;
      }
      case Cmd::PcmBegin: {
        PcmDesc desc;
        desc.loadId = static_cast<uint32_t>(b["loadId"].asNumber(0));
        const std::string& kind = b["kind"].asString();
        desc.kind = kind == "stem" ? PcmKind::Stem : (kind == "sample" ? PcmKind::Sample : PcmKind::Track);
        desc.format = b["format"].asString() == "f32" ? PcmFormat::F32 : PcmFormat::S16;
        desc.sourceChannels = static_cast<int>(b["sourceChannels"].asNumber(2));
        desc.sampleRate = static_cast<int>(b["sampleRate"].asNumber(0));
        desc.frames = static_cast<int64_t>(b["frames"].asNumber(-1));
        desc.headroom = static_cast<float>(b["headroom"].asNumber(0.0));
        desc.peak = static_cast<float>(b["peak"].asNumber(0.0));
        const PcmError e = pcm.begin(desc);
        reply(pc, e == PcmError::None, json::Value(), e == PcmError::None ? "" : pcmErrorName(e));
        return;
      }
      case Cmd::PcmAbort:
        pcm.abort(static_cast<uint32_t>(b["loadId"].asNumber(0)));
        return;
      case Cmd::DeckLoad: {
        const uint32_t loadId = static_cast<uint32_t>(b["loadId"].asNumber(0));
        std::shared_ptr<TrackBuffer> tb = pcm.acquire(loadId);
        if (!tb) {
          reply(pc, false, json::Value(), "unknown loadId");
          return;
        }
        BeatGrid* grid = buildGrid(b["grid"], true, nullptr);
        {
          std::lock_guard<std::mutex> lk(controlM);
          lastBeats[d] = grid->beats;
        }
        RtCommand c = pc.rt;
        c.type = Cmd::DeckResetForLoad;
        bool ok = pushLocked(c);
        c.type = Cmd::AttachStems;  // engine.js loadTrack: stems dropped
        c.u.attach.ptr = nullptr;
        ok = ok && pushLocked(c);
        c.type = Cmd::AttachTrack;
        c.u.attach.ptr = tb.get();
        const bool trackPushed = ok && pushLocked(c);
        c.type = Cmd::AttachGrid;
        c.u.attach.ptr = grid;
        const bool gridPushed = trackPushed && pushLocked(c);
        if (!trackPushed) pcm.release(tb.get());  // never happens after the reservation
        if (!gridPushed) delete grid;
        reply(pc, gridPushed);
        return;
      }
      case Cmd::DeckUnload: {
        RtCommand c = pc.rt;
        c.type = Cmd::DeckResetForLoad;
        pushLocked(c);
        for (Cmd t : {Cmd::AttachStems, Cmd::AttachGrid, Cmd::AttachTrack}) {
          c.type = t;
          c.u.attach.ptr = nullptr;
          pushLocked(c);
        }
        std::lock_guard<std::mutex> lk(controlM);
        lastBeats[d].clear();
        return;
      }
      case Cmd::DeckStems: {
        auto* set = new StemSet();
        const char* names[kNumStems] = {"vocals", "drums", "bass", "other"};
        bool ok = true;
        for (int s = 0; s < kNumStems && ok; s++) {
          if (!b[names[s]].isNumber()) continue;
          std::shared_ptr<TrackBuffer> tb = pcm.acquire(static_cast<uint32_t>(b[names[s]].asNumber(0)));
          if (!tb) {
            ok = false;
            break;
          }
          set->stems[s] = tb.get();
          set->keep[s] = tb;
        }
        RtCommand c = pc.rt;
        c.type = Cmd::AttachStems;
        c.u.attach.ptr = set;
        if (!ok || !pushLocked(c)) {
          for (const TrackBuffer* t : set->stems)
            if (t) pcm.release(t);  // give the acquired users back
          delete set;
          reply(pc, false, json::Value(), ok ? "queue full" : "unknown loadId");
          return;
        }
        reply(pc, true);
        return;
      }
      case Cmd::DeckGrid: {
        BeatGrid* grid;
        {
          std::lock_guard<std::mutex> lk(controlM);
          grid = buildGrid(b, false, &lastBeats[d]);
          lastBeats[d] = grid->beats;
        }
        RtCommand c = pc.rt;
        c.type = Cmd::AttachGrid;
        c.u.attach.ptr = grid;
        if (!pushLocked(c)) delete grid;
        return;
      }
      case Cmd::SamplerLoad:
      case Cmd::SamplerClear: {
        const int slot = static_cast<int>(b["slot"].asNumber(-1));
        if (slot < 0 || slot >= kMaxSamplerSlots) {
          reply(pc, false, json::Value(), "slot out of range");
          return;
        }
        std::shared_ptr<TrackBuffer> tb;
        if (pc.spec->cmd == Cmd::SamplerLoad) {
          tb = pcm.acquire(static_cast<uint32_t>(b["loadId"].asNumber(0)));
          if (!tb) {
            reply(pc, false, json::Value(), "unknown loadId");
            return;
          }
        }
        RtCommand c = pc.rt;
        c.type = Cmd::AttachSample;
        c.u.attach.ptr = tb.get();
        c.u.attach.slot = slot;
        if (!pushLocked(c)) {
          if (tb) pcm.release(tb.get());
          reply(pc, false, json::Value(), "queue full");
          return;
        }
        reply(pc, true);
        return;
      }
      default:
        reply(pc, false, json::Value(), "not an inline command");
        return;
    }
  }

  // ------------------------------------------------------------------------
  // Output devices (ops thread; start() / stop() while it does not run)
  // ------------------------------------------------------------------------
  void stopNull() {
    if (activeCb.load() == kCbNull) {
      audioExpected.store(false);
      activeCb.store(kCbNone);
    }
    pacer.reset();  // joins the core pacer (no render after this)
    if (nullDev) {
      nullDev->stop();
      nullDev->close();
    }
    nullPaced = false;
  }

  void stopSys() {
    if (activeCb.load() == kCbSystem) {
      audioExpected.store(false);
      activeCb.store(kCbNone);
    }
    if (sysDev) {
      sysDev->stop();   // contract: no render() call after stop() returns
      sysDev->close();
      sysDev.reset();   // released on the ops thread (COM objects live in its apartment)
    }
  }

  // The NULL device at `rate`: the silent output before any device.open,
  // after device.close and while the configured device is lost (the
  // transport, the sample clock and a recording keep running).
  bool startNull(double rate, int ch, int blockFrames, int latency, std::string* err) {
    stopNull();
    NullDeviceConfig nc;
    nc.sampleRate = static_cast<int>(rate);
    nc.channels = std::max(1, ch);
    nc.blockFrames = clampv(blockFrames > 0 ? blockFrames : opt.nullConfig.blockFrames, 16, kMaxBlockFrames);
    nc.latencyFrames = std::max(0, latency);
    const bool wantPaced = !opt.manual && (!opt.nullDevice || opt.nullConfig.realtime);
    nc.realtime = wantPaced;
    activeCb.store(kCbNull);
    nullDev = std::make_unique<NullDevice>(nc);
    std::string e;
    bool ok = nullDev->open(DeviceConfig(), &nullCb, &e) && nullDev->start(&e);
    if (!ok && wantPaced) {
      // The device module's own real-time pacer is not available: offline
      // NULL device paced by the core.
      nc.realtime = false;
      nullDev = std::make_unique<NullDevice>(nc);
      e.clear();
      ok = nullDev->open(DeviceConfig(), &nullCb, &e) && nullDev->start(&e);
      if (ok) pacer = std::make_unique<NullPacer>(nullDev.get(), rate, nc.blockFrames);
    }
    if (!ok) {
      activeCb.store(kCbNone);
      if (err) *err = e.empty() ? "NULL device failed" : e;
      return false;
    }
    nullPaced = wantPaced;
    channels.store(nc.channels);
    devMode.store(static_cast<int>(DeviceMode::Null));
    devPeriod.store(nc.blockFrames);
    audioExpected.store(wantPaced);
    return true;
  }

  std::vector<DeviceInfo> enumerate(std::string* err) {
    if (opt.backends.enumerateOutputs) return opt.backends.enumerateOutputs(err);
    if (opt.nullDevice) {
      if (err) *err = "the engine runs on the NULL device (no sound card)";
      return {};
    }
    return enumerateOutputDevices(err);
  }

  std::unique_ptr<AudioDevice> createOutput() {
    if (opt.backends.createOutput) return opt.backends.createOutput();
    if (opt.nullDevice) return nullptr;
    return createSystemDevice();
  }

  void postOpsJob(Job j) { queueJob(opsM, opsQ, opsCv, std::move(j)); }

  // Creates, opens and starts the system output on endpoint `cfg.id`. The
  // caller has stopped whatever rendered before (no device renders now), so
  // a rate change can re-prepare the modules here. Fills *stOut.
  bool startSystemOutput(const DeviceConfig& cfg, std::string* err, DeviceStatus* stOut) {
    std::unique_ptr<AudioDevice> dev = createOutput();
    if (!dev) {
      if (err) *err = opt.nullDevice ? "the engine runs on the NULL device (no sound card)" : "no audio backend in this build";
      return false;
    }
    const uint64_t gen = ++outputGen;
    dev->setEventHandler([this, gen](const DeviceEventInfo& ev) {
      Job j;
      j.kind = Job::OutputEvent;
      j.ev = ev;
      j.gen = gen;
      postOpsJob(std::move(j));
    });
    std::string e;
    if (!dev->open(cfg, &sysCb, &e)) {
      if (err) *err = e.empty() ? "device open failed" : e;
      return false;
    }
    DeviceStatus st = dev->status();
    const double prevRate = sampleRate.load();
    const double rate = st.sampleRate > 0 ? st.sampleRate : prevRate;
    if (rate != prevRate) reprepare(rate);  // no device renders now
    channels.store(st.channels > 0 ? st.channels : 2);
    devPeriod.store(st.periodFrames);
    if (phonesSet && rate != prevRate) reopenPhones();
    applyRouting();
    activeCb.store(kCbSystem);
    if (!dev->start(&e)) {
      activeCb.store(kCbNone);
      dev->close();
      if (err) *err = e.empty() ? "device start failed" : e;
      return false;
    }
    st = dev->status();
    sysDev = std::move(dev);
    lostDev.reset();
    sysStatus = st;
    lastPeriodSteps = st.periodSteps;
    devMode.store(static_cast<int>(st.mode));
    devPeriod.store(st.periodFrames);
    devFellBack.store(st.fellBack);
    devPeriodSteps.store(static_cast<uint32_t>(st.periodSteps));
    devGlitches.store(st.glitches);
    audioExpected.store(true);
    stOutputOpens++;
    if (stOut) *stOut = st;
    return true;
  }

  // Opens `want` as the master output (device.open: id > exact name +
  // nameIndex > case-insensitive name > prefix > the role's default). The
  // previous output stops first (an exclusive stream needs the endpoint
  // free); on failure the previous configuration is reopened when there was
  // one, else the NULL device runs at the current rate.
  bool openOutput(const DeviceConfig& want, std::string* err, DeviceStatus* stOut) {
    std::string e;
    const std::vector<DeviceInfo> list = enumerate(&e);
    DeviceConfig cfg = want;
    cfg.id = resolveOutputDevice(want, list);
    if (cfg.id.empty()) {
      if (err) *err = e.empty() ? "no output device matches" : e;
      return false;
    }
    const bool hadSys = sysDev != nullptr;
    const int prevCh = channels.load();
    stopSys();
    stopNull();
    if (startSystemOutput(cfg, err, stOut)) return true;
    if (!(hadSys && haveConfigured && openConfigured(nullptr))) {
      std::string e2;
      startNull(sampleRate.load(), prevCh, opt.nullConfig.blockFrames, opt.nullConfig.latencyFrames, &e2);
      applyRouting();
    }
    return false;
  }

  // The endpoint to reopen for the configuration: `preferId` (the endpoint
  // that is or was open) when present; else the configured endpoint
  // (matchConfiguredEndpoint: never the role's default unless the
  // configuration follows it), excluding the endpoints in `exclude` (those
  // already present when the output was lost: a twin controller still
  // plugged in is not "the device coming back").
  std::string pickConfigured(const std::vector<DeviceInfo>& list, const std::string& preferId,
                             const std::vector<std::string>* exclude) {
    if (!configured.followDefault && !preferId.empty()) {
      for (const auto& d : list)
        if (d.active && d.id == preferId) return d.id;
    }
    std::vector<DeviceInfo> candidates;
    for (const auto& d : list) {
      if (exclude && std::find(exclude->begin(), exclude->end(), d.id) != exclude->end()) continue;
      candidates.push_back(d);
    }
    return core::matchConfiguredEndpoint(configured, candidates);
  }

  // Reopens the CONFIGURED endpoint (restore after a loss, stall restart,
  // format change, default change): never another endpoint, except the
  // role's new default when the configuration follows the default. The
  // current output is stopped first.
  bool openConfigured(std::string* err, const std::string& preferId = std::string(),
                      const std::vector<std::string>* exclude = nullptr) {
    std::string e;
    const std::vector<DeviceInfo> list = enumerate(&e);
    DeviceConfig cfg = configured;
    cfg.id = pickConfigured(list, preferId, exclude);
    if (cfg.id.empty()) {
      if (err) *err = "the configured device is not present";
      return false;
    }
    stopSys();
    stopNull();
    return startSystemOutput(cfg, err, nullptr);
  }

  json::Value statusJson() {
    DeviceStatus st;
    if (sysDev) {
      st = sysStatus;
    } else {
      st.mode = nullDev && activeCb.load() == kCbNull ? DeviceMode::Null : DeviceMode::Closed;
      st.name = "NULL";
      st.sampleRate = static_cast<int>(sampleRate.load());
      st.channels = channels.load();
      st.periodFrames = devPeriod.load();
      st.running = audioExpected.load();
      st.sampleFormat = "f32";
    }
    st.lost = lost;
    json::Value f = core::deviceStatusJson(st);
    f.set("cueRouted", json::Value::boolean(devCueRouted.load()));
    json::Value ph = json::Value::object();
    ph.set("set", json::Value::boolean(phonesSet));
    ph.set("active", json::Value::boolean(phonesSet && phones->active()));
    ph.set("lost", json::Value::boolean(phonesLost));
    if (phonesSet) {
      const DeviceStatus ps = phones->status();
      ph.set("name", json::Value::string(ps.name.empty() ? phonesCfg.name : ps.name));
      ph.set("sampleRate", json::Value::number(ps.sampleRate));
      ph.set("channels", json::Value::number(ps.channels));
    }
    f.set("phones", std::move(ph));
    if (haveConfigured) {
      json::Value c = json::Value::object();
      c.set("name", json::Value::string(configured.name));
      c.set("nameIndex", json::Value::number(configured.nameIndex));
      c.set("followDefault", json::Value::boolean(configured.followDefault));
      c.set("role", json::Value::string(configured.role == DeviceRole::Communications ? "communications" : "console"));
      c.set("mode", json::Value::string(outputModeName(configured.mode)));
      f.set("configured", std::move(c));
    }
    return f;
  }

  void refreshStatusCache() {
    json::Value v = statusJson();
    std::lock_guard<std::mutex> lk(statusM);
    statusCache = std::move(v);
  }

  void emitDevice(const char* reason, const char* target = nullptr) {
    refreshStatusCache();
    json::Value f = json::Value::object();
    f.set("reason", json::Value::string(reason));
    if (target) f.set("target", json::Value::string(target));
    {
      std::lock_guard<std::mutex> lk(statusM);
      f.set("status", statusCache);
    }
    emit(eventJson("device", f));
  }

  // The configured output is gone: silent NULL pacer at the same rate, so
  // nothing jumps; restored when it comes back (SPEC.md §8.4).
  void onOutputLost() {
    const double rate = sampleRate.load();
    const int ch = channels.load();
    const int period = sysStatus.periodFrames > 0 ? sysStatus.periodFrames : opt.nullConfig.blockFrames;
    const int latency = static_cast<int>(std::lround(sysStatus.outputLatencyMs * rate / 1000.0));
    lostId = sysStatus.id;
    {
      std::string e;
      presentAtLoss.clear();
      for (const auto& d : enumerate(&e))
        if (d.id != lostId) presentAtLoss.push_back(d.id);
    }
    if (activeCb.load() == kCbSystem) {
      audioExpected.store(false);
      activeCb.store(kCbNone);
    }
    if (sysDev) {
      sysDev->stop();
      sysDev->close();
      if (watcher) sysDev.reset();
      else lostDev = std::move(sysDev);  // kept for its notifications
    }
    lost = true;
    devLost.store(true);
    std::string e;
    startNull(rate, ch, std::min(period, kMaxBlockFrames), latency, &e);
    applyRouting();
    nextLossRetryAt = now() + opt.lossRetryMs / 1000.0;
    emitDevice("lost");
  }

  // The NULL device again after a failed reopen (the transport keeps running).
  void nullAfterFailure(double rate, int ch) {
    std::string e;
    startNull(rate, ch > 0 ? ch : opt.nullConfig.channels, opt.nullConfig.blockFrames, opt.nullConfig.latencyFrames, &e);
    applyRouting();
  }

  void tryRestore() {
    if (!lost || !haveConfigured) return;
    std::string e;
    const std::vector<DeviceInfo> list = enumerate(&e);
    if (pickConfigured(list, lostId, &presentAtLoss).empty()) return;
    const double rate = sampleRate.load();
    const int ch = channels.load();
    if (openConfigured(&e, lostId, &presentAtLoss)) {
      lost = false;
      devLost.store(false);
      emitDevice("restored");
      return;
    }
    nullAfterFailure(rate, ch);
  }

  void reopenPhones() {
    if (!phonesSet) return;
    phones->close();
    std::string e;
    const std::vector<DeviceInfo> list = enumerate(&e);
    DeviceConfig cfg = phonesCfg;
    cfg.id = core::matchConfiguredEndpoint(phonesCfg, list);
    if (cfg.id.empty() || !phones->open(cfg, static_cast<int>(sampleRate.load()), devPeriod.load(), &e)) {
      phonesLost = true;
      devPhones.store(false);
      return;
    }
    phonesLost = false;
    devPhones.store(true);
  }

  void reopenAfterFormatChange() {
    // The mix format changed (rate, channels): the same endpoint again.
    const double rate = sampleRate.load();
    const int ch = channels.load();
    std::string e;
    if (openConfigured(&e, sysStatus.id)) {
      emitDevice("formatChanged");
      return;
    }
    nullAfterFailure(rate, ch);
    lost = true;
    devLost.store(true);
    nextLossRetryAt = now() + opt.lossRetryMs / 1000.0;
    emitDevice("lost");
  }

  void phonesLostNow() {
    phones->close();
    phonesLost = true;
    devPhones.store(false);
    applyRouting();
    emitDevice("lost", "phones");
  }

  void phonesTryRestore() {
    if (!phonesSet || !phonesLost) return;
    reopenPhones();
    if (!phonesLost) {
      applyRouting();
      emitDevice("restored", "phones");
    }
  }

  // Notifications of the output stream (Lost, PeriodStep: checked against the
  // output's generation) and of the endpoints (from the process-wide watcher,
  // or from the output itself when there is no watcher).
  void handleOutputEvent(const Job& j) {
    const DeviceEventInfo& ev = j.ev;
    const bool current = !j.fromWatcher && j.gen == outputGen;
    switch (ev.event) {
      case DeviceEvent::Lost:
        if (current && sysDev && !lost) onOutputLost();
        return;
      case DeviceEvent::PeriodStep:
        if (current && sysDev) {
          sysStatus = sysDev->status();
          devPeriod.store(sysStatus.periodFrames);
          devPeriodSteps.store(static_cast<uint32_t>(sysStatus.periodSteps));
          if (sysStatus.periodSteps > lastPeriodSteps) {
            lastPeriodSteps = sysStatus.periodSteps;
            emitDevice("periodStep");
          }
        }
        return;
      default:
        break;
    }
    // Endpoint notifications: from the watcher only when there is one (the
    // output reports the same ones: never handle them twice).
    if (watcher && !j.fromWatcher) return;
    switch (ev.event) {
      case DeviceEvent::FormatChanged:
        if (sysDev && !lost && (ev.id.empty() || ev.id == sysStatus.id)) reopenAfterFormatChange();
        return;
      case DeviceEvent::DefaultChanged:
        // Reopens only when the user chose "Default" (SPEC.md §8.4): the
        // engine never moves the master to another device by itself.
        if (haveConfigured && configured.followDefault && ev.role == configured.role) {
          const double rate = sampleRate.load();
          const int ch = channels.load();
          std::string e;
          if (openConfigured(&e)) {
            lost = false;
            devLost.store(false);
            emitDevice("defaultChanged");
          } else {
            if (!sysDev) nullAfterFailure(rate, ch);
            if (!lost) {
              lost = true;
              devLost.store(true);
              nextLossRetryAt = now() + opt.lossRetryMs / 1000.0;
              emitDevice("lost");
            }
          }
        }
        return;
      case DeviceEvent::Added:
      case DeviceEvent::StateChanged:
        if (ev.event == DeviceEvent::StateChanged && !(ev.state & kDeviceStateActive)) {
          // Removed, disabled or unplugged: the stream reports it too, but
          // not always at once (the endpoint can go before its stream).
          if (sysDev && !lost && !ev.id.empty() && ev.id == sysStatus.id) onOutputLost();
          if (phonesSet && !phonesLost && !ev.id.empty() && ev.id == phones->status().id) phonesLostNow();
          return;
        }
        tryRestore();
        phonesTryRestore();
        return;
      default:
        return;
    }
  }

  void handlePhonesEvent(const Job& j) {
    if (j.gen != phonesGen || !phonesSet) return;
    if (j.ev.event == DeviceEvent::Lost && !phonesLost) {
      phonesLostNow();
    } else if (!watcher && (j.ev.event == DeviceEvent::Added ||
                            (j.ev.event == DeviceEvent::StateChanged && (j.ev.state & kDeviceStateActive)))) {
      phonesTryRestore();
    }
  }

  // Stall watchdog: close and reopen the same output once (SPEC.md §3.5).
  void restartOutput() {
    stStallRestarts++;
    if (sysDev && haveConfigured) {
      std::string e;
      // Failure: no output at all, and the watchdog keeps counting so that
      // "stalled" follows (the proxy falls back to the Web engine).
      if (!openConfigured(&e, sysStatus.id)) audioExpected.store(true);
    } else if (nullDev) {
      std::string e;
      const NullDeviceConfig nc = nullDev->config();
      startNull(sampleRate.load(), nc.channels, nc.blockFrames, nc.latencyFrames, &e);
      applyRouting();
    }
    refreshStatusCache();
  }

  // Periodic ops work (every 250 ms, every pump in manual mode): device
  // status (period steps, glitches, jitter, a stream that died silently),
  // headphones, recorder errors, loss retries.
  void opsTick(bool force) {
    const EngineTime t = now();
    if (!force && t < nextOpsTickAt) return;
    nextOpsTickAt = t + 0.25;
    if (sysDev) {
      const DeviceStatus st = sysDev->status();
      sysStatus = st;
      devGlitches.store(st.glitches);
      devJitterMs.store(static_cast<float>(st.presentJitterMs));
      devPeriod.store(st.periodFrames);
      devPeriodSteps.store(static_cast<uint32_t>(st.periodSteps));
      devFellBack.store(st.fellBack);
      if (st.periodSteps > lastPeriodSteps) {
        lastPeriodSteps = st.periodSteps;
        emitDevice("periodStep");
      }
      if (st.lost && !lost) onOutputLost();
    }
    if (phonesSet && !phonesLost && !phones->active()) {
      phonesLost = true;
      devPhones.store(false);
      applyRouting();
      emitDevice("lost", "phones");
    }
    if (recorder->takeError()) emitRecStatus(std::string());
    if (lost && t >= nextLossRetryAt) {
      nextLossRetryAt = t + opt.lossRetryMs / 1000.0;
      tryRestore();
    }
    refreshStatusCache();
  }

  // ------------------------------------------------------------------------
  // Ops and vst-ops jobs (their own threads; pump() in manual mode)
  // ------------------------------------------------------------------------
  void queueJob(std::mutex& m, std::deque<Job>& q, std::condition_variable& cv, Job j) {
    {
      std::lock_guard<std::mutex> lk(m);
      q.push_back(std::move(j));
    }
    cv.notify_one();
  }

  std::string recordingsDir() const {
    if (opt.dataDir.empty()) return {};
    const char last = opt.dataDir.back();
    return opt.dataDir + ((last == '/' || last == '\\') ? "" : "/") + "recordings";
  }

  void runOpsJob(const Job& j) {
    switch (j.kind) {
      case Job::OutputEvent: handleOutputEvent(j); return;
      case Job::PhonesEvent: handlePhonesEvent(j); return;
      case Job::StallRestart: restartOutput(); return;
      case Job::FinishRecording:
        if (recorder->active()) {
          const RecStatus st = recorder->stop();
          emit(eventJson("rec.status", recStatusJson(st)));
        }
        return;
      default: break;
    }
    const ParsedCommand& pc = j.pc;
    const json::Value& b = pc.body;
    if (opt.jobHook) opt.jobHook("ops", pc.spec->name);
    switch (pc.spec->cmd) {
      case Cmd::DeviceList: {
        std::string err;
        const auto list = enumerate(&err);
        json::Value arr = json::Value::array();
        for (const auto& dv : list) arr.push(core::deviceInfoJson(dv));
        json::Value f = json::Value::object();
        f.set("devices", std::move(arr));
        reply(pc, err.empty() || !list.empty(), f, list.empty() ? err : std::string());
        return;
      }
      case Cmd::DeviceOpen: {
        DeviceConfig want;
        std::string err;
        if (!core::parseDeviceConfig(b, want, &err)) {
          reply(pc, false, json::Value(), err);
          return;
        }
        DeviceStatus st;
        if (!openOutput(want, &err, &st)) {
          refreshStatusCache();
          json::Value f = json::Value::object();
          {
            std::lock_guard<std::mutex> lk(statusM);
            f.set("status", statusCache);
          }
          reply(pc, false, f, err);
          return;
        }
        configured = want;
        haveConfigured = true;
        lost = false;
        lostId.clear();
        presentAtLoss.clear();
        devLost.store(false);
        emitDevice("opened");
        json::Value f = json::Value::object();
        {
          std::lock_guard<std::mutex> lk(statusM);
          f.set("status", statusCache);
        }
        if (st.fellBack) {
          json::Value fb = json::Value::object();
          fb.set("requested", json::Value::string(outputModeName(want.mode)));
          fb.set("mode", json::Value::string(deviceModeName(st.mode)));
          fb.set("reason", json::Value::string(st.fallbackReason.empty() ? "unsupported" : st.fallbackReason));
          f.set("fallback", std::move(fb));
          emitDevice("fallback");
        }
        reply(pc, true, f);
        return;
      }
      case Cmd::DevicePhones: {
        if (b["name"].isNull() && !b.has("deviceId") && !b.has("role")) {
          // No headphones card: the cue goes back to 3/4 of a 4-channel output.
          phones->close();
          phonesSet = false;
          phonesLost = false;
          devPhones.store(false);
          ++phonesGen;
          applyRouting();
          refreshStatusCache();
          json::Value f = json::Value::object();
          f.set("status", statusJson());
          reply(pc, true, f);
          return;
        }
        DeviceConfig want;
        std::string err;
        if (!core::parseDeviceConfig(b, want, &err)) {
          reply(pc, false, json::Value(), err);
          return;
        }
        want.mode = OutputMode::Shared;  // headphones: shared mode only (SPEC.md §8.7)
        const std::vector<DeviceInfo> list = enumerate(&err);
        DeviceConfig cfg = want;
        cfg.id = resolveOutputDevice(want, list);
        phones->close();
        const uint64_t gen = ++phonesGen;
        phones->setEventHandler([this, gen](const DeviceEventInfo& ev) {
          Job pj;
          pj.kind = Job::PhonesEvent;
          pj.ev = ev;
          pj.gen = gen;
          postOpsJob(std::move(pj));
        });
        const bool ok = !cfg.id.empty() &&
                        phones->open(cfg, static_cast<int>(sampleRate.load()), std::max(1, devPeriod.load()), &err);
        phonesSet = ok;
        phonesLost = false;
        phonesCfg = want;
        devPhones.store(ok);
        applyRouting();
        refreshStatusCache();
        json::Value f = json::Value::object();
        f.set("status", statusJson());
        reply(pc, ok, f, ok ? std::string() : (err.empty() ? std::string("no headphones device matches") : err));
        return;
      }
      case Cmd::DeviceClose: {
        const double rate = sampleRate.load();
        stopSys();
        lostDev.reset();
        haveConfigured = false;
        lost = false;
        devLost.store(false);
        std::string err;
        const bool ok = startNull(rate, opt.nullConfig.channels, opt.nullConfig.blockFrames, opt.nullConfig.latencyFrames, &err);
        applyRouting();
        emitDevice("closed");
        reply(pc, ok, json::Value(), err);
        return;
      }
      case Cmd::RecStart: {
        RecFormat fmt = RecFormat::S24;
        if (b.has("format") && !recFormatFromName(b["format"].asString().c_str(), fmt)) {
          reply(pc, false, json::Value(), "unknown format");
          return;
        }
        const std::string dir = recordingsDir();
        if (dir.empty()) {
          reply(pc, false, json::Value(), "no data folder");
          return;
        }
        const std::string name = b["name"].isString() && !b["name"].asString().empty() ? b["name"].asString()
                                                                                        : Recorder::defaultName();
        std::string path, err;
        const bool ok = recorder->start(dir, name, fmt, static_cast<int>(sampleRate.load()), &path, &err);
        json::Value f = json::Value::object();
        f.set("path", json::Value::string(path));
        f.set("format", json::Value::string(recFormatName(fmt)));
        reply(pc, ok, f, err);
        return;
      }
      case Cmd::RecStop: {
        const RecStatus st = recorder->stop();
        json::Value f = recStatusJson(st);
        reply(pc, st.error.empty(), f, st.error);
        return;
      }
      case Cmd::RecList: {
        json::Value arr = json::Value::array();
        const std::string dir = recordingsDir();
        if (!dir.empty()) {
          for (const RecFileInfo& r : recorder->list(dir, true)) {
            json::Value o = json::Value::object();
            o.set("path", json::Value::string(r.path));
            o.set("bytes", json::Value::number(static_cast<double>(r.bytes)));
            o.set("seconds", json::Value::number(r.seconds));
            o.set("repaired", json::Value::boolean(r.repaired));
            arr.push(std::move(o));
          }
        }
        json::Value f = json::Value::object();
        f.set("files", std::move(arr));
        reply(pc, true, f);
        return;
      }
      case Cmd::Shutdown: {
        // Orderly stop asked by the host: the recording is finalized, the
        // plugins unloaded, the devices closed (the threads stay until
        // destroy, so late commands are still answered).
        if (recorder->active()) {
          const RecStatus st = recorder->stop();
          json::Value f = recStatusJson(st);
          emit(eventJson("rec.status", f));
        }
        phones->close();
        phonesSet = false;
        devPhones.store(false);
        stopSys();
        stopNull();
        lostDev.reset();
        haveConfigured = false;
        lost = false;
        devMode.store(static_cast<int>(DeviceMode::Closed));
        Job vj;
        vj.kind = Job::UnloadAllVst;
        queueJob(vstM, vstQ, vstCv, std::move(vj));
        refreshStatusCache();
        emit(eventJson("shutdown", json::Value::object()));
        return;
      }
      default:
        reply(pc, false, json::Value(), "not an ops command");
        return;
    }
  }

  // The VST host (host thread + 4 deck workers) starts with the first
  // plugin, at the device rate, its editors owned by OpenMix's window.
  bool ensureVstHost(std::string* err) {
    if (vst->running()) return true;
    vst->setOwnerWindow(opt.ownerWindow);
    return vst->start(sampleRate.load(), kMaxBlockFrames, err);
  }

  void runVstJob(const Job& j) {
    if (j.kind == Job::UnloadAllVst) {
      if (vst->running())
        for (int d = 0; d < kNumDecks; d++) vst->unload(d);
      return;
    }
    if (j.kind == Job::VstReconfigure) {
      if (vst->running()) vst->reconfigure(j.rate, kMaxBlockFrames);
      return;
    }
    const ParsedCommand& pc = j.pc;
    const json::Value& b = pc.body;
    const int d = pc.rt.deck;
    if (opt.jobHook) opt.jobHook("vst", pc.spec->name);
    switch (pc.spec->cmd) {
      case Cmd::VstLoad: {
        const std::string path = b["path"].asString();
        bool allowed;
        {
          std::lock_guard<std::mutex> lk(policyM);
          allowed = policyAllowsVst(policy, path);
        }
        if (!allowed) {
          replyCode(pc, "plugin path not allowed", "notAllowed");
          return;
        }
        if (b.has("state") && !b["state"].isNull() && !b["state"].isString()) {
          replyCode(pc, "\"state\" must be base64 text", "invalid");
          return;
        }
        std::string err;
        if (!ensureVstHost(&err)) {
          replyCode(pc, err.empty() ? "VST host unavailable" : err, "unavailable");
          return;
        }
        // The state (base64, the Web engine's saved slots) is restored before
        // the plugin's first block.
        const VstLoadResult r = vst->load(d, path, b["uid"].asString(), b["state"].asString());
        json::Value f = json::Value::object();
        f.set("name", json::Value::string(r.name));
        f.set("latency", json::Value::number(r.latency));
        f.set("inputs", json::Value::number(r.inputs));
        f.set("outputs", json::Value::number(r.outputs));
        if (!r.code.empty()) f.set("code", json::Value::string(r.code));
        if (b["state"].isString() && !b["state"].asString().empty()) f.set("stateRestored", json::Value::boolean(r.stateRestored));
        reply(pc, r.ok, f, r.error);
        return;
      }
      case Cmd::VstUnload:
        if (vst->running()) vst->unload(d);
        reply(pc, true);
        return;
      case Cmd::VstEditor: {
        std::string err;
        if (!vst->running()) {
          reply(pc, false, json::Value(), "no plugin loaded");
          return;
        }
        err = vst->openEditor(d, opt.ownerWindow);
        reply(pc, err.empty(), json::Value(), err);
        return;
      }
      case Cmd::VstEditorClose:
        if (vst->running()) vst->closeEditor(d);
        return;
      case Cmd::VstGetState: {
        const std::string text = vst->running() ? vst->getState(d) : std::string();  // base64 text
        json::Value f = json::Value::object();
        f.set("state", json::Value::string(text));
        reply(pc, !text.empty(), f, text.empty() ? "no plugin state" : "");
        return;
      }
      case Cmd::VstSetState: {
        if (!b["state"].isString()) {
          replyCode(pc, "\"state\" must be base64 text", "invalid");
          return;
        }
        const bool ok = vst->running() && vst->setState(d, b["state"].asString());
        reply(pc, ok, json::Value(), ok ? "" : "state refused");
        return;
      }
      default:
        reply(pc, false, json::Value(), "not a vst command");
        return;
    }
  }

  void opsLoop() {
    for (;;) {
      Job j;
      bool have = false;
      {
        std::unique_lock<std::mutex> lk(opsM);
        opsCv.wait_for(lk, std::chrono::milliseconds(250), [&] { return !opsQ.empty() || !runJobs.load(); });
        if (!runJobs.load()) return;  // stopping: a job queued now is dropped (stop() cleared the rest)
        if (!opsQ.empty()) {
          j = std::move(opsQ.front());
          opsQ.pop_front();
          have = true;
        }
      }
      if (have) runOpsJob(j);
      opsTick(false);
    }
  }

  void vstLoop() {
    for (;;) {
      Job j;
      {
        std::unique_lock<std::mutex> lk(vstM);
        vstCv.wait(lk, [&] { return !vstQ.empty() || !runJobs.load(); });
        if (!runJobs.load()) return;  // stopping: queued jobs are dropped, never run at quit
        j = std::move(vstQ.front());
        vstQ.pop_front();
      }
      runVstJob(j);
    }
  }

  void drainJobs(std::mutex& m, std::deque<Job>& q, bool vstJobs) {
    for (;;) {
      Job j;
      {
        std::lock_guard<std::mutex> lk(m);
        if (q.empty()) return;
        j = std::move(q.front());
        q.pop_front();
      }
      if (vstJobs) runVstJob(j);
      else runOpsJob(j);
    }
  }

  // ------------------------------------------------------------------------
  // Audio thread
  // ------------------------------------------------------------------------
  void pushEvent(const RtEvent& e) noexcept {
    if (!evQ.push(e)) eventsLost++;
    pushedThisBlock = true;
  }

  // Audio thread: the object an undelivered command owns (a "when" deck.load,
  // deck.grid, deck.stems or sampler.load dropped by hello {reset}) is
  // released by the control thread, like any replaced object.
  void retireUndelivered(const RtCommand& c) noexcept {
    switch (c.type) {
      case Cmd::AttachFxChain:
      case Cmd::AttachColorChain: retire(Retired::FxChain, c.u.attach.ptr); break;
      case Cmd::AttachGrid: retire(Retired::Grid, c.u.attach.ptr); break;
      case Cmd::AttachStems: retire(Retired::Stems, c.u.attach.ptr); break;
      case Cmd::AttachTrack: retire(Retired::Track, c.u.attach.ptr); break;
      case Cmd::AttachSample: retire(Retired::Sample, c.u.attach.ptr); break;
      default: break;
    }
  }

  void retire(Retired::Kind k, const void* p) noexcept {
    if (!p) return;
    pushedThisBlock = true;
    Retired r;
    r.kind = k;
    r.ptr = p;
    if (backlogCount == 0 && retQ.push(r)) return;
    if (backlogCount < kRetireBacklog) {
      backlog[backlogCount++] = r;  // retried every block; never freed here
      return;
    }
    retiredLost++;  // leaked rather than freed on the audio thread (reported in health)
  }

  void retryBacklog() noexcept {
    int i = 0;
    while (i < backlogCount && retQ.push(backlog[i])) i++;
    if (i == 0) return;
    for (int k = i; k < backlogCount; k++) backlog[k - i] = backlog[k];
    backlogCount -= i;
    pushedThisBlock = true;
  }

  void apply(const RtCommand& c, const BlockClock& clk, bool late = false) noexcept {
    if (opt.applyHook) opt.applyHook(opt.applyHookUser, c);
    const int d = c.deck;
    Deck* dk = d >= 0 ? decks[d].get() : nullptr;
    switch (c.type) {
      // ---- mixer ----
      case Cmd::MasterVolume: mixer.setMasterVolume(c.u.level.v); break;
      case Cmd::MasterFilter: mixer.setMasterFilter(c.u.level.v); break;
      case Cmd::Crossfader: mixer.setCrossfader(c.u.level.v); break;
      case Cmd::XfSides:
        for (int k = 0; k < kNumDecks; k++) mixer.setXfSide(k, static_cast<XfSide>(c.u.xfSides.sides[k]));
        break;
      case Cmd::ColorTypeSet:
        mixer.setColorType(static_cast<ColorType>(c.u.color.type));  // forwards to the Color FX bus
        break;
      case Cmd::ColorEnabled: mixer.setColorEnabled(c.u.flag.on != 0); break;
      case Cmd::DeckColor: mixer.setDeckColor(d, c.u.level.v); break;
      case Cmd::DeckPfl: mixer.setDeckPfl(d, c.u.flag.on != 0); break;
      case Cmd::DeckVolume: mixer.setDeckVolume(d, c.u.level.v); break;
      case Cmd::DeckTrim: mixer.setDeckTrim(d, c.u.level.v); break;
      case Cmd::DeckEq: mixer.setDeckEq(d, static_cast<EqBand>(c.u.eq.band), c.u.eq.v); break;
      case Cmd::DeckPadDryHold: mixer.setPadDryHold(d, c.u.padDry.dry); break;
      case Cmd::FxSet:
        mixer.setFx(c.u.fx.unit, c.u.fx.mask, static_cast<FxType>(c.u.fx.type), c.u.fx.enabled != 0, c.u.fx.level,
                    c.u.fx.beats);
        break;
      case Cmd::FxAssign: mixer.setFxAssign(c.u.fxSends.bits); break;
      case Cmd::FxSends:
        if (c.u.fxSends.hasAssign) mixer.setFxAssign(c.u.fxSends.bits);
        mixer.updateFxSends();
        break;
      case Cmd::FxPad:
        mixer.setPadFx(d, c.u.fxPad.on != 0, static_cast<FxType>(c.u.fxPad.type), c.u.fxPad.beats, c.u.fxPad.level);
        break;
      case Cmd::SamplerPlay: mixer.sampler().play(c.u.sampler.slot, c.u.sampler.voice, c.u.sampler.gain, clk); break;
      case Cmd::SamplerStop: mixer.sampler().stop(c.u.sampler.voice); break;
      case Cmd::VstMix: vst->setMix(d, c.u.vstMix.mix); break;
      // ---- deck ----
      case Cmd::DeckPlay: dk->play(c.at, clk); break;
      case Cmd::DeckPause: dk->pause(c.at, clk); break;
      case Cmd::DeckSeek: dk->seek(c.u.seek.t, c.at, clk); break;
      case Cmd::DeckCuePoint: dk->setCuePoint(c.u.seek.t); break;
      case Cmd::DeckTempo:
        dk->setTempo(c.u.tempo.r);
        sync.onTempoCommand(d);  // engine.js _onTempo -> _followMaster
        break;
      case Cmd::DeckKey: dk->setKey(c.u.key.semi); break;
      case Cmd::DeckKeylock: dk->setKeylock(c.u.flag.on != 0); break;
      case Cmd::DeckLoop: dk->setLoop(c.u.loop.start, c.u.loop.end); break;
      case Cmd::DeckLoopExit: dk->exitLoop(); break;
      case Cmd::DeckLoopBeats: dk->setLoopBeats(c.u.loopBeats.beats); break;
      case Cmd::DeckRoll: dk->startRoll(c.u.roll.beats, c.u.roll.mix); break;
      case Cmd::DeckRollMix: dk->setRollMix(c.u.roll.mix); break;
      case Cmd::DeckRollStop: dk->stopRoll(c.u.roll.immediate != 0); break;
      case Cmd::DeckScratch: dk->scratch(static_cast<ScratchPhase>(c.u.scratch.phase), c.u.scratch.t, c.at, clk); break;
      case Cmd::DeckSpin: dk->spin(static_cast<SpinKind>(c.u.spin.kind), clk); break;
      case Cmd::DeckStemsOn: dk->setStemsOn(c.u.flag.on != 0); break;
      case Cmd::DeckStemGain: dk->setStemGain(static_cast<Stem>(c.u.stemGain.stem), c.u.stemGain.gain, c.u.stemGain.tau); break;
      case Cmd::DeckInterp: dk->setInterpolation(static_cast<InterpQuality>(c.u.interp.quality)); break;
      case Cmd::DeckKeylockRatio:
        dk->setKeylockRatioSource(c.u.keylockRatio.mode ? KeylockRatioSource::InputTempo : KeylockRatioSource::Worklet);
        break;
      case Cmd::KeylockPrecision:  // engine-wide setting: every deck (kept by hello {reset}, like sync.precision)
        for (auto& x : decks) x->setKeylockPrecision(c.u.flag.on != 0);
        break;
      case Cmd::GridOffset:
        for (auto& x : decks) x->setGlobalGridOffset(c.u.gridOffset.sec);
        sync.setGlobalGridOffset(c.u.gridOffset.sec);
        break;
      // ---- sync ----
      case Cmd::SyncMaster: sync.setManualMaster(c.u.master.idx); break;
      case Cmd::SyncJogHold: sync.setJogHold(c.u.flag.on != 0); break;
      case Cmd::SyncDo:
      case Cmd::SyncSnap: {
        RtEvent e;
        e.type = Ev::SyncResult;
        e.deck = static_cast<int8_t>(d);
        e.seq = c.seq;
        e.t = clk.presentTime;
        e.a = c.type == Cmd::SyncDo ? 0 : 1;
        e.ok = (c.type == Cmd::SyncDo ? sync.sync(d, clk) : sync.snapToRef(d, c.u.snap.maxErr)) ? 1 : 0;
        pushEvent(e);
        break;
      }
      case Cmd::SyncReanchor: sync.reanchor(d); break;
      case Cmd::SyncArm: sync.setSynced(d, c.u.flag.on != 0); break;
      case Cmd::SyncPrecision: sync.setNativePrecision(c.u.flag.on != 0); break;
      case Cmd::SyncBase: {
        SyncBaseWrite w;
        w.mask = c.u.syncBase.mask;
        w.base = c.u.syncBase.base;
        w.ref = c.u.syncBase.ref;
        w.pllCorr = c.u.syncBase.pllCorr;
        sync.writeSyncBase(d, w);
        break;
      }
      case Cmd::DeckPadRoll: sync.setPadRoll(d, c.u.roll.beats, c.u.roll.mix); break;
      // ---- internal ----
      case Cmd::EngineReset:
        // "when" commands of the previous page still scheduled are dropped
        // (never applied on the new page, no "applied" with an old seq); an
        // object one carries goes back to the control thread.
        for (int i = 0; i < pendingCount; i++) retireUndelivered(pending[i]);
        pendingCount = 0;
        for (int k = 0; k < kNumDecks; k++) {
          Deck& x = *decks[k];
          x.resetForLoad();
          x.clearLoopBounds();  // a new engine.js page starts at 0 / 0 (app.js RELOOP reads them)
          x.clearEnded();       // ... and with no natural end on record (resetForLoad keeps it)
          x.setKeylock(false);
          x.setInterpolation(InterpQuality::Linear);
          x.setKeylockRatioSource(KeylockRatioSource::Worklet);
          x.setGlobalGridOffset(0);
          retire(Retired::Stems, x.attachStems(nullptr));
          retire(Retired::Grid, x.attachGrid(nullptr));
          retire(Retired::Track, x.attachTrack(nullptr));
          sync.onTrackLoaded(k);
        }
        for (int s = 0; s < kMaxSamplerSlots; s++) retire(Retired::Sample, mixer.sampler().attach(s, nullptr));
        mixer.resetToDefaults();
        sync.resetToDefaults();  // keeps sync.precision (an engine setting, like keylock.precision on the decks)
        sync.setGlobalGridOffset(0);
        ack = 0;
        epochAudio = c.u.reset.epoch;
        return;  // the reset command itself is not acknowledged (ack restarts at 0)
      case Cmd::DeckResetForLoad:
        dk->resetForLoad();
        sync.onTrackLoaded(d);
        break;
      case Cmd::AttachTrack: retire(Retired::Track, dk->attachTrack(static_cast<const TrackBuffer*>(c.u.attach.ptr))); break;
      case Cmd::AttachGrid: retire(Retired::Grid, dk->attachGrid(static_cast<const BeatGrid*>(c.u.attach.ptr))); break;
      case Cmd::AttachStems: retire(Retired::Stems, dk->attachStems(static_cast<const StemSet*>(c.u.attach.ptr))); break;
      case Cmd::AttachSample:
        retire(Retired::Sample, mixer.sampler().attach(c.u.attach.slot, static_cast<const TrackBuffer*>(c.u.attach.ptr)));
        break;
      case Cmd::AttachFxUnit:
        // The core owns the unit (fxUnits); a replaced pointer is never freed here.
        mixer.attachFx(c.u.attach.unit, static_cast<IFxProcessor*>(const_cast<void*>(c.u.attach.ptr)));
        stUnitsAttached.fetch_add(1, std::memory_order_relaxed);
        break;
      case Cmd::AttachFxChain: {
        FxUnit* u = unitPtr[fxSlotIndex(c.u.attach.unit)].load(std::memory_order_acquire);
        auto* chain = static_cast<FxChain*>(const_cast<void*>(c.u.attach.ptr));
        // A chain made before a re-preparation has the old rate's sizes: refused.
        if (u && static_cast<uint32_t>(c.u.attach.slot) == audioGen) chain = u->attachChain(static_cast<FxType>(c.u.attach.type), chain);
        if (chain) stChainsDropped.fetch_add(1, std::memory_order_relaxed);
        else stChainsAttached.fetch_add(1, std::memory_order_relaxed);
        retire(Retired::FxChain, chain);  // refused (or no unit): back to the control thread
        break;
      }
      case Cmd::AttachColorChain: {
        auto* chain = static_cast<FxChain*>(const_cast<void*>(c.u.attach.ptr));
        if (colorFx && static_cast<uint32_t>(c.u.attach.slot) == audioGen)
          chain = colorFx->attachChain(static_cast<ColorType>(c.u.attach.type), chain);
        if (chain) stChainsDropped.fetch_add(1, std::memory_order_relaxed);
        else stChainsAttached.fetch_add(1, std::memory_order_relaxed);
        retire(Retired::FxChain, chain);
        break;
      }
      case Cmd::SetInsertLatency: dk->setInsertLatency(c.u.latency.frames); break;
      case Cmd::SetRouting: {
        OutputRouting r;
        r.masterL = c.u.routing.masterL;
        r.masterR = c.u.routing.masterR;
        r.cueL = c.u.routing.cueL;
        r.cueR = c.u.routing.cueR;
        mixer.setRouting(r);
        stRouting[0].store(r.masterL, std::memory_order_relaxed);
        stRouting[1].store(r.masterR, std::memory_order_relaxed);
        stRouting[2].store(r.cueL, std::memory_order_relaxed);
        stRouting[3].store(r.cueR, std::memory_order_relaxed);
        break;
      }
      case Cmd::SetVstDeadline: vst->setDeadline(c.u.deadline.fraction); break;
      default: stUnhandled.fetch_add(1, std::memory_order_relaxed); break;
    }
    if (c.flags & kRtWhen) {
      // "when" commands are excluded from ack and confirmed one by one.
      RtEvent e;
      e.type = Ev::Applied;
      e.seq = c.seq;
      e.t = clk.presentTime;
      e.ok = late ? 0 : 1;
      pushEvent(e);
    } else if (c.seq > ack) {
      ack = c.seq;  // arrival order: every seq <= ack has been applied
    }
  }

  static int frameOffset(EngineTime when, const BlockClock& clk) noexcept {
    const double k = (when - clk.presentTime) * clk.sampleRate;
    return k <= 0.0 ? 0 : static_cast<int>(std::min(k + 0.5, 1e9));
  }

  void renderSegment(float* out, int n, int ch, const BlockClock& sub) noexcept {
    const MixView mv = mixer.mixView();
    FxRackView fv;
    mixer.fxRackView(fv);
    sync.tick(sub, mv, fv);
    for (int u = 0; u < kNumFxUnits; u++) mixer.setFxBeatClock(panelUnit(u), sync.panelBeatClock(u));
    for (int k = 0; k < kNumDecks; k++) mixer.setFxBeatClock(padUnit(k), sync.padBeatClock(k));
    mixer.setFxBeatClock(masterUnit(), sync.masterBeatClock());
    DeckInput in[kNumDecks];
    for (int k = 0; k < kNumDecks; k++) {
      // Plugin latency joins the deck's read-ahead (SPEC.md §9.9, §13.3).
      const int L = vst->latencyFrames(k);
      if (L != insertLatency[k]) {
        insertLatency[k] = L;
        decks[k]->setInsertLatency(L);
      }
      {
        // VST transport at the insert INPUT position: the block the plugin
        // receives is heard L frames later (SPEC.md §13.3). Zero-latency
        // plugins get the transport too (lead = 0), or tempo-synced plugins
        // would see no tempo or position (V08).
        const BeatClock bc = sync.deckBeatClock(k);
        const double lead = L / sub.sampleRate;
        VstTransport t;
        t.playing = bc.playing;
        t.tempoBpm = bc.valid && bc.beatDur > 0 ? 60.0 / bc.beatDur : 0.0;
        t.beatPos = bc.beatPos + lead * bc.beatsPerSec;
        t.barStartBeat = std::floor(t.beatPos / 4.0) * 4.0;
        t.samplePos = static_cast<int64_t>(std::llround(decks[k]->positionAt(sub.presentTime + lead) * sub.sampleRate));
        vst->setTransport(k, t);
      }
      float* l = deckBuf.data() + static_cast<size_t>(k) * 2 * kMaxBlockFrames;
      float* r = l + kMaxBlockFrames;
      decks[k]->render(l, r, n, sub);
      in[k].l = l;
      in[k].r = r;
    }
    mixer.process(in, n, sub);  // IInsert::begin / end inside (two phases, SPEC.md §10.6)
    mixer.writeOutput(out, n, ch);
    recorder->push(mixer.masterL(), mixer.masterR(), n);
    if (devPhones.load(std::memory_order_relaxed)) phones->push(mixer.cueL(), mixer.cueR(), n, sub.callbackTime);
  }

  // Entry point of every device callback (one adapter per device kind).
  void deviceRender(int id, float* out, int frames, int ch, const BlockClock& devClk) noexcept {
    if (activeCb.load(std::memory_order_acquire) != id || inRender.exchange(true, std::memory_order_acquire)) {
      // Not the current output (a late callback after a switch), or a
      // render already running: silence, nothing touched.
      if (out && frames > 0 && ch > 0) std::memset(out, 0, sizeof(float) * static_cast<size_t>(frames) * static_cast<size_t>(ch));
      return;
    }
    BlockClock clk = devClk;
    const double devLatency = std::max(0.0, devClk.presentTime - devClk.callbackTime);
    if (opt.manual) {
      clk.callbackTime = sampleClock;  // manual mode: the engine clock is the sample clock
      clk.presentTime = sampleClock + devLatency;
    } else if (id == kCbNull) {
      clk.callbackTime = EngineClock::now();  // the NULL device has no DAC clock: real time
      clk.presentTime = clk.callbackTime + devLatency;
    }
    renderBlock(out, frames, ch, clk, devLatency);
    inRender.store(false, std::memory_order_release);
  }

  void renderBlock(float* out, int frames, int ch, const BlockClock& devClk, double devLatency) noexcept {
    rt::Scope rts;
    const uint64_t allocBefore = rt::allocViolations();
    const uint64_t freeBefore = rt::freeViolations();
    const EngineTime t0 = EngineClock::now();
    pushedThisBlock = false;
    BlockClock clk = devClk;
    clk.presentTime += mixer.masterLatencyFrames() / clk.sampleRate;  // heard at the master output
    clk.sampleTime = sampleClock;
    vst->startCallback(frames / clk.sampleRate);
    retryBacklog();

    // 1) commands: due ones now, future ones ("when") into the pending list
    RtCommand c;
    for (int budget = kCommandsPerCallback; budget > 0 && cmdQ.pop(c); budget--) {
      if (c.when > 0 && frameOffset(c.when, clk) > 0) {
        if (pendingCount < kPendingMax) {
          pending[pendingCount++] = c;
        } else {
          pendingFull++;
          apply(c, clk, true);  // confirmed late
        }
      } else {
        apply(c, clk);
      }
    }

    // 2) render, split at the scheduled commands (sample-exact)
    int pos = 0;
    while (pos < frames) {
      BlockClock sub = clk;
      sub.frame += pos;
      sub.callbackTime += pos / clk.sampleRate;
      sub.presentTime += pos / clk.sampleRate;
      sub.sampleTime += pos / clk.sampleRate;
      int n = std::min(frames - pos, kMaxBlockFrames);
      for (int i = 0; i < pendingCount;) {
        const int k = frameOffset(pending[i].when, sub);
        if (k == 0) {
          apply(pending[i], sub);
          pending[i] = pending[--pendingCount];
          continue;
        }
        if (k < n) n = k;
        i++;
      }
      sub.frames = n;
      renderSegment(out + static_cast<size_t>(pos) * ch, n, ch, sub);
      pos += n;
    }

    // 3) events and snapshot
    for (int k = 0; k < kNumDecks; k++) {
      const uint8_t vev = vst->takeEvents(k);
      if (vev) {
        RtEvent e;
        e.type = Ev::Vst;
        e.deck = static_cast<int8_t>(k);
        e.t = clk.presentTime;
        e.a = vev;
        e.b = vst->latencyFrames(k);
        pushEvent(e);
      }
    }
    block++;
    om_state& s = state.writeBuffer();
    s.struct_size = sizeof(om_state);
    s.ack = ack;
    s.epoch = epochAudio;
    s.block = block;
    s.t = clk.presentTime + frames / clk.sampleRate;
    for (int k = 0; k < kNumDecks; k++) {
      decks[k]->snapshot(s.decks[k], s.t);
      mixer.deckMeters(k, s.decks[k].peak, s.decks[k].rms, s.decks[k].dry);
      // The VST insert (SPEC.md §15.5): the lock-free accessor, never
      // vst->status() here (it clears latencyChanged and asks the backend).
      uint64_t late = 0;
      s.decks[k].insert_state = vst->insertState(k, &late);
      s.decks[k].insert_late = static_cast<uint32_t>(std::min<uint64_t>(late, UINT32_MAX));
    }
    sync.snapshot(s.sync);
    mixer.snapshot(s.mixer);
    const double load = (EngineClock::now() - t0) * clk.sampleRate / std::max(1, frames);
    if (load > 1.0) {
      overruns++;
      RtEvent e;
      e.type = Ev::Xrun;
      e.a = load;
      pushEvent(e);
    }
    if (static_cast<float>(load) > maxLoad.load(std::memory_order_relaxed))
      maxLoad.store(static_cast<float>(load), std::memory_order_relaxed);
    s.device = om_device_state();
    s.device.mode = devMode.load(std::memory_order_relaxed);
    s.device.sample_rate = static_cast<int32_t>(clk.sampleRate);
    s.device.channels = ch;
    const int period = devPeriod.load(std::memory_order_relaxed);
    s.device.period_frames = period > 0 ? period : frames;
    s.device.load = static_cast<float>(load);
    s.device.max_load = maxLoad.load(std::memory_order_relaxed);
    s.device.output_latency = devLatency;
    s.device.present_jitter_ms = devJitterMs.load(std::memory_order_relaxed);
    s.device.cue_routed = devCueRouted.load(std::memory_order_relaxed);
    s.device.phones_active = devPhones.load(std::memory_order_relaxed);
    s.device.recording = recorder->active();
    s.device.lost = devLost.load(std::memory_order_relaxed);
    s.device.fell_back = devFellBack.load(std::memory_order_relaxed);
    s.device.period_steps = devPeriodSteps.load(std::memory_order_relaxed);
    s.device.throttling_off = throttlingOff.load(std::memory_order_relaxed);
    s.device.xruns = overruns + devGlitches.load(std::memory_order_relaxed);
    s.health.rt_allocs = rt::allocViolations();
    s.health.rt_frees = rt::freeViolations();
    s.health.plugin_allocs = rt::pluginAllocations();
    s.health.batches_rejected = batchesRejected.load(std::memory_order_relaxed);
    s.health.events_lost = eventsLost;
    s.health.retired_backlog = static_cast<uint32_t>(backlogCount);
    s.health.retired_lost = retiredLost;
    s.health.pending_full = pendingFull;
    s.health.stalls = stalls.load(std::memory_order_relaxed);
    s.pcm_bytes = pcm.bytes();  // atomic load
    if (opt.snapshotHook) opt.snapshotHook(opt.snapshotHookUser, s);
    state.publish();
    sampleClock += frames / clk.sampleRate;
    stBlocks.store(block, std::memory_order_relaxed);
    if (opt.manual) manualNow.store(sampleClock, std::memory_order_relaxed);
    const uint64_t allocs = rt::allocViolations() - allocBefore;
    const uint64_t frees = rt::freeViolations() - freeBefore;
    if (allocs || frees) {
      RtEvent e;
      e.type = allocs ? Ev::RtAlloc : Ev::RtFree;
      e.a = static_cast<double>(allocs ? allocs : frees);
      pushEvent(e);
    }
    // Non-blocking wake-ups (WakeByAddress / futex): events or retired
    // objects to handle, or a state is due (disarmed here, re-armed by the
    // control thread after it sent the state).
    // (t0: the engine clock read at the start of this callback, whatever
    // clock the device stamps its blocks with)
    bool wakeNow = pushedThisBlock;
    double due = stateDueAt.load(std::memory_order_relaxed);
    if (t0 >= due && stateDueAt.compare_exchange_strong(due, 1e300, std::memory_order_acq_rel)) wakeNow = true;
    if (wakeNow) wakeControl();
  }

  // ------------------------------------------------------------------------
  // Control work (control thread, or pump() in manual mode)
  // ------------------------------------------------------------------------
  void processControlJobs() {
    // Never waits for a re-preparation of the ops thread: retried next time.
    std::unique_lock<std::mutex> prep(prepM, std::try_to_lock);
    if (!prep.owns_lock()) return;
    const uint32_t gen = prepGen.load();
    while (true) {
      ControlJob j;
      {
        std::lock_guard<std::mutex> lk(controlM);
        if (controlJobs.empty()) return;
        j = controlJobs.front();
        controlJobs.pop_front();
      }
      RtCommand c;
      switch (j.kind) {
        case ControlJob::MakeUnit: {
          if (fxUnits[j.slot]) break;
          auto u = std::make_unique<FxUnit>();
          u->prepare(sampleRate.load(), kMaxBlockFrames, fxReverbKernel);
          FxUnit* raw = u.get();
          fxUnits[j.slot] = std::move(u);
          unitPtr[j.slot].store(raw, std::memory_order_release);
          stFxUnits++;
          c.type = Cmd::AttachFxUnit;
          c.u.attach.ptr = static_cast<IFxProcessor*>(raw);
          c.u.attach.unit = unitOfSlot(j.slot);
          pushInternal(c);
          break;
        }
        case ControlJob::MakeChain: {
          FxUnit* u = fxUnits[j.slot].get();
          if (!u) break;
          FxChainPtr chain = u->makeChain(static_cast<FxType>(j.type));
          if (!chain) break;
          stFxChains++;
          c.type = Cmd::AttachFxChain;
          c.u.attach.ptr = chain.release();
          c.u.attach.unit = unitOfSlot(j.slot);
          c.u.attach.type = j.type;
          c.u.attach.slot = static_cast<int32_t>(gen);
          pushInternal(c);
          break;
        }
        case ControlJob::MakeColorChain: {
          if (!colorFx) break;
          FxChainPtr chain = colorFx->makeChain(static_cast<ColorType>(j.type));
          if (!chain) break;
          stColorChains++;
          c.type = Cmd::AttachColorChain;
          c.u.attach.ptr = chain.release();
          c.u.attach.type = j.type;
          c.u.attach.slot = static_cast<int32_t>(gen);
          pushInternal(c);
          break;
        }
      }
    }
  }

  void releaseRetired(const Retired& r) {
    switch (r.kind) {
      case Retired::Grid: delete static_cast<const BeatGrid*>(r.ptr); break;
      case Retired::Stems: {
        const auto* set = static_cast<const StemSet*>(r.ptr);
        for (const TrackBuffer* tb : set->stems)
          if (tb) pcm.release(tb);
        delete set;
        break;
      }
      case Retired::Track:
      case Retired::Sample: pcm.release(static_cast<const TrackBuffer*>(r.ptr)); break;
      case Retired::FxChain: FxChainDeleter()(static_cast<FxChain*>(const_cast<void*>(r.ptr))); break;
      case Retired::FxUnit: break;  // owned by fxUnits[]
    }
  }

  void drainRetired() {
    Retired r;
    while (retQ.pop(r)) releaseRetired(r);
  }

  void drainAudioSide() {
    drainRetired();
    RtEvent e;
    while (evQ.pop(e)) {
      json::Value f = json::Value::object();
      switch (e.type) {
        case Ev::SyncResult:
          f.set("deck", json::Value::number(e.deck));
          f.set("op", json::Value::string(e.a == 0 ? "sync" : "snap"));
          f.set("ok", json::Value::boolean(e.ok != 0));
          f.set("seq", json::Value::number(e.seq));
          emit(eventJson("sync.result", f));
          break;
        case Ev::Applied:
          f.set("seq", json::Value::number(e.seq));
          f.set("t", json::Value::number(e.t));
          f.set("late", json::Value::boolean(e.ok == 0));
          emit(eventJson("applied", f));
          break;
        case Ev::Vst: {
          const auto bits = static_cast<uint8_t>(e.a);
          const int d = e.deck;
          f.set("deck", json::Value::number(d));
          if (bits & kVstCrashed) emit(eventJson("vst.crashed", f));
          if (bits & kVstHung) emit(eventJson("vst.hung", f));
          if ((bits & kVstLate) && d >= 0 && d < kNumDecks) {
            // At most one "vst.late" per second and deck, with the count.
            vstLateCount[d]++;
            const EngineTime t = now();
            if (t - lastVstLate[d] >= 1.0) {
              lastVstLate[d] = t;
              json::Value g = json::Value::object();
              g.set("deck", json::Value::number(d));
              g.set("count", json::Value::number(vstLateCount[d]));
              vstLateCount[d] = 0;
              emit(eventJson("vst.late", g));
            }
          }
          if (bits & kVstLatency) {
            const VstSlotStatus st = vst->status(d);
            f.set("latency", json::Value::number(e.b));
            f.set("refused", json::Value::boolean(st.latencyRefused));
            emit(eventJson("vst.latency", f));
          }
          break;
        }
        case Ev::RtAlloc:
        case Ev::RtFree:
          f.set("kind", json::Value::string(e.type == Ev::RtAlloc ? "rt-alloc" : "rt-free"));
          f.set("count", json::Value::number(e.a));
          emit(eventJson("diag", f));
          break;
        case Ev::Xrun:
          xrunEvents++;  // reported (at most once per second) by emitDiagnostics
          break;
        default:
          break;
      }
    }
  }

  void refreshState() {
    std::lock_guard<std::mutex> lk(stateM);
    state.read(lastState);
  }

  // Overflow counters of the snapshot as "diag" events (at most once per
  // second per kind, SPEC.md §3.2): counters when they grow, the retired
  // backlog when it becomes non-empty.
  uint64_t diagSent[6] = {};
  void emitDiagnostics(const om_state& s, EngineTime t, bool force) {
    if (!force && t < nextDiagAt) return;
    nextDiagAt = t + 1.0;
    struct K {
      const char* kind;
      const char* what;
      uint64_t value;
      bool level;
    };
    const K ks[6] = {{"overflow", "events", s.health.events_lost, false},
                     {"queue-full", "commands", s.health.batches_rejected, false},
                     {"overflow", "retired", s.health.retired_lost, false},
                     {"overflow", "pending", s.health.pending_full, false},
                     {"xrun", "callback", xrunEvents, false},
                     {"overflow", "retiredBacklog", s.health.retired_backlog, true}};
    for (int i = 0; i < 6; i++) {
      const uint64_t v = ks[i].value;
      const bool report = ks[i].level ? (v > 0 && diagSent[i] == 0) : (v > diagSent[i]);
      diagSent[i] = v;
      if (!report) continue;
      json::Value f = json::Value::object();
      f.set("kind", json::Value::string(ks[i].kind));
      f.set("what", json::Value::string(ks[i].what));
      f.set("count", json::Value::number(static_cast<double>(v)));
      if (i == 4) f.set("maxLoad", json::Value::number(s.device.max_load));
      emit(eventJson("diag", f));
    }
  }

  void controlIteration(bool manualPump) {
    stIterations++;
    drainAudioSide();
    processControlJobs();
    retryDeferred();
    const EngineTime t = now();
    if (t >= nextGcAt) {
      nextGcAt = t + 1.0;
      pcm.collectGarbage(t);
    }
    pcm.freePending();  // the only place PCM memory is returned (SPEC.md §7.3)
    refreshState();
    om_state copy;
    {
      std::lock_guard<std::mutex> lk(stateM);
      copy = lastState;
    }
    // Natural ends: the sticky latch of each deck (never lost).
    for (int d = 0; d < kNumDecks; d++) {
      if (copy.decks[d].ended_count != lastEndedCount[d]) {
        lastEndedCount[d] = copy.decks[d].ended_count;
        json::Value f = json::Value::object();
        f.set("deck", json::Value::number(d));
        f.set("t", json::Value::number(copy.decks[d].ended_at));
        f.set("count", json::Value::number(copy.decks[d].ended_count));
        emit(eventJson("deck.ended", f));
      }
    }
    // "state" only when the audio thread published a new snapshot.
    if (copy.block != lastEmittedBlock && (manualPump || t >= nextStateAt)) {
      nextStateAt = t + 1.0 / std::max(1, stateHz.load(std::memory_order_relaxed));
      lastEmittedBlock = copy.block;
      emit(stateJson(copy));
      maxLoad.store(0.0f, std::memory_order_relaxed);  // diagnostics: max over one state period
    }
    // Heartbeat: the host is alive even when the audio is not.
    if (manualPump || t >= nextHbAt) {
      nextHbAt = t + opt.heartbeatMs / 1000.0;
      json::Value f = json::Value::object();
      f.set("t", json::Value::number(t));
      f.set("block", json::Value::number(static_cast<double>(copy.block)));
      f.set("running", json::Value::boolean(started.load() && audioExpected.load()));
      emit(eventJson("hb", f));
    }
    emitDiagnostics(copy, t, manualPump);
    // Stall watchdog (threaded mode): no new block while audio is expected.
    if (!opt.manual) {
      watchStall(copy.block, t);
      if (t >= nextThrottleAt) {
        nextThrottleAt = t + 10.0;
        throttlingOff.store(disableProcessPowerThrottling(nullptr), std::memory_order_relaxed);
      }
    }
  }

  void watchStall(uint64_t blk, EngineTime t) {
    if (blk != watchBlock) {
      watchBlock = blk;
      watchSince = t;
      if (stallPhase != 0) {
        stallPhase = 0;  // audio resumed (after the restart)
        json::Value f = json::Value::object();
        f.set("kind", json::Value::string("stall-recovered"));
        f.set("ms", json::Value::number((t - stallAt) * 1000.0));
        emit(eventJson("diag", f));
      }
      return;
    }
    if (!audioExpected.load()) {
      watchSince = t;  // nothing should render now (device switch): not a stall
      if (stallPhase != 1) return;
    }
    if (stallPhase == 0 && audioExpected.load() && t - watchSince > opt.stallMs / 1000.0) {
      stallPhase = 1;
      stallAt = t;
      stalls++;
      json::Value f = json::Value::object();
      f.set("kind", json::Value::string("stall"));
      f.set("ms", json::Value::number((t - watchSince) * 1000.0));
      emit(eventJson("diag", f));
      Job j;
      j.kind = Job::StallRestart;  // one stream restart (ops thread)
      postOpsJob(std::move(j));
    } else if (stallPhase == 1 && t - stallAt > opt.stalledMs / 1000.0) {
      stallPhase = 2;
      json::Value f = json::Value::object();
      f.set("reason", json::Value::string("stalled"));
      {
        std::lock_guard<std::mutex> lk(statusM);
        f.set("status", statusCache);
      }
      emit(eventJson("device", f));
    }
  }

  void controlLoop() {
    raiseServiceThreadPriority();  // "above normal" (SPEC.md §3.1): state, hb, events never queue behind a game
    lastIteration = std::chrono::steady_clock::now();
    while (runControl.load()) {
      const double gapMs = secondsSince(lastIteration) * 1000.0;
      lastIteration = std::chrono::steady_clock::now();
      if (gapMs > stMaxGapMs.load(std::memory_order_relaxed)) stMaxGapMs.store(gapMs, std::memory_order_relaxed);
      controlIteration(false);
      // Sleep until a wake-up or the next deadline: the audio thread wakes
      // us when a state is due (and for events / retired objects); the
      // heartbeat, the watchdog / GC granularity and deferred pushes are
      // timed here.
      stateDueAt.store(nextStateAt, std::memory_order_release);
      const EngineTime t = now();
      double wait = std::clamp(nextHbAt - t, 0.001, 0.05);
      if (!deferredEmpty()) wait = std::min(wait, 0.002);
      if (wake.try_acquire_for(std::chrono::microseconds(static_cast<int64_t>(wait * 1e6)))) {
        while (wake.try_acquire()) {
        }
      }
      wakePending.store(false, std::memory_order_release);
    }
  }

  EngineTime now() const noexcept {
    if (opt.manual) return manualNow.load(std::memory_order_relaxed);
    return EngineClock::now();
  }
};

Engine::Engine(const EngineOptions& opt) : impl_(std::make_unique<Impl>(opt)) {
  if (impl_->opt.manual) impl_->opt.nullDevice = true;
}

Engine::~Engine() { stop(); }

bool Engine::start(std::string* err) {
  Impl& m = *impl_;
  if (m.started) return true;
  const NullDeviceConfig& nc = m.opt.nullConfig;
  if (!m.prepared) {
    std::lock_guard<std::mutex> lk(m.prepM);
    m.prepareModules(nc.sampleRate > 0 ? nc.sampleRate : 48000);
  }
  // Initial routing set directly: no device renders yet.
  const core::Routing r = core::outputRouting(nc.channels, false);
  OutputRouting mr;
  mr.masterL = r.masterL;
  mr.masterR = r.masterR;
  mr.cueL = r.cueL;
  mr.cueR = r.cueR;
  m.mixer.setRouting(mr);
  m.stRouting[0].store(r.masterL);
  m.stRouting[1].store(r.masterR);
  m.stRouting[2].store(r.cueL);
  m.stRouting[3].store(r.cueR);
  m.devCueRouted.store(r.cueL >= 0);
  if (!m.startNull(m.sampleRate.load(), nc.channels, nc.blockFrames, nc.latencyFrames, err)) return false;
  // Endpoint notifications for the whole process (posted to the ops thread).
  {
    DeviceEventFn onEndpoint = [&m](const DeviceEventInfo& ev) {
      Impl::Job j;
      j.kind = Impl::Job::OutputEvent;
      j.ev = ev;
      j.fromWatcher = true;
      m.postOpsJob(std::move(j));
    };
    if (m.opt.backends.createWatcher) {
      m.watcher = m.opt.backends.createWatcher(onEndpoint);
    } else if (!m.opt.nullDevice) {
      std::string werr;
      m.watcher = createDeviceWatcher(onEndpoint, &werr);
    }
  }
  m.refreshStatusCache();
  m.started = true;
  if (!m.opt.manual) {
    m.runJobs = true;
    m.opsThread = std::thread([&m] { m.opsLoop(); });
    m.vstThread = std::thread([&m] { m.vstLoop(); });
    m.runControl = true;
    m.control = std::thread([&m] { m.controlLoop(); });
  }
  return true;
}

void Engine::stop() {
  Impl& m = *impl_;
  if (!m.started) return;
  m.runControl = false;
  m.wake.release();
  if (m.control.joinable()) m.control.join();
  // Quit order (SPEC.md §6.5): the queued jobs are dropped (their requests do
  // not matter at quit), the ops thread only finishes the job it is running,
  // the recording is finalized BEFORE the VST thread is joined (a plugin
  // load, editor or dialog job may wait for the plugin up to its time-out,
  // and main kills the host after a grace time), then the devices stop.
  m.runJobs = false;
  {
    std::lock_guard<std::mutex> lk(m.opsM);
    m.opsQ.clear();
  }
  {
    std::lock_guard<std::mutex> lk(m.vstM);
    m.vstQ.clear();
  }
  m.opsCv.notify_all();
  m.vstCv.notify_all();
  if (m.opsThread.joinable()) m.opsThread.join();
  // No ops thread any more: this thread owns the recorder.
  if (m.recorder->active()) m.recorder->stop();  // a running recording is finalized, never lost
  if (m.vstThread.joinable()) m.vstThread.join();
  // No ops thread any more: this thread owns the devices.
  m.watcher.reset();  // no notification after this
  m.stopSys();
  m.stopNull();
  m.lostDev.reset();
  m.phones->close();
  if (m.recorder->active()) m.recorder->stop();  // (a recording started meanwhile: never lost either)
  m.vst->stop();
  m.devMode.store(static_cast<int>(DeviceMode::Closed));
  m.started = false;
}

bool Engine::running() const noexcept { return impl_->started; }

void Engine::setEventSink(EventSink sink) {
  std::lock_guard<std::mutex> lk(impl_->sinkM);
  impl_->sink = std::move(sink);
}

void Engine::setPolicy(const EnginePolicy& p) {
  std::lock_guard<std::mutex> lk(impl_->policyM);
  impl_->policy = p;
}

CommandResult Engine::command(std::string_view text, std::string* err) {
  Impl& m = *impl_;
  std::vector<ParsedCommand> cmds;
  if (!parseCommands(text, cmds, err)) return CommandResult::Invalid;
  size_t cost = 0;
  for (const ParsedCommand& pc : cmds) cost += static_cast<size_t>(queueCost(pc));
  std::lock_guard<std::mutex> lk(m.producerM);
  // Atomic batch: room for every RtCommand of the message, or nothing runs.
  if (cost > 0 && m.cmdQ.freeApprox() < cost) {
    m.batchesRejected++;
    if (err) *err = "full";
    return CommandResult::Full;
  }
  for (const ParsedCommand& pc : cmds) {
    switch (pc.spec->route) {
      case Route::Audio:
        m.requestFxMemory(pc.rt);
        m.pushLocked(pc.rt);
        break;
      case Route::Inline:
        m.handleInline(pc);
        break;
      case Route::Ops: {
        Impl::Job j;
        j.pc = pc;
        m.queueJob(m.opsM, m.opsQ, m.opsCv, std::move(j));
        break;
      }
      case Route::Vst: {
        Impl::Job j;
        j.pc = pc;
        m.queueJob(m.vstM, m.vstQ, m.vstCv, std::move(j));
        break;
      }
    }
  }
  return CommandResult::Ok;
}

PcmError Engine::pcmBegin(const PcmDesc& d) { return impl_->pcm.begin(d); }
PcmError Engine::pcmWrite(uint32_t loadId, int64_t offsetFrames, int frames, int channels, const float* planar) {
  return impl_->pcm.write(loadId, offsetFrames, frames, channels, planar);
}
PcmError Engine::pcmEnd(uint32_t loadId) {
  const PcmError e = impl_->pcm.end(loadId);
  json::Value f = json::Value::object();
  f.set("loadId", json::Value::number(loadId));
  if (e == PcmError::None) {
    impl_->emit(eventJson("pcm.done", f));
  } else {
    f.set("error", json::Value::string(pcmErrorName(e)));
    impl_->emit(eventJson("pcm.error", f));
  }
  return e;
}
void Engine::pcmAbort(uint32_t loadId) { impl_->pcm.abort(loadId); }

bool Engine::readState(om_state& out) {
  impl_->refreshState();
  std::lock_guard<std::mutex> lk(impl_->stateM);
  out = impl_->lastState;
  return true;
}

EngineTime Engine::now() const noexcept { return impl_->now(); }
uint32_t Engine::epoch() const noexcept { return impl_->pcm.epoch(); }

EngineStats Engine::stats() const {
  const Impl& m = *impl_;
  EngineStats s;
  s.fxUnitsCreated = m.stFxUnits.load();
  s.fxChainsCreated = m.stFxChains.load();
  s.colorChainsCreated = m.stColorChains.load();
  s.fxUnitsAttached = m.stUnitsAttached.load();
  s.chainsAttached = m.stChainsAttached.load();
  s.chainsDropped = m.stChainsDropped.load();
  s.prepares = m.stPrepares.load();
  s.outputOpens = m.stOutputOpens.load();
  s.stallRestarts = m.stStallRestarts.load();
  s.unhandledCommands = m.stUnhandled.load();
  s.controlIterations = m.stIterations.load();
  s.maxControlGapMs = m.stMaxGapMs.load();
  s.blocks = m.stBlocks.load();
  for (int i = 0; i < 4; i++) s.routing[i] = m.stRouting[i].load();
  return s;
}

void Engine::pump() {
  Impl& m = *impl_;
  m.drainJobs(m.opsM, m.opsQ, false);
  m.drainJobs(m.vstM, m.vstQ, true);
  if (m.started) m.opsTick(true);
  m.drainJobs(m.opsM, m.opsQ, false);  // events posted by the tick (device restored...)
  m.controlIteration(true);
}

int Engine::render(float* out, int frames) {
  Impl& m = *impl_;
  if (!m.opt.manual || !m.nullDev || frames <= 0 || m.activeCb.load() != kCbNull) return 0;
  const int bf = m.nullDev->config().blockFrames;
  if (frames % bf != 0) return 0;  // whole NULL-device blocks only
  const int blocks = frames / bf;
  if (out) return m.nullDev->pump(blocks, out) * bf;
  int done = 0;
  for (int b = 0; b < blocks; b++) done += m.nullDev->pump(1, nullptr);
  return done * bf;
}

const char* engineVersion() noexcept { return "0.2.0-beta.1"; }

}  // namespace om
