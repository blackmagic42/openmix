// Deck transport and rendering (owner: deck). SKELETON: keeps the plain
// state that commands set (so the core and the JS proxy can be integrated
// early) but renders silence and never moves. SPEC.md §8.
#include <algorithm>
#include <cstring>

#include "om/deck.h"

namespace om {

struct Deck::Impl {
  const TrackBuffer* track = nullptr;
  const BeatGrid* grid = nullptr;
  const StemSet* stems = nullptr;
  uint64_t gen = 0;
  bool playing = false;
  double pos = 0.0;  // heard position (s) — TODO(deck): read position + history ring
  double tempo = 1.0;
  double cuePoint = 0.0;
  int keyShift = 0;
  bool keylock = false;
  bool looping = false;
  double loopStart = 0, loopEnd = 0, loopBeats = kNaN;
  bool stemsOn = false;
  float stemGains[kNumStems] = {1, 1, 1, 1};
  bool slip = false;
  double globalGridOffset = 0;
  int insertLatency = 0;
  double sampleRate = 48000;
  EngineTime endedAt = kNaN;
  EngineTime lastPresent = 0;
};

Deck::Deck(int index) : index_(index), impl_(std::make_unique<Impl>()) {}
Deck::~Deck() = default;

void Deck::prepare(double deviceRate, int) { impl_->sampleRate = deviceRate; }

void Deck::reset() noexcept {
  Impl& d = *impl_;
  d.playing = false;
  d.pos = 0;
  d.tempo = 1;
  d.cuePoint = 0;
  d.keyShift = 0;
  d.looping = false;
  d.loopBeats = kNaN;
  d.stemsOn = false;
  for (float& g : d.stemGains) g = 1;
  d.endedAt = kNaN;
}

const TrackBuffer* Deck::attachTrack(const TrackBuffer* tb, uint64_t gen) noexcept {
  const TrackBuffer* old = impl_->track;
  impl_->track = tb;
  impl_->gen = gen;
  return old;
}
const BeatGrid* Deck::attachGrid(const BeatGrid* g) noexcept {
  const BeatGrid* old = impl_->grid;
  impl_->grid = g;
  return old;
}
const StemSet* Deck::attachStems(const StemSet* s) noexcept {
  const StemSet* old = impl_->stems;
  impl_->stems = s;
  return old;
}
void Deck::setGlobalGridOffset(double sec) noexcept { impl_->globalGridOffset = sec; }
void Deck::setInsertLatency(int frames) noexcept { impl_->insertLatency = frames; }

void Deck::play(EngineTime, const BlockClock&) noexcept {
  if (impl_->track) impl_->playing = true;
}
void Deck::pause(EngineTime, const BlockClock&) noexcept { impl_->playing = false; }
void Deck::seek(double t, EngineTime, const BlockClock&) noexcept { impl_->pos = std::max(-kPreRollSec, t); }
void Deck::cueButton(EngineTime, const BlockClock&) noexcept {}
void Deck::setCuePoint(double t) noexcept { impl_->cuePoint = t; }
void Deck::setKey(int semitones) noexcept { impl_->keyShift = clampv(semitones, kKeyMin, kKeyMax); }
void Deck::setKeylock(bool on) noexcept { impl_->keylock = on; }
void Deck::setLoop(double start, double end) noexcept {
  impl_->loopStart = start;
  impl_->loopEnd = end;
  impl_->looping = end - start >= 0.01;
}
void Deck::exitLoop() noexcept {
  impl_->looping = false;
  impl_->loopBeats = kNaN;
}
void Deck::setLoopBeats(double beats) noexcept { impl_->loopBeats = beats; }
void Deck::setSlip(bool on) noexcept { impl_->slip = on; }
void Deck::scratch(ScratchPhase, double, EngineTime, const BlockClock&) noexcept {}
void Deck::spin(SpinKind, const BlockClock&) noexcept {}
void Deck::setStemsOn(bool on) noexcept { impl_->stemsOn = on && impl_->stems; }
void Deck::setStemGain(Stem s, float gain, float) noexcept { impl_->stemGains[static_cast<int>(s)] = gain; }

void Deck::render(float* l, float* r, int frames, const BlockClock& clk) noexcept {
  impl_->lastPresent = clk.presentTime;
  std::memset(l, 0, sizeof(float) * static_cast<size_t>(frames));
  std::memset(r, 0, sizeof(float) * static_cast<size_t>(frames));
}

bool Deck::takeEnded(EngineTime&) noexcept { return false; }

void Deck::snapshot(DeckSnapshot& s) const noexcept {
  const Impl& d = *impl_;
  s = DeckSnapshot();
  s.loaded = d.track != nullptr;
  s.gen = d.gen;
  s.duration = d.track ? d.track->duration() : 0.0;
  s.pos = d.pos;
  s.at = d.lastPresent;
  s.rate = 0;
  s.playing = d.playing;
  s.tempo = d.tempo;
  s.looping = d.looping;
  s.loopStart = d.loopStart;
  s.loopEnd = d.loopEnd;
  s.loopBeats = d.loopBeats;
  s.cuePoint = d.cuePoint;
  s.keyShift = d.keyShift;
  s.keylock = d.keylock;
  s.stemsReady = d.stems != nullptr;
  s.stemsOn = d.stemsOn;
  std::copy(std::begin(d.stemGains), std::end(d.stemGains), s.stemGains);
  s.slip = d.slip;
  s.endedAt = d.endedAt;
}

double Deck::heardPositionAt(EngineTime) const noexcept { return impl_->pos; }
double Deck::procLatencySec() const noexcept { return 0.0; }
int Deck::keyShift() const noexcept { return impl_->keyShift; }
bool Deck::keylock() const noexcept { return impl_->keylock; }
double Deck::cuePoint() const noexcept { return impl_->cuePoint; }
bool Deck::looping() const noexcept { return impl_->looping; }
uint64_t Deck::gen() const noexcept { return impl_->gen; }

bool Deck::loaded() const noexcept { return impl_->track != nullptr; }
bool Deck::playing() const noexcept { return impl_->playing; }
double Deck::duration() const noexcept { return impl_->track ? impl_->track->duration() : 0.0; }
double Deck::heardPosition() const noexcept { return impl_->pos; }
bool Deck::transportSettled() const noexcept { return true; }
double Deck::tempo() const noexcept { return impl_->tempo; }
void Deck::setTempo(double r) noexcept { impl_->tempo = clampv(r, kTempoMin, kTempoMax); }
void Deck::seekHeard(double t) noexcept { impl_->pos = t; }
bool Deck::routedThroughWsola() const noexcept { return impl_->keylock || impl_->keyShift != 0; }
const BeatGrid* Deck::grid() const noexcept { return impl_->grid; }
EngineTime Deck::endedAt() const noexcept { return impl_->endedAt; }
bool Deck::startRoll(double, double) noexcept { return false; }
void Deck::setRollMix(double) noexcept {}
void Deck::stopRoll(bool) noexcept {}
bool Deck::rolling(double* beats) const noexcept {
  if (beats) *beats = 0;
  return false;
}

}  // namespace om
