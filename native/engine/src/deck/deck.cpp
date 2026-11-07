// Deck transport and rendering (owner: deck), SPEC.md §4.3, §4.4, §9:
// everything engine.js Deck does before TRIM.
//
// Signal path (engine.js: source -> srcGain + roll -> preIn -> direct / WSOLA
// -> trim; scrubIn -> trim):
//   main read pointer (track, or the stems with their gains)  x mainGain
// + roll read pointer (the slice, looped)                      x rollGain
//   = the voice INPUT -> direct, or the voice's WSOLA instance (lockstep)
//   (two voices, A/B: 5 ms crossfades for jumps, 6 ms for route changes)
// + scratch voice (signed follower) + spin voice (V.BRAKE / BACKSPIN)
// + the pre-rendered fade-out tail of a load / media swap
//   = the deck's pre-TRIM output.
//
// Time: the deck counts its own output frames (g). Every rendered frame's
// "content" position (the track position it carries) and nominal rate go to
// a ring sized for the insert latency (<= 1 s); the heard position at master
// frame G is the content of deck frame G - insertLatency, and future frames
// are predicted from the read pointers (the WSOLA input history gives the
// next 2647 frames exactly). Positions are exact: the read pointer follows
// Chromium's accumulation (tests/deck goldens) and the bookkeeping records
// what is rendered, never an estimate.
//
// Real-time rules: prepare() allocates; everything else is noexcept, without
// allocation, free, lock or I/O. Buffers the deck reads are borrowed: a
// voice never keeps a pointer to a detached buffer (the fade-out of a load or
// a stem swap is rendered BEFORE the old buffer is returned).
#include "om/deck.h"

#include <algorithm>
#include <cmath>
#include <cstring>

#include "deck_internal.h"
#include "om/grid.h"
#include "om/wsola.h"

namespace om {

using deckimpl::ARateTarget;
using deckimpl::KRateTarget;
using deckimpl::FadeRamp;
using deckimpl::LoopFrames;

namespace {

constexpr int LAT = Wsola::kLatency;
constexpr int kQ = kRenderQuantum;
constexpr int kSrcRing = 8192;  // per-voice input history (deck frames)
constexpr int64_t kSrcMask = kSrcRing - 1;
static_assert(kSrcRing >= LAT + 2 * kMaxBlockFrames + kQ, "the input history must cover the WSOLA lag and a block");
constexpr int kTailMax = 1024;          // pre-rendered fade-out (2 ms at up to 384 kHz)
constexpr double kStopFadeSec = 0.002;  // pause, stop, end, load (SPEC.md §9.10)
constexpr double kJumpFadeSec = 0.005;  // jumps while playing, stems on/off
constexpr double kRouteFadeSec = 0.006; // entering / leaving the transposer (engine.js _switchRoute ramps)
constexpr double kRatioTau = 0.02;      // engine.js _applyPitch setTargetAtTime(ratio, now, 0.02)
constexpr double kRollTau = 0.004;      // engine.js _rampGain
constexpr double kSpinStopFade = 0.02;  // engine.js stopSpinSound
constexpr double kScratchMaxSpeed = 8.0;
constexpr double kScratchOmega = 60.0;  // follower: critically damped, time constant ~ one UI frame (1/60 s)
constexpr double kScratchSilent = 0.01; // |speed| below: silence (a held platter)
constexpr double kScratchFull = 0.08;   // |speed| above: full level
constexpr double kScratchJitterSec = 0.03;  // command lead spread absorbed by the scratch timeline

inline double clampd(double v, double lo, double hi) noexcept { return v < lo ? lo : (v > hi ? hi : v); }

struct Content {
  double pos;  // track seconds
  float rate;  // nominal heard rate (track s per s)
};

}  // namespace

// One transport voice: a read pointer (track or stems), its WSOLA instance,
// its gain envelope, and the history of what it fed (for the heard mapping).
struct DeckVoice {
  bool active = false;
  bool routed = false;
  bool stems = false;
  bool finished = false;  // Chromium: the source passed the end of the buffer (reads silence)
  bool dying = false;     // fading out: deactivated when its ramp reaches 0
  bool endKnown = false;  // finishInput is valid
  int64_t finishInput = 0;  // deck frame of the first input frame past the end
  double rp = 0;          // read pointer (source frames), Chromium's virtual_read_index
  FadeRamp gain;
  std::unique_ptr<double[]> srcPos;  // [kSrcRing] seconds of the input frame fed at deck frame g
  std::unique_ptr<float[]> srcRate;  // [kSrcRing] heard rate of that input frame
};

struct Deck::Impl {
  // ---- setup ----
  double fs = 48000;
  int maxBlock = kMaxBlockFrames;
  bool prepared = false;
  // ---- media (borrowed) ----
  const TrackBuffer* track = nullptr;
  const BeatGrid* grid = nullptr;
  const StemSet* stems = nullptr;
  // ---- transport ----
  bool playing = false;
  bool armed = false;
  double armPos = 0;
  SampleTime armSince = 0;
  float startWaitMs = 0;
  double pausedPos = 0;  // position while stopped (track s)
  double tempo = 1.0;
  float tempoF = 1.0f;   // the AudioParam value Chromium plays with
  double cuePoint = 0;
  int keyShift = 0;
  bool keylock = false;
  bool routeWanted = false;  // engine.js _routeW
  bool looping = false;
  double loopStart = 0, loopEnd = 0, loopBeats = kNaN;
  double globalGridOffset = 0;
  int insLat = 0;
  InterpQuality interp = InterpQuality::Linear;
  KeylockRatioSource ratioSource = KeylockRatioSource::Worklet;
  // ---- voices / WSOLA ----
  DeckVoice v[2];
  int cur = 0;
  std::unique_ptr<Wsola> ws[2];
  KRateTarget ratio;   // the worklet's "ratio" AudioParam
  KRateTarget keyK;    // key factor alone ("input" ratio mode)
  float ratioQ[2] = {1, 1};  // ratio of the current quantum, per voice
  // ---- roll (engine.js _roll) ----
  bool rollOn = false;        // engine.js _roll != null
  bool rollSounding = false;  // its source still plays (fading out after stopRoll)
  int rollStopLeft = 0;       // frames until the roll source stops
  double rollStart = 0, rollEnd = 0, rollBeats = 0, rollMix = -1;
  double rollRp = 0;
  ARateTarget mainGain;  // engine.js srcGain
  ARateTarget rollGain;  // engine.js rollGain
  // ---- stems ----
  bool stemsOn = false;
  ARateTarget stemGain[kNumStems];
  // ---- scratch voice ----
  bool scratching = false;
  bool scSounding = false;
  double scX = 0, scV = 0;              // follower position (track s) and speed (s/s)
  double scT = 0, scTv = 0;             // last target and its velocity
  SampleTime scTAt = 0;                 // sample time the last target is due (its `at` on the heard timeline)
  double scTSpan = 0;                   // extrapolation span of the last target (s)
  double scLead = -1;                   // largest command lead (presentTime - at) of the gesture, -1 unknown
  double scLastT = 0;
  EngineTime scLastAt = 0;
  bool scHasLast = false;
  FadeRamp scFade;
  bool scDying = false;
  // ---- spin voice (engine.js spinSound, see spinNext()) ----
  bool spinOn = false;    // V.BRAKE / BACKSPIN sound running (engine.js _spinSrc)
  bool spinBack = false;
  int64_t spinBase = 0;   // track frame of slice frame 0 (engine.js i0, or i0 + n - 1 for the reversed slice)
  int64_t spinLen = 0;    // slice frames (engine.js n)
  double spinX = 0;       // read position in the slice (Chromium's virtual_read_index)
  double spinInc = 0;     // its increment during the current quantum of the spin
  int64_t spinFrame = 0;  // output frames since the spin started (its k-rate grid starts there)
  float spinV1 = 1.0f, spinV2 = 0.001f;  // playbackRate ramp end points (AudioParam values: float)
  float spinK = 0.0f;     // float(1 / dur), as Chromium's linear ramp computes it
  double spinDur = 0, spinFadeAt = 0, spinEnd = 0;  // seconds after the start
  float spinG = 1;        // gain of the last frame (engine.js g.gain.value)
  bool spinStopping = false;
  int64_t spinStopAt = 0, spinStopLen = 1;  // stopSpinSound: spin frame of the stop, 20 ms in frames
  float spinStopG = 1;
  // ---- end latch / segments ----
  uint32_t endedCount = 0;
  EngineTime endedAt = kNaN;
  SampleTime endedAtSample = kNaN;
  int64_t endHeardG = -1;  // deck frame at which the natural end is heard (pending latch)
  uint32_t seg = 0;
  EngineTime anchorT = 0;
  double anchorPos = 0;
  int transientLeft = 0;  // frames during which the transport is not settled
  // ---- time ----
  int64_t gNext = 0;           // next deck output frame
  EngineTime nextPresent = 0;  // its presentTime
  SampleTime nextSample = 0;   // its sample time
  int qPhase = 0;              // frames into the deck's current 128-frame quantum
  // ---- content ring (heard mapping, sized for the insert latency) ----
  std::unique_ptr<double[]> cPos;
  std::unique_ptr<float[]> cRate;
  int64_t cMask = 0;
  // ---- scratch buffers (one quantum at most per pass) ----
  float gMain[kQ], gRoll[kQ], gStem[kNumStems][kQ];
  float rollL[kQ], rollR[kQ];
  float xL[kQ], xR[kQ], yL[kQ], yR[kQ], tL[kQ], tR[kQ];
  double posTmp[kQ];
  Content cTmp[kQ];
  float histL[Wsola::kPrimeFrames], histR[Wsola::kPrimeFrames];
  float stemL[Wsola::kPrimeFrames], stemR[Wsola::kPrimeFrames];  // one stem's prime history
  double histPos[Wsola::kPrimeFrames];
  float tailL[kTailMax], tailR[kTailMax];
  int tailLen = 0, tailPos = 0;

  Impl() {
    ws[0] = std::make_unique<Wsola>();
    ws[1] = std::make_unique<Wsola>();
    for (auto& vc : v) {
      vc.srcPos.reset(new double[kSrcRing]);
      vc.srcRate.reset(new float[kSrcRing]);
      std::fill(vc.srcPos.get(), vc.srcPos.get() + kSrcRing, 0.0);
      std::fill(vc.srcRate.get(), vc.srcRate.get() + kSrcRing, 0.0f);
    }
    mainGain.reset(1);
    rollGain.reset(0);
    for (auto& s : stemGain) s.reset(1);
    ratio.reset(1, fs, kRatioTau);
    keyK.reset(1, fs, kRatioTau);
  }

  // ---- small helpers ------------------------------------------------------------
  double duration() const noexcept { return track ? track->duration() : 0.0; }
  double fileRate() const noexcept { return track && track->sampleRate > 0 ? track->sampleRate : fs; }
  // Chromium ComputePlaybackRate: (bufferRate / contextRate) * float(playbackRate)
  double inc() const noexcept { return (fileRate() / fs) * static_cast<double>(tempoF); }
  int framesOf(double sec) const noexcept { return std::max(1, static_cast<int>(sec * fs + 0.5)); }
  EngineTime presentOf(int64_t g) const noexcept { return nextPresent + static_cast<double>(g - gNext) / fs; }
  SampleTime sampleOf(int64_t g) const noexcept { return nextSample + static_cast<double>(g - gNext) / fs; }
  double insSec() const noexcept { return insLat / fs; }
  bool stemsUsable() const noexcept { return stemsOn && stems != nullptr; }
  LoopFrames loopFrames() const noexcept {
    return track ? LoopFrames::of(*track, looping, loopStart, loopEnd) : LoopFrames();
  }

  void newSegment(EngineTime at, double pos) noexcept {
    seg++;
    anchorT = at;
    anchorPos = pos;
  }
  void syncClock(const BlockClock& clk) noexcept {
    // Commands carry the clock of the block they apply in: its first frame is gNext.
    nextPresent = clk.presentTime;
    nextSample = clk.sampleTime;
  }

  // ---- content (what deck frame g carries) ---------------------------------------
  Content extrapolate(const DeckVoice& vc, int64_t k) const noexcept {
    // position of input frame gNext + k (k >= 0) from the read pointer
    if (vc.finished) return {duration(), 0.0f};
    const double in = inc();
    double p = vc.rp + static_cast<double>(k) * in;
    const LoopFrames lf = loopFrames();
    if (lf.on && p >= lf.virtualEnd && lf.length > 0) p = lf.virtualEnd - lf.length + std::fmod(p - lf.virtualEnd, lf.length);
    if (!lf.on && p >= static_cast<double>(track->frames)) return {duration(), 0.0f};
    return {p / fileRate(), tempoF};
  }
  Content predict(int64_t g) const noexcept {
    if (!track) return {0.0, 0.0f};
    if (scSounding && scratching) return {scX + scV * static_cast<double>(g - gNext) / fs, static_cast<float>(scV)};
    if (!playing) return {pausedPos, 0.0f};
    if (armed) return {armPos, 0.0f};
    const DeckVoice& vc = v[cur];
    if (!vc.active) return {pausedPos, 0.0f};
    if (vc.routed) {
      const int64_t i = g - LAT;
      if (i < gNext) {
        double p = vc.srcPos[i & kSrcMask];
        float r = vc.srcRate[i & kSrcMask];
        if (p >= duration()) {
          p = duration();
          r = 0;
        }
        return {p, r};
      }
      return extrapolate(vc, i - gNext);
    }
    return extrapolate(vc, g - gNext);
  }
  Content contentAt(int64_t g) const noexcept {
    if (g >= gNext || !cPos) return predict(g);
    const int64_t cap = cMask;  // ring holds the last cMask frames
    if (g < gNext - cap) g = gNext - cap;
    return {cPos[g & cMask], cRate[g & cMask]};
  }
  // Heard position at deck frame G (fractional): content of frame G - insLat.
  // A time on a frame boundary that rounding put a hair before it counts as
  // that frame: the core asks positionAt(presentTime + L / rate) for the plugin
  // transport, and (p + lead) - p is not exactly lead, so after a jump the
  // floor read the frame before it, the PRE-jump position (2 jumps in 3 with a
  // latent plugin, campaign_transport_position_right_after_a_jump). 1e-4 frame
  // covers that rounding for engine times up to ~97 days at 192 kHz (the
  // engine clock starts with the process) and is 0.5 ns at 192 kHz.
  Content heardAt(double G) const noexcept {
    const double c = G - insLat;
    double fl = std::floor(c);
    if (c - fl > 1.0 - 1e-4) fl += 1.0;
    const Content k = contentAt(static_cast<int64_t>(fl));
    return {k.pos + (c - fl) * static_cast<double>(k.rate) / fs, k.rate};
  }
  double clampPos(double p) const noexcept { return clampd(p, -kPreRollSec, duration()); }
  double contentNext() const noexcept { return clampPos(predict(gNext).pos); }

  // ---- input of a voice ----------------------------------------------------------
  // Main read (track or stems) for n frames from the voice's read pointer.
  void readMain(DeckVoice& vc, int n, float* oL, float* oR, double* pos) noexcept {
    const double in = inc();
    const LoopFrames lf = loopFrames();
    if (!vc.stems || !stems) {
      deckimpl::readChromium(*track, vc.rp, in, lf, n, oL, oR, pos, vc.finished, interp);
      return;
    }
    // Stems: the same positions in every stem, each with its gain (engine.js:
    // one source per stem, stemGains[s] -> srcGain). The end follows the track.
    std::memset(oL, 0, sizeof(float) * static_cast<size_t>(n));
    std::memset(oR, 0, sizeof(float) * static_cast<size_t>(n));
    if (vc.finished) {
      if (pos) {
        for (int i = 0; i < n; i++) pos[i] = vc.rp;
      }
      return;
    }
    const double rp0 = vc.rp;
    bool fin = vc.finished;
    bool any = false;
    for (int s = 0; s < kNumStems; s++) {
      const TrackBuffer* tb = stems->stems[s];
      if (!tb || tb->frames <= 0) continue;
      const double k = tb->sampleRate == track->sampleRate ? 1.0 : static_cast<double>(tb->sampleRate) / fileRate();
      double p = rp0 * k;
      bool f = false;
      const LoopFrames slf = LoopFrames::of(*tb, looping, loopStart, loopEnd);
      deckimpl::readChromium(*tb, p, in * k, slf, n, tL, tR, nullptr, f, interp);
      const float* g = gStem[s];
      for (int i = 0; i < n; i++) {
        oL[i] += tL[i] * g[i];
        oR[i] += tR[i] * g[i];
      }
      any = true;
    }
    (void)any;
    // the read pointer itself follows the track (positions, loop, end)
    float dl[kQ], dr[kQ];
    deckimpl::readChromium(*track, vc.rp, in, lf, n, dl, dr, pos, fin, InterpQuality::Linear);
    if (fin && !vc.finished) {
      vc.finished = true;
      // frames from the end on are silent (the track's end)
      int k0 = 0;
      while (k0 < n && pos && pos[k0] < static_cast<double>(track->frames)) k0++;
      for (int i = k0; i < n; i++) oL[i] = oR[i] = 0;
    }
  }

  // Voice input for n frames: main x mainGain + roll x rollGain.
  void voiceInput(DeckVoice& vc, int n, bool rollActive, bool gainsMove) noexcept {
    const bool wasFinished = vc.finished;
    readMain(vc, n, xL, xR, posTmp);
    if (!wasFinished && vc.finished && !vc.endKnown) {
      int k = 0;
      while (k < n && posTmp[k] < static_cast<double>(track->frames)) k++;
      vc.finishInput = gNext + k;
      vc.endKnown = true;
    }
    if (gainsMove || mainGain.value() != 1.0f) {
      for (int i = 0; i < n; i++) {
        xL[i] *= gMain[i];
        xR[i] *= gMain[i];
      }
    }
    if (rollActive) {
      for (int i = 0; i < n; i++) {
        xL[i] += rollL[i] * gRoll[i];
        xR[i] += rollR[i] * gRoll[i];
      }
    }
  }

  // ---- priming (SPEC.md §9.4) --------------------------------------------------------
  // Frames at the increasing positions pos[0..n) (no wrap): one range check,
  // then a tight loop when every frame read lies in ready chunks away from
  // the buffer end; Chromium's per-frame rules otherwise.
  static void readPositions(const TrackBuffer& tb, const LoopFrames& lf, const double* pos, int n, float* oL,
                            float* oR) noexcept {
    if (n <= 0) return;
    const int64_t a = static_cast<int64_t>(std::floor(pos[0]));
    const int64_t b = static_cast<int64_t>(std::floor(pos[n - 1])) + 1;
    bool fast = a >= 0 && b < tb.frames - 1;
    for (int64_t c = fast ? tb.chunkOf(a) : 0; fast && c <= tb.chunkOf(b); c++) fast = tb.chunkReady(c);
    if (!fast) {
      for (int j = 0; j < n; j++) deckimpl::sampleAt(tb, pos[j], lf, oL[j], oR[j]);
      return;
    }
    for (int j = 0; j < n; j++) {
      const double q = pos[j];
      const int64_t i = static_cast<int64_t>(q);
      const double f = q - static_cast<double>(i);
      float l1, r1, l2, r2;
      tb.frame(i, l1, r1);
      tb.frame(i + 1, l2, r2);
      oL[j] = static_cast<float>((1.0 - f) * l1 + f * l2);
      oR[j] = static_cast<float>((1.0 - f) * r1 + f * r2);
    }
  }

  // Main source (track, or the stems with their current gains) at the
  // history positions [j0, j1); `accumulated`: the Chromium read from
  // histPos[j0] (wraps, end) instead of the given positions.
  void historyMain(const DeckVoice& vc, int j0, int j1, bool accumulated, double& p, bool& fin) noexcept {
    const int n = j1 - j0;
    const LoopFrames lf = loopFrames();
    const double in = inc();
    if (!vc.stems || !stems) {
      if (accumulated) deckimpl::readChromium(*track, p, in, lf, n, histL + j0, histR + j0, histPos + j0, fin, interp);
      else readPositions(*track, lf, histPos + j0, n, histL + j0, histR + j0);
      return;
    }
    if (accumulated) {
      // the positions follow the track (loop, end); the samples are the stems'
      float dl[kQ], dr[kQ];
      for (int j = j0; j < j1; j += kQ) {
        const int m = std::min(kQ, j1 - j);
        deckimpl::readChromium(*track, p, in, lf, m, dl, dr, histPos + j, fin, InterpQuality::Linear);
      }
    }
    std::fill(histL + j0, histL + j1, 0.0f);
    std::fill(histR + j0, histR + j1, 0.0f);
    const double len = static_cast<double>(track->frames);
    auto silent = [&](int j) { return accumulated && histPos[j] >= len && !lf.on; };  // past the end
    for (int s = 0; s < kNumStems; s++) {
      const TrackBuffer* tb = stems->stems[s];
      if (!tb || tb->frames <= 0) continue;
      const double k = tb->sampleRate == track->sampleRate ? 1.0 : static_cast<double>(tb->sampleRate) / fileRate();
      const LoopFrames slf = LoopFrames::of(*tb, looping, loopStart, loopEnd);
      const float g = stemGain[s].value();
      if (k == 1.0) {
        // runs of increasing positions (a loop wrap or the end starts a new run), each read by
        // readPositions: one range check, then the tight loop where the frames are ready (the same
        // arithmetic as sampleAt). Per-frame sampleAt made 4 keylocked primes with 3 stems cost 14 %
        // of a 128-frame period instead of 5 %.
        int j = j0;
        while (j < j1) {
          if (silent(j)) {
            j++;
            continue;
          }
          int e = j + 1;
          while (e < j1 && histPos[e] >= histPos[e - 1] && !silent(e)) e++;
          readPositions(*tb, slf, histPos + j, e - j, stemL + j, stemR + j);
          for (int q = j; q < e; q++) {
            histL[q] += stemL[q] * g;
            histR[q] += stemR[q] * g;
          }
          j = e;
        }
        continue;
      }
      for (int j = j0; j < j1; j++) {
        if (silent(j)) continue;
        float a, b;
        deckimpl::sampleAt(*tb, histPos[j] * k, slf, a, b);
        histL[j] += a * g;
        histR[j] += b * g;
      }
    }
  }

  // Prime voice vi so that its first output (deck frame gNext) carries the
  // track at source frame tf (the read pointer then continues at the input
  // frame gNext, LAT frames ahead).
  void primeVoice(int vi, double tf) noexcept {
    DeckVoice& vc = v[vi];
    const int H = Wsola::kPrimeFrames;
    const int A = H - LAT;  // history index of the frame heard first
    const double in = inc();
    const double len = static_cast<double>(track->frames);
    // before tf: virtual positions (the read never happened)
    for (int j = 0; j < A; j++) histPos[j] = tf - static_cast<double>(A - j) * in;
    double p = 0;
    bool fin = false;
    historyMain(vc, 0, A, false, p, fin);
    // from tf: accumulated like Chromium (loop wraps, end of buffer)
    p = tf;
    if (!looping && tf >= len) fin = true;
    historyMain(vc, A, H, true, p, fin);
    int finJ = -1;
    if (fin) {
      finJ = A;
      while (finJ < H && histPos[finJ] < len) finJ++;
    }
    const float m = mainGain.value();
    if (m != 1.0f) {
      for (int j = 0; j < H; j++) {
        histL[j] *= m;
        histR[j] *= m;
      }
    }
    if (rollSounding) {
      const float rg = rollGain.value();
      const LoopFrames rl = LoopFrames::of(*track, true, rollStart, rollEnd);
      for (int j = 0; j < H; j++) {
        double qq = rollRp - static_cast<double>(H - j) * in;
        if (rl.length > 0 && qq < rl.start) qq = rl.virtualEnd - std::fmod(rl.start - qq, rl.length);
        float a, b;
        deckimpl::sampleAt(*track, qq, rl, a, b);
        histL[j] += a * rg;
        histR[j] += b * rg;
      }
    }
    ws[vi]->prime(histL, histR, ratioQ[vi]);
    // the input frames gNext - LAT .. gNext - 1 of this voice are the history's A..H-1
    for (int j = A; j < H; j++) {
      const int64_t gi = gNext - LAT + (j - A);
      vc.srcPos[gi & kSrcMask] = histPos[j] / fileRate();
      vc.srcRate[gi & kSrcMask] = histPos[j] >= len && !looping ? 0.0f : tempoF;
    }
    vc.rp = fin ? len : p;
    vc.finished = fin;
    vc.endKnown = fin;
    if (fin) vc.finishInput = gNext - LAT + (finJ - A);
  }

  // Starts a voice at position posSec (rounded to a frame, like Chromium's
  // start offset). fadeIn = 0: full level at once. Returns the exact start.
  double startVoice(double posSec, bool routed, bool useStems, int fadeIn) noexcept {
    const int ni = 1 - cur;
    DeckVoice& nv = v[ni];
    const double tf = std::round(posSec * fileRate());
    nv.active = true;
    nv.routed = routed;
    nv.stems = useStems;
    nv.finished = false;
    nv.endKnown = false;
    nv.dying = false;
    if (fadeIn > 0) {
      nv.gain.set(0);
      nv.gain.rampTo(1, fadeIn);
    } else {
      nv.gain.set(1);
    }
    ratioQ[ni] = ratioQ[cur];
    if (routed) {
      primeVoice(ni, tf);
    } else {
      nv.rp = tf;
      // a start at or past the end of a non-looping buffer finishes at once
      if (!looping && tf >= static_cast<double>(track->frames)) {
        nv.finished = true;
        nv.endKnown = true;
        nv.finishInput = gNext;
      }
    }
    cur = ni;
    return tf / fileRate();
  }
  void fadeOut(DeckVoice& vc, int frames) noexcept {
    if (!vc.active) return;
    vc.dying = true;
    vc.gain.rampTo(0, frames);
  }
  // A jump / route / source change while playing: the current voice fades out
  // and a new one fades in (the voice still fading from a previous change is dropped).
  double crossfadeTo(double posSec, bool routed, bool useStems, int frames) noexcept {
    DeckVoice& other = v[1 - cur];
    if (other.active) other.active = false;  // a third voice: the oldest one is cut
    fadeOut(v[cur], frames);
    const double s = startVoice(posSec, routed, useStems, frames);
    endHeardG = -1;
    transientLeft = frames + (routed ? Wsola::kHop : 0);
    return s;
  }

  // ---- armed start (SPEC.md §9.1) ----------------------------------------------------
  bool rangeReady(const TrackBuffer* tb, double lo, double hi) const noexcept {
    if (!tb || tb->frames <= 0) return true;
    const double last = static_cast<double>(tb->frames - 1);
    if (hi < 0 || lo > last) return true;
    const int64_t a = static_cast<int64_t>(std::max(0.0, std::floor(lo)));
    const int64_t b = static_cast<int64_t>(std::min(last, std::ceil(hi)));
    for (int64_t c = tb->chunkOf(a); c <= tb->chunkOf(b); c++) {
      if (!tb->chunkReady(c)) return false;
    }
    return true;
  }
  bool dataReady(double posSec, int blockFrames) const noexcept {
    if (!track) return true;
    const double in = inc();
    const double tf = std::round(posSec * fileRate());
    double lo = tf - 1;
    double hi = tf + (blockFrames + 2) * in + 2;
    if (routeWanted) {
      lo = tf - (Wsola::kPrimeFrames - LAT) * in - 2;
      hi = tf + (LAT + blockFrames + 2) * in + 2;
    }
    if (looping) {
      // inside a loop the reads wrap: the whole loop must be there
      const double ls = loopStart * fileRate(), le = loopEnd * fileRate();
      if (hi > le) {
        lo = std::min(lo, ls);
        hi = std::max(hi, le) + 2;
      }
    }
    if (stemsUsable()) {
      for (const TrackBuffer* tb : stems->stems) {
        if (tb && !rangeReady(tb, lo, hi)) return false;
      }
      return true;
    }
    return rangeReady(track, lo, hi);
  }
  // Starts an armed play when its data is ready (or the 250 ms cap passed).
  void tryStart(EngineTime present, SampleTime sample, int blockFrames) noexcept {
    if (!armed || !track) return;
    const double waited = sample - armSince;
    if (!dataReady(armPos, blockFrames) && waited < kArmedStartMaxSec) return;
    armed = false;
    startWaitMs = static_cast<float>(std::max(0.0, waited) * 1000.0);
    // the new voice takes the other slot: the current one (still fading out
    // after a pause just before) keeps fading; an older one in that slot is cut
    DeckVoice& other = v[1 - cur];
    if (other.active) other.active = false;
    const double s = startVoice(armPos, routeWanted, stemsUsable(), 0);
    newSegment(present + insSec(), s);
    endHeardG = -1;
    transientLeft = routeWanted ? Wsola::kHop : 0;
  }

  // ---- pitch (engine.js _applyPitch) ----------------------------------------------------
  void applyPitch() noexcept {
    const bool want = keylock || keyShift != 0;
    if (want != routeWanted) switchRoute(want);
    pitchTargets(false);
  }
  // setTargetAtTime(want ? ratio : 1, now, 0.02) on the worklet's ratio (and the
  // key factor of the "input" A/B); `force`: a new event even for the same value.
  void pitchTargets(bool force) noexcept {
    const double key = std::pow(2.0, keyShift / 12.0);
    const double lock = keylock && tempo > 0 ? 1.0 / tempo : 1.0;
    const double r = clampd(key * lock, Wsola::kRatioMin, Wsola::kRatioMax);
    const bool want = keylock || keyShift != 0;
    const float target = static_cast<float>(want ? r : 1.0);
    if (force || target != ratio.target()) ratio.setTarget(target, nextSample);
    const float keyTarget = static_cast<float>(want ? key : 1.0);
    if (force || keyTarget != keyK.target()) keyK.setTarget(keyTarget, nextSample);
  }
  void switchRoute(bool on) noexcept {
    routeWanted = on;
    if (!playing || armed || !track || !v[cur].active || v[cur].dying || v[cur].finished) return;
    // engine.js _switchRoute without its 30 ms lead: both paths aligned on the
    // current content position, 6 ms crossfade (no position discontinuity).
    const double pos = contentNext();
    crossfadeTo(pos, on, v[cur].stems, framesOf(kRouteFadeSec));
  }

  // ---- the quantum's ratio (k-rate, deck's own grid) ------------------------------------
  void quantumStart(SampleTime qTime) noexcept {
    const float r = ratio.step(qTime);
    const float k = keyK.step(qTime);
    for (int i = 0; i < 2; i++) {
      if (ratioSource == KeylockRatioSource::InputTempo && keylock && routeWanted) {
        // the tempo that produced the input a grain placed now reads: its
        // centre is input frame G - LAT + N/2 (read already)
        const float tin = v[i].active ? v[i].srcRate[(gNext - LAT + Wsola::kHop) & kSrcMask] : tempoF;
        const double t = tin > 0 ? tin : tempoF;
        ratioQ[i] = static_cast<float>(clampd(static_cast<double>(k) / t, Wsola::kRatioMin, Wsola::kRatioMax));
      } else {
        ratioQ[i] = r;
      }
    }
  }

  // ---- tail (fade-out pre-rendered before media are detached) -------------------------
  // Renders the next kStopFade of every sounding voice into the tail buffer
  // (fading to 0) and silences them: used when the buffers they read are
  // about to be returned to the core.
  enum TailWhat : int { kTailVoices = 1, kTailScratch = 2, kTailSpin = 4, kTailAll = 7 };
  // raised-cosine fade of the tail: 1 -> 0 over n frames (frame i of n)
  static float tailGain(int i, int n) noexcept {
    return static_cast<float>(0.5 * (1.0 + std::cos(kPi * static_cast<double>(i + 1) / static_cast<double>(n))));
  }
  void renderTailNow(int what = kTailAll) noexcept {
    if (!track || !prepared) return;
    const int n = std::min(kTailMax, framesOf(kStopFadeSec));
    bool any = false;
    float acc[kTailMax];
    float accR[kTailMax];
    std::memset(acc, 0, sizeof(float) * static_cast<size_t>(n));
    std::memset(accR, 0, sizeof(float) * static_cast<size_t>(n));
    // leftover of a previous tail
    for (int i = 0; i < n && tailPos + i < tailLen; i++) {
      acc[i] += tailL[tailPos + i];
      accR[i] += tailR[tailPos + i];
      any = true;
    }
    if (!(what & kTailVoices)) {
      // only the scratch / spin voices
      for (int i = 0; i < n; i++) {
        const float f = tailGain(i, n);
        float l, r;
        if ((what & kTailScratch) && scSounding) {
          const double sp = std::fabs(scV);
          const float sg = static_cast<float>(clampd((sp - kScratchSilent) / (kScratchFull - kScratchSilent), 0, 1));
          deckimpl::kernelRead(*track, InterpQuality::Linear, scX * fileRate(), sp, l, r);
          acc[i] += l * sg * scFade.value() * f;
          accR[i] += r * sg * scFade.value() * f;
          scX += scV / fs;
        }
        if ((what & kTailSpin) && spinOn) {
          if (spinNext(l, r)) {
            acc[i] += l * f;
            accR[i] += r * f;
          } else {
            spinOn = false;
          }
        }
      }
      if (what & kTailScratch) scSounding = false;
      if (what & kTailSpin) spinOn = false;
      std::memcpy(tailL, acc, sizeof(float) * static_cast<size_t>(n));
      std::memcpy(tailR, accR, sizeof(float) * static_cast<size_t>(n));
      tailLen = n;
      tailPos = 0;
      return;
    }
    // the shared gains as they are now (constant over the tail)
    for (int i = 0; i < kQ; i++) {
      gMain[i] = mainGain.value();
      gRoll[i] = rollGain.value();
      for (int s = 0; s < kNumStems; s++) gStem[s][i] = stemGain[s].value();
    }
    for (int vi = 0; vi < 2; vi++) {
      DeckVoice& vc = v[vi];
      if (!vc.active) continue;
      const float g0 = vc.gain.value();
      int done = 0;
      while (done < n) {
        const int m = std::min(kQ, n - done);
        voiceInput(vc, m, false, false);
        if (vc.routed) ws[vi]->process(xL, xR, yL, yR, m, ratioQ[vi]);
        else {
          std::memcpy(yL, xL, sizeof(float) * static_cast<size_t>(m));
          std::memcpy(yR, xR, sizeof(float) * static_cast<size_t>(m));
        }
        for (int i = 0; i < m; i++) {
          const float f = g0 * tailGain(done + i, n);
          acc[done + i] += yL[i] * f;
          accR[done + i] += yR[i] * f;
        }
        done += m;
      }
      vc.active = false;
      any = true;
    }
    if (scSounding || spinOn) {
      for (int i = 0; i < n; i++) {
        const float f = tailGain(i, n);
        float l, r;
        if (scSounding) {
          const double sp = std::fabs(scV);
          const float sg = static_cast<float>(clampd((sp - kScratchSilent) / (kScratchFull - kScratchSilent), 0, 1));
          deckimpl::kernelRead(*track, InterpQuality::Linear, scX * fileRate(), sp, l, r);
          acc[i] += l * sg * scFade.value() * f;
          accR[i] += r * sg * scFade.value() * f;
          scX += scV / fs;
        }
        if (spinOn) {
          if (spinNext(l, r)) {
            acc[i] += l * f;
            accR[i] += r * f;
          } else {
            spinOn = false;
          }
        }
      }
      scSounding = false;
      spinOn = false;
      any = true;
    }
    if (rollSounding) rollSounding = false;
    if (!any) return;
    std::memcpy(tailL, acc, sizeof(float) * static_cast<size_t>(n));
    std::memcpy(tailR, accR, sizeof(float) * static_cast<size_t>(n));
    tailLen = n;
    tailPos = 0;
  }

  // ---- scratch voice ------------------------------------------------------------------
  // Target path: the last Move target extrapolated with its velocity for at
  // most two UI intervals, then held (so a still hand means a still platter).
  // Two, not one: app.js sends a Move per animation frame, and a dropped frame
  // (a 33 ms gap, common while the UI is busy) used to hold the target for
  // 17 ms, which nearly stopped the platter (1x fell to 0.05x) before the next
  // Move; the price is a longer coast when Moves stop abruptly while moving
  // (two intervals of travel instead of one; app.js's jog smoother brings its
  // Moves to rest gradually). Before its due time (a Move applied earlier than
  // the gesture's largest lead) the same line is followed backward.
  void scratchTarget(SampleTime t, double& T, double& V) const noexcept {
    const double dt = t - scTAt;
    const double horizon = 2.0 * scTSpan;
    if (dt < horizon) {
      T = scT + scTv * dt;
      V = scTv;
    } else {
      T = scT + scTv * horizon;
      V = 0;
    }
  }

  // Content of the frames g0 .. g0+n-1 just rendered by the transport voices
  // (the current voice's input history; the stopped / armed position otherwise).
  void contentOfPass(int64_t g0, int n) noexcept {
    const DeckVoice& vc = v[cur];
    if (!track || !playing || armed || !vc.active) {
      const Content c = !track ? Content{0.0, 0.0f}
                               : (armed ? Content{armPos, 0.0f}
                                        : (playing ? Content{duration(), 0.0f} : Content{pausedPos, 0.0f}));
      for (int i = 0; i < n; i++) cTmp[i] = c;
      return;
    }
    const int64_t lag = vc.routed ? LAT : 0;
    for (int i = 0; i < n; i++) {
      const int64_t gi = g0 + i - lag;
      cTmp[i] = {vc.srcPos[gi & kSrcMask], vc.srcRate[gi & kSrcMask]};
    }
  }

  // ---- spin voice (SPEC.md §9.6) ---------------------------------------------------------------
  // engine.js spinSound plays a COPY of a slice of the track (reversed for the backspin) through an
  // AudioBufferSourceNode whose playbackRate ramps linearly from v0 to 0.001, into a gain that holds 1 and
  // fades linearly over the last 40 ms; stopSpinSound fades linearly to 0 over 20 ms from the current gain.
  // Reproduced as Chromium renders it (null-tested on goldens/source/spin_*):
  //  - the slice is addressed in place: slice frame j = track frame base + j (base - j reversed), 0 outside
  //    the track (engine.js copies `src[k] || 0`);
  //  - playbackRate is k-rate: one value per 128-frame quantum, from the spin's start (spinSound runs between
  //    two quanta), evaluated like Chromium's linear ramp, x = float(t * float(1 / dur)), v = v1 + x * (v2 - v1)
  //    in float, v2 once the ramp is over;
  //  - the read follows Chromium's rules: accumulated position, linear interpolation in double, extrapolation
  //    from the last two frames, silence once past the end of the slice.
  // Writes the next frame (gain applied); false once the voice has ended.
  bool spinNext(float& l, float& r) noexcept {
    const double t = static_cast<double>(spinFrame) / fs;
    if (t >= spinEnd) return false;  // s.stop(now + dur + 0.05): the gain is 0 by then
    if ((spinFrame & (kQ - 1)) == 0) {
      float rate = spinV2;
      if (t < spinDur) {
        const float x = static_cast<float>(t * static_cast<double>(spinK));
        rate = spinV1 + x * (spinV2 - spinV1);
      }
      spinInc = (fileRate() / fs) * static_cast<double>(rate);
    }
    float g;
    if (spinStopping) {
      const int64_t k = spinFrame - spinStopAt;
      if (k >= spinStopLen) return false;
      g = static_cast<float>(static_cast<double>(spinStopG) * (1.0 - static_cast<double>(k) / static_cast<double>(spinStopLen)));
    } else {
      g = t < spinFadeAt ? 1.0f
                         : static_cast<float>(std::max(0.0, 1.0 - (t - spinFadeAt) / std::max(1e-9, spinDur - spinFadeAt)));
    }
    spinG = g;
    const double p = spinX;
    if (!(p < static_cast<double>(spinLen))) return false;  // the source has finished
    const double fi = std::floor(p);
    int64_t i = static_cast<int64_t>(fi);
    double f = p - fi;
    int64_t i2 = i + 1;
    if (i2 >= spinLen) {
      if (spinLen >= 2) {
        i = spinLen - 2;
        i2 = spinLen - 1;
        f = p - static_cast<double>(spinLen - 2);
      } else {
        i2 = i;
      }
    }
    float s1l, s1r, s2l, s2r;
    if (interp == InterpQuality::Linear) {
      deckimpl::fetch(*track, spinBack ? spinBase - i : spinBase + i, s1l, s1r);
      deckimpl::fetch(*track, spinBack ? spinBase - i2 : spinBase + i2, s2l, s2r);
      l = static_cast<float>((1.0 - f) * s1l + f * s2l) * g;
      r = static_cast<float>((1.0 - f) * s1r + f * s2r) * g;
    } else {
      // dev A/B kernels at the same track position
      deckimpl::kernelRead(*track, interp, spinBack ? static_cast<double>(spinBase) - p : static_cast<double>(spinBase) + p,
                           spinInc, s1l, s1r);
      l = s1l * g;
      r = s1r * g;
    }
    spinX = p + spinInc;
    spinFrame++;
    return true;
  }

  // ---- render one pass (n <= frames left in the quantum) ---------------------------------
  void renderPass(float* outL, float* outR, int n) noexcept {
    const int64_t g0 = gNext;
    std::memset(outL, 0, sizeof(float) * static_cast<size_t>(n));
    std::memset(outR, 0, sizeof(float) * static_cast<size_t>(n));
    const bool haveTrack = track != nullptr;
    // shared a-rate gains
    const bool gainsMove = mainGain.moving() || rollGain.moving();
    mainGain.render(gMain, n);
    rollGain.render(gRoll, n);
    for (int s = 0; s < kNumStems; s++) stemGain[s].render(gStem[s], n);
    // roll pointer (shared by both voices' inputs)
    const bool rollActive = haveTrack && rollSounding;
    if (rollActive) {
      bool fin = false;
      const LoopFrames rl = LoopFrames::of(*track, true, rollStart, rollEnd);
      deckimpl::readChromium(*track, rollRp, inc(), rl, n, rollL, rollR, nullptr, fin, interp);
      if (rollStopLeft > 0) {
        rollStopLeft -= n;
        if (rollStopLeft <= 0) {
          rollSounding = false;
          rollStopLeft = 0;
        }
      }
    }
    // transport voices
    for (int vi = 0; vi < 2 && haveTrack; vi++) {
      DeckVoice& vc = v[vi];
      if (!vc.active) continue;
      voiceInput(vc, n, rollActive, gainsMove);
      for (int i = 0; i < n; i++) {
        const int64_t gi = g0 + i;
        vc.srcPos[gi & kSrcMask] = posTmp[i] / fileRate();
        vc.srcRate[gi & kSrcMask] = vc.finished && posTmp[i] >= static_cast<double>(track->frames) ? 0.0f : tempoF;
      }
      const float* yl = xL;
      const float* yr = xR;
      if (vc.routed) {
        ws[vi]->process(xL, xR, yL, yR, n, ratioQ[vi]);
        yl = yL;
        yr = yR;
      }
      if (!vc.gain.moving() && vc.gain.value() == 1.0f) {
        for (int i = 0; i < n; i++) {
          outL[i] += yl[i];
          outR[i] += yr[i];
        }
      } else {
        for (int i = 0; i < n; i++) {
          const float g = vc.gain.next();
          outL[i] += yl[i] * g;
          outR[i] += yr[i] * g;
        }
        if (vc.dying && !vc.gain.moving() && vc.gain.value() == 0.0f) vc.active = false;
      }
    }
    // content of these frames (from what the voices fed; the scratch voice overrides it)
    contentOfPass(g0, n);
    // scratch voice (bypasses the transposer, engine.js scrubIn)
    if (haveTrack && scSounding) {
      const double fr = fileRate();
      for (int i = 0; i < n; i++) {
        const SampleTime t = nextSample + static_cast<double>(i) / fs;
        double T, V;
        scratchTarget(t, T, V);
        // critically damped follower with velocity feed-forward
        const double a = kScratchOmega * kScratchOmega * (T - scX) + 2.0 * kScratchOmega * (V - scV);
        scV = clampd(scV + a / fs, -kScratchMaxSpeed, kScratchMaxSpeed);
        if (std::fabs(scV) < 1e-12 && std::fabs(T - scX) < 1e-12) scV = 0;  // at rest (no denormal tail)
        const double sp = std::fabs(scV);
        float l, r;
        deckimpl::kernelRead(*track, interp, scX * fr, sp, l, r);
        const float sg = static_cast<float>(clampd((sp - kScratchSilent) / (kScratchFull - kScratchSilent), 0, 1));
        const float f = scFade.next();
        outL[i] += l * sg * f;
        outR[i] += r * sg * f;
        if (scratching) cTmp[i] = {clampPos(scX), static_cast<float>(scV)};
        scX += scV / fs;
      }
      if (scDying && !scFade.moving() && scFade.value() == 0.0f) {
        scSounding = false;
        scDying = false;
      }
    }
    // spin voice (V.BRAKE / BACKSPIN, through the scratch input)
    if (haveTrack && spinOn) {
      for (int i = 0; i < n; i++) {
        float l, r;
        if (!spinNext(l, r)) {
          spinOn = false;
          break;
        }
        outL[i] += l;
        outR[i] += r;
      }
    }
    // pre-rendered tail
    if (tailPos < tailLen) {
      const int m = std::min(n, tailLen - tailPos);
      for (int i = 0; i < m; i++) {
        outL[i] += tailL[tailPos + i];
        outR[i] += tailR[tailPos + i];
      }
      tailPos += m;
    }
    // content ring
    if (cPos) {
      for (int i = 0; i < n; i++) {
        const int64_t gi = g0 + i;
        Content c = cTmp[i];
        if (c.pos > duration()) {
          c.pos = duration();
          c.rate = 0;
        }
        cPos[gi & cMask] = c.pos;
        cRate[gi & cMask] = c.rate;
      }
    }
    // natural end: the current voice passed the end of the buffer
    DeckVoice& cv = v[cur];
    if (playing && !armed && cv.active && cv.endKnown && endHeardG < 0 && !looping) {
      endHeardG = cv.finishInput + (cv.routed ? LAT : 0) + insLat;
    }
    if (endHeardG >= 0 && playing && endHeardG < g0 + n) {
      const int64_t e = std::max(endHeardG, g0);
      playing = false;
      armed = false;
      endedCount++;
      endedAt = presentOf(e);
      endedAtSample = sampleOf(e);
      pausedPos = duration();
      newSegment(endedAt, pausedPos);
      for (auto& vc : v) {
        if (vc.active && (vc.finished || vc.dying)) vc.active = false;
      }
      if (rollOn) {
        rollOn = false;
        mainGain.setTarget(1, kRollTau, fs);
        rollGain.setTarget(0, kRollTau, fs);
        rollStopLeft = framesOf(0.02);
      }
      endHeardG = -1;
    }
    if (transientLeft > 0) transientLeft = std::max(0, transientLeft - n);
    gNext += n;
    nextPresent += static_cast<double>(n) / fs;
    nextSample += static_cast<double>(n) / fs;
  }

  // ---- full render ---------------------------------------------------------------------
  void render(float* l, float* r, int frames, const BlockClock& clk) noexcept {
    syncClock(clk);
    if (!prepared) {
      std::memset(l, 0, sizeof(float) * static_cast<size_t>(frames));
      std::memset(r, 0, sizeof(float) * static_cast<size_t>(frames));
      gNext += frames;
      return;
    }
    if (armed) tryStart(clk.presentTime, clk.sampleTime, frames);
    int done = 0;
    while (done < frames) {
      if (qPhase == 0) quantumStart(nextSample);
      const int n = std::min(frames - done, kQ - qPhase);
      renderPass(l + done, r + done, n);
      done += n;
      qPhase = (qPhase + n) & (kQ - 1);
    }
  }
};

// =====================================================================================
// Deck
// =====================================================================================

Deck::Deck(int index) : index_(index), impl_(std::make_unique<Impl>()) {}
Deck::~Deck() = default;

void Deck::prepare(double deviceRate, int maxBlockFrames) {
  Impl& d = *impl_;
  const double oldFs = d.fs;
  const double pos = d.prepared ? d.contentNext() : d.pausedPos;
  d.fs = deviceRate > 0 ? deviceRate : 48000.0;
  d.maxBlock = std::max(1, std::min(maxBlockFrames, kMaxBlockFrames));
  // content ring: insert latency (<= 1 s) + two blocks + margin, power of 2
  const int64_t need = static_cast<int64_t>(std::ceil(kMaxInsertLatencySec * d.fs)) + 2 * kMaxBlockFrames + 1024;
  int64_t size = 1;
  while (size < need) size <<= 1;
  if (!d.cPos || d.cMask + 1 != size) {
    d.cPos.reset(new double[static_cast<size_t>(size)]);
    d.cRate.reset(new float[static_cast<size_t>(size)]);
    d.cMask = size - 1;
  }
  std::fill(d.cPos.get(), d.cPos.get() + size, d.playing ? pos : d.pausedPos);
  std::fill(d.cRate.get(), d.cRate.get() + size, 0.0f);
  // the smoothers keep their value and get the current targets again (the
  // control rate depends on the device rate)
  d.ratio.reset(d.ratio.value(), d.fs, kRatioTau);
  d.keyK.reset(d.keyK.value(), d.fs, kRatioTau);
  d.pitchTargets(true);
  d.qPhase = 0;
  d.insLat = std::min(d.insLat, static_cast<int>(kMaxInsertLatencySec * d.fs));
  // A running transport restarts on the new device at its position (armed).
  if (d.prepared && d.playing && !d.armed && oldFs > 0) {
    d.armPos = d.clampPos(pos);
    d.armed = true;
    d.armSince = -1e9;  // no wait: starts at the first render
  }
  for (auto& vc : d.v) vc.active = false;
  d.ws[0]->reset();
  d.ws[1]->reset();
  d.tailLen = d.tailPos = 0;
  d.prepared = true;
}

void Deck::resetForLoad() noexcept {
  Impl& d = *impl_;
  d.renderTailNow();  // 2 ms fade-out of whatever sounds, from the media still attached
  for (auto& vc : d.v) vc.active = false;
  d.rollOn = false;
  d.rollSounding = false;
  d.rollMix = -1;
  d.mainGain.jump(1);
  d.rollGain.jump(0);
  d.scratching = false;
  d.scSounding = false;
  d.spinOn = false;
  d.playing = false;
  d.armed = false;
  d.pausedPos = 0;
  d.cuePoint = 0;
  d.tempo = 1;
  d.tempoF = 1.0f;
  d.looping = false;
  d.loopBeats = kNaN;
  d.stemsOn = false;
  for (auto& g : d.stemGain) g.jump(1);
  d.keyShift = 0;
  d.applyPitch();  // keylock kept (engine.js loadTrack -> setKey(0))
  // The natural-end timestamp is kept (engine.js loadTrack leaves _endedAt;
  // only play() clears it): a deck that ended and got its next track within
  // 2 s still counts as "ended" for the auto-master handover.
  d.endHeardG = -1;
  d.startWaitMs = 0;
  d.transientLeft = 0;
  d.newSegment(d.nextPresent + d.insSec(), 0.0);
}

void Deck::clearLoopBounds() noexcept {
  Impl& d = *impl_;
  d.looping = false;
  d.loopStart = 0;
  d.loopEnd = 0;
}

void Deck::clearEnded() noexcept {
  Impl& d = *impl_;
  d.endedAt = kNaN;
  d.endedAtSample = kNaN;
}

const TrackBuffer* Deck::attachTrack(const TrackBuffer* tb) noexcept {
  Impl& d = *impl_;
  const TrackBuffer* old = d.track;
  // Same buffer again (a deck.load of the same loadId): the core acquired one
  // more PCM user for this attachment and releases the one returned, so the
  // buffer stays alive; nothing changes here.
  if (tb == old) return old;
  // (the core sends resetForLoad first; a swap under a playing deck restarts
  // at the position it had reached)
  const double here = old ? (d.playing && !d.armed ? d.contentNext() : (d.armed ? d.armPos : d.pausedPos)) : d.pausedPos;
  if (old) d.renderTailNow();
  for (auto& vc : d.v) vc.active = false;
  d.track = tb;
  d.pausedPos = here;
  if (!tb) {
    d.playing = false;
    d.armed = false;
    d.pausedPos = 0;
    d.rollOn = d.rollSounding = false;
    d.scratching = d.scSounding = false;
    d.spinOn = false;
  } else if (d.playing) {
    // a buffer swapped under a playing deck restarts at the same position (armed)
    d.armPos = d.clampPos(d.pausedPos);
    d.armed = true;
    d.armSince = d.nextSample;
  }
  d.pausedPos = d.clampPos(d.pausedPos);
  d.endHeardG = -1;
  d.newSegment(d.nextPresent + d.insSec(), d.pausedPos);
  return old;
}

const BeatGrid* Deck::attachGrid(const BeatGrid* g) noexcept {
  const BeatGrid* old = impl_->grid;
  impl_->grid = g;
  return old == g ? nullptr : old;
}

const StemSet* Deck::attachStems(const StemSet* s) noexcept {
  Impl& d = *impl_;
  const StemSet* old = d.stems;
  if (s == old) return nullptr;
  bool readingStems = false;
  for (auto& vc : d.v) readingStems = readingStems || (vc.active && vc.stems);
  if (readingStems) {
    // the old stems are about to be retired: fade out from them now, then
    // continue at the same position on the new source
    const double pos = d.contentNext();
    const bool wasPlaying = d.playing && !d.armed;
    d.renderTailNow();
    for (auto& vc : d.v) vc.active = false;
    d.stems = s;
    if (!s) d.stemsOn = false;
    if (wasPlaying && d.track) {
      d.startVoice(pos, d.routeWanted, d.stemsUsable(), d.framesOf(kStopFadeSec));
      d.transientLeft = d.framesOf(kStopFadeSec) + (d.routeWanted ? Wsola::kHop : 0);
    }
    return old;
  }
  d.stems = s;
  if (!s) d.stemsOn = false;
  return old;
}

void Deck::setGlobalGridOffset(double sec) noexcept { impl_->globalGridOffset = std::isfinite(sec) ? sec : 0.0; }

void Deck::setInsertLatency(int frames) noexcept {
  Impl& d = *impl_;
  const int cap = static_cast<int>(kMaxInsertLatencySec * d.fs);
  const int nl = clampv(frames, 0, cap);
  if (nl == d.insLat) return;
  const int old = d.insLat;
  if (d.playing && !d.armed && d.track && d.v[d.cur].active && !d.v[d.cur].finished) {
    // engine.js setInsert: the read-ahead grows by the new latency; the heard
    // timeline continues (the content jumps ahead by the latency difference)
    const double target = d.clampPos(d.contentNext() + (nl - old) / d.fs * d.tempo);
    d.insLat = nl;
    const double s = d.crossfadeTo(target, d.routeWanted, d.stemsUsable(), d.framesOf(kJumpFadeSec));
    d.newSegment(d.nextPresent + d.insSec(), s);
    return;
  }
  d.insLat = nl;
}

void Deck::setInterpolation(InterpQuality q) noexcept { impl_->interp = q; }
void Deck::setKeylockRatioSource(KeylockRatioSource s) noexcept { impl_->ratioSource = s; }

// ---- transport --------------------------------------------------------------------------

void Deck::play(EngineTime, const BlockClock& clk) noexcept {
  Impl& d = *impl_;
  if (!d.track || d.playing) return;
  d.syncClock(clk);
  if (d.pausedPos >= d.duration() - 0.01) d.pausedPos = 0;  // engine.js play(): restart at the end
  d.endedAt = kNaN;  // engine.js _endedAt = 0
  d.endedAtSample = kNaN;
  if (d.scratching) {
    // engine.js: a play during a scrub keeps the scrub; here the scratch ends
    d.scratching = false;
    d.scDying = true;
    d.scFade.rampTo(0, d.framesOf(kStopFadeSec));
  }
  d.playing = true;
  d.armed = true;
  d.armPos = d.pausedPos;
  d.armSince = clk.sampleTime;
  d.startWaitMs = 0;
  d.tryStart(clk.presentTime, clk.sampleTime, std::max(1, clk.frames));
}

void Deck::pause(EngineTime, const BlockClock& clk) noexcept {
  Impl& d = *impl_;
  if (!d.playing) return;
  d.syncClock(clk);
  stopRoll(true);  // engine.js pause() -> stopRoll(true)
  d.pausedPos = d.armed ? d.armPos : d.contentNext();
  d.playing = false;
  d.armed = false;
  d.fadeOut(d.v[d.cur], d.framesOf(kStopFadeSec));
  d.endHeardG = -1;
  d.transientLeft = 0;
  d.newSegment(clk.presentTime + d.insSec(), d.pausedPos);
}

void Deck::seek(double t, EngineTime at, const BlockClock& clk) noexcept {
  Impl& d = *impl_;
  if (!d.track || !std::isfinite(t)) return;
  d.syncClock(clk);
  t = d.clampPos(t);
  if (d.looping && (t < d.loopStart || t >= d.loopEnd)) {  // jumping out of the loop disables it
    d.looping = false;
    d.loopBeats = kNaN;
  }
  const EngineTime anchor = clk.presentTime + d.insSec();
  if (d.scratching) {
    // a seek during a scratch moves the platter (engine.js: offset = t)
    d.scX = d.scT = t;
    d.scV = d.scTv = 0;
    d.scTSpan = 0;
    d.scTAt = clk.sampleTime;
    d.pausedPos = t;
    d.newSegment(anchor, t);
    return;
  }
  if (d.playing && !d.armed) {
    // 'at' compensation: the UI computed t at `at`; it is heard at `anchor`
    double target = t;
    if (at > 0) target += clampd(anchor - at, 0.0, 1.0) * d.tempo;
    if (d.looping && target >= d.loopEnd && d.loopEnd > d.loopStart)
      target = d.loopStart + std::fmod(target - d.loopStart, d.loopEnd - d.loopStart);
    if (target > d.duration()) target = d.duration();
    const double s = d.crossfadeTo(target, d.routeWanted, d.stemsUsable(), d.framesOf(kJumpFadeSec));
    d.newSegment(anchor, s);
    return;
  }
  if (d.armed) d.armPos = t;
  else d.pausedPos = t;
  d.newSegment(anchor, t);
}

void Deck::setCuePoint(double t) noexcept {
  if (std::isfinite(t)) impl_->cuePoint = t;
}

void Deck::setKey(int semitones) noexcept {
  Impl& d = *impl_;
  d.keyShift = clampv(semitones, kKeyMin, kKeyMax);
  d.applyPitch();
}

void Deck::setKeylock(bool on) noexcept {
  Impl& d = *impl_;
  d.keylock = on;
  d.applyPitch();
}

void Deck::setLoop(double start, double end) noexcept {
  Impl& d = *impl_;
  start = std::max(0.0, start);
  end = std::min(d.duration(), end);
  if (!(end - start >= 0.01)) return;  // engine.js: ignored when shorter than 10 ms
  d.loopStart = start;
  d.loopEnd = end;
  d.looping = true;
  // Chromium (each quantum): a read pointer already past the loop end goes to the loop start
  if (d.track) {
    const LoopFrames lf = d.loopFrames();
    for (auto& vc : d.v) {
      if (vc.active && !vc.finished && vc.rp >= lf.virtualEnd)
        vc.rp = std::min(lf.start, static_cast<double>(d.track->frames - 1));
    }
  }
}

void Deck::exitLoop() noexcept {
  Impl& d = *impl_;
  if (!d.looping) return;  // engine.js exitLoop
  d.looping = false;
  d.loopBeats = kNaN;
}

void Deck::setLoopBeats(double beats) noexcept { impl_->loopBeats = beats; }

void Deck::scratch(ScratchPhase phase, double t, EngineTime at, const BlockClock& clk) noexcept {
  Impl& d = *impl_;
  if (!d.track) return;
  d.syncClock(clk);
  const EngineTime anchor = clk.presentTime + d.insSec();
  switch (phase) {
    case ScratchPhase::Start: {
      if (d.playing) pause(at, clk);  // a scratch started on a playing deck pauses it first
      const double x = d.clampPos(d.pausedPos);
      d.scratching = true;
      d.scSounding = true;
      d.scDying = false;
      d.scX = x;
      d.scV = 0;
      d.scT = x;
      d.scTv = 0;
      d.scTAt = clk.sampleTime;
      d.scTSpan = 0;
      d.scHasLast = false;
      d.scLead = at > 0 ? clk.presentTime - at : -1.0;
      d.scFade.set(0);
      d.scFade.rampTo(1, d.framesOf(kStopFadeSec));
      d.transientLeft = 0;
      d.newSegment(anchor, x);
      break;
    }
    case ScratchPhase::Move: {
      if (!std::isfinite(t)) break;
      t = d.clampPos(t);
      if (!d.scratching) {  // engine.js scrubMove without scrubStart: offset = t
        if (!d.playing) {
          d.pausedPos = t;
          d.newSegment(anchor, t);
        }
        break;
      }
      // target velocity from the UI timestamps (feed-forward), extrapolated
      // for at most one UI interval
      double vel = 0, span = 0;
      if (d.scHasLast && at > 0 && d.scLastAt > 0) {
        const double dt = at - d.scLastAt;
        if (dt > 0.001 && dt < 0.1) {
          vel = clampd((t - d.scLastT) / dt, -kScratchMaxSpeed, kScratchMaxSpeed);
          span = dt;
        }
      }
      // When the target is due: on the UI's own timeline, `at` + the largest command lead (presentTime - at)
      // of the gesture. A Move is applied at the start of the next block (up to a period after it was
      // issued, plus the IPC); anchoring it at the block instead re-timed every target by that random delay
      // and shook the platter speed at the UI rate (e.g. 128-frame blocks, 60 Hz moves at 1x: 0.83x..1.04x).
      // A lead far from the others (a stalled UI) re-anchors the path once.
      SampleTime due = clk.sampleTime;
      if (at > 0) {
        const double lead = clk.presentTime - at;
        if (d.scLead < 0 || std::fabs(lead - d.scLead) > kScratchJitterSec) d.scLead = lead;
        else if (lead > d.scLead) d.scLead = lead;
        due = clk.sampleTime + (d.scLead - lead);
      }
      d.scT = t;
      d.scTv = vel;
      d.scTAt = due;
      d.scTSpan = span;
      d.scLastT = t;
      d.scLastAt = at;
      d.scHasLast = true;
      d.pausedPos = t;
      break;
    }
    case ScratchPhase::End: {
      if (!d.scratching) break;
      d.scratching = false;
      d.scDying = true;
      d.scFade.rampTo(0, d.framesOf(kStopFadeSec));
      d.pausedPos = d.clampPos(d.scT);  // engine.js: offset = the last scrubMove target
      d.newSegment(anchor, d.pausedPos);
      break;
    }
  }
}

void Deck::spin(SpinKind kind, const BlockClock& clk) noexcept {
  Impl& d = *impl_;
  d.syncClock(clk);
  // engine.js stopSpinSound(): from g.gain.value (the gain of the last frame), linear to 0 over 20 ms
  if (d.spinOn && !d.spinStopping) {
    d.spinStopping = true;
    d.spinStopAt = d.spinFrame;
    d.spinStopLen = d.framesOf(kSpinStopFade);
    d.spinStopG = d.spinG;
  }
  if (kind == SpinKind::None || !d.track) return;
  if (d.spinOn) d.renderTailNow(Impl::kTailSpin);  // the fading spin ends in the tail (2 ms)
  // engine.js spinSound(kind), from the heard position (currentTime())
  const double pos = d.clampPos(d.heardAt(static_cast<double>(d.gNext)).pos);
  const bool back = kind == SpinKind::Backspin;
  const double v0 = back ? 7.0 : std::max(0.2, d.tempo > 0 ? d.tempo : 1.0);
  const double decel = back ? 4.5 : 1.6;
  const double dur = v0 / decel;
  const double dist = (v0 * v0) / (2 * decel) + 0.15;
  const double sr = d.fileRate();
  const double a = back ? std::max(0.0, pos - dist) : std::max(0.0, std::min(pos, d.duration() - 0.05));
  const double b = back ? pos : std::min(d.duration(), pos + dist);
  // n = max(sr >> 4, floor((b - a) * sr)), i0 = floor(a * sr); the reversed slice starts at track frame i0 + n - 1
  const int64_t n = std::max<int64_t>(static_cast<int64_t>(sr) >> 4, static_cast<int64_t>(std::floor((b - a) * sr)));
  const int64_t i0 = static_cast<int64_t>(std::floor(a * sr));
  d.spinOn = true;
  d.spinBack = back;
  d.spinStopping = false;
  d.spinBase = back ? i0 + n - 1 : i0;
  d.spinLen = n;
  d.spinX = 0;
  d.spinInc = 0;
  d.spinFrame = 0;
  d.spinV1 = static_cast<float>(v0);  // playbackRate.setValueAtTime(v0, now)
  d.spinV2 = 0.001f;                  // linearRampToValueAtTime(0.001, now + dur)
  d.spinK = static_cast<float>(1.0 / dur);
  d.spinDur = dur;
  d.spinFadeAt = std::max(0.01, dur - 0.04);
  d.spinEnd = dur + 0.05;
  d.spinG = 1;
}

void Deck::setStemsOn(bool on) noexcept {
  Impl& d = *impl_;
  const bool want = on && d.stems != nullptr;
  if (want) {
    for (auto& g : d.stemGain) g.jump(1);  // engine.js loadStems: gains back to 1
  }
  if (want == d.stemsOn) return;
  d.stemsOn = want;
  if (d.playing && !d.armed && d.track && d.v[d.cur].active && !d.v[d.cur].dying && !d.v[d.cur].finished) {
    // same position, the other source, 5 ms crossfade (no discontinuity)
    d.crossfadeTo(d.contentNext(), d.routeWanted, want, d.framesOf(kJumpFadeSec));
  }
}

void Deck::setStemGain(Stem s, float gain, float tauSec) noexcept {
  Impl& d = *impl_;
  const int i = static_cast<int>(s);
  if (i < 0 || i >= kNumStems) return;
  d.stemGain[i].setTarget(gain, tauSec, d.fs);
}

// ---- render / queries ----------------------------------------------------------------

void Deck::render(float* l, float* r, int frames, const BlockClock& clk) noexcept {
  if (frames <= 0) return;
  impl_->render(l, r, frames, clk);
}

void Deck::snapshot(om_deck_state& s, EngineTime t) const noexcept {
  const Impl& d = *impl_;
  s = om_deck_state();
  s.load_id = d.track ? d.track->loadId : 0;
  s.seg = d.seg;
  s.ended_count = d.endedCount;
  s.loaded = d.track != nullptr;
  s.playing = d.playing;
  s.armed = d.armed;
  s.looping = d.looping;
  s.keylock = d.keylock;
  s.routed_wsola = d.routeWanted;
  s.stems_ready = d.stems != nullptr;
  s.stems_on = d.stemsOn;
  s.scratching = d.scratching;
  s.spinning = d.spinOn;
  s.rolling = d.rollOn;
  s.settled = transportSettled();
  s.key_shift = static_cast<int8_t>(d.keyShift);
  s.pcm_ready = d.track ? d.track->readyRatio() : 0.0f;
  s.start_wait_ms = d.startWaitMs;
  s.duration = d.duration();
  const double G = static_cast<double>(d.gNext) + (t - d.nextPresent) * d.fs;
  const Content h = d.heardAt(G);
  s.pos = d.track ? d.clampPos(h.pos) : 0.0;
  s.rate = d.armed ? 0.0 : static_cast<double>(h.rate);
  s.tempo = d.tempo;
  s.anchor_t = d.anchorT;
  s.anchor_pos = d.anchorPos;
  s.loop_start = d.loopStart;
  s.loop_end = d.loopEnd;
  s.loop_beats = d.loopBeats;
  s.cue_point = d.cuePoint;
  s.proc_latency = procLatencySec();
  s.roll_beats = d.rollOn ? d.rollBeats : 0.0;
  s.ended_at = d.endedAt;
  for (int i = 0; i < kNumStems; i++) s.stem_gains[i] = d.stemGain[i].value();
  s.dry = 1.0f;
}

double Deck::positionAt(EngineTime when) const noexcept {
  const Impl& d = *impl_;
  if (!d.track) return 0.0;
  const double G = static_cast<double>(d.gNext) + (when - d.nextPresent) * d.fs;
  return d.clampPos(d.heardAt(G).pos);
}

double Deck::procLatencySec() const noexcept {
  const Impl& d = *impl_;
  return (d.routeWanted ? LAT / d.fs : 0.0) + d.insSec();
}
int Deck::keyShift() const noexcept { return impl_->keyShift; }
bool Deck::keylock() const noexcept { return impl_->keylock; }
double Deck::cuePoint() const noexcept { return impl_->cuePoint; }
bool Deck::looping() const noexcept { return impl_->looping; }
bool Deck::armed() const noexcept { return impl_->armed; }
uint32_t Deck::loadId() const noexcept { return impl_->track ? impl_->track->loadId : 0; }
uint32_t Deck::endedCount() const noexcept { return impl_->endedCount; }

// ---- IDeckControl ------------------------------------------------------------------------

bool Deck::loaded() const noexcept { return impl_->track != nullptr; }
bool Deck::playing() const noexcept { return impl_->playing; }
double Deck::duration() const noexcept { return impl_->duration(); }
double Deck::heardPosition() const noexcept {
  const Impl& d = *impl_;
  if (!d.track) return 0.0;
  return d.clampPos(d.heardAt(static_cast<double>(d.gNext)).pos);
}
bool Deck::transportSettled() const noexcept {
  const Impl& d = *impl_;
  return !d.armed && !d.scratching && !d.spinOn && d.transientLeft == 0;
}
double Deck::tempo() const noexcept { return impl_->tempo; }
void Deck::setTempo(double r) noexcept {
  Impl& d = *impl_;
  if (!std::isfinite(r)) return;
  d.tempo = clampv(r, kTempoMin, kTempoMax);
  d.tempoF = static_cast<float>(d.tempo);
  if (d.keylock) d.applyPitch();  // engine.js setTempo -> _applyPitch under keylock
}
void Deck::seekHeard(double t) noexcept {
  Impl& d = *impl_;
  if (!d.track || !std::isfinite(t)) return;
  BlockClock clk;
  clk.presentTime = d.nextPresent;
  clk.sampleTime = d.nextSample;
  clk.sampleRate = d.fs;
  // heard at presentTime + insert latency: aim where the timeline will be then
  const double target = d.playing && !d.armed ? t + d.insSec() * d.tempo : t;
  seek(target, 0, clk);
}
bool Deck::routedThroughWsola() const noexcept { return impl_->routeWanted; }
const BeatGrid* Deck::grid() const noexcept { return impl_->grid; }
SampleTime Deck::endedAtSample() const noexcept { return impl_->endedAtSample; }

bool Deck::startRoll(double beats, double mix) noexcept {
  Impl& d = *impl_;
  if (!d.track || !d.playing || !(beats > 0)) return false;
  const double pos = heardPosition();
  if (pos < 0) return false;
  double start, end;
  const BeatGrid* g = d.grid;
  if (g && g->hasDynamic()) {
    const double f = grid::indexFracAt(*g, pos, d.globalGridOffset);
    const double anchor = g->barAnchor;
    const double k0 = std::floor((f - anchor) / beats + 1e-6) * beats + anchor;
    start = grid::timeAtIndex(*g, k0, d.globalGridOffset);
    end = grid::timeAtIndex(*g, k0 + beats, d.globalGridOffset);
  } else if (g && g->bpm > 0) {
    const double per = 60.0 / g->bpm;
    const double off = isSet(g->beatOffset) ? g->beatOffset : 0.0;  // engine.js beatOffset || 0
    const double k0 = std::floor((pos - off) / (per * beats) + 1e-6);
    start = off + k0 * per * beats;
    end = start + per * beats;
  } else {
    return false;
  }
  if (!isSet(start) || !isSet(end) || end - start < 0.01) return false;
  start = std::max(0.0, start);
  end = std::min(d.duration(), end);
  if (end - start < 0.01) return false;
  // already rolling on the same slice: only the amount changes
  if (d.rollOn && std::fabs(d.rollStart - start) < 1e-4 && std::fabs(d.rollEnd - end) < 1e-4) {
    setRollMix(mix);
    return true;
  }
  stopRoll(true);
  // the second pointer starts where the main read pointer is, wrapped into the slice
  double off = d.v[d.cur].active ? d.v[d.cur].rp / d.fileRate() : pos;
  if (off >= end) off = start + std::fmod(off - start, end - start);
  if (off < start) off = start;
  d.rollOn = true;
  d.rollSounding = true;
  d.rollStopLeft = 0;
  d.rollStart = start;
  d.rollEnd = end;
  d.rollBeats = beats;
  d.rollMix = -1;
  d.rollRp = std::round(off * d.fileRate());  // Chromium start offset
  setRollMix(mix);
  return true;
}

void Deck::setRollMix(double mix) noexcept {
  Impl& d = *impl_;
  if (!d.rollOn) return;
  const double m = clampd(mix, 0.0, 1.0);
  if (std::fabs(m - d.rollMix) < 0.005) return;
  d.rollMix = m;
  d.mainGain.setTarget(static_cast<float>(1.0 - m), kRollTau, d.fs);
  d.rollGain.setTarget(static_cast<float>(m), kRollTau, d.fs);
}

void Deck::stopRoll(bool immediate) noexcept {
  Impl& d = *impl_;
  if (!d.rollOn) return;
  d.rollOn = false;
  d.mainGain.setTarget(1.0f, kRollTau, d.fs);
  d.rollGain.setTarget(0.0f, kRollTau, d.fs);
  d.rollStopLeft = d.framesOf(immediate ? 0.02 : 0.04);  // engine.js r.src.stop(t + 0.02 / 0.04)
}

bool Deck::rolling(double* beats) const noexcept {
  const Impl& d = *impl_;
  if (beats) *beats = d.rollOn ? d.rollBeats : 0.0;
  return d.rollOn;
}

}  // namespace om
