// AudioParam emulation of the mixer (owner: mixer, private header): the
// exact per-frame values Chromium gives an AudioParam driven by
// setTargetAtTime(target, now, tau) (engine.js smooths every gain and EQ
// knob that way) and by `.value = x`. A port of AudioParamTimeline::
// ProcessSetTarget as Chromium runs it on x86 (the Web engine's platform),
// pinned against Chromium's own renders (golden suites strip/*, master/*:
// residuals ~ -150 dBFS, where a plain serial recursion is off by -99 dBFS):
//  - an event at time t starts at frame ceil(t x rate) (double arithmetic:
//    t = frame / rate is not exact, so some frames, 60160 at 48 kHz, start
//    one frame late — Chromium's own artefact, reproduced);
//  - the time constant is kept as a float; c0 = 1 - exp(-1 / (rate x tau))
//    rounded to float;
//  - Chromium processes an automation in "calls": at the event's first frame
//    and at every 128-frame render quantum boundary. A call computes its
//    first value (at the event start: target + (v - target) x
//    exp(-(t_frame - t0) / tau), i.e. the previous value; afterwards one
//    recursion step v + (target - v) x c0 from the last written value),
//    tests convergence on it — 10 time constants elapsed (>), or |v - target|
//    < e^-10 |target|, or |v| < e^-10 for a target 0 — and if converged
//    writes the target for the whole call (the param is then constant);
//  - otherwise the call's frames come in groups of 4 from a base value b
//    (Chromium's SSE loop): b, b + d c0, b + d c1, b + d c2 with d = target
//    - b, c1 = c0 (2 - c0), c2 = c0 ((c0 - 3) c0 + 3), and the next base
//    b + d c3, c3 = c0 (c0 ((4 - c0) c0 - 6) + 4) (all in float); the frames
//    left after the last whole group are serial steps;
//  - a new event whose time is exactly a render quantum start, while a
//    setTarget is still running: Chromium runs the old event once more
//    there for zero frames, which advances the carried value by one serial
//    step of the OLD automation; the new event's first frame holds that
//    value (a retarget elsewhere holds the last value as is);
//  - `.value = x` (setValueAtTime) gives x from its start frame on;
//  - a param whose node is not pulled is not computed (fill() is not called
//    for those frames: the mixer's send freezes): a running automation
//    resumes from its last value; an event whose start frame passed
//    meanwhile starts at the first processed frame, value unchanged, its
//    10-time-constant clock from there (measured in Chromium by the fx
//    module, src/fx/fx_dsp.h; pinned by goldens/mixer c*_color_sends).
// The 128-frame quantum grid is the mixer's own frame counter, so the
// values do not depend on the device block sizes. Real-time safe.
#pragma once

#include <cmath>
#include <cstdint>

namespace om {
namespace mixer_detail {

class AParam {
 public:
  static constexpr double kConverge = 4.539992976248485e-05;  // exp(-10): Chromium kSetTargetThreshold (and zero threshold)
  static constexpr double kTimeConstants = 10.0;              // Chromium kTimeConstantsToConverge
  static constexpr int kQuantum = 128;

  void prepare(double sampleRate) noexcept { sr_ = sampleRate > 0 ? sampleRate : 48000.0; }

  // Intrinsic value, no automation (construction, resets).
  void reset(float v) noexcept {
    v_ = v;
    t_ = v;
    moving_ = false;
    pending_ = Pending::None;
  }

  // AudioParam.setTargetAtTime(target, frame / rate, tau), issued before
  // `frame` (the next frame to be processed) is rendered.
  void setTarget(float target, double tauSec, int64_t frame) noexcept {
    if (pending_ == Pending::None && !moving_ && v_ == target) return;  // converges at its first frame
    if (!(tauSec > 0)) {
      setValue(target, frame);
      return;
    }
    pending_ = Pending::Target;
    pT_ = target;
    pTau_ = static_cast<double>(static_cast<float>(tauSec));  // AudioParamTimeline keeps a float
    pTime_ = static_cast<double>(frame) / sr_;
    pFrame_ = startFrame(pTime_, frame);
  }

  // AudioParam.value = x (setValueAtTime(x, frame / rate)).
  void setValue(float x, int64_t frame) noexcept {
    pending_ = Pending::Value;
    pT_ = x;
    pTime_ = static_cast<double>(frame) / sr_;
    pFrame_ = startFrame(pTime_, frame);
  }

  // Constant over the next frames (no automation running or pending).
  bool idle() const noexcept { return !moving_ && pending_ == Pending::None; }
  // Value of the last processed frame (AudioParam.value as read by engine.js).
  float value() const noexcept { return v_; }
  // Where the automation goes (the pending one when there is one).
  float target() const noexcept { return pending_ != Pending::None ? pT_ : t_; }
  // idle() and exactly x: callers skip a multiplication by 1 or a send at 0.
  bool constantAt(float x) const noexcept { return idle() && v_ == x; }

  // Values of frames [f0, f0 + n): out may be nullptr (advance only).
  void fill(float* out, int n, int64_t f0) noexcept {
    const int64_t stop = f0 + n;
    int64_t f = f0;
    while (f < stop) {
      if (pending_ != Pending::None && f >= pFrame_) applyPending(f);
      int64_t end = stop;
      if (pending_ != Pending::None && pFrame_ < end) end = pFrame_;
      if (!moving_) {
        if (out)
          for (int64_t k = f; k < end; k++) out[k - f0] = v_;
        f = end;
        continue;
      }
      if (f >= callEnd_) {
        beginCall(f, false);  // a new render quantum
        continue;             // (converged: the constant branch writes the target)
      }
      if (callEnd_ < end) end = callEnd_;
      for (int64_t k = f; k < end; k++) {
        float x;
        if (k < groupsEnd_) {
          const int64_t lane = (k - callStart_) & 3;
          if (lane == 0) {
            gBase_ = run_;
            gDelta_ = t_ - run_;
            x = gBase_;
            run_ = gBase_ + gDelta_ * c3_;
          } else {
            x = gBase_ + gDelta_ * (lane == 1 ? c0_ : (lane == 2 ? c1_ : c2_));
          }
        } else {
          x = run_;
          run_ = run_ + (t_ - run_) * c0_;
        }
        v_ = x;
        if (out) out[k - f0] = x;
      }
      f = end;
    }
  }

 private:
  enum class Pending : uint8_t { None, Target, Value };

  // First frame of an event at time t: ceil(t x rate), never before `frame`.
  int64_t startFrame(double t, int64_t frame) const noexcept {
    const int64_t s = static_cast<int64_t>(std::ceil(t * sr_));
    return s > frame ? s : frame;
  }

  void applyPending(int64_t f) noexcept {
    const Pending p = pending_;
    pending_ = Pending::None;
    if (f > pFrame_) {
      // First computed late (frozen while its frame passed): it starts here,
      // from the current value.
      pTime_ = static_cast<double>(f) / sr_;
    } else if (moving_ && f % kQuantum == 0 && pTime_ >= static_cast<double>(f) / sr_) {
      // The old setTarget re-run for zero frames at a quantum start that is
      // exactly the new event's time (see the header comment).
      v_ = v_ + (t_ - v_) * c0_;
    }
    if (p == Pending::Value) {
      v_ = pT_;
      t_ = pT_;
      moving_ = false;
      return;
    }
    t_ = pT_;
    tau_ = pTau_;
    start_ = pTime_;
    c0_ = static_cast<float>(1.0 - std::exp(-1.0 / (sr_ * tau_)));
    c1_ = c0_ * (2.0f - c0_);
    c2_ = c0_ * ((c0_ - 3.0f) * c0_ + 3.0f);
    c3_ = c0_ * (c0_ * ((4.0f - c0_) * c0_ - 6.0f) + 4.0f);
    moving_ = true;
    beginCall(f, true);
  }

  // Start of a call at frame f: its first value and the convergence test.
  void beginCall(int64_t f, bool eventStart) noexcept {
    const double now = static_cast<double>(f) / sr_;
    float value;
    if (eventStart)
      value = static_cast<float>(static_cast<double>(t_) +
                                 (static_cast<double>(v_) - static_cast<double>(t_)) * std::exp(-(now - start_) / tau_));
    else
      value = v_ + (t_ - v_) * c0_;
    const bool byTime = now > start_ + kTimeConstants * tau_;
    const bool byValue = t_ == 0.0f ? std::fabs(value) < kConverge
                                    : std::fabs(t_ - value) < kConverge * std::fabs(static_cast<double>(t_));
    if (byTime || byValue) {
      v_ = t_;
      moving_ = false;
      return;
    }
    callStart_ = f;
    callEnd_ = (f / kQuantum + 1) * kQuantum;
    groupsEnd_ = f + ((callEnd_ - f) / 4) * 4;
    run_ = value;
  }

  double sr_ = 48000.0;
  float v_ = 0.0f;       // value of the last processed frame
  float t_ = 0.0f;       // target of the running automation
  float c0_ = 1.0f, c1_ = 1.0f, c2_ = 1.0f, c3_ = 1.0f;
  double tau_ = 0.0;     // seconds (a float's value)
  double start_ = 0.0;   // event time (s)
  bool moving_ = false;
  // the current call [callStart_, callEnd_): groups of 4 up to groupsEnd_
  int64_t callStart_ = 0, callEnd_ = 0, groupsEnd_ = 0;
  float run_ = 0.0f;     // Chromium's running value inside the call
  float gBase_ = 0.0f, gDelta_ = 0.0f;
  Pending pending_ = Pending::None;
  float pT_ = 0.0f;
  double pTau_ = 0.0;
  double pTime_ = 0.0;
  int64_t pFrame_ = 0;
};

}  // namespace mixer_detail
}  // namespace om
