// SPDX-License-Identifier: MIT
// Copyright (c) 2026 blackmagic42 (OpenMix) and contributors
// @openmix/web-engine — the Web Audio DJ engine of OpenMix
// https://github.com/blackmagic42/openmix

// Runner of the browser suite and its results protocol (DESIGN §10.2):
//
//   window.__TEST_RESULTS__ = {
//     done, passed, failed, skipped,
//     results: [{ name, pass, skipped, metrics, error }]
//   }
//
// When the suite ends, document.title becomes 'PASS n/n' or 'FAIL k/n', where
// the numerator counts the passed tests and n the tests that ran (skipped
// tests are not counted). scripts/test-browser.js polls __TEST_RESULTS__.

const ALL_TEST_NAMES = [
  'sync-60s', 'sync-keylock-60s', 'keylock-pitch', 'loop-precision', 'beatloop-quantize',
  'analysis-bpm', 'analysis-key', 'peaks', 'cue-routing', 'render-cpu',
  // additional checks (tests.js)
  'analysis-bpm-clicks', 'analysis-key-major', 'sync-midtrack-bars', 'eq-kill-60hz',
  'crossfader-extremes', 'keylock-8pct', 'loop-4-beats', 'peaks-shape',
  'position-model', 'keylock-toggle-synced', 'loadfrom-wav', 'fx-timing', 'roll-spin-resume',
  'master-tempo-follow', 'two-engines-one-context', 'stems-sync', 'manual-offsets'
];
// ?only=name1,name2 runs a subset (handy while working on one test)
const ONLY = (() => {
  const raw = new URLSearchParams(location.search).get('only');
  if (!raw) return null;
  const names = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return names.length ? new Set(names) : null;
})();
const TEST_NAMES = ONLY ? ALL_TEST_NAMES.filter((n) => ONLY.has(n)) : ALL_TEST_NAMES;
const TEST_TIMEOUT_MS = 75000;

// Silence by construction: a realtime AudioContext cannot even be created
// while the suite is loaded (only OfflineAudioContext is allowed, §2.5). The
// Proxy keeps `instanceof AudioContext` and AudioContext.prototype working.
function forbidRealtimeContexts() {
  for (const name of ['AudioContext', 'webkitAudioContext']) {
    const Real = globalThis[name];
    if (typeof Real !== 'function' || Real.__silentGuard) continue;
    const guarded = new Proxy(Real, {
      construct() {
        throw new Error(`${name} is forbidden in the browser tests: use OfflineAudioContext`);
      },
      get(target, key) {
        return key === '__silentGuard' ? true : Reflect.get(target, key);
      }
    });
    try {
      globalThis[name] = guarded;
    } catch {
      // read-only global: the tests still never create one
    }
  }
}

const $ = (sel) => document.querySelector(sel);

function formatMetrics(metrics) {
  if (!metrics) return '';
  return Object.entries(metrics)
    .map(([k, v]) => `${k}=${typeof v === 'object' && v !== null ? JSON.stringify(v) : v}`)
    .join('  ');
}

function errorText(e) {
  if (!e) return null;
  const message = String(e.message || e);
  return e.name && e.name !== 'Error' && !message.startsWith(e.name) ? `${e.name}: ${message}` : message;
}

function withTimeout(promise, ms, name) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${name} timed out after ${ms / 1000} s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function renderRows(names) {
  const body = $('#results tbody');
  body.textContent = '';
  for (const name of names) {
    const tr = document.createElement('tr');
    tr.dataset.test = name;
    tr.innerHTML = '<th scope="row"></th><td class="status">pending</td><td class="metrics"></td><td class="error"></td>';
    tr.querySelector('th').textContent = name;
    body.appendChild(tr);
  }
}

function updateRow(name, status, entry) {
  const tr = document.querySelector(`#results tr[data-test="${name}"]`);
  if (!tr) return;
  tr.dataset.status = status;
  tr.querySelector('.status').textContent = status;
  if (entry) {
    tr.querySelector('.metrics').textContent = formatMetrics(entry.metrics);
    tr.querySelector('.error').textContent = entry.error || '';
  }
}

function setSummary(text) {
  $('#summary').textContent = text;
}

let running = false;

async function runSuite() {
  if (running) return;
  running = true;
  $('#run').disabled = true;
  const state = { done: false, passed: 0, failed: 0, skipped: 0, total: TEST_NAMES.length, results: [] };
  window.__TEST_RESULTS__ = state;
  renderRows(TEST_NAMES);
  forbidRealtimeContexts();
  const started = performance.now();

  let mod = null;
  let loadError = null;
  try {
    mod = await import('./tests.js');
  } catch (e) {
    loadError = e;
  }

  if (!mod) {
    // The package (or the suite) did not load: every test fails with the cause
    const error = `Suite failed to load: ${errorText(loadError)}`;
    for (const name of TEST_NAMES) {
      const entry = { name, pass: false, skipped: false, metrics: {}, error };
      state.results.push(entry);
      state.failed++;
      updateRow(name, 'FAIL', entry);
    }
  } else {
    $('#version').textContent = `v${mod.VERSION}`;
    const tests = ONLY ? mod.TESTS.filter((t) => ONLY.has(t.name)) : mod.TESTS;
    state.total = tests.length;
    renderRows(tests.map((t) => t.name));
    for (const test of tests) {
      updateRow(test.name, 'running…');
      setSummary(`Running ${test.name} (${state.results.length + 1}/${tests.length})…`);
      document.title = `RUNNING ${state.results.length + 1}/${tests.length} ${test.name}`;
      const t0 = performance.now();
      let entry;
      try {
        const out = await withTimeout(Promise.resolve().then(() => test.run()), TEST_TIMEOUT_MS, test.name);
        const metrics = { ...(out && out.metrics), testMs: Math.round(performance.now() - t0) };
        entry = { name: test.name, pass: !!(out && out.pass), skipped: false, metrics, error: null };
        if (!entry.pass) entry.error = 'pass criteria not met (see metrics)';
      } catch (e) {
        const metrics = { testMs: Math.round(performance.now() - t0) };
        if (e && e.name === 'SkipTest') {
          entry = { name: test.name, pass: false, skipped: true, metrics: { ...metrics, reason: e.message }, error: null };
        } else {
          entry = { name: test.name, pass: false, skipped: false, metrics, error: errorText(e) };
          console.error(`[${test.name}]`, e);
        }
      }
      state.results.push(entry);
      if (entry.skipped) state.skipped++;
      else if (entry.pass) state.passed++;
      else state.failed++;
      updateRow(test.name, entry.skipped ? 'SKIP' : entry.pass ? 'PASS' : 'FAIL', entry);
      // let the page repaint and the GC breathe between heavy renders
      await new Promise((r) => setTimeout(r, 30));
    }
  }

  const ran = state.passed + state.failed;
  const ok = state.failed === 0 && state.passed > 0;
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  state.durationMs = Math.round(performance.now() - started);
  state.done = true;
  document.title = `${ok ? 'PASS' : 'FAIL'} ${state.passed}/${ran}`;
  setSummary(`${ok ? 'PASS' : 'FAIL'}: ${state.passed} passed, ${state.failed} failed, ${state.skipped} skipped in ${seconds} s`);
  document.body.dataset.result = ok ? 'pass' : 'fail';
  running = false;
  $('#run').disabled = false;
}

$('#run').addEventListener('click', () => {
  document.body.dataset.result = '';
  runSuite();
});

if (location.protocol !== 'file:') runSuite();
