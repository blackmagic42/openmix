// SPDX-License-Identifier: MIT
// Copyright (c) 2026 blackmagic42 (OpenMix) and contributors
// @openmix/web-engine — the Web Audio DJ engine of OpenMix
// https://github.com/blackmagic42/openmix

// Types of '@openmix/web-engine/waveform' (DESIGN §5.9).

/** Waveform peaks of a track (computePeaks). */
export interface Peaks {
  /** Signed max per slice (per channel, never L+R averaged). */
  top: Float32Array;
  /** Signed min per slice. */
  bottom: Float32Array;
  /** Low-band peak per slice (below 200 Hz). */
  low: Float32Array;
  /** Mid-band peak per slice (around 630 Hz, 200 Hz – 2 kHz). */
  mid: Float32Array;
  /** High-band peak per slice (above 2 kHz). */
  high: Float32Array;
  /** Fine envelope, max per 0.25 ms (4000 points/s, scaled ×127). Empty when `fine: false`. */
  fineTop: Int8Array;
  /** Fine envelope, min per 0.25 ms (4000 points/s, scaled ×127). Empty when `fine: false`. */
  fineBottom: Int8Array;
  /** 4000, or 0 when computed with `fine: false`. */
  finePps: number;
  /** Slices per second (default 400). */
  perSecond: number;
  /** Track duration in seconds. */
  duration: number;
}

/** Options of computePeaks. */
export interface ComputePeaksOptions {
  /** Slices per second. Default 400. */
  perSecond?: number;
  /** Compute the fine zoom envelope (4000 points/s). Default true. */
  fine?: boolean;
}

/**
 * Computes the 3-band peaks of a track (renders the bands at 16 kHz with an
 * OfflineAudioContext). Slice bounds are exact in time: no drift along the track.
 */
export function computePeaks(buffer: AudioBuffer, options?: ComputePeaksOptions): Promise<Peaks>;

/** Waveform palettes. */
export type WavePalette = 'rgb' | 'mono' | 'blueorange' | 'neon' | 'club';

/** ['rgb', 'mono', 'blueorange', 'neon', 'club'] */
export const WAVE_PALETTES: readonly WavePalette[];

/** What the drawing functions read from a deck. A Deck satisfies it; plain objects work too. */
export interface DeckView {
  peaks: Peaks | null;
  /** Used for extreme zooms (raw samples). */
  buffer?: AudioBuffer | null;
  /** Position to draw: the first defined of displayPosition, position, currentTime(). */
  displayPosition?: number;
  position?: number;
  currentTime?(): number;
  cuePoint?: number | null;
  hotCues?: readonly (number | null)[];
  loop?: { active: boolean; start: number; end: number; inPoint?: number | null };
  bpm?: number | null;
  beats?: readonly number[] | null;
  beatOffset?: number | null;
  barAnchor?: number;
  gridShift?: number;
  globalGridOffset?: number;
}

/** Options of drawZoom. */
export interface DrawZoomOptions {
  /** Width of the window in seconds. Default 8. For equal beat widths across decks: `base × deck.baseTempo`. */
  windowSeconds?: number;
  /** Position to draw instead of the deck's. */
  time?: number;
  /** Default 'rgb'. RangeError for an unknown palette. */
  palette?: WavePalette;
}

/** Options of drawOverview. */
export interface DrawOverviewOptions {
  /** Position to draw instead of the deck's. */
  time?: number;
  /** Default 'rgb'. RangeError for an unknown palette. */
  palette?: WavePalette;
}

/**
 * Scrolling zoom view centered on the position (3-band colors, beat grid with
 * bar and phrase lines, loop band with IN/OUT flags, CUE marker, lettered hot
 * cues). The playhead line is NOT drawn: draw it at the horizontal center.
 * A zero-size or hidden canvas draws nothing and never throws.
 */
export function drawZoom(canvas: HTMLCanvasElement, deck: DeckView, options?: DrawZoomOptions): void;

/**
 * Whole-track overview (cached), the played part at full intensity, loop band,
 * hot cues and a white playhead. A zero-size or hidden canvas draws nothing.
 */
export function drawOverview(canvas: HTMLCanvasElement, deck: DeckView, options?: DrawOverviewOptions): void;

/**
 * Sizes the backing store to the CSS size × devicePixelRatio.
 * @returns true if the canvas was resized
 */
export function fitCanvas(canvas: HTMLCanvasElement): boolean;
