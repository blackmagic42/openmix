// WSOLA pitch shifter, line-by-line C++ port of src/js/pitch-worklet.js,
// plus prime() so the deck can restart it on a new position without delay
// (owner: deck). SPEC.md §9.4.
//
// Bit parity with the worklet: every scalar expression is evaluated in double
// in the worklet's order and stored to float where the worklet stores to a
// Float32Array (ring, accumulator, window); the ratio is the float32 value an
// AudioParam holds. The correlation search is the only part rewritten for
// speed, and it is EXACT, not approximate: the candidate scores are the same
// sequential double sums (each candidate keeps its own accumulation order;
// candidates are merely computed side by side), and the read indices
// trunc(s + k*r) are obtained from floor(S0 + k*r) + d, which equals the
// worklet's value whenever every operation is exact — guaranteed when r is a
// float32 value, the positions are >= 0 and the frame counters stay below
// 2^29 (they are rebased by a multiple of RING beyond that). Outside those
// conditions (a freshly reset instance reading negative positions during its
// first 85 ms, a ratio clamped to the double 1.8) the search runs the
// worklet's own per-point arithmetic.
#include "om/wsola.h"

#include <cmath>
#include <cstring>
#include <limits>

#if defined(_M_X64) || defined(__x86_64__) || (defined(_M_IX86_FP) && _M_IX86_FP >= 2) || defined(__SSE2__)
#define OM_WSOLA_SSE2 1
#include <emmintrin.h>
#endif

namespace om {

namespace {

constexpr int N = Wsola::kGrain;
constexpr int HS = Wsola::kHop;
constexpr int OVL = Wsola::kOverlap;
constexpr int SEARCH = Wsola::kSearch;
constexpr int LAT = Wsola::kLatency;
constexpr int RING = Wsola::kRing;
constexpr int ACC = Wsola::kAcc;
constexpr int64_t RM = RING - 1;
constexpr int64_t AM = ACC - 1;
constexpr double R_MIN = Wsola::kRatioMin;
constexpr double R_MAX = Wsola::kRatioMax;

constexpr int kCoarsePts = OVL / 4;            // 192 points per coarse score (step 4)
constexpr int kFinePts = OVL / 2;              // 384 points per fine score (step 2)
constexpr int kCoarseCands = 2 * SEARCH / 4 + 1;  // 241 candidates, d = -480 .. 480 step 4
constexpr int kCandBlock = 8;                  // candidates scored side by side
constexpr int kCoarseCandsPadded = ((kCoarseCands + kCandBlock - 1) / kCandBlock) * kCandBlock;  // 248
// Copy of the mono signal under every coarse candidate (padded ones included):
// from S0 - SEARCH to S0 + (OVL - 4) * R_MAX + 4 * (kCoarseCandsPadded - 1) - SEARCH,
// split in 4 phases (stride 4) so that one point's candidates are contiguous.
constexpr int kLinSpan = static_cast<int>((OVL - 4) * R_MAX) + 4 + 4 * kCoarseCandsPadded + 8;
constexpr int kLinPhase = kLinSpan / 4 + 4;
// Rebase threshold of the frame counters: positions stay below 2^28, so every
// sum of the search (multiples of 2^-24) is exact in double.
constexpr int64_t kRebaseAt = int64_t(1) << 28;
constexpr int64_t kRebaseBy = int64_t(1) << 27;  // multiple of RING and ACC
static_assert(kRebaseBy % RING == 0 && kRebaseBy % ACC == 0, "rebasing must keep ring and accumulator slots");

// The worklet's ratio: an AudioParam value (float32), "if (!(r > 0)) r = 1",
// then clamped to [R_MIN, R_MAX] in double.
inline double workletRatio(double ratio) noexcept {
  double r = static_cast<double>(static_cast<float>(ratio));
  if (!(r > 0)) r = 1;
  return r < R_MIN ? R_MIN : (r > R_MAX ? R_MAX : r);
}

inline bool isFloatValue(double r) noexcept { return static_cast<double>(static_cast<float>(r)) == r; }

// JavaScript "x | 0" for the range used here (|x| < 2^31): truncation toward zero.
inline int64_t jsTrunc(double x) noexcept { return static_cast<int64_t>(x); }

}  // namespace

struct Wsola::Impl {
  float win[N];
  float ringL[RING];
  float ringR[RING];
  double mono[RING];  // ringL + ringR in double (exact): the search signal of _score
  float accL[ACC];
  float accR[ACC];
  int64_t inW = 0;
  int64_t outP = 0;
  int64_t nextG = 0;
  bool hasPrev = false;  // prevS !== null
  double prevS = 0;
  double prevR = 1;
  double pen = kDefaultPenalty;
  // search scratch (no allocation in process / prime)
  double ref4[kCoarsePts];
  double ref2[kFinePts];
  int64_t base4[kCoarsePts];
  int64_t base2[kFinePts];
  double linPh[4][kLinPhase];
  int phOf[kCoarsePts];
  int idxOf[kCoarsePts];
  double dotC[kCoarseCandsPadded];
  double enC[kCoarseCandsPadded];

  Impl() noexcept {
    // PERIODIC Hann: two windows offset by N/2 sum exactly to 1
    for (int i = 0; i < N; i++) win[i] = static_cast<float>(0.5 - 0.5 * std::cos((2 * kPi * i) / N));
    clearAll();
  }

  void clearAll() noexcept {
    std::memset(ringL, 0, sizeof(ringL));
    std::memset(ringR, 0, sizeof(ringR));
    std::memset(mono, 0, sizeof(mono));
    std::memset(accL, 0, sizeof(accL));
    std::memset(accR, 0, sizeof(accR));
    inW = 0;
    outP = 0;
    nextG = 0;
    hasPrev = false;
    prevS = 0;
    prevR = 1;
  }

  void rebaseIfNeeded() noexcept {
    if (outP < kRebaseAt) return;
    inW -= kRebaseBy;
    outP -= kRebaseBy;
    nextG -= kRebaseBy;
    prevS -= static_cast<double>(kRebaseBy);
  }

  // ---- _score(cont, s, r, step), the worklet's own arithmetic -------------------
  double scoreExact(double cont, double s, double r, int step) const noexcept {
    double dot = 0;
    double en = 1e-9;
    double er = 1e-9;
    for (int k = 0; k < OVL; k += step) {
      const int64_t pc = jsTrunc(cont + k * r);
      const int64_t ps = jsTrunc(s + k * r);
      const double ref = static_cast<double>(ringL[pc & RM]) + static_cast<double>(ringR[pc & RM]);
      const double v = static_cast<double>(ringL[ps & RM]) + static_cast<double>(ringR[ps & RM]);
      dot += v * ref;
      en += v * v;
      er += ref * ref;
    }
    return dot / std::sqrt(en * er);
  }

  // Reference part of a score (the continuation of the previous grain): the
  // values and their energy sum, accumulated in the worklet's order.
  double refPart(double cont, double r, int step, double* ref) const noexcept {
    double er = 1e-9;
    int j = 0;
    for (int k = 0; k < OVL; k += step, j++) {
      const int64_t pc = jsTrunc(cont + k * r);
      const double v = mono[pc & RM];
      ref[j] = v;
      er += v * v;
    }
    return er;
  }

  // Coarse search over d = -SEARCH..SEARCH step 4 (fast exact path). Returns best d.
  int coarseFast(double S0, double r, double cont) noexcept {
    const double er = refPart(cont, r, 4, ref4);
    // floor(S0 + k r) for k = 0, 4, ... (exact, positions >= 0)
    for (int j = 0; j < kCoarsePts; j++) base4[j] = static_cast<int64_t>(std::floor(S0 + (4 * j) * r));
    // Indices read: base4[j] + d for d = -SEARCH .. -SEARCH + 4 * (padded candidates - 1)
    const int64_t lo = base4[0] - SEARCH;  // base4 is increasing
    const int64_t hi = base4[kCoarsePts - 1] - SEARCH + 4 * (kCoarseCandsPadded - 1);
    const int span = static_cast<int>(hi - lo + 1);
    // Phase-separated copies of the mono ring (stride 4): the values of
    // consecutive candidates for one point are contiguous.
    for (int i = 0; i < span; i++) linPh[i & 3][i >> 2] = mono[(lo + i) & RM];
    for (int j = 0; j < kCoarsePts; j++) {
      const int o = static_cast<int>(base4[j] - SEARCH - lo);  // offset of candidate d = -SEARCH
      phOf[j] = o & 3;
      idxOf[j] = o >> 2;
    }
    // Score the candidates side by side: each lane is the worklet's sequential sum.
    for (int c0 = 0; c0 < kCoarseCandsPadded; c0 += kCandBlock) {
#if OM_WSOLA_SSE2
      __m128d d0 = _mm_setzero_pd(), d1 = _mm_setzero_pd(), d2 = _mm_setzero_pd(), d3 = _mm_setzero_pd();
      const __m128d e9 = _mm_set1_pd(1e-9);
      __m128d n0 = e9, n1 = e9, n2 = e9, n3 = e9;
      for (int j = 0; j < kCoarsePts; j++) {
        const double* v = &linPh[phOf[j]][idxOf[j] + c0];
        const __m128d rf = _mm_set1_pd(ref4[j]);
        const __m128d v0 = _mm_loadu_pd(v), v1 = _mm_loadu_pd(v + 2), v2 = _mm_loadu_pd(v + 4), v3 = _mm_loadu_pd(v + 6);
        d0 = _mm_add_pd(d0, _mm_mul_pd(v0, rf));
        d1 = _mm_add_pd(d1, _mm_mul_pd(v1, rf));
        d2 = _mm_add_pd(d2, _mm_mul_pd(v2, rf));
        d3 = _mm_add_pd(d3, _mm_mul_pd(v3, rf));
        n0 = _mm_add_pd(n0, _mm_mul_pd(v0, v0));
        n1 = _mm_add_pd(n1, _mm_mul_pd(v1, v1));
        n2 = _mm_add_pd(n2, _mm_mul_pd(v2, v2));
        n3 = _mm_add_pd(n3, _mm_mul_pd(v3, v3));
      }
      _mm_storeu_pd(dotC + c0, d0);
      _mm_storeu_pd(dotC + c0 + 2, d1);
      _mm_storeu_pd(dotC + c0 + 4, d2);
      _mm_storeu_pd(dotC + c0 + 6, d3);
      _mm_storeu_pd(enC + c0, n0);
      _mm_storeu_pd(enC + c0 + 2, n1);
      _mm_storeu_pd(enC + c0 + 4, n2);
      _mm_storeu_pd(enC + c0 + 6, n3);
#else
      double dd[kCandBlock] = {0, 0, 0, 0, 0, 0, 0, 0};
      double nn[kCandBlock] = {1e-9, 1e-9, 1e-9, 1e-9, 1e-9, 1e-9, 1e-9, 1e-9};
      for (int j = 0; j < kCoarsePts; j++) {
        const double* v = &linPh[phOf[j]][idxOf[j] + c0];
        const double rf = ref4[j];
        for (int c = 0; c < kCandBlock; c++) {
          dd[c] += v[c] * rf;
          nn[c] += v[c] * v[c];
        }
      }
      for (int c = 0; c < kCandBlock; c++) {
        dotC[c0 + c] = dd[c];
        enC[c0 + c] = nn[c];
      }
#endif
    }
    int best = 0;
    double bestS = -std::numeric_limits<double>::infinity();
    for (int c = 0; c < kCoarseCands; c++) {
      const int d = -SEARCH + 4 * c;
      const double sc = dotC[c] / std::sqrt(enC[c] * er) - (pen * (d < 0 ? -d : d)) / SEARCH;
      if (sc > bestS) {
        bestS = sc;
        best = d;
      }
    }
    return best;
  }

  // Fine search d = best-3 .. best+3 step 1, scores at step 2, no penalty (fast exact path).
  int fineFast(double S0, double r, double cont, int best) noexcept {
    const double er = refPart(cont, r, 2, ref2);
    for (int j = 0; j < kFinePts; j++) base2[j] = static_cast<int64_t>(std::floor(S0 + (2 * j) * r));
    double dd[kCandBlock] = {0, 0, 0, 0, 0, 0, 0, 0};
    double nn[kCandBlock] = {1e-9, 1e-9, 1e-9, 1e-9, 1e-9, 1e-9, 1e-9, 1e-9};
    const int64_t d0 = best - 3;
#if OM_WSOLA_SSE2
    __m128d a0 = _mm_setzero_pd(), a1 = _mm_setzero_pd(), a2 = _mm_setzero_pd(), a3 = _mm_setzero_pd();
    const __m128d e9 = _mm_set1_pd(1e-9);
    __m128d b0 = e9, b1 = e9, b2 = e9, b3 = e9;
    for (int j = 0; j < kFinePts; j++) {
      // 8 consecutive candidates (7 used): contiguous in the ring unless they wrap
      const int64_t i0 = base2[j] + d0;
      double v[kCandBlock];
      const int64_t m0 = i0 & RM;
      if (m0 + kCandBlock <= RING) {
        std::memcpy(v, mono + m0, sizeof(v));
      } else {
        for (int c = 0; c < kCandBlock; c++) v[c] = mono[(i0 + c) & RM];
      }
      const __m128d rf = _mm_set1_pd(ref2[j]);
      const __m128d v0 = _mm_loadu_pd(v), v1 = _mm_loadu_pd(v + 2), v2 = _mm_loadu_pd(v + 4), v3 = _mm_loadu_pd(v + 6);
      a0 = _mm_add_pd(a0, _mm_mul_pd(v0, rf));
      a1 = _mm_add_pd(a1, _mm_mul_pd(v1, rf));
      a2 = _mm_add_pd(a2, _mm_mul_pd(v2, rf));
      a3 = _mm_add_pd(a3, _mm_mul_pd(v3, rf));
      b0 = _mm_add_pd(b0, _mm_mul_pd(v0, v0));
      b1 = _mm_add_pd(b1, _mm_mul_pd(v1, v1));
      b2 = _mm_add_pd(b2, _mm_mul_pd(v2, v2));
      b3 = _mm_add_pd(b3, _mm_mul_pd(v3, v3));
    }
    _mm_storeu_pd(dd, a0);
    _mm_storeu_pd(dd + 2, a1);
    _mm_storeu_pd(dd + 4, a2);
    _mm_storeu_pd(dd + 6, a3);
    _mm_storeu_pd(nn, b0);
    _mm_storeu_pd(nn + 2, b1);
    _mm_storeu_pd(nn + 4, b2);
    _mm_storeu_pd(nn + 6, b3);
#else
    for (int j = 0; j < kFinePts; j++) {
      const int64_t i0 = base2[j] + d0;
      const double rf = ref2[j];
      for (int c = 0; c < kCandBlock; c++) {
        const double v = mono[(i0 + c) & RM];
        dd[c] += v * rf;
        nn[c] += v * v;
      }
    }
#endif
    int fine = best;
    double fineS = -std::numeric_limits<double>::infinity();
    for (int c = 0; c < 7; c++) {
      const double sc = dd[c] / std::sqrt(nn[c] * er);
      if (sc > fineS) {
        fineS = sc;
        fine = best - 3 + c;
      }
    }
    return fine;
  }

  // The worklet's search (coarse step 4 over the window, then fine at 1/1).
  double search(double S0, double r, double cont) noexcept {
    // Fast exact path when every position is >= 0 and the arithmetic is exact
    // (float32 ratio); otherwise the worklet's per-point arithmetic.
    const bool fast = isFloatValue(r) && S0 - SEARCH - 4 >= 0;
    if (fast) {
      const int best = coarseFast(S0, r, cont);
      const int fine = fineFast(S0, r, cont, best);
      return S0 + fine;
    }
    int best = 0;
    double bestS = -std::numeric_limits<double>::infinity();
    for (int d = -SEARCH; d <= SEARCH; d += 4) {
      const double sc = scoreExact(cont, S0 + d, r, 4) - (pen * (d < 0 ? -d : d)) / SEARCH;
      if (sc > bestS) {
        bestS = sc;
        best = d;
      }
    }
    int fine = best;
    double fineS = -std::numeric_limits<double>::infinity();
    for (int d = best - 3; d <= best + 3; d++) {
      const double sc = scoreExact(cont, S0 + d, r, 2);
      if (sc > fineS) {
        fineS = sc;
        fine = d;
      }
    }
    return S0 + fine;
  }

  // _grain(G, r), writing only grain samples k in [kFrom, N).
  void grain(int64_t G, double r, int kFrom = 0) noexcept {
    // "Ideal" position: the grain's center comes out LAT later
    const double S0 = static_cast<double>(G - LAT) - (N * (r - 1)) / 2;
    double S = S0;
    if (hasPrev) {
      const double cont = prevS + HS * prevR;
      if (std::fabs(r - 1) < 1e-4 && std::fabs(prevR - 1) < 1e-4 && std::fabs(cont - S0) < 0.5) {
        S = S0;  // nothing to shift: plain exact delay, no search
      } else {
        S = search(S0, r, cont);
      }
    }
    for (int k = kFrom; k < N; k++) {
      const double p = S + k * r;
      const double fi0 = std::floor(p);
      const double fr = p - fi0;
      const int64_t i0 = static_cast<int64_t>(fi0);
      const int64_t j0 = i0 & RM;
      const int64_t j1 = (i0 + 1) & RM;
      const int64_t o = (G + k) & AM;
      const double w = win[k];
      const double l0 = ringL[j0], r0 = ringR[j0];
      accL[o] = static_cast<float>(static_cast<double>(accL[o]) + (l0 + (static_cast<double>(ringL[j1]) - l0) * fr) * w);
      accR[o] = static_cast<float>(static_cast<double>(accR[o]) + (r0 + (static_cast<double>(ringR[j1]) - r0) * fr) * w);
    }
    prevS = S;
    prevR = r;
    hasPrev = true;
  }
};

Wsola::Wsola() : impl_(new Impl()) {}
Wsola::~Wsola() = default;

void Wsola::reset() noexcept { impl_->clearAll(); }

void Wsola::setPenalty(double pen) noexcept { impl_->pen = pen; }

void Wsola::process(const float* inL, const float* inR, float* outL, float* outR, int n, double ratio) noexcept {
  Impl& w = *impl_;
  if (n <= 0) return;
  const double r = workletRatio(ratio);
  // 1) Input -> rings
  if (!inR) inR = inL;
  for (int i = 0; i < n; i++) {
    const int64_t p = (w.inW + i) & RM;
    const float l = inL ? inL[i] : 0.0f;
    const float rr = inR ? inR[i] : 0.0f;
    w.ringL[p] = l;
    w.ringR[p] = rr;
    w.mono[p] = static_cast<double>(l) + static_cast<double>(rr);
  }
  w.inW += n;
  // 2) Grains needed to cover this output block
  while (w.nextG < w.outP + n) {
    w.grain(w.nextG, r);
    w.nextG += HS;
  }
  // 3) Output, and reset of the consumed slots
  for (int i = 0; i < n; i++) {
    const int64_t o = (w.outP + i) & AM;
    outL[i] = w.accL[o];
    if (outR) outR[i] = w.accR[o];
    w.accL[o] = 0;
    w.accR[o] = 0;
  }
  w.outP += n;
  w.rebaseIfNeeded();
}

void Wsola::prime(const float* histL, const float* histR, double ratio) noexcept {
  Impl& w = *impl_;
  const double r = workletRatio(ratio);
  if (!histR) histR = histL;
  // Lockstep: one output frame per input frame. Positive positions (the
  // search's fast path) once the counters are past one ring.
  int64_t g0 = w.outP > w.inW ? w.outP : w.inW;
  if (g0 < RING) g0 = RING;
  w.inW = g0;
  w.outP = g0;
  for (int j = 0; j < kPrimeFrames; j++) {
    const int64_t p = (g0 - kPrimeFrames + j) & RM;
    const float l = histL ? histL[j] : 0.0f;
    const float rr = histR ? histR[j] : 0.0f;
    w.ringL[p] = l;
    w.ringR[p] = rr;
    w.mono[p] = static_cast<double>(l) + static_cast<double>(rr);
  }
  std::memset(w.accL, 0, sizeof(w.accL));
  std::memset(w.accR, 0, sizeof(w.accR));
  // The grain at G0 - HS, placed without search: only its second half
  // (outputs >= G0) is ever heard.
  w.hasPrev = false;
  w.grain(g0 - HS, r, HS);
  // The grain at G0, aligned on it with one search.
  w.grain(g0, r);
  w.nextG = g0 + HS;
}

int64_t Wsola::inputFrames() const noexcept { return impl_->inW; }
int64_t Wsola::outputFrames() const noexcept { return impl_->outP; }

}  // namespace om
