// SPDX-License-Identifier: MIT
// Copyright (c) 2026 blackmagic42 (OpenMix) and contributors
// @openmix/web-engine — the Web Audio DJ engine of OpenMix
// https://github.com/blackmagic42/openmix

// Numeric constants and shared tables (DESIGN §5.12).

/** Package version. Must equal the "version" field of package.json. */
export const VERSION = '0.1.0';

/** Lowest tempo ratio (−50 %). */
export const TEMPO_MIN = 0.5;
/** Highest tempo ratio (+60 %). */
export const TEMPO_MAX = 1.6;

/** Lowest key shift, in semitones. */
export const KEY_SHIFT_MIN = -7;
/** Highest key shift, in semitones. */
export const KEY_SHIFT_MAX = 7;

// A track can be positioned BEFORE its start (negative position):
// it stays silent until 0 then starts — handy for cueing it in late.
/** Seconds of allowed negative position (pre-roll). */
export const PRE_ROLL = 3600;

// Latency of the transposition engine (samples) — MUST equal LAT in
// worklets/pitch-processor.js (the worklet also announces it on startup)
/** Fixed latency of the WSOLA keylock worklet, in samples (≈ 55.1 ms at 48 kHz). */
export const WSOLA_LATENCY_SAMPLES = 2647;

/** Name under which worklets/pitch-processor.js registers its processor. */
export const PITCH_PROCESSOR_NAME = 'openmix-pitch-shift';

// Colors of the 8 hot cues (A-H), cycled beyond 8 slots
/** Hot-cue colors, cycled: slot i uses HOT_CUE_COLORS[i % 8]. */
export const HOT_CUE_COLORS = Object.freeze([
  '#ff3b30', '#ff9500', '#ffcc00', '#34c759', '#5ac8fa', '#3b82f7', '#af52de', '#ff2d55'
]);
