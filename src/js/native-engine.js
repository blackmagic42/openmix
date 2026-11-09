// OpenMix native engine, renderer proxy (owner: jsproxy, native/engine/SPEC.md §16, §17).
// app.js creates its engine with createAudioEngine(): the Web Audio engine
// (engine.js, the default) or, when Settings chose "Native engine (beta)",
// the NativeEngine facade that drives libopenmix in the Electron engine host
// and falls back to engine.js automatically. The implementation lives in
// src/js/native-engine/ (same owner); this module is the public entry point.
// Importable in Node (no browser global touched at import time).

export { createAudioEngine, NativeEngine, ENGINE_KEY, KEYLOCK_PRECISION_KEY, rememberOutputDevices } from './native-engine/core.js';
export { NativeVstHost, SUSPECTS_KEY } from './native-engine/vst-host.js';
export { NativeDeck } from './native-engine/deck.js';
export { NativeFxUnit } from './native-engine/fx.js';
export { recordingStamp, stopAndSaveRecording, revealRecording } from './native-engine/recording.js';
export { LateBadge, LATE_MIN_RISES, LATE_SHOW_WINDOW_MS, LATE_HIDE_AFTER_MS } from './native-engine/late-badge.js';
