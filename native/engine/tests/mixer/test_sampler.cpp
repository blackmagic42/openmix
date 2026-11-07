// Tests of the sampler (owner: mixer): AudioBufferSourceNode playback
// (exact copy at the device rate, linear interpolation at another rate with
// Chromium's end-of-buffer extrapolation, against Chromium's renders of the
// golden suite source/* when OM_GOLDEN_DIR is set), 16 voices with the
// oldest stolen (5 ms fade), stop = 2 ms fade, a reused voice id, armed
// triggers that wait for chunk 0 (<= 250 ms on the sample clock) or are
// dropped and counted, slot replacement, stopAll. SPEC.md §10.9.
#include <cmath>
#include <memory>
#include <vector>

#include "mixer_test_util.h"
#include "om/media.h"
#include "om/rt.h"
#include "om/sampler.h"

using namespace om;

namespace {

// A sound of `frames` stereo frames at `rate`; chunks published unless `publish` is false.
std::unique_ptr<TrackBuffer> sound(const std::vector<float>& l, const std::vector<float>& r, int rate,
                                   bool publish = true, PcmFormat fmt = PcmFormat::F32) {
  const int64_t frames = static_cast<int64_t>(l.size());
  auto tb = TrackBuffer::allocate(7, PcmKind::Sample, fmt, rate, frames, fmt == PcmFormat::S16 ? 1.0f : 0.0f);
  if (!tb) return nullptr;
  if (!publish) return tb;
  for (int64_t c = 0; c < tb->numChunks; c++) {
    const int64_t start = c * TrackBuffer::kChunkFrames;
    const int64_t n = tb->chunkFramesOf(c);
    if (fmt == PcmFormat::F32) {
      std::vector<float> inter(static_cast<size_t>(n) * 2);
      for (int64_t i = 0; i < n; i++) {
        inter[static_cast<size_t>(2 * i)] = l[static_cast<size_t>(start + i)];
        inter[static_cast<size_t>(2 * i + 1)] = r[static_cast<size_t>(start + i)];
      }
      tb->writeChunkRaw(start, inter.data(), inter.size() * sizeof(float), 1.0f);
    } else {
      std::vector<int16_t> inter(static_cast<size_t>(n) * 2);
      for (int64_t i = 0; i < n; i++) {
        inter[static_cast<size_t>(2 * i)] = static_cast<int16_t>(std::lround(l[static_cast<size_t>(start + i)] * 32767));
        inter[static_cast<size_t>(2 * i + 1)] = static_cast<int16_t>(std::lround(r[static_cast<size_t>(start + i)] * 32767));
      }
      tb->writeChunkRaw(start, inter.data(), inter.size() * sizeof(int16_t), 1.0f / 32767.0f);
    }
  }
  return tb;
}

// Renders `frames` of the sampler (fresh zeroed output, irregular blocks).
struct Run {
  Sampler& s;
  double rate = 48000;
  int64_t pos = 0;
  int k = 0;
  BlockClock clock() const {
    BlockClock c;
    c.frame = pos;
    c.sampleRate = rate;
    c.sampleTime = static_cast<double>(pos) / rate;
    return c;
  }
  void render(std::vector<float>& l, std::vector<float>& r, int64_t frames, bool regular = false) {
    l.assign(static_cast<size_t>(frames), 0.0f);
    r.assign(static_cast<size_t>(frames), 0.0f);
    int64_t done = 0;
    while (done < frames) {
      int n = regular ? 128 : mixtest::blockSize(k++);
      if (done + n > frames) n = static_cast<int>(frames - done);
      BlockClock c = clock();
      c.frames = n;
      {
        rt::Scope rts;
        s.render(l.data() + done, r.data() + done, n, c);
      }
      pos += n;
      done += n;
    }
  }
};

}  // namespace

// A voice = AudioBufferSourceNode(buffer).start() at playbackRate 1, whose
// total rate is bufferRate / contextRate. The golden suite source/* renders
// AudioBufferSourceNodes; the cases whose total rate the sampler can express
// exactly are replayed with a sound declared at rate x 48000 (Chromium's
// pitch rate = bufferRate / contextRate x playbackRate, the same double).
OM_TEST(mixer_sampler_null_vs_chromium_buffer_source) {
  struct Case {
    const char* name;
    double playbackRate;  // the golden's (exact in float)
  } cases[] = {{"rate_1_exact_copy", 1.0}, {"filerate_44100_rate_1", 1.0}, {"play_past_the_end", 1.25},
               {"rate_0.75", 0.75}, {"rate_0.5", 0.5}};
  for (const Case& c : cases) {
    const mixtest::Golden g = mixtest::loadGolden("source", c.name);
    MIXTEST_REQUIRE_GOLDEN(g);
    const om::json::Value& su = g.meta["setup"].at(0);
    OM_CHECK(su["playbackRate"].asNumber(0) == c.playbackRate && !su["loop"].asBool(true) &&
             su["start"]["offset"].asNumber(1) == 0 && su["start"]["when"].asNumber(1) == 0);
    const int bufferRate = static_cast<int>(su["bufferRate"].asNumber(48000));
    const int declared = static_cast<int>(bufferRate * c.playbackRate);  // 60000 for 1.25, 36000 for 0.75...
    OM_CHECK(static_cast<double>(declared) / 48000.0 == bufferRate / 48000.0 * c.playbackRate);
    const auto inL = mixtest::channel(g.input, 0), inR = mixtest::channel(g.input, 1);
    OM_CHECK(static_cast<double>(inL.size()) == su["bufferFrames"].asNumber(0));
    auto tb = sound(inL, inR, declared);
    OM_CHECK(tb != nullptr);
    Sampler s;
    s.prepare(48000, kMaxBlockFrames);
    s.attach(0, tb.get());
    Run run{s};
    s.play(0, 1, 1.0f, run.clock());
    std::vector<float> l, r;
    run.render(l, r, g.out.frames());
    const double res = mixtest::residualStereo(l, r, g.out);
    std::printf("    source/%s (sound at %d Hz): residual %.1f dBFS\n", c.name, declared, res);
    OM_CHECK(res < -80.0);
    s.attach(0, nullptr);
  }
}

OM_TEST(mixer_sampler_rate_exact_copy_and_end) {
  Sampler s;
  s.prepare(48000, kMaxBlockFrames);
  const auto l = mixtest::noise(30000, 0.5f, 5), r = mixtest::noise(30000, 0.5f, 6);
  auto tb = sound(l, r, 48000);
  s.attach(3, tb.get());
  OM_CHECK(s.loaded(3) && !s.loaded(2));
  Run run{s};
  s.play(3, 10, 1.0f, run.clock());
  OM_CHECK(s.activeVoices() == 1);
  std::vector<float> ol, orr;
  run.render(ol, orr, 40000);
  bool exact = true;
  for (size_t i = 0; i < 30000; i++) exact &= ol[i] == l[i] && orr[i] == r[i];
  OM_CHECK(exact);                         // playbackRate 1 at the device rate: exact copy
  OM_CHECK(mixtest::peakOf(ol.data() + 30000, 10000) == 0.0);  // the voice ended with its sound
  OM_CHECK(s.activeVoices() == 0);
  // a 44.1 kHz sound lasts frames * 48000 / 44100 output frames (linear interpolation)
  auto tb44 = sound(mixtest::constant(44100, 0.25f), mixtest::constant(44100, 0.25f), 44100);
  s.attach(4, tb44.get());
  s.play(4, 11, 0.5f, run.clock());
  run.render(ol, orr, 50000, true);
  int64_t last = -1;
  for (int64_t i = 0; i < 50000; i++)
    if (ol[static_cast<size_t>(i)] != 0.0f) last = i;
  // positions 0, 0.91875, ... < 44100: 48000 frames (one more if the double accumulation lands below)
  OM_CHECK(last == 47999 || last == 48000);
  OM_CHECK_NEAR(ol[100], 0.125, 1e-7);     // gain as given
  s.attach(3, nullptr);
  s.attach(4, nullptr);
}

OM_TEST(mixer_sampler_stop_fade_retrigger_and_steal) {
  Sampler s;
  s.prepare(48000, kMaxBlockFrames);
  const auto dc = mixtest::constant(200000, 0.01f);
  auto tb = sound(dc, dc, 48000);
  s.attach(0, tb.get());
  Run run{s};
  std::vector<float> l, r;
  // stop = AudioBufferSourceNode.stop() with a 2 ms (96-frame) fade
  s.play(0, 1, 1.0f, run.clock());
  run.render(l, r, 1000);
  s.stop(1);
  OM_CHECK(s.activeVoices() == 0);
  run.render(l, r, 200, true);
  OM_CHECK_NEAR(l[0], 0.01, 1e-7);
  OM_CHECK_NEAR(l[48], 0.01 * (1.0 - 48.0 / 96.0), 1e-6);
  OM_CHECK(l[96] == 0.0f && l[150] == 0.0f);
  // a reused voice id ends its previous voice (fade) and starts again from the sound's start
  s.play(0, 2, 1.0f, run.clock());
  run.render(l, r, 500);
  s.play(0, 2, 1.0f, run.clock());
  OM_CHECK(s.activeVoices() == 1);
  run.render(l, r, 200, true);
  OM_CHECK_NEAR(l[0], 0.02, 1e-7);  // fading old + new
  OM_CHECK_NEAR(l[150], 0.01, 1e-7);
  s.stopAll();
  OM_CHECK(s.activeVoices() == 0);
  // 16 voices at most: the 17th steals the oldest with a 5 ms (240-frame) fade
  for (uint32_t v = 0; v < 16; v++) s.play(0, 100 + v, 1.0f, run.clock());
  run.render(l, r, 256, true);
  OM_CHECK(s.activeVoices() == 16);
  OM_CHECK_NEAR(l[255], 0.16, 1e-6);
  s.play(0, 200, 1.0f, run.clock());
  OM_CHECK(s.activeVoices() == 16);
  run.render(l, r, 512, true);
  OM_CHECK_NEAR(l[0], 0.17, 1e-6);                          // the stolen voice still sounds...
  OM_CHECK_NEAR(l[120], 0.16 + 0.01 * (1 - 120.0 / 240.0), 1e-6);
  OM_CHECK_NEAR(l[400], 0.16, 1e-6);                        // ...and is gone after 5 ms
  s.stop(100);                                              // the stolen id: already gone, no effect
  OM_CHECK(s.activeVoices() == 16);
  s.stopAll();
  s.attach(0, nullptr);
}

OM_TEST(mixer_sampler_armed_waits_for_chunk_0_then_drops) {
  Sampler s;
  s.prepare(48000, kMaxBlockFrames);
  const auto dc = mixtest::constant(1000, 0.3f);
  Run run{s};
  std::vector<float> l, r;
  // a trigger on an empty slot is armed: silent, then plays when the sound arrives (< 250 ms)
  s.play(5, 1, 1.0f, run.clock());
  OM_CHECK(s.activeVoices() == 1);
  run.render(l, r, 4800, true);  // 100 ms
  OM_CHECK(mixtest::peakOf(l.data(), l.size()) == 0.0);
  auto late = sound(dc, dc, 48000, false);  // attached, chunk 0 not published yet
  s.attach(5, late.get());
  run.render(l, r, 1280, true);
  OM_CHECK(mixtest::peakOf(l.data(), l.size()) == 0.0);
  std::vector<float> inter(2000, 0.3f);
  late->writeChunkRaw(0, inter.data(), inter.size() * sizeof(float), 1.0f);  // chunk 0 arrives
  run.render(l, r, 1280, true);
  OM_CHECK(l[0] == 0.3f && l[999] == 0.3f && l[1000] == 0.0f);  // starts at the block, from frame 0
  OM_CHECK(s.droppedTriggers() == 0);
  // no data within 250 ms (sample clock): dropped and counted
  auto never = sound(dc, dc, 48000, false);
  s.attach(6, never.get());
  s.play(6, 2, 1.0f, run.clock());
  run.render(l, r, 11904, true);  // 248 ms
  OM_CHECK(s.activeVoices() == 1 && s.droppedTriggers() == 0);
  run.render(l, r, 256, true);
  OM_CHECK(s.activeVoices() == 0 && s.droppedTriggers() == 1);
  // replacing a slot's buffer ends the voices still reading the old one, at once
  auto a = sound(mixtest::constant(48000, 0.1f), mixtest::constant(48000, 0.1f), 48000);
  auto b = sound(mixtest::constant(48000, 0.2f), mixtest::constant(48000, 0.2f), 48000);
  s.attach(7, a.get());
  s.play(7, 3, 1.0f, run.clock());
  run.render(l, r, 128, true);
  OM_CHECK(s.attach(7, b.get()) == a.get());
  OM_CHECK(s.activeVoices() == 0);
  run.render(l, r, 128, true);
  OM_CHECK(mixtest::peakOf(l.data(), l.size()) == 0.0);
  for (int slot : {5, 6, 7}) s.attach(slot, nullptr);
}
