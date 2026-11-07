// Private FFT of the fx module (owner: fx): radix-2 complex FFT on split
// float arrays (SSE2 butterflies on x86 / x64, scalar elsewhere), the packed
// real FFT on top of it, the packed complex multiply-accumulate of the
// partitioned convolver, and a double-precision FFT for table building.
// Real-time safe once constructed (no allocation in any transform).
#include "fft.h"

#include <cmath>
#include <utility>

#if defined(__SSE2__) || defined(_M_X64) || (defined(_M_IX86_FP) && _M_IX86_FP >= 2)
#define OM_FX_SSE2 1
#include <emmintrin.h>
#endif

namespace om {
namespace fx {

namespace {
constexpr double kPiD = 3.14159265358979323846;
int log2Of(int n) noexcept {
  int k = 0;
  while ((1 << k) < n) k++;
  return k;
}
}  // namespace

RealFft::RealFft(int points) : m_(points), l_(points / 2) {
  const int L = l_;
  const int bits = log2Of(L);
  for (int i = 0; i < L; i++) {
    int r = 0;
    for (int b = 0; b < bits; b++)
      if (i & (1 << b)) r |= 1 << (bits - 1 - b);
    if (i < r) {
      swaps_.push_back(i);
      swaps_.push_back(r);
    }
  }
  twRe_.assign(static_cast<size_t>(L), 0.0f);
  twIm_.assign(static_cast<size_t>(L), 0.0f);
  for (int h = 1; h < L; h *= 2) {
    for (int j = 0; j < h; j++) {
      const double a = -kPiD * j / h;
      twRe_[static_cast<size_t>(h - 1 + j)] = static_cast<float>(std::cos(a));
      twIm_[static_cast<size_t>(h - 1 + j)] = static_cast<float>(std::sin(a));
    }
  }
  postC_.resize(static_cast<size_t>(L / 2 + 1));
  postS_.resize(static_cast<size_t>(L / 2 + 1));
  for (int k = 0; k <= L / 2; k++) {
    const double a = 2.0 * kPiD * k / m_;
    postC_[static_cast<size_t>(k)] = static_cast<float>(std::cos(a));
    postS_[static_cast<size_t>(k)] = static_cast<float>(std::sin(a));
  }
}

void RealFft::complexForward(float* re, float* im) const noexcept {
  const int L = l_;
  const int* s = swaps_.data();
  const size_t ns = swaps_.size();
  for (size_t p = 0; p < ns; p += 2) {
    const int i = s[p], j = s[p + 1];
    std::swap(re[i], re[j]);
    std::swap(im[i], im[j]);
  }
  // Stages h = 1 and h = 2 as one radix-4 pass (twiddles 1 and -i).
  for (int g = 0; g < L; g += 4) {
    const float r0 = re[g], r1 = re[g + 1], r2 = re[g + 2], r3 = re[g + 3];
    const float i0 = im[g], i1 = im[g + 1], i2 = im[g + 2], i3 = im[g + 3];
    const float a0r = r0 + r1, a0i = i0 + i1, a1r = r0 - r1, a1i = i0 - i1;
    const float a2r = r2 + r3, a2i = i2 + i3, a3r = r2 - r3, a3i = i2 - i3;
    re[g] = a0r + a2r;
    im[g] = a0i + a2i;
    re[g + 2] = a0r - a2r;
    im[g + 2] = a0i - a2i;
    re[g + 1] = a1r + a3i;
    im[g + 1] = a1i - a3r;
    re[g + 3] = a1r - a3i;
    im[g + 3] = a1i + a3r;
  }
  for (int h = 4; h < L; h *= 2) {
    const float* wr = twRe_.data() + (h - 1);
    const float* wi = twIm_.data() + (h - 1);
    for (int st = 0; st < L; st += 2 * h) {
      float* ar = re + st;
      float* ai = im + st;
      float* br = ar + h;
      float* bi = ai + h;
#if defined(OM_FX_SSE2)
      for (int j = 0; j < h; j += 4) {
        const __m128 xr = _mm_loadu_ps(br + j), xi = _mm_loadu_ps(bi + j);
        const __m128 cr = _mm_loadu_ps(wr + j), ci = _mm_loadu_ps(wi + j);
        const __m128 tr = _mm_sub_ps(_mm_mul_ps(xr, cr), _mm_mul_ps(xi, ci));
        const __m128 ti = _mm_add_ps(_mm_mul_ps(xr, ci), _mm_mul_ps(xi, cr));
        const __m128 ur = _mm_loadu_ps(ar + j), ui = _mm_loadu_ps(ai + j);
        _mm_storeu_ps(ar + j, _mm_add_ps(ur, tr));
        _mm_storeu_ps(ai + j, _mm_add_ps(ui, ti));
        _mm_storeu_ps(br + j, _mm_sub_ps(ur, tr));
        _mm_storeu_ps(bi + j, _mm_sub_ps(ui, ti));
      }
#else
      for (int j = 0; j < h; j++) {
        const float tr = br[j] * wr[j] - bi[j] * wi[j];
        const float ti = br[j] * wi[j] + bi[j] * wr[j];
        const float ur = ar[j], ui = ai[j];
        ar[j] = ur + tr;
        ai[j] = ui + ti;
        br[j] = ur - tr;
        bi[j] = ui - ti;
      }
#endif
    }
  }
}

void RealFft::forward(const float* in, float* re, float* im) const noexcept {
  const int L = l_;
  for (int n = 0; n < L; n++) {
    re[n] = in[2 * n];
    im[n] = in[2 * n + 1];
  }
  complexForward(re, im);
  const float z0r = re[0], z0i = im[0];
  re[0] = z0r + z0i;  // DC
  im[0] = z0r - z0i;  // Nyquist
  for (int k = 1; k < L / 2; k++) {
    const int l = L - k;
    const float zkr = re[k], zki = im[k], zlr = re[l], zli = im[l];
    const float er = 0.5f * (zkr + zlr), ei = 0.5f * (zki - zli);
    const float orr = 0.5f * (zki + zli), oi = -0.5f * (zkr - zlr);
    const float c = postC_[static_cast<size_t>(k)], s = postS_[static_cast<size_t>(k)];
    const float wr = c * orr + s * oi, wi = c * oi - s * orr;  // e^{-2 pi i k / M} * O
    re[k] = er + wr;
    im[k] = ei + wi;
    re[l] = er - wr;
    im[l] = wi - ei;
  }
  im[L / 2] = -im[L / 2];  // X[L/2] = conj(Z[L/2])
}

void RealFft::inverse(float* re, float* im, float* out) const noexcept {
  const int L = l_;
  const float dc = re[0], ny = im[0];
  re[0] = 0.5f * (dc + ny);
  im[0] = 0.5f * (dc - ny);
  for (int k = 1; k < L / 2; k++) {
    const int l = L - k;
    const float xkr = re[k], xki = im[k], xlr = re[l], xli = im[l];
    const float er = 0.5f * (xkr + xlr), ei = 0.5f * (xki - xli);
    const float dr = 0.5f * (xkr - xlr), di = 0.5f * (xki + xli);
    const float c = postC_[static_cast<size_t>(k)], s = postS_[static_cast<size_t>(k)];
    const float orr = dr * c - di * s, oi = dr * s + di * c;  // O = D * e^{+2 pi i k / M}
    re[k] = er - oi;
    im[k] = ei + orr;
    re[l] = er + oi;
    im[l] = orr - ei;
  }
  im[L / 2] = -im[L / 2];
  complexForward(im, re);  // swapped arrays: unnormalized inverse
  for (int n = 0; n < L; n++) {
    out[2 * n] = re[n];
    out[2 * n + 1] = im[n];
  }
}

void complexMacPacked(float* accRe, float* accIm, const float* xRe, const float* xIm, const float* hRe,
                      const float* hIm, int n) noexcept {
  const float dc = accRe[0] + xRe[0] * hRe[0];
  const float ny = accIm[0] + xIm[0] * hIm[0];
#if defined(OM_FX_SSE2)
  for (int k = 0; k < n; k += 4) {
    const __m128 ar = _mm_loadu_ps(xRe + k), ai = _mm_loadu_ps(xIm + k);
    const __m128 br = _mm_loadu_ps(hRe + k), bi = _mm_loadu_ps(hIm + k);
    __m128 cr = _mm_loadu_ps(accRe + k), ci = _mm_loadu_ps(accIm + k);
    cr = _mm_add_ps(cr, _mm_sub_ps(_mm_mul_ps(ar, br), _mm_mul_ps(ai, bi)));
    ci = _mm_add_ps(ci, _mm_add_ps(_mm_mul_ps(ar, bi), _mm_mul_ps(ai, br)));
    _mm_storeu_ps(accRe + k, cr);
    _mm_storeu_ps(accIm + k, ci);
  }
#else
  for (int k = 0; k < n; k++) {
    const float ar = xRe[k], ai = xIm[k], br = hRe[k], bi = hIm[k];
    accRe[k] += ar * br - ai * bi;
    accIm[k] += ar * bi + ai * br;
  }
#endif
  accRe[0] = dc;
  accIm[0] = ny;
}

void fftDouble(double* re, double* im, int n, bool inverse) {
  for (int i = 1, j = 0; i < n; i++) {
    int bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      std::swap(re[i], re[j]);
      std::swap(im[i], im[j]);
    }
  }
  for (int len = 2; len <= n; len <<= 1) {
    const double ang = (inverse ? 2.0 : -2.0) * kPiD / len;
    const int h = len / 2;
    for (int j = 0; j < h; j++) {
      const double wr = std::cos(ang * j), wi = std::sin(ang * j);
      for (int s = 0; s < n; s += len) {
        const int a = s + j, b = a + h;
        const double tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
      }
    }
  }
}

}  // namespace fx
}  // namespace om
