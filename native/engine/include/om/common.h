// Engine-wide types and constants of the OpenMix native audio engine.
//
// FROZEN FOUNDATION (maintainer: host). Every module depends on this file:
// a change needs the agreement of all module owners (see SPEC.md §20).
// Names and values mirror src/js/engine.js so that both engines behave alike.
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
constexpr int kNumFxUnits = 4;          // panel FX units (engine.js AudioEngine.fx)
constexpr int kNumSamplerSlots = 10;    // app.js PAD_COUNT
constexpr int kMaxBlockFrames = 2048;   // largest block a module ever receives (the core splits longer ones)
constexpr int kMaxOutputChannels = 32;
constexpr double kPreRollSec = 3600.0;  // engine.js PRE_ROLL: a track may sit up to 1 h before its start
constexpr int kWsolaLatencySamples = 2647;  // engine.js WS_LAT_SAMPLES == pitch-worklet.js LAT
constexpr double kTempoMin = 0.5;       // engine.js setTempo clamp
constexpr double kTempoMax = 1.6;
constexpr int kKeyMin = -7;             // engine.js setKey clamp (semitones)
constexpr int kKeyMax = 7;

// Seconds on the engine clock (see EngineClock). Every timestamp of the
// protocol ("at", "t", "te") uses this clock.
using EngineTime = double;

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
// call must happen on a non-real-time thread (function-local static).
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
// the ones used by engine.js / app.js and by the JSON protocol.
// ---------------------------------------------------------------------------
enum class Stem : uint8_t { Vocals = 0, Drums = 1, Bass = 2, Other = 3 };
constexpr int kNumStems = 4;  // engine.js keys; "bass" carries bass+other merged, "other" is normally empty

enum class EqBand : uint8_t { Low = 0, Mid = 1, High = 2 };
enum class XfSide : uint8_t { A = 0, B = 1 };

// What the channel FILTER knobs do (engine.js colorType)
enum class ColorType : uint8_t { Filter = 0, DubEcho, HpfEcho, LpfEcho, BpfEcho, CrushEcho, Reverb, Noise, Crush };
constexpr int kNumColorTypes = 9;

// Beat FX types (engine.js FxUnit.type / app.js FX_TYPE_OPTIONS)
enum class FxType : uint8_t {
  Delay = 0, Echo, Spiral, MtDelay, UpEcho, DownEcho, LowCut, PingPong, Reverb,
  Flanger, Phaser, Pan, Trans, Filter, Roll, Robot, Helix, Crush
};
constexpr int kNumFxTypes = 18;

enum class SpinKind : uint8_t { None = 0, VBrake = 1, Backspin = 2 };
enum class ScratchPhase : uint8_t { Start = 0, Move = 1, End = 2 };

// Addresses one FX unit: panel units 0..3, pad unit of deck 0..3, master FX.
// Plain POD (no initializers) so it can live inside the command union.
struct FxUnitId {
  enum Kind : uint8_t { Panel = 0, Pad = 1, Master = 2 };
  uint8_t kind;
  uint8_t index;
};
inline FxUnitId panelUnit(int i) noexcept { return {FxUnitId::Panel, static_cast<uint8_t>(i)}; }
inline FxUnitId padUnit(int deck) noexcept { return {FxUnitId::Pad, static_cast<uint8_t>(deck)}; }
inline FxUnitId masterUnit() noexcept { return {FxUnitId::Master, 0}; }

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
// Timing of one rendered block (see SPEC.md §4 "Time model").
// ---------------------------------------------------------------------------
struct BlockClock {
  int64_t frame = 0;            // device frame index of the block's first frame
  int frames = 0;               // frames in this block (<= kMaxBlockFrames)
  double sampleRate = 48000.0;  // device rate
  EngineTime callbackTime = 0;  // engine time when the block is being rendered
  EngineTime presentTime = 0;   // engine time when the block's first frame reaches the DAC
};

// Beat clock driving one beat-synced FX unit during one block (computed by the
// sync engine from the unit's reference deck, consumed by the FX units).
struct BeatClock {
  bool valid = false;        // a playing reference deck with a grid exists
  double beatDur = 0.5;      // real seconds per beat at the current speed (engine.js beatOf / setBeatDur)
  double beatPos = 0.0;      // fractional beat index relative to the bar anchor, at the block's presentTime
  double beatsPerSec = 2.0;  // d(beatPos)/dt in real time
};

// What the sync engine reads from the mixer each block (auto-master "bass deck" rule).
struct MixView {
  float volume[kNumDecks] = {0.85f, 0.85f, 0.85f, 0.85f};  // channel fader 0..1
  float eqLow[kNumDecks] = {0, 0, 0, 0};                  // LOW knob -1..1
  float xfGain[kNumDecks] = {1, 1, 1, 1};                 // crossfader gain of the deck's side
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
  FxUnitView master;
  // engine.js fxAssign[u][d] as bit (u * 4 + d); default: unit u processes deck u
  uint16_t assign = 0x8421;
  bool assigned(int unit, int deck) const noexcept { return (assign >> (unit * 4 + deck)) & 1u; }
};

// ---------------------------------------------------------------------------
// Channel insert (VST3) seen by the mixer: implemented by om::VstHost, faked
// in the mixer tests. Called on the audio thread only.
// ---------------------------------------------------------------------------
class IInsert {
 public:
  virtual ~IInsert() = default;
  // In-place processing of one deck's stereo signal; returns false when the
  // slot is empty, busy or crashed (the signal is then left untouched).
  virtual bool process(int deck, float* l, float* r, int frames) noexcept = 0;
  // Latency the insert adds (frames at the device rate), 0 when empty.
  virtual int latencyFrames(int deck) const noexcept = 0;
};

}  // namespace om
