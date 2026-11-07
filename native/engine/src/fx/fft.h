// Private FFT of the fx module (owner: fx): a radix-2 complex FFT on split
// (re / im) float arrays with SSE2 butterflies where available, the real FFT
// built on it (packed DC / Nyquist), and a double-precision complex FFT used
// off the audio thread to build band-limited oscillator tables. Written here
// (no download, MIT). Plans are immutable once built and may be shared by any
// number of convolvers on any thread.
#pragma once

#include <vector>

namespace om {
namespace fx {

// Real FFT of M = 2L points (L a power of two, L >= 4) in float.
//  forward(): X = DFT(x) (unnormalized), written as L complex bins in split
//    arrays: re[k] / im[k] for 1 <= k < L, and the two real bins packed in bin
//    0: re[0] = X[0] (DC), im[0] = X[L] (Nyquist).
//  inverse(): from that packed layout back to M samples scaled by L
//    (inverse(forward(x)) == L * x). re / im are used as work space.
class RealFft {
 public:
  explicit RealFft(int points);  // control thread (allocates the tables)
  int points() const noexcept { return m_; }
  int bins() const noexcept { return l_; }
  void forward(const float* in, float* re, float* im) const noexcept;
  void inverse(float* re, float* im, float* out) const noexcept;

  // Complex FFT of L points in place, unnormalized, e^{-i} kernel. The
  // inverse (e^{+i}, unnormalized) is complexForward(im, re).
  void complexForward(float* re, float* im) const noexcept;

 private:
  int m_ = 0, l_ = 0;
  std::vector<int> swaps_;          // bit-reversal pairs (i, j), i < j
  std::vector<float> twRe_, twIm_;  // per stage h (1, 2, 4 ... L/2): e^{-i pi j / h} at [h - 1 + j]
  std::vector<float> postC_, postS_;  // cos / sin(2 pi k / M), k = 0 .. L/2
};

// Complex FFT in double (radix 2, in place, n a power of two), e^{-i} kernel
// when !inverse, e^{+i} (unnormalized) when inverse. Off the audio thread.
void fftDouble(double* re, double* im, int n, bool inverse);

// Element-wise complex multiply-accumulate on split arrays, the convolution
// kernel of the partitioned convolver: acc += x * h for n bins (n multiple of
// 4), with bin 0 holding the packed real DC / Nyquist pair (multiplied as two
// real numbers).
void complexMacPacked(float* accRe, float* accIm, const float* xRe, const float* xIm, const float* hRe,
                      const float* hIm, int n) noexcept;

}  // namespace fx
}  // namespace om
