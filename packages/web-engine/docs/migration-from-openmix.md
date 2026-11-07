# Migrating from the OpenMix app engine

This guide is for code written against the engine that ships inside the
OpenMix app: `AudioEngine`, `Deck` and `FxUnit` in `src/js/engine.js`, the
engine logic in `src/js/app.js`, and the helpers in `bpm.js`, `key.js`,
`waveform.js` and `pitch-worklet.js`. It maps each of them to
`@openmix/web-engine`.

The OpenMix app itself has not switched to the package yet; that switch comes
later. The package keeps the app's sound and behavior, so most changes are
renames, plus app logic that moved into the engine (see
[DESIGN.md](../DESIGN.md) §8). For the full API, see the
[README](../README.md#api-reference).

## Contents

- [What changes in a nutshell](#what-changes-in-a-nutshell)
- [Quick reference](#quick-reference)
- [Before and after](#before-and-after)
  - [Creating the engine](#creating-the-engine)
  - [The frame loop](#the-frame-loop)
  - [Loading tracks and analysis](#loading-tracks-and-analysis)
  - [Position and end of track](#position-and-end-of-track)
  - [Mixer](#mixer)
  - [Master](#master)
  - [Sync and tempo](#sync-and-tempo)
  - [Jog bend and scratch](#jog-bend-and-scratch)
  - [FX](#fx)
  - [Pad FX, roll and spin](#pad-fx-roll-and-spin)
  - [Loops, jumps and hot cues](#loops-jumps-and-hot-cues)
  - [Grid editing and persistence](#grid-editing-and-persistence)
  - [Waveforms](#waveforms)
  - [Outputs and recording](#outputs-and-recording)
  - [Display values](#display-values)
  - [Insert and VST](#insert-and-vst)
  - [Worklet and logging](#worklet-and-logging)
- [Intentional differences](#intentional-differences)
- [What stays in the app](#what-stays-in-the-app)
- [Checklist](#checklist)

## What changes in a nutshell

- **One import.** Everything comes from `@openmix/web-engine` (analysis and
  waveform helpers also have their own entry points).
- **Configurable sizes.** 4 decks, 4 FX units and 8 hot cues are the defaults,
  no longer hard-coded.
- **No more internals.** Code that wrote `_syncBase`, `_padDryHold`,
  `_loopInPoint`, `synced = …` or `engine.jogHold` now calls public methods.
- **App logic moved in.** Sync arming, the re-alignment on play, the
  hold-to-preview CUE, quantized hot cues, beat loops, beat jumps, the jog
  bend, the pad FX and the brake/backspin effects are engine methods.
- **Events instead of library calls.** Listen to `'hotcue'`, `'loop'` and
  `'grid'` to persist user edits, and to `'ended'` to chain tracks.
- **No app couplings.** No `localStorage`, no i18n, no `window.api`, no
  `[midi]` logs: return values, events and options replace them.

## Quick reference

The OpenMix app (engine.js / app.js) on the left, the package on the right.

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

Two mappings need care:

- **`autoMasterIdx`.** The app usually computed the effective master as
  `masterIdx !== null ? masterIdx : autoMasterIdx`: that expression is now
  `engine.masterIndex`. The automatic candidate alone, while a manual master is
  set, is not exposed.
- **`effectiveBpm`.** The app's `deck.effectiveBpm` was `bpm × tempo`, with the
  sync servo's micro-correction included. The package's is
  `bpm × baseTempo`, without it, which is what the app displayed.

## Before and after

Each "before" snippet shows the app code (simplified), and each "after"
snippet shows the same thing with the package.

### Creating the engine

Before:

```js
import { AudioEngine } from './engine.js';

const engine = new AudioEngine();   // its own AudioContext, wired to ctx.destination
engine.resume();
console.log(engine.ctx.sampleRate);
```

After:

```js
import { createEngine } from '@openmix/web-engine';

const engine = await createEngine();   // or: const engine = new Engine(); await engine.ready;
await engine.resume();                 // from a user gesture
console.log(engine.context.sampleRate);
```

The constructor options replace the hard-wired parts:

```js
const ctx = new AudioContext({ latencyHint: 'interactive' });
const bus = ctx.createGain();
bus.connect(ctx.destination);
const engine = await createEngine({ context: ctx, output: bus, decks: 2, fxUnits: 2, hotCues: 16 });
// … later: stops everything; the injected context stays open
await engine.destroy();
```

### The frame loop

Before (`frameBody` in app.js):

```js
engine.syncLock();                    // lock + FX alignment + dry compensation
const beatOf = (dk) => {
  if (!dk || !dk.bpm) return null;
  const per = engine._localPeriod(dk) || 60 / dk.bpm;
  return per / ((dk.tempo || 1) / (1 + (dk._pllCorr || 0)));
};
const masterBeat = beatOf(engine.getMasterDeck(-1)) || 0.5;
engine.fx.forEach((u, uIdx) => {
  if (u.enabled) u.setBeatDur(beatOf(engine.fxRefDeck(uIdx)) || masterBeat);
});
engine.padFx.forEach((u, d) => {
  if (u && u.enabled) u.setBeatDur(beatOf(engine.decks[d]) || masterBeat);
});
if (engine.masterFx && engine.masterFx.enabled) engine.masterFx.setBeatDur(masterBeat);
```

After: nothing to write. Auto-tick calls `engine.tick()` every frame
(`requestAnimationFrame`, or a timer that keeps one tick every 20 ms on
average in hidden tabs and when frames stop coming, e.g. a minimized Electron
window), and `tick()` does all of the above.
Draw on the `'tick'` event:

```js
engine.on('tick', () => {
  drawZoom(zoomCanvas, deck, { windowSeconds: 8 * deck.baseTempo });
});
```

Or keep your own loop:

```js
const engine = await createEngine({ autoTick: false });
function frame() {
  engine.tick();
  draw();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
```

### Loading tracks and analysis

Before (`loadTrackToDeck`):

```js
const peaks = await computeBandPeaks(buffer);
engine.decks[i].loadTrack({ buffer, bpm, peaks, track, beatOffset, hotCues: (hotCues || []).slice(), beats, gridShift, barAnchor });
engine.decks[i].musicKey = musicKey != null ? musicKey : (track.musicKey ?? null);
```

After, with stored metadata:

```js
engine.decks[i].load(buffer, { bpm, beats, beatOffset, barAnchor, gridShift, hotCues, peaks, musicKey, track });
```

After, in one call (decode, analyze what is missing, load):

```js
// Nothing known yet: BPM/grid, key and peaks are all analyzed
await engine.decks[i].loadFrom(file);
// Grid and key known: only the peaks are computed
await engine.decks[i].loadFrom(url, { bpm, beats, barAnchor, gridShift, musicKey, hotCues, track });
```

`loadFrom()` also replaces the app's cancellation of a load in progress: a
newer `loadFrom()` on the same deck rejects the older one with an
`'AbortError'`, and so does an `AbortSignal`.

The analysis functions are renamed:

```js
// Before
const grid = await detectBPM(buffer, { lo: 90, hi: 180 });       // { bpm, beatOffset, beats, barAnchor, rigid, q }
const key = await detectKey(buffer);                              // { code, confidence, score, tuning }
const thumb = await computeBandPeaks(buffer, 400, { fine: false });
```

```js
// After
const grid = await analyzeBpm(buffer, { minBpm: 90, maxBpm: 180 }); // { …, deviationMs } instead of q
const key = await analyzeKey(buffer);                                // + key.name ('Am'), key.camelot ('8A')
const thumb = await computePeaks(buffer, { perSecond: 400, fine: false });
const all = await analyzeTrack(buffer);                              // the three at once
```

### Position and end of track

Before:

```js
const t = deck.currentTime();
deck.onEnded = () => loadNextFromQueue(i);
```

After:

```js
const t = deck.position;                           // deck.currentTime() still works
deck.on('ended', () => loadNextFromQueue(deck.index));
```

### Mixer

Before:

```js
engine.setCuePfl(i, true);          // state in deck.cueOn
engine.setDeckColor(i, -0.4);       // state in deck.filterVal
engine.setColorType('dubecho');
engine.setColorEnabled(false);
deck.setTrim(0.2);                  // state in deck.trimVal
deck.toggleBassKill();
```

After:

```js
deck.setHeadphoneCue(true);         // deck.headphoneCue
deck.setFilter(-0.4);               // deck.filterValue
engine.setColorFx('dubecho');       // RangeError on an unknown id
engine.setColorFxEnabled(false);
deck.setTrim(0.2);                  // deck.trimValue
deck.setKill('low', true);          // any band; setKill('low', false) restores the knob
```

The crossfader sides are per deck now, with a new `'thru'` side:

```js
// Before: engine.xfSides = ['A', 'B', 'A', 'B'] (hard-coded)
engine.decks[2].setCrossfaderSide('thru');   // always at full level
```

### Master

Before:

```js
engine.setMaster(i);                // a toggle: pressing again cleared it
const manual = engine.masterIdx;
const mi = engine.masterIdx !== null ? engine.masterIdx : engine.autoMasterIdx;
```

After:

```js
engine.setMaster(engine.manualMasterIndex === i ? null : i);   // the old toggle
engine.setMaster(null);                                         // back to automatic
const manual = engine.manualMasterIndex;
const mi = engine.masterIndex;
engine.on('master', ({ index, manual: isManual }) => showMasterBadge(index, isManual));
```

### Sync and tempo

Before (`syncDeck` and `playDeck` in app.js):

```js
function syncDeck(i) {
  engine.resume();
  const d = engine.decks[i];
  const mi = engine.masterIdx !== null ? engine.masterIdx : engine.autoMasterIdx;
  if (mi === i && d.bpm) {          // the master: arm without touching its tempo
    d.synced = true;
    d._syncBase = d.tempo;
    d._syncRef = d.tempo;
    return;
  }
  if (engine.sync(i)) return;       // aligned to the master
  if (d.bpm) d.synced = true;       // no reference yet: armed
}

function playDeck(i) {
  engine.resume();
  const deck = engine.decks[i];
  const wasPlaying = deck.playing;
  deck.togglePlay();
  const mi = engine.masterIdx !== null ? engine.masterIdx : engine.autoMasterIdx;
  if (!wasPlaying && deck.playing && deck.synced && mi !== i) engine.sync(i);
}
```

After:

```js
const result = deck.sync();         // 'synced' | 'armed' | 'master' | null (no BPM)
deck.play();                        // a synced follower that starts is aligned to the master
deck.unsync();                      // was: deck.synced = false
deck.on('sync', ({ synced }) => syncButton.classList.toggle('on', synced));
```

The tempo fader no longer needs to unsync by hand:

```js
// Before
deck.setTempo(1 + v / 100);
deck.synced = false;
```

```js
// After: a synced follower leaves SYNC by itself ('sync' event);
// on the master, the followers follow in the same call
deck.setTempo(1 + v / 100);
```

BPM buttons no longer write `_syncBase`:

```js
// Before (masterBpmNudge)
const m = engine.decks[mi];
const nt = m.tempo * (target / (m.bpm * m.tempo));
m.setTempo(nt);
if (m._syncBase) m._syncBase = nt;
```

```js
// After
if (engine.masterBpm) engine.setMasterBpm(engine.masterBpm + 0.5);   // the followers follow
engine.setMasterTempo(1.02);                                          // the same, as a ratio
deck.setBpm(124);                                                     // = deck.setTempo(124 / deck.bpm)
```

### Jog bend and scratch

Before (the gamepad and MIDI jog bend):

```js
// while the jog moves
if (!gpBend[d]) {
  gpBend[d] = { tempo: gpBaseTempo(deck), synced: deck.synced };
  engine.jogHold = true;
}
deck.synced = false;
deck.setTempo(gpBend[d].tempo * (1 + v * Math.abs(v) * 0.06));
// on release
deck.setTempo(gpBend[d].tempo);
deck.synced = gpBend[d].synced;
gpBend[d] = null;
engine.jogHold = false;
for (let k = 0; k < 4; k++) engine.reanchorSync(k);
```

After:

```js
deck.nudge(v * Math.abs(v) * 0.06);   // while the jog moves: base captured once, lock held
deck.endNudge();                       // on release: base back, then every synced deck adopts the new alignment
```

`engine.syncHold` reads `true` during the bend, and `engine.setSyncHold(on)`
suspends the lock for gestures of your own.

Before (the waveform scratch release):

```js
deck.scrubEnd();
if (scrub.wasPlaying) deck.play();
if (localStorage.getItem('snapRelease') !== '0') engine.snapToRef(i);
for (let k = 0; k < 4; k++) engine.reanchorSync(k);
```

After:

```js
deck.scrubStart();                          // pauses, remembers whether the deck was playing
deck.scrubMove(t);                          // audible grains at the gesture speed
deck.scrubEnd({ snap: userWantsSnap });     // resume, snapToReference() if snap, then reanchorSync()
```

`engine.snapToRef(i, maxErr)` is now `deck.snapToReference(maxBeats)`.

### FX

Before:

```js
engine.fxAssign[u][d] = true;
engine.updateFxSends();
engine.fx[u].setEnabled(true);
engine.updateFxSends();
engine.fx[u].setBeatsMult(0.5);
engine.fx[u].setBeatDur(60 / 128);
```

After:

```js
engine.assignFx(u, d, true);              // sends updated
engine.fx[u].setEnabled(true);            // sends updated
engine.fx[u].setBeats(0.5);
engine.fx[u].setBeatDuration(60 / 128);   // rarely needed: tick() follows the reference deck
```

The FX option lists of app.js are exported as `FX_TYPES`, `COLOR_FX_TYPES`,
`FX_BEATS` and `DEFAULT_PAD_FX`, and the dry tables as `FX_DRY_CUT`,
`fxDryCut()` and `PAD_FX_DRY`.

### Pad FX, roll and spin

Before (`padFxPress`):

```js
engine.setPadFx(i, preset);
engine.decks[i]._padDryHold = PADFX_DRY[preset.type] ?? 1;
// release
engine.setPadFx(i, null);
engine.decks[i]._padDryHold = null;

// the ROLL pad
deck._padRoll = { beats: 0.5, mix: 1 };
deck.startRoll(0.5, 1);
// release
deck._padRoll = null;
deck.stopRoll();
```

After:

```js
deck.setPadFx(preset);                          // dry = preset.dry ?? PAD_FX_DRY[type] ?? 1 while held
deck.setPadFx(null);
deck.setPadFx({ type: 'roll', beats: 0.5 });    // the ROLL pad: a slip roll
deck.setPadFx(null);
```

Before (`padSpinFx`):

```js
const wasPlaying = deck.playing;
if (wasPlaying) deck.pause();
deck.spinSound('backspin');
const s = { pos0: deck.currentTime(), start: performance.now(), wasPlaying };
// release
deck.stopSpinSound();
if (s.wasPlaying) {
  const elapsed = (performance.now() - s.start) / 1000;
  deck.seek(Math.min(deck.duration, s.pos0 + elapsed * (deck.tempo || 1)));
  deck.play();
} else {
  deck.seek(Math.max(0, s.pos0));
}
// display during the effect: s.pos0 + elapsed × tempo
```

After:

```js
deck.spinStart('backspin');      // or 'brake' (alias 'vbrake')
deck.spinEnd();                  // resumes where the track would be, on the audio clock
drawZoom(zoomCanvas, deck);      // draws deck.displayPosition: the virtual position during the effect
```

### Loops, jumps and hot cues

Before:

```js
applyLoop(i, 4);                         // resize, or a quantized start
doBeatJump(i, -1);                       // in bars
loopIn(i);                               // IN halves during a loop
loopOut(i);                              // OUT doubles during a loop
const beats = deck._loopBeats;
const inPoint = deck._loopInPoint;
const active = deck.looping;
```

After:

```js
deck.beatLoop(4);
deck.beatJump(-1 * 4);                   // in beats: bars × 4
deck.loopIn();
deck.loopOut();
const { active, start, end, beats, inPoint } = deck.loop;
```

The hardware convention "IN halves and OUT doubles during a loop" stays in
your app:

```js
inButton.onclick = () => (deck.loop.active ? deck.loopHalve() : deck.loopIn());
outButton.onclick = () => (deck.loop.active ? deck.loopDouble() : deck.loopOut());
```

Hot cues, before (the hot-cue pad):

```js
const c = deck.hotCues[idx];
if (c == null) {
  deck.hotCues[idx] = snapToBeat(deck, deck.currentTime());
  if (deck.track) library.setHotCues(deck.track, deck.hotCues);
} else {
  deck.seek(c);
}
// clear (Shift + pad)
deck.hotCues[idx] = null;
if (deck.track) library.setHotCues(deck.track, deck.hotCues);
```

After:

```js
deck.hotCue(idx);             // empty: set it (snapped when deck.quantize is on); set: jump there
deck.clearHotCue(idx);
deck.on('hotcue', () => { if (deck.track) library.setHotCues(deck.track, deck.hotCues); });
```

`snapToBeat(deck, t)` is exported too, with an optional division:
`snapToBeat(deck, t, 4)` snaps to the nearest quarter beat.

### Grid editing and persistence

Before: app functions that edit the deck's grid fields, then save through the
library (`library.setGridMeta()`, `library.setBpmValue()`), plus a
module-global offset:

```js
gridScale(i, 2);
setGlobalGridOffset(ms / 1000);
const offset = getGlobalGridOffset();
```

After:

```js
deck.scaleGrid(2);              // ×2 (0.5 for ÷2); false without a BPM or outside 40–320 BPM
deck.setGrid({ bpm: 126 });     // the BPM correction: a fixed grid
deck.shiftGrid(0.005);          // the grid nudge, in seconds
deck.setDownbeat();             // recalGrid: the beat nearest the playhead starts a bar, exactly here
engine.setGridOffset(ms / 1000);
const offset = engine.gridOffset;
deck.on('grid', ({ bpm, beats, beatOffset, barAnchor, gridShift }) => {
  library.setGridMeta(deck.track, { bpm, beats, beatOffset, barAnchor, gridShift });
});
```

The grid helpers no longer read a module-global offset. A `Deck` carries
`globalGridOffset`; a plain object passes it explicitly:

```js
import { gridIndexFracAt } from '@openmix/web-engine';

gridIndexFracAt(deck, t);                                              // uses deck.globalGridOffset
gridIndexFracAt({ beats, gridShift: 0, globalGridOffset: 0.01 }, t);   // a plain grid
```

### Waveforms

Before:

```js
setWavePalette('club');
drawZoom(zoomCanvas, deck, 8 * deck.tempo, t);
drawOverview(overviewCanvas, deck);
```

After:

```js
drawZoom(zoomCanvas, deck, { windowSeconds: 8 * deck.baseTempo, time: t, palette: 'club' });
drawOverview(overviewCanvas, deck, { palette: 'club' });
```

`time` is optional: by default the drawing follows `deck.displayPosition`,
which already handles the brake and backspin effects. The canvas caches moved
from expando properties (`canvas._strip`, `canvas._cache`) to a module
`WeakMap`.

### Outputs and recording

Before:

```js
await engine.ctx.setSinkId(id);
engine._wireOutput();                    // the channel count (headphones!) depends on the device
const ok = await engine.setPhonesDevice(phonesId);
const phones = engine.phonesOk;
const recorder = new MediaRecorder(engine.recDest.stream);
```

After:

```js
await engine.setOutputDevice(id);                         // false when unsupported, offline or failing
const ok = await engine.setHeadphoneDevice(phonesId);     // null or '' = the default routing
const phones = engine.headphonesAvailable;
const recorder = new MediaRecorder(engine.getRecordingStream());   // created on first call
```

New: the `cueOutput` option sends the headphone bus to any node, for example
a `MediaStreamAudioDestinationNode` played by an `<audio>` element with
`setSinkId()` (see the
[README](../README.md#cue-routing-to-a-second-output)).

### Display values

Before:

```js
const base = deck.tempo / (1 + (deck._pllCorr || 0));
const bpm = deck.bpm * base;
const beat = (engine._localPeriod(deck) || 60 / deck.bpm) / base;
```

After:

```js
const base = deck.baseTempo;
const bpm = deck.effectiveBpm;
const beat = deck.beatDuration;          // real seconds per beat, from the local grid
```

The same applies to the master: `engine.masterBpm` and `engine.masterDeck`.

### Insert and VST

Before (`vst.js`):

```js
deck.setInsert(slot.node, slot.latency);   // VstHost: native host, worker, SharedArrayBuffer ring
deck.setInsert(null, 0);
```

After:

```js
deck.setInsert(node, latencySeconds);      // any AudioNode or AudioWorkletNode, fixed latency in seconds
deck.setInsert(null);
```

The hook is the same; the VST host (the native process, the worker, the
SharedArrayBuffer ring and the plugin UI) stays in the app.

### Worklet and logging

Before: `src/js/pitch-worklet.js`, registered as `'pitch-shift'` and loaded
with `new URL('./pitch-worklet.js', import.meta.url)`; diagnostics printed as
`[midi] …` with `console.log`.

After: `worklets/pitch-processor.js`, registered as `'openmix-pitch-shift'`
(`PITCH_PROCESSOR_NAME`). The engine loads it at most once per context, and the
registration is guarded. Diagnostics go to an optional `log` callback, and the
state is exposed:

```js
const engine = await createEngine({
  workletUrl: '/static/pitch-processor.js',            // only when the default URL cannot work
  log: (message) => console.debug('[web-engine]', message)
});
console.log(engine.pitchEngine, engine.pitchEngineError, engine.headphonesAvailable);
```

## Intentional differences

These are the intentional behavior differences from the OpenMix app engine
([DESIGN.md](../DESIGN.md) §9), with what they mean for your code:

1. **Audio clock.** Grace periods and end-of-track timing use the audio clock
   (`context.currentTime`) instead of `performance.now()`. They are
   deterministic offline, and they freeze while the context is suspended.
2. **`setMaster(i)` sets the master; it no longer toggles.** Use
   `setMaster(null)` for automatic, and
   `setMaster(engine.manualMasterIndex === i ? null : i)` for the old toggle.
3. **Per-engine grid offset, per-call palette.** `engine.setGridOffset()`
   replaces `setGlobalGridOffset()`, and the waveform palette is the `palette`
   option of `drawZoom()` and `drawOverview()`.
4. **Configurable counts.** Deck, FX-unit and hot-cue counts are options. The
   OpenMix values (4/4/8) remain the defaults.
5. **New crossfader side `'thru'`.**
6. **Worklet renamed.** The file is `worklets/pitch-processor.js` and the
   processor `'openmix-pitch-shift'`. Registration is guarded, and the module is
   loaded once per context.
7. **Lazy recording stream.** It is created by the first
   `getRecordingStream()` call, which throws on offline contexts.
8. **No logging by default.** Pass `log` to see the diagnostics.
9. **Tempo and SYNC.** `deck.setTempo()` on a synced follower leaves SYNC (the
   app did this in its UI handler). `deck.effectiveBpm` excludes the sync
   servo's micro-correction (the app removed it at display time).
10. **Kill on any EQ band** (`setKill(band, on)`), where the app only had a bass
    kill.
11. **Analysis renames.** `analyzeBpm` takes `{ minBpm, maxBpm }` (was
    `{ lo, hi }`), and the result field `q` is renamed `deviationMs`.
    `analyzeKey` adds `name` and `camelot`.
12. **New:** the `limiter` option, `destroy()`, events, `renderOffline()`,
    `loadFrom()`, `analyzeTrack()` and `eject()`.
13. **Echo repeats on the beat.** In Chromium, each trip around a `DelayNode`
    feedback loop is one render quantum late (+128 frames, 2.67 ms at 48 kHz),
    so the app's echo repeats drifted off the beat, repeat after repeat. The
    engine measures that latency once per sample rate (inside `engine.ready`)
    and compensates it in the echo-type beat FX; the ping-pong's feedback cycle
    now holds a single delay. Nothing to change in your code: the echoes just
    stay in time.
14. **Auto-tick survives frameless windows.** An Electron window that is not
    shown, minimized or occluded with `backgroundThrottling: false` reports
    `visible` but gets no `requestAnimationFrame`: the app's frame loop, and
    its sync lock, stopped there. Auto-tick switches to a timer after 100 ms
    without a frame, until the first frame comes back. That timer keeps one
    tick every 20 ms on average (late timers are caught up), so it holds 50
    ticks per second even on Windows' default 15.6 ms system timer, where a
    plain 20 ms timeout gives 31. If you keep your own
    `requestAnimationFrame` loop with `autoTick: false`, give it the same
    fallback.
15. **No autoplay warnings at creation.** An engine created before the first
    user gesture starts its permanent sources (FX modulations, color-FX
    noise) on the context's first `running` state, so Chrome no longer logs
    "The AudioContext was not allowed to start" for each of them.

## What stays in the app

The package is the engine only. These stay in your app:

- the track library and database, and the persistence of hot cues, grids and
  BPMs (listen to `'hotcue'`, `'loop'` and `'grid'`);
- MIDI and HID mapping, controller LEDs, and gamepads;
- hardware conventions such as "IN halves and OUT doubles during a loop", tempo
  ranges and BPM step sizes;
- status messages and translations: methods return values and emit events
  instead;
- settings storage (for example the snap-on-release preference: pass
  `scrubEnd({ snap })`);
- the VST host (it plugs in through `deck.setInsert()`), the sampler, the
  recording UI, and stem separation (pass the stems to `deck.loadStems()`).

## Checklist

- [ ] Replace `new AudioEngine()` with `await createEngine()`, and
      `engine.ctx` with `engine.context`.
- [ ] Remove the `syncLock()` call and the FX `setBeatDur()` code from your
      frame loop (or call `engine.tick()` if you turn auto-tick off).
- [ ] Replace every write to a deck or engine internal (`_syncBase`,
      `_padDryHold`, `_padRoll`, `_loopBeats`, `_loopInPoint`, `synced`,
      `jogHold`, `masterIdx`) with the matching method.
- [ ] Replace `onEnded` and the library calls after edits with events.
- [ ] Make your MASTER button call `setMaster(i)` or `setMaster(null)`
      explicitly.
- [ ] Rename the analysis calls and their options (`minBpm`, `maxBpm`,
      `deviationMs`).
- [ ] Move the waveform palette into the `drawZoom()` / `drawOverview()`
      options.
- [ ] Pass `workletUrl` if your build cannot resolve the default worklet URL.
