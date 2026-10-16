# @openmix/web-engine — design and API contract

Version 0.1.0 · Status: **frozen contract** for the three parallel teams *core*, *demo*
and *docs* · Owner: architect.

This file and `package.json` are **read-only** for the three teams. If something
here is wrong, ambiguous or missing, implement the closest faithful
interpretation and list the deviation in your final report (§12). Section numbers
are stable: refer to them in code reviews and reports.

---

## 1. Purpose

`@openmix/web-engine` is the Web Audio engine of OpenMix (free, open-source,
MIT, 4-deck DJ software) packaged as a standalone, documented, dependency-free
library, so that anyone can build a DJ or mixing app that runs in a web browser.
The OpenMix desktop app is getting a native C++ engine on another branch; this
package keeps the web engine alive and shareable. The OpenMix app will switch to
this package later; that switch is **not** part of this work.

Goals:

- Same sound and same behavior as the OpenMix engine: sync that holds, keylock
  with latency compensation, sample-accurate loops, beat-synced FX. The
  hard-won logic **and its comments** are preserved.
- A small, clear, documented public API with no app couplings.
- Works with any `AudioContext` or `OfflineAudioContext`, and any output node.
- Pure ES modules plus one AudioWorklet. Zero dependencies, no build step.
- Silent, automated tests.

Non-goals for v0.1.0: track library or database, MIDI/HID controllers, gamepads,
stem separation (callers supply stem buffers), VST hosting (a generic insert
hook only), sampler, recording UI, i18n, persistence, npm publication.

---

## 2. Ground rules (all teams)

1. Work only inside `packages/web-engine/` of the worktree
   `C:\Users\david\Documents\Turbo mix\openmix-webengine` (branch `web-engine`).
   The app files (`src/**`, `main.js`, `preload.js`, root `package.json`) are
   **read-only** sources. Never touch `...\Turbo mix\openmix` or
   `...\Turbo mix\openmix-engine`.
2. No git commit or push, no `npm publish`, no `npm install`, no network
   downloads. The package has **no dependencies at all**, not even dev
   dependencies.
3. Never start or stop the owner's OpenMix. Never bind or probe ports **8722**
   or **9333**. Never run the Electron binary from the openmix `node_modules`:
   its path matches the owner's kill-by-path rule.
4. The owner's PC is also his gaming PC, so no heavy tools. Any browser you
   launch must be:
   - headless and muted;
   - on a temporary profile;
   - killed through its own process handle, never by name;
   - running for at most a couple of minutes.
5. **Tests are silent by construction:**
   - Node tests have no audio device.
   - Browser tests use `OfflineAudioContext` only, never `new AudioContext()`.
   - The headless browser also runs with `--mute-audio`.
   - The demo is the only code that makes sound, and only after a user gesture.
     It honors `?silent=1`.
6. Everything is in English: code, comments, docs and UI text.
7. Put this license header on every source file (JS, `.d.ts`, HTML, CSS):

   ```js
   // SPDX-License-Identifier: MIT
   // Copyright (c) 2026 blackmagic42 (OpenMix) and contributors
   // @openmix/web-engine — the Web Audio DJ engine of OpenMix
   // https://github.com/blackmagic42/openmix
   ```

   In HTML, use the same four lines in one `<!-- -->` comment. In CSS, use
   `/* */`.
8. Code style:
   - ES2022 modules, 2-space indent, semicolons, single quotes.
   - JSDoc on public members.
   - No `console.log` in library code; use the `log` option.
   - **No top-level access to browser globals** (`window`, `document`,
     `AudioContext`, `OfflineAudioContext`, `AudioWorkletNode`,
     `requestAnimationFrame`, `devicePixelRatio`, `performance`). Read them
     lazily through `globalThis` inside functions, so that every module imports
     cleanly in Node.
9. No binary assets anywhere: no audio files, no images. Audio for the demo and
   the tests is synthesized at runtime.

---

## 3. Layout and file ownership

```
packages/web-engine/
├── package.json                 architect (frozen)
├── DESIGN.md                    architect (frozen)
├── README.md                    docs
├── CHANGELOG.md                 docs
├── LICENSE                      docs
├── docs/                        docs
│   └── migration-from-openmix.md
├── src/                         core
│   ├── index.js                 entry '.'  — re-exports the whole public API (§5.1)
│   ├── engine.js                Engine + createEngine(): master chain, mixer, outputs, FX matrix,
│   │                            color/pad/master FX, tick(), auto-tick, events, lifecycle
│   ├── deck.js                  Deck: transport + timing model, loops, cues, roll, scratch/spin,
│   │                            keylock routing, stems, insert, channel strip
│   ├── sync.js                  sync, reanchor, snap, continuous lock, master election, follow-master
│   ├── fx.js                    FxUnit, echo/impulse/crush builders, FX tables (§5.12)
│   ├── pitch-fallback.js        two-tap PitchShifter (used when AudioWorklet is unavailable)
│   ├── grid.js                  pure beat-grid helpers (§5.10)
│   ├── offline.js               renderOffline() (§5.11)
│   ├── emitter.js               tiny event emitter (§5.7)
│   ├── constants.js             VERSION, numeric constants, PITCH_PROCESSOR_NAME
│   ├── analysis/
│   │   ├── index.js             entry './analysis'
│   │   ├── bpm.js               analyzeBpm (ex detectBPM), alignImportedGrid
│   │   ├── key.js               analyzeKey (ex detectKey), keyFromMono, keyFromChroma, Camelot, heardKey
│   │   └── track.js             analyzeTrack()
│   └── waveform/
│       ├── index.js             entry './waveform'
│       ├── peaks.js             computePeaks (ex computeBandPeaks)
│       └── draw.js              drawZoom, drawOverview, fitCanvas, palettes
├── worklets/
│   └── pitch-processor.js       core — WSOLA AudioWorkletProcessor 'openmix-pitch-shift'
├── types/                       core
│   ├── index.d.ts               (re-exports analysis.d.ts and waveform.d.ts)
│   ├── analysis.d.ts
│   └── waveform.d.ts
├── test/
│   ├── unit/*.test.js           core — `npm test` (node:test, Node ≥ 22, silent)
│   ├── helpers/                 core — fake Web Audio for Node, fixtures
│   └── browser/                 demo — OfflineAudioContext suite (index.html + modules)
├── example/                     demo — index.html, demo.js (+ optional demo.css, synth.js, …)
└── scripts/                     demo
    ├── serve.js                 dependency-free static server (`npm run demo`)
    └── test-browser.js          headless runner for test/browser (`npm run test:browser`)
```

Ownership is exclusive: a team creates and edits only its own paths. The entry
points are fixed by `package.json`:

- `src/index.js`
- `src/analysis/index.js`
- `src/waveform/index.js`
- `worklets/pitch-processor.js`
- `types/index.d.ts`, `types/analysis.d.ts`, `types/waveform.d.ts`
- `scripts/serve.js`, `scripts/test-browser.js`
- `test/unit/*.test.js`

The internal split of `src/` above is a strong recommendation; core may merge or
split internal modules.

---

## 4. Source mapping and porting rules

| Package module | Ported from (read-only app sources) |
|---|---|
| `src/engine.js`, `src/sync.js` | `src/js/engine.js` — `AudioEngine` |
| `src/deck.js` | `src/js/engine.js` — `Deck` (+ app logic listed in §8) |
| `src/fx.js` | `engine.js` — `FxUnit`, `buildEchoLoop`, `makeImpulse`, `crushCurve`, `FX_DRY_CUT` (+ FX tables from `app.js`) |
| `src/pitch-fallback.js` | `engine.js` — `PitchShifter` |
| `src/grid.js` | `engine.js` grid helpers (+ `snapToBeat` from `app.js`) |
| `worklets/pitch-processor.js` | `src/js/pitch-worklet.js` |
| `src/analysis/bpm.js` | `src/js/bpm.js` |
| `src/analysis/key.js` | `src/js/key.js` |
| `src/waveform/*` | `src/js/waveform.js` |

Porting means **moving** the code and its comments, then applying only the
changes this contract requires:

- Keep every hard-won comment: the measurements, the "why", the "do not
  reintroduce" warnings.
- Replace personal references ("David's request") with neutral wording such as
  "by design" or "user feedback". Keep the technical content.
- Generalize hardware-specific comments ("the FLX6") to "a 4-channel DJ
  controller sound card" when they describe generic behavior.
- Mark every intentional behavior change with a one-line `// web-engine: …`
  comment.
- Keep all magic numbers. When a number moves, its explaining comment moves
  with it.

---

## 5. Public API (normative)

### 5.0 Canonical usage

The demo and the docs use these idioms.

```js
import { createEngine, drawZoom, drawOverview } from '../src/index.js';

const engine = await createEngine();            // 4 decks, keylock worklet loaded, auto-tick on
const [a, b] = engine.decks;

startButton.onclick = async () => {
  await engine.resume();                        // autoplay policy: needs a user gesture
  await a.loadFrom(fileInput.files[0]);         // decode + BPM/grid + key + peaks, then load
  await b.loadFrom('/music/two.mp3');
  a.play();                                     // first deck started = automatic master
  b.sync();                                     // tempo matched + bars aligned, then held by the lock
  b.play();                                     // a synced deck that starts is aligned again
  engine.setCrossfader(1);                      // decks 1/3 are side A, 2/4 side B
};

engine.on('tick', () => {                       // once per frame (auto-tick)
  drawZoom(zoomCanvas, a, { windowSeconds: 8 * a.baseTempo });
  drawOverview(overviewCanvas, a);
  meter.value = a.meterPeak();
});
```

```js
// Beat FX unit 0 on deck 1, 1/2-beat echo
engine.assignFx(0, 1, true);
engine.fx[0].setType('echo');
engine.fx[0].setBeats(0.5);
engine.fx[0].setEnabled(true);
engine.fx[0].setLevel(0.6);            // units start at level 0

// Keylock and key
b.setKeylock(true);
b.setTempo(1.04);                      // +4 % without changing the key
b.setKey(-2);                          // two semitones down, same speed

// Headphones: PFL on deck 2
b.setHeadphoneCue(true);
```

```js
// Offline (silent) rendering and testing
import { createEngine, renderOffline } from '../src/index.js';
const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: 48000 * 30, sampleRate: 48000 });
const engine = await createEngine({ context: ctx });   // auto-tick is off for offline contexts
engine.decks[0].load(bufferA, { bpm: 124, beats: beatsA });
engine.decks[0].play();
const rendered = await renderOffline(engine, {
  tickRate: 60,
  onTick: (t) => { if (t >= 10 && !engine.decks[1].playing) { engine.decks[1].sync(); engine.decks[1].play(); } }
});
```

### 5.1 Entry points and exact export lists

| Specifier | File | Contents |
|---|---|---|
| `@openmix/web-engine` | `src/index.js` | the whole API |
| `@openmix/web-engine/analysis` | `src/analysis/index.js` | analysis only: no engine, no DOM |
| `@openmix/web-engine/waveform` | `src/waveform/index.js` | peaks and canvas drawing |
| `@openmix/web-engine/worklets/pitch-processor.js` | `worklets/pitch-processor.js` | the worklet module, for bundlers and CDNs |

Without a bundler, import `src/index.js` by relative path or through an import
map. The engine finds its worklet with
`new URL('../worklets/pitch-processor.js', import.meta.url)`, a pattern that Vite,
webpack 5, Rollup, esbuild and Parcel understand. The `workletUrl` option
overrides it.

Named exports only, no default export. These lists are exact: nothing more and
nothing less.

- **`src/analysis/index.js`**:
  - `analyzeBpm`, `analyzeKey`, `analyzeTrack`, `alignImportedGrid`
  - `keyFromMono`, `keyFromChroma`
  - `camelot`, `camelotLabel`, `keyName`, `shiftKey`, `keyDistance`, `heardKey`
- **`src/waveform/index.js`**: `computePeaks`, `drawZoom`, `drawOverview`,
  `fitCanvas`, `WAVE_PALETTES`.
- **`src/index.js`** exports everything from the two lists above, plus:
  - classes and functions: `createEngine`, `Engine`, `Deck`, `FxUnit`,
    `renderOffline`
  - grid helpers: `gridIndexFracAt`, `gridTimeAtIndex`, `gridPeriodAt`,
    `barAlignedSeekTime`, `snapToBeat`
  - constants:
    - `VERSION`
    - `FX_TYPES`, `COLOR_FX_TYPES`, `FX_BEATS`, `FX_DRY_CUT`, `fxDryCut`,
      `PAD_FX_DRY`, `DEFAULT_PAD_FX`, `HOT_CUE_COLORS`
    - `TEMPO_MIN`, `TEMPO_MAX`, `KEY_SHIFT_MIN`, `KEY_SHIFT_MAX`, `PRE_ROLL`
    - `WSOLA_LATENCY_SAMPLES`, `PITCH_PROCESSOR_NAME`

`Deck` and `FxUnit` are exported for `instanceof` checks and types. Only the
engine creates them.

### 5.2 Conventions

- **Times** are in seconds:
  - Deck positions are file seconds of what is **heard** (§6.2).
  - Real-time durations are labeled as such; for example, `beatDuration` is in
    real seconds.
- **Ranges:**
  - Unipolar 0..1: volume, FX level, crossfader (0 = side A only).
  - Bipolar −1..1: EQ, trim, filter, master filter (0 = neutral).
  - Tempo ratio: 1 = original speed.
- **Indices** are 0-based: decks, FX units, hot-cue slots.
- **Invalid input:**
  - Numbers out of range are clamped.
  - `NaN` or a non-number makes the call a no-op.
  - Enum values outside the allowed set throw `RangeError`.
  - Out-of-range deck, FX-unit or hot-cue slot indices throw `RangeError`.
- **Impossible operations** (no track loaded, no grid, not playing) return
  `false`, `null` or nothing, as documented per method. They never throw.
- **Read-only properties** are marked `readonly`. Some are plain fields
  internally; writing them is unsupported.
- **Events** (§5.7):
  - Subscription methods: `on(type, listener)` returns an unsubscribe function;
    `once` and `off` are also available.
  - Each listener receives one `detail` object. Events are emitted
    synchronously, after the state has changed.
  - Listener exceptions are caught and passed to `options.onError` (default
    `console.error`). They never break the engine or the tick.
- **Aliases:** `deck.currentTime()` returns the same value as `deck.position`
  and is kept for OpenMix compatibility. `engine.ctx` is internal; use
  `engine.context`.

### 5.3 `createEngine(options?) → Promise<Engine>`

`new Engine(options)` builds the whole graph synchronously. `createEngine` is
`const e = new Engine(options); await e.ready; return e;`.

```ts
interface EngineOptions {
  /** AudioContext or OfflineAudioContext. Default: a new AudioContext(contextOptions).
   *  The engine closes a context it created (destroy()); it never closes an injected one.
   *  Throws Error('No AudioContext available; pass options.context') if none can be made. */
  context?: BaseAudioContext;
  /** Used only when `context` is omitted. Default { latencyHint: 'interactive' }. */
  contextOptions?: AudioContextOptions;
  /** Receives the master mix (stereo, post-limiter). Default: context.destination, with the
   *  automatic 4-channel headphone layout when available (§6.6). */
  output?: AudioNode;
  /** Receives the headphone (CUE) bus (stereo). Default: destination channels 3/4 when `output`
   *  is omitted and destination.maxChannelCount ≥ 4; otherwise unconnected. */
  cueOutput?: AudioNode;
  /** Number of decks, 1–8. Default 4. Crossfader sides default to A, B, A, B, … */
  decks?: number;
  /** Number of beat-FX units, 0–8. Default: same as `decks`. Unit u starts assigned to deck u
   *  (when that deck exists), disabled, at level 0. */
  fxUnits?: number;
  /** Hot-cue slots per deck, 1–16. Default 8. */
  hotCues?: number;
  /** Load the WSOLA keylock worklet. Default true. false = two-tap fallback shifter only. */
  keylock?: boolean;
  /** URL of worklets/pitch-processor.js. Default: new URL('../worklets/pitch-processor.js', import.meta.url). */
  workletUrl?: string | URL;
  /** Call tick() automatically. Default: true for a realtime context when requestAnimationFrame
   *  exists; false for an OfflineAudioContext. */
  autoTick?: boolean;
  /** Safety limiter on the master (§6.7). Default true. false = a unity gain node instead. */
  limiter?: boolean;
  /** Diagnostics (worklet fallback reason, output layout). Default: no-op. */
  log?: (message: string) => void;
  /** Receives exceptions thrown by event listeners and by auto-tick. Default: console.error. */
  onError?: (error: unknown) => void;
}
```

`ready` resolves once the worklet attempt has finished. It **never rejects**.

- Success sets `pitchEngine` to `'wsola'`.
- Any failure sets `pitchEngine` to `'fallback'` and records the cause in
  `pitchEngineError`. Failures include: no `audioWorklet` (insecure context, old
  browser), a module load error, or a node creation error.
- With `keylock: false`, `pitchEngine` is `'fallback'` and `pitchEngineError`
  is `null`.

Worklet loading details:

- The module is added **at most once per context**, through a module-level
  `WeakMap<BaseAudioContext, Promise>`.
- The worklet guards its own `registerProcessor` call, so a second evaluation
  cannot throw.
- Decks use the fallback shifter until the worklet is ready, as in OpenMix.

### 5.4 `Engine`

```ts
class Engine {
  constructor(options?: EngineOptions);

  // ---- state (read-only) ----
  readonly ready: Promise<void>;
  readonly context: BaseAudioContext;
  readonly isOffline: boolean;                 // context is an OfflineAudioContext
  readonly decks: readonly Deck[];
  readonly fx: readonly FxUnit[];              // beat-FX units
  readonly masterFx: FxUnit | null;            // null until ensureMasterFx()
  readonly fxAssign: readonly (readonly boolean[])[];  // fxAssign[unit][deck]
  readonly crossfader: number;                 // 0..1, default 0.5
  readonly masterVolume: number;               // 0..1, default 0.9
  readonly masterFilter: number;               // -1..1, default 0
  readonly headphoneVolume: number;            // 0..1, default 1
  readonly colorFx: ColorFxType;               // default 'filter'
  readonly colorFxEnabled: boolean;            // default true
  readonly masterIndex: number | null;         // effective master: manual if set, else automatic
  readonly manualMasterIndex: number | null;
  readonly masterDeck: Deck | null;            // decks[masterIndex]
  readonly masterBpm: number | null;           // masterDeck.effectiveBpm
  readonly syncHold: boolean;                  // phase lock suspended (nudge in progress / setSyncHold)
  readonly gridOffset: number;                 // seconds, default 0
  readonly pitchEngine: 'loading' | 'wsola' | 'fallback';
  readonly pitchEngineError: Error | null;
  readonly headphonesAvailable: boolean;       // the cue bus currently reaches an output
  readonly masterOut: AudioNode;               // final master node (post-limiter): connect extra taps here
  readonly cueOut: AudioNode;                  // the headphone bus node

  // ---- lifecycle ----
  resume(): Promise<void>;                     // resumes a realtime context (call in a user gesture); no-op offline
  tick(): void;                                // one control step, every frame (30–144 Hz), see below
  startAutoTick(): void;
  stopAutoTick(): void;
  destroy(): Promise<void>;

  // ---- loading ----
  decode(source: AudioSource): Promise<AudioBuffer>;

  // ---- mixer ----
  setCrossfader(x: number): void;
  setMasterVolume(v: number): void;            // also scales the FX returns, as in OpenMix
  setMasterFilter(v: number): void;            // <0 low-pass, >0 high-pass, dead zone |v| < 0.04
  setHeadphoneVolume(v: number): void;         // gain of the cue bus
  setColorFx(type: ColorFxType): void;         // mode of every channel FILTER knob; re-applies knobs
  setColorFxEnabled(on: boolean): void;        // off = FILTER knobs do nothing; re-applies knobs
  masterPeak(): number;                        // instantaneous peak of the mix, pre-limiter (0..~2)

  // ---- master and sync ----
  setMaster(index: number | null): void;       // SETS the manual master (null = automatic); not a toggle
  setMasterTempo(ratio: number): boolean;      // master deck tempo; synced followers follow in the same call
  setMasterBpm(bpm: number): boolean;          // same, as an effective BPM; false without a master BPM
  reanchorSync(index?: number): void;          // adopt the CURRENT alignment of synced decks (all if omitted)
  setSyncHold(on: boolean): void;              // suspend/resume phase correction globally

  // ---- FX ----
  assignFx(unit: number, deck: number, on?: boolean): void;   // on defaults to true; updates the sends
  isFxAssigned(unit: number, deck: number): boolean;
  ensureMasterFx(): FxUnit;                    // FX unit on the whole mix, created on first call

  // ---- outputs ----
  setOutputDevice(deviceId: string): Promise<boolean>;            // context.setSinkId + re-wire (§6.6)
  setHeadphoneDevice(deviceId: string | null): Promise<boolean>;  // cue bus on another device; null/'' = default routing
  getRecordingStream(): MediaStream;           // master as a MediaStream (lazy); throws TypeError offline

  // ---- grid ----
  setGridOffset(seconds: number): void;        // global offset added to every beat-list grid

  // ---- events ----
  on<K extends keyof EngineEventMap>(type: K, listener: (detail: EngineEventMap[K]) => void): () => void;
  once<K extends keyof EngineEventMap>(type: K, listener: (detail: EngineEventMap[K]) => void): () => void;
  off<K extends keyof EngineEventMap>(type: K, listener: (detail: EngineEventMap[K]) => void): void;
}

type AudioSource = string | URL | Blob | ArrayBuffer | AudioBuffer;
```

Semantics:

- **`tick()`** performs, in this order:
  1. The OpenMix per-frame work, ex-`syncLock()`:
     - FX beat alignment and ROLL driving (ex-`fxTick`);
     - per-deck dry compensation, then master dry compensation;
     - master election;
     - continuous phase lock, unless `syncHold`.
  2. FX units follow their reference deck's beat duration (moved from the app
     frame loop, §8). Each beat-FX unit follows the first assigned playing deck,
     otherwise the master. Pad-FX units follow their own deck, otherwise the
     master. The master FX follows the master. The fallback is 0.5 s.
  3. Emits `'master'` if the effective master changed.
  4. Emits `'tick'`.

  How auto-tick runs:
  - It calls `tick()` from `requestAnimationFrame` while the page is visible,
    and from a 20 ms timer while `document.visibilityState === 'hidden'`
    (requestAnimationFrame is paused in hidden tabs).
  - Each auto-tick is wrapped in `try/catch` that reports to `onError`. The
    loop never dies.
  - Calling `tick()` manually while auto-tick runs is allowed but pointless.
- **`decode(source)`**:
  - Fetches strings and URLs, and reads Blobs and Files.
  - Decodes with `context.decodeAudioData`. An ArrayBuffer is **detached** by
    decoding; pass a copy if you need to keep yours.
  - Returns AudioBuffers unchanged.
  - Rejects on network or decode errors.
- **`destroy()`** stops auto-tick, stops every deck and source, and disconnects
  from the outputs. It closes the headphone context and the engine's **own**
  context, never an injected one. Later calls on the engine are unsupported.
- **`setOutputDevice` / `setHeadphoneDevice`** resolve `false` (they do not
  throw) when `setSinkId` is unsupported, when the context is offline, or when
  the device fails.

### 5.5 `Deck`

```ts
class Deck {
  // ---- identity / track ----
  readonly index: number;
  readonly engine: Engine;
  readonly buffer: AudioBuffer | null;
  readonly track: unknown;                     // caller metadata, from load(…, { track })
  readonly peaks: Peaks | null;
  readonly loaded: boolean;
  readonly duration: number;                   // 0 when empty

  // ---- transport / timing ----
  readonly playing: boolean;
  readonly position: number;                   // HEARD position (file s); negative during pre-roll
  readonly displayPosition: number;            // = position, except during a spin FX (virtual position)
  readonly tempo: number;                      // instantaneous playback rate (includes sync micro-corrections)
  readonly baseTempo: number;                  // tempo without the sync servo correction (display this)
  readonly latency: number;                    // processing latency compensated by read-ahead (s)

  // ---- grid ----
  readonly bpm: number | null;                 // track BPM (from the grid)
  readonly effectiveBpm: number | null;        // bpm × baseTempo
  readonly beatDuration: number | null;        // real seconds per beat now (local grid period / baseTempo)
  readonly beats: readonly number[] | null;    // beat-list grid (file s), or null (fixed grid)
  readonly beatOffset: number | null;          // first beat of a fixed grid
  readonly barAnchor: number;                  // index of a beat that starts a bar
  readonly gridShift: number;                  // manual offset of a beat-list grid (s)
  readonly globalGridOffset: number;           // = engine.gridOffset

  // ---- sync / key ----
  readonly synced: boolean;
  readonly isMaster: boolean;                  // engine.masterIndex === index
  readonly keylock: boolean;
  readonly keyShift: number;                   // semitones, integer -7..+7
  readonly musicKey: number | null;            // detected key code 0..23 (§5.8)
  readonly heardKey: { code: number; cents: number } | null;

  // ---- cues / loops ----
  readonly cuePoint: number;
  readonly hotCues: readonly (number | null)[];  // length = options.hotCues
  readonly loop: LoopState;                    // fresh object per read
  quantize: boolean;                           // writable, default true (§ hot cues, loops)

  // ---- channel strip ----
  readonly volume: number;                     // 0..1, default 0.85
  readonly trimValue: number;                  // -1..1
  readonly eq: Readonly<{ low: number; mid: number; high: number }>;
  readonly kills: Readonly<{ low: boolean; mid: boolean; high: boolean }>;
  readonly filterValue: number;                // -1..1 (the FILTER knob)
  readonly headphoneCue: boolean;              // PFL
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
  currentTime(): number;                       // alias of position

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
  /** Default true: analyze what `meta` does not provide. false: analyze nothing. */
  analyze?: boolean | AnalyzeOptions;
  signal?: AbortSignal;
}
interface LoadResult extends TrackAnalysis { buffer: AudioBuffer; }   // the values applied to the deck
interface LoopState { active: boolean; start: number; end: number; beats: number | null; inPoint: number | null; }
type SyncResult = 'synced' | 'armed' | 'master' | null;
```

Semantics, in the order of the class:

**Loading**

- `load(buffer, meta)` keeps OpenMix `loadTrack` behavior:
  - stops playback and any roll;
  - resets position, cue point, loop, tempo (to 1), key shift (to 0), stems and
    the sync calibration;
  - applies `meta`; a `beats` array needs more than 2 entries to be used.
    When `beats` is given without `bpm`, the BPM is derived from the median
    beat interval. The same rule applies to `setGrid` and `loadFrom`.
  - **SYNC stays on across loads** and re-aligns from the first frame. Keylock
    stays as it was.
  - Emits `'load'`.
  - Throws `TypeError` when `buffer` is not an AudioBuffer-like object.
- `loadFrom(source, options)`:
  1. Calls `engine.resume()` synchronously, while the user gesture is still
     valid.
  2. Decodes the source (`engine.decode`).
  3. Analyzes what `options` does not provide:
     - the BPM/grid unless `bpm` or `beats` is given;
     - the key unless `musicKey` is given;
     - the peaks unless `peaks` is given.

     It uses `analyzeTrack` with the given `AnalyzeOptions`.
  4. Calls `load()`.

  A newer `loadFrom()` on the same deck, or an abort through `signal`, rejects
  the older call with an Error named `'AbortError'`, without touching the deck.
- `eject()` stops the deck and clears everything track-related (buffer, grid,
  peaks, track, stems, loop, hot cues). Emits `'eject'`.
- `setPeaks(peaks)` and `setMusicKey(code)` set the value without any other
  effect.

**Grid editing**

- `setGrid(grid)` replaces only the given fields.
  - A `bpm` without `beats` makes a fixed grid: `beats` becomes null, and
    `beatOffset` defaults to 0 when unknown. This is the OpenMix "BPM
    correction".
  - If the BPM or the beat list changed, the deck leaves SYNC (`'sync'` event)
    and its sync calibration is reset.
  - Emits `'grid'`.
- `scaleGrid(2 | 0.5)` is the OpenMix ×2/÷2 grid (app `gridScale`).
  - On a beat list: ×2 inserts midpoints and doubles `barAnchor`; ÷2 keeps
    every other beat with the parity of `barAnchor`.
  - The new BPM (`bpm × factor`) must be within 40–320.
  - Leaves SYNC and emits `'grid'`.
  - Returns `false` without a BPM or out of range.
- `shiftGrid(s)`: on a beat list, `gridShift += s`; on a fixed grid,
  `beatOffset = max(0, beatOffset + s)`. Emits `'grid'`.
- `setDownbeat(time = position)`: the beat nearest to `time` becomes a bar
  start placed exactly at `time` (app `recalGrid`).
  - Beat list: `gridShift` is adjusted and `barAnchor` is set to that beat.
  - Fixed grid: `beatOffset = time`.
  - Emits `'grid'`. Returns `false` without a buffer or BPM.

**Transport**

- `play()`:
  - The start is scheduled 30 ms ahead and is sample-accurate.
  - From the end of the track, it restarts at 0.
  - It calls `engine.resume()`.
  - **A synced deck that is not the master is aligned to the master right
    after it starts** (tempo + bars), like the app's `playDeck`.
  - Emits `'play'`.

  Internal restarts never re-align. These are cue preview, spin end and scrub
  end, all of which use an internal `_play()`.
- `pause()` stops any roll and keeps the heard position. It cuts the
  transposer's ~55 ms reserve so that it is not replayed on resume. Emits
  `'pause'`.
- `seek(t)`:
  - `t` is clamped to `[−PRE_ROLL, duration]`. Negative positions are silence
    before the track start (pre-roll).
  - Jumping outside the active loop disables the loop (`'loop'` event).
  - While playing, the restart is compensated for the 30 ms scheduling.

**Cue**

- `cue()` behaves like a CDJ:
  - while playing: back to the cue point, and pause;
  - while paused at the cue point (within 20 ms): re-seek to it;
  - while paused elsewhere: set the cue point here (`'cuepoint'` event).

  The cue point itself is never quantized, as in OpenMix.
- `cueDown()` / `cueUp()` give hold-to-preview, ported from the app's CUE
  button:
  - `cueDown()` while playing is the same as `cue()`.
  - `cueDown()` while paused away from the cue point sets the cue point.
  - `cueDown()` while paused at the cue point plays while held.
  - `cueUp()` after a preview goes back to the cue point and pauses.
- `setCuePoint(time = position)` emits `'cuepoint'`.

**Hot cues**

- `setHotCue(slot, time?)`:
  - Without `time`, it uses the current position, snapped to the nearest beat
    when `quantize` is on and a grid exists.
  - An explicit `time` is stored as is.
  - Emits `'hotcue'`. Returns `false` without a track.
- `clearHotCue(slot)` emits `'hotcue'` with `time: null`.
- `hotCue(slot)` is the pad press: it sets the slot (as above) if it is empty,
  otherwise it jumps there with `seek`, leaving the play state unchanged.

**Loops and jumps**

- `setLoop(start, end)` makes a sample-accurate native loop of at least 10 ms,
  clamped to the track. Emits `'loop'`.
- `beatLoop(beats)` needs a BPM.
  - With an active loop, it resizes the loop from its start; beat-list grids
    follow the real beats.
  - Otherwise, it starts a loop at the current position, snapped to the nearest
    ¼ beat when `quantize` is on. The length is `beats` on the grid.
  - Emits `'loop'`.
- `loopIn()` stores the IN point, snapped to the nearest beat when `quantize`
  is on. `loopOut()` needs an IN point and an OUT that is more than 50 ms after
  IN; it then activates the loop. Both emit `'loop'`.
- `loopHalve()` and `loopDouble()` apply only to an active loop.
  - Halving needs the half length to be at least ⅛ beat, or 50 ms without a
    BPM.
  - Doubling needs the new end to stay inside the track.
- `reloop()` re-activates the last loop without jumping. The playhead wraps if
  it is past the end. This is the OpenMix MIDI reloop.
- `exitLoop()` disables the loop.
- `beatJump(beats)` jumps ±`beats` on the grid; beat lists follow the real
  beats, and fixed grids use `60/bpm`. With an active loop, the loop moves by
  the same amount, clamped to the track (app `doBeatJump`). Returns `false`
  without a BPM.
- `loop.beats` is the loop length measured on the grid, rounded to 1/32 beat.
  It is `null` without a grid.

**Tempo and sync**

- `setTempo(ratio)` clamps to [`TEMPO_MIN`, `TEMPO_MAX`] = [0.5, 1.6].
  - A synced **follower** leaves SYNC first, like moving its tempo fader.
  - On the master, synced followers follow in the same call; the master's sync
    base is updated when it has one.
  - The sync servo uses an internal `_setRate()`, which never unsyncs.
- `setBpm(bpm)` is `setTempo(bpm / deck.bpm)`. Returns `false` without a BPM.
- `sync()` returns one of the following:

  | Result | When | Effect |
  |---|---|---|
  | `'master'` | the deck is the effective master | SYNC is armed without touching its tempo |
  | `'synced'` | another deck is a usable reference | aligned to the master now (§6.3) |
  | `'armed'` | no reference plays yet | the lock aligns the deck as soon as one plays |
  | `null` | the deck has no BPM | nothing |

  Emits `'sync'` when the flag changes.
- `unsync()` emits `'sync'`.
- `nudge(amount)` is a pitch bend, ported from the app's jog bend.
  - `amount` is clamped to ±0.5; ±0.06 is a typical full deflection.
  - On the first call, the base tempo is captured: the sync base when synced,
    otherwise the tempo. The deck is added to the engine's hold set
    (`syncHold`).
  - The rate becomes `base × (1 + amount)`. The `synced` flag is not touched.
  - Returns `false` when the deck is not playing; seek instead.
- `endNudge()` restores the base tempo and removes the deck from the hold set.
  When no deck holds any more, `engine.reanchorSync()` adopts the new alignment
  on every deck.
- `snapToReference(maxBeats = 0.06)` acts only when another deck with a grid is
  playing; the manual master is preferred. If this deck's beat phase is within
  `maxBeats` of it, the deck seeks to the exact alignment and returns `true`.
  This is the "discreet magnet" (ex `snapToRef`).

**Key**

- `setKeylock(on)` keeps the key when the tempo changes.
- `setKey(semitones)` rounds to an integer and clamps to ±7.
- Both route the deck through the transposer when `keylock || keyShift ≠ 0`
  (§6.4).

**Channel strip**

- Value mappings are in §6.7.
- `setKill(band, on)` remembers the band's value, sets it to −1 (−40 dB) and
  restores it on release. This generalizes OpenMix's bass kill to all bands.
- `setFilter(v)` is the channel FILTER knob. It follows the engine's color-FX
  mode (ex `engine.setDeckColor`).
- `setHeadphoneCue(on)` sends the deck to the cue bus pre-fader (PFL).

**Performance**

- `startRoll(beats, mix = 1)` is a slip roll, ported from OpenMix.
  - It loops the current grid slice of `beats` beats; slices are aligned to
    multiples of `beats` from `barAnchor`.
  - The track keeps running silently underneath.
  - `stopRoll()` resumes exactly where the track would be.
  - `setRollMix(m)` sets 0 for the track only and 1 for the loop only.
  - `startRoll` needs a playing deck with a grid. Returns `false` otherwise.
- `setPadFx(preset)` plays a momentary FX on this deck, through an independent
  unit created on demand.
  - `{ type: 'roll', beats }` is a slip roll.
  - Any other type uses the pad-FX unit (type, beats, level). While it is held,
    the deck's dry is reduced to `preset.dry ?? PAD_FX_DRY[type] ?? 1`.
  - `null` turns it off.
- `spinStart('brake' | 'backspin')` and `spinEnd()` play a turntable brake or
  backspin sound effect (`'vbrake'` is accepted as an alias of `'brake'`).
  - During the effect, the deck is paused and the track virtually keeps
    running: `displayPosition` shows that virtual position.
  - `spinEnd()` resumes exactly where the track would be if it was playing.
    Otherwise it returns to the starting point.
  - The clock is the audio clock.
- `scrubStart({ audible = true })`, `scrubMove(t)` and
  `scrubEnd({ resume = true, snap = true })` implement a scratch on the
  waveform.
  - `scrubStart` pauses the deck and remembers whether it was playing.
  - `scrubMove` plays audible grains at the gesture speed, on the zero-latency
    path. With `audible: false`, it seeks silently.
  - `scrubEnd` resumes if the deck was playing, then calls `snapToReference()`
    (when `snap` is on), then `engine.reanchorSync()` (always).

**Stems and insert**

- `loadStems({ vocals, drums, bass, other })` takes buffers on the track's
  timeline. They play instead of the mix; bass + other is the instrumental.
  - `setStem` and `toggleStem` (which returns the new state) mute or unmute one
    stem.
  - `clearStems()` goes back to the full mix, restarting seamlessly when
    playing.
- `setInsert(node, latency = 0)` places a generic insert between the filter and
  the fader, cue and meter taps.
  - Its fixed latency (in seconds) is compensated by read-ahead. While playing,
    this causes one brief restart.
  - Use it for any `AudioNode` or `AudioWorkletNode` effect, such as WASM DSP or
    a VST bridge.
- `meterPeak()` returns the instantaneous peak (0..~2), post EQ, filter and
  insert, and pre-fader.

### 5.6 `FxUnit`

```ts
class FxUnit {                                 // created by the engine only
  readonly type: FxType;                       // default 'echo'
  readonly enabled: boolean;                   // default false
  readonly level: number;                      // 0..1, default 0 (units always start at the minimum)
  readonly beats: number;                      // beat multiple, default 0.5 (typical values: FX_BEATS)
  readonly beatDuration: number;               // seconds per beat currently followed, default 0.5
  setType(type: FxType): void;                 // RangeError on unknown types
  setEnabled(on: boolean): void;               // the engine updates the deck sends automatically
  setLevel(v: number): void;                   // also drives feedback/depth inside the effect
  setBeats(beats: number): void;               // > 0
  setBeatDuration(seconds: number): void;      // manual; tick() overrides it while a reference deck plays
}
```

### 5.7 Events

Every deck event detail includes `deck` and `index`. Every engine event detail
includes `engine`.

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
  statechange: { engine: Engine; state: AudioContextState };   // proxies context 'statechange'
}
```

Emission points:

- **`play` / `pause`** fire on every flip of `playing`, including internal ones
  (cue, spin, scrub).
- **`master`** fires when the effective master index changes: from `tick()`,
  and synchronously from `setMaster()`. Nothing fires at creation.
- **`hotcue`, `loop` and `grid`** let apps persist user edits; they replace the
  OpenMix library calls.
- **Positions, tempos and meters** have no events. Poll them in your frame
  loop, or on `'tick'`.

### 5.8 Analysis (`@openmix/web-engine/analysis`)

```ts
interface AnalyzeBpmOptions { minBpm?: number; maxBpm?: number; }   // default 85..170
interface BpmResult {
  bpm: number;                 // 3 decimals; integer-locked on rigid grids (e.g. 128.00)
  beatOffset: number;          // first beat (s)
  beats: number[] | null;      // every beat (s); null when ≤ 8 beats
  barAnchor: number;           // index of a downbeat starting a phrase
  rigid: boolean;              // constant-tempo (DAW) grid detected
  deviationMs: number;         // median phase deviation per chunk (ms); ex `q`; large = variable tempo
}
function analyzeBpm(buffer: AudioBuffer, options?: AnalyzeBpmOptions): Promise<BpmResult | null>; // null: < 5 s, no beat

interface KeyResult { code: number; name: string; camelot: string; confidence: number; score: number; tuning: number; }
function analyzeKey(buffer: AudioBuffer): Promise<KeyResult | null>;    // ex detectKey + name/camelot
function keyFromMono(samples: Float32Array, sampleRate?: number, yieldEvery?: number):
  Promise<{ code: number; confidence: number; score: number; tuning: number } | null>;  // sampleRate must be 8000
function keyFromChroma(chroma: ArrayLike<number>): { code: number; confidence: number; score: number };

function camelot(code: number | null): { num: number; letter: 'A' | 'B' } | null;  // C major = 8B, A minor = 8A
function camelotLabel(code: number | null): string;                    // '8A', '' for null
function keyName(code: number | null): string;                         // 'C', 'F#', 'Am', '' for null
function shiftKey(code: number, semitones: number): number;
function keyDistance(a: number, b: number): 0 | 1 | 2 | 3 | null;      // 0 same, 1 neighbor/relative, 2 energy, 3 clash
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
function analyzeTrack(buffer: AudioBuffer, options?: AnalyzeOptions): Promise<TrackAnalysis>;  // runs the three
```

- **Key codes:** 0–11 are the major keys C…B; 12–23 are the minor keys Cm…Bm.
  The note names are:

  | | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 |
  |---|---|---|---|---|---|---|---|---|---|---|---|---|
  | major | C | Db | D | Eb | E | F | F# | G | Ab | A | Bb | B |
  | minor | Cm | C#m | Dm | Ebm | Em | Fm | F#m | Gm | G#m | Am | Bbm | Bm |
- **`alignImportedGrid`** re-aligns a grid imported from other software onto
  this decoder's timeline. It measures the median offset to the real
  transients, which is typically ~51 ms for LAME MP3s.
- **`analyzeTrack`** never rejects for an analysis failure. A part that fails
  is returned as `null`.
- **Algorithm summaries** for the docs are in §6.2 and §6.8.

### 5.9 Waveform (`@openmix/web-engine/waveform`)

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
function fitCanvas(canvas: HTMLCanvasElement): boolean;   // backing store = CSS size × devicePixelRatio; true if resized
```

- **Rendering** is identical to OpenMix: same colors, grid lines, loop band with
  IN/OUT flags, CUE marker, lettered hot-cue flags and dimming.
- **`drawZoom`**:
  - It draws a scrolling window centered on the position, 8 s wide by default.
  - Rendering is cached in a pre-rendered strip three windows wide; the cost is
    one GPU copy per frame, plus one third of the strip repainted per frame
    after a jump.
  - **The playhead line is not drawn**; draw it at the horizontal center.
  - To give two decks at the same effective BPM equal beat widths, pass
    `windowSeconds: base × deck.baseTempo`.
- **`drawOverview`** caches the whole-track rendering, and draws the played part
  at full intensity plus a white playhead.
- **`time`** overrides the drawn position.
- **Canvas caches** live in a module `WeakMap` keyed by canvas, not in expando
  properties.
- **Hidden canvases:** a zero-size or hidden canvas draws nothing and never
  throws.
- **Offscreen buffers** use `OffscreenCanvas` when available, otherwise
  `document.createElement('canvas')`.

### 5.10 Grid helpers

```ts
interface GridLike {
  bpm?: number | null; beats?: readonly number[] | null; beatOffset?: number | null;
  barAnchor?: number; gridShift?: number; globalGridOffset?: number;
}
function gridIndexFracAt(grid: GridLike, time: number): number | null;   // fractional beat index (beat list)
function gridTimeAtIndex(grid: GridLike, index: number): number | null;  // inverse; extrapolates at both ends
function gridPeriodAt(grid: GridLike, time: number): number | null;      // local beat period (s)
function barAlignedSeekTime(grid: GridLike, fromTime: number, toTime: number): number;  // same phase in the target bar
function snapToBeat(grid: GridLike, time: number, division?: number): number;           // nearest 1/division beat, ≥ 0
```

- The first three helpers return `null` unless the grid has a beat list of at
  least 2 beats.
- **Shift:** beat-list helpers use `time − (gridShift + globalGridOffset)`.
  Fixed-grid code paths use `bpm` + `beatOffset` and ignore the shifts, exactly
  as in OpenMix.
- **`snapToBeat`** handles both grid kinds. It returns `time` unchanged without
  a grid. `division` defaults to 1 (a whole beat); 4 means quarter beats.

### 5.11 Offline rendering

```ts
interface RenderOfflineOptions { tickRate?: number; onTick?: (time: number) => void | Promise<void>; }
function renderOffline(engine: Engine, options?: RenderOfflineOptions): Promise<AudioBuffer>;
```

- **Context:** throws `TypeError` unless `engine.context` is an
  `OfflineAudioContext` that has not rendered yet.
- **Ticks:** `tickRate` defaults to 60. With `tickRate > 0`, it needs
  `OfflineAudioContext.prototype.suspend`; when that is missing, it rejects with
  a clear `Error` that suggests `tickRate: 0`.
- **Tick times** are `k / tickRate`, rounded **up** to render-quantum (128-frame)
  boundaries. They are deduplicated, strictly increasing, and below the
  render's end.
- **At each tick:** `engine.tick()`, then `await onTick?.(time)`, then
  `context.resume()`.
- **Scheduling** is lazy: the next suspend is scheduled from inside the
  handler, so long renders don't queue thousands of suspends.
- **Result:** the promise resolves with the result of `startRendering()`.

### 5.12 Constants and shared types

```ts
const VERSION: string;                       // '0.1.0' — must equal package.json "version"
const TEMPO_MIN = 0.5, TEMPO_MAX = 1.6;
const KEY_SHIFT_MIN = -7, KEY_SHIFT_MAX = 7;
const PRE_ROLL = 3600;                       // seconds of allowed negative position
const WSOLA_LATENCY_SAMPLES = 2647;          // MUST equal LAT in worklets/pitch-processor.js
const PITCH_PROCESSOR_NAME = 'openmix-pitch-shift';
const HOT_CUE_COLORS: readonly string[];     // ['#ff3b30','#ff9500','#ffcc00','#34c759','#5ac8fa','#3b82f7','#af52de','#ff2d55'], cycled
const FX_BEATS: readonly number[];           // [0.25, 0.5, 0.75, 1, 2, 4, 8, 16, 32]
const FX_TYPES: readonly { id: FxType; label: string }[];          // order below
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

The FX tables reproduce the app's option lists exactly. The ids are the API; the
labels are suggestions for UIs.

**`FX_TYPES`** (18):

| id | label |
|---|---|
| `delay` | Delay |
| `echo` | Echo |
| `spiral` | Spiral |
| `mtdelay` | MT Delay |
| `upecho` | Up Echo |
| `downecho` | Down Echo |
| `lowcut` | Low Cut Echo |
| `pingpong` | Ping Pong |
| `reverb` | Reverb |
| `flanger` | Flanger |
| `phaser` | Phaser |
| `pan` | Pan |
| `trans` | Trans |
| `filter` | Filter |
| `roll` | Roll |
| `robot` | Robot |
| `helix` | Helix |
| `crush` | Crush |

**`COLOR_FX_TYPES`** (9):

| id | label |
|---|---|
| `filter` | Filter |
| `dubecho` | Dub Echo |
| `hpfecho` | HPF Echo |
| `lpfecho` | LPF Echo |
| `bpfecho` | BPF Echo |
| `crushecho` | Crush Echo |
| `reverb` | Space |
| `noise` | Noise |
| `crush` | Crush |

**`DEFAULT_PAD_FX`** (10, the OpenMix pad bank):

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

Each entry carries its label in a `label` field.

---

## 6. Behavior contract

Core must preserve this behavior; docs must explain it.

### 6.1 Signal flow

```
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

### 6.2 Decks, timing model and beat grids

- **Heard position.** `position` is the file time of what is heard.
  - Starts and restarts are scheduled 30 ms ahead, with sample-accurate
    bookkeeping.
  - A seek while playing targets `t + 0.03 × tempo`, so jumps land on time.
  - During the 30 ms window before a scheduled start, the position is the exact
    extrapolation; it is never floored to the future position.
- **Pre-roll.** Positions down to −3600 s are allowed. The deck is silent until
  0, then the track starts. When the tempo changes during pre-roll, the start is
  rescheduled.
- **Loops** use the native `AudioBufferSourceNode` loop, which is
  sample-accurate. `position` wraps inside the loop.
- **Tempo** is the `playbackRate` of every source of the deck (track, stems,
  roll). Keylock compensation follows the tempo live.
- **End of track** emits `'ended'`, leaves `playing` false and puts the position
  at the end. Pressing play again restarts at 0.
- **Beat grids** come in two kinds:
  - A **beat list** (`beats`, from `analyzeBpm`): every beat at its real
    position. All helpers interpolate between real beats and extrapolate with
    the edge periods. `barAnchor` marks a downbeat; red bar lines fall every 4
    beats from it, and reinforced phrase lines every 16.
  - A **fixed grid** (`bpm` + `beatOffset`, no beat list): used for manual BPM
    entry.
- **Grid offsets.** `gridShift` (per deck) and `engine.gridOffset` (global)
  shift beat-list grids. The global offset suits the grid to a listener's ear
  or screen latency.
- **BPM analysis** (`analyzeBpm`), summarized for the docs:
  1. Bass onset strength is computed at 8 kHz. Autocorrelation gives the
     tempo, and the median inter-onset interval chooses the octave.
  2. A dual-score sweep of the whole range follows: bass-power phase peak plus
     wideband transients, with ternary and octave candidates and a lock on
     integer or half-integer BPMs.
  3. If per-chunk phase deviations are small, a **rigid grid** is produced:
     constant tempo, anchored on the kick attack. 61 of 61 Rekordbox grids
     measured on real tracks were rigid.
  4. Otherwise, beat-by-beat **dynamic tracking** is used, with sections
     re-anchored after breaks.
  5. Final steps: re-alignment on wideband transients (the low-pass group
     delay), an octave safeguard, then downbeat and phrase detection.

  The default range is 85–170 BPM, and the octave ceiling is
  `max(maxBpm × 1.06, 180)`.

### 6.3 Sync, master election and phase lock

All of this is preserved from OpenMix.

- **Master election:**
  - A **manual master** (`setMaster`) always wins.
  - Otherwise, the **automatic master** is the first deck started. It stays
    master as long as it plays.
  - A stop shorter than 1.2 s (audio clock) keeps the crown: this is cut
    tolerance.
  - A natural end of the track hands over immediately.
  - The new master is the playing deck with **open bass** (EQ low > −0.9) that
    is the most audible (volume × crossfader side gain). The score is
    `(bass > 0 ? 10 + bass : 0) + heard`.
  - A manual master that stops hands over after 1.2 s, or immediately at a
    natural end.
  - When looking for a reference, a non-synced playing deck is preferred, so
    that two followers never chase each other.
- **SYNC:**
  - The tempo ratio comes from **local beat periods** (the average of the 16
    beats around the position), with the master's servo correction removed.
    It is octave-folded into [0.5, 1.6]; a synced deck never doubles the
    master's BPM.
  - Then the **bars** are aligned: downbeat lines fall together, computed as a
    beat index on beat lists.
- **Calibration** corrects the ratio once instead of servoing it forever:
  - Stage 1 measures the phase-drift slope for 1 s and corrects up to ±1 %.
  - Stage 2 measures for 8 s and corrects up to ±0.1 %.
  - It stops after at most 4 passes, or when a correction falls below 0.02 %.
    The absolute cap is ±2 %.
  - When both decks have beat lists, it starts directly at stage 2.
  - A measurement disturbed by a jump, seek or loop is discarded. Calibration
    gives up after 12 invalid attempts.
- **Continuous lock** (in `tick()`):
  - The phase error is smoothed (EMA 0.85/0.15). The dead zone is 0.0015 beat
    (< 0.6 ms).
  - The correction is proportional and capped at **±0.2 %** (gain 0.08),
    which is inaudible.
  - Decks routed through the transposer get **±1.5 %** (gain 1.0), because
    their pitch does not follow the tempo.
  - The base ratio is frozen: no absorption. The comment "DO NOT REINTRODUCE
    absorption" stays.
- **Deliberate offsets:**
  - An error larger than 0.08 beat is **adopted** as the new target, not chased.
  - Manual moves (nudge end, scrub end, `reanchorSync`) adopt the present
    alignment. A residue below 0.03 beat counts as "aligned" and is pulled to
    exact alignment: the visual magnet.
  - The master is never re-aligned.
- **Master tempo changes** scale the followers in the same call: there is no
  one-frame lag.
- **Master handover** happens without a jump. A follower keeps its current speed
  if it is within 0.4 % of the new target; otherwise it re-targets. Offsets are
  re-anchored on the present alignment.
- **Self-repair.** If a synced deck's base drifts more than 6 % from its target,
  it is re-aimed and recalibrated.
- **Stopped followers.** A synced deck that is stopped already takes the
  master's BPM, and its phase locks on PLAY.
- **Ticks.** The lock and the FX alignment run only in `tick()`. Call it at
  30–144 Hz, or let auto-tick do it.

### 6.4 Keylock and key shift: latency compensation

- **The WSOLA worklet** (`'openmix-pitch-shift'`):
  - Hann grains of N = 1536 samples (32 ms at 48 kHz), with **50 % overlap**:
    each output sample mixes exactly two aligned grains.
  - A correlation search over ±480 samples, coarse (step 4) then fine.
  - A small offset penalty (0.1, `processorOptions.pen`) keeps kick attacks
    sharp.
  - The ratio range is 0.5–1.8.
  - **The latency is fixed and known**: LAT = 2647 samples, ≈ 55.1 ms at
    48 kHz and 60.0 ms at 44.1 kHz. At ratio 1, the worklet is an exact delay.
    It posts `{ lat }` on startup.
  - It does no allocation in `process()`.
- **Routing decision** is stable: a deck uses the transposer when
  `keylock || keyShift ≠ 0`. The decision never depends on the ratio, so the
  sound does not enter and leave the transposer while sync makes the tempo
  hover around 1.
- **Ratio** = `2^(keyShift/12) × (keylock ? 1/tempo : 1)`, clamped to
  [0.5, 1.8]. It follows the sync micro-corrections live.
- **Compensation:** while routed, `latency` = LAT / sampleRate (+ any insert
  latency).
  - The deck **reads its track that much ahead**, so what is heard lands
    exactly on the grid: sync, waveforms and cues stay correct.
  - PLAY from stop does not skip the attack: the sound comes out `latency`
    later, and the clock accounts for it.
- **Path switches** are glitch-free:
  - Two permanent paths (direct and transposed) are crossfaded with 6 ms gain
    ramps; nodes are never reconnected.
  - On entry, the old sound continues on the direct path until the transposer
    delivers.
  - On exit, the direct path resumes exactly at the current position.
  - Pause cuts the transposer's reserve.
- **Fallback:** without AudioWorklet, the deck uses the two-tap delay shifter.
  It has lower quality and no read-ahead.
- **Scratch and spin** bypass the transposer, so they have zero latency.

### 6.5 FX

- **Beat FX units** are send effects tapping the post-crossfader signal (`xf`)
  of their assigned decks. The wet signal returns through `fxReturn`, so it
  follows the master volume.
- **Level** (0..1) sets the wet gain and also drives the effect itself: echo
  feedback `min(0.97, base × (0.55 + 0.45 × level))`, filter-sweep depth and
  flanger feedback.
- **Dry compensation per deck:**
  - `dry = 1 − max(fxDryCut(type) × level)` over the enabled units assigned to
    that deck.
  - "Insert-like" effects (gate, filter, crush, robot, pan) replace the sound at
    full level; echoes and reverbs add to it.
  - A held pad FX can lower the dry further (`PAD_FX_DRY`).
  - The master FX doses the dry of the whole mix (`dryComp`).
- **Tempo sync:**
  - Delay times are `beatDuration × beats`, clamped to 0.02–3.9 s.
  - They are updated only when the beat duration changes by more than 0.05 %.
  - Delay chains are built **on first use** to save memory, and are born
    already in time.
  - Modulations (trans gate, flanger, phaser, pan, filter sweep) restart
    **exactly on a beat or bar boundary** (`alignTo`). They re-align after a
    type or beats change, a reference-deck change, or a beat-duration drift
    above 0.4 %.
- **ROLL** (unit type `'roll'`) is played by the deck: a slip loop with the mix
  equal to the unit level. The unit itself outputs nothing.
- **Pad FX:** one momentary unit per deck, created on demand. It never touches
  the panel units.
- **Master FX:** one unit on the whole mix, created on demand.
- **Color FX** sets the mode of every channel FILTER knob:
  - `'filter'`: a biquad low-pass (knob left) or high-pass (knob right).
  - `'noise'`: white noise at `|v|² × 0.4` into the fader.
  - Other modes: a send of `post`, scaled by `|v|`, into one shared chain (echo
    variants, reverb "Space", crush) that returns through `colorWet` (0.85).
  - When disabled, the knobs do nothing.
- **Shared resources:** reverb impulses are memoized, and AudioBuffers are
  shared between contexts of the same sample rate.

### 6.6 Outputs, headphone cue, recording

The wiring is re-applied after every output change. The first matching rule
wins:

| # | Situation | Master goes to | Cue bus goes to | `headphonesAvailable` |
|---|---|---|---|---|
| 1 | `setHeadphoneDevice(id)` active | `output`, or destination as stereo | the second AudioContext on device `id`, through a MediaStream bridge; a ≥ 4-channel headphone device gets it on channels 3/4 | true |
| 2 | `cueOutput` given | `output`, or destination as stereo | `cueOutput` | true |
| 3 | `output` given (no `cueOutput`) | `output` | nowhere | false |
| 4 | destination has ≥ 4 channels | destination channels 1/2 (`channelInterpretation: 'discrete'`) | destination channels 3/4 — e.g. a 4-channel DJ controller sound card whose headphone jack reads 3/4 | true |
| 5 | otherwise | destination as stereo | nowhere | false |

The recording stream, once created, stays connected to the limiter.

Implementation note: `OfflineAudioContext` destinations reject
`channelCount` changes, so wrap destination channel settings in `try/catch`.
A 4-channel offline context must still produce rule 4; the browser tests rely
on it (§10.2).

Headphone notes:

- **PFL** (`setHeadphoneCue`) taps `post`: pre-fader, but post EQ, filter and
  insert.
- **The MediaStream bridge** in rule 1 adds latency between master and
  headphones. That latency is not compensated.
- **Alternative second output:** `cueOutput` set to a
  `MediaStreamAudioDestinationNode` whose stream plays in an `<audio>` element
  with `setSinkId()`.

### 6.7 Mixer curves and defaults

| Control | Mapping and default |
|---|---|
| Channel fader | gain = v², default v = 0.85 |
| Trim | gain = 4^v (−12…+12 dB) |
| EQ | v < 0 → v × 40 dB (−1 = −40 dB kill); v ≥ 0 → v × 6 dB |
| FILTER and master filter | \|v\| < 0.04 = neutral (peaking 0 dB); v > 0 = high-pass 20 × 400^v Hz (20 Hz → 8 kHz); v < 0 = low-pass 20000 × (80/20000)^(−v) Hz (20 kHz → 80 Hz); Q 0.9 |
| Crossfader ("mix" curve, both sides full at the center) | gA = x ≤ 0.5 ? 1 : 2(1−x); gB = x ≥ 0.5 ? 1 : 2x; `'thru'` decks = 1 |
| Master volume | default 0.9; also scales the FX returns |
| Limiter | DynamicsCompressor: threshold −3 dB, knee 0, ratio 12, attack 2 ms, release 150 ms |
| Meters | AnalyserNode `fftSize` 512, peak of every other sample |

Parameter changes use short `setTargetAtTime` ramps, exactly as in the source.

### 6.8 Key detection (summary for the docs)

1. Up to 15 minutes of audio is resampled to 8 kHz mono (natively, off the main
   thread).
2. An FFT of 8192 points with a hop of 4096 runs over at most 1400 frames.
3. A chroma is built from C2 to B6 with 3 sub-bins per semitone, which detects
   a tuning offset of up to ±⅓ semitone.
4. Every frame is normalized, and silence and fades are discarded.
5. The chroma is correlated with the KeyFinder (Sha'ath) major and minor
   profiles, with a minor bias of +0.1.
6. The computation yields to the event loop every 12 frames.

---

## 7. App couplings removed (and how)

| # | Coupling in the app sources | Removal |
|---|---|---|
| 1 | `console.log('[midi] …')` in `_loadPitchWorklet`, `_wireOutput`, `setPhonesDevice` | removed; optional `log(message)` option; state exposed as `pitchEngine`, `pitchEngineError`, `headphonesAvailable` |
| 2 | `performance.now()` for end-of-track and master grace periods | **audio clock** (`context.currentTime`): deterministic offline, and freezes with a suspended context |
| 3 | module globals `GLOBAL_GRID_OFFSET` (engine.js) and `PALETTE` (waveform.js) | per-engine `gridOffset` (exposed to grid helpers via `deck.globalGridOffset`); per-call `palette` option |
| 4 | hard-coded 4 decks, 4 FX units, `xfSides`, `padFx[4]`, `fxRefDeck` loop `d < 4` | sized from `decks`, `fxUnits`, `hotCues` options |
| 5 | `new AudioContext()` in the constructor, hard-wired `ctx.destination` | `context`, `contextOptions`, `output`, `cueOutput` options; injected contexts are never closed |
| 6 | eager `createMediaStreamDestination()` (`recDest`) | lazy `getRecordingStream()`; not available offline |
| 7 | worklet `./pitch-worklet.js`, processor `'pitch-shift'` | `worklets/pitch-processor.js`, `'openmix-pitch-shift'`, `workletUrl` option, guarded registration, loaded once per context |
| 8 | app pokes deck internals (`_padRoll`, `_padDryHold`, `_loopBeats`, `_loopInPoint`, `_syncBase`, `_pllCorr`, `synced = …`, `onEnded`, `engine.jogHold`, `masterIdx`) | public methods, getters and events (§5, Appendix A) |
| 9 | i18n `t()`, `flashStatus` in the logic moved from `app.js` | none in the package: return values and events instead |
| 10 | `localStorage` (VST slots, `snapRelease` flag, palette, tempo range…) | no storage at all; options instead (`scrubEnd({ snap })`) |
| 11 | `window.api`, VST worker/worklet, SharedArrayBuffer ring (`vst.js`, `vst-worker.js`, `vst-worklet.js`) | not ported; generic `deck.setInsert(node, latency)` kept |
| 12 | `window.devicePixelRatio`, `document.createElement`, `canvas._strip` / `_cache` expandos | lazy `globalThis` reads, `OffscreenCanvas` when available, `WeakMap` caches |
| 13 | personal names and controller-specific wording in comments | neutral wording; technical content kept (§4) |
| 14 | `deck.track = { name, path }` (library shape) | opaque `track` metadata |
| 15 | `engine.resume()` sprinkled through the UI | `engine.resume()` public; also called by `play()`, `cueDown()` and `loadFrom()` |

---

## 8. App logic moved into the package

These features live in `app.js` today. They are needed by any DJ UI and use
engine internals, so they move into the package. The logic is kept; UI and i18n
are dropped.

| app.js function | Package API |
|---|---|
| frame loop `engine.syncLock()` + FX `setBeatDur(beatOf(…))` | `engine.tick()` (+ auto-tick) |
| `playDeck` (align a synced deck when it starts) | `deck.play()` |
| `syncDeck` (master case, arming) | `deck.sync()` |
| CUE button pointerdown/up (hold to preview) | `deck.cueDown()` / `deck.cueUp()` |
| `snapToBeat`, hot-cue pad (snap + set / jump) | `snapToBeat()`, `deck.setHotCue()`, `deck.hotCue()` |
| `applyLoop`, loop pads (resize / quantized start) | `deck.beatLoop()` |
| `loopIn`, `loopOut`, `loopHalve`, `loopDouble` | same names on `Deck` (the hardware "IN halves / OUT doubles during a loop" stays in apps) |
| `doBeatJump` and jump pads (moves the loop too) | `deck.beatJump(beats)` (bars × 4) |
| MIDI reloop/exit | `deck.reloop()` / `deck.exitLoop()` |
| tempo fader (`setTempo` + `synced = false`) | `deck.setTempo()` |
| `masterBpmNudge`, `deckBpmNudge`, `syncGroupTempoScale` | `engine.setMasterBpm()` / `setMasterTempo()`, `deck.setBpm()` |
| jog bend (`gpBend`, `jogHold`, release `reanchorSync`) | `deck.nudge()` / `deck.endNudge()` |
| waveform scratch release (`snapToRef` + `reanchorSync`) | `deck.scrubStart/Move/End()` |
| `padFxPress` (dry hold, pad roll) | `deck.setPadFx()` |
| `padSpinFx` (pause, virtual position, aligned resume) | `deck.spinStart()` / `deck.spinEnd()`, `deck.displayPosition` |
| `gridScale`, BPM correction, `gridNudge`, `recalGrid` | `deck.scaleGrid()`, `deck.setGrid()`, `deck.shiftGrid()`, `deck.setDownbeat()` |
| PFL/FX assign plumbing (`fxAssign[u][d] = …; updateFxSends()`) | `engine.assignFx()`, `fx.setEnabled()` (sends auto-updated) |
| `setSinkId` + `_wireOutput()` | `engine.setOutputDevice()` |
| `deck.onEnded` (queue chaining) | `deck.on('ended')` |

---

## 9. Intentional differences from the OpenMix app engine

The docs list these in `CHANGELOG.md` and in the migration guide.

1. Grace periods and end-of-track timing use the audio clock (§7 #2).
2. `setMaster(i)` **sets** the master; it no longer toggles. Use
   `setMaster(null)` for automatic.
3. Grid offset is per engine; the waveform palette is a per-call option.
4. Deck, FX-unit and hot-cue counts are configurable. The OpenMix values
   (4/4/8) remain the defaults.
5. New crossfader side `'thru'`.
6. Worklet file and processor renamed; registration guarded; loaded once per
   context.
7. The recording stream is created lazily, and `getRecordingStream()` throws on
   offline contexts.
8. No logging by default.
9. `deck.setTempo()` on a synced follower leaves SYNC (the app did this in its
   UI handler). `deck.effectiveBpm` excludes the sync servo's micro-correction;
   the app removed it at display time.
10. Kill on any EQ band (was bass only).
11. `analyzeBpm` options are `{ minBpm, maxBpm }` (were `{ lo, hi }`), and the
    result field `q` is renamed `deviationMs`. `analyzeKey` adds `name` and
    `camelot`.
12. New: `limiter` option, `destroy()`, events, `renderOffline()`, `loadFrom()`,
    `analyzeTrack()`, `eject()`.

---

## 10. Testing (silent by construction)

### 10.1 Node unit tests (core: `test/unit/*.test.js`, `test/helpers/**`)

`npm test` runs `node --test "test/unit/*.test.js"`. It must pass in under
30 s with no network, no audio device and no browser.

`test/helpers/` contains a minimal **fake Web Audio** implementation, written by
core, that models what the engine touches:

- node factories with `connect`/`disconnect` that record graph edges;
- `AudioParam` with immediate `value` updates for `set*`/`*Ramp*`/
  `setTargetAtTime`, plus a recorded event log;
- `AudioBufferSourceNode` with `start`/`stop`/`onended`/`loop*`/
  `playbackRate`;
- `createBuffer`, an analyser that returns zeros, and `audioWorklet.addModule`
  (configurable to resolve or reject), with a fake `AudioWorkletNode` installed
  on `globalThis`;
- a controllable clock (`ctx.advance(seconds)`);
- a fake offline context with `suspend`/`resume`/`startRendering`.

Required coverage (file names are up to core):

1. **Imports:** every entry point imports in Node, and the export lists match
   §5.1 exactly.
2. **Types parity:** every runtime export of each entry is declared in the
   matching `.d.ts`, checked by parsing the text.
3. **Hygiene:**
   - The SPDX header is present in every file under `src/`, `worklets/` and
     `types/`.
   - None of these strings appear in `src/` or `worklets/`: `localStorage`,
     `window.api`, `[midi]`, `i18n`, `performance.now`, `console.log`.
   - `VERSION` equals `package.json` `version`.
   - `WSOLA_LATENCY_SAMPLES` equals the worklet's `LAT`.
4. **Grid:**
   - index ↔ time round trip;
   - extrapolation before and after the beat list;
   - `gridShift` + `globalGridOffset`;
   - fixed-grid paths;
   - `barAlignedSeekTime` keeps the phase within the bar;
   - `snapToBeat` with divisions 1 and 4.
5. **Key:**
   - all 24 Camelot labels, `keyName`, `shiftKey` wrap-around,
     `keyDistance` cases, `heardKey` with and without keylock;
   - `keyFromChroma` on rotated profiles returns that key;
   - `keyFromMono` on a synthetic 8 kHz A-minor signal returns 21 (Am).
6. **`alignImportedGrid`:** clicks offset by +26 ms are found with a shift of
   0.026 ± 0.002 s.
7. **Worklet DSP**, run in Node with shims (`globalThis.AudioWorkletProcessor`
   base class with a `port`, and `globalThis.registerProcessor` that captures
   the class):
   - It registers under `PITCH_PROCESSOR_NAME`.
   - At ratio 1, the output is the input delayed by exactly LAT samples
     (|error| < 1e-6 after warm-up).
   - At ratio 2^(3/12), a 440 Hz sine comes out at 523.25 Hz ± 5 cents.
   - Ratios are clamped to 0.5–1.8.
   - No NaN in the output.
8. **Engine** (fake context):
   - defaults: 4 decks, 4 units, 8 slots, sides A/B/A/B, unit u assigned to
     deck u;
   - `decks: 2` and `decks: 6`;
   - `RangeError` cases;
   - `destroy()` closes only an owned context.
9. **Transport:**
   - load/eject state and events;
   - play/pause and `position` against the fake clock, including the 30 ms
     scheduled start and seek compensation;
   - pre-roll;
   - natural end: `'ended'`, then play restarts at 0.
10. **Loops and cues:**
    - `setLoop`/`exitLoop`/`reloop`;
    - `beatLoop` with a quantized start (nearest ¼ beat) and grid length,
      plus resize;
    - `loopIn`/`loopOut` rules, halve/double limits;
    - `beatJump` moves an active loop;
    - `loop.beats`;
    - hot cues with and without `quantize`;
    - `cue`/`cueDown`/`cueUp` semantics;
    - `'loop'`, `'hotcue'` and `'cuepoint'` events.
11. **Sync:**
    - every `sync()` result;
    - the ratio from local periods, including octave folding;
    - the bar-alignment seek target;
    - auto master = first started;
    - manual master set and clear (`'master'` event);
    - handover after 1.2 s of **audio** time, and immediately at a natural end;
    - `setTempo` on a follower unsyncs;
    - `setMasterBpm` scales followers in the same call;
    - `nudge`/`endNudge` hold and reanchor.
12. **Mixer and FX:**
    - crossfader gains for A/B/thru at 0, 0.5 and 1;
    - EQ dB, trim and fader curves;
    - `setFilter` in `'filter'` mode versus an echo mode (send gain);
    - `assignFx`/`setEnabled` → send gains;
    - `ensureMasterFx` is idempotent;
    - pad-FX dry hold;
    - a throwing listener does not break `tick()`.
13. **`renderOffline`** with the fake offline context:
    - ticks at quantized, increasing times;
    - `onTick` is awaited;
    - a clear error when `suspend` is missing and `tickRate > 0`.

### 10.2 Browser tests (demo: `test/browser/**`)

`test/browser/index.html` runs the suite on load. A "Run again" button runs it
again.

- **Context and inputs:**
  - Only `OfflineAudioContext` (48 kHz), never a realtime context.
  - Synthesized signals only, from a seeded PRNG.
  - Public API only, imported from `../../src/index.js`.
- **Results protocol:**
  - `window.__TEST_RESULTS__` is set to
    `{ done, passed, failed, skipped, results: [{ name, pass, skipped, metrics, error }] }`.
  - When the suite ends, `document.title` becomes `'PASS n/n'` or
    `'FAIL k/n'`.
  - A readable table is shown on the page.
- **Per-deck capture technique:**
  1. Put a unity `GainNode` on each deck with `deck.setInsert(tap, 0)`.
  2. Connect each tap to a `ChannelMerger`, one input per deck, and connect the
     merger to the destination.
  3. Route the engine master to a gain-0 sink (`output` option).

  The rendered channels are then the decks, as heard (after
  keylock/transposer compensation).

The tests, with their pass criteria. The metrics are always reported, including
on failure.

1. **`sync-60s`**
   - Setup: two decks with impulse click tracks at 124.000 and 128.000 BPM.
     Exact beat lists are given (not analyzed). Deck 0 plays at t = 0; deck 1
     calls `sync()` and plays at t = 2 s. The render is 64 s with
     `renderOffline` at 60 Hz.
   - Measure: the onset offset (deck 1 − deck 0) for each beat in 10–62 s.
   - Pass: median |offset| ≤ 1.0 ms, p95 ≤ 2.0 ms, max ≤ 5 ms, and
     |drift slope| ≤ 0.02 ms/s.
2. **`sync-keylock-60s`**
   - Setup: the same as test 1, but deck 1 has keylock on (transposer path,
     latency compensated).
   - Pass: median ≤ 1.5 ms, p95 ≤ 3 ms, max ≤ 6 ms.
3. **`keylock-pitch`**
   - Setup: a 440 Hz sine, measured over 2–8 s.
   - Cases:
     - keylock on, tempo 1.06 → 440 Hz;
     - keylock off, key +3 → 523.25 Hz;
     - keylock on, tempo 0.94, key −5 → 440 × 2^(−5/12) Hz.
   - Pass: each case within ±5 cents. Also report the fallback engine
     (`keylock: false` option, key +3) as information only.
4. **`loop-precision`**
   - Setup: an impulse every 0.25 s, `setLoop(1.0, 1.5)` while playing,
     render 8 s.
   - Pass: every repeat interval equals 0.5 s / tempo within ±2 samples, and
     the impulse at loop start recurs within ±2 samples.
5. **`beatloop-quantize`**
   - Setup: a 120 BPM beat list (beats at 0, 0.5, 1.0, …), position 1.13 s.
   - Pass: `beatLoop(4)` gives `loop.start` = 1.125, `loop.end` = 3.125 and
     `loop.beats` = 4.
6. **`analysis-bpm`**
   - Setup: synthesized 60 s kick/hat tracks at 128 BPM and 100 BPM.
   - Pass: |bpm − truth| ≤ 0.02, `rigid === true`, and the median
     |beat − truth| ≤ 3 ms.
7. **`analysis-key`**
   - Setup: a synthesized 30 s A-minor progression (A pedal, Am triads, natural
     minor melody).
   - Pass: `code === 21` (Am).
8. **`peaks`**
   - Pass: array lengths = ⌈duration × perSecond⌉, and values are in range;
     `fine: false` gives `finePps === 0`.
9. **`cue-routing`**
   - Setup: a 4-channel `OfflineAudioContext` with no `output` option.
     `headphonesAvailable` must be true.
   - Pass:
     - PFL on with the fader at 0: channels 3/4 RMS > −30 dBFS and channels
       1/2 < −90 dBFS.
     - PFL off: channels 3/4 < −90 dBFS.
10. **`render-cpu`** (information only)
    - Setup: 4 decks for 60 s, 2 keylocked, 2 FX units on.
    - Report the realtime factor (60 s / wall time). It passes unless it
      throws.

The whole suite should finish in under 90 s in headless Chromium.

### 10.3 Headless runner (demo: `scripts/test-browser.js`)

The runner uses zero dependencies and Node ≥ 22 (global `WebSocket` and
`fetch`).

1. **Server:** it starts the static server in-process with
   `startServer({ port: 0 })` (an ephemeral port).
2. **Browser lookup:**
   - It looks for a Chromium-family browser: first `--browser <path>` or
     `CHROME_PATH`; then the standard Chrome, Edge and Chromium install
     locations on Windows, macOS and Linux.
   - It never uses Electron from the openmix folder.
   - If no browser is found, it exits with code **2** and a clear message
     (open `/test/browser/` manually).
3. **Launch flags:** `--headless=new --mute-audio --no-first-run
   --no-default-browser-check --disable-extensions --user-data-dir=<fresh temp dir>
   --remote-debugging-port=0`. It reads the port from `DevToolsActivePort` in the
   profile directory, and never uses 9333 or 8722.
4. **Running the suite:**
   - It drives the page over CDP: navigates to `<server>/test/browser/` and
     polls `window.__TEST_RESULTS__`.
   - The timeout is 120 s.
   - It prints one line per test with its metrics, then a summary.
5. **Exit codes:** 0 = all passed; 1 = failures or a timeout; 2 = an
   infrastructure error.
6. **Cleanup** always runs, in `finally`: close CDP, kill **only** the spawned
   child process through its handle, delete the temporary profile (best effort,
   with retries on Windows), and close the server.

---

## 11. Work split: three parallel tasks

All three teams start from this contract at the same time. Nobody waits for
anybody: demo and docs code against §5, not against core's files.

### 11.1 `core`: the package source, worklet, types and unit tests

- **Owns:** `src/**`, `worklets/**`, `types/**`, `test/unit/**`,
  `test/helpers/**`.
- **Deliverables:**
  1. The port described in §4, preserving all of §6. Apply §7 and move in §8.
     Implement **every** symbol of §5 with the exact names, signatures,
     defaults, return values and events.
  2. `worklets/pitch-processor.js`:
     - the same DSP as `pitch-worklet.js`;
     - `registerProcessor(PITCH_PROCESSOR_NAME …)` wrapped in `try/catch`;
     - `{ lat }` posted on startup;
     - no imports, no allocation in `process()`, and loadable in Node through
       shims.
  3. `types/index.d.ts`, `analysis.d.ts` and `waveform.d.ts` matching §5, with
     JSDoc carrying the defaults and ranges. `index.d.ts` re-exports the other
     two.
  4. The unit tests of §10.1 and the fake Web Audio in `test/helpers/`.
- **Implementation notes:**
  - **Internal versus public entry points:**
    - Rename the servo's internal `setTempo` calls to `_setRate`. The public
      `setTempo` adds the unsync and master-base rules (§5.5).
    - Use an internal `_play()` for restarts that must not re-align.
  - **Engine wiring:**
    - Keep the 30 ms start constant and the `_onTempo` → follow-master hook.
    - The `FxUnit` constructor takes an `onChange` hook so the engine can
      update the sends.
    - Generalize everything to N decks (§7 #4). `_pickBassDeck` must handle
      `'thru'` (side gain 1).
  - **Defensive coding:**
    - Wrap `tick()` steps so that a listener cannot break the lock.
    - Wrap destination channel settings in `try/catch` (§6.6).
- **Acceptance:**
  - `npm test` is green and silent, in under 30 s.
  - Every module imports in Node.
  - The hygiene test passes.
  - No file is written outside the owned paths.
- **Report:** in your final report, list any deviation from §5 and §6, and any
  OpenMix behavior you could not preserve.

### 11.2 `demo`: example app, static server, browser tests

- **Owns:** `example/**`, `scripts/**`, `test/browser/**`.
- **Deliverables:** the following components.

**1. `scripts/serve.js`**

- It is a CLI (`node scripts/serve.js [--port 8080] [--host 127.0.0.1] [--root <dir>]`)
  **and** a module exporting
  `startServer({ root, host, port }) → Promise<{ url, port, close() }>`.
- Defaults:
  - The root is the package root, resolved from the script location.
  - The host is `127.0.0.1` (never `0.0.0.0` unless `--host` is given).
  - The port is 8080; if it is busy, the server tries 8081–8099. Port 0 means
    ephemeral.
- MIME types:
  - `.js`/`.mjs` → `text/javascript; charset=utf-8`;
  - `.html`, `.css`, `.json`, `.map`, `.md`, `.txt`, `.svg`, `.png`, `.ico`;
  - `.wav`, `.mp3`, `.ogg`, `.flac`, `.m4a`, `.webm`.
- Request handling:
  - Only GET and HEAD are allowed (405 otherwise); unknown paths get 404.
  - A directory serves its `index.html`, and `/` redirects to `/example/`.
  - Path traversal is rejected: the resolved path must stay inside the root.
  - Every response carries `Cache-Control: no-store`.
- It prints the demo URL (`/example/`) and the tests URL (`/test/browser/`).
- It never opens a browser.

**2. `example/index.html` + `example/demo.js`**

Optional extra files are allowed: `example/demo.css`, `example/synth.js`, and
so on.

- **Constraints:**
  - It is a no-build, no-framework, no-network page that imports only
    `../src/index.js`.
  - It works in a normal browser at `http://127.0.0.1:8080/example/`, and from
    any static server rooted at the package.
  - Under `file://`, it shows a clear message instead.
- **Header:** context state, sample rate, `baseLatency`/`outputLatency`,
  `pitchEngine`, `headphonesAvailable`, and a **Start audio** button that calls
  `engine.resume()`.
- **Four decks.** Each deck has:
  - track loading:
    - file input and drag-and-drop;
    - a **demo track** menu.

    Demo tracks are synthesized in the browser with `OfflineAudioContext`.
    There are at least two presets, such as "House 124 BPM · A minor" and
    "Techno 128 BPM · F minor", each 60–120 s long. They are loaded through
    `loadFrom(buffer)`, so the analysis runs on them.
  - display:
    - title;
    - effective BPM;
    - key name, Camelot label and heard key;
    - a MASTER badge and button.
  - transport and sync: PLAY, CUE (hold-to-preview via `cueDown`/`cueUp`),
    SYNC.
  - tempo and key:
    - tempo slider (±8 %) with a % readout;
    - keylock toggle;
    - KEY −/+ with a value readout.
  - performance controls:
    - hot cues 1–4 (click = `hotCue`, Shift/Alt-click = `clearHotCue`);
    - beat loop ½/1/2/4/8 and exit, plus IN/OUT;
    - beat jump ±4 beats.
  - waveforms:
    - an overview canvas (`drawOverview`);
    - a zoom canvas (`drawZoom` with `windowSeconds: 8 * deck.baseTempo`) with
      a center playhead line.
- **Mixer:**
  - per channel: TRIM, 3-band EQ, FILTER knob, fader, PFL toggle, VU meter
    (`meterPeak`);
  - crossfader;
  - master volume, master filter and master VU (`masterPeak`);
  - a color-FX select (`COLOR_FX_TYPES`) and its ON toggle.
- **FX:**
  - one panel per beat-FX unit: type (`FX_TYPES`), beats (`FX_BEATS`), level,
    ON, and deck assignment toggles;
  - optional pad-FX buttons from `DEFAULT_PAD_FX` (hold = on).
- **Output devices:** if `'setSinkId' in AudioContext.prototype`, show selects
  for the master device (`setOutputDevice`) and the headphone device
  (`setHeadphoneDevice`), filled from `enumerateDevices`. Handle labels that are
  hidden without permission.
- **`?silent=1`:** master and headphone volume 0 at startup, with a visible
  "SILENT" badge (for smoke tests).
- **Rendering:**
  - Draw on `engine.on('tick')`.
  - Write to the DOM only when values change; no layout reads in the frame
    loop.
- **Style:**
  - Dark theme, readable at 1280×720, with accessible labels.
  - Deck colors: `#39c2ff`, `#ff9f43`, `#5fe08a`, `#ff6b9d` (the OpenMix
    palette).
  - Everything is inline: no fonts or icons fetched from the network.

**3. `test/browser/**`:** the suite and protocol of §10.2.

**4. `scripts/test-browser.js`:** the runner of §10.3.

- **Acceptance:**
  - `node scripts/serve.js` serves the package root.
  - The demo, once core is in place, loads without console errors, plays,
    syncs and draws, using only the public API.
  - The browser suite follows the protocol.
  - The runner obeys every safety rule in §2.
- **Report:** in your final report, list any API friction you hit (it becomes
  input for the contract).

### 11.3 `docs`: README, changelog, license, migration guide

- **Owns:** `README.md`, `CHANGELOG.md`, `LICENSE`, `docs/**`.
- **Deliverables:**

**1. `README.md`**, with these sections in this order:

1. Title and pitch, credits ("the Web Audio engine of
   [OpenMix](https://github.com/blackmagic42/openmix)"), status 0.1.0, MIT.
2. Features.
3. Installation and usage from source:
   - The package is **not on npm yet**. Never claim it is; npm install
     instructions may only appear as "once published".
   - Cover: a git checkout, copying the folder, an import map, and the bundler
     note about `new URL(…, import.meta.url)` and `workletUrl`.
   - AudioWorklet needs a secure context (https or localhost).
4. Quick start: use §5.0.
5. Demo and tests: `npm run demo` → `http://127.0.0.1:8080/example/`;
   `npm test`; `npm run test:browser`. Node ≥ 22 is needed only for these
   scripts. Any static server at the package root also works.
6. Concepts:
   - signal flow (§6.1 diagram);
   - decks and the timing model;
   - beat grids and analysis;
   - sync and phase lock (master election, calibration, lock, deliberate
     offsets, nudge and reanchor);
   - keylock and its latency compensation;
   - FX (beat FX, roll, pad FX, master FX, color FX, dry compensation);
   - cue routing to a second output (the §6.6 table, 4-channel devices,
     `cueOutput` with a MediaStream and `<audio>.setSinkId`,
     `setHeadphoneDevice` and its bridge latency);
   - offline rendering and testing;
   - the insert hook.
7. API reference: **every** symbol of §5 with its signature, parameters,
   defaults and ranges, returns, events and a short example where useful.
   Group it as: createEngine and options, Engine, Deck, FxUnit, events,
   analysis, waveform, grid helpers, offline, constants and types.
8. Browser support (§13): conservative, as a feature → fallback table.
9. Limits (§13).
10. Contributing and tests, license, and a trademark note. Rekordbox,
    Pioneer DJ and AlphaTheta names belong to their owners; OpenMix is not
    affiliated.

**2. `CHANGELOG.md`:**

- Keep a Changelog 1.1.0 format.
- An empty `[Unreleased]` section.
- `[0.1.0] - 2026-10-16`, with:
  - Added: the feature list;
  - "Differences from the OpenMix app engine": §9;
  - Notes: not published on npm.

**3. `LICENSE`:** the standard MIT text, with
`Copyright (c) 2026 blackmagic42 (OpenMix) and contributors`.

**4. `docs/migration-from-openmix.md`:** Appendix A expanded with short
before/after snippets, plus §9.

- **Acceptance:**
  - 100 % of the §5 symbols are documented.
  - Every code sample is consistent with §5.
  - Claims follow §13.
  - Relative links resolve inside the package.
  - Plain Markdown that renders on GitHub.

---

## 12. Coordination and integration

- **This file is the single source of truth.** Never edit another team's files.
  Contract problems go in your final report, as "deviations" or "friction",
  together with a proposed fix.
- **Integration happens after the three tasks:**
  1. Run `npm test`.
  2. Run `npm run test:browser`: once, headless and muted (§2.4).
  3. Open the demo.
  4. Reconcile the reported deviations, and update DESIGN.md if the contract
     changes.
- **No git operations.** The owner commits.

---

## 13. Facts for the docs: browser support and limits

Be conservative: "tested in" and "requires" rather than version promises.

| Feature used | Needed for | If missing |
|---|---|---|
| Web Audio API (`AudioContext`, `OfflineAudioContext`) | everything | the engine cannot run |
| `AudioWorklet` (Chrome 66+, Firefox 76+, Safari 14.1+); **secure context only** (https, localhost/127.0.0.1) | WSOLA keylock and key shift | fallback two-tap shifter: lower quality, no latency compensation (`pitchEngine === 'fallback'`) |
| `AudioContext.prototype.setSinkId` (Chromium 110+ at the time of writing) | `setOutputDevice`, `setHeadphoneDevice` | they resolve `false`; use `cueOutput` + `<audio>.setSinkId` where available, or the system default |
| `destination.maxChannelCount ≥ 4` (device, driver and browser dependent) | automatic headphone cue on channels 3/4 | no automatic headphone output (`headphonesAvailable === false`) |
| `OfflineAudioContext.prototype.suspend` (Chromium) | `renderOffline` with ticks | it rejects with a clear error; use `tickRate: 0` (no sync lock during the render) |
| `OfflineAudioContext` at 8 kHz and 16 kHz sample rates | `analyzeBpm`, `analyzeKey`, `computePeaks` | analysis rejects |
| `MediaStreamAudioDestinationNode` | `getRecordingStream`, `setHeadphoneDevice` bridge | those features throw or resolve `false` |

**Tested by the project:** Chromium-based browsers, through the automated
headless suite. **Expected to work:** Firefox and Safari, through the standard
API and the fallbacks above. They are not covered by automated tests.

All browsers apply an autoplay policy: the context starts suspended, so call
`engine.resume()` from a user gesture.

Limits:

- **Memory:** whole tracks are decoded in memory as float32, ≈ 21 MB per stereo
  minute at 44.1 kHz. Stems multiply that.
- **Analysis cost:** analysis runs mostly on the main thread. BPM analysis of a
  long track can block for a second or more, so run it before playing or
  between interactions. Key detection yields to the event loop.
- **Ticks:** the sync lock and FX alignment need `tick()` at 30–144 Hz.
  - Without ticks, decks keep their tempo, but phase is not held.
  - In hidden tabs, auto-tick falls back to a 20 ms timer, which browsers may
    throttle.
- **Ranges:**
  - tempo 0.5–1.6 (−50 % … +60 %);
  - key shift ±7 semitones;
  - transposer ratio (key × keylock compensation) clamped to 0.5–1.8;
  - 1–8 decks, 0–8 FX units, 1–16 hot cues.
- **Keylock reaction time:** keylocked or key-shifted decks add a fixed 2647
  samples (≈ 55 ms at 48 kHz). Timing is compensated, but play-from-stop and
  seeks on such a deck are heard that much later.
- **Headphones on a second device** through `setHeadphoneDevice`: the bridge
  latency between master and headphones is not compensated.
- **Grids:** sync quality depends on the beat grids. A track with no detectable
  beat (`bpm === null`) can't sync.
- **Out of scope:** library management, MIDI/HID, stem separation, VST
  hosting, recording UI.

---

## Appendix A: migration table (OpenMix app → package)

| OpenMix app (engine.js / app.js) | @openmix/web-engine |
|---|---|
| `new AudioEngine()` | `await createEngine()` (or `new Engine()` + `await engine.ready`) |
| `engine.ctx` | `engine.context` |
| `engine.syncLock()` every frame + FX `setBeatDur(beatOf(…))` | `engine.tick()` (auto-tick by default) |
| `deck.loadTrack({ buffer, bpm, beats, … })` | `deck.load(buffer, { bpm, beats, … })` |
| `deck.currentTime()` | `deck.position` (`currentTime()` kept) |
| `deck.onEnded = fn` | `deck.on('ended', fn)` |
| `engine.setCuePfl(i, on)`, `deck.cueOn` | `deck.setHeadphoneCue(on)`, `deck.headphoneCue` |
| `engine.setDeckColor(i, v)`, `deck.filterVal` | `deck.setFilter(v)`, `deck.filterValue` |
| `deck.trimVal` | `deck.trimValue` |
| `engine.setColorType(t)` / `setColorEnabled(b)` | `engine.setColorFx(t)` / `setColorFxEnabled(b)` |
| `engine.setMaster(i)` (toggle) | `engine.setMaster(engine.manualMasterIndex === i ? null : i)` |
| `engine.masterIdx` / `engine.autoMasterIdx` | `engine.manualMasterIndex` / `engine.masterIndex` |
| `engine.sync(i)` + app arming (`syncDeck`) | `deck.sync()` |
| `deck.synced = false` | `deck.unsync()` |
| tempo fader: `deck.setTempo(x); deck.synced = false` | `deck.setTempo(x)` |
| `masterBpmNudge` / `deckBpmNudge` (`_syncBase` writes) | `engine.setMasterBpm(bpm)` / `deck.setBpm(bpm)` |
| jog bend: `engine.jogHold = true; deck.setTempo(base × …)`, release + `reanchorSync` | `deck.nudge(amount)` / `deck.endNudge()` |
| scratch release: `engine.snapToRef(i)` + `reanchorSync(k)` | `deck.scrubEnd({ snap: true })` |
| `engine.reanchorSync(k)` loop | `engine.reanchorSync()` |
| `engine.fxAssign[u][d] = on; engine.updateFxSends()` | `engine.assignFx(u, d, on)` |
| `fx.setEnabled(b); engine.updateFxSends()` | `engine.fx[u].setEnabled(b)` |
| `fx.setBeatsMult(m)` / `fx.setBeatDur(s)` | `fx.setBeats(m)` / `fx.setBeatDuration(s)` |
| `engine.setPadFx(i, p); deck._padDryHold = PADFX_DRY[p.type]` | `deck.setPadFx(p)` |
| `deck._padRoll = { beats }; deck.startRoll(beats, 1)` | `deck.setPadFx({ type: 'roll', beats })` |
| `deck.spinSound(kind)` + app pause/resume (`padSpinFx`) | `deck.spinStart(kind)` / `deck.spinEnd()` (+ `displayPosition`) |
| `applyLoop(d, beats)` | `deck.beatLoop(beats)` |
| `doBeatJump(d, measures)` | `deck.beatJump(measures * 4)` |
| `loopIn(i)` / `loopOut(i)` / `loopHalve(i)` / `loopDouble(i)` | `deck.loopIn()` / `loopOut()` / `loopHalve()` / `loopDouble()` |
| `deck._loopBeats`, `deck._loopInPoint` | `deck.loop.beats`, `deck.loop.inPoint` |
| hot-cue pad (snap + `hotCues[i] = t` / `seek`) | `deck.hotCue(slot)` |
| `deck.hotCues[i] = null` | `deck.clearHotCue(slot)` |
| `library.setHotCues(…)`, `setGridMeta(…)`, `setBpmValue(…)` after edits | listen to `'hotcue'` / `'grid'` |
| `gridScale(×2/÷2)`, BPM correction, `gridNudge`, `recalGrid` | `deck.scaleGrid()`, `deck.setGrid()`, `deck.shiftGrid()`, `deck.setDownbeat()` |
| `setGlobalGridOffset(sec)` / `getGlobalGridOffset()` | `engine.setGridOffset(sec)` / `engine.gridOffset` |
| `setWavePalette(p)`; `drawZoom(c, deck, win, t)` | `drawZoom(c, deck, { windowSeconds: win, time: t, palette: p })` |
| `computeBandPeaks(buffer, pps, { fine })` | `computePeaks(buffer, { perSecond: pps, fine })` |
| `detectBPM(buffer, { lo, hi })` → `{ …, q }` | `analyzeBpm(buffer, { minBpm, maxBpm })` → `{ …, deviationMs }` |
| `detectKey(buffer)` | `analyzeKey(buffer)` (+ `name`, `camelot`) |
| `engine.recDest.stream` | `engine.getRecordingStream()` |
| `engine.ctx.setSinkId(id); engine._wireOutput()` | `engine.setOutputDevice(id)` |
| `engine.setPhonesDevice(id)`, `engine.phonesOk` | `engine.setHeadphoneDevice(id)`, `engine.headphonesAvailable` |
| `engine._localPeriod(d)` / tempo ÷ `(1 + _pllCorr)` | `deck.beatDuration` / `deck.baseTempo`, `deck.effectiveBpm` |
| `deck.toggleBassKill()` | `deck.setKill('low', on)` |
| `VstHost` → `deck.setInsert(node, latency)` | `deck.setInsert(node, latency)` (generic; the VST host stays in the app) |
| worklet `src/js/pitch-worklet.js`, `'pitch-shift'` | `worklets/pitch-processor.js`, `'openmix-pitch-shift'` |
