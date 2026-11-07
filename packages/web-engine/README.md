# @openmix/web-engine

**The Web Audio engine of [OpenMix](https://github.com/blackmagic42/openmix), packaged as a
standalone library for DJ and mixing apps that run in a web browser.**

Multi-deck playback, beat grids, sync with phase lock, WSOLA keylock, a full DJ
mixer, beat-synced FX, headphone cue routing, BPM and key analysis, and
waveform drawing. Pure ES modules plus one AudioWorklet: zero dependencies, no
build step.

**Status:** version 0.1.0 · [MIT license](LICENSE) · not published on npm yet
([use it from source](#installation-and-usage-from-source))

OpenMix is free, open-source DJ software with four decks. Its desktop app is
getting a native C++ engine, and this package keeps the web engine alive and
shareable. It has the same sound and the same behavior as the OpenMix engine:
sync that holds, keylock with latency compensation, sample-accurate loops and
beat-synced FX. The logic and its hard-won comments were ported from the app,
and the app couplings were removed. The OpenMix app itself will switch to this
package later.

Credits: built for OpenMix by blackmagic42 and the OpenMix contributors. The
normative API and behavior contract is [DESIGN.md](DESIGN.md); code written
against the app engine can follow the
[migration guide](docs/migration-from-openmix.md). Changes are listed in the
[changelog](CHANGELOG.md).

## Contents

- [Features](#features)
- [Installation and usage from source](#installation-and-usage-from-source)
- [Quick start](#quick-start)
- [Demo and tests](#demo-and-tests)
- [Concepts](#concepts)
  - [Signal flow](#signal-flow)
  - [Decks and the timing model](#decks-and-the-timing-model)
  - [Beat grids and analysis](#beat-grids-and-analysis)
  - [Sync and phase lock](#sync-and-phase-lock)
  - [Keylock and latency compensation](#keylock-and-latency-compensation)
  - [FX](#fx)
  - [Cue routing to a second output](#cue-routing-to-a-second-output)
  - [Offline rendering and testing](#offline-rendering-and-testing)
  - [The insert hook](#the-insert-hook)
- [API reference](#api-reference)
  - [Entry points](#entry-points) · [Conventions](#conventions) ·
    [createEngine and options](#createengine-and-options) · [Engine](#engine) ·
    [Deck](#deck) · [FxUnit](#fxunit) · [Events](#events) ·
    [Analysis](#analysis) · [Waveform](#waveform) ·
    [Grid helpers](#grid-helpers) · [Offline](#offline) ·
    [Constants and types](#constants-and-types)
- [Browser support](#browser-support)
- [Limits](#limits)
- [Contributing and tests](#contributing-and-tests)
- [License](#license)
- [Trademarks](#trademarks)

## Features

- **Decks:** 1 to 8 (default 4). Each one has a clock that reports the heard
  position, starts and restarts scheduled 30 ms ahead with sample-accurate
  bookkeeping, pre-roll before the track start, and native sample-accurate
  loops.
- **Beat grids:** beat lists (every real beat) or fixed grids, bar and phrase
  anchors, per-deck and global grid offsets, ×2 / ÷2, shift and downbeat
  editing, and pure grid helpers.
- **Sync that holds:** manual or automatic master, tempo matched from local
  beat periods, bar alignment, a two-stage ratio calibration, an inaudible
  continuous phase lock, respected deliberate offsets, pitch-bend nudging, and
  master tempo changes that move every follower in the same call.
- **Keylock and key shift:** a WSOLA AudioWorklet with a fixed, known latency
  that the deck compensates by reading ahead, glitch-free path switches, and a
  fallback shifter.
- **Mixer:** trim, 3-band EQ with kills, a DJ filter knob, channel faders, a
  crossfader with A, B and thru sides, master volume and master filter, a
  safety limiter, and peak meters.
- **FX:** 18 beat-synced FX types on assignable send units, with dry
  compensation and beat-aligned modulations; slip roll; momentary pad FX (the
  OpenMix pad bank); a master FX unit; 9 color FX modes for the FILTER knobs.
- **Performance controls:** CDJ-style cue with hold-to-preview, quantized hot
  cues, beat loops, manual IN/OUT loops, reloop, halve and double, beat jump,
  brake and backspin effects, and waveform scratching.
- **Headphones:** pre-fader listen (PFL) on a cue bus that goes automatically to
  channels 3/4 of a 4-channel sound card, or to any node you choose, or to a
  second output device.
- **Stems and inserts:** play stems that you supply, with per-stem mutes.
  Insert any `AudioNode` (WASM DSP, an AudioWorklet effect, a VST bridge) on a
  deck, with latency compensation.
- **Analysis:** BPM and beat grid (rigid-grid detection, beat tracking,
  downbeat and phrase detection), musical key with Camelot helpers, and
  alignment of grids imported from other software.
- **Waveforms:** 3-band peaks with a fine envelope, cached zoom and overview
  drawing on a canvas, five palettes.
- **Testable:** works with `OfflineAudioContext`. `renderOffline()` drives the
  engine during a render, for deterministic and silent tests.
- **No app couplings:** no storage, no i18n, no logging by default. Events let
  your app persist hot cues, loops and grids. TypeScript declarations are
  included.

## Installation and usage from source

> The package is **not on npm yet**. Use it from source: it is plain ES
> modules with no build step, so a copy of its folder is all you need.

### Get the code

The package lives in `packages/web-engine/` of the OpenMix repository:

```sh
git clone https://github.com/blackmagic42/openmix.git
cd openmix/packages/web-engine
```

To fetch only this folder, use a sparse checkout:

```sh
git clone --depth 1 --filter=blob:none --sparse https://github.com/blackmagic42/openmix.git
cd openmix
git sparse-checkout set packages/web-engine
```

### Copy the folder into your project

Copy `packages/web-engine/` into your project, for example as
`vendor/web-engine/`. At runtime the browser needs `src/` and `worklets/`;
`types/` is for TypeScript. Keep `src/` and `worklets/` side by side, because
the engine finds its worklet at `../worklets/pitch-processor.js` relative to
its own modules.

### Import it

By relative path:

```js
import { createEngine } from './vendor/web-engine/src/index.js';
```

Or under the package names, through an import map:

```html
<script type="importmap">
  {
    "imports": {
      "@openmix/web-engine": "/vendor/web-engine/src/index.js",
      "@openmix/web-engine/analysis": "/vendor/web-engine/src/analysis/index.js",
      "@openmix/web-engine/waveform": "/vendor/web-engine/src/waveform/index.js"
    }
  }
</script>
<script type="module">
  import { createEngine } from '@openmix/web-engine';
  import { analyzeKey, camelotLabel } from '@openmix/web-engine/analysis';
</script>
```

The specifiers and what they contain are listed under
[Entry points](#entry-points). The worklet needs no import map entry: the
engine does not import it, it loads it with `audioWorklet.addModule()` from a
URL computed next to its own modules (see below), and import maps do not apply
to that URL.

### Bundlers and the worklet URL

The engine loads its AudioWorklet from
`new URL('../worklets/pitch-processor.js', import.meta.url)`. This is the
standard way for an ES module to reference a file next to it. Browsers resolve
it natively without a bundler, and bundlers that understand the pattern (Vite,
webpack 5 and Parcel, for example) emit the worklet file with your build.

If your toolchain moves the engine's modules without the worklet file (for
example a bundler or plugin that ignores the pattern, dependency pre-bundling,
or a CDN), the relative URL breaks. Then pass the URL yourself with the
`workletUrl` option:

```js
// Any toolchain: copy worklets/pitch-processor.js to your static files
const engine = await createEngine({ workletUrl: '/static/pitch-processor.js' });
```

```js
// Vite: an explicit URL import
import workletUrl from './vendor/web-engine/worklets/pitch-processor.js?url';
const engine = await createEngine({ workletUrl });
```

The worklet module has no imports, so it can be served from anywhere your page
can load modules from: the same origin, or another origin that sends CORS
headers. If the worklet cannot load, the engine still works with the fallback
shifter: `engine.pitchEngine` is then `'fallback'`, and `engine.pitchEngineError`
says why.

### Secure context

AudioWorklet exists only in a
[secure context](https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts):
`https://`, or `http://localhost` / `http://127.0.0.1` during development. On
plain `http://` from another host, keylock and key shift use the fallback
shifter. Serve your pages over http(s): module scripts and worklets do not work
reliably from `file://`.

### TypeScript

The declarations are in `types/` (`index.d.ts`, `analysis.d.ts` and
`waveform.d.ts`), and `package.json` points to them. With a copied folder, map
the package names in your `tsconfig.json`:

```json
{
  "compilerOptions": {
    "paths": {
      "@openmix/web-engine": ["./vendor/web-engine/types/index.d.ts"],
      "@openmix/web-engine/analysis": ["./vendor/web-engine/types/analysis.d.ts"],
      "@openmix/web-engine/waveform": ["./vendor/web-engine/types/waveform.d.ts"]
    }
  }
}
```

### Once published

Once the package is published on npm, it will install with
`npm install @openmix/web-engine`. It is not published yet: until then, use
the steps above.

## Quick start

A page with a start button, a file input, two waveform canvases and a meter:

```html
<button id="start">Start</button>
<input id="file" type="file" accept="audio/*">
<canvas id="zoom" style="width: 100%; height: 120px"></canvas>
<canvas id="overview" style="width: 100%; height: 40px"></canvas>
<meter id="meter" min="0" max="1"></meter>
<script type="module" src="app.js"></script>
```

`app.js` (or import `'@openmix/web-engine'` through an import map):

```js
import { createEngine, drawZoom, drawOverview } from './vendor/web-engine/src/index.js';

const startButton = document.getElementById('start');
const fileInput = document.getElementById('file');
const zoomCanvas = document.getElementById('zoom');
const overviewCanvas = document.getElementById('overview');
const meter = document.getElementById('meter');

const engine = await createEngine();            // 4 decks, keylock worklet loaded, auto-tick on
const [a, b] = engine.decks;

startButton.onclick = async () => {
  const file = fileInput.files[0];
  if (!file) return;
  await engine.resume();                        // autoplay policy: needs a user gesture
  await a.loadFrom(file);                       // decode + BPM/grid + key + peaks, then load
  await b.loadFrom('/music/two.mp3');           // any audio URL the page can fetch
  a.play();                                     // first deck started = automatic master
  b.sync();                                     // tempo matched + bars aligned, then held by the lock
  b.play();                                     // a synced deck that starts is aligned again
  engine.setCrossfader(1);                      // side B only: decks[1] and decks[3] (decks[0] and decks[2] are side A)
};

engine.on('tick', () => {                       // once per frame (auto-tick)
  drawZoom(zoomCanvas, a, { windowSeconds: 8 * a.baseTempo });
  const g = zoomCanvas.getContext('2d');        // drawZoom leaves the playhead to you:
  g.fillStyle = '#ffffff';                      // draw it at the horizontal center
  g.fillRect(zoomCanvas.width / 2 - 1, 0, 2, zoomCanvas.height);
  drawOverview(overviewCanvas, a);
  meter.value = a.meterPeak();
});
```

Beat FX, keylock and headphones (indices are 0-based, so deck `b` is
`engine.decks[1]`):

```js
// Beat FX unit 0 on deck b (index 1), 1/2-beat echo
engine.assignFx(0, 1, true);
engine.fx[0].setType('echo');
engine.fx[0].setBeats(0.5);
engine.fx[0].setEnabled(true);
engine.fx[0].setLevel(0.6);            // units start at level 0

// Keylock and key
b.setKeylock(true);
b.setTempo(1.04);                      // +4 % without changing the key
b.setKey(-2);                          // two semitones down, same speed

// Headphones: PFL on deck b
b.setHeadphoneCue(true);
```

Offline (silent) rendering, for tests:

```js
import { createEngine, renderOffline } from './vendor/web-engine/src/index.js';

const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: 48000 * 30, sampleRate: 48000 });
const engine = await createEngine({ context: ctx });   // auto-tick is off for offline contexts
const [a, b] = engine.decks;
a.load(bufferA, { bpm: 124, beats: beatsA });
b.load(bufferB, { bpm: 128, beats: beatsB });
a.play();
const rendered = await renderOffline(engine, {
  tickRate: 60,
  onTick: (t) => { if (t >= 10 && !b.playing) { b.sync(); b.play(); } }
});
```

Next: the [Concepts](#concepts) explain how the engine behaves, and the
[API reference](#api-reference) lists every symbol.

## Demo and tests

These scripts need **Node.js 22 or later**, and only they need it: the library
runs in the browser and has no dependencies, so there is nothing to install.
Run them from the package folder:

```sh
npm run demo           # static server, then open http://127.0.0.1:8080/example/
npm test               # Node unit tests
npm run test:browser   # browser suite in a headless, muted Chromium-family browser
```

**Demo:** `npm run demo` runs `node scripts/serve.js`, which takes
`[--port 8080] [--host 127.0.0.1] [--root <dir>]`.

- It is a dependency-free static server rooted at the package folder. It
  listens on 127.0.0.1 unless you pass `--host`. When port 8080 is busy, it
  tries 8081 to 8099. It prints the demo URL (`/example/`) and the tests URL
  (`/test/browser/`), and it never opens a browser.
- The [demo](example/) is a four-deck DJ page built only on the public API.
  Its demo tracks are synthesized in the browser (no audio files ship with the
  package), and you can also load your own files or drop them on a deck. It
  has waveforms, sync, keylock, hot cues, loops, a mixer, FX panels, and output
  device selection where the browser supports it.
- It makes sound only after you press **Start audio**. Add `?silent=1` to the
  URL to start with the master and headphone volumes at 0.
- Any other static server rooted at the package folder works too, as long as
  it serves `.js` files with a JavaScript MIME type. Opened from `file://`, the
  demo only shows a message.

**Unit tests:** `npm test` runs `node --test` over `test/unit/*.test.js`,
with a minimal fake Web Audio implementation. They need no network, no audio
device and no browser, and they finish in under 30 seconds.

**Browser tests:** `npm run test:browser` runs the [suite](test/browser/)
through `OfflineAudioContext` only, at 48 kHz, on synthesized signals, so it is
silent by construction. The runner:

- looks for Chrome, Edge or Chromium, or uses the browser given with
  `--browser <path>` or the `CHROME_PATH` environment variable;
- launches it headless and muted on a temporary profile, and always closes it
  through its own process handle;
- prints one line per test with its metrics, then a summary;
- exits with 0 when every test passed, 1 on failures or a timeout, and 2 on an
  infrastructure problem. If no browser is found, it exits with 2: open
  `/test/browser/` in a browser yourself.

The suite is specified in [DESIGN.md](DESIGN.md) §10.2:

| Test | What it checks |
|---|---|
| `sync-60s` | Click tracks at 124 and 128 BPM; deck 1 is synced at 2 s. Over 10–62 s, the onset offset has a median ≤ 1.0 ms, a p95 ≤ 2.0 ms, a max ≤ 5 ms, and a drift ≤ 0.02 ms/s. |
| `sync-keylock-60s` | The same with keylock on deck 1 (transposer path): median ≤ 1.5 ms, p95 ≤ 3 ms, max ≤ 6 ms. |
| `keylock-pitch` | A 440 Hz sine stays at 440 Hz with keylock at tempo 1.06, becomes 523.25 Hz with key +3, and 440 × 2^(−5/12) Hz with keylock at tempo 0.94 and key −5, each within ±5 cents. |
| `loop-precision` | `setLoop(1.0, 1.5)` on an impulse train: every repeat lands within ±2 samples. |
| `beatloop-quantize` | On a 120 BPM beat list at 1.13 s, `beatLoop(4)` gives a loop from 1.125 s to 3.125 s with `loop.beats === 4`. |
| `analysis-bpm` | Synthesized 128 and 100 BPM tracks: BPM within 0.02, a rigid grid, and a median beat error ≤ 3 ms. |
| `analysis-key` | A synthesized A-minor progression is detected as Am (code 21). |
| `peaks` | Peak array lengths and value ranges; `fine: false` gives `finePps === 0`. |
| `cue-routing` | On a 4-channel offline context, PFL reaches channels 3/4 with the fader down, and nothing reaches channels 1/2. |
| `render-cpu` | Information only: the realtime factor of 4 decks (2 keylocked, 2 FX units on) over 60 s. |

The same page also runs these additional checks:

| Test | What it checks |
|---|---|
| `analysis-bpm-clicks` | Click tracks at 14 known tempos from 86 to 174 BPM (integer, half and fractional, such as 126.37): BPM within 0.05 and a median beat error ≤ 3 ms. |
| `analysis-key-major` | Sustained major triads (C, G, D, F, Bb, E, and a bare C triad): the right key name and Camelot code. |
| `sync-midtrack-bars` | A follower parked mid-track (off the beat and the bar) syncs onto a playing master: per-beat error as in `sync-60s`, and every downbeat meets a downbeat. |
| `eq-kill-60hz` | `setKill('low')` attenuates 60 Hz (and 1 kHz) exactly as the contract's low shelf (200 Hz, −40 dB) does, and the release restores the level. |
| `crossfader-extremes` | Decks on sides A, B and thru at x = 0, 1, 0.5, 0.25 and 0.75, measured on the master: the "mix" curve within 0.05 dB, cut sides below −100 dB. |
| `keylock-8pct` | Keylock at +8 % and −8 % tempo keeps 440 Hz within 5 cents; without keylock, +8 % gives 475.2 Hz. |
| `loop-4-beats` | `beatLoop(4)` while playing (tempo 1 and 0.97): a loop of exactly 4 grid beats whose clicks recur within 1 sample. |
| `peaks-shape` | `computePeaks` array types and lengths, an envelope that follows an amplitude ramp, and the low, mid and high bands on 60 Hz, 1 kHz and 6 kHz. |
| `position-model` | Play, seek, pause, pre-roll and tempo changes on a direct deck, a keylocked deck and a deck behind a 12.3 ms insert: every click sounds when `deck.position` equals its file time (±1 ms, ±1.5 ms keylocked), none skipped, doubled or heard while paused. |
| `keylock-toggle-synced` | Keylock and key shift switched on and off on a synced follower: it stays on the master's beats. |
| `loadfrom-wav` | `loadFrom()` on a 44.1 kHz WAV given as an ArrayBuffer, a Blob and a blob: URL; aborts by a newer load and by an `AbortSignal`; undecodable data rejects. |
| `fx-timing` | Echo, ping-pong and helix repeats within 2 samples of `beats × beatDuration` (tempo included), and a trans gate on the half-beat grid. |
| `roll-spin-resume` | After a slip roll, a brake and a keylocked backspin, the decks resume where the track would be. |
| `master-tempo-follow` | `setMasterBpm()` and `setMasterTempo()` while a synced follower plays: it follows in the same call and stays on the beats. |
| `two-engines-one-context` | Three engines on one context all get the WSOLA worklet. |
| `stems-sync` | A click track split into two stems plays in phase with the full mix; a muted stem stays silent, also through a keylock switch; `clearStems()` is seamless. |
| `manual-offsets` | On a synced follower: a small nudge is pulled back toward the beat, a large one is adopted and held, and a scratch released near the beat snaps onto it. |

Add `?only=name1,name2` to the page URL to run a subset.

**Electron runner:** on a machine with Electron but no desktop browser to
launch, `electron test/electron/run.cjs` (with `ELECTRON_RUN_AS_NODE` removed
from the environment) serves the package on an ephemeral 127.0.0.1 port, runs
the suite in a hidden, muted window without GPU, then opens the demo with
`?silent=1`: it checks that the demo loads without console errors, then
presses Start audio, loads the demo set, plays, syncs and uses the main
controls, all with the master at 0. It takes `--suite-only`, `--demo-only`,
`--only a,b`, `--json <file>` and `--timeout <seconds>`, and exits with 0, 1
or 2 like the headless runner. Never run it with the OpenMix app's own
Electron, or through a junction or symbolic link to it (a worktree's
`node_modules` can be one): the runner resolves the real path of its Electron
binary and refuses, with exit code 2, any binary inside an `openmix` folder.
Use `npm run test:browser`, or an Electron copied outside the OpenMix tree.

## Concepts

### Signal flow

Every deck is a fixed graph of Web Audio nodes, built once. The decks meet on
the master bus:

```text
                    stems (4 sources) ─► stemGains ─┐
AudioBufferSource ─────────────────────────────────► srcGain ─┐
ROLL loop source ───────────────────────────────────► rollGain ┴─► preIn ─┬─► dirGain ──────────────┐
                                                                          ├─► WSOLA worklet ─► wsOut ┤   (crossfaded paths)
                                                                          └─► fallback shifter ──────┤   (no worklet only)
scratch grains / brake / backspin ─► scrubIn (zero-latency path) ────────────────────────────────────┤
                                                                                                     ▼
            trim ─► EQ low (shelf 200 Hz) ─► EQ mid (peak 1 kHz, Q 0.9) ─► EQ high (shelf 8 kHz) ─► FILTER ─► [insert] ─► post
post ─► fader ─► xf (crossfader) ─► dryOut ─► MASTER BUS
post ─► cueSend (PFL) ─► CUE BUS          post ─► analyser (deck meter)       post ─► colorSend ─► color FX bus
noise ─► noiseGain ─► fader (color FX "noise")
xf ─► fxSend[u] ─► beat FX unit u (wet only) ─► fxReturn        xf ─► padFxSend ─► pad FX unit ─► fxReturn

MASTER BUS ─► dryComp ─► postBus ─► master FILTER ─► limiter ─► output (or destination ch 1/2)
MASTER BUS ─► master FX send ─► master FX unit ─► postBus
fxReturn (beat FX + pad FX + color FX wet; follows the master volume) ─► postBus
master FILTER ─► master analyser (pre-limiter meter)        limiter ─► recording stream (lazy)
CUE BUS ─► cueOutput | destination ch 3/4 | headphone AudioContext (MediaStream bridge)
```

- **Sources.** The track (or its stems) and the roll loop meet in `preIn`. From
  there, the sound takes two permanent paths: direct (`dirGain`), and
  transposed through the WSOLA worklet (`wsOut`). They are crossfaded by gain
  (see [Keylock](#keylock-and-latency-compensation)). Without AudioWorklet, the
  fallback shifter takes the transposed role.
- **Zero-latency path.** Scratch grains and the brake and backspin effects
  enter at `scrubIn`, after the transposer.
- **Channel strip.** Trim, the 3-band EQ and the FILTER knob, then the optional
  [insert](#the-insert-hook), then `post`.
- **Taps on `post`.** The fader, the headphone send (pre-fader listen), the deck
  meter and the color FX send all listen to `post`, so they all hear the EQ,
  the filter and the insert.
- **FX sends.** Beat FX and pad FX tap `xf`, after the fader and the
  crossfader, so a deck that is faded out sends nothing new to them. Their wet
  output comes back through `fxReturn`, which follows the master volume.
- **Master.** The dry mix goes through `dryComp` (the dry compensation of the
  master FX), the master FILTER and the limiter. `engine.masterOut` is the
  final node and `engine.cueOut` is the headphone bus; both are public so that
  you can add taps.

Mixer curves and defaults:

| Control | Mapping and default |
|---|---|
| Channel fader | gain = v², default v = 0.85 |
| Trim | gain = 4^v (−12 … +12 dB) |
| EQ | v < 0 → v × 40 dB (−1 = −40 dB kill); v ≥ 0 → v × 6 dB |
| FILTER and master filter | \|v\| < 0.04 = neutral (peaking 0 dB); v > 0 = high-pass at 20 × 400^v Hz (20 Hz → 8 kHz); v < 0 = low-pass at 20000 × (80/20000)^(−v) Hz (20 kHz → 80 Hz); Q 0.9 |
| Crossfader ("mix" curve, both sides full at the center) | gA = x ≤ 0.5 ? 1 : 2(1 − x); gB = x ≥ 0.5 ? 1 : 2x; `'thru'` decks = 1 |
| Master volume | default 0.9; also scales the FX returns |
| Limiter | DynamicsCompressor: threshold −3 dB, knee 0, ratio 12, attack 2 ms, release 150 ms |
| Meters | AnalyserNode with `fftSize` 512, peak of every other sample |

Parameter changes use short `setTargetAtTime` ramps, exactly as in OpenMix.

### Decks and the timing model

- **Heard position.** `deck.position` is the file time, in seconds, of what is
  heard right now. On a keylocked deck the track is read ahead of what you
  hear (see [Keylock](#keylock-and-latency-compensation)), and `position` still
  reports the heard sound. Waveforms, cues, loops and sync all use it.
- **Scheduled starts.** `play()` and every restart (seek, hot cue, beat jump,
  sync alignment) schedule the sources 30 ms ahead on the audio clock, with
  sample-accurate bookkeeping. A start "as soon as possible" would leave a few
  milliseconds of uncertainty on every play, seek and sync.
- **Seek compensation.** A seek while playing targets `t + 0.03 × tempo`: the
  position the sound would have reached with an instantaneous jump. Jumps land
  on time, and the sync lock has nothing to correct afterwards.
- **The 30 ms window.** Until a scheduled start happens, `position` is the exact
  extrapolation of the clock: it climbs toward the start point instead of
  jumping to it. Right after `play()` from 12 s at tempo 1, it reads 11.97 s.
  It is never floored to the future position, so a measurement taken in that
  window (a sync right after play, the first calibration sample) is correct.
  Display code may clamp it, for example with `Math.max(0, deck.position)`.
- **Pre-roll.** Positions down to −3600 s (`PRE_ROLL`) are allowed. The deck is
  silent until 0, then the track starts: `seek(-8)` then `play()` gives 8 s of
  silence at tempo 1, which is handy to bring a track in late. A tempo change
  during pre-roll reschedules the start, so a synced deck still starts on the
  grid.
- **Loops.** Loops use the native `AudioBufferSourceNode` loop, so they are
  sample-accurate, and `position` wraps inside the loop. A loop lasts at least
  10 ms.
- **Tempo.** The tempo is the `playbackRate` of every source of the deck: the
  track, the stems and the roll. `deck.tempo` is the instantaneous rate,
  including the sync lock's micro-corrections; `deck.baseTempo` is the same
  without them, and it is the one to display. The keylock compensation follows
  the tempo live.
- **End of track.** A natural end emits `'ended'`, leaves `playing` false and
  puts the position at the end. `play()` then restarts from 0.
- **Polling.** Positions, tempos and meters have no events: read them in your
  frame loop, or on the engine's `'tick'` event.

```js
const deck = engine.decks[0];
deck.seek(-8);                     // pre-roll: 8 s of silence (at tempo 1), then the track
deck.play();
engine.on('tick', () => {
  clock.textContent = Math.max(0, deck.position).toFixed(2);
});
```

### Beat grids and analysis

A deck's grid is one of two kinds:

- A **beat list** (`deck.beats`) has every beat at its real position in the
  file, as found by `analyzeBpm()`. All grid computations interpolate between
  the real beats and extrapolate past both ends with the edge periods, so a
  track whose tempo moves still gets a correct grid.
- A **fixed grid** (`deck.bpm` and `deck.beatOffset`, with `beats === null`) is
  a constant tempo from a first beat. It is used for manual BPM entry
  (`setGrid({ bpm })`).

`barAnchor` is the index of a beat that starts a bar. Bar lines fall every 4
beats from it, and reinforced phrase lines every 16. `deck.gridShift` (per
deck) and `engine.gridOffset` (global, set with `setGridOffset()`) shift
beat-list grids; fixed grids ignore both shifts, exactly as in OpenMix. The
global offset suits the grid to a listener's ear or to screen latency.

Where grids come from:

- `deck.loadFrom()` analyzes the track unless you pass `bpm` or `beats`.
- `deck.load()` and `deck.setGrid()` take grids that you stored or computed. A
  `beats` array needs more than 2 entries; given without `bpm`, the BPM is
  derived from the median beat interval.
- `alignImportedGrid()` re-aligns a grid imported from other software onto
  this decoder's timeline. It measures the median offset to the real
  transients, which is typically about 51 ms for LAME MP3s.

Grid edits (`setGrid()`, `scaleGrid()`, `shiftGrid()`, `setDownbeat()`) emit
`'grid'` with the new grid, so that your app can store it. A change of BPM or
of beat list takes the deck out of SYNC.

**How the BPM analysis works** (`analyzeBpm`):

1. Bass onset strength is computed at 8 kHz. Autocorrelation gives the tempo,
   and the median inter-onset interval chooses the octave.
2. A dual-score sweep of the whole range follows: the bass-power phase peak
   plus wideband transients, with ternary and octave candidates, and a lock on
   integer or half-integer BPMs.
3. If the per-chunk phase deviations are small, a **rigid grid** is produced: a
   constant tempo, anchored on the kick attack. 61 of 61 Rekordbox grids
   measured on real tracks were rigid.
4. Otherwise, beat-by-beat **dynamic tracking** is used, with sections
   re-anchored after breaks.
5. Final steps: re-alignment on wideband transients (to cancel the group delay
   of the low-pass), an octave safeguard, then downbeat and phrase detection.

The default range is 85–170 BPM. The octave ceiling is
`max(maxBpm × 1.06, 180)`: above it, a tempo is treated as a double tempo.
Widen the range for music outside it, for example
`analyzeBpm(buffer, { minBpm: 100, maxBpm: 200 })`.

**How the key detection works** (`analyzeKey`):

1. Up to 15 minutes of audio is resampled to 8 kHz mono, natively and off the
   main thread.
2. An FFT of 8192 points with a hop of 4096 runs over at most 1400 frames.
3. A chroma is built from C2 to B6 with 3 sub-bins per semitone, which detects
   a tuning offset of up to ±⅓ semitone.
4. Every frame is normalized, and silence and fades are discarded.
5. The chroma is correlated with the KeyFinder (Sha'ath) major and minor
   profiles, with a minor bias of +0.1.
6. The computation yields to the event loop every 12 frames.

Key codes run from 0 to 23: 0–11 are the major keys C … B and 12–23 the minor
keys Cm … Bm (table under [Analysis](#analysis)). `camelotLabel()` turns them
into Camelot labels (C major = 8B, A minor = 8A), and `keyDistance()` rates
harmonic compatibility.

```js
const deck = engine.decks[0];
await deck.loadFrom(file, { analyze: { minBpm: 100, maxBpm: 200 } });
deck.on('grid', ({ bpm, beats, beatOffset, barAnchor, gridShift }) => {
  saveGrid(deck.track, { bpm, beats, beatOffset, barAnchor, gridShift });
});
deck.scaleGrid(2);        // the analysis found half the real tempo
deck.setDownbeat();       // the beat nearest the playhead starts a bar, exactly here
```

### Sync and phase lock

All of this behavior comes from OpenMix. The lock runs only in `tick()`: call
it at 30–144 Hz, or keep auto-tick on.

**Master election**

- A **manual master** (`engine.setMaster(i)`) always wins. `setMaster(null)`
  returns to automatic.
- Otherwise, the **automatic master** is the first deck started, and it stays
  master as long as it plays.
- A stop shorter than 1.2 s (audio clock) keeps the crown. This cut tolerance
  means that a quick play/pause cut never moves the master.
- A natural end of the track hands over immediately.
- The new master is the playing deck with **open bass** (EQ low > −0.9) that is
  the most audible (volume × crossfader side gain). The score is
  `(bass > 0 ? 10 + bass : 0) + heard`, where `bass` is 1 + the EQ low value
  when the bass is open, and 0 otherwise.
- A manual master that stops hands over after 1.2 s, or immediately at a
  natural end.
- When a deck looks for a reference, a non-synced playing deck is preferred,
  so that two followers never chase each other.

`engine.masterIndex`, `masterDeck` and `masterBpm` describe the current master,
and the `'master'` event fires when it changes.

**SYNC** (`deck.sync()`)

- **Tempo.** The ratio comes from **local beat periods**, the average of the 16
  beats around the position, with the master's servo correction removed. This
  is far more accurate than rounded global BPMs. The ratio is octave-folded
  into [0.5, 1.6]: a synced deck never doubles the master's BPM.
- **Bars.** The deck then seeks so that its downbeat lines fall together with
  the master's. On beat lists, the target is computed as a beat index.
- A synced deck that starts (`play()`) is aligned again. A synced deck that is
  stopped already takes the master's BPM, and its phase locks on play.
- SYNC stays on across track loads, and the new track is re-aligned from the
  first frame.
- `unsync()` leaves SYNC, and so does a tempo move on a follower (`setTempo()`,
  `setBpm()`), like moving its tempo fader.

| `sync()` returns | When | Effect |
|---|---|---|
| `'master'` | the deck is the effective master | SYNC is armed without touching its tempo |
| `'synced'` | another deck is a usable reference | aligned to the master now |
| `'armed'` | no reference plays yet | the lock aligns the deck as soon as one plays |
| `null` | the deck has no BPM | nothing |

**Calibration** corrects the ratio once instead of servoing it forever:

- Stage 1 measures the phase-drift slope for 1 s and corrects up to ±1 %.
- Stage 2 measures for 8 s and corrects up to ±0.1 %.
- It stops after at most 4 passes, or when a correction falls below 0.02 %.
  The absolute cap is ±2 %.
- When both decks have beat lists, it starts directly at stage 2.
- A measurement disturbed by a jump, a seek or a loop is discarded.
  Calibration gives up after 12 invalid attempts.

**Continuous lock** (in `tick()`)

- The phase error is smoothed (EMA 0.85/0.15). The dead zone is 0.0015 beat
  (< 0.6 ms).
- The correction is proportional and capped at **±0.2 %** (gain 0.08), which
  is inaudible.
- Decks routed through the transposer get **±1.5 %** (gain 1.0), because their
  pitch does not follow the tempo.
- The base ratio is frozen: the correction is never absorbed into it. Absorbing
  it made the BPM change continuously, and the source keeps a "DO NOT
  REINTRODUCE absorption" warning.

**Deliberate offsets**

- An error larger than 0.08 beat is **adopted** as the new target, not chased:
  the lock only corrects micro-drifts, and a deliberate placement stays where
  the DJ put it.
- Manual moves (the end of a nudge, the end of a scrub, `reanchorSync()`)
  adopt the present alignment. A residue below 0.03 beat counts as "aligned"
  and is pulled to exact alignment: the visual magnet.
- The master is never re-aligned.

**Tempo changes and handover**

- Master tempo changes (`engine.setMasterTempo()`, `engine.setMasterBpm()`, or
  `setTempo()` on the master deck) scale the followers in the same call, with
  no one-frame lag.
- A master handover happens without a jump. A follower keeps its current speed
  if it is within 0.4 % of the new target; otherwise it re-targets. Offsets are
  re-anchored on the present alignment.
- **Self-repair:** if a synced deck's base drifts more than 6 % from its
  target, it is re-aimed and recalibrated.

**Nudge and reanchor**

- `deck.nudge(amount)` is a pitch bend, as from a jog wheel: the rate becomes
  `base × (1 + amount)`, with `amount` clamped to ±0.5 (±0.06 is a typical full
  deflection). The first call captures the base tempo (the sync base when
  synced, otherwise the tempo) and adds the deck to the engine's hold set, so
  `engine.syncHold` is true and no deck chases the one being nudged. The
  `synced` flag is not touched. On a deck that is not playing, it returns
  `false`: seek instead.
- `deck.endNudge()` restores the base tempo and removes the deck from the hold
  set. When no deck holds any more, `engine.reanchorSync()` adopts the new
  alignment on every deck.
- `engine.setSyncHold(on)` suspends and resumes the phase correction globally,
  for gestures of your own.
- `engine.reanchorSync(index?)` adopts the current alignment of one synced deck
  (or of all of them). Call it after a small manual move that the lock would
  otherwise pull back (anything below 0.08 beat).
- `deck.snapToReference(maxBeats = 0.06)` is the "discreet magnet". It acts
  only when another deck with a grid is playing (the manual master is
  preferred): if this deck's beat phase is within `maxBeats` of that reference,
  the deck seeks to the exact alignment and the call returns `true`.
- `deck.scrubEnd()` resumes the deck if it was playing, calls
  `snapToReference()` (unless `snap: false`), then `engine.reanchorSync()`.

```js
const [a, b] = engine.decks;
masterButton.onclick = () => engine.setMaster(engine.manualMasterIndex === 1 ? null : 1);
syncButton.onclick = () => (b.synced ? b.unsync() : b.sync());
tempoSlider.oninput = () => b.setTempo(1 + tempoSlider.valueAsNumber / 100);   // a follower leaves SYNC
bpmUpButton.onclick = () => { if (engine.masterBpm) engine.setMasterBpm(engine.masterBpm + 0.1); };
jog.onpointermove = (e) => b.nudge(Math.max(-0.06, Math.min(0.06, e.movementX * 0.003)));
jog.onpointerup = () => b.endNudge();
engine.on('master', ({ index, manual }) => showMasterBadge(index, manual));
b.on('sync', ({ synced }) => syncButton.classList.toggle('on', synced));
```

### Keylock and latency compensation

`deck.setKeylock(true)` keeps the key when the tempo changes, and
`deck.setKey(n)` transposes by n semitones (−7 … +7) at the same speed. Both
send the deck through a transposer.

**The WSOLA worklet** (`worklets/pitch-processor.js`, processor
`'openmix-pitch-shift'`):

- Hann grains of N = 1536 samples (32 ms at 48 kHz), with **50 % overlap**:
  each output sample mixes exactly two aligned grains.
- A correlation search over ±480 samples, coarse (step 4) then fine, aligns
  each grain with the previous one. This avoids the doubled, flanged sound of a
  simple two-tap delay.
- A small offset penalty (0.1, `processorOptions.pen`) keeps kick attacks
  sharp.
- The ratio range is 0.5–1.8.
- **The latency is fixed and known:** LAT = 2647 samples
  (`WSOLA_LATENCY_SAMPLES`), ≈ 55.1 ms at 48 kHz and 60.0 ms at 44.1 kHz,
  whatever the ratio. At ratio 1, the worklet is an exact delay. It posts
  `{ lat }` on startup.
- It does no allocation in `process()`.

**Routing.** A deck uses the transposer when `keylock || keyShift !== 0`. The
decision never depends on the ratio, so the sound does not enter and leave the
transposer while sync makes the tempo hover around 1.

**Ratio.** `ratio = 2^(keyShift / 12) × (keylock ? 1 / tempo : 1)`, clamped to
[0.5, 1.8]. It follows the sync micro-corrections live. At the extremes (for
example key +7 at tempo 0.5), the clamp wins and the key is no longer fully
held.

**Compensation.** While a deck is routed through the transposer,
`deck.latency` is LAT / sampleRate, plus the latency of any insert.

- The deck **reads its track that much ahead**, so what is heard lands exactly
  on the grid: sync, waveforms and cues stay correct.
- Play from stop does not skip the attack: the sound comes out `latency` later,
  and the clock accounts for it.

**Path switches** are glitch-free:

- Two permanent paths, direct and transposed, are crossfaded with 6 ms gain
  ramps. Nodes are never reconnected.
- On entry, the old sound continues on the direct path until the transposer
  delivers.
- On exit, the direct path resumes exactly at the current position.
- Pause cuts the transposer's reserve (about 55 ms of sound), so that it is not
  replayed on resume.

**Fallback.** Without AudioWorklet (an insecure context, an old browser, a
module that fails to load, or the `keylock: false` option), the deck uses a
two-tap delay shifter. It has lower quality and no read-ahead, so no latency
compensation. `engine.pitchEngine` says which engine runs (`'wsola'` or
`'fallback'`) and `engine.pitchEngineError` says why the worklet is not used.
Decks also use the fallback shifter until `engine.ready` resolves.

**Scratch and spin** bypass the transposer, so they have zero latency.

```js
const deck = engine.decks[1];
deck.setKeylock(true);
deck.setTempo(1.06);               // faster, same key
deck.setKey(+2);                   // and two semitones up
console.log(deck.latency);         // ≈ 0.0551 at 48 kHz while routed through the transposer
if (engine.pitchEngine === 'fallback') console.warn('Keylock fallback:', engine.pitchEngineError);
```

### FX

| Kind | Fed from | Count | API |
|---|---|---|---|
| Beat FX units | the post-crossfader signal (`xf`) of the decks assigned to them | `fxUnits` option (default: one per deck) | `engine.fx[u]`, `engine.assignFx()` |
| Pad FX | one deck, while a pad is held | one per deck, created on first use | `deck.setPadFx()` |
| Master FX | the whole mix | one, created on first use | `engine.ensureMasterFx()`, `engine.masterFx` |
| Color FX | each channel's FILTER knob | one shared chain | `engine.setColorFx()`, `deck.setFilter()` |

**Beat FX units** are send effects. Each unit taps the post-crossfader signal
of its assigned decks (`engine.assignFx(unit, deck, on)`, read back with
`fxAssign` and `isFxAssigned()`), and its wet signal returns through
`fxReturn`, so it follows the master volume. Unit u starts assigned to deck u,
disabled, at level 0: units always start at the minimum, and raising the level
is the user's move. Enabling, disabling and assigning update the sends
automatically.

**Level** (0..1) sets the wet gain, and it also drives the effect itself: the
echo feedback becomes `min(0.97, base × (0.55 + 0.45 × level))`, and the level
also sets the filter-sweep depth and the flanger feedback.

**Dry compensation, per deck:**

- `dry = 1 − max(fxDryCut(type) × level)` over the enabled units assigned to
  that deck. An FX on one deck never touches another deck's dry.
- "Insert-like" effects (the trans gate, filter, crush, robot and pan) replace
  the sound at full level; echoes and reverbs add to it. The values are in
  `FX_DRY_CUT`.
- A held pad FX can lower the dry further (`PAD_FX_DRY`).
- The master FX doses the dry of the whole mix (`dryComp`).

**Tempo sync:**

- Delay times are `beatDuration × beats`, clamped to 0.02–3.9 s. They are
  updated only when the beat duration changes by more than 0.05 %.
- Delay chains are built **on first use**, to save memory, and they are born
  already in time.
- **Every repeat lands on the beat.** In Chromium, each trip around a feedback
  loop through a `DelayNode` is one render quantum late (+128 frames, 2.67 ms
  at 48 kHz, per repeat). The engine measures that latency once per sample
  rate (a tiny offline render, inside `engine.ready`, which waits for it 2 s
  at most) and takes it out of the loop delays of the echo-type effects
  (`echo`, `delay`, `lowcut`, `spiral`, `upecho`, `downecho`, `helix`,
  `pingpong`), with a fixed post-delay outside the loop for the first repeat.
  Measured: every repeat within one sample of
  `beats × beatDuration`. In a browser without that latency nothing changes.
  The flanger and the color-FX echoes are not beat-synced and keep their
  timing.
- Modulations (trans gate, flanger, phaser, pan, filter sweep) restart
  **exactly on a beat or bar boundary** of the reference deck. They re-align
  after a type or beats change, a reference-deck change, or a beat-duration
  drift above 0.4 %.
- On every `tick()`, each beat-FX unit follows the beat duration of the first
  assigned deck that is playing, otherwise the master. Pad-FX units follow
  their own deck, otherwise the master. The master FX follows the master. The
  fallback is 0.5 s.

**ROLL.** A unit of type `'roll'` is played by the deck itself: a slip loop of
the current grid slice whose mix equals the unit level, while the track keeps
running silently underneath. The unit itself outputs nothing. Decks also offer
`startRoll()` directly.

**Pad FX.** `deck.setPadFx(preset)` plays a momentary FX on that deck through
an independent unit, created on demand: a held pad never changes the panel
units. `{ type: 'roll', beats }` is a slip roll; any other type uses the pad-FX
unit, and while it is held the deck's dry is reduced to
`preset.dry ?? PAD_FX_DRY[type] ?? 1`. `null` turns it off. `DEFAULT_PAD_FX` is
the OpenMix pad bank; two of its entries are turntable effects, played with
`spinStart()` instead.

**Master FX.** `engine.ensureMasterFx()` creates one unit on the whole mix on
its first call, and returns the same unit afterwards.

**Color FX** sets the mode of every channel FILTER knob (`deck.setFilter()`):

- `'filter'`: a biquad low-pass (knob to the left) or high-pass (knob to the
  right).
- `'noise'`: white noise at `|v|² × 0.4` into the fader.
- The other modes: a send of `post`, scaled by `|v|`, into one shared chain
  (echo variants, the reverb "Space", crush) that returns through a 0.85 gain.
- When color FX are disabled (`setColorFxEnabled(false)`), the knobs do
  nothing.

Reverb impulses are memoized, and AudioBuffers are shared between contexts of
the same sample rate.

```js
import { DEFAULT_PAD_FX } from './vendor/web-engine/src/index.js';

const deck = engine.decks[0];
const mfx = engine.ensureMasterFx();          // reverb on the whole mix
mfx.setType('reverb');
mfx.setEnabled(true);
mfx.setLevel(0.3);

DEFAULT_PAD_FX.forEach((preset, i) => {       // hold a pad = play its FX
  pads[i].textContent = preset.label;
  pads[i].onpointerdown = () => ('spin' in preset ? deck.spinStart(preset.spin) : deck.setPadFx(preset));
  pads[i].onpointerup = () => ('spin' in preset ? deck.spinEnd() : deck.setPadFx(null));
});

engine.setColorFx('dubecho');                 // every FILTER knob now sends to a dub echo
deck.setFilter(0.5);
```

### Cue routing to a second output

The headphone (CUE) bus gathers the decks whose `setHeadphoneCue(true)` is on.
PFL taps `post`: it is pre-fader, but it hears the EQ, the filter and the
insert. `engine.setHeadphoneVolume(v)` sets the bus gain.

The wiring is re-applied after every output change, and the first matching
rule wins:

| # | Situation | Master goes to | Cue bus goes to | `headphonesAvailable` |
|---|---|---|---|---|
| 1 | `setHeadphoneDevice(id)` active | `output`, or the destination as stereo | a second AudioContext on device `id`, through a MediaStream bridge; a headphone device with ≥ 4 channels gets it on channels 3/4 | true |
| 2 | `cueOutput` given | `output`, or the destination as stereo | `cueOutput` | true |
| 3 | `output` given (no `cueOutput`) | `output` | nowhere | false |
| 4 | the destination has ≥ 4 channels | destination channels 1/2 (`channelInterpretation: 'discrete'`) | destination channels 3/4, for example a 4-channel DJ controller sound card whose headphone jack reads channels 3/4 | true |
| 5 | otherwise | the destination as stereo | nowhere | false |

- **4-channel devices (rule 4)** need nothing from you: when the output device
  exposes 4 channels, the master plays on 1/2 and the headphones on 3/4. Check
  `engine.headphonesAvailable` to show or hide your headphone controls.
- **`setOutputDevice(id)`** moves the master to another device
  (`context.setSinkId()`) and re-applies the wiring, because the channel count
  depends on the device.
- **`setHeadphoneDevice(id)`** (rule 1) plays the cue bus on another device,
  through a second AudioContext fed by a MediaStream. The bridge adds latency
  between master and headphones, and that latency is **not compensated**.
  `setHeadphoneDevice(null)` or `''` returns to the default routing.
- **`cueOutput`** (rule 2) sends the bus to any node of yours. To reach a
  second device, use a `MediaStreamAudioDestinationNode` whose stream plays in
  an `<audio>` element with `setSinkId()`, where the browser offers it. That
  path also adds latency between master and headphones, which is not
  compensated either.
- Both device methods resolve `false`, without throwing, when `setSinkId` is
  unsupported, when the context is offline, or when the device fails.
- The recording stream (`getRecordingStream()`), once created, stays connected
  to the limiter whatever the routing.

```js
// Device lists. Labels may be empty until the page has a media permission.
const devices = await navigator.mediaDevices.enumerateDevices();
const outputs = devices.filter((d) => d.kind === 'audiooutput');
await engine.setOutputDevice(outputs[0].deviceId);                // false when unsupported
const ok = await engine.setHeadphoneDevice(outputs[1].deviceId);   // cue bus on a second device
```

```js
// cueOutput through an <audio> element (rule 2)
import { createEngine } from './vendor/web-engine/src/index.js';

const ctx = new AudioContext({ latencyHint: 'interactive' });
const cueBridge = ctx.createMediaStreamDestination();
const engine = await createEngine({ context: ctx, cueOutput: cueBridge });
const phones = new Audio();
phones.srcObject = cueBridge.stream;

startButton.onclick = async () => {
  await engine.resume();
  if (phones.setSinkId) await phones.setSinkId(headphoneDeviceId);
  await phones.play();
};
```

### Offline rendering and testing

The engine runs the same on an `OfflineAudioContext`, which renders faster than
real time and without any sound: ideal for tests, previews and exports.

- Pass the context to `createEngine({ context })`. Auto-tick is off for offline
  contexts, and `engine.resume()` is a no-op.
- `renderOffline(engine, { tickRate = 60, onTick })` starts the render and
  calls `engine.tick()` at regular audio times, so that the sync lock and the FX
  alignment run during the render. At each tick it calls `engine.tick()`, then
  awaits `onTick(time)`, then resumes the context. Use `onTick` to act at given
  times: start a deck, sync it, move a fader.
- Tick times are multiples of `1 / tickRate`, rounded **up** to render-quantum
  (128-frame) boundaries, deduplicated, strictly increasing, and below the end
  of the render. The next suspend is scheduled from inside the handler, so a
  long render does not queue thousands of suspends.
- Ticks need `OfflineAudioContext.prototype.suspend`. Without it, a render with
  `tickRate > 0` rejects with an error that suggests `tickRate: 0`, which
  renders without ticks (so without the sync lock).
- `renderOffline()` throws a `TypeError` unless the context is an
  `OfflineAudioContext` that has not rendered yet. It resolves with the result
  of `startRendering()`.

To test what each deck sounds like, the project's browser suite captures every
deck on its own channel. It puts a unity `GainNode` on each deck as an insert,
connects each one to a `ChannelMergerNode`, and sends the master to a silent
sink:

```js
import { createEngine, renderOffline } from './vendor/web-engine/src/index.js';

const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: 48000 * 20, sampleRate: 48000 });
const sink = new GainNode(ctx, { gain: 0 });               // the master goes nowhere audible
sink.connect(ctx.destination);
const engine = await createEngine({ context: ctx, decks: 2, output: sink });
const merger = new ChannelMergerNode(ctx, { numberOfInputs: 2 });
merger.connect(ctx.destination);
engine.decks.forEach((deck, i) => {
  const tap = new GainNode(ctx);                           // unity gain
  deck.setInsert(tap, 0);                                  // after the EQ and the filter
  tap.connect(merger, 0, i);                               // channel i = deck i, as heard
});
// … load and play the decks, then:
const rendered = await renderOffline(engine);
const deck0 = rendered.getChannelData(0);
```

The rendered channels are then the decks as heard, after the keylock latency
compensation, before the fader. The project's own tests follow the same rules:
Node tests use a fake Web Audio, and browser tests use `OfflineAudioContext`
only, never a realtime context, so they are silent by construction (see
[Demo and tests](#demo-and-tests)).

### The insert hook

`deck.setInsert(node, latency = 0)` places any `AudioNode` between the deck's
FILTER and `post`. The fader, the headphone cue, the meter and the color FX
send all hear it.

- Use it for any effect node: a native Web Audio node, an `AudioWorkletNode`
  (for example WASM DSP), or a bridge to a VST host.
- The node needs one input and one output, and should output stereo.
- Give its **fixed** latency in seconds. The deck compensates it by reading
  ahead, like the keylock latency, so the grid, sync and cues stay exactly on
  time; it adds to `deck.latency`. A latency that changes over time cannot be
  compensated.
- Setting or removing an insert while the deck plays causes one brief restart.
- `setInsert(null)` removes it; `deck.insert` returns the current node.
- The package does not host VST plugins: the OpenMix app keeps its own VST
  host, and plugs it in through this hook.

```js
const ctx = engine.context;
await ctx.audioWorklet.addModule('/my-dsp-processor.js');
const node = new AudioWorkletNode(ctx, 'my-dsp', { outputChannelCount: [2] });
engine.decks[0].setInsert(node, 256 / ctx.sampleRate);    // the effect's fixed latency, in seconds
```

## API reference

This reference covers every public symbol. [DESIGN.md](DESIGN.md) §5 is the
normative version, and `types/` holds the TypeScript declarations.

### Entry points

| Specifier | File | Contents |
|---|---|---|
| `@openmix/web-engine` | `src/index.js` | the whole API |
| `@openmix/web-engine/analysis` | `src/analysis/index.js` | analysis only: no engine, no DOM |
| `@openmix/web-engine/waveform` | `src/waveform/index.js` | peaks and canvas drawing |
| `@openmix/web-engine/worklets/pitch-processor.js` | `worklets/pitch-processor.js` | the worklet module, for bundlers and CDNs |

All exports are named; there is no default export. The lists are exact:

- **`@openmix/web-engine/analysis`:** `analyzeBpm`, `analyzeKey`,
  `analyzeTrack`, `alignImportedGrid`, `keyFromMono`, `keyFromChroma`,
  `camelot`, `camelotLabel`, `keyName`, `shiftKey`, `keyDistance`, `heardKey`.
- **`@openmix/web-engine/waveform`:** `computePeaks`, `drawZoom`,
  `drawOverview`, `fitCanvas`, `WAVE_PALETTES`.
- **`@openmix/web-engine`:** everything from the two lists above, plus:
  - classes and functions: `createEngine`, `Engine`, `Deck`, `FxUnit`,
    `renderOffline`;
  - grid helpers: `gridIndexFracAt`, `gridTimeAtIndex`, `gridPeriodAt`,
    `barAlignedSeekTime`, `snapToBeat`;
  - constants: `VERSION`, `FX_TYPES`, `COLOR_FX_TYPES`, `FX_BEATS`,
    `FX_DRY_CUT`, `fxDryCut`, `PAD_FX_DRY`, `DEFAULT_PAD_FX`,
    `HOT_CUE_COLORS`, `TEMPO_MIN`, `TEMPO_MAX`, `KEY_SHIFT_MIN`,
    `KEY_SHIFT_MAX`, `PRE_ROLL`, `WSOLA_LATENCY_SAMPLES`,
    `PITCH_PROCESSOR_NAME`.

`Deck` and `FxUnit` are exported for `instanceof` checks and types; only the
engine creates them. Every module imports cleanly in Node: browser globals are
only read inside functions.

### Conventions

- **Times** are in seconds. Deck positions are file seconds of what is
  **heard**. Real-time durations are labeled as such: for example,
  `beatDuration` is in real seconds.
- **Ranges:** unipolar 0..1 for volume, FX level and crossfader (0 = side A
  only); bipolar −1..1 for EQ, trim, filter and master filter (0 = neutral);
  tempo as a ratio (1 = original speed).
- **Indices** are 0-based: decks, FX units and hot-cue slots.
- **Invalid input:**
  - Numbers out of range are clamped.
  - `NaN` or a non-number makes the call a no-op.
  - Enum values outside the allowed set throw `RangeError`.
  - Out-of-range deck, FX-unit or hot-cue slot indices throw `RangeError`.
- **Impossible operations** (no track loaded, no grid, not playing) return
  `false`, `null` or nothing, as documented per method. They never throw.
- **Read-only properties** are marked `readonly`. Some are plain fields
  internally; writing them is unsupported.
- **Events:** `on(type, listener)` returns an unsubscribe function; `once` and
  `off` exist too. Each listener receives one `detail` object, synchronously,
  after the state has changed. Listener exceptions go to `options.onError` and
  never break the engine or the tick.
- **Aliases:** `deck.currentTime()` returns the same value as `deck.position`,
  for OpenMix compatibility. `engine.ctx` is internal: use `engine.context`.

### createEngine and options

```ts
function createEngine(options?: EngineOptions): Promise<Engine>;
```

`createEngine(options)` is `const e = new Engine(options); await e.ready; return e;`.
`new Engine(options)` builds the whole audio graph synchronously; use it
directly if you need the engine before the worklet is ready (decks use the
fallback shifter until then). `ready` resolves once the worklet attempt and the
one-off FX feedback-latency measurement have finished. Never rejects.

| Option | Type | Default | Description |
|---|---|---|---|
| `context` | `BaseAudioContext` | a new `AudioContext(contextOptions)` | An `AudioContext` or `OfflineAudioContext`. The engine closes a context it created (in `destroy()`), never an injected one. |
| `contextOptions` | `AudioContextOptions` | `{ latencyHint: 'interactive' }` | Used only when `context` is omitted. |
| `output` | `AudioNode` | `context.destination`, with the automatic 4-channel headphone layout when available | Receives the master mix: stereo, post-limiter. See [Cue routing](#cue-routing-to-a-second-output). |
| `cueOutput` | `AudioNode` | destination channels 3/4 when `output` is omitted and `destination.maxChannelCount ≥ 4`; otherwise unconnected | Receives the headphone (CUE) bus, stereo. |
| `decks` | `number` | `4` | Number of decks, 1–8. Crossfader sides default to A, B, A, B, … |
| `fxUnits` | `number` | same as `decks` | Number of beat-FX units, 0–8. Unit u starts assigned to deck u (when that deck exists), disabled, at level 0. |
| `hotCues` | `number` | `8` | Hot-cue slots per deck, 1–16. |
| `keylock` | `boolean` | `true` | Load the WSOLA keylock worklet. `false` = the two-tap fallback shifter only. |
| `workletUrl` | `string \| URL` | `new URL('../worklets/pitch-processor.js', import.meta.url)` | Where to load `worklets/pitch-processor.js` from. |
| `autoTick` | `boolean` | `true` for a realtime context when `requestAnimationFrame` exists; `false` for an `OfflineAudioContext` | Call `tick()` automatically. |
| `limiter` | `boolean` | `true` | Safety limiter on the master (see the mixer curves). `false` = a unity gain node instead. |
| `log` | `(message: string) => void` | no-op | Diagnostics: the worklet fallback reason, the output layout. |
| `onError` | `(error: unknown) => void` | `console.error` | Receives exceptions thrown by event listeners and by auto-tick. |

- Without `context`, if no `AudioContext` can be created (for example in Node),
  the constructor throws `Error('No AudioContext available; pass options.context')`,
  and `createEngine()` rejects with it.
- **The worklet attempt.** Success sets `pitchEngine` to `'wsola'`. Any failure
  sets it to `'fallback'` and records the cause in `pitchEngineError`: no
  `audioWorklet` (insecure context, old browser), a module load error, or a
  node creation error. With `keylock: false`, `pitchEngine` is `'fallback'`
  and `pitchEngineError` is `null`. None of these makes `ready` reject.
- **The feedback-latency measurement** (a tiny offline render, once per sample
  rate, see [FX](#fx)) takes a few milliseconds. `ready` waits for it 2 s at
  most; a result that comes later is applied when it arrives.
- **The worklet module is added at most once per context** (a module-level
  `WeakMap`), so several engines can share one context. The worklet guards its
  own `registerProcessor` call, so a second evaluation cannot throw.

```js
const engine = await createEngine({
  decks: 2,
  hotCues: 16,
  log: (message) => console.debug('[web-engine]', message)
});
```

### Engine

```ts
class Engine {
  constructor(options?: EngineOptions);

  // ---- state (read-only) ----
  readonly ready: Promise<void>;
  readonly context: BaseAudioContext;
  readonly isOffline: boolean;
  readonly decks: readonly Deck[];
  readonly fx: readonly FxUnit[];
  readonly masterFx: FxUnit | null;
  readonly fxAssign: readonly (readonly boolean[])[];
  readonly crossfader: number;
  readonly masterVolume: number;
  readonly masterFilter: number;
  readonly headphoneVolume: number;
  readonly colorFx: ColorFxType;
  readonly colorFxEnabled: boolean;
  readonly masterIndex: number | null;
  readonly manualMasterIndex: number | null;
  readonly masterDeck: Deck | null;
  readonly masterBpm: number | null;
  readonly syncHold: boolean;
  readonly gridOffset: number;
  readonly pitchEngine: 'loading' | 'wsola' | 'fallback';
  readonly pitchEngineError: Error | null;
  readonly headphonesAvailable: boolean;
  readonly masterOut: AudioNode;
  readonly cueOut: AudioNode;

  // ---- lifecycle ----
  resume(): Promise<void>;
  tick(): void;
  startAutoTick(): void;
  stopAutoTick(): void;
  destroy(): Promise<void>;

  // ---- loading ----
  decode(source: AudioSource): Promise<AudioBuffer>;

  // ---- mixer ----
  setCrossfader(x: number): void;
  setMasterVolume(v: number): void;
  setMasterFilter(v: number): void;
  setHeadphoneVolume(v: number): void;
  setColorFx(type: ColorFxType): void;
  setColorFxEnabled(on: boolean): void;
  masterPeak(): number;

  // ---- master and sync ----
  setMaster(index: number | null): void;
  setMasterTempo(ratio: number): boolean;
  setMasterBpm(bpm: number): boolean;
  reanchorSync(index?: number): void;
  setSyncHold(on: boolean): void;

  // ---- FX ----
  assignFx(unit: number, deck: number, on?: boolean): void;
  isFxAssigned(unit: number, deck: number): boolean;
  ensureMasterFx(): FxUnit;

  // ---- outputs ----
  setOutputDevice(deviceId: string): Promise<boolean>;
  setHeadphoneDevice(deviceId: string | null): Promise<boolean>;
  getRecordingStream(): MediaStream;

  // ---- grid ----
  setGridOffset(seconds: number): void;

  // ---- events ----
  on<K extends keyof EngineEventMap>(type: K, listener: (detail: EngineEventMap[K]) => void): () => void;
  once<K extends keyof EngineEventMap>(type: K, listener: (detail: EngineEventMap[K]) => void): () => void;
  off<K extends keyof EngineEventMap>(type: K, listener: (detail: EngineEventMap[K]) => void): void;
}

type AudioSource = string | URL | Blob | ArrayBuffer | AudioBuffer;
```

#### Engine: state

| Property | Type | Default | Description |
|---|---|---|---|
| `ready` | `Promise<void>` | | Resolves once the worklet attempt and the one-off FX feedback-latency measurement have finished. Never rejects. |
| `context` | `BaseAudioContext` | | The engine's audio context. |
| `isOffline` | `boolean` | | `true` when the context is an `OfflineAudioContext`. |
| `decks` | `readonly Deck[]` | 4 decks | The decks, by index. |
| `fx` | `readonly FxUnit[]` | one unit per deck | The beat-FX units. |
| `masterFx` | `FxUnit \| null` | `null` | The master FX unit, `null` until `ensureMasterFx()`. |
| `fxAssign` | `readonly (readonly boolean[])[]` | unit u on deck u | `fxAssign[unit][deck]`: which units process which decks. |
| `crossfader` | `number` | `0.5` | 0..1; 0 = side A only. |
| `masterVolume` | `number` | `0.9` | 0..1. |
| `masterFilter` | `number` | `0` | −1..1. |
| `headphoneVolume` | `number` | `1` | 0..1. |
| `colorFx` | `ColorFxType` | `'filter'` | The mode of every channel FILTER knob. |
| `colorFxEnabled` | `boolean` | `true` | `false` = the FILTER knobs do nothing. |
| `masterIndex` | `number \| null` | `null` | The effective master: the manual one if set, otherwise the automatic one. |
| `manualMasterIndex` | `number \| null` | `null` | The master set with `setMaster()`. |
| `masterDeck` | `Deck \| null` | `null` | `decks[masterIndex]`. |
| `masterBpm` | `number \| null` | `null` | `masterDeck.effectiveBpm`. |
| `syncHold` | `boolean` | `false` | `true` while the phase lock is suspended: a nudge in progress, or `setSyncHold(true)`. |
| `gridOffset` | `number` | `0` | Global offset added to every beat-list grid, in seconds. |
| `pitchEngine` | `'loading' \| 'wsola' \| 'fallback'` | `'loading'` | The transposition engine in use: `'loading'` while the worklet loads, then `'wsola'` or `'fallback'` (always `'fallback'` with `keylock: false`). |
| `pitchEngineError` | `Error \| null` | `null` | Why the worklet is not used, after a failure. |
| `headphonesAvailable` | `boolean` | | `true` when the cue bus currently reaches an output (see the routing table). |
| `masterOut` | `AudioNode` | | The final master node, post-limiter. Connect extra taps here (analysers, recorders). |
| `cueOut` | `AudioNode` | | The headphone bus node. |

#### Engine: lifecycle

- `resume(): Promise<void>` — Resumes a realtime context. Call it from a user
  gesture, because of the browsers' autoplay policy. It is a no-op on an
  offline context. `deck.play()`, `deck.cueDown()` and `deck.loadFrom()` call
  it too. An engine can be created before that gesture: it starts its
  permanent sources (the FX modulations, the color-FX noise) on the context's
  first `running` state, so the browser logs no autoplay warning for them.
- `tick(): void` — One control step. Call it every frame (30–144 Hz), or let
  auto-tick do it. In this order, it:
  1. does the OpenMix per-frame work: FX beat alignment and ROLL driving;
     per-deck dry compensation, then the master dry compensation; master
     election; the continuous phase lock, unless `syncHold`;
  2. makes the FX units follow their reference deck's beat duration (see
     [FX](#fx));
  3. emits `'master'` if the effective master changed;
  4. emits `'tick'`.
- `startAutoTick(): void` and `stopAutoTick(): void` — Start and stop the
  automatic ticks. Auto-tick calls `tick()` from `requestAnimationFrame` while
  the page is visible, and from a timer while
  `document.visibilityState === 'hidden'` (`requestAnimationFrame` is paused in
  hidden tabs). A page can also be `visible` and get no frames at all: an
  Electron window that is not shown, minimized or occluded with
  `backgroundThrottling: false`, or an off-screen iframe. After 100 ms without
  a frame, the timer takes over until the first frame comes back. The timer
  keeps one tick every 20 ms on average: each tick is due 20 ms after the
  previous one was due, so a timer that fires late is followed by a shorter
  wait (at most one missed tick is caught up, never a burst). On Windows'
  default 15.6 ms system timer, a plain 20 ms timeout fires about every 31 ms
  (31 ticks per second, the bottom of the 30–144 Hz the lock is made for);
  this cadence keeps 50. Browsers may still throttle timers. Each auto-tick
  is wrapped in `try/catch` and reports to `onError`, so the loop never dies.
  Calling `tick()` yourself while auto-tick runs is allowed but pointless.
- `destroy(): Promise<void>` — Stops auto-tick, stops every deck and source,
  and disconnects from the outputs. It closes the headphone context and the
  engine's **own** context, never an injected one. Later calls on the engine
  are unsupported.

#### Engine: loading

- `decode(source: AudioSource): Promise<AudioBuffer>` — Fetches strings and
  URLs, reads Blobs and Files, and decodes them with `context.decodeAudioData`.
  An `ArrayBuffer` is **detached** by decoding: pass a copy
  (`buffer.slice(0)`) if you need to keep yours. An `AudioBuffer` is returned
  unchanged. Rejects on network or decode errors.

#### Engine: mixer

- `setCrossfader(x: number): void` — 0..1, default 0.5. "Mix" curve: both
  sides are at full level in the center. Decks on side `'thru'` ignore it.
- `setMasterVolume(v: number): void` — 0..1, default 0.9. It also scales the FX
  returns, as in OpenMix.
- `setMasterFilter(v: number): void` — −1..1. Below 0 a low-pass, above 0 a
  high-pass, with a neutral dead zone for |v| < 0.04 (curves in
  [Signal flow](#signal-flow)).
- `setHeadphoneVolume(v: number): void` — 0..1, default 1: the gain of the cue
  bus.
- `setColorFx(type: ColorFxType): void` — The mode of every channel FILTER
  knob (`COLOR_FX_TYPES`). Re-applies the knobs. Throws `RangeError` on an
  unknown type.
- `setColorFxEnabled(on: boolean): void` — `false` makes the FILTER knobs do
  nothing. Re-applies the knobs.
- `masterPeak(): number` — The instantaneous peak of the mix, before the
  limiter (0..~2). Poll it for a master meter.

#### Engine: master and sync

- `setMaster(index: number | null): void` — **Sets** the manual master; `null`
  returns to automatic. It is not a toggle. Emits `'master'` synchronously if
  the effective master changes. Throws `RangeError` for an out-of-range index.
- `setMasterTempo(ratio: number): boolean` — Sets the master deck's tempo
  (clamped to `TEMPO_MIN`..`TEMPO_MAX`). Synced followers follow in the same
  call. Returns `false` when there is no master deck.
- `setMasterBpm(bpm: number): boolean` — The same, as an effective BPM.
  Returns `false` without a master BPM.
- `reanchorSync(index?: number): void` — Synced decks adopt their **current**
  alignment as the new target: one deck, or all of them when `index` is
  omitted. A residue below 0.03 beat snaps to exact alignment; the master is
  never re-anchored.
- `setSyncHold(on: boolean): void` — Suspends (`true`) or resumes (`false`) the
  phase correction globally. `syncHold` also reads `true` while a deck is being
  nudged.

```js
plusButton.onclick = () => { if (engine.masterBpm) engine.setMasterBpm(engine.masterBpm + 0.5); };
```

#### Engine: FX

- `assignFx(unit: number, deck: number, on = true): void` — Assigns (or, with
  `on: false`, unassigns) a beat-FX unit to a deck, and updates the sends.
  Throws `RangeError` for out-of-range indices.
- `isFxAssigned(unit: number, deck: number): boolean` — Reads
  `fxAssign[unit][deck]`.
- `ensureMasterFx(): FxUnit` — The FX unit on the whole mix, created on the
  first call; later calls return the same unit.

#### Engine: outputs

- `setOutputDevice(deviceId: string): Promise<boolean>` — Calls
  `context.setSinkId(deviceId)` and re-applies the output wiring (the channel
  count depends on the device).
- `setHeadphoneDevice(deviceId: string | null): Promise<boolean>` — Plays the
  cue bus on another device, through a second AudioContext and a MediaStream
  bridge. `null` or `''` returns to the default routing.
- Both resolve `false`, and never throw, when `setSinkId` is unsupported, when
  the context is offline, or when the device fails.
- `getRecordingStream(): MediaStream` — The master as a `MediaStream`, created
  on the first call; it stays connected to the limiter. Throws `TypeError` on
  an offline context.

```js
const recorder = new MediaRecorder(engine.getRecordingStream());
recorder.ondataavailable = (e) => chunks.push(e.data);
recorder.start();
```

#### Engine: grid

- `setGridOffset(seconds: number): void` — A global offset added to every
  beat-list grid (default 0). Decks expose it as `deck.globalGridOffset`, and
  the grid helpers apply it. Fixed grids ignore it.

#### Engine events

- `on(type, listener): () => void`, `once(type, listener): () => void`,
  `off(type, listener): void` — Subscribe to `'tick'`, `'master'` and
  `'statechange'` (see [Events](#events)). `on` and `once` return an
  unsubscribe function.

### Deck

```ts
class Deck {
  // ---- identity / track ----
  readonly index: number;
  readonly engine: Engine;
  readonly buffer: AudioBuffer | null;
  readonly track: unknown;
  readonly peaks: Peaks | null;
  readonly loaded: boolean;
  readonly duration: number;

  // ---- transport / timing ----
  readonly playing: boolean;
  readonly position: number;
  readonly displayPosition: number;
  readonly tempo: number;
  readonly baseTempo: number;
  readonly latency: number;

  // ---- grid ----
  readonly bpm: number | null;
  readonly effectiveBpm: number | null;
  readonly beatDuration: number | null;
  readonly beats: readonly number[] | null;
  readonly beatOffset: number | null;
  readonly barAnchor: number;
  readonly gridShift: number;
  readonly globalGridOffset: number;

  // ---- sync / key ----
  readonly synced: boolean;
  readonly isMaster: boolean;
  readonly keylock: boolean;
  readonly keyShift: number;
  readonly musicKey: number | null;
  readonly heardKey: { code: number; cents: number } | null;

  // ---- cues / loops ----
  readonly cuePoint: number;
  readonly hotCues: readonly (number | null)[];
  readonly loop: LoopState;
  quantize: boolean;

  // ---- channel strip ----
  readonly volume: number;
  readonly trimValue: number;
  readonly eq: Readonly<{ low: number; mid: number; high: number }>;
  readonly kills: Readonly<{ low: boolean; mid: boolean; high: boolean }>;
  readonly filterValue: number;
  readonly headphoneCue: boolean;
  readonly crossfaderSide: CrossfaderSide;

  // ---- performance / extras ----
  readonly stemsActive: boolean;
  readonly stemStates: Readonly<Record<StemName, boolean>>;
  readonly insert: AudioNode | null;
  readonly padFx: PadFxPreset | null;
  readonly roll: { beats: number; mix: number } | null;
  readonly spinning: boolean;
  readonly scrubbing: boolean;
  readonly nudging: boolean;

  // ---- loading ----
  load(buffer: AudioBuffer, meta?: LoadMeta): void;
  loadFrom(source: AudioSource, options?: LoadFromOptions): Promise<LoadResult>;
  eject(): void;
  setPeaks(peaks: Peaks | null): void;
  setMusicKey(code: number | null): void;

  // ---- grid editing ----
  setGrid(grid: GridData): void;
  scaleGrid(factor: 2 | 0.5): boolean;
  shiftGrid(seconds: number): void;
  setDownbeat(time?: number): boolean;

  // ---- transport ----
  play(): void;
  pause(): void;
  togglePlay(): void;
  seek(time: number): void;
  currentTime(): number;

  // ---- cue ----
  cue(): void;
  cueDown(): void;
  cueUp(): void;
  setCuePoint(time?: number): void;

  // ---- hot cues ----
  setHotCue(slot: number, time?: number): boolean;
  clearHotCue(slot: number): void;
  hotCue(slot: number): boolean;

  // ---- loops & jumps ----
  setLoop(start: number, end: number): boolean;
  exitLoop(): void;
  reloop(): boolean;
  beatLoop(beats: number): boolean;
  loopIn(): boolean;
  loopOut(): boolean;
  loopHalve(): boolean;
  loopDouble(): boolean;
  beatJump(beats: number): boolean;

  // ---- tempo & sync ----
  setTempo(ratio: number): void;
  setBpm(bpm: number): boolean;
  sync(): SyncResult;
  unsync(): void;
  nudge(amount: number): boolean;
  endNudge(): void;
  snapToReference(maxBeats?: number): boolean;

  // ---- key ----
  setKeylock(on: boolean): void;
  setKey(semitones: number): void;

  // ---- channel strip ----
  setVolume(v: number): void;
  setTrim(v: number): void;
  setEq(band: EqBand, v: number): void;
  setKill(band: EqBand, on: boolean): void;
  setFilter(v: number): void;
  setHeadphoneCue(on: boolean): void;
  setCrossfaderSide(side: CrossfaderSide): void;

  // ---- performance ----
  startRoll(beats: number, mix?: number): boolean;
  setRollMix(mix: number): void;
  stopRoll(): void;
  setPadFx(preset: PadFxPreset | null): void;
  spinStart(kind: SpinKind): boolean;
  spinEnd(): void;
  scrubStart(options?: { audible?: boolean }): void;
  scrubMove(time: number): void;
  scrubEnd(options?: { resume?: boolean; snap?: boolean }): void;

  // ---- stems & insert ----
  loadStems(stems: Partial<Record<StemName, AudioBuffer>>): void;
  clearStems(): void;
  setStem(name: StemName, on: boolean): void;
  toggleStem(name: StemName): boolean;
  setInsert(node: AudioNode | null, latency?: number): void;

  // ---- meter ----
  meterPeak(): number;

  // ---- events ----
  on<K extends keyof DeckEventMap>(type: K, listener: (detail: DeckEventMap[K]) => void): () => void;
  once<K extends keyof DeckEventMap>(type: K, listener: (detail: DeckEventMap[K]) => void): () => void;
  off<K extends keyof DeckEventMap>(type: K, listener: (detail: DeckEventMap[K]) => void): void;
}

interface GridData { bpm?: number | null; beats?: number[] | null; beatOffset?: number | null; barAnchor?: number; gridShift?: number; }
interface LoadMeta extends GridData {
  hotCues?: (number | null)[];     // extra entries beyond the slot count are ignored
  cuePoint?: number;               // default 0
  peaks?: Peaks | null;
  musicKey?: number | null;
  track?: unknown;
}
interface LoadFromOptions extends LoadMeta {
  analyze?: boolean | AnalyzeOptions;   // default true: analyze what the metadata does not provide
  signal?: AbortSignal;
}
interface LoadResult extends TrackAnalysis { buffer: AudioBuffer; }   // the values applied to the deck
interface LoopState { active: boolean; start: number; end: number; beats: number | null; inPoint: number | null; }
type SyncResult = 'synced' | 'armed' | 'master' | null;
```

Decks are created by the engine (`engine.decks`).

#### Deck: state

Identity and track:

| Property | Type | Description |
|---|---|---|
| `index` | `number` | The deck's index in `engine.decks`. |
| `engine` | `Engine` | The engine that owns the deck. |
| `buffer` | `AudioBuffer \| null` | The loaded track. |
| `track` | `unknown` | Your metadata, from `load(…, { track })`; the engine never reads it. |
| `peaks` | `Peaks \| null` | Waveform peaks for drawing. |
| `loaded` | `boolean` | `true` when a track is loaded. |
| `duration` | `number` | Track duration in seconds; 0 when empty. |

Transport and timing:

| Property | Type | Description |
|---|---|---|
| `playing` | `boolean` | `true` while playing. |
| `position` | `number` | The **heard** position, in file seconds; negative during pre-roll. |
| `displayPosition` | `number` | Equals `position`, except during a brake or backspin effect, where it is the virtual position of the track that keeps running underneath. Draw with it. |
| `tempo` | `number` | The instantaneous playback rate, including the sync micro-corrections. Default 1. |
| `baseTempo` | `number` | The tempo without the sync servo's correction. Display this one. |
| `latency` | `number` | The processing latency compensated by read-ahead, in seconds: the transposer's, plus the insert's. 0 on the direct path. |

Grid:

| Property | Type | Description |
|---|---|---|
| `bpm` | `number \| null` | The track's BPM, from the grid. |
| `effectiveBpm` | `number \| null` | `bpm × baseTempo`: the BPM heard now, without the sync servo's micro-correction. |
| `beatDuration` | `number \| null` | Real seconds per beat now: the local grid period / `baseTempo`. |
| `beats` | `readonly number[] \| null` | The beat-list grid (file seconds), or `null` for a fixed grid. |
| `beatOffset` | `number \| null` | The first beat of a fixed grid. |
| `barAnchor` | `number` | The index of a beat that starts a bar. |
| `gridShift` | `number` | The manual offset of a beat-list grid, in seconds. |
| `globalGridOffset` | `number` | Equals `engine.gridOffset`, so that a deck can be passed to the grid helpers. |

Sync and key:

| Property | Type | Description |
|---|---|---|
| `synced` | `boolean` | SYNC is on. |
| `isMaster` | `boolean` | `engine.masterIndex === index`. |
| `keylock` | `boolean` | Keylock is on. Default `false`. |
| `keyShift` | `number` | Key shift in semitones, an integer from −7 to +7. Default 0. |
| `musicKey` | `number \| null` | The detected key code, 0..23 (see [Analysis](#analysis)). |
| `heardKey` | `{ code: number; cents: number } \| null` | The key heard now: the track key, plus the key shift, plus the effect of the tempo when keylock is off. `cents` is the deviation from the in-tune note. |

Cues and loops:

| Property | Type | Description |
|---|---|---|
| `cuePoint` | `number` | The cue point, in file seconds. Default 0. |
| `hotCues` | `readonly (number \| null)[]` | One entry per slot (`hotCues` option); `null` = empty. |
| `loop` | `LoopState` | `{ active, start, end, beats, inPoint }`, a fresh object on every read. `beats` is the loop length measured on the grid, rounded to 1/32 beat, and `null` without a grid; `inPoint` is the stored loop IN point. |
| `quantize` | `boolean` | **Writable**, default `true`. Snaps hot cues set at the current position, beat-loop starts and loop IN points to the grid. |

Channel strip:

| Property | Type | Description |
|---|---|---|
| `volume` | `number` | The channel fader, 0..1. Default 0.85. |
| `trimValue` | `number` | The trim, −1..1. Default 0. |
| `eq` | `{ low, mid, high }` | The EQ values, −1..1 each. Default 0. |
| `kills` | `{ low, mid, high }` | The kill state of each band (booleans). |
| `filterValue` | `number` | The FILTER knob, −1..1. Default 0. |
| `headphoneCue` | `boolean` | PFL is on. Default `false`. |
| `crossfaderSide` | `CrossfaderSide` | `'A'`, `'B'` or `'thru'`. Default A, B, A, B, … by index. |

Performance and extras:

| Property | Type | Description |
|---|---|---|
| `stemsActive` | `boolean` | Stems are loaded and play instead of the mix. |
| `stemStates` | `Record<StemName, boolean>` | Which stems are audible. |
| `insert` | `AudioNode \| null` | The current insert. |
| `padFx` | `PadFxPreset \| null` | The pad FX being held. |
| `roll` | `{ beats, mix } \| null` | The roll in progress. |
| `spinning` | `boolean` | A brake or backspin effect is in progress. |
| `scrubbing` | `boolean` | Between `scrubStart()` and `scrubEnd()`. |
| `nudging` | `boolean` | Between the first `nudge()` and `endNudge()`. |

#### Deck: loading

- `load(buffer: AudioBuffer, meta?: LoadMeta): void` — Loads a decoded track,
  like the OpenMix `loadTrack`:
  - stops playback and any roll;
  - resets the position, the cue point, the loop, the tempo (to 1), the key
    shift (to 0), the stems and the sync calibration;
  - applies `meta`. A `beats` array needs more than 2 entries to be used; given
    without `bpm`, the BPM is derived from the median beat interval. Extra
    `hotCues` entries beyond the slot count are ignored;
  - **SYNC stays on across loads** and re-aligns from the first frame. Keylock
    stays as it was;
  - emits `'load'`.

  Throws `TypeError` when `buffer` is not an AudioBuffer-like object.
- `loadFrom(source: AudioSource, options?: LoadFromOptions): Promise<LoadResult>` —
  Decodes, analyzes and loads in one call:
  1. calls `engine.resume()` synchronously, while the user gesture is still
     valid;
  2. decodes the source (`engine.decode()`);
  3. analyzes what `options` does not provide, with `analyzeTrack()` and the
     given `AnalyzeOptions`: the BPM and grid unless `bpm` or `beats` is given,
     the key unless `musicKey` is given, the peaks unless `peaks` is given.
     `analyze: false` analyzes nothing;
  4. calls `load()`.

  It resolves with the values applied to the deck, plus the buffer. A newer
  `loadFrom()` on the same deck, or an abort through `signal`, rejects the
  older call with an `Error` named `'AbortError'`, without touching the deck.
- `eject(): void` — Stops the deck and clears everything track-related: buffer,
  grid, peaks, track, stems, loop and hot cues. Emits `'eject'`.
- `setPeaks(peaks: Peaks | null): void` and `setMusicKey(code: number | null): void` —
  Set the value, without any other effect (for example after analyzing in the
  background).

```js
const controller = new AbortController();
cancelButton.onclick = () => controller.abort();
try {
  const result = await deck.loadFrom(url, { hotCues: savedCues, track: { title }, signal: controller.signal });
  console.log(result.bpm, result.musicKey);
} catch (error) {
  if (error.name !== 'AbortError') throw error;
}
```

#### Deck: grid editing

- `setGrid(grid: GridData): void` — Replaces only the given fields.
  - A `bpm` without `beats` makes a fixed grid: `beats` becomes `null`, and
    `beatOffset` defaults to 0 when unknown. This is the OpenMix "BPM
    correction".
  - If the BPM or the beat list changed, the deck leaves SYNC (`'sync'` event)
    and its sync calibration is reset.
  - Emits `'grid'`.
- `scaleGrid(factor: 2 | 0.5): boolean` — The ×2 / ÷2 grid. On a beat list, ×2
  inserts midpoints and doubles `barAnchor`, and ÷2 keeps every other beat with
  the parity of `barAnchor`. The new BPM (`bpm × factor`) must stay within
  40–320. Leaves SYNC and emits `'grid'`. Returns `false` without a BPM or when
  the new BPM is out of range.
- `shiftGrid(seconds: number): void` — On a beat list, `gridShift += seconds`;
  on a fixed grid, `beatOffset = max(0, beatOffset + seconds)`. Emits `'grid'`.
- `setDownbeat(time = position): boolean` — The beat nearest to `time` becomes
  a bar start, placed exactly at `time`. On a beat list, `gridShift` is adjusted
  and `barAnchor` is set to that beat; on a fixed grid, `beatOffset = time`.
  Emits `'grid'`. Returns `false` without a buffer or a BPM.

#### Deck: transport

- `play(): void` — Starts playback, 30 ms ahead and sample-accurate. From the
  end of the track, it restarts at 0. It calls `engine.resume()`. **A synced
  deck that is not the master is aligned to the master right after it
  starts** (tempo and bars). Emits `'play'`. The internal restarts (cue
  preview, end of a spin, end of a scrub) never re-align.
- `pause(): void` — Stops playback and any roll, and keeps the heard position.
  It cuts the transposer's reserve (about 55 ms) so that it is not replayed on
  resume. Emits `'pause'`.
- `togglePlay(): void` — `play()` when paused, `pause()` when playing.
- `seek(time: number): void` — Moves the position. `time` is clamped to
  `[−PRE_ROLL, duration]`; negative positions are silence before the track
  start. Jumping outside the active loop disables the loop (`'loop'` event).
  While playing, the restart is compensated for the 30 ms scheduling.
- `currentTime(): number` — Same as `position`, kept for OpenMix
  compatibility.

#### Deck: cue

- `cue(): void` — Behaves like a CDJ cue button:
  - while playing: back to the cue point, and pause;
  - while paused at the cue point (within 20 ms): re-seek to it;
  - while paused elsewhere: sets the cue point here (`'cuepoint'` event).

  The cue point itself is never quantized, as in OpenMix.
- `cueDown(): void` and `cueUp(): void` — Hold-to-preview, for a cue button
  that you hold (`pointerdown` / `pointerup`):
  - `cueDown()` while playing is the same as `cue()`;
  - `cueDown()` while paused away from the cue point sets the cue point;
  - `cueDown()` while paused at the cue point plays while held;
  - `cueUp()` after a preview goes back to the cue point and pauses.

  `cueDown()` calls `engine.resume()`.
- `setCuePoint(time = position): void` — Sets the cue point. Emits
  `'cuepoint'`.

```js
cueButton.onpointerdown = () => deck.cueDown();
cueButton.onpointerup = () => deck.cueUp();
```

#### Deck: hot cues

- `setHotCue(slot: number, time?: number): boolean` — Stores a hot cue.
  Without `time`, it uses the current position, snapped to the nearest beat
  when `quantize` is on and a grid exists; an explicit `time` is stored as is.
  Emits `'hotcue'`. Returns `false` without a track.
- `clearHotCue(slot: number): void` — Empties the slot. Emits `'hotcue'` with
  `time: null`.
- `hotCue(slot: number): boolean` — The pad press: sets the slot (as above) if
  it is empty, otherwise jumps there with `seek()`, leaving the play state
  unchanged. Returns `false` without a track.

Slots outside `0 .. hotCues − 1` throw `RangeError`. `HOT_CUE_COLORS` gives the
slot colors used by the waveforms.

```js
pad.onclick = (e) => (e.shiftKey ? deck.clearHotCue(i) : deck.hotCue(i));
deck.on('hotcue', () => saveHotCues(deck.track, deck.hotCues));
```

#### Deck: loops and jumps

- `setLoop(start: number, end: number): boolean` — A sample-accurate native
  loop between `start` and `end` (file seconds), at least 10 ms long, clamped to
  the track. Emits `'loop'`. Returns `false` when no such loop can be made (no
  track, or less than 10 ms).
- `exitLoop(): void` — Disables the loop.
- `reloop(): boolean` — Re-activates the last loop without jumping; the
  playhead wraps if it is past the end (the OpenMix MIDI reloop). Returns
  `false` when there is no loop to re-activate.
- `beatLoop(beats: number): boolean` — A loop of `beats` beats on the grid. It
  needs a BPM.
  - With an active loop, it resizes the loop from its start; beat-list grids
    follow the real beats.
  - Otherwise, it starts a loop at the current position, snapped to the nearest
    ¼ beat when `quantize` is on.
  - Emits `'loop'`. Returns `false` without a BPM.
- `loopIn(): boolean` — Stores the IN point (`loop.inPoint`), snapped to the
  nearest beat when `quantize` is on. Emits `'loop'`. Returns `false` without
  a track.
- `loopOut(): boolean` — Sets the OUT point at the current position and
  activates the loop. It needs an IN point and an OUT more than 50 ms after
  IN, and returns `false` otherwise. Emits `'loop'`.
- `loopHalve(): boolean` and `loopDouble(): boolean` — Apply only to an active
  loop. Halving needs the half length to be at least ⅛ beat (50 ms without a
  BPM); doubling needs the new end to stay inside the track. They emit
  `'loop'`, and return `false` when the rule is not met.
- `beatJump(beats: number): boolean` — Jumps ±`beats` on the grid: beat lists
  follow the real beats, and fixed grids use `60 / bpm`. With an active loop,
  the loop moves by the same amount, clamped to the track. Returns `false`
  without a BPM.

The hardware convention "IN halves and OUT doubles during a loop" stays in
apps:

```js
inButton.onclick = () => (deck.loop.active ? deck.loopHalve() : deck.loopIn());
outButton.onclick = () => (deck.loop.active ? deck.loopDouble() : deck.loopOut());
jumpBackButton.onclick = () => deck.beatJump(-4 * 4);   // 4 bars back
```

#### Deck: tempo and sync

- `setTempo(ratio: number): void` — Sets the tempo, clamped to
  [`TEMPO_MIN`, `TEMPO_MAX`] = [0.5, 1.6]. On a synced **follower**, it leaves
  SYNC first (`'sync'` event), like moving its tempo fader. On the master, the
  synced followers follow in the same call, and the master's sync base is
  updated when it has one. (The sync servo uses an internal rate setter that
  never unsyncs.)
- `setBpm(bpm: number): boolean` — `setTempo(bpm / deck.bpm)`. Returns `false`
  without a BPM.
- `sync(): SyncResult` — Turns SYNC on: returns `'master'`, `'synced'`,
  `'armed'` or `null` (table in [Sync and phase lock](#sync-and-phase-lock)).
  Emits `'sync'` when the flag changes.
- `unsync(): void` — Turns SYNC off. Emits `'sync'`.
- `nudge(amount: number): boolean` — A pitch bend, as from a jog wheel:
  `amount` is clamped to ±0.5, and ±0.06 is a typical full deflection. See
  [Nudge and reanchor](#sync-and-phase-lock). Returns `false` when the deck is
  not playing.
- `endNudge(): void` — Ends the bend: restores the base tempo, and when no deck
  holds any more, every synced deck adopts the new alignment.
- `snapToReference(maxBeats = 0.06): boolean` — The discreet magnet: if another
  deck with a grid plays (the manual master is preferred) and this deck's beat
  phase is within `maxBeats` of it, seeks to the exact alignment and returns
  `true`.

#### Deck: key

- `setKeylock(on: boolean): void` — Keeps the key when the tempo changes.
- `setKey(semitones: number): void` — Transposes at the same speed. Rounds to an
  integer and clamps to ±7 (`KEY_SHIFT_MIN`..`KEY_SHIFT_MAX`).
- Both route the deck through the transposer while
  `keylock || keyShift !== 0` (see
  [Keylock](#keylock-and-latency-compensation)).

#### Deck: channel strip

The value mappings are in [Signal flow](#signal-flow).

- `setVolume(v: number): void` — The channel fader, 0..1 (gain v²).
- `setTrim(v: number): void` — The trim, −1..1 (−12 … +12 dB).
- `setEq(band: EqBand, v: number): void` — `'low'`, `'mid'` or `'high'`, −1..1:
  −1 is a −40 dB kill, +1 is +6 dB. Throws `RangeError` for another band.
- `setKill(band: EqBand, on: boolean): void` — Remembers the band's value, sets
  it to −1 (−40 dB), and restores it when `on` is `false`. Works on every band.
- `setFilter(v: number): void` — The channel FILTER knob, −1..1. What it does
  follows the engine's color FX mode (`engine.setColorFx()`).
- `setHeadphoneCue(on: boolean): void` — Sends the deck to the cue bus,
  pre-fader (PFL).
- `setCrossfaderSide(side: CrossfaderSide): void` — `'A'`, `'B'` or `'thru'`
  (always at full level, whatever the crossfader). Throws `RangeError` for
  another value.

#### Deck: performance

- `startRoll(beats: number, mix = 1): boolean` — A slip roll: loops the current
  grid slice of `beats` beats (slices are aligned to multiples of `beats` from
  `barAnchor`), while the track keeps running silently underneath. Needs a
  playing deck with a grid; returns `false` otherwise.
- `setRollMix(mix: number): void` — 0 = the track only, 1 = the loop only.
- `stopRoll(): void` — Ends the roll; the track resumes exactly where it would
  be.
- `setPadFx(preset: PadFxPreset | null): void` — A momentary FX on this deck,
  through an independent unit created on demand. `{ type: 'roll', beats }` is a
  slip roll. Any other type uses the pad-FX unit (type, beats, level), and while
  it is held the deck's dry is reduced to `preset.dry ?? PAD_FX_DRY[type] ?? 1`.
  `null` turns it off.
- `spinStart(kind: SpinKind): boolean` and `spinEnd(): void` — A turntable
  brake (`'brake'`, or its alias `'vbrake'`) or backspin (`'backspin'`) sound
  effect. During the effect, the deck is paused and the track virtually keeps
  running: `displayPosition` shows that virtual position. `spinEnd()` resumes
  exactly where the track would be if it was playing; otherwise it returns to
  the starting point. The clock is the audio clock. `spinStart()` returns
  `false` without a track.
- `scrubStart({ audible = true } = {}): void`, `scrubMove(time: number): void`,
  `scrubEnd({ resume = true, snap = true } = {}): void` — A scratch on the
  waveform:
  - `scrubStart` pauses the deck and remembers whether it was playing;
  - `scrubMove` plays audible grains at the gesture speed, on the zero-latency
    path; with `audible: false`, it seeks silently;
  - `scrubEnd` resumes if the deck was playing (unless `resume: false`), then
    calls `snapToReference()` (when `snap` is on), then `engine.reanchorSync()`
    (always).

```js
let grab = null;
waveform.onpointerdown = (e) => { grab = { x: e.clientX, t: deck.position }; deck.scrubStart(); };
waveform.onpointermove = (e) => {
  if (!grab) return;
  const secondsPerPixel = (8 * deck.baseTempo) / waveform.clientWidth;
  deck.scrubMove(grab.t - (e.clientX - grab.x) * secondsPerPixel);
};
waveform.onpointerup = () => { grab = null; deck.scrubEnd(); };
```

#### Deck: stems and insert

- `loadStems(stems: Partial<Record<StemName, AudioBuffer>>): void` — Takes
  stem buffers (`vocals`, `drums`, `bass`, `other`) on the track's timeline.
  They play instead of the mix; bass + other is the instrumental. The package
  does not separate stems: you supply them.
- `setStem(name: StemName, on: boolean): void` — Mutes or unmutes one stem.
- `toggleStem(name: StemName): boolean` — Flips one stem and returns its new
  state (`true` = audible).
- `clearStems(): void` — Back to the full mix, restarting seamlessly when
  playing.
- `setInsert(node: AudioNode | null, latency = 0): void` — A generic insert
  between the filter and the fader, cue and meter taps, with its fixed latency
  in seconds compensated by read-ahead. While playing, it causes one brief
  restart. See [The insert hook](#the-insert-hook).

#### Deck: meter

- `meterPeak(): number` — The instantaneous peak (0..~2), after the EQ, the
  filter and the insert, and before the fader. Poll it for a channel meter.

#### Deck events

- `on(type, listener): () => void`, `once(type, listener): () => void`,
  `off(type, listener): void` — Subscribe to `'load'`, `'eject'`, `'play'`,
  `'pause'`, `'ended'`, `'loop'`, `'hotcue'`, `'cuepoint'`, `'sync'` and
  `'grid'` (see [Events](#events)).

### FxUnit

```ts
class FxUnit {                                 // created by the engine only
  readonly type: FxType;                       // default 'echo'
  readonly enabled: boolean;                   // default false
  readonly level: number;                      // 0..1, default 0
  readonly beats: number;                      // beat multiple, default 0.5
  readonly beatDuration: number;               // seconds per beat followed, default 0.5
  setType(type: FxType): void;
  setEnabled(on: boolean): void;
  setLevel(v: number): void;
  setBeats(beats: number): void;
  setBeatDuration(seconds: number): void;
}
```

Units come from `engine.fx`, `engine.ensureMasterFx()`, and internally from
`deck.setPadFx()`.

| Member | Description |
|---|---|
| `type` | The effect, one of the `FX_TYPES` ids. Default `'echo'`. |
| `enabled` | Default `false`. |
| `level` | 0..1, default 0: units always start at the minimum. |
| `beats` | The beat multiple, default 0.5. Typical values: `FX_BEATS`. |
| `beatDuration` | The seconds per beat that the unit currently follows. Default 0.5. |
| `setType(type)` | Changes the effect. Throws `RangeError` on an unknown type. |
| `setEnabled(on)` | Turns the unit on or off; the engine updates the deck sends automatically. |
| `setLevel(v)` | 0..1. Sets the wet gain and also drives the feedback or depth inside the effect. |
| `setBeats(beats)` | The beat multiple, > 0. Delay times are `beatDuration × beats` (0.02–3.9 s). |
| `setBeatDuration(seconds)` | Sets the beat duration by hand. `tick()` overrides it while a reference deck plays (see [FX](#fx)). |

### Events

```ts
interface DeckEventMap {
  load:     { deck: Deck; index: number; track: unknown; duration: number };
  eject:    { deck: Deck; index: number };
  play:     { deck: Deck; index: number; position: number };
  pause:    { deck: Deck; index: number; position: number };
  ended:    { deck: Deck; index: number };                      // natural end of the track
  loop:     { deck: Deck; index: number } & LoopState;          // any loop change
  hotcue:   { deck: Deck; index: number; slot: number; time: number | null };
  cuepoint: { deck: Deck; index: number; time: number };
  sync:     { deck: Deck; index: number; synced: boolean };     // the synced flag flipped
  grid:     { deck: Deck; index: number; bpm: number | null; beats: readonly number[] | null;
              beatOffset: number | null; barAnchor: number; gridShift: number };
}
interface EngineEventMap {
  tick:        { engine: Engine; time: number };               // context time at the end of tick()
  master:      { engine: Engine; index: number | null; deck: Deck | null; manual: boolean };
  statechange: { engine: Engine; state: AudioContextState };   // proxies the context's 'statechange'
}
```

- Every deck event detail includes `deck` and `index`; every engine event
  detail includes `engine`.
- `on(type, listener)` returns an unsubscribe function; `once()` listens once;
  `off(type, listener)` removes a listener.
- Events are emitted synchronously, after the state has changed. A listener
  that throws is reported to `options.onError` (default `console.error`) and
  never breaks the engine or the tick.

When they fire:

- **`play` / `pause`** fire on every flip of `playing`, including internal ones
  (cue, spin, scrub).
- **`ended`** fires at the natural end of the track.
- **`master`** fires when the effective master index changes: from `tick()`,
  and synchronously from `setMaster()`. Nothing fires at creation. `manual`
  tells whether the effective master is the manual one.
- **`hotcue`, `loop` and `grid`** let apps persist user edits.
- **`load`, `eject`, `cuepoint`, `sync`** fire from the methods documented
  above.
- **`tick`** fires at the end of every `tick()`, with the context time.
- **`statechange`** proxies the context's `'statechange'` event; `state` is the
  context's new `state`.
- **Positions, tempos and meters** have no events: poll them in your frame loop
  or on `'tick'`.

```js
const stop = deck.on('loop', ({ active, start, end, beats }) => showLoop(active, start, end, beats));
deck.once('load', ({ duration }) => console.log('loaded', duration));
engine.on('statechange', ({ state }) => { startButton.hidden = state === 'running'; });
stop();                            // unsubscribe
```

### Analysis

Import from `@openmix/web-engine/analysis` (no engine, no DOM) or from the main
entry. `analyzeBpm()` and `analyzeKey()` resample the track to 8 kHz through an
`OfflineAudioContext` (and `computePeaks()` renders its bands at 16 kHz the
same way).

```ts
interface AnalyzeBpmOptions { minBpm?: number; maxBpm?: number; }   // default 85..170
interface BpmResult {
  bpm: number;                 // 3 decimals; integer-locked on rigid grids (e.g. 128.00)
  beatOffset: number;          // first beat (s)
  beats: number[] | null;      // every beat (s); null when ≤ 8 beats
  barAnchor: number;           // index of a downbeat starting a phrase
  rigid: boolean;              // constant-tempo (DAW) grid detected
  deviationMs: number;         // median phase deviation per chunk (ms); large = variable tempo
}
function analyzeBpm(buffer: AudioBuffer, options?: AnalyzeBpmOptions): Promise<BpmResult | null>;

interface KeyResult { code: number; name: string; camelot: string; confidence: number; score: number; tuning: number; }
function analyzeKey(buffer: AudioBuffer): Promise<KeyResult | null>;
function keyFromMono(samples: Float32Array, sampleRate?: number, yieldEvery?: number):
  Promise<{ code: number; confidence: number; score: number; tuning: number } | null>;
function keyFromChroma(chroma: ArrayLike<number>): { code: number; confidence: number; score: number };

function camelot(code: number | null): { num: number; letter: 'A' | 'B' } | null;
function camelotLabel(code: number | null): string;
function keyName(code: number | null): string;
function shiftKey(code: number, semitones: number): number;
function keyDistance(a: number, b: number): 0 | 1 | 2 | 3 | null;
function heardKey(deck: { musicKey: number | null; keyShift?: number; keylock?: boolean; tempo?: number }):
  { code: number; cents: number } | null;
function alignImportedGrid(buffer: AudioBuffer, beats: number[]): { beats: number[]; shift: number };

interface AnalyzeOptions extends AnalyzeBpmOptions {
  bpm?: boolean; key?: boolean; peaks?: boolean;      // each default true
  peaksPerSecond?: number;                            // default 400
  fine?: boolean;                                     // default true (fine zoom envelope)
}
interface TrackAnalysis {
  bpm: number | null; beats: number[] | null; beatOffset: number | null; barAnchor: number; rigid: boolean;
  musicKey: number | null; keyConfidence: number | null; peaks: Peaks | null;
}
function analyzeTrack(buffer: AudioBuffer, options?: AnalyzeOptions): Promise<TrackAnalysis>;
```

**Key codes.** 0–11 are the major keys C … B, and 12–23 the minor keys Cm … Bm:

| | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| major (code) | C | Db | D | Eb | E | F | F# | G | Ab | A | Bb | B |
| minor (code − 12) | Cm | C#m | Dm | Ebm | Em | Fm | F#m | Gm | G#m | Am | Bbm | Bm |

- `analyzeBpm(buffer, { minBpm = 85, maxBpm = 170 } = {})` — The BPM and beat
  grid (method in [Beat grids and analysis](#beat-grids-and-analysis)). The
  octave ceiling is `max(maxBpm × 1.06, 180)`. Resolves with `null` when the
  track is shorter than 5 s or has no detectable beat. Feed the result to
  `deck.load()` or `deck.setGrid()`. As in OpenMix, it reads at most the first
  10 minutes of the track; the grid helpers extrapolate beyond.
- `analyzeKey(buffer)` — The musical key: `code` (0..23), `name` (for example
  `'Am'`), `camelot` (for example `'8A'`), `confidence` (the score margin over
  the second-best key), `score` (the best correlation) and `tuning` (the
  detected tuning offset, in semitones, within ±⅓). Resolves with `null` when
  the audio is too short or silent.
- `keyFromMono(samples, sampleRate = 8000, yieldEvery = 0)` — The key detection
  core, on mono samples. `sampleRate` must be 8000: resample first, as
  `analyzeKey()` does; another rate rejects. `yieldEvery` > 0 yields to the
  event loop every that many frames. Resolves with `null` when the signal is
  too short or silent.
- `keyFromChroma(chroma)` — The key of a 12-bin chroma (index 0 = C, energy per
  pitch class), correlated with the KeyFinder profiles.
- `camelot(code)` — `{ num, letter }` on the Camelot wheel: letter `'A'` for
  minor keys and `'B'` for major keys; C major = 8B, A minor = 8A. `null` for
  `null`.
- `camelotLabel(code)` — `'8A'`, or `''` for `null`.
- `keyName(code)` — `'C'`, `'F#'`, `'Am'` …, or `''` for `null`.
- `shiftKey(code, semitones)` — Transposes a key code, keeping its mode, with
  wrap-around (C major + 1 = Db major, B major + 1 = C major).
- `keyDistance(a, b)` — Harmonic compatibility on the Camelot wheel: 0 = the
  same key, 1 = a neighbor or the relative key, 2 = an "energy" move, 3 = a
  clash, `null` when a key is unknown.
- `heardKey(deck)` — The key a deck is heard in: its `musicKey`, plus
  `keyShift`, plus the effect of `tempo` when `keylock` is off (speeding up
  raises the pitch). `cents` is the deviation from the in-tune note (±50). A
  `Deck` works as the argument, and so does a plain object.
- `alignImportedGrid(buffer, beats)` — Re-aligns a grid imported from other
  software onto this decoder's timeline, by measuring the median offset to the
  real transients (typically about 51 ms for LAME MP3s). Returns the shifted
  beats and the `shift` applied, in seconds; `shift` is 0 and the beats are
  unchanged when no reliable offset is found.
- `analyzeTrack(buffer, options?)` — Runs the BPM, key and peaks analyses
  (each can be turned off with `bpm`, `key` or `peaks: false`). It never
  rejects because an analysis failed: a part that fails is returned as `null`.
  `keyConfidence` is the key's `confidence`. `deck.loadFrom()` uses it.

```js
import { analyzeTrack, camelotLabel, keyDistance } from '@openmix/web-engine/analysis';

const buffer = await engine.decode(file);                // any decoded AudioBuffer works
const { bpm, beats, musicKey, peaks } = await analyzeTrack(buffer);
console.log(bpm, camelotLabel(musicKey));                // '' when no key was found
const playing = engine.decks[0].musicKey;
const compatible = musicKey !== null && playing !== null
  && keyDistance(musicKey, playing) <= 1;                // same key, neighbor or relative
```

### Waveform

Import from `@openmix/web-engine/waveform` or from the main entry.

```ts
interface Peaks {
  top: Float32Array; bottom: Float32Array;           // signed max/min per slice (per channel, never L+R averaged)
  low: Float32Array; mid: Float32Array; high: Float32Array;  // band peaks per slice
  fineTop: Int8Array; fineBottom: Int8Array;         // fine envelope (4000 pts/s, ×127)
  finePps: number;                                   // 4000, or 0 when fine: false
  perSecond: number; duration: number;
}
function computePeaks(buffer: AudioBuffer, options?: { perSecond?: number; fine?: boolean }): Promise<Peaks>;

type WavePalette = 'rgb' | 'mono' | 'blueorange' | 'neon' | 'club';
const WAVE_PALETTES: readonly WavePalette[];        // ['rgb', 'mono', 'blueorange', 'neon', 'club']

interface DeckView {                                 // a Deck satisfies it; plain objects work too
  peaks: Peaks | null; buffer?: AudioBuffer | null;
  displayPosition?: number; position?: number; currentTime?(): number;   // first defined one wins
  cuePoint?: number | null; hotCues?: readonly (number | null)[];
  loop?: { active: boolean; start: number; end: number; inPoint?: number | null };
  bpm?: number | null; beats?: readonly number[] | null; beatOffset?: number | null;
  barAnchor?: number; gridShift?: number; globalGridOffset?: number;
}
function drawZoom(canvas: HTMLCanvasElement, deck: DeckView,
                  options?: { windowSeconds?: number; time?: number; palette?: WavePalette }): void;
function drawOverview(canvas: HTMLCanvasElement, deck: DeckView,
                      options?: { time?: number; palette?: WavePalette }): void;
function fitCanvas(canvas: HTMLCanvasElement): boolean;
```

- `computePeaks(buffer, { perSecond = 400, fine = true } = {})` — Computes the
  waveform data: a signed envelope per slice (taken per channel, never as an
  L+R average, so that drops in phase opposition still show), the low, mid and
  high band peaks per slice, and a fine envelope at 4000 points per second for
  deep zooms. `top`, `bottom`, `low`, `mid` and `high` have
  ⌈duration × perSecond⌉ entries. `fine: false` skips the fine envelope
  (`finePps === 0`), which saves memory for thumbnails. The bands are rendered
  at 16 kHz with an `OfflineAudioContext`.
- `drawZoom(canvas, deck, { windowSeconds = 8, time, palette = 'rgb' } = {})` —
  A scrolling window centered on the position, `windowSeconds` wide (8 s by
  default).
  - The rendering is cached in a pre-rendered strip three windows wide. A frame
    costs one GPU copy, plus one third of the strip repainted per frame after a
    jump.
  - **The playhead line is not drawn**: draw it at the horizontal center.
  - To give two decks at the same effective BPM equal beat widths, pass
    `windowSeconds: base × deck.baseTempo`.
- `drawOverview(canvas, deck, { time, palette = 'rgb' } = {})` — The whole
  track: the rendering is cached, and each frame draws the played part at full
  intensity, plus a white playhead.
- `time` overrides the drawn position. Otherwise the position is the first
  defined of `displayPosition`, `position` and `currentTime()`.
- `palette` is one of `WAVE_PALETTES`.
- `fitCanvas(canvas)` — Sets the canvas backing store to its CSS size ×
  `devicePixelRatio`, and returns `true` if it resized it. Use it before drawing
  your own overlays, such as the playhead.

Rendering notes:

- The rendering is identical to OpenMix: the same colors and grid lines (beats,
  red bar lines, reinforced phrase lines), the loop band with IN/OUT flags, the
  CUE marker, the lettered hot-cue flags, and the dimming of the part not yet
  played.
- The canvas caches live in a module `WeakMap` keyed by canvas, not in expando
  properties.
- A zero-size or hidden canvas draws nothing and never throws.
- Offscreen buffers use `OffscreenCanvas` when available, otherwise
  `document.createElement('canvas')`.

```js
import { computePeaks, drawOverview, drawZoom } from '@openmix/web-engine/waveform';

const peaks = await computePeaks(buffer, { fine: false });
const view = { peaks, buffer, position: 30, bpm: 128, beatOffset: 0.12 };   // a plain object works too
drawZoom(zoomCanvas, view, { windowSeconds: 6, palette: 'club' });
drawOverview(overviewCanvas, view, { palette: 'club' });
```

### Grid helpers

Pure functions over any grid-like object; a `Deck` qualifies.

```ts
interface GridLike {
  bpm?: number | null; beats?: readonly number[] | null; beatOffset?: number | null;
  barAnchor?: number; gridShift?: number; globalGridOffset?: number;
}
function gridIndexFracAt(grid: GridLike, time: number): number | null;
function gridTimeAtIndex(grid: GridLike, index: number): number | null;
function gridPeriodAt(grid: GridLike, time: number): number | null;
function barAlignedSeekTime(grid: GridLike, fromTime: number, toTime: number): number;
function snapToBeat(grid: GridLike, time: number, division?: number): number;
```

- `gridIndexFracAt(grid, time)` — The fractional beat index at `time` on a beat
  list (2.5 = halfway between beats 2 and 3).
- `gridTimeAtIndex(grid, index)` — The inverse: the time of a fractional beat
  index. It extrapolates at both ends with the edge periods.
- `gridPeriodAt(grid, time)` — The local beat period at `time`, in file
  seconds.
- These three return `null` unless the grid has a beat list of at least 2
  beats.
- `barAlignedSeekTime(grid, fromTime, toTime)` — A "bar-intact" jump target:
  the time in the bar that contains `toTime`, at the same phase within the bar
  as `fromTime`. Use it for clicks on an overview. It returns `toTime`
  unchanged when the grid cannot tell.
- `snapToBeat(grid, time, division = 1)` — The nearest 1/`division` beat
  (1 = whole beats, 4 = quarter beats), never below 0. It handles both grid
  kinds, and returns `time` unchanged without a grid.
- **Shifts:** the beat-list helpers use `time − (gridShift + globalGridOffset)`.
  The fixed-grid code paths use `bpm` and `beatOffset` and ignore the shifts,
  exactly as in OpenMix.

```js
import { gridIndexFracAt, gridTimeAtIndex, snapToBeat, barAlignedSeekTime } from './vendor/web-engine/src/index.js';

const grid = { bpm: 120, beats: [0, 0.5, 1, 1.5, 2, 2.5], barAnchor: 0 };
gridIndexFracAt(grid, 1.25);          // 2.5
gridTimeAtIndex(grid, 8);             // 4: extrapolated with the last period
snapToBeat(grid, 1.13, 4);            // 1.125: the nearest quarter beat
overview.onclick = (e) => {
  const target = (e.offsetX / overview.clientWidth) * deck.duration;
  deck.seek(barAlignedSeekTime(deck, deck.position, target));
};
```

### Offline

```ts
interface RenderOfflineOptions { tickRate?: number; onTick?: (time: number) => void | Promise<void>; }
function renderOffline(engine: Engine, options?: RenderOfflineOptions): Promise<AudioBuffer>;
```

- `renderOffline(engine, { tickRate = 60, onTick } = {})` — Renders the
  engine's `OfflineAudioContext` and calls `engine.tick()` during the render.
  - Throws `TypeError` unless `engine.context` is an `OfflineAudioContext` that
    has not rendered yet.
  - With `tickRate > 0`, it needs `OfflineAudioContext.prototype.suspend`. When
    that is missing, it rejects with a clear `Error` that suggests
    `tickRate: 0`.
  - Tick times are multiples of `1 / tickRate`, rounded **up** to render-quantum
    (128-frame) boundaries. They are deduplicated, strictly increasing, and
    below the end of the render.
  - At each tick: `engine.tick()`, then `await onTick?.(time)`, then
    `context.resume()`.
  - The next suspend is scheduled from inside the handler, so long renders do
    not queue thousands of suspends.
  - Resolves with the result of `startRendering()`.

Examples are in [Offline rendering and testing](#offline-rendering-and-testing).

### Constants and types

```ts
const VERSION: string;                       // '0.1.0', equal to package.json "version"
const TEMPO_MIN = 0.5, TEMPO_MAX = 1.6;
const KEY_SHIFT_MIN = -7, KEY_SHIFT_MAX = 7;
const PRE_ROLL = 3600;                       // seconds of allowed negative position
const WSOLA_LATENCY_SAMPLES = 2647;          // equal to LAT in worklets/pitch-processor.js
const PITCH_PROCESSOR_NAME = 'openmix-pitch-shift';
const HOT_CUE_COLORS: readonly string[];     // ['#ff3b30','#ff9500','#ffcc00','#34c759','#5ac8fa','#3b82f7','#af52de','#ff2d55'], cycled
const FX_BEATS: readonly number[];           // [0.25, 0.5, 0.75, 1, 2, 4, 8, 16, 32]
const FX_TYPES: readonly { id: FxType; label: string }[];
const COLOR_FX_TYPES: readonly { id: ColorFxType; label: string }[];
const FX_DRY_CUT: Readonly<Partial<Record<FxType, number>>>;       // { trans:1, filter:1, crush:1, robot:1, pan:1, roll:0, flanger:0.5, phaser:0.5, reverb:0.3 }
function fxDryCut(type: FxType): number;                           // FX_DRY_CUT[type] ?? 0.45
const PAD_FX_DRY: Readonly<Partial<Record<FxType, number>>>;       // { roll:0, filter:0, trans:0, echo:0.2, mtdelay:0.25, reverb:0.45, flanger:1 }
const DEFAULT_PAD_FX: readonly (PadFxPreset | { label: string; spin: SpinKind })[];

type FxType = 'delay' | 'echo' | 'spiral' | 'mtdelay' | 'upecho' | 'downecho' | 'lowcut' | 'pingpong'
  | 'reverb' | 'flanger' | 'phaser' | 'pan' | 'trans' | 'filter' | 'roll' | 'robot' | 'helix' | 'crush';
type ColorFxType = 'filter' | 'dubecho' | 'hpfecho' | 'lpfecho' | 'bpfecho' | 'crushecho' | 'reverb' | 'noise' | 'crush';
type CrossfaderSide = 'A' | 'B' | 'thru';
type EqBand = 'low' | 'mid' | 'high';
type StemName = 'vocals' | 'drums' | 'bass' | 'other';
type SpinKind = 'brake' | 'backspin';
interface PadFxPreset { type: FxType; beats: number; level?: number; dry?: number; label?: string; }
```

| Constant | Value | Use |
|---|---|---|
| `VERSION` | `'0.1.0'` | The package version. |
| `TEMPO_MIN`, `TEMPO_MAX` | 0.5, 1.6 | The tempo range (−50 % … +60 %). |
| `KEY_SHIFT_MIN`, `KEY_SHIFT_MAX` | −7, 7 | The key shift range, in semitones. |
| `PRE_ROLL` | 3600 | Seconds of negative position allowed before the track start. |
| `WSOLA_LATENCY_SAMPLES` | 2647 | The fixed latency of the WSOLA worklet, in samples. |
| `PITCH_PROCESSOR_NAME` | `'openmix-pitch-shift'` | The worklet's processor name. |
| `HOT_CUE_COLORS` | 8 colors | Hot-cue colors by slot, cycled beyond 8 slots. |
| `FX_BEATS` | `[0.25, 0.5, 0.75, 1, 2, 4, 8, 16, 32]` | Typical beat multiples for `fx.setBeats()`. |
| `FX_DRY_CUT` and `fxDryCut(type)` | see above | The share of the dry removed at full level, per FX type (0.45 by default). |
| `PAD_FX_DRY` | see above | The deck's dry while a pad FX of that type is held. |

The FX tables reproduce the OpenMix option lists exactly. The ids are the API;
the labels are suggestions for UIs.

**`FX_TYPES`** (18), for beat-FX units, pad FX and the master FX:

| id | label | What it does |
|---|---|---|
| `delay` | Delay | A plain delay with light feedback. |
| `echo` | Echo | A delay with feedback and a low cut in the loop. The default type. |
| `spiral` | Spiral | An echo whose repeats go through a band-pass, with a long tail. |
| `mtdelay` | MT Delay | A multi-tap delay (three taps). |
| `upecho` | Up Echo | An echo whose every repeat goes through a high-pass, so the repeats get thinner. |
| `downecho` | Down Echo | An echo whose every repeat goes through a low-pass, so the repeats get darker. |
| `lowcut` | Low Cut Echo | An echo whose first repeat is full range; a high-pass in the feedback loop thins the later ones. |
| `pingpong` | Ping Pong | A stereo delay that bounces left and right. |
| `reverb` | Reverb | A convolution reverb. |
| `flanger` | Flanger | A modulated short delay with feedback. |
| `phaser` | Phaser | Four modulated all-pass stages. |
| `pan` | Pan | An auto-pan, left and right in rhythm. |
| `trans` | Trans | A rhythmic gate. |
| `filter` | Filter | A band-pass sweep in rhythm. |
| `roll` | Roll | A slip roll, played by the deck; the unit itself outputs nothing. |
| `robot` | Robot | A ring modulator. |
| `helix` | Helix | An echo with a very long, almost endless tail. |
| `crush` | Crush | A bit crusher. |

The modulation of `trans` repeats every `beats`, `pan` and `filter` every
2 × `beats`, `phaser` every 4 × `beats` and `flanger` every 8 × `beats`.

**`COLOR_FX_TYPES`** (9), for `engine.setColorFx()`:

| id | label | What the FILTER knob does |
|---|---|---|
| `filter` | Filter | Low-pass to the left, high-pass to the right. |
| `dubecho` | Dub Echo | Sends to a dub echo (high-passed loop). |
| `hpfecho` | HPF Echo | Sends to an echo through a high-pass. |
| `lpfecho` | LPF Echo | Sends to an echo through a low-pass. |
| `bpfecho` | BPF Echo | Sends to an echo through a band-pass. |
| `crushecho` | Crush Echo | Sends to an echo with a bit crusher. |
| `reverb` | Space | Sends to a reverb. |
| `noise` | Noise | Adds white noise (`\|v\|² × 0.4`). |
| `crush` | Crush | Sends to a bit crusher. |

**`DEFAULT_PAD_FX`** (10, the OpenMix pad bank). Each entry carries its label in
a `label` field:

| label | preset |
|---|---|
| ROLL ½ | `{ type: 'roll', beats: 0.5, level: 0.9 }` |
| SWEEP | `{ type: 'filter', beats: 4, level: 0.9 }` |
| FLANGER | `{ type: 'flanger', beats: 2, level: 0.85 }` |
| TRANS | `{ type: 'trans', beats: 0.5, level: 1 }` |
| V.BRAKE | `{ spin: 'brake' }` |
| ECHO ¼ | `{ type: 'echo', beats: 0.25, level: 0.7 }` |
| ECHO ½ | `{ type: 'echo', beats: 0.5, level: 0.7 }` |
| MT DELAY | `{ type: 'mtdelay', beats: 0.5, level: 0.75 }` |
| REVERB | `{ type: 'reverb', beats: 1, level: 0.75 }` |
| BACKSPIN | `{ spin: 'backspin' }` |

Entries with `spin` are turntable effects for `deck.spinStart()`; the others
are `PadFxPreset`s for `deck.setPadFx()`.

**Types:**

| Type | Values |
|---|---|
| `FxType` | the 18 `FX_TYPES` ids |
| `ColorFxType` | the 9 `COLOR_FX_TYPES` ids |
| `CrossfaderSide` | `'A'`, `'B'`, `'thru'` |
| `EqBand` | `'low'`, `'mid'`, `'high'` |
| `StemName` | `'vocals'`, `'drums'`, `'bass'`, `'other'` |
| `SpinKind` | `'brake'`, `'backspin'` (`spinStart()` also accepts `'vbrake'`) |
| `PadFxPreset` | `{ type, beats, level?, dry?, label? }` |
| `AudioSource` | `string`, `URL`, `Blob`, `ArrayBuffer` or `AudioBuffer` |

## Browser support

The package relies on standard Web APIs, with a fallback for each optional
feature:

| Feature used | Needed for | If missing |
|---|---|---|
| Web Audio API (`AudioContext`, `OfflineAudioContext`) | everything | the engine cannot run |
| `AudioWorklet` (Chrome 66+, Firefox 76+, Safari 14.1+); **secure context only** (https, localhost/127.0.0.1) | WSOLA keylock and key shift | the fallback two-tap shifter: lower quality, no latency compensation (`pitchEngine === 'fallback'`) |
| `AudioContext.prototype.setSinkId` (Chromium 110+ at the time of writing) | `setOutputDevice`, `setHeadphoneDevice` | they resolve `false`; use `cueOutput` + `<audio>.setSinkId` where available, or the system default |
| `destination.maxChannelCount ≥ 4` (device, driver and browser dependent) | the automatic headphone cue on channels 3/4 | no automatic headphone output (`headphonesAvailable === false`) |
| `OfflineAudioContext.prototype.suspend` (Chromium) | `renderOffline` with ticks | it rejects with a clear error; use `tickRate: 0` (no sync lock during the render) |
| `OfflineAudioContext` at 8 kHz and 16 kHz sample rates | `analyzeBpm`, `analyzeKey`, `computePeaks` | the analysis rejects |
| `MediaStreamAudioDestinationNode` | `getRecordingStream`, the `setHeadphoneDevice` bridge | those features throw or resolve `false` |

**Tested by the project:** Chromium-based browsers, through the automated
headless suite. **Expected to work:** Firefox and Safari, through the standard
API and the fallbacks above. They are not covered by automated tests.

All browsers apply an autoplay policy: the context starts suspended, so call
`engine.resume()` from a user gesture.

## Limits

- **Memory:** whole tracks are decoded in memory as float32, about 21 MB per
  stereo minute at 44.1 kHz. Stems multiply that.
- **Analysis cost:** analysis runs mostly on the main thread. The BPM analysis
  of a long track can block for a second or more, so run it before playing or
  between interactions. Key detection yields to the event loop.
- **Ticks:** the sync lock and the FX alignment need `tick()` at 30–144 Hz.
  - Without ticks, decks keep their tempo, but the phase is not held.
  - In hidden tabs, auto-tick falls back to a timer that keeps one tick every
    20 ms on average, which browsers may throttle. So does a visible page that
    gets no animation frames for 100 ms.
- **BPM of short clips:** the constant-tempo (rigid) grid is only tried on
  tracks longer than 30 s. Shorter clips (5–30 s) get the beat-by-beat
  tracker, which is less exact: on a 30 s house loop at 126 BPM it found
  125.79 to 126.05 BPM, where 40 s and longer give 126.00 exactly.
- **Ranges:**
  - tempo 0.5–1.6 (−50 % … +60 %);
  - key shift ±7 semitones;
  - transposer ratio (key × keylock compensation) clamped to 0.5–1.8;
  - 1–8 decks, 0–8 FX units, 1–16 hot cues.
- **Keylock reaction time:** keylocked or key-shifted decks add a fixed 2647
  samples (about 55 ms at 48 kHz). Timing is compensated, but play-from-stop
  and seeks on such a deck are heard that much later.
- **Transients through the transposer:** WSOLA reads 32 ms grains faster or
  slower, so a sharp attack can move by up to ±(grain/2) × (1 − 1/ratio).
  Measured on clicks: keylock at −3 % tempo, 0.2 ms on average (0.4 ms at
  most); key +2 semitones, 1.1 ms on average (1.8 ms at most).
- **Headphones on a second device** through `setHeadphoneDevice`: the bridge
  latency between master and headphones is not compensated.
- **Grids:** sync quality depends on the beat grids. A track with no detectable
  beat (`bpm === null`) cannot sync.
- **Out of scope:** library management, MIDI/HID controllers, stem separation,
  VST hosting and a recording UI. The engine gives you the hooks: events,
  `loadStems()`, `setInsert()` and `getRecordingStream()`.

## Contributing and tests

Issues and pull requests are welcome on the
[OpenMix repository](https://github.com/blackmagic42/openmix/issues).

- [DESIGN.md](DESIGN.md) is the contract: the public API (§5) and the behavior
  that must not regress (§6). Discuss API changes there first.
- Keep the package dependency-free: no runtime or development dependencies, and
  no build step. Code style: ES2022 modules, 2-space indent, semicolons, single
  quotes, and JSDoc on public members.
- Every source file (JS, `.d.ts`, HTML, CSS) starts with this header (in an
  HTML comment for HTML, `/* */` for CSS):

  ```js
  // SPDX-License-Identifier: MIT
  // Copyright (c) 2026 blackmagic42 (OpenMix) and contributors
  // @openmix/web-engine — the Web Audio DJ engine of OpenMix
  // https://github.com/blackmagic42/openmix
  ```

- Library code never calls `console.log`: report diagnostics through the `log`
  option. Modules must import cleanly in Node, so read browser globals lazily
  through `globalThis`, inside functions.
- Keep the hard-won comments: the measurements, the "why" and the "do not
  reintroduce" warnings. Mark an intentional behavior change from the OpenMix
  app with a one-line `// web-engine: …` comment.
- No binary assets: the audio for the demo and the tests is synthesized at
  runtime.
- Tests are silent by construction. Node tests use a fake Web Audio, browser
  tests use `OfflineAudioContext` only (never `new AudioContext()`), and the
  headless browser runs muted.
- Before you send a change, run `npm test` and `npm run test:browser` (see
  [Demo and tests](#demo-and-tests)).

## License

[MIT](LICENSE). Copyright (c) 2026 blackmagic42 (OpenMix) and contributors.

## Trademarks

Rekordbox, CDJ, Pioneer DJ and AlphaTheta are trademarks of their respective
owners. OpenMix and this package are independent projects: they are not
affiliated with, approved by or endorsed by these companies. These names appear
only to describe compatibility or comparable behavior. Other product names
mentioned here (browsers, bundlers) belong to their respective owners.
