// SPDX-License-Identifier: MIT
// Copyright (c) 2026 blackmagic42 (OpenMix) and contributors
// @openmix/web-engine — the Web Audio DJ engine of OpenMix
// https://github.com/blackmagic42/openmix

// Types of '@openmix/web-engine/analysis' (DESIGN §5.8). Analysis only: no engine, no DOM.

import type { Peaks } from './waveform.js';

/** BPM search range. */
export interface AnalyzeBpmOptions {
  /** Lowest base BPM. Default 85. */
  minBpm?: number;
  /** Highest base BPM. Default 170. The octave ceiling is max(maxBpm × 1.06, 180). */
  maxBpm?: number;
}

/** Result of analyzeBpm. */
export interface BpmResult {
  /** BPM, 3 decimals; integer-locked on rigid grids (e.g. 128.00). */
  bpm: number;
  /** First beat (s). */
  beatOffset: number;
  /** Every beat (s); null when there are 8 beats or fewer. */
  beats: number[] | null;
  /** Index of a downbeat starting a phrase. */
  barAnchor: number;
  /** Constant-tempo (DAW) grid detected. */
  rigid: boolean;
  /** Median phase deviation per chunk (ms); large = variable tempo. (OpenMix: `q`.) */
  deviationMs: number;
}

/**
 * BPM and beat-grid analysis (ex detectBPM): bass onsets at 8 kHz, dual-score
 * sweep, rigid grid or beat-by-beat tracking, downbeat and phrase detection.
 * @returns null for tracks shorter than 5 s or without beats
 */
export function analyzeBpm(buffer: AudioBuffer, options?: AnalyzeBpmOptions): Promise<BpmResult | null>;

/** Result of analyzeKey. */
export interface KeyResult {
  /** Key code: 0–11 = C…B major, 12–23 = Cm…Bm minor. */
  code: number;
  /** 'C', 'F#', 'Am'… */
  name: string;
  /** Camelot label, e.g. '8A'. */
  camelot: string;
  /** Score gap to the second-best key. */
  confidence: number;
  /** Correlation score of the key. */
  score: number;
  /** Tuning offset in semitones: -1/3, 0 or +1/3. */
  tuning: number;
}

/** Key detection (ex detectKey): up to 15 minutes, chroma + KeyFinder profiles. */
export function analyzeKey(buffer: AudioBuffer): Promise<KeyResult | null>;

/** Result of keyFromMono. */
export interface MonoKeyResult {
  code: number;
  confidence: number;
  score: number;
  tuning: number;
}

/**
 * Key of a mono signal sampled at 8 kHz.
 * @param sampleRate must be 8000 (the promise rejects otherwise)
 * @param yieldEvery yield to the event loop every N frames (default 0 = never)
 */
export function keyFromMono(samples: Float32Array, sampleRate?: number, yieldEvery?: number): Promise<MonoKeyResult | null>;

/** Result of keyFromChroma. */
export interface ChromaKeyResult {
  code: number;
  confidence: number;
  score: number;
}

/** Key from a 12-bin chroma (index 0 = C). */
export function keyFromChroma(chroma: ArrayLike<number>): ChromaKeyResult;

/** A Camelot wheel position. */
export interface CamelotPosition {
  /** 1..12 */
  num: number;
  /** 'A' = minor, 'B' = major. */
  letter: 'A' | 'B';
}

/** Camelot position of a key code (C major = 8B, A minor = 8A); null for null. */
export function camelot(code: number | null): CamelotPosition | null;

/** Camelot label ('8A'); '' for null. */
export function camelotLabel(code: number | null): string;

/** Musical name ('C', 'F#', 'Am'); '' for null. */
export function keyName(code: number | null): string;

/** Transposes a key code (wraps around, keeps the mode). */
export function shiftKey(code: number, semitones: number): number;

/** Harmonic distance: 0 same, 1 neighbor/relative, 2 energy, 3 clash; null if a code is null. */
export function keyDistance(a: number, b: number): 0 | 1 | 2 | 3 | null;

/** What heardKey reads (a Deck satisfies it). */
export interface HeardKeySource {
  musicKey: number | null;
  /** Semitones. Default 0. */
  keyShift?: number;
  keylock?: boolean;
  /** Tempo ratio; without keylock, speeding up pitches up. */
  tempo?: number;
}

/** The key as heard. */
export interface HeardKey {
  code: number;
  /** Deviation from the in-tune note, ±50. */
  cents: number;
}

/** The key a deck is heard in: track key + key shift + tempo effect when keylock is off. */
export function heardKey(deck: HeardKeySource): HeardKey | null;

/** Result of alignImportedGrid. */
export interface ImportedGridAlignment {
  /** The shifted beats (or the input when no shift applies). */
  beats: number[];
  /** Shift applied (s); 0 under 4 ms or beyond 80 ms. */
  shift: number;
}

/**
 * Re-aligns a grid imported from other software onto this decoder's timeline
 * (median offset to the real transients, typically ~51 ms for LAME MP3s).
 */
export function alignImportedGrid(buffer: AudioBuffer, beats: number[]): ImportedGridAlignment;

/** Options of analyzeTrack (and loadFrom's `analyze`). */
export interface AnalyzeOptions extends AnalyzeBpmOptions {
  /** Analyze the BPM and grid. Default true. */
  bpm?: boolean;
  /** Detect the key. Default true. */
  key?: boolean;
  /** Compute the waveform peaks. Default true. */
  peaks?: boolean;
  /** Peak slices per second. Default 400. */
  peaksPerSecond?: number;
  /** Fine zoom envelope. Default true. */
  fine?: boolean;
}

/** Result of analyzeTrack: a part that fails (or is turned off) is null. */
export interface TrackAnalysis {
  bpm: number | null;
  beats: number[] | null;
  beatOffset: number | null;
  barAnchor: number;
  rigid: boolean;
  musicKey: number | null;
  keyConfidence: number | null;
  peaks: Peaks | null;
}

/** Runs the BPM, key and peaks analyses. Never rejects for an analysis failure. */
export function analyzeTrack(buffer: AudioBuffer, options?: AnalyzeOptions): Promise<TrackAnalysis>;
