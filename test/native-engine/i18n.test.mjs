// Every i18n key added for the native engine (owner: jsproxy, native/engine/SPEC.md §17.9.8)
// exists in French AND English, with the placeholders app.js fills in.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

if (typeof globalThis.localStorage === 'undefined' || globalThis.localStorage === null) {
  const m = new Map();
  globalThis.localStorage = { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}
const { hasTranslation, t } = await import('../../src/js/i18n.js');

const KEYS = {
  settings_audio_engine: [], engine_web: [], engine_native: [], engine_native_exclusive: [],
  engine_restart_hint: [], engine_native_active: ['device'], engine_native_unavailable: ['reason'],
  engine_native_fallback: ['reason'], recording_saved_wav: ['path'], recording_kept: ['path'],
  recordings_unsaved: ['n', 'path'], show_in_folder: [], recording_error: ['error'],
  device_lost: [], device_restored: [], engine_period: ['mode', 'period', 'ms', 'latency']
};

test('the 16 keys of SPEC §17.9.8 exist in fr and en', () => {
  assert.equal(Object.keys(KEYS).length, 16);
  for (const key of Object.keys(KEYS)) {
    assert.ok(hasTranslation('fr', key), `fr: ${key}`);
    assert.ok(hasTranslation('en', key), `en: ${key}`);
  }
});

test('placeholders are present in both languages', () => {
  const src = readFileSync(new URL('../../src/js/i18n.js', import.meta.url), 'utf8');
  for (const [key, vars] of Object.entries(KEYS)) {
    const lines = src.split('\n').filter((l) => l.trimStart().startsWith(`${key}:`));
    assert.equal(lines.length, 2, `${key} once per language`);
    for (const l of lines) for (const v of vars) assert.ok(l.includes(`{${v}}`), `${key} has {${v}}: ${l.trim()}`);
  }
  assert.match(t('engine_native_fallback', { reason: 'X' }), /X/);
});

test('every key the native-engine code paths of app.js use is defined', () => {
  const app = readFileSync(new URL('../../src/js/app.js', import.meta.url), 'utf8');
  const html = readFileSync(new URL('../../src/index.html', import.meta.url), 'utf8');
  for (const key of Object.keys(KEYS)) {
    assert.ok(app.includes(`'${key}'`) || html.includes(`"${key}"`), `${key} is used by app.js or index.html`);
  }
});

test('the keys of the review round of 2026-11-07 (PCM memory limit) exist in fr and en and are used by app.js', () => {
  const app = readFileSync(new URL('../../src/js/app.js', import.meta.url), 'utf8');
  for (const key of ['engine_reason_memory', 'engine_memory_stems', 'engine_memory_sample']) {
    assert.ok(hasTranslation('fr', key), `fr: ${key}`);
    assert.ok(hasTranslation('en', key), `en: ${key}`);
    assert.ok(app.includes(`'${key}'`), `${key} is used by app.js`);
  }
});

test('the keys of the owner decisions of 2026-11-09 (precise keylock, VST late badge) exist in fr and en and are used', () => {
  const app = readFileSync(new URL('../../src/js/app.js', import.meta.url), 'utf8');
  const html = readFileSync(new URL('../../src/index.html', import.meta.url), 'utf8');
  for (const key of ['keylock_precision_label', 'keylock_precision_title', 'keylock_precision_web_hint', 'vst_late_title']) {
    assert.ok(hasTranslation('fr', key), `fr: ${key}`);
    assert.ok(hasTranslation('en', key), `en: ${key}`);
    assert.notEqual(t(key), key);
    assert.ok(app.includes(`'${key}'`) || html.includes(`"${key}"`), `${key} is used by app.js or index.html`);
  }
});
