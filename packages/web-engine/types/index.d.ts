// SPDX-License-Identifier: MIT
// Copyright (c) 2026 blackmagic42 (OpenMix) and contributors
// @openmix/web-engine — the Web Audio DJ engine of OpenMix
// https://github.com/blackmagic42/openmix

// Types of '@openmix/web-engine' (DESIGN §5). Re-exports the analysis and
// waveform entries.

export * from './analysis.js';
export * from './waveform.js';

import type { Peaks } from './waveform.js';
import type { AnalyzeOptions, TrackAnalysis, HeardKey } from './analysis.js';

// ------------------------------------------------------------- constants ---

/** Package version ('0.1.0'); equals package.json "version". */
export const VERSION: string;
/** Lowest tempo ratio (−50 %). */
export const TEMPO_MIN: 0.5;
/** Highest tempo ratio (+60 %). */
export const TEMPO_MAX: 1.6;
/** Lowest key shift (semitones). */
export const KEY_SHIFT_MIN: -7;
/** Highest key shift (semitones). */
export const KEY_SHIFT_MAX: 7;
/** Seconds of allowed negative position (pre-roll: silence before the track). */
export const PRE_ROLL: 3600;
/** Fixed latency of the WSOLA keylock worklet, in samples (≈ 55.1 ms at 48 kHz); equals the worklet's LAT. */
export const WSOLA_LATENCY_SAMPLES: 2647;
/** Name of the AudioWorkletProcessor registered by worklets/pitch-processor.js. */
export const PITCH_PROCESSOR_NAME: 'openmix-pitch-shift';
/** Hot-cue colors, cycled: ['#ff3b30','#ff9500','#ffcc00','#34c759','#5ac8fa','#3b82f7','#af52de','#ff2d55']. */
export const HOT_CUE_COLORS: readonly string[];
/** Typical beat multiples of the FX units: [0.25, 0.5, 0.75, 1, 2, 4, 8, 16, 32]. */
export const FX_BEATS: readonly number[];

/** Beat-FX types. */
export type FxType = 'delay' | 'echo' | 'spiral' | 'mtdelay' | 'upecho' | 'downecho' | 'lowcut' | 'pingpong'
  | 'reverb' | 'flanger' | 'phaser' | 'pan' | 'trans' | 'filter' | 'roll' | 'robot' | 'helix' | 'crush';
/** Modes of the channel FILTER knobs (color FX). */
export type ColorFxType = 'filter' | 'dubecho' | 'hpfecho' | 'lpfecho' | 'bpfecho' | 'crushecho' | 'reverb' | 'noise' | 'crush';
/** Crossfader side of a deck; 'thru' ignores the crossfader. */
export type CrossfaderSide = 'A' | 'B' | 'thru';
/** EQ band. */
export type EqBand = 'low' | 'mid' | 'high';
/** Stem name; bass + other is the instrumental. */
export type StemName = 'vocals' | 'drums' | 'bass' | 'other';
/** Turntable effect ('vbrake' is also accepted as an alias of 'brake'). */
export type SpinKind = 'brake' | 'backspin';

/** The 18 beat-FX types, in the OpenMix menu order (ids are the API, labels are UI suggestions). */
export const FX_TYPES: readonly { readonly id: FxType; readonly label: string }[];
/** The 9 color-FX modes ('reverb' is labeled 'Space'). */
export const COLOR_FX_TYPES: readonly { readonly id: ColorFxType; readonly label: string }[];
/** Share of the dry removed at full level: { trans:1, filter:1, crush:1, robot:1, pan:1, roll:0, flanger:0.5, phaser:0.5, reverb:0.3 }. */
export const FX_DRY_CUT: Readonly<Partial<Record<FxType, number>>>;
/** FX_DRY_CUT[type] ?? 0.45 */
export function fxDryCut(type: FxType): number;
/** Deck dry level while a pad FX is held: { roll:0, filter:0, trans:0, echo:0.2, mtdelay:0.25, reverb:0.45, flanger:1 } (default 1). */
export const PAD_FX_DRY: Readonly<Partial<Record<FxType, number>>>;

/** A momentary pad FX (deck.setPadFx). */
export interface PadFxPreset {
  type: FxType;
  /** Beat multiple, > 0. */
  beats: number;
  /** 0..1. Default 1. (The roll pad always plays its loop at full mix.) */
  level?: number;
  /** Deck dry level while held, 0..1. Default PAD_FX_DRY[type] ?? 1. */
  dry?: number;
  label?: string;
}

/** A spin entry of the pad bank (use deck.spinStart / spinEnd). */
export interface SpinPadPreset {
  label: string;
  spin: SpinKind;
}

/** The OpenMix pad bank (10 entries; every entry has a `label`). */
export const DEFAULT_PAD_FX: readonly (Readonly<PadFxPreset & { label: string }> | Readonly<SpinPadPreset>)[];

// ------------------------------------------------------------------ grid ---

/** What the grid helpers read (a Deck satisfies it). */
export interface GridLike {
  bpm?: number | null;
  /** Beat list (file s); helpers need at least 2 beats. */
  beats?: readonly number[] | null;
  /** First beat of a fixed grid. */
  beatOffset?: number | null;
  /** Index of a beat that starts a bar. */
  barAnchor?: number;
  /** Per-deck offset of a beat list (s). */
  gridShift?: number;
  /** Engine-wide offset of beat lists (s). */
  globalGridOffset?: number;
}

/** Fractional beat index at `time` on a beat list (uses time − (gridShift + globalGridOffset)); null without a beat list. */
export function gridIndexFracAt(grid: GridLike, time: number): number | null;
/** Inverse of gridIndexFracAt; extrapolates at both ends with the edge periods; null without a beat list. */
export function gridTimeAtIndex(grid: GridLike, index: number): number | null;
/** Local beat period (s) at `time`; null without a beat list. */
export function gridPeriodAt(grid: GridLike, time: number): number | null;
/** Same phase within the bar of `toTime` as at `fromTime` ("bar-intact" jump); `toTime` without a grid. */
export function barAlignedSeekTime(grid: GridLike, fromTime: number, toTime: number): number;
/**
 * Nearest 1/division beat, never below 0; `time` unchanged without a grid.
 * @param division default 1 (whole beats); 4 = quarter beats
 */
export function snapToBeat(grid: GridLike, time: number, division?: number): number;

// ---------------------------------------------------------------- engine ---

/** Anything engine.decode() / deck.loadFrom() accept. */
export type AudioSource = string | URL | Blob | ArrayBuffer | AudioBuffer;

/** Options of createEngine / new Engine. */
export interface EngineOptions {
  /**
   * AudioContext or OfflineAudioContext. Default: a new AudioContext(contextOptions).
   * The engine closes a context it created (destroy()); it never closes an injected one.
   * Throws Error('No AudioContext available; pass options.context') if none can be made.
   */
  context?: BaseAudioContext;
  /** Used only when `context` is omitted. Default { latencyHint: 'interactive' }. */
  contextOptions?: AudioContextOptions;
  /** Receives the master mix (stereo, post-limiter). Default: the destination, with the automatic 4-channel headphone layout when available. */
  output?: AudioNode;
  /** Receives the headphone (CUE) bus. Default: destination channels 3/4 when `output` is omitted and destination.maxChannelCount ≥ 4; otherwise unconnected. */
  cueOutput?: AudioNode;
  /** Number of decks, 1–8. Default 4. Crossfader sides default to A, B, A, B… RangeError otherwise. */
  decks?: number;
  /** Number of beat-FX units, 0–8. Default: same as `decks`. Unit u starts assigned to deck u, disabled, at level 0. */
  fxUnits?: number;
  /** Hot-cue slots per deck, 1–16. Default 8. */
  hotCues?: number;
  /** Load the WSOLA keylock worklet. Default true. false = two-tap fallback shifter only. */
  keylock?: boolean;
  /** URL of worklets/pitch-processor.js. Default: new URL('../worklets/pitch-processor.js', import.meta.url). */
  workletUrl?: string | URL;
  /** Call tick() automatically. Default: true for a realtime context when requestAnimationFrame exists; false offline. */
  autoTick?: boolean;
  /** Safety limiter on the master (threshold −3 dB, ratio 12). Default true. false = a unity gain node instead. */
  limiter?: boolean;
  /** Diagnostics (worklet fallback reason, output layout). Default: no-op. */
  log?: (message: string) => void;
  /** Receives exceptions thrown by event listeners and by auto-tick. Default: console.error. */
  onError?: (error: unknown) => void;
}

/** Loop state (a fresh object per read). */
export interface LoopState {
  active: boolean;
  /** Loop start (file s); kept after exitLoop() for reloop(). */
  start: number;
  /** Loop end (file s). */
  end: number;
  /** Length measured on the grid, rounded to 1/32 beat; null without a grid. */
  beats: number | null;
  /** Loop IN point waiting for an OUT (loopIn), or null. */
  inPoint: number | null;
}

/** Grid fields (load meta, setGrid). */
export interface GridData {
  bpm?: number | null;
  /** Beat list (file s); needs more than 2 entries. Without `bpm`, the BPM is the median interval. */
  beats?: number[] | null;
  beatOffset?: number | null;
  barAnchor?: number;
  gridShift?: number;
}

/** deck.load() metadata. */
export interface LoadMeta extends GridData {
  /** Extra entries beyond the slot count are ignored. */
  hotCues?: (number | null)[];
  /** Default 0. */
  cuePoint?: number;
  peaks?: Peaks | null;
  /** Key code 0..23. */
  musicKey?: number | null;
  /** Opaque caller metadata. */
  track?: unknown;
}

/** deck.loadFrom() options. */
export interface LoadFromOptions extends LoadMeta {
  /** Default true: analyze what the options do not provide. false: analyze nothing. */
  analyze?: boolean | AnalyzeOptions;
  /** Aborting rejects the call with an AbortError, without touching the deck. */
  signal?: AbortSignal;
}

/** The values applied to the deck by loadFrom(). */
export interface LoadResult extends TrackAnalysis {
  buffer: AudioBuffer;
}

/** Result of deck.sync(). */
export type SyncResult = 'synced' | 'armed' | 'master' | null;

/** Deck events. */
export interface DeckEventMap {
  load: { deck: Deck; index: number; track: unknown; duration: number };
  eject: { deck: Deck; index: number };
  play: { deck: Deck; index: number; position: number };
  pause: { deck: Deck; index: number; position: number };
  /** Natural end of the track (a 'pause' precedes it). */
  ended: { deck: Deck; index: number };
  /** Any loop change. */
  loop: { deck: Deck; index: number } & LoopState;
  hotcue: { deck: Deck; index: number; slot: number; time: number | null };
  cuepoint: { deck: Deck; index: number; time: number };
  /** The synced flag flipped. */
  sync: { deck: Deck; index: number; synced: boolean };
  grid: {
    deck: Deck; index: number; bpm: number | null; beats: readonly number[] | null;
    beatOffset: number | null; barAnchor: number; gridShift: number;
  };
}

/** Engine events. */
export interface EngineEventMap {
  /** At the end of each tick(); `time` is the context time. */
  tick: { engine: Engine; time: number };
  /** The effective master changed (from tick() or setMaster()). */
  master: { engine: Engine; index: number | null; deck: Deck | null; manual: boolean };
  /** Proxies the context's 'statechange'. */
  statechange: { engine: Engine; state: AudioContextState };
}

/** A beat-FX unit (engine.fx[u], engine.masterFx, pad FX). Created by the engine only. */
export class FxUnit {
  private constructor();
  /** Default 'echo'. */
  readonly type: FxType;
  /** Default false. */
  readonly enabled: boolean;
  /** Wet level and intensity, 0..1. Default 0 (units always start at the minimum). */
  readonly level: number;
  /** Beat multiple. Default 0.5 (typical values: FX_BEATS). */
  readonly beats: number;
  /** Seconds per beat currently followed. Default 0.5. */
  readonly beatDuration: number;
  /** RangeError on unknown types. */
  setType(type: FxType): void;
  /** The engine updates the deck sends automatically. */
  setEnabled(on: boolean): void;
  /** 0..1 (clamped); also drives feedback / depth inside the effect. */
  setLevel(v: number): void;
  /** > 0 (other values are ignored). */
  setBeats(beats: number): void;
  /** Manual beat duration (s, > 0); tick() overrides it while a reference deck plays. */
  setBeatDuration(seconds: number): void;
}

/** One player. Created by the engine only (engine.decks). */
export class Deck {
  private constructor();

  // ---- identity / track ----
  readonly index: number;
  readonly engine: Engine;
  readonly buffer: AudioBuffer | null;
  /** Caller metadata, from load(…, { track }). */
  readonly track: unknown;
  readonly peaks: Peaks | null;
  readonly loaded: boolean;
  /** Seconds; 0 when empty. */
  readonly duration: number;

  // ---- transport / timing ----
  readonly playing: boolean;
  /** HEARD position (file s); negative during pre-roll. */
  readonly position: number;
  /** = position, except during a spin FX (the virtual position). */
  readonly displayPosition: number;
  /** Instantaneous playback rate (includes the sync micro-corrections). */
  readonly tempo: number;
  /** Tempo without the sync servo correction (display this). */
  readonly baseTempo: number;
  /** Processing latency compensated by read-ahead (s): WSOLA (2647 samples) + insert. */
  readonly latency: number;

  // ---- grid ----
  readonly bpm: number | null;
  /** bpm × baseTempo. */
  readonly effectiveBpm: number | null;
  /** Real seconds per beat now (local grid period / baseTempo). */
  readonly beatDuration: number | null;
  /** Beat-list grid (file s), or null (fixed grid). */
  readonly beats: readonly number[] | null;
  /** First beat of a fixed grid. */
  readonly beatOffset: number | null;
  /** Index of a beat that starts a bar. */
  readonly barAnchor: number;
  /** Manual offset of a beat-list grid (s). */
  readonly gridShift: number;
  /** = engine.gridOffset. */
  readonly globalGridOffset: number;

  // ---- sync / key ----
  readonly synced: boolean;
  /** engine.masterIndex === index. */
  readonly isMaster: boolean;
  readonly keylock: boolean;
  /** Semitones, integer −7..+7. */
  readonly keyShift: number;
  /** Detected key code 0..23, or null. */
  readonly musicKey: number | null;
  readonly heardKey: HeardKey | null;

  // ---- cues / loops ----
  readonly cuePoint: number;
  /** Length = options.hotCues. */
  readonly hotCues: readonly (number | null)[];
  /** A fresh object per read. */
  readonly loop: LoopState;
  /** Snap hot cues (nearest beat), beat-loop starts (nearest ¼ beat) and loop IN/OUT (nearest beat). Default true. */
  quantize: boolean;

  // ---- channel strip ----
  /** Channel fader 0..1 (gain v²). Default 0.85. */
  readonly volume: number;
  /** −1..1 (gain 4^v: −12…+12 dB). */
  readonly trimValue: number;
  /** −1..1 each (−1 = −40 dB kill, +1 = +6 dB). */
  readonly eq: Readonly<{ low: number; mid: number; high: number }>;
  readonly kills: Readonly<{ low: boolean; mid: boolean; high: boolean }>;
  /** The FILTER knob, −1..1. */
  readonly filterValue: number;
  /** PFL. */
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
  /** Stops playback; resets position, cue point, loop, tempo, key shift, stems and sync calibration (SYNC and keylock stay). Emits 'load'. TypeError if `buffer` is not an AudioBuffer. */
  load(buffer: AudioBuffer, meta?: LoadMeta): void;
  /** engine.resume() (synchronously), decode, analyze what `options` lacks, then load(). AbortError when superseded or aborted. */
  loadFrom(source: AudioSource, options?: LoadFromOptions): Promise<LoadResult>;
  /** Clears everything track-related. Emits 'eject'. */
  eject(): void;
  setPeaks(peaks: Peaks | null): void;
  /** 0..23 or null (RangeError otherwise). */
  setMusicKey(code: number | null): void;

  // ---- grid editing ----
  /** Replaces the given fields; a bpm without beats makes a fixed grid (beatOffset defaults to 0). Leaves SYNC if the BPM or beats changed. Emits 'grid'. */
  setGrid(grid: GridData): void;
  /** ×2 / ÷2 (new BPM within 40–320). Leaves SYNC. Emits 'grid'. RangeError for another factor. */
  scaleGrid(factor: 2 | 0.5): boolean;
  /** Beat list: gridShift += s; fixed grid: beatOffset = max(0, beatOffset + s). Emits 'grid'. */
  shiftGrid(seconds: number): void;
  /** The beat nearest to `time` (default: position) becomes a bar start placed exactly there. Emits 'grid'. */
  setDownbeat(time?: number): boolean;

  // ---- transport ----
  /** Scheduled 30 ms ahead, sample-accurate; restarts at 0 from the end; calls engine.resume(); a synced non-master deck is aligned to the master. Emits 'play'. */
  play(): void;
  /** Keeps the heard position, stops any roll, cuts the transposer's reserve. Emits 'pause'. */
  pause(): void;
  togglePlay(): void;
  /** Clamped to [−PRE_ROLL, duration]; leaving the active loop disables it. */
  seek(time: number): void;
  /** Alias of `position`. */
  currentTime(): number;

  // ---- cue ----
  /** CDJ cue: playing → back to the cue point + pause; paused at it (20 ms) → re-seek; elsewhere → set it here. */
  cue(): void;
  /** Hold-to-preview CUE (press); calls engine.resume(). */
  cueDown(): void;
  /** Hold-to-preview CUE (release): back to the cue point and pause. */
  cueUp(): void;
  /** Default: the position. Emits 'cuepoint'. */
  setCuePoint(time?: number): void;

  // ---- hot cues (RangeError for an out-of-range slot) ----
  /** Without `time`: the position, snapped to the nearest beat when quantize is on. Emits 'hotcue'. */
  setHotCue(slot: number, time?: number): boolean;
  /** Emits 'hotcue' with time null. */
  clearHotCue(slot: number): void;
  /** Pad press: sets the slot if empty, otherwise jumps there (play state unchanged). */
  hotCue(slot: number): boolean;

  // ---- loops & jumps ----
  /** Native loop, at least 10 ms, clamped to the track. Emits 'loop'. */
  setLoop(start: number, end: number): boolean;
  exitLoop(): void;
  /** Re-activates the last loop without jumping. */
  reloop(): boolean;
  /** Needs a BPM; resizes an active loop, else starts one (nearest ¼ beat with quantize). */
  beatLoop(beats: number): boolean;
  /** Stores the IN point (nearest beat with quantize). */
  loopIn(): boolean;
  /** Needs an IN point and an OUT > IN + 50 ms; activates the loop. */
  loopOut(): boolean;
  /** Active loop only; the half must be ≥ ⅛ beat (50 ms without a BPM). */
  loopHalve(): boolean;
  /** Active loop only; the new end must stay inside the track. */
  loopDouble(): boolean;
  /** ±beats on the grid; an active loop moves too. False without a BPM. */
  beatJump(beats: number): boolean;

  // ---- tempo & sync ----
  /** Clamped to [TEMPO_MIN, TEMPO_MAX]; a synced follower leaves SYNC; on the master, the followers follow. */
  setTempo(ratio: number): void;
  /** setTempo(bpm / deck.bpm); false without a BPM. */
  setBpm(bpm: number): boolean;
  sync(): SyncResult;
  unsync(): void;
  /** Pitch bend: rate = base × (1 + amount), amount clamped to ±0.5; holds the phase lock. False when not playing. */
  nudge(amount: number): boolean;
  /** Restores the base tempo; reanchors every deck when no deck holds any more. */
  endNudge(): void;
  /** Discreet magnet. Default maxBeats 0.06. */
  snapToReference(maxBeats?: number): boolean;

  // ---- key ----
  setKeylock(on: boolean): void;
  /** Rounded and clamped to ±7. */
  setKey(semitones: number): void;

  // ---- channel strip (RangeError for an unknown band / side) ----
  setVolume(v: number): void;
  setTrim(v: number): void;
  setEq(band: EqBand, v: number): void;
  setKill(band: EqBand, on: boolean): void;
  /** The FILTER knob; follows the engine's color-FX mode. */
  setFilter(v: number): void;
  /** PFL (pre-fader, post EQ / filter / insert). */
  setHeadphoneCue(on: boolean): void;
  setCrossfaderSide(side: CrossfaderSide): void;

  // ---- performance ----
  /** Slip roll of the current grid slice; needs a playing deck with a grid. Default mix 1. */
  startRoll(beats: number, mix?: number): boolean;
  /** 0 = track only, 1 = loop only. */
  setRollMix(mix: number): void;
  stopRoll(): void;
  /** Momentary FX on this deck; null turns it off. RangeError for an unknown type or beats ≤ 0. */
  setPadFx(preset: PadFxPreset | null): void;
  /** Brake / backspin sound; the track virtually keeps running. RangeError for another kind. */
  spinStart(kind: SpinKind | 'vbrake'): boolean;
  spinEnd(): void;
  /** Pauses and remembers the play state. Default audible true. */
  scrubStart(options?: { audible?: boolean }): void;
  scrubMove(time: number): void;
  /** Defaults: resume true, snap true. Always reanchors the sync. */
  scrubEnd(options?: { resume?: boolean; snap?: boolean }): void;

  // ---- stems & insert ----
  /** Buffers on the track's timeline; RangeError for an unknown stem name. No-op without a track. */
  loadStems(stems: Partial<Record<StemName, AudioBuffer>>): void;
  clearStems(): void;
  setStem(name: StemName, on: boolean): void;
  /** @returns the new state */
  toggleStem(name: StemName): boolean;
  /** Generic insert between the FILTER and the fader / cue / meter taps; its latency (s, default 0) is compensated. */
  setInsert(node: AudioNode | null, latency?: number): void;

  // ---- meter ----
  /** Instantaneous peak, 0..~2, post EQ / filter / insert, pre-fader. */
  meterPeak(): number;

  // ---- events ----
  on<K extends keyof DeckEventMap>(type: K, listener: (detail: DeckEventMap[K]) => void): () => void;
  once<K extends keyof DeckEventMap>(type: K, listener: (detail: DeckEventMap[K]) => void): () => void;
  off<K extends keyof DeckEventMap>(type: K, listener: (detail: DeckEventMap[K]) => void): void;
}

/** The engine. `new Engine(options)` builds the graph synchronously; see createEngine. */
export class Engine {
  constructor(options?: EngineOptions);

  // ---- state ----
  /**
   * Resolves once the worklet attempt and the one-off FX feedback-latency
   * measurement have finished. Never rejects. (It waits for the measurement
   * 2 s at most; a later result is applied when it arrives.)
   */
  readonly ready: Promise<void>;
  readonly context: BaseAudioContext;
  /** The context is an OfflineAudioContext. */
  readonly isOffline: boolean;
  readonly decks: readonly Deck[];
  /** Beat-FX units. */
  readonly fx: readonly FxUnit[];
  /** null until ensureMasterFx(). */
  readonly masterFx: FxUnit | null;
  /** fxAssign[unit][deck] (a copy). */
  readonly fxAssign: readonly (readonly boolean[])[];
  /** 0..1. Default 0.5. */
  readonly crossfader: number;
  /** 0..1. Default 0.9. */
  readonly masterVolume: number;
  /** −1..1. Default 0. */
  readonly masterFilter: number;
  /** 0..1. Default 1. */
  readonly headphoneVolume: number;
  /** Default 'filter'. */
  readonly colorFx: ColorFxType;
  /** Default true. */
  readonly colorFxEnabled: boolean;
  /** Effective master: manual if set, else automatic. */
  readonly masterIndex: number | null;
  readonly manualMasterIndex: number | null;
  readonly masterDeck: Deck | null;
  /** masterDeck.effectiveBpm. */
  readonly masterBpm: number | null;
  /** Phase lock suspended (nudge in progress / setSyncHold). */
  readonly syncHold: boolean;
  /** Seconds. Default 0. */
  readonly gridOffset: number;
  readonly pitchEngine: 'loading' | 'wsola' | 'fallback';
  readonly pitchEngineError: Error | null;
  /** The cue bus currently reaches an output. */
  readonly headphonesAvailable: boolean;
  /** Final master node (post-limiter): connect extra taps here. */
  readonly masterOut: AudioNode;
  /** The headphone bus node. */
  readonly cueOut: AudioNode;

  // ---- lifecycle ----
  /** Resumes a realtime context (call it in a user gesture); no-op offline. Never rejects. */
  resume(): Promise<void>;
  /** One control step; call it every frame (30–144 Hz) or let auto-tick do it. */
  tick(): void;
  /**
   * Calls tick() from requestAnimationFrame while the page is visible, from a
   * timer while it is hidden, and from that timer too when a visible page gets
   * no frames for 100 ms (e.g. an Electron window not shown or minimized),
   * until a frame comes back. The timer keeps one tick every 20 ms on average
   * (50 per second, also on Windows' coarse 15.6 ms system timer), but
   * browsers may throttle it.
   */
  startAutoTick(): void;
  stopAutoTick(): void;
  /** Stops everything; closes the engine's own context, never an injected one. */
  destroy(): Promise<void>;

  // ---- loading ----
  /** Fetches / reads / decodes; an ArrayBuffer is detached by decoding. */
  decode(source: AudioSource): Promise<AudioBuffer>;

  // ---- mixer ----
  setCrossfader(x: number): void;
  /** Also scales the FX returns. */
  setMasterVolume(v: number): void;
  /** < 0 low-pass, > 0 high-pass, dead zone |v| < 0.04. */
  setMasterFilter(v: number): void;
  setHeadphoneVolume(v: number): void;
  /** RangeError for an unknown type; re-applies the knobs. */
  setColorFx(type: ColorFxType): void;
  setColorFxEnabled(on: boolean): void;
  /** Instantaneous peak of the mix, pre-limiter (0..~2). */
  masterPeak(): number;

  // ---- master and sync ----
  /** SETS the manual master (null = automatic); not a toggle. RangeError for a bad index. */
  setMaster(index: number | null): void;
  /** Master deck tempo; synced followers follow in the same call. */
  setMasterTempo(ratio: number): boolean;
  /** Same, as an effective BPM; false without a master BPM. */
  setMasterBpm(bpm: number): boolean;
  /** Adopts the CURRENT alignment of the synced decks (all if omitted). */
  reanchorSync(index?: number): void;
  /** Suspends / resumes the phase correction globally (release = reanchorSync()). */
  setSyncHold(on: boolean): void;

  // ---- FX (RangeError for bad indices) ----
  /** `on` defaults to true; updates the sends. */
  assignFx(unit: number, deck: number, on?: boolean): void;
  isFxAssigned(unit: number, deck: number): boolean;
  /** FX unit on the whole mix, created on the first call. */
  ensureMasterFx(): FxUnit;

  // ---- outputs ----
  /** context.setSinkId + re-wiring; resolves false when unsupported, offline or failing. */
  setOutputDevice(deviceId: string): Promise<boolean>;
  /** Cue bus on another device (null / '' = default routing); resolves false when unsupported, offline or failing. */
  setHeadphoneDevice(deviceId: string | null): Promise<boolean>;
  /** The master as a MediaStream (lazy); TypeError offline. */
  getRecordingStream(): MediaStream;

  // ---- grid ----
  /** Global offset added to every beat-list grid (s). */
  setGridOffset(seconds: number): void;

  // ---- events ----
  on<K extends keyof EngineEventMap>(type: K, listener: (detail: EngineEventMap[K]) => void): () => void;
  once<K extends keyof EngineEventMap>(type: K, listener: (detail: EngineEventMap[K]) => void): () => void;
  off<K extends keyof EngineEventMap>(type: K, listener: (detail: EngineEventMap[K]) => void): void;
}

/** `const e = new Engine(options); await e.ready; return e;` */
export function createEngine(options?: EngineOptions): Promise<Engine>;

// --------------------------------------------------------------- offline ---

/** Options of renderOffline. */
export interface RenderOfflineOptions {
  /** Ticks per second of audio. Default 60. 0 = no ticks (needed without OfflineAudioContext.prototype.suspend). */
  tickRate?: number;
  /** Called (and awaited) after each engine.tick(), with the tick time. */
  onTick?: (time: number) => void | Promise<void>;
}

/**
 * Renders an engine built on an OfflineAudioContext that has not rendered yet
 * (TypeError otherwise), ticking at k / tickRate rounded up to render quanta.
 * @returns the result of startRendering()
 */
export function renderOffline(engine: Engine, options?: RenderOfflineOptions): Promise<AudioBuffer>;
