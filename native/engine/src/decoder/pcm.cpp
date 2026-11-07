// Engine side of the PCM handoff (owner: decoder): the PcmStore registry
// (epochs, begin / chunk writes / end / abort, users, memory accounting and
// limits, garbage collection of abandoned streams, frees deferred to the
// control thread and never done under the mutex) and the conversions of the
// float32 planar chunks the renderer sends (Web Audio "speakers" fold to
// stereo, per-track or per-chunk headroom, TPDF-dithered int16 with a
// deterministic seed per chunk, float32 interleave). SPEC.md §5, §7.3.
#include <cmath>
#include <cstring>
#include <iterator>
#include <vector>

#include "om/pcm.h"

namespace om {

const char* pcmErrorName(PcmError e) noexcept {
  switch (e) {
    case PcmError::None: return "none";
    case PcmError::Invalid: return "invalid";
    case PcmError::Exists: return "exists";
    case PcmError::NotFound: return "notFound";
    case PcmError::OutOfMemory: return "memory";
    case PcmError::Range: return "range";
    case PcmError::Duplicate: return "duplicate";
    case PcmError::Incomplete: return "incomplete";
    case PcmError::Aborted: return "aborted";
  }
  return "invalid";
}

// One stream. Owned by the registry map (or by the displaced list once a new
// begin() took its key); write() uses it through a raw pointer while its
// `writers` count is held, and freePending() never frees an entry a writer
// still converts into.
struct PcmStore::Entry {
  std::shared_ptr<TrackBuffer> tb;
  uint64_t k = 0;
  uint32_t epoch = 0;
  double seenAt = kNaN;  // first collectGarbage() pass that saw it (caller's clock)
  int users = 0;
  bool ended = false;
  bool everAttached = false;
  bool dropWhenUnused = false;  // aborted, or left behind by a new epoch, while attached
  bool dead = false;            // dropped: waits for freePending()
  std::atomic<int> writers{0};  // write() calls converting outside the mutex
  std::atomic<uint64_t> clipped{0};
  std::unique_ptr<std::atomic<uint8_t>[]> claimed;  // per chunk: taken by a writer
  std::shared_ptr<Entry> nextDisplaced;              // intrusive list (displaced_)
};

namespace {
// Room for live + dead entries without a rehash (a rehash frees the old
// bucket array, and nothing may be freed under the mutex).
constexpr size_t kMapCapacity = 4 * kPcmMaxStreams;

bool finite(float v) noexcept { return v - v == 0.0f; }

// Destroys an intrusive list iteratively (no deep recursion through the
// shared_ptr chain).
template <class E>
void destroyList(std::shared_ptr<E>& head) noexcept {
  while (head) {
    std::shared_ptr<E> next = std::move(head->nextDisplaced);
    head.reset();
    head = std::move(next);
  }
}
}  // namespace

PcmStore::PcmStore(uint64_t maxBytes) : maxBytes_(maxBytes) { entries_.reserve(kMapCapacity); }

PcmStore::~PcmStore() {
  std::lock_guard<std::mutex> lk(m_);  // (no writer may run while the store is destroyed)
  destroyList(displaced_);
  entries_.clear();
}

uint32_t PcmStore::epoch() const noexcept { return epoch_.load(); }

PcmStore::Entry* PcmStore::liveLocked(uint64_t k) const noexcept {
  auto it = entries_.find(k);
  return (it == entries_.end() || it->second->dead) ? nullptr : it->second.get();
}

void PcmStore::dropLocked(Entry& e) noexcept {
  if (e.dead) return;
  e.dead = true;
  const uint64_t b = e.tb ? e.tb->bytes() : 0;
  bytes_.fetch_sub(b);
  deadBytes_ += b;
  live_--;
  dead_++;
}

uint32_t PcmStore::newEpoch() {
  std::lock_guard<std::mutex> lk(m_);
  const uint32_t e = epoch_.fetch_add(1) + 1;
  for (auto& kv : entries_) {
    Entry& en = *kv.second;
    if (en.dead) continue;
    if (en.users == 0) dropLocked(en);
    else en.dropWhenUnused = true;
  }
  return e;
}

PcmError PcmStore::begin(const PcmDesc& d) {
  if (d.loadId == 0 || d.sourceChannels < 1 || d.sourceChannels > kPcmMaxChannels || d.sampleRate < kPcmMinRate ||
      d.sampleRate > kPcmMaxRate || d.frames < 1 || d.frames > kPcmMaxFrames ||
      (d.format != PcmFormat::S16 && d.format != PcmFormat::F32) || !finite(d.headroom) ||
      !(d.headroom == 0.0f || d.headroom >= 1.0f) ||
      (d.kind != PcmKind::Track && d.kind != PcmKind::Stem && d.kind != PcmKind::Sample))
    return PcmError::Invalid;
  const uint64_t need = static_cast<uint64_t>(d.frames) * 2 * (d.format == PcmFormat::S16 ? 2 : 4);
  uint32_t ep;
  {
    // Reservation: concurrent begin() calls can never overshoot the limits.
    std::lock_guard<std::mutex> lk(m_);
    ep = epoch_.load();
    if (liveLocked(key(ep, d.loadId))) return PcmError::Exists;
    if (live_ >= kPcmMaxStreams || entries_.size() >= kMapCapacity || (maxBytes_ && bytes_.load() + need > maxBytes_)) {
      refused_++;
      return PcmError::OutOfMemory;
    }
    bytes_ += need;
    live_++;
  }
  // The big allocation runs outside the mutex (it may take milliseconds).
  std::unique_ptr<TrackBuffer> tb = TrackBuffer::allocate(d.loadId, d.kind, d.format, d.sampleRate, d.frames,
                                                          d.format == PcmFormat::S16 ? d.headroom : 0.0f);
  std::shared_ptr<Entry> e;
  if (tb) {
    e = std::shared_ptr<Entry>(new (std::nothrow) Entry());
    if (e) {
      e->claimed.reset(new (std::nothrow) std::atomic<uint8_t>[static_cast<size_t>(tb->numChunks)]);
      if (!e->claimed) e.reset();
    }
  }
  const uint64_t k = key(ep, d.loadId);
  if (e) {
    for (int64_t c = 0; c < tb->numChunks; c++) e->claimed[c].store(0, std::memory_order_relaxed);
    tb->storeKey = k;
    tb->peak = finite(d.peak) ? d.peak : 0.0f;
    e->tb = std::shared_ptr<TrackBuffer>(tb.release());
    e->k = k;
    e->epoch = ep;
  }
  // (declared before the lock: a failed allocation's leftovers are freed after unlocking)
  std::lock_guard<std::mutex> lk(m_);
  if (!e) {
    bytes_ -= need;
    live_--;
    refused_++;
    return PcmError::OutOfMemory;
  }
  // A newEpoch() (or a racing begin() of the same key) between the
  // reservation and now: the stream is born dead and the caller is told why.
  const bool stale = epoch_.load() != ep;
  auto it = entries_.find(k);
  if (stale || (it != entries_.end() && !it->second->dead)) {
    e->dead = true;
    bytes_ -= need;
    deadBytes_ += need;
    live_--;
    dead_++;
    e->nextDisplaced = std::move(displaced_);
    displaced_ = std::move(e);
    return stale ? PcmError::Aborted : PcmError::Exists;
  }
  if (it != entries_.end()) {
    // a dead stream of the same key: displaced to the pending list (no free here)
    std::shared_ptr<Entry>& slot = it->second;
    slot->nextDisplaced = std::move(displaced_);
    displaced_ = std::move(slot);
    slot = std::move(e);
  } else {
    entries_.emplace(k, std::move(e));  // allocates a node; no rehash (capacity reserved)
  }
  return PcmError::None;
}

PcmError PcmStore::write(uint32_t loadId, int64_t offsetFrames, int frames, int channels, const float* planar) {
  Entry* en = nullptr;
  TrackBuffer* tbp = nullptr;
  int64_t c = 0;
  {
    std::lock_guard<std::mutex> lk(m_);
    en = liveLocked(key(epoch_.load(), loadId));
    if (!en) return PcmError::NotFound;
    if (en->dropWhenUnused) return PcmError::Aborted;
    tbp = en->tb.get();
    if (!planar || channels < 1 || channels > kPcmMaxChannels || offsetFrames < 0 || offsetFrames >= tbp->frames ||
        (offsetFrames & (TrackBuffer::kChunkFrames - 1)) != 0)
      return PcmError::Range;
    c = offsetFrames >> TrackBuffer::kChunkShift;
    if (frames != tbp->chunkFramesOf(c)) return PcmError::Range;
    if (tbp->chunkReady(c) || en->claimed[c].exchange(1, std::memory_order_acq_rel) != 0) return PcmError::Duplicate;
    en->writers.fetch_add(1, std::memory_order_acq_rel);
  }
  TrackBuffer& tb = *tbp;
  // Fold to stereo (stack buffers are too small for a chunk: one reused
  // thread-local scratch per writer thread, grown once).
  const float* l = planar;
  const float* r = channels >= 2 ? planar + frames : planar;
  if (channels > 2) {
    thread_local std::vector<float> fold;
    if (fold.size() < static_cast<size_t>(frames) * 2) fold.resize(static_cast<size_t>(frames) * 2);
    downmixToStereo(planar, channels, frames, fold.data(), fold.data() + frames);
    l = fold.data();
    r = fold.data() + frames;
  }
  bool published;
  if (tb.format == PcmFormat::S16) {
    float headroom;
    if (tb.headroom >= 1.0f) {
      headroom = tb.headroom;
      const uint64_t over = countOver(l, r, frames, headroom);
      if (over) {
        en->clipped.fetch_add(over, std::memory_order_relaxed);
        clippedTotal_.fetch_add(over, std::memory_order_relaxed);
      }
    } else {
      headroom = headroomFor(peakOf(l, r, frames));
    }
    quantizeS16(l, r, frames, headroom, ditherSeed(loadId, c), tb.s16Chunk(c));
    published = tb.publishChunk(c, headroom / 32767.0f);
  } else {
    float* dst = tb.f32Chunk(c);
    for (int i = 0; i < frames; i++) {
      const float a = l[i];
      const float b = r[i];
      dst[2 * i] = finite(a) ? a : 0.0f;  // (NaN / Inf would poison every filter downstream)
      dst[2 * i + 1] = finite(b) ? b : 0.0f;
    }
    published = tb.publishChunk(c, 1.0f);
  }
  chunks_.fetch_add(1, std::memory_order_relaxed);
  en->writers.fetch_sub(1, std::memory_order_acq_rel);  // last access to the entry
  return published ? PcmError::None : PcmError::Duplicate;
}

PcmError PcmStore::end(uint32_t loadId) {
  std::lock_guard<std::mutex> lk(m_);
  Entry* en = liveLocked(key(epoch_.load(), loadId));
  if (!en) return PcmError::NotFound;
  if (en->dropWhenUnused) return PcmError::Aborted;
  if (!en->tb->complete()) return PcmError::Incomplete;
  en->ended = true;
  return PcmError::None;
}

void PcmStore::abort(uint32_t loadId) {
  std::lock_guard<std::mutex> lk(m_);
  Entry* en = liveLocked(key(epoch_.load(), loadId));
  if (!en) return;
  if (en->users == 0) dropLocked(*en);  // freed by freePending() on the control thread
  else en->dropWhenUnused = true;
}

std::shared_ptr<TrackBuffer> PcmStore::acquire(uint32_t loadId) {
  std::lock_guard<std::mutex> lk(m_);
  Entry* en = liveLocked(key(epoch_.load(), loadId));
  if (!en || en->dropWhenUnused) return nullptr;
  en->users++;
  en->everAttached = true;
  return en->tb;
}

void PcmStore::release(const TrackBuffer* tb) {
  if (!tb) return;
  std::lock_guard<std::mutex> lk(m_);
  Entry* en = liveLocked(tb->storeKey);
  if (!en || en->tb.get() != tb) return;
  if (en->users > 0) en->users--;
  // A buffer that is no longer attached anywhere is dropped (the renderer
  // hands it off again if it is loaded again).
  if (en->users == 0) dropLocked(*en);
}

std::shared_ptr<const TrackBuffer> PcmStore::peek(uint32_t loadId) const {
  std::lock_guard<std::mutex> lk(m_);
  Entry* en = liveLocked(key(epoch_.load(), loadId));
  return en ? en->tb : nullptr;
}

bool PcmStore::info(uint32_t loadId, PcmInfo& out) const {
  std::lock_guard<std::mutex> lk(m_);
  const Entry* en = liveLocked(key(epoch_.load(), loadId));
  if (!en) return false;
  const TrackBuffer& tb = *en->tb;
  out.loadId = loadId;
  out.epoch = en->epoch;
  out.kind = tb.kind;
  out.format = tb.format;
  out.sampleRate = tb.sampleRate;
  out.frames = tb.frames;
  out.chunks = tb.numChunks;
  out.chunksReady = tb.readyChunks.load();
  out.ended = en->ended;
  out.attached = en->everAttached;
  out.users = en->users;
  out.bytes = tb.bytes();
  out.headroom = tb.headroom;
  out.clipped = en->clipped.load();
  return true;
}

PcmStoreStats PcmStore::stats() const {
  std::lock_guard<std::mutex> lk(m_);
  PcmStoreStats s;
  s.streams = live_;
  s.bytes = bytes_.load();
  s.pendingFree = dead_;
  s.pendingBytes = deadBytes_;
  s.freedBuffers = freed_.load();
  s.collected = collected_.load();
  s.refused = refused_.load();
  s.clipped = clippedTotal_.load();
  s.chunksWritten = chunks_.load();
  return s;
}

uint64_t PcmStore::bytes() const noexcept { return bytes_.load(); }

size_t PcmStore::count() const {
  std::lock_guard<std::mutex> lk(m_);
  return live_;
}

size_t PcmStore::collectGarbage(EngineTime now, double maxAgeSec) {
  std::lock_guard<std::mutex> lk(m_);
  size_t n = 0;
  for (auto& kv : entries_) {
    Entry& e = *kv.second;
    if (e.dead || e.users != 0 || e.everAttached) continue;
    if (!isSet(e.seenAt)) {
      e.seenAt = now;
    } else if (now - e.seenAt > maxAgeSec) {
      dropLocked(e);
      n++;
    }
  }
  collected_ += n;
  return n;
}

size_t PcmStore::freePending() {
  size_t want;
  {
    std::lock_guard<std::mutex> lk(m_);
    want = dead_;
  }
  if (want == 0) return 0;
  // Storage for the unlinked map nodes, reserved before taking the mutex: no
  // allocation is needed and nothing is freed while the mutex is held.
  std::vector<Map::node_type> nodes;
  nodes.reserve(want + 8);
  std::shared_ptr<Entry> taken;
  size_t n = 0;
  {
    std::lock_guard<std::mutex> lk(m_);
    std::shared_ptr<Entry> keep;
    while (displaced_) {
      std::shared_ptr<Entry> e = std::move(displaced_);
      displaced_ = std::move(e->nextDisplaced);
      if (e->writers.load(std::memory_order_acquire) != 0) {
        e->nextDisplaced = std::move(keep);
        keep = std::move(e);
        continue;
      }
      deadBytes_ -= e->tb ? e->tb->bytes() : 0;
      dead_--;
      n++;
      e->nextDisplaced = std::move(taken);
      taken = std::move(e);
    }
    displaced_ = std::move(keep);
    for (auto it = entries_.begin(); it != entries_.end() && nodes.size() < nodes.capacity();) {
      const std::shared_ptr<Entry>& e = it->second;
      if (e->dead && e->writers.load(std::memory_order_acquire) == 0) {
        deadBytes_ -= e->tb ? e->tb->bytes() : 0;
        dead_--;
        n++;
        auto next = std::next(it);
        nodes.push_back(entries_.extract(it));
        it = next;
      } else {
        ++it;
      }
    }
  }
  // Freed here, outside the mutex (the last owner of a TrackBuffer returns its memory).
  nodes.clear();
  destroyList(taken);
  freed_ += n;
  return n;
}

// ---------------------------------------------------------------------------
// Conversions
// ---------------------------------------------------------------------------
float headroomFor(float peak) noexcept { return peak > 1.0f ? peak : 1.0f; }

float peakOf(const float* l, const float* r, int64_t frames) noexcept {
  float p = 0.0f;
  for (int64_t i = 0; i < frames; i++) {
    const float a = std::fabs(l[i]);
    const float b = std::fabs(r[i]);
    if (a > p && a <= 3.4e38f) p = a;  // (NaN and Inf ignored)
    if (b > p && b <= 3.4e38f) p = b;
  }
  return p;
}

uint64_t countOver(const float* l, const float* r, int64_t frames, float headroom) noexcept {
  uint64_t n = 0;
  for (int64_t i = 0; i < frames; i++) n += (std::fabs(l[i]) > headroom) + (std::fabs(r[i]) > headroom);
  return n;
}

void downmixToStereo(const float* planar, int channels, int64_t frames, float* l, float* r) noexcept {
  const float* c0 = planar;
  const float* c1 = channels >= 2 ? planar + frames : planar;
  constexpr float kSqrtHalf = 0.70710678118654752f;
  if (channels == 4) {  // quad: L, R, SL, SR
    const float* sl = planar + 2 * frames;
    const float* sr = planar + 3 * frames;
    for (int64_t i = 0; i < frames; i++) {
      l[i] = 0.5f * (c0[i] + sl[i]);
      r[i] = 0.5f * (c1[i] + sr[i]);
    }
    return;
  }
  if (channels == 6) {  // 5.1: L, R, C, LFE, SL, SR (LFE dropped)
    const float* c = planar + 2 * frames;
    const float* sl = planar + 4 * frames;
    const float* sr = planar + 5 * frames;
    for (int64_t i = 0; i < frames; i++) {
      l[i] = c0[i] + kSqrtHalf * (c[i] + sl[i]);
      r[i] = c1[i] + kSqrtHalf * (c[i] + sr[i]);
    }
    return;
  }
  if (l != c0) std::memmove(l, c0, static_cast<size_t>(frames) * sizeof(float));  // mono duplicated, stereo as
  if (r != c1) std::memmove(r, c1, static_cast<size_t>(frames) * sizeof(float));  // is, others: first two channels
}

uint32_t ditherSeed(uint32_t loadId, int64_t chunk) noexcept {
  uint32_t x = loadId * 0x9E3779B1u ^ (static_cast<uint32_t>(chunk) + 1u) * 0x85EBCA6Bu;
  x ^= x >> 16;
  x *= 0x7FEB352Du;
  x ^= x >> 15;
  return x ? x : 0x9E3779B9u;
}

namespace {
// floor(t) clamped to int16, NaN -> 0 (exactly floor() for every finite t).
inline int16_t floorToS16(double t) noexcept {
  if (t >= 32767.0) return 32767;
  if (t > -32768.0) {
    const int64_t k = static_cast<int64_t>(t);  // truncation toward zero
    return static_cast<int16_t>(t < static_cast<double>(k) ? k - 1 : k);
  }
  return t != t ? int16_t(0) : int16_t(-32768);
}
}  // namespace

void quantizeS16(const float* l, const float* r, int64_t frames, float headroom, uint32_t seed,
                 int16_t* out) noexcept {
  uint32_t x = seed ? seed : 0x9E3779B9u;
  constexpr double kInv32 = 1.0 / 4294967296.0;  // exact (a power of two)
  const double scale = 32767.0 / (headroom >= 1.0f ? static_cast<double>(headroom) : 1.0);
  for (int64_t i = 0; i < frames; i++) {
    const float v2[2] = {l[i], r[i]};
    for (int ch = 0; ch < 2; ch++) {
      // d = rand() - rand(): the FIRST draw minus the SECOND (explicit order:
      // the operands of a C++ subtraction are evaluated in no fixed order)
      x ^= x << 13;
      x ^= x >> 17;
      x ^= x << 5;
      const double a = x * kInv32;
      x ^= x << 13;
      x ^= x >> 17;
      x ^= x << 5;
      const double b = x * kInv32;
      const double d = a - b;
      out[2 * i + ch] = floorToS16(static_cast<double>(v2[ch]) * scale + d + 0.5);
    }
  }
}

}  // namespace om
