// End-to-end PLAY and HOT CUE latency through the whole engine (owner:
// host): a track handed off as float32 chunks, deck.load, deck.play (or a
// deck.seek while playing), then the frames between the block that applied
// the command and the first output frame that carries it at the device
// output (deck -> strip -> master -> limiter -> channels 1/2), plain and
// under KEYLOCK (the WSOLA transposer is primed straight from the track: no
// 55-60 ms fill). The Web engine adds a fixed 30 ms scheduling
// lead to every play and every jump (and 55-60 ms more under keylock); the
// native engine adds only the limiter's 6 ms look-ahead (the same
// DynamicsCompressor pre-delay the Web engine has), plus the deck's short
// crossfade for a jump. Measurement test: it reports the numbers
// and checks the plain path; skipped when the modules of this build render
// silence. SPEC.md §9.1, §9.4, §20.
#include <algorithm>
#include <cmath>
#include <cstdio>
#include <string>
#include <vector>

#include "../om_test.h"
#include "core_util.h"

using namespace om;
using namespace omtest;

namespace {
// Frames from the block where deck.play is applied to the first output
// frame above -60 dBFS on channel 1, or -1 when nothing sounds within `maxBlocks`.
int64_t framesToSound(bool keylock, int* blockFramesOut) {
  TestEngine t;
  const int bf = 256;  // NULL device block (EngineOptions default)
  if (blockFramesOut) *blockFramesOut = bf;
  if (!t.handoff(1, 48000 * 4, 0.25f)) return -2;
  t.cmd(R"({"cmd":"deck.load","deck":0,"loadId":1,"grid":{"bpm":120,"beatOffset":0}})");
  if (keylock) t.cmd(R"({"cmd":"deck.keylock","deck":0,"on":true})");
  std::vector<float> out(static_cast<size_t>(bf) * 4);
  for (int b = 0; b < 8; b++) t.e->render(out.data(), bf);  // settle (load, smoothers)
  t.e->pump();
  t.cmd(R"({"cmd":"deck.play","deck":0})");  // applied at the start of the next block
  for (int b = 0; b < 200; b++) {
    t.e->render(out.data(), bf);
    for (int i = 0; i < bf; i++)
      if (std::fabs(out[static_cast<size_t>(i) * 4]) > 1e-3f) return static_cast<int64_t>(b) * bf + i;
  }
  return -1;
}

// Hot cue: the track is +0.25 for its first two chunks and -0.25 after;
// playing in the positive region, deck.seek(3 s) jumps into the negative
// one. Frames from the block that applied the seek to the first output
// frame below zero, or -1.
int64_t framesToHotCue(bool keylock) {
  TestEngine t;
  const int bf = 256;
  PcmDesc d;
  d.loadId = 1;
  d.sampleRate = 48000;
  d.frames = 48000 * 6;
  d.headroom = 1.0f;
  if (t.e->pcmBegin(d) != PcmError::None) return -2;
  for (int64_t off = 0; off < d.frames; off += TrackBuffer::kChunkFrames) {
    const int n = static_cast<int>(std::min<int64_t>(TrackBuffer::kChunkFrames, d.frames - off));
    std::vector<float> planar(static_cast<size_t>(n) * 2, off < 2 * TrackBuffer::kChunkFrames ? 0.25f : -0.25f);
    t.e->pcmWrite(1, off, n, 2, planar.data());
  }
  t.e->pcmEnd(1);
  t.cmd(R"({"cmd":"deck.load","deck":0,"loadId":1,"grid":{"bpm":120,"beatOffset":0}})");
  if (keylock) t.cmd(R"({"cmd":"deck.keylock","deck":0,"on":true})");
  t.cmd(R"({"cmd":"deck.play","deck":0})");
  std::vector<float> out(static_cast<size_t>(bf) * 4);
  for (int b = 0; b < 90; b++) t.e->render(out.data(), bf);  // ~0.5 s into the positive region
  t.e->pump();
  if (!(out[static_cast<size_t>(bf - 1) * 4] > 1e-3f)) return -1;  // not playing audibly
  t.cmd(R"({"cmd":"deck.seek","deck":0,"t":3.0})");
  for (int b = 0; b < 200; b++) {
    t.e->render(out.data(), bf);
    for (int i = 0; i < bf; i++)
      if (out[static_cast<size_t>(i) * 4] < -1e-3f) return static_cast<int64_t>(b) * bf + i;
  }
  return -1;
}
}  // namespace

namespace {
std::string ms(int64_t frames) {
  if (frames < 0) return "not measured";
  char b[64];
  std::snprintf(b, sizeof(b), "%lld frames (%.2f ms)", static_cast<long long>(frames), frames / 48.0);
  return b;
}
}  // namespace

OM_TEST(core_hot_cue_to_new_audio_latency_plain_and_keylock) {
  const int64_t plain = framesToHotCue(false);
  if (plain == -1) OM_SKIP("the deck / mixer of this build render silence: nothing to measure");
  const int64_t keyed = framesToHotCue(true);
  std::printf("[latency] deck.seek while playing -> first frame of the new region: %s plain, %s under keylock "
              "(Web engine: the old audio stops at once, the new region starts 30 ms later + 6 ms limiter, "
              "+ 55 ms under keylock)\n",
              ms(plain).c_str(), ms(keyed).c_str());
  OM_CHECK(plain >= 0 && plain <= 288 + 2 * 256);  // limiter look-ahead + the jump crossfade, within a block
}

OM_TEST(core_play_to_first_sound_latency_plain_and_keylock) {
  int bf = 256;
  const int64_t plain = framesToSound(false, &bf);
  if (plain == -1) OM_SKIP("the deck / mixer of this build render silence: nothing to measure");
  OM_CHECK(plain >= 0);
  const int64_t keyed = framesToSound(true, nullptr);
  std::printf("[latency] deck.play -> first audible frame: %lld frames (%.2f ms) plain, %s under keylock "
              "(Web engine: 30 ms lead + 6 ms limiter, + 55 ms under keylock)\n",
              static_cast<long long>(plain), plain / 48.0,
              keyed >= 0 ? (std::to_string(keyed) + " frames (" + std::to_string(keyed / 48.0).substr(0, 5) + " ms)").c_str()
                         : "no sound within 200 blocks");
  // The plain path: at most the limiter look-ahead (288 frames at 48 kHz) plus one block of slack.
  OM_CHECK(plain <= 288 + bf);
}
