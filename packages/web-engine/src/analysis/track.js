// SPDX-License-Identifier: MIT
// Copyright (c) 2026 blackmagic42 (OpenMix) and contributors
// @openmix/web-engine — the Web Audio DJ engine of OpenMix
// https://github.com/blackmagic42/openmix

// analyzeTrack(): BPM/grid + key + peaks in one call (DESIGN §5.8).

import { analyzeBpm } from './bpm.js';
import { analyzeKey } from './key.js';
import { computePeaks } from '../waveform/peaks.js';
import { isAudioBufferLike } from '../util.js';

// A part that fails is returned as null: analyzeTrack never rejects for
// an analysis failure.
const orNull = (run) => {
  try {
    return Promise.resolve(run()).then((v) => v || null, () => null);
  } catch {
    return Promise.resolve(null);
  }
};

/**
 * Runs the three analyses (each can be turned off).
 * @param {AudioBuffer} buffer
 * @param {{ minBpm?: number, maxBpm?: number, bpm?: boolean, key?: boolean, peaks?: boolean,
 *   peaksPerSecond?: number, fine?: boolean }} [options] bpm/key/peaks default true,
 *   peaksPerSecond default 400, fine default true, BPM range default 85..170
 * @returns {Promise<{ bpm: number | null, beats: number[] | null, beatOffset: number | null,
 *   barAnchor: number, rigid: boolean, musicKey: number | null, keyConfidence: number | null,
 *   peaks: object | null }>}
 */
export async function analyzeTrack(buffer, options = {}) {
  if (!isAudioBufferLike(buffer)) throw new TypeError('analyzeTrack: expected an AudioBuffer');
  const o = options || {};
  const [grid, key, peaks] = await Promise.all([
    o.bpm === false ? null : orNull(() => analyzeBpm(buffer, { minBpm: o.minBpm, maxBpm: o.maxBpm })),
    o.key === false ? null : orNull(() => analyzeKey(buffer)),
    o.peaks === false ? null : orNull(() => computePeaks(buffer, { perSecond: o.peaksPerSecond, fine: o.fine !== false }))
  ]);
  return {
    bpm: grid ? grid.bpm : null,
    beats: grid ? grid.beats : null,
    beatOffset: grid ? grid.beatOffset : null,
    barAnchor: grid ? grid.barAnchor : 0,
    rigid: grid ? grid.rigid : false,
    musicKey: key ? key.code : null,
    keyConfidence: key ? key.confidence : null,
    peaks: peaks || null
  };
}
