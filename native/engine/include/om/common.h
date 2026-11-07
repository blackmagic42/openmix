// Engine-wide types and constants of libopenmix, the OpenMix native audio
// engine: sizes, the two clocks, the enumerations shared by the protocol and
// the modules, the per-block timing structs, the views modules give each
// other every block, and the seams between modules (IInsert for the VST
// inserts, IFxProcessor / IColorProcessor for the FX units the mixer drives).
//
// FROZEN FOUNDATION (maintainer: host). Every module depends on this file:
// a change needs the agreement of all module owners (see SPEC.md §19).
// Names, defaults and constants mirror src/js/engine.js so that both engines
// behave alike. No platform header may be included here.
#pragma once

#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <limits>

namespace om {

// ---------------------------------------------------------------------------
// Sizes and limits
// ---------------------------------------------------------------------------
constexpr int kNumDecks = 4;
constexpr int kNumFxUnits = 4;           // panel FX units (engine.js AudioEngine.fx)
constexpr int kMaxSamplerSlots = 32;     // samples registered by the JS proxy (app.js has 10 pads)
constexpr int kMaxSamplerVoices = 16;    // sampler voices playing at once
constexpr int kMaxBlockFrames = 2048;    // largest block a module ever receives (the core splits longer ones)
constexpr int kRenderQuantum = 128;      // Web Audio render quantum: k-rate parameters change at this pace
constexpr int kMaxOutputChannels = 32;
constexpr double kPreRollSec = 3600.0;   // engine.js PRE_ROLL: a track may sit up to 1 h before its start
constexpr int kWsolaLatencySamples = 2647;  // engine.js WS_LAT_SAMPLES == pitch-worklet.js LAT
constexpr double kTempoMin = 0.5;        // engine.js setTempo clamp
constexpr double kTempoMax = 1.6;
constexpr int kKeyMin = -7;              // engine.js setKey clamp (semitones)
constexpr int kKeyMax = 7;
constexpr double kMaxInsertLatencySec = 1.0;  // VST plugin latency cap (SPEC.md §13.3): refused above
constexpr double kArmedStartMaxSec = 0.25;    // armed deck start / sampler voice: longest wait for data (§9.1)

// Seconds on the ENGINE clock (see EngineClock): QueryPerformanceCounter
// time. Used only for the protocol's timestamps ("at", "when", "t", "te",
// anchors, endedAt) and their conversion to frames (SPEC.md §4.1).
using EngineTime = double;
// Seconds on the SAMPLE clock: audio rendered by the engine so far
// (sum of frames / rate over every block, continuous across device switches
// and device loss). Every internal duration uses it: sync timers, grace
// periods, calibration windows, armed waits, envelopes (SPEC.md §4.1).
using SampleTime = double;

constexpr double kNaN = std::numeric_limits<double>::quiet_NaN();
constexpr double kPi = 3.14159265358979323846;

inline bool isSet(double v) noexcept { return !std::isnan(v); }

template <class T>
constexpr T clampv(T v, T lo, T hi) noexcept {
  return v < lo ? lo : (v > hi ? hi : v);
}

inline double dbToGain(double db) noexcept { return std::pow(10.0, db / 20.0); }
inline double gainToDb(double g) noexcept { return 20.0 * std::log10(g > 1e-12 ? g : 1e-12); }

// JavaScript Math.round (halves round toward +infinity), needed for exact ports.
inline double jsRound(double x) noexcept { return std::floor(x + 0.5); }

// ---------------------------------------------------------------------------
// Engine clock: monotonic seconds since the first call in this process.
// std::chrono::steady_clock is QueryPerformanceCounter on Windows. The first
// call must happen on a non-real-time thread (function-local static): the
// Engine constructor calls it. Offline renders use a virtual clock instead
// (frames rendered / sample rate), see Engine::now().
// ---------------------------------------------------------------------------
struct EngineClock {
  static EngineTime now() noexcept {
    using namespace std::chrono;
    static const steady_clock::time_point origin = steady_clock::now();
    return duration<double>(steady_clock::now() - origin).count();
  }
};

// ---------------------------------------------------------------------------
// Enumerations shared by the protocol and the modules. The string names are
// the ones used by engine.js / app.js and by the JSON protocol (SPEC.md §15).
// ---------------------------------------------------------------------------
enum class Stem : uint8_t { Vocals = 0, Drums = 1, Bass = 2, Other = 3 };
constexpr int kNumStems = 4;  // engine.js keys; "bass" carries bass+other merged by app.js, "other" stays empty

enum class EqBand : uint8_t { Low = 0, Mid = 1, High = 2 };
enum class XfSide : uint8_t { A = 0, B = 1 };

// What the channel FILTER knobs do (engine.js colorType)
enum class ColorType : uint8_t { Filter = 0, DubEcho, HpfEcho, LpfEcho, BpfEcho, CrushEcho, Reverb, Noise, Crush };
constexpr int kNumColorTypes = 9;

// Beat FX types (engine.js FxUnit.type / app.js FX_TYPE_OPTIONS): 18 selectable
// types = 17 DSP effects + ROLL, which the DECK plays (the unit outputs silence).
enum class FxType : uint8_t {
  Delay = 0, Echo, Spiral, MtDelay, UpEcho, DownEcho, LowCut, PingPong, Reverb,
  Flanger, Phaser, Pan, Trans, Filter, Roll, Robot, Helix, Crush
};
constexpr int kNumFxTypes = 18;

enum class SpinKind : uint8_t { None = 0, VBrake = 1, Backspin = 2 };
enum class ScratchPhase : uint8_t { Start = 0, Move = 1, End = 2 };

// Addresses one FX unit: panel units 0..3, pad unit of deck 0..3, master FX.
// Plain POD (no initializers) so it can live inside the command union.
// JSON names: "fx0".."fx3", "pad0".."pad3", "master".
struct FxUnitId {
  enum Kind : uint8_t { Panel = 0, Pad = 1, Master = 2 };
  uint8_t kind;
  uint8_t index;
};
inline FxUnitId panelUnit(int i) noexcept { return {FxUnitId::Panel, static_cast<uint8_t>(i)}; }
inline FxUnitId padUnit(int deck) noexcept { return {FxUnitId::Pad, static_cast<uint8_t>(deck)}; }
inline FxUnitId masterUnit() noexcept { return {FxUnitId::Master, 0}; }
// Fields of an "fx.set" (RtCommand::u.fx.mask, Mixer::setFx mask).
enum FxField : uint8_t { kFxType = 1, kFxEnabled = 2, kFxLevel = 4, kFxBeats = 8 };
// Flat index 0..8 (panel 0-3, pad 4-7, master 8), for per-unit tables.
constexpr int kNumFxSlots = kNumFxUnits + kNumDecks + 1;
inline int fxSlotIndex(FxUnitId id) noexcept {
  return id.kind == FxUnitId::Panel ? (id.index & 3) : (id.kind == FxUnitId::Pad ? kNumFxUnits + (id.index & 3) : 8);
}

namespace detail {
template <int N>
inline int findName(const char* const (&names)[N], const char* s) noexcept {
  if (!s) return -1;
  for (int i = 0; i < N; i++) {
    if (std::strcmp(names[i], s) == 0) return i;
  }
  return -1;
}
inline const char* const kStemNames[] = {"vocals", "drums", "bass", "other"};
inline const char* const kEqNames[] = {"low", "mid", "high"};
inline const char* const kColorNames[] = {"filter", "dubecho", "hpfecho", "lpfecho", "bpfecho",
                                          "crushecho", "reverb", "noise", "crush"};
inline const char* const kFxNames[] = {"delay", "echo", "spiral", "mtdelay", "upecho", "downecho",
                                       "lowcut", "pingpong", "reverb", "flanger", "phaser", "pan",
                                       "trans", "filter", "roll", "robot", "helix", "crush"};
inline const char* const kSpinNames[] = {"none", "vbrake", "backspin"};
inline const char* const kScratchNames[] = {"start", "move", "end"};
}  // namespace detail

inline const char* stemName(Stem s) noexcept { return detail::kStemNames[static_cast<int>(s)]; }
inline bool stemFromName(const char* n, Stem& out) noexcept {
  int i = detail::findName(detail::kStemNames, n);
  if (i < 0) return false;
  out = static_cast<Stem>(i);
  return true;
}
inline const char* eqBandName(EqBand b) noexcept { return detail::kEqNames[static_cast<int>(b)]; }
inline bool eqBandFromName(const char* n, EqBand& out) noexcept {
  int i = detail::findName(detail::kEqNames, n);
  if (i < 0) return false;
  out = static_cast<EqBand>(i);
  return true;
}
inline const char* colorTypeName(ColorType t) noexcept { return detail::kColorNames[static_cast<int>(t)]; }
inline bool colorTypeFromName(const char* n, ColorType& out) noexcept {
  int i = detail::findName(detail::kColorNames, n);
  if (i < 0) return false;
  out = static_cast<ColorType>(i);
  return true;
}
inline const char* fxTypeName(FxType t) noexcept { return detail::kFxNames[static_cast<int>(t)]; }
inline bool fxTypeFromName(const char* n, FxType& out) noexcept {
  int i = detail::findName(detail::kFxNames, n);
  if (i < 0) return false;
  out = static_cast<FxType>(i);
  return true;
}
inline const char* spinKindName(SpinKind k) noexcept { return detail::kSpinNames[static_cast<int>(k)]; }
inline bool spinKindFromName(const char* n, SpinKind& out) noexcept {
  int i = detail::findName(detail::kSpinNames, n);
  if (i < 0) return false;
  out = static_cast<SpinKind>(i);
  return true;
}
inline const char* scratchPhaseName(ScratchPhase p) noexcept { return detail::kScratchNames[static_cast<int>(p)]; }
inline bool scratchPhaseFromName(const char* n, ScratchPhase& out) noexcept {
  int i = detail::findName(detail::kScratchNames, n);
  if (i < 0) return false;
  out = static_cast<ScratchPhase>(i);
  return true;
}

// engine.js FX_DRY_CUT / fxDryCut(): share of the deck's DRY sound removed
// when the effect is at full level (insert effects replace the sound, echoes
// add to it, flanger/phaser need the dry).
inline double fxDryCut(FxType t) noexcept {
  switch (t) {
    case FxType::Trans:
    case FxType::Filter:
    case FxType::Crush:
    case FxType::Robot:
    case FxType::Pan:
      return 1.0;
    case FxType::Roll:
      return 0.0;
    case FxType::Flanger:
    case FxType::Phaser:
      return 0.5;
    case FxType::Reverb:
      return 0.3;
    default:
      return 0.45;
  }
}

// ---------------------------------------------------------------------------
// Timing of one rendered (sub-)block (see SPEC.md §4 "Time model").
// ---------------------------------------------------------------------------
struct BlockClock {
  int64_t frame = 0;            // device frame index of the block's first frame
  int frames = 0;               // frames in this block (<= kMaxBlockFrames)
  double sampleRate = 48000.0;  // device rate
  EngineTime callbackTime = 0;  // engine time when the block is being rendered
  // Engine time when the block's first frame is HEARD at the master output:
  // the device's frame -> QPC mapping (IAudioClock, never the wake-up time)
  // + master chain latency (limiter look-ahead). Every "heard position" of
  // the protocol refers to this time.
  EngineTime presentTime = 0;
  // Sample clock at the block's first frame (filled by the core): the time
  // base of every internal duration.
  SampleTime sampleTime = 0;
  double secondsPerFrame() const noexcept { return sampleRate > 0 ? 1.0 / sampleRate : 0.0; }
  EngineTime presentTimeOf(int offset) const noexcept { return presentTime + offset * secondsPerFrame(); }
  SampleTime sampleTimeOf(int offset) const noexcept { return sampleTime + offset * secondsPerFrame(); }
};

// Beat clock of one deck or one beat-synced FX unit during one block
// (computed by the sync engine; consumed by the FX units and, per deck, by
// the VST transport).
struct BeatClock {
  bool valid = false;        // a reference deck with a grid exists
  bool playing = false;      // the reference deck is playing
  double beatDur = 0.5;      // real seconds per beat (app.js beatOf(): localPeriod / base tempo); 0.5 = fallback
  double beatPos = 0.0;      // fractional beat index relative to the bar anchor, at the block's presentTime
  double beatsPerSec = 2.0;  // d(beatPos)/dt in real time (includes the servo correction)
  double baseTempo = 1.0;    // the reference deck's base tempo: tempo / (1 + pllCorr)
};

// What the sync engine reads from the mixer each block (auto-master "bass deck" rule).
struct MixView {
  float volume[kNumDecks] = {0.85f, 0.85f, 0.85f, 0.85f};  // channel fader knob 0..1 (engine.js Deck.volume)
  float eqLow[kNumDecks] = {0, 0, 0, 0};                  // LOW knob -1..1 (engine.js Deck.eq.low)
  float xfGain[kNumDecks] = {1, 1, 1, 1};                 // crossfader gain of the deck's side (target, not smoothed)
};

// FX state the sync engine reads each block (fxRefDeck, ROLL driving, beat clocks).
struct FxUnitView {
  bool enabled = false;
  FxType type = FxType::Echo;
  float level = 0.0f;       // knob value 0..1 (engine.js FxUnit.level)
  float beatsMult = 0.5f;   // beat fraction (engine.js FxUnit.beatsMult)
};
struct FxRackView {
  FxUnitView panel[kNumFxUnits];
  FxUnitView pad[kNumDecks];
  bool padExists[kNumDecks] = {false, false, false, false};  // engine.js padFx[i] != null
  FxUnitView master;
  bool masterExists = false;                                  // engine.js masterFx != null
  // engine.js fxAssign[u][d], the LIVE matrix ("fx.assign"), as bit (u * 4 + d);
  // default: unit u processes deck u. The sends use their own latch ("fx.sends").
  uint16_t assign = 0x8421;
  bool assigned(int unit, int deck) const noexcept { return (assign >> (unit * 4 + deck)) & 1u; }
};

// ---------------------------------------------------------------------------
// Channel insert (VST3) seen by the mixer: implemented by om::VstHost, faked
// in the mixer tests. Called on the audio thread only, in two phases so the
// four decks' plugins run in parallel on their workers (SPEC.md §10.6, §13.2):
//   begin(d) for every deck after its FILTER, other work, then end(d).
// ---------------------------------------------------------------------------
class IInsert {
 public:
  virtual ~IInsert() = default;
  // Hands this block's pre-insert signal of `deck` to its plugin and returns
  // at once (never waits). False = no active plugin: end() is not called and
  // the signal passes untouched.
  virtual bool begin(int deck, const float* l, const float* r, int frames) noexcept = 0;
  // Writes the plugin output into l / r (the same buffers begin() read), or,
  // when the plugin missed the block deadline or is busy, hung, crashed or
  // bypassed, the dry signal delayed by the plugin latency (timing never
  // jumps). May spin until the block deadline; never longer.
  virtual void end(int deck, float* l, float* r, int frames) noexcept = 0;
  // Latency the insert adds (frames at the device rate), 0 when empty.
  virtual int latencyFrames(int deck) const noexcept = 0;
};

// ---------------------------------------------------------------------------
// FX seam (SPEC.md §10.3): the mixer drives FX units through these
// interfaces; the core creates the real om::FxUnit / om::ColorFx and attaches
// them by pointer, the mixer tests attach fakes. Audio thread only.
// ---------------------------------------------------------------------------
class IFxProcessor {
 public:
  virtual ~IFxProcessor() = default;
  virtual void setType(FxType t) noexcept = 0;           // engine.js setType (the old chain's output is cut)
  virtual void setEnabled(bool on) noexcept = 0;         // disabled = no output, chain state frozen
  virtual void setLevel(float v) noexcept = 0;           // 0..1: wet + intensity
  virtual void setBeatsMult(float m) noexcept = 0;       // beat fraction
  virtual void setBeatClock(const BeatClock& bc) noexcept = 0;  // every block
  virtual float wetGain() const noexcept = 0;            // current smoothed wet gain (dry cut, snapshot)
  // Processes the unit's send bus and writes its WET output (wet gain
  // applied). Silence when disabled, for "roll", and while the chain's
  // memory is not attached yet.
  virtual void process(const float* inL, const float* inR, float* outL, float* outR, int n) noexcept = 0;
};

class IColorProcessor {
 public:
  virtual ~IColorProcessor() = default;
  virtual void setType(ColorType t) noexcept = 0;        // engine.js _routeColor
  // Processes the color bus and writes the wet signal BEFORE the mixer's
  // 0.85 colorWet gain. Silence while the type's chain is not attached yet.
  virtual void process(const float* inL, const float* inR, float* outL, float* outR, int n) noexcept = 0;
};

}  // namespace om
