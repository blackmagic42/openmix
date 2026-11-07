# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-10-16

First standalone release of the Web Audio engine of
[OpenMix](https://github.com/blackmagic42/openmix), ported from the OpenMix app
with its behavior and its hard-won comments preserved. See the
[README](README.md) for the full documentation and the
[migration guide](docs/migration-from-openmix.md) for code written against the
app engine.

### Added

- `createEngine()` and `Engine`: a configurable engine (1–8 decks, 0–8 beat-FX
  units, 1–16 hot cues per deck) that works with any `AudioContext` or
  `OfflineAudioContext` and any output node. Injected contexts are never closed.
- Deck transport with a heard-position clock: starts and restarts scheduled
  30 ms ahead with sample-accurate bookkeeping, seek compensation, pre-roll
  down to −3600 s, and native sample-accurate loops.
- Beat grids: beat lists (every real beat) and fixed grids, `barAnchor`,
  per-deck `gridShift` and a per-engine `gridOffset`; grid editing with
  `setGrid()`, `scaleGrid()` (×2 / ÷2), `shiftGrid()` and `setDownbeat()`.
- Sync that holds: manual or automatic master election with cut tolerance and
  bass-aware handover, tempo matching from local beat periods with octave
  folding, bar alignment, two-stage ratio calibration, a continuous phase lock
  (±0.2 %, ±1.5 % on transposed decks), respected deliberate offsets,
  `nudge()` / `endNudge()`, `reanchorSync()`, `snapToReference()`, and master
  tempo changes that move the followers in the same call.
- Keylock and key shift (±7 semitones) through the WSOLA AudioWorklet
  `'openmix-pitch-shift'`, with its fixed 2647-sample latency compensated by
  read-ahead, glitch-free path switches, and a two-tap fallback shifter when
  AudioWorklet is unavailable.
- Mixer: trim, 3-band EQ with kills on every band, a DJ filter knob, channel
  fader, crossfader with sides A, B and `'thru'`, master volume, master filter,
  an optional safety limiter, deck and master peak meters.
- FX: 18 beat-synced FX types on assignable send units with per-deck dry
  compensation and beat-aligned modulations; slip roll; momentary pad FX with
  the OpenMix pad bank (`DEFAULT_PAD_FX`); a master FX unit; 9 color FX modes
  for the channel FILTER knobs.
- Performance controls: CDJ-style cue with hold-to-preview (`cueDown()` /
  `cueUp()`), quantized hot cues, beat loops, manual IN/OUT loops, reloop,
  halve and double, beat jump that moves an active loop, brake and backspin
  effects, and waveform scratching.
- Headphone cue (PFL) with automatic routing to channels 3/4 of 4-channel
  devices, a `cueOutput` option, `setHeadphoneDevice()` for a second device,
  `setOutputDevice()`, and a lazy recording stream (`getRecordingStream()`).
- Caller-supplied stems (`loadStems()`, `setStem()`, `toggleStem()`) and a
  generic insert hook (`setInsert(node, latency)`) with latency compensation,
  for WASM DSP, AudioWorklet effects or a VST bridge.
- `deck.loadFrom()`: decode, analyze what is missing, and load in one call,
  with cancellation through `AbortSignal`.
- Events: `load`, `eject`, `play`, `pause`, `ended`, `loop`, `hotcue`,
  `cuepoint`, `sync`, `grid` on decks; `tick`, `master`, `statechange` on the
  engine.
- Analysis entry point (`@openmix/web-engine/analysis`): `analyzeBpm()` (rigid
  grid detection, dynamic beat tracking, downbeat and phrase detection),
  `analyzeKey()` (KeyFinder profiles, tuning detection), `analyzeTrack()`,
  `alignImportedGrid()`, `keyFromMono()`, `keyFromChroma()`, and Camelot
  helpers (`camelot()`, `camelotLabel()`, `keyName()`, `shiftKey()`,
  `keyDistance()`, `heardKey()`).
- Waveform entry point (`@openmix/web-engine/waveform`): `computePeaks()`
  (3-band peaks plus a fine envelope), `drawZoom()` and `drawOverview()` with
  cached rendering, `fitCanvas()` and five palettes (`WAVE_PALETTES`).
- Pure grid helpers: `gridIndexFracAt()`, `gridTimeAtIndex()`,
  `gridPeriodAt()`, `barAlignedSeekTime()`, `snapToBeat()`.
- `renderOffline()`: drives `tick()` during an `OfflineAudioContext` render
  for deterministic, silent tests.
- Constants and FX tables (`FX_TYPES`, `COLOR_FX_TYPES`, `FX_BEATS`,
  `FX_DRY_CUT`, `fxDryCut()`, `PAD_FX_DRY`, `HOT_CUE_COLORS`, tempo and key
  ranges, `PRE_ROLL`, `WSOLA_LATENCY_SAMPLES`, `PITCH_PROCESSOR_NAME`,
  `VERSION`).
- TypeScript declarations (`types/`), a no-build demo (`npm run demo`), silent
  Node unit tests (`npm test`) and a silent headless browser suite
  (`npm run test:browser`).
- Zero dependencies: pure ES modules plus one AudioWorklet, no build step.

### Differences from the OpenMix app engine

1. Grace periods and end-of-track timing use the audio clock
   (`context.currentTime`) instead of `performance.now()`: deterministic
   offline, and frozen while the context is suspended.
2. `setMaster(i)` **sets** the master; it no longer toggles. Use
   `setMaster(null)` for automatic.
3. The grid offset is per engine (`engine.setGridOffset()`); the waveform
   palette is a per-call option.
4. Deck, FX-unit and hot-cue counts are configurable. The OpenMix values
   (4/4/8) remain the defaults.
5. New crossfader side `'thru'`.
6. The worklet file and processor are renamed (`worklets/pitch-processor.js`,
   `'openmix-pitch-shift'`); registration is guarded; the module is loaded once
   per context.
7. The recording stream is created lazily, and `getRecordingStream()` throws on
   offline contexts.
8. No logging by default (use the `log` option).
9. `deck.setTempo()` on a synced follower leaves SYNC (the app did this in its
   UI handler). `deck.effectiveBpm` excludes the sync servo's micro-correction
   (the app removed it at display time).
10. Kill on any EQ band (was bass only).
11. `analyzeBpm` options are `{ minBpm, maxBpm }` (were `{ lo, hi }`), and the
    result field `q` is renamed `deviationMs`. `analyzeKey` adds `name` and
    `camelot`.
12. New: `limiter` option, `destroy()`, events, `renderOffline()`,
    `loadFrom()`, `analyzeTrack()`, `eject()`.
13. Beat-FX feedback echoes stay on the beat. In Chromium, every trip around a
    feedback loop through a `DelayNode` is one render quantum late (+128
    frames, 2.67 ms at 48 kHz, per repeat), so the app's echo repeats drifted
    off the beat. The engine measures that latency once per sample rate and
    compensates it in the delay times of `echo`, `delay`, `lowcut`, `spiral`,
    `upecho`, `downecho`, `helix` and `pingpong`; where a browser has no such
    latency, nothing changes. The ping-pong's feedback cycle now holds a
    single delay (same response). The flanger and the color-FX echoes keep the
    app's timing. `engine.ready` waits for the measurement 2 s at most; a
    result that comes later is applied when it arrives.
14. Auto-tick keeps running when a page reports `visible` but gets no
    animation frames (an Electron window that is not shown, minimized or
    occluded with `backgroundThrottling: false`): after 100 ms without a
    frame, a timer ticks until the first frame comes back. The app's frame
    loop (and so its sync lock) stopped there. That timer, like the one of
    hidden tabs, keeps one tick every 20 ms on average: each tick is due 20 ms
    after the previous one was due, so late timers are caught up (one missed
    tick at most). On Windows' default 15.6 ms system timer, a plain 20 ms
    timeout gives 31 ticks per second, the bottom of the 30–144 Hz the lock is
    made for; this cadence keeps 50.
15. An engine created before the first user gesture starts its permanent
    sources (FX modulations, color-FX noise, fallback-shifter ramps) on the
    context's first `running` state. Chrome logged "The AudioContext was not
    allowed to start" for each of them otherwise: 45 warnings for a default
    engine.

### Notes

- Not published on npm. The package is used from source (a git checkout or a
  copy of the folder); see the README.
- The OpenMix app does not use this package yet; it will switch to it later.
