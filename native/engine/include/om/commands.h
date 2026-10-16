// Fixed-size messages that cross thread boundaries inside the engine:
// RtCommand (control thread -> audio thread), RtEvent (audio thread ->
// control thread) and Retired (objects the audio thread hands back for
// deletion). See SPEC.md §14 for the dispatch table and §15 for the JSON
// names of every command (owner: host).
#pragma once

#include <cstdint>
#include <type_traits>

#include "om/common.h"

namespace om {

// Every command of the protocol. Commands up to kFirstAudioCmd run on the
// control thread only; the others are queued to the audio thread as RtCommand.
enum class Cmd : uint16_t {
  None = 0,

  // ---- control thread only ---------------------------------------------------
  Hello,           // hello
  EngineConfig,    // engine.config
  DeviceList,      // device.list
  DeviceOpen,      // device.open
  DevicePhones,    // device.phones
  DeviceClose,     // device.close
  ClockPing,       // clock.ping
  Shutdown,        // shutdown
  DeckPreload,     // deck.preload   (start decoding early)
  DeckLoad,        // deck.load      (commit: reset deck, attach when decoded)
  DeckLoadPcm,     // deck.loadPcm   (fallback: PCM decoded by the renderer)
  DeckCancelLoad,  // deck.cancelLoad
  DeckGrid,        // deck.grid      (builds an immutable BeatGrid)
  DeckStems,       // deck.stems     (decode + merge + align stems)
  SamplerLoad,     // sampler.load
  SamplerClear,    // sampler.clear
  RecStart,        // rec.start
  RecStop,         // rec.stop
  VstScan,         // vst.scan
  VstLoad,         // vst.load
  VstUnload,       // vst.unload
  VstEditor,       // vst.editor
  VstEditorClose,  // vst.editorClose
  VstGetState,     // vst.getState
  VstSetState,     // vst.setState
  VstStatus,       // vst.status

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

  // ---- audio thread: deck --------------------------------------------------------
  DeckUnload,      // deck.unload
  DeckPlay,        // deck.play
  DeckPause,       // deck.pause
  DeckSeek,        // deck.seek
  DeckCueButton,   // deck.cueButton (CDJ cue: engine.js Deck.cue())
  DeckCuePoint,    // deck.cuePoint  (deck.cuePoint = t)
  DeckTempo,       // deck.tempo
  DeckKey,         // deck.key
  DeckKeylock,     // deck.keylock
  DeckLoop,        // deck.loop
  DeckLoopExit,    // deck.loopExit
  DeckLoopBeats,   // deck.loopBeats (deck._loopBeats mirror)
  DeckRoll,        // deck.roll      (startRoll)
  DeckRollMix,     // deck.rollMix
  DeckRollStop,    // deck.rollStop
  DeckPadRoll,     // deck.padRoll   (deck._padRoll)
  DeckSlip,        // deck.slip      (CDJ slip mode, optional in phase 1)
  DeckScratch,     // deck.scratch   (scrubStart / scrubMove / scrubEnd)
  DeckSpin,        // deck.spin      (spinSound / stopSpinSound)
  DeckStemsOn,     // deck.stemsOn   (loadStems)
  DeckStemGain,    // deck.stemGain  (stemGains[x].gain.setTargetAtTime)
  GridGlobalOffset,  // grid.globalOffset (setGlobalGridOffset)

  // ---- audio thread: sync --------------------------------------------------------
  SyncMaster,      // sync.master    (setMaster / masterIdx = x)
  SyncJogHold,     // sync.jogHold   (engine.jogHold = x)
  SyncDo,          // sync.do        (engine.sync(i), replies)
  SyncReanchor,    // sync.reanchor  (engine.reanchorSync(i))
  SyncSnap,        // sync.snap      (engine.snapToRef(i), replies)
  SyncArm,         // sync.arm       (deck.synced = x)
  SyncBase,        // sync.base      (deck._syncBase / _pllCorr writes)

  // ---- audio thread: fx / sampler / vst --------------------------------------------
  FxSet,           // fx.set         (setType / setEnabled / setLevel / setBeatsMult)
  FxAssign,        // fx.assign      (fxAssign matrix + updateFxSends)
  FxPad,           // fx.pad         (engine.setPadFx)
  SamplerPlay,     // sampler.play
  SamplerStop,     // sampler.stop
  VstMix,          // vst.mix

  // ---- internal (control thread -> audio thread, no JSON name) -------------------
  DeckReset,       // engine.js loadTrack() state reset, sent at deck.load commit
  AttachTrack,     // u.attach.ptr = const TrackBuffer* (nullptr = detach), gen
  AttachGrid,      // u.attach.ptr = const BeatGrid*
  AttachStems,     // u.attach.ptr = const StemSet*
  AttachSample,    // u.sampler.slot + u.attach.ptr = const TrackBuffer*
  SetInsertLatency,  // u.latency.frames (VST plugin latency of the deck)
  Ack,             // pure ack of a control-thread command (seq)

  Count
};

constexpr Cmd kFirstAudioCmd = Cmd::MasterVolume;
inline bool isAudioCmd(Cmd c) noexcept { return c >= kFirstAudioCmd && c < Cmd::Count; }

// Bit masks of RtCommand::u.fx.mask
enum FxField : uint8_t { kFxType = 1, kFxEnabled = 2, kFxLevel = 4, kFxBeats = 8 };

// A command for the audio thread. Trivially copyable, 64 bytes, no pointers
// owned (attach commands carry borrowed pointers, see media.h ownership rule).
struct RtCommand {
  Cmd type = Cmd::None;
  int8_t deck = -1;      // target deck, -1 = global
  uint8_t reserved = 0;
  uint32_t seq = 0;      // UI sequence number, acknowledged in the state snapshot
  EngineTime at = 0;     // UI issue time on the engine clock (0 = unknown / now)
  union Payload {
    struct { double t; } seek;                       // DeckSeek, DeckCuePoint (heard position, s)
    struct { double r; } tempo;                      // DeckTempo
    struct { int32_t semi; } key;                    // DeckKey
    struct { uint8_t on; } flag;                     // DeckKeylock, DeckPfl, ColorEnabled, SyncJogHold, SyncArm, DeckStemsOn, DeckSlip
    struct { double start, end; } loop;              // DeckLoop (track seconds)
    struct { double beats; } loopBeats;              // DeckLoopBeats (NaN = cleared)
    struct { double beats, mix; uint8_t immediate; } roll;  // DeckRoll, DeckRollMix, DeckRollStop, DeckPadRoll (beats <= 0 = off)
    struct { double t; uint8_t phase; } scratch;     // DeckScratch (ScratchPhase)
    struct { uint8_t kind; } spin;                   // DeckSpin (SpinKind)
    struct { float v; } level;                       // volumes, trims, filters, crossfader, deck color
    struct { uint8_t band; float v; } eq;            // DeckEq
    struct { uint8_t stem; float gain; float tau; } stemGain;  // DeckStemGain
    struct { uint8_t sides[kNumDecks]; } xfSides;    // XfSides (XfSide per deck)
    struct { uint8_t type; } color;                  // ColorTypeSet (ColorType)
    struct { FxUnitId unit; uint8_t mask; uint8_t type; uint8_t enabled; float level; float beats; } fx;  // FxSet
    struct { uint16_t bits; } fxAssign;              // FxAssign: bit (unit * 4 + deck)
    struct { uint8_t on; uint8_t type; float beats; float level; } fxPad;  // FxPad
    struct { float dry; } padDry;                    // DeckPadDryHold (NaN = none)
    struct { int32_t idx; } master;                  // SyncMaster (-1 = automatic)
    struct { double base; uint8_t hasBase; uint8_t resetCorr; } syncBase;  // SyncBase
    struct { double maxErr; uint32_t replyId; } snap;  // SyncSnap
    struct { uint32_t replyId; } req;                // SyncDo
    struct { double sec; } gridOffset;               // GridGlobalOffset
    struct { const void* ptr; uint64_t gen; int32_t slot; } attach;  // Attach* (slot: sampler)
    struct { int32_t slot; float gain; } sampler;    // SamplerPlay / SamplerStop
    struct { int32_t frames; } latency;              // SetInsertLatency
    struct { float mix; } vstMix;                    // VstMix
    double raw[5];
  } u{};
};
static_assert(std::is_trivially_copyable<RtCommand>::value, "RtCommand must be trivially copyable");

// Something the audio thread reports to the control thread.
enum class Ev : uint8_t {
  None = 0,
  Ended,        // deck reached its end (engine.js onended) — t = engine time
  Reply,        // reply to SyncDo / SyncSnap — id, ok
  Xrun,         // the callback overran its period — a = load ratio
  VstCrashed,   // a plugin crashed inside process(): slot disabled
  QueueFull,    // a queue overflowed (diagnostics) — a = which queue
  StemsActive,  // stems switched on/off — a = on
};

struct RtEvent {
  Ev type = Ev::None;
  int8_t deck = -1;
  uint8_t ok = 0;
  uint8_t reserved = 0;
  uint32_t id = 0;
  EngineTime t = 0;
  double a = 0, b = 0;
};
static_assert(std::is_trivially_copyable<RtEvent>::value, "RtEvent must be trivially copyable");

// An object the audio thread no longer uses; the control thread destroys it.
struct Retired {
  const void* ptr = nullptr;
  void (*destroy)(const void*) noexcept = nullptr;
};
template <class T>
inline Retired retiredOf(const T* p) noexcept {
  return Retired{p, [](const void* q) noexcept { delete static_cast<const T*>(q); }};
}

}  // namespace om
