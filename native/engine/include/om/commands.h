// Fixed-size messages that cross thread boundaries inside the engine
// (owner: host): RtCommand (host JS / control thread -> audio thread),
// RtEvent (audio thread -> control thread) and Retired (objects the audio
// thread hands back to be released on the control thread). The JSON name of
// every command and its route (inline / ops / vst / audio) are listed in
// protocol.cpp and SPEC.md §15.3.
#pragma once

#include <cstdint>
#include <type_traits>

#include "om/common.h"

namespace om {

// Every command of the protocol. Commands before kFirstAudioCmd never reach
// the audio thread as such (they run inline, on the ops thread or on the
// vst-ops thread, SPEC.md §3.3); the others are queued as RtCommand.
enum class Cmd : uint16_t {
  None = 0,

  // ---- control side ------------------------------------------------------------
  Hello,           // hello           inline (reset -> EngineReset)
  EngineConfig,    // engine.config   inline
  ClockPing,       // clock.ping      inline
  DeviceList,      // device.list     ops
  DeviceOpen,      // device.open     ops
  DevicePhones,    // device.phones   ops
  DeviceClose,     // device.close    ops
  DeviceStatus,    // device.status   inline (cached)
  Shutdown,        // shutdown        ops
  PcmBegin,        // pcm.begin       inline (the data comes through om_pcm_write)
  PcmAbort,        // pcm.abort       inline
  DeckLoad,        // deck.load       inline (engine.js loadTrack: reset + attach PCM + grid)
  DeckUnload,      // deck.unload     inline
  DeckStems,       // deck.stems      inline (stem PCM ready on the deck, not on)
  DeckGrid,        // deck.grid       inline (builds an immutable BeatGrid)
  SamplerLoad,     // sampler.load    inline
  SamplerClear,    // sampler.clear   inline
  RecStart,        // rec.start       ops
  RecStop,         // rec.stop        ops
  RecStatus,       // rec.status      inline (cached)
  RecList,         // rec.list        ops
  VstLoad,         // vst.load        vst
  VstUnload,       // vst.unload      vst
  VstEditor,       // vst.editor      vst
  VstEditorClose,  // vst.editorClose vst
  VstGetState,     // vst.getState    vst
  VstSetState,     // vst.setState    vst
  VstStatus,       // vst.status      inline (non-blocking)

  // ---- audio thread: mixer -----------------------------------------------------
  MasterVolume,    // master.volume
  MasterFilter,    // master.filter
  Crossfader,      // xf.set
  XfSides,         // xf.sides
  ColorTypeSet,    // color.type
  ColorEnabled,    // color.enabled
  DeckColor,       // deck.color     (engine.setDeckColor)
  DeckPfl,         // deck.pfl       (engine.setCuePfl)
  DeckVolume,      // deck.volume
  DeckTrim,        // deck.trim
  DeckEq,          // deck.eq
  DeckPadDryHold,  // deck.padDryHold (deck._padDryHold)
  FxSet,           // fx.set         (setType / setEnabled / setLevel / setBeatsMult, ensureMasterFx)
  FxAssign,        // fx.assign      (the LIVE fxAssign matrix)
  FxSends,         // fx.sends       (updateFxSends latch; optional assign first)
  FxPad,           // fx.pad         (engine.setPadFx)
  SamplerPlay,     // sampler.play
  SamplerStop,     // sampler.stop
  VstMix,          // vst.mix

  // ---- audio thread: deck ------------------------------------------------------
  DeckPlay,        // deck.play
  DeckPause,       // deck.pause
  DeckSeek,        // deck.seek
  DeckCuePoint,    // deck.cuePoint  (deck.cuePoint = t)
  DeckTempo,       // deck.tempo
  DeckKey,         // deck.key
  DeckKeylock,     // deck.keylock
  DeckLoop,        // deck.loop
  DeckLoopExit,    // deck.loopExit
  DeckLoopBeats,   // deck.loopBeats (deck._loopBeats = x)
  DeckRoll,        // deck.roll      (startRoll)
  DeckRollMix,     // deck.rollMix   (setRollMix)
  DeckRollStop,    // deck.rollStop  (stopRoll)
  DeckScratch,     // deck.scratch   (scrubStart / scrubMove / scrubEnd)
  DeckSpin,        // deck.spin      (spinSound / stopSpinSound)
  DeckStemsOn,     // deck.stemsOn   (loadStems / off)
  DeckStemGain,    // deck.stemGain  (stemGains[x].gain.setTargetAtTime)
  DeckInterp,      // deck.interp    (A/B of the interpolation quality, dev only)
  DeckKeylockRatio,  // deck.keylockRatio (A/B of the WSOLA ratio source, dev only)
  GridOffset,      // grid.offset    (setGlobalGridOffset)

  // ---- audio thread: sync --------------------------------------------------------
  SyncMaster,      // sync.master    (masterIdx = x; setMaster toggles in the proxy)
  SyncJogHold,     // sync.jogHold   (engine.jogHold = x)
  SyncDo,          // sync.do        (engine.sync(i))
  SyncReanchor,    // sync.reanchor  (engine.reanchorSync(i))
  SyncSnap,        // sync.snap      (engine.snapToRef(i, maxErr))
  SyncArm,         // sync.arm       (deck.synced = x)
  SyncBase,        // sync.base      (deck._syncBase / _syncRef / _pllCorr writes)
  SyncPrecision,   // sync.precision (native precision refinements; survives resetToDefaults)
  DeckPadRoll,     // deck.padRoll   (deck._padRoll = {beats, mix} | null)

  // ---- internal (no JSON name) -----------------------------------------------------
  EngineReset,       // hello {reset}: decks unloaded, samples cleared, mixer/FX/sync defaults, ack = 0, u.reset.epoch
  DeckResetForLoad,  // engine.js loadTrack() reset, sent by deck.load before the attaches
  AttachTrack,       // u.attach.ptr = const TrackBuffer* (nullptr = detach)
  AttachGrid,        // u.attach.ptr = const BeatGrid*
  AttachStems,       // u.attach.ptr = const StemSet*
  AttachSample,      // u.attach.ptr = const TrackBuffer*, u.attach.slot
  AttachFxUnit,      // u.attach.ptr = IFxProcessor* (pad / master unit created by the control thread), u.attach.unit
  AttachFxChain,     // u.attach.ptr = FxChain* for unit u.attach.unit, type u.attach.type (lazy chain)
  AttachColorChain,  // u.attach.ptr = FxChain* of the Color FX bus, color type u.attach.type
  SetInsertLatency,  // u.latency.frames (VST plugin latency of the deck)
  SetRouting,        // u.routing (output channels of master / cue)
  SetVstDeadline,    // u.deadline.fraction (engine.config {vstDeadline})

  Count
};

constexpr Cmd kFirstAudioCmd = Cmd::MasterVolume;
inline bool isAudioCmd(Cmd c) noexcept { return c >= kFirstAudioCmd && c < Cmd::Count; }

// A command for the audio thread. Trivially copyable, no pointer owned
// (attach commands carry pointers whose ownership rules are in media.h and
// fx.h: the audio thread never frees them, it retires them).
struct RtCommand {
  Cmd type = Cmd::None;
  int8_t deck = -1;      // target deck, -1 = global
  uint8_t flags = 0;     // kRtWhen when the message carried "when" (excluded from ack, confirmed by Applied)
  uint32_t seq = 0;      // UI sequence number, acknowledged in the state snapshot
  EngineTime at = 0;     // UI issue time on the engine clock (0 = unknown / now)
  EngineTime when = 0;   // apply at this engine time, sample-exact (0 = next block)
  union Payload {
    struct { double t; } seek;                       // DeckSeek, DeckCuePoint (heard position, s)
    struct { double r; } tempo;                      // DeckTempo
    struct { int32_t semi; } key;                    // DeckKey
    struct { uint8_t on; } flag;                     // DeckKeylock, DeckPfl, ColorEnabled, SyncJogHold, SyncArm, SyncPrecision, DeckStemsOn
    struct { double start, end; } loop;              // DeckLoop (track seconds)
    struct { double beats; } loopBeats;              // DeckLoopBeats (NaN = null)
    struct { double beats, mix; uint8_t immediate; } roll;  // DeckRoll, DeckRollMix, DeckRollStop, DeckPadRoll (beats <= 0 = null)
    struct { double t; uint8_t phase; } scratch;     // DeckScratch (ScratchPhase)
    struct { uint8_t kind; } spin;                   // DeckSpin (SpinKind)
    struct { float v; } level;                       // volumes, trims, filters, crossfader, deck color
    struct { uint8_t band; float v; } eq;            // DeckEq
    struct { uint8_t stem; float gain; float tau; } stemGain;  // DeckStemGain
    struct { uint8_t sides[kNumDecks]; } xfSides;    // XfSides (XfSide per deck)
    struct { uint8_t type; } color;                  // ColorTypeSet (ColorType)
    struct { FxUnitId unit; uint8_t mask; uint8_t type; uint8_t enabled; float level; float beats; } fx;  // FxSet
    struct { uint16_t bits; uint8_t hasAssign; } fxSends;  // FxAssign (bits), FxSends (hasAssign: bits valid)
    struct { uint8_t on; uint8_t type; float beats; float level; } fxPad;  // FxPad
    struct { float dry; } padDry;                    // DeckPadDryHold (NaN = null)
    struct { int32_t idx; } master;                  // SyncMaster (-1 = automatic)
    struct { uint8_t mask; double base, ref, pllCorr; } syncBase;  // SyncBase (SyncBaseWrite)
    struct { double maxErr; } snap;                  // SyncSnap
    struct { double sec; } gridOffset;               // GridOffset
    struct { uint8_t quality; } interp;              // DeckInterp (InterpQuality)
    struct { uint8_t mode; } keylockRatio;           // DeckKeylockRatio (0 worklet, 1 input tempo)
    struct { const void* ptr; int32_t slot; FxUnitId unit; uint8_t type; } attach;  // Attach*
    struct { int32_t slot; uint32_t voice; float gain; } sampler;  // SamplerPlay / SamplerStop
    struct { int32_t frames; } latency;              // SetInsertLatency
    struct { int8_t masterL, masterR, cueL, cueR; } routing;  // SetRouting
    struct { float mix; } vstMix;                    // VstMix
    struct { float fraction; } deadline;             // SetVstDeadline
    struct { uint32_t epoch; } reset;                // EngineReset
    double raw[4];
  } u{};
};
static_assert(std::is_trivially_copyable<RtCommand>::value, "RtCommand must be trivially copyable");
constexpr uint8_t kRtWhen = 1;  // RtCommand::flags

// Something the audio thread reports to the control thread. (The end of a
// track is NOT an event: it is the sticky om_deck_state::ended_count latch.)
enum class Ev : uint8_t {
  None = 0,
  SyncResult,   // result of SyncDo / SyncSnap — a = 0 sync / 1 snap, ok, seq
  Applied,      // a "when" command took effect — seq, t; ok = 0 when applied late (pending list full)
  Xrun,         // the callback overran its period — a = load ratio
  Vst,          // VST slot events of a deck — a = VstEvent bits (crashed, hung, late, latency)
  RtAlloc,      // allocations detected on the audio thread (trap builds) — a = count
  RtFree,       // frees detected on the audio thread (trap builds) — a = count
};

struct RtEvent {
  Ev type = Ev::None;
  int8_t deck = -1;
  uint8_t ok = 0;
  uint8_t reserved = 0;
  uint32_t seq = 0;
  EngineTime t = 0;
  double a = 0, b = 0;
};
static_assert(std::is_trivially_copyable<RtEvent>::value, "RtEvent must be trivially copyable");

// An object the audio thread no longer uses; the control thread destroys it
// (or releases it to its owner, e.g. the PCM store).
struct Retired {
  enum Kind : uint8_t { Grid = 0, Stems = 1, Track = 2, Sample = 3, FxUnit = 4, FxChain = 5 };
  uint8_t kind = Grid;
  const void* ptr = nullptr;
};

}  // namespace om
