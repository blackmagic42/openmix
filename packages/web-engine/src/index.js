// SPDX-License-Identifier: MIT
// Copyright (c) 2026 blackmagic42 (OpenMix) and contributors
// @openmix/web-engine — the Web Audio DJ engine of OpenMix
// https://github.com/blackmagic42/openmix

// Entry '@openmix/web-engine': the whole public API (DESIGN §5.1).
// Named exports only; this list is exact.

export { createEngine, Engine } from './engine.js';
export { Deck } from './deck.js';
export {
  FxUnit,
  FX_TYPES, COLOR_FX_TYPES, FX_BEATS, FX_DRY_CUT, fxDryCut, PAD_FX_DRY, DEFAULT_PAD_FX
} from './fx.js';
export { renderOffline } from './offline.js';
export { gridIndexFracAt, gridTimeAtIndex, gridPeriodAt, barAlignedSeekTime, snapToBeat } from './grid.js';
export {
  VERSION,
  TEMPO_MIN, TEMPO_MAX, KEY_SHIFT_MIN, KEY_SHIFT_MAX, PRE_ROLL,
  WSOLA_LATENCY_SAMPLES, PITCH_PROCESSOR_NAME,
  HOT_CUE_COLORS
} from './constants.js';
export {
  analyzeBpm, analyzeKey, analyzeTrack, alignImportedGrid,
  keyFromMono, keyFromChroma,
  camelot, camelotLabel, keyName, shiftKey, keyDistance, heardKey
} from './analysis/index.js';
export { computePeaks, drawZoom, drawOverview, fitCanvas, WAVE_PALETTES } from './waveform/index.js';
