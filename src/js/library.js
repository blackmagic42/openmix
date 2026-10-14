// Two-source library: local files and SoundCloud.
// BPM + beat grid analysis in the background (with cache), selection with
// keyboard / gamepad, loading onto a deck.

import { detectBPM, alignImportedGrid } from './bpm.js';
import { computeBandPeaks } from './waveform.js';
import { detectKey, camelot } from './key.js';
import { t as i18n } from './i18n.js';

// Colored mini waveform preview (RGB by frequency band) encoded as a dataURL
async function makePreview(buffer) {
  const W = 150;
  const H = 26;
  const ps = Math.max(2, W / Math.max(1, buffer.duration));
  const peaks = await computeBandPeaks(buffer, ps, { fine: false });
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d');
  const mid = H / 2;
  const len = peaks.top.length;
  for (let x = 0; x < W; x++) {
    const b = Math.min(len - 1, Math.floor((x / W) * len));
    const l = peaks.low[b], m = peaks.mid[b], h = peaks.high[b];
    const mx = Math.max(l, m, h, 1e-6);
    ctx.fillStyle = `rgb(${Math.round((l / mx) * 255)},${Math.round((m / mx) * 255)},${Math.round((h / mx) * 255)})`;
    const y0 = mid - peaks.top[b] * (H * 0.48);
    const y1 = mid - peaks.bottom[b] * (H * 0.48);
    ctx.fillRect(x, y0, 1, Math.max(1, y1 - y0));
  }
  return c.toDataURL('image/png');
}

// Same preview, but built from the peaks ALREADY computed for the deck (no
// recomputation: loading a track produces its real preview for free)
export function previewFromPeaks(peaks) {
  const W = 150;
  const H = 26;
  const len = peaks.top.length;
  if (!len) return null;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d');
  const mid = H / 2;
  for (let x = 0; x < W; x++) {
    const a = Math.floor((x / W) * len);
    const b = Math.max(a + 1, Math.floor(((x + 1) / W) * len));
    let top = 0;
    let bot = 0;
    let l = 0;
    let m = 0;
    let h = 0;
    for (let k = a; k < b && k < len; k++) {
      if (peaks.top[k] > top) top = peaks.top[k];
      if (peaks.bottom[k] < bot) bot = peaks.bottom[k];
      l += peaks.low[k];
      m += peaks.mid[k];
      h += peaks.high[k];
    }
    const mx = Math.max(l, m, h, 1e-6);
    ctx.fillStyle = `rgb(${Math.round((l / mx) * 255)},${Math.round((m / mx) * 255)},${Math.round((h / mx) * 255)})`;
    const y0 = mid - top * (H * 0.48);
    const y1 = mid - bot * (H * 0.48);
    ctx.fillRect(x, y0, 1, Math.max(1, y1 - y0));
  }
  return c.toDataURL('image/png');
}

// QUICK PREVIEW of a local file WITHOUT the full analysis: decoded
// directly at 11 kHz (resampled off the main thread by the
// browser — 4× less memory than a normal decode) then two one-pole
// filters for the low/mid/high color. Light enough to run
// DURING the mix: the library shows the shape of tracks without loading them.
async function makeQuickPreview(arrayBuffer) {
  const SR = 11025;
  const dec = new OfflineAudioContext(2, 1, SR);
  const buf = await dec.decodeAudioData(arrayBuffer);
  const W = 150;
  const H = 26;
  const L = buf.getChannelData(0);
  const R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : L;
  const n = L.length;
  if (!n) return null;
  const a200 = 1 - Math.exp((-2 * Math.PI * 200) / SR);
  const a2k = 1 - Math.exp((-2 * Math.PI * 2000) / SR);
  let lp200 = 0;
  let lp2k = 0;
  const cols = [];
  for (let x = 0; x < W; x++) {
    const i0 = Math.floor((x / W) * n);
    const i1 = Math.floor(((x + 1) / W) * n);
    let hi = 0;
    let lo = 0;
    let el = 0;
    let em = 0;
    let eh = 0;
    for (let i = i0; i < i1; i++) {
      const a = L[i];
      const b = R[i];
      if (a > hi) hi = a;
      if (b > hi) hi = b;
      if (a < lo) lo = a;
      if (b < lo) lo = b;
      const v = (a + b) * 0.5;
      lp200 += a200 * (v - lp200);
      lp2k += a2k * (v - lp2k);
      el += Math.abs(lp200);
      em += Math.abs(lp2k - lp200);
      eh += Math.abs(v - lp2k);
    }
    cols.push([hi, lo, el, em, eh]);
    // yield now and then: never freeze the UI
    if (x % 25 === 24) await new Promise((r) => setTimeout(r, 0));
  }
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d');
  const mid = H / 2;
  cols.forEach(([hi, lo, el, em, eh], x) => {
    const mx = Math.max(el, em, eh, 1e-6);
    ctx.fillStyle = `rgb(${Math.round((el / mx) * 255)},${Math.round((em / mx) * 255)},${Math.round((eh / mx) * 255)})`;
    const y0 = mid - hi * (H * 0.48);
    const y1 = mid - lo * (H * 0.48);
    ctx.fillRect(x, y0, 1, Math.max(1, y1 - y0));
  });
  return { url: c.toDataURL('image/png'), duration: buf.duration };
}

// Preview of a SOUNDCLOUD track from the waveform SoundCloud
// publishes itself (a few KB, no audio download): amplitude
// only — blue tint, the full color preview arrives on load.
function previewFromSamples(samples) {
  const W = 150;
  const H = 26;
  if (!samples || !samples.length) return null;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d');
  const mid = H / 2;
  let max = 0;
  for (const v of samples) if (v > max) max = v;
  if (!max) return null;
  for (let x = 0; x < W; x++) {
    const a = Math.floor((x / W) * samples.length);
    const b = Math.max(a + 1, Math.floor(((x + 1) / W) * samples.length));
    let v = 0;
    for (let k = a; k < b && k < samples.length; k++) if (samples[k] > v) v = samples[k];
    // Modern masters are "brickwalled" (almost everything at full level): the
    // cubic curve brings out breaks and build-ups instead of a solid block
    const r = Math.pow(v / max, 3);
    // the louder, the lighter (the track's dynamics at a glance)
    ctx.fillStyle = `rgb(${Math.round(40 + 140 * r)},${Math.round(110 + 110 * r)},${Math.round(230 + 25 * r)})`;
    const h = Math.max(1, r * (H * 0.48));
    ctx.fillRect(x, mid - h, 1, h * 2);
  }
  return c.toDataURL('image/png');
}

// --- SORTING the list (click on a column header) ---
// Navigation rows (folders, playlists, accounts…) stay at the top,
// in their order; only TRACKS are sorted.
const isNavRow = (t) => t.plRow || t.fsRow || t.fsUpRow || t.scRootRow || t.plRootRow ||
  t.scLikes || t.scAccountRow || t.scPlaylist;
const splitName = (t) => {
  const sep = (t.name || '').indexOf(' - ');
  return sep > 0
    ? { artist: t.name.slice(0, sep), title: t.name.slice(sep + 3) }
    : { artist: '', title: t.name || '' };
};
const SORTERS = {
  title: (t) => splitName(t).title.toLowerCase(),
  artist: (t) => splitName(t).artist.toLowerCase(),
  bpm: (t) => t.bpm || null,
  dur: (t) => t.duration || null,
  // Camelot wheel order: 1A 1B 2A 2B … 12B
  key: (t) => {
    const c = camelot(t.musicKey);
    return c ? c.num * 2 + (c.letter === 'B' ? 1 : 0) : null;
  }
};

const trackKey = (t) => t.key || (t.sc ? `sc:${t.scId}` : `${t.path}|${t.size}|${Math.round(t.mtime)}`);

// Analysis algorithm version: bumping it forces a re-analysis
// (manual corrections and previews are always kept)
// v12 = section-based analysis (bass/chill): re-anchored each time the beat comes back
const ANALYSIS_V = 13;

export class Library {
  constructor(audioCtx, callbacks) {
    this.audioCtx = audioCtx;
    this.cb = callbacks; // { onListChanged, onTrackUpdated, onStatus }
    this.mode = 'local'; // 'local' | 'sc' | 'hist'
    this.tracks = [];    // local files
    this.scTracks = [];  // SoundCloud tracks or playlists
    this.history = [];   // last tracks played
    this.playlists = []; // user-created playlists
    this.plOpen = null;  // currently open playlist
    this.scTitle = null;
    // SoundCloud multi-account (b2b): the current view always belongs to
    // ONE account (scAcctIdx) and each account keeps its playlist list
    // cached so that ⬅ falls back to ITS OWN, not the friend's
    this.scAcctIdx = 0;
    this.scPlaylistsByAcct = {};
    this.scAccountsView = false; // the "account list" view is displayed
    this.scAccountCount = 0;     // refreshed by refreshScStatus (app.js)
    this.filtered = [];
    this.selection = 0;
    this.search = '';
    this.cache = {};
    this.played = {};    // tracks played DURING THIS SESSION (key → date), see isTaken
    this._scanId = 0;
    this._saveTimer = null;
    // sort chosen by clicking the headers (remembered)
    this.sort = { col: null, dir: 1 };
    try {
      const sv = JSON.parse(localStorage.getItem('libSort'));
      if (sv && SORTERS[sv.col]) this.sort = { col: sv.col, dir: sv.dir === -1 ? -1 : 1 };
    } catch { /* default sort */ }
    this._previewBusy = false;
    this._scWaveQueue = [];
    this._scWaveRunning = 0;
  }

  // Header click: ascending → descending → original order
  toggleSort(col) {
    if (this.sort.col !== col) this.sort = { col, dir: 1 };
    else if (this.sort.dir === 1) this.sort = { col, dir: -1 };
    else this.sort = { col: null, dir: 1 };
    try { localStorage.setItem('libSort', JSON.stringify(this.sort)); } catch { /* nothing */ }
    const cur = this.filtered[this.selection];
    this.applyFilter();
    // the selection follows the track, not its position
    const ni = cur ? this.filtered.indexOf(cur) : -1;
    if (ni >= 0 && ni !== this.selection) {
      this.selection = ni;
      this.cb.onListChanged();
    }
  }

  // Pulls everything already known about a track from the central cache
  _fromCache(t) {
    const cached = this.cache[trackKey(t)];
    if (!cached) return t;
    if (cached.v >= 2) {
      t.bpm = cached.bpm;
      t.beatOffset = cached.beatOffset;
      t.analyzed = cached.v >= ANALYSIS_V;
    }
    if (cached.preview && !t.preview) {
      t.preview = cached.preview;
      t.previewQ = !!cached.previewQ;
    }
    if (cached.musicKey != null) t.musicKey = cached.musicKey;
    return t;
  }

  // BPM analysis range chosen in the settings (default: 85-170)
  _range() {
    const r = localStorage.getItem('bpmRange') || '85-170';
    if (r === 'auto') return { lo: 85, hi: 170 };
    const [a, b] = r.split('-').map(Number);
    return a && b ? { lo: a, hi: b } : { lo: 85, hi: 170 };
  }

  // Invalidates all analyses (BPM range change, for example).
  // Grids imported from Rekordbox are kept: they are the
  // reference, not a calculation to redo.
  invalidateAnalysis() {
    let n = 0;
    for (const k of Object.keys(this.cache)) {
      const c = this.cache[k];
      if (c && typeof c === 'object' && c.v && !c.rb) {
        c.v = 0;
        n++;
      }
    }
    this.tracks.forEach(t => { t.analyzed = false; });
    this.scTracks.forEach(t => { if (!t.scPlaylist) t.analyzed = false; });
    this._scheduleSave();
    if (this.cache.__folder) this.scan(this.cache.__folder);
    return n;
  }

  // Imports the beat grids computed by Rekordbox (ANLZ files
  // on this PC). Matched by file name, ties broken by duration.
  // The imported grid becomes the track's reference (rb flag): re-analysis
  // no longer overwrites it, but manual GRID / ÷2×2 still take priority.
  async importRekordboxGrids() {
    const list = await window.api.rbGrids();
    if (!list || !list.length) return 0;
    const byName = new Map();
    for (const g of list) {
      const arr = byName.get(g.name) || [];
      arr.push(g);
      byName.set(g.name, arr);
    }
    let count = 0;
    const all = [...this.tracks, ...this.scTracks.filter(t => t.path)];
    for (const t of all) {
      const base = String(t.path || t.name || '').split(/[\\/]/).pop().toLowerCase();
      const cands = byName.get(base);
      if (!cands) continue;
      const key = trackKey(t);
      const prev = this.cache[key] || {};
      const dur = prev.duration || t.duration || null;
      let g = cands[0];
      if (cands.length > 1 && dur) {
        g = cands.reduce((a, b) => Math.abs(a.lastBeat - dur) < Math.abs(b.lastBeat - dur) ? a : b);
      }
      // The last beat cannot be past the end of the file: otherwise it is
      // not the same track (same name, another version)
      if (dur && g.lastBeat > dur + 3) continue;
      this.cache[key] = {
        ...prev,
        v: ANALYSIS_V,
        rb: true,
        bpm: g.bpm,
        beatOffset: g.beats[0],
        beats: g.beats,
        barAnchorAuto: g.anchor,
        duration: prev.duration || null
      };
      // The Rekordbox grid REPLACES beats: manual adjustments relative to
      // the OLD array no longer make sense — clear them (invariant:
      // gridShift/barAnchor are always relative to the saved beats)
      delete this.cache[key].gridShift;
      delete this.cache[key].barAnchor;
      delete this.cache[key].manual;
      delete this.cache[key].manualBpm;
      delete this.cache[key].manualOffset;
      t.bpm = g.bpm;
      t.beatOffset = g.beats[0];
      t.analyzed = true;
      count++;
      this.cb.onTrackUpdated(t);
    }
    if (count) this._scheduleSave();
    return count;
  }

  list() {
    if (this.mode === 'sc') return this.scTracks;
    if (this.mode === 'hist') return this.history;
    if (this.mode === 'pl') {
      if (this.plOpen) return this.plOpen.tracks;
      return this.playlists.map(p => ({
        plRow: true,
        pl: p,
        name: `📁 ${p.name}`,
        count: p.tracks.length
      }));
    }
    // ROOTS VIEW ("home"): SoundCloud, Playlists and the PC's
    // roots — the starting point for browsing with the encoder, like the left
    // column. Root names already carry their icon.
    if (this.rootsView) {
      return [
        { scRootRow: true, name: 'SoundCloud' },
        { plRootRow: true, name: 'Playlists' },
        ...(this.fsDirs || []).map(d => ({ fsRow: true, path: d.path, name: d.native ? i18n('dl_native_root') : d.name }))
      ];
    }
    // Local mode: ".." row (go up) then browsable subfolders
    // ABOVE the tracks — even an empty folder stays browsable
    const dirRows = (this.fsDirs || []).map(d => ({
      fsRow: true,
      path: d.path,
      name: `📁 ${d.name}`
    }));
    if (this.fsDir) dirRows.unshift({ fsUpRow: true, name: i18n('parent_folder') });
    return dirRows.length ? [...dirRows, ...this.tracks] : this.tracks;
  }

  // Go back to the STARTING POINT of navigation (PC roots + SoundCloud
  // + Playlists) — where BACK always ends up
  async showRoots() {
    this._scanId++; // stops a scan in progress
    this.rootsView = true;
    this.fsDir = null;
    this.tracks = [];
    this.fsDirs = (await window.api.fsRoots()) || [];
    this.selection = 0;
    this.applyFilter();
    this.cb.onStatus(i18n('library_root_hint'));
  }

  async init() {
    this.cache = (await window.api.cacheLoad()) || {};
    this.history = this.cache.__history || [];
    // "Already played" marks only apply to the CURRENT session: on
    // every launch, everything starts white again (David's request). Clean up
    // the old permanent version if it is still lying around in the cache.
    this.played = {};
    delete this.cache.__played;
    this._refoldOctaves();
    this.playlists = this.cache.__playlists || [];
    this.plOpen = null;
    const last = this.cache.__folder;
    if (last) await this.scan(last);
    else await this.showRoots(); // first launch: browsing starts at the roots
  }

  // ONE TIME ONLY: analyses already cached above the octave ceiling
  // (double tempo, e.g. Bon Appétit read as 212 instead of 106 — see FOLD_HI in
  // bpm.js) are queued for re-analysis. A BPM typed in / ÷2×2 by hand and
  // Rekordbox grids are respected; grid adjustments (◀ ▶, GRID)
  // made on a double-tempo grid no longer make sense: cleared.
  _refoldOctaves() {
    if (this.cache.__octFold >= 1) return;
    const { hi } = this._range();
    const foldHi = Math.max(hi * 1.06, 180);
    let n = 0;
    for (const k of Object.keys(this.cache)) {
      const c = this.cache[k];
      if (!c || typeof c !== 'object' || k.startsWith('__') || !(c.bpm > foldHi)) continue;
      if (c.manualBpm || c.rb) continue;
      delete c.manual;
      delete c.manualOffset;
      delete c.gridShift;
      delete c.barAnchor;
      c.v = 2; // BPM kept for display, re-analyzed on the next pass
      n++;
    }
    this.cache.__octFold = 1;
    if (n) console.log(`[midi] analysis: ${n} double-tempo tracks queued for re-analysis`);
    this._scheduleSave();
  }

  // --- Playlists ---
  savePlaylists() {
    this.cache.__playlists = this.playlists;
    this._scheduleSave();
  }

  trackRef(track) {
    return {
      key: trackKey(track),
      name: track.name,
      path: track.path || null,
      sc: !!track.sc,
      scId: track.scId || null,
      // Original SoundCloud account: downloading a private/Go+ track
      // to disk must reuse THE SAME token
      acctIdx: track.acctIdx != null ? track.acctIdx : null,
      bpm: track.bpm || null,
      beatOffset: track.beatOffset != null ? track.beatOffset : null,
      duration: track.duration || null,
      preview: track.preview || null,
      musicKey: track.musicKey ?? null,
      analyzed: true
    };
  }

  createPlaylist(name) {
    const p = { id: String(Date.now()), name, tracks: [] };
    this.playlists.push(p);
    this.savePlaylists();
    if (this.mode === 'pl' && !this.plOpen) this.applyFilter();
    return p;
  }

  addToPlaylist(p, track) {
    const ref = this.trackRef(track);
    if (p.tracks.some(t => t.key === ref.key)) return null;
    p.tracks.push(ref);
    this.savePlaylists();
    if (this.mode === 'pl') this.applyFilter();
    return ref;
  }

  removeFromPlaylist(p, idx) {
    p.tracks.splice(idx, 1);
    this.savePlaylists();
    if (this.mode === 'pl') this.applyFilter();
  }

  moveInPlaylist(p, from, to) {
    if (from === to || from < 0 || to < 0 || from >= p.tracks.length || to >= p.tracks.length) return;
    const [item] = p.tracks.splice(from, 1);
    p.tracks.splice(to, 0, item);
    this.savePlaylists();
    this.applyFilter();
  }

  deletePlaylist(p) {
    const idx = this.playlists.indexOf(p);
    if (idx >= 0) this.playlists.splice(idx, 1);
    this.savePlaylists();
    if (this.mode === 'pl') this.applyFilter();
  }

  openPlaylist(p) {
    this.plOpen = p;
    this.selection = 0;
    this.applyFilter();
  }

  closePlaylist() {
    this.plOpen = null;
    this.selection = 0;
    this.applyFilter();
  }

  // History: called every time a track is loaded onto a deck
  // Tracks ALREADY PLAYED DURING THIS SESSION (loaded onto a deck since
  // OpenMix was launched): shown in green in the browser. Nothing is
  // kept from one session to the next: on relaunch, everything is white again.
  isTaken(t) {
    if (!t || !t.name) return false;
    return !!this.played[trackKey(t)];
  }

  // A file was FILED elsewhere (moved or copied): its analysis (BPM,
  // grid, cues, key) follows it under its new key, and playlists /
  // history point to the new location if it was moved
  relocateTrack(track, info) {
    const oldKey = trackKey(track);
    const nt = { path: info.path, size: info.size, mtime: info.mtime };
    const newKey = trackKey(nt);
    if (this.cache[oldKey] && !this.cache[newKey]) {
      this.cache[newKey] = JSON.parse(JSON.stringify(this.cache[oldKey]));
    }
    if (info.moved) {
      const fix = (r) => {
        if (r && r.key === oldKey) {
          r.key = newKey;
          r.path = info.path;
          r.name = info.name;
        }
      };
      this.playlists.forEach((p) => p.tracks.forEach(fix));
      this.history.forEach(fix);
      if (this.played[oldKey]) this.played[newKey] = this.played[oldKey];
    }
    this._scheduleSave();
  }

  // File moved / renamed outside the view (folder moved, renamed…):
  // { from, to, size, mtime } — its analysis and its playlists follow
  relocateMoved(m) {
    const name = String(m.to).split(/[\\/]/).pop().replace(/\.[^.]+$/, '');
    this.relocateTrack({ path: m.from, size: m.size, mtime: m.mtime },
      { path: m.to, size: m.size, mtime: m.mtime, moved: true, name });
  }

  // Remove the mark from one track (right-click) or from all of them
  unmarkPlayed(t) {
    delete this.played[trackKey(t)];
  }

  clearPlayed() {
    this.played = {};
  }

  addHistory(track) {
    const entry = {
      key: trackKey(track),
      name: track.name,
      path: track.path || null,
      sc: !!track.sc,
      scId: track.scId || null,
      bpm: track.bpm || null,
      beatOffset: track.beatOffset != null ? track.beatOffset : null,
      duration: track.duration || null,
      preview: track.preview || null,
      musicKey: track.musicKey ?? null,
      analyzed: true,
      at: Date.now()
    };
    this.history = this.history.filter(h => h.key !== entry.key);
    this.history.unshift(entry);
    this.played[entry.key] = entry.at; // permanent "already played" mark
    if (this.history.length > 300) this.history.length = 300;
    this.cache.__history = this.history;
    this._scheduleSave();
    if (this.mode === 'hist') this.applyFilter();
  }

  setMode(mode) {
    if (this.mode === mode) return;
    this.mode = mode;
    this.selection = 0;
    this.applyFilter();
  }

  async chooseFolder() {
    const dir = await window.api.pickFolder();
    if (!dir) return;
    this.cache.__folder = dir;
    this._scheduleSave();
    this.setMode('local');
    await this.scan(dir);
  }

  async scan(dir) {
    const scanId = ++this._scanId;
    this.cb.onStatus(i18n('scanning_folder', { dir }));
    // Rekordbox-style navigation: SUBFOLDERS are shown at the top of the
    // list (the encoder enters them, BACK goes up to the parent folder)
    this.rootsView = false;
    this.fsDir = dir;
    this.fsDirs = [];
    window.api.fsList(dir).then((dirs) => {
      if (scanId !== this._scanId) return;
      this.fsDirs = dirs || [];
      this.applyFilter();
    });
    const files = await window.api.scanFolder(dir);
    if (scanId !== this._scanId) return;
    this.tracks = files.map(f => {
      const cached = this.cache[trackKey(f)];
      const ok = cached && cached.v >= 2;
      const fresh = cached && cached.v >= ANALYSIS_V;
      return {
        ...f,
        bpm: ok ? cached.bpm : null,
        beatOffset: ok ? cached.beatOffset : null,
        duration: ok ? cached.duration : null,
        preview: cached && cached.preview ? cached.preview : null,
        previewQ: !!(cached && cached.previewQ),
        musicKey: cached && cached.musicKey != null ? cached.musicKey : null,
        keyTried: !!(cached && cached.keyFail),
        analyzed: !!fresh
      };
    });
    this.applyFilter();
    this.cb.onStatus(i18n('library_scanning_status', { n: this.tracks.length }));
    this._analyzeQueue(scanId);
    this._previewQueue(scanId);
  }

  // ---------------------------------------------------------------------
  // SoundCloud
  // ---------------------------------------------------------------------

  async loadScUrl(url, acctIdx = this.scAcctIdx ?? 0) {
    this.cb.onStatus(i18n('sc_connecting'));
    const res = await window.api.scResolve(url, acctIdx);
    if (!res.ok) {
      this.cb.onStatus(i18n('sc_error', { error: res.error }));
      return false;
    }
    // The view now belongs to this account: ⬅ and downloads
    // will use ITS token. When switching accounts without knowing its
    // playlists, forget the previous account's — ⬅ must never show
    // the friend's playlists under the wrong name
    const switching = this.scAcctIdx !== acctIdx;
    this.scAcctIdx = acctIdx;
    this.scAccountsView = false;
    if (this.scPlaylistsByAcct[acctIdx]) this.scPlaylists = this.scPlaylistsByAcct[acctIdx];
    else if (switching) this.scPlaylists = null;
    if (res.kind === 'user') {
      const rows = res.playlists.map(p => ({ ...p, acctIdx }));
      this.scTracks = rows;
      this.scPlaylists = rows;
      this.scTitle = i18n('sc_user_playlists_title', { user: res.title });
    } else {
      this.scTracks = res.tracks.map(t => ({
        ...t,
        sc: true,
        acctIdx,
        bpm: null,
        beatOffset: null,
        analyzed: false,
        path: null
      }));
      // Retrieve what is already known (BPM, key, preview) from the cache
      for (const t of this.scTracks) this._fromCache(t);
      this._queueScWaves(this.scTracks);
      this.scTitle = res.title;
    }
    this.cache.__scUrl = url;
    this._scheduleSave();
    this.setMode('sc');
    this.selection = 0;
    this.applyFilter();
    this.cb.onStatus(i18n('sc_playlist_status', { title: this.scTitle, n: this.scTracks.length }));
    return true;
  }

  // Search the WHOLE SoundCloud catalog — beyond playlists.
  // Results load/stream like any other SC track.
  async searchSc(query) {
    this.cb.onStatus(i18n('sc_searching', { query }));
    // The search uses the CURRENT account's token: a Go+ result
    // must download with the right account, not anonymously
    const acctIdx = this.scAcctIdx ?? 0;
    const res = await window.api.scSearch(query, acctIdx);
    if (!res.ok) {
      this.cb.onStatus(i18n('sc_error', { error: res.error }));
      return false;
    }
    this.scAccountsView = false;
    this.scTracks = res.tracks.map(t => ({
      ...t,
      sc: true,
      acctIdx,
      bpm: null,
      beatOffset: null,
      analyzed: false,
      path: null
    }));
    // BPM, key and previews already known, retrieved from the cache
    for (const t of this.scTracks) this._fromCache(t);
    this._queueScWaves(this.scTracks);
    this.scTitle = i18n('sc_search_title', { query });
    this.search = ''; // results must not be filtered again locally
    this.setMode('sc');
    this.selection = 0;
    this.applyFilter();
    this.cb.onStatus(i18n('sc_search_results', { n: this.scTracks.length, query }));
    return true;
  }

  // ---------------------------------------------------------------------

  applyFilter() {
    const q = this.search.trim().toLowerCase();
    const src = this.list();
    let list = q
      ? src.filter(t => t.name.toLowerCase().includes(q))
      : src;
    const by = this.sort && this.sort.col && SORTERS[this.sort.col];
    if (by) {
      const dir = this.sort.dir || 1;
      const nav = list.filter(isNavRow);
      const tracks = list.filter((t) => !isNavRow(t));
      // stable order; unknown values (BPM not analyzed yet…) go last
      const keyed = tracks.map((t, i) => ({ t, i, v: by(t) }));
      keyed.sort((a, b) => {
        if (a.v == null && b.v == null) return a.i - b.i;
        if (a.v == null) return 1;
        if (b.v == null) return -1;
        const c = typeof a.v === 'string' ? a.v.localeCompare(b.v) : a.v - b.v;
        return c ? c * dir : a.i - b.i;
      });
      list = [...nav, ...keyed.map((k) => k.t)];
    }
    this.filtered = list;
    // History / playlists: their entries kept the preview (often
    // empty or blue) from the moment they were added — refresh them
    // from the cache and fill in the missing colors
    if (this.mode === 'hist' || (this.mode === 'pl' && this.plOpen)) {
      const items = src.filter((t) => !isNavRow(t));
      for (const t of items) {
        if (!t._enriched) { t._enriched = true; this._fromCache(t); }
      }
      this._queueScColors(items);
    }
    this.selection = Math.min(this.selection, Math.max(0, this.filtered.length - 1));
    this.cb.onListChanged();
  }

  setSearch(q) {
    this.search = q;
    this.selection = 0;
    this.applyFilter();
  }

  moveSelection(delta) {
    if (!this.filtered.length) return;
    this.selection = Math.min(this.filtered.length - 1, Math.max(0, this.selection + delta));
    this.cb.onSelectionChanged();
  }

  // Back ⬅ in the SoundCloud tab — 3 levels in b2b: tracks of a
  // playlist → current account's playlists → account list (and only
  // 2 levels, as before, when there is a single account)
  scBack() {
    if (this.scAccountsView) return false; // already at the very top
    if (this.scPlaylists && this.scPlaylists.length && this.scTracks !== this.scPlaylists) {
      this.scTracks = this.scPlaylists;
      this.scTitle = 'Playlists';
      this.setMode('sc');
      this.selection = 0;
      this.applyFilter();
      this.cb.onStatus(`${this.scPlaylists.length} playlists`);
      return true;
    }
    if ((this.scAccountCount || 0) >= 2) {
      this.loadScAccounts();
      return true;
    }
    return false;
  }

  // List of connected SoundCloud accounts — the ROOT level of the tab
  // when mixing b2b (≥ 2 accounts): everyone finds THEIR OWN tracks there
  async loadScAccounts() {
    const s = await window.api.scStatus();
    const accounts = (s && s.accounts) || [];
    this.scAccountCount = accounts.length;
    this.scTracks = accounts.map((a, i) => ({
      scAccountRow: true,
      acctIdx: i,
      name: `${a.name || i18n('sc_account_default_name', { n: i + 1 })}${a.expired ? i18n('sc_account_reconnect_suffix') : ''}`
    }));
    this.scAccountsView = true;
    this.scTitle = i18n('sc_accounts_title');
    this.setMode('sc');
    this.selection = 0;
    this.applyFilter();
    this.cb.onStatus(i18n('sc_accounts_status', { n: accounts.length }));
    return true;
  }

  // Playlists of the requested SoundCloud account (default: account 0 = as before)
  async loadScMine(acctIdx = 0) {
    this.cb.onStatus(i18n('sc_fetching_playlists'));
    const res = await window.api.scMyPlaylists(acctIdx);
    if (!res.ok) {
      this.cb.onStatus(i18n('sc_error', { error: res.error }));
      return res;
    }
    // Each row (❤️ Likes included) is tagged with ITS account: the right
    // token follows the playlist all the way to the track downloads
    const rows = res.playlists.map(p => ({ ...p, acctIdx }));
    this.scAcctIdx = acctIdx;
    this.scAccountsView = false;
    this.scPlaylistsByAcct[acctIdx] = rows;
    this.scTracks = rows;
    this.scPlaylists = rows;
    this.scTitle = i18n('sc_user_playlists_title', { user: res.username });
    this.setMode('sc');
    this.selection = 0;
    this.applyFilter();
    this.cb.onStatus(i18n('sc_user_playlists_status', { n: rows.length, user: res.username }));
    return res;
  }

  // The requested account's LIKED tracks, presented as a playlist
  async loadScLikes(acctIdx = 0) {
    this.cb.onStatus(i18n('sc_fetching_likes'));
    const res = await window.api.scMyLikes(acctIdx);
    if (!res.ok) {
      this.cb.onStatus(i18n('sc_error', { error: res.error }));
      return false;
    }
    const switching = this.scAcctIdx !== acctIdx;
    this.scAcctIdx = acctIdx;
    this.scAccountsView = false;
    // ⬅ must fall back to THIS account's playlists (or nothing if unknown)
    if (this.scPlaylistsByAcct[acctIdx]) this.scPlaylists = this.scPlaylistsByAcct[acctIdx];
    else if (switching) this.scPlaylists = null;
    this.scTracks = res.tracks.map(t => ({
      ...t,
      sc: true,
      acctIdx,
      bpm: null,
      beatOffset: null,
      analyzed: false,
      path: null
    }));
    for (const t of this.scTracks) this._fromCache(t);
    this._queueScWaves(this.scTracks);
    // In b2b, say WHOSE likes these are — solo keeps the historical label
    this.scTitle = (this.scAccountCount >= 2 && res.username)
      ? i18n('sc_user_likes_title', { user: res.username })
      : '❤ Likes';
    this.setMode('sc');
    this.selection = 0;
    this.applyFilter();
    this.cb.onStatus(i18n('sc_likes_status', { n: this.scTracks.length }));
    return true;
  }

  selectedTrack() {
    return this.filtered[this.selection] || null;
  }

  // Track COVER ART: read once (file tags or SoundCloud
  // artwork), shrunk to 64 px and stored in the cache — null is also
  // stored (a file without cover art is not re-read on every load)
  async coverFor(track) {
    const key = trackKey(track);
    const c = this.cache[key];
    // Only the POSITIVE cache is trusted: a stored null is
    // retried (artwork can show up later, e.g. SC artwork)
    if (c && c.cover) return c.cover;
    // SoundCloud: the online ARTWORK first — the downloaded mp3 in the
    // cache has no tags, it was hiding the cover art
    const src = (track.sc && track.artwork) ? track.artwork : (track.path || track.artwork || null);
    let url = null;
    if (src) {
      try {
        const pic = await window.api.readCover(src);
        if (pic) {
          url = await new Promise((resolve) => {
            const im = new Image();
            im.onload = () => {
              const cv = document.createElement('canvas');
              cv.width = 64;
              cv.height = 64;
              const g = cv.getContext('2d');
              const s = Math.max(64 / im.width, 64 / im.height);
              g.drawImage(im, (64 - im.width * s) / 2, (64 - im.height * s) / 2,
                im.width * s, im.height * s);
              resolve(cv.toDataURL('image/jpeg', 0.78));
            };
            im.onerror = () => resolve(null);
            im.src = `data:${pic.format};base64,${pic.data}`;
          });
        }
      } catch { /* no cover art */ }
    }
    const entry = this.cache[key] || { v: 2 };
    entry.cover = url;
    this.cache[key] = entry;
    this._scheduleSave();
    return url;
  }

  // PARALLEL ANALYSIS: several tracks processed AT THE SAME TIME, one per
  // "lane". Decoding and filtering run on Chromium's native threads:
  // with 3 lanes, a multi-core machine analyzes a library
  // ~3× faster than one at a time. Capped so as not to saturate RAM
  // (each decoded track weighs several tens of MB).
  async _analyzeQueue(scanId) {
    const cores = navigator.hardwareConcurrency || 4;
    const lanes = Math.max(1, Math.min(3, Math.floor(cores / 2)));
    let next = 0;
    const state = { save: Date.now() };
    const nextTrack = () => {
      while (next < this.tracks.length) {
        const t = this.tracks[next++];
        if (!(t.analyzed && t.preview && !t.previewQ) || (t.musicKey == null && !t.keyTried)) return t;
      }
      return null;
    };
    await Promise.all(
      Array.from({ length: lanes }, () => this._analyzeVoie(scanId, nextTrack, state))
    );
    if (scanId === this._scanId) this._scheduleSave();
  }

  async _analyzeVoie(scanId, nextTrack, state) {
    let sinceLastSave = state; // timestamp shared between lanes
    for (let t = nextTrack(); t; t = nextTrack()) {
      if (scanId !== this._scanId) return;
      // NEVER analyze while a deck is playing: decoding + BPM detection
      // saturated the CPU → "the sound lags". The analysis waits patiently and
      // resumes on its own as soon as playback stops (like Demucs).
      while (this.cb.canAnalyze && !this.cb.canAnalyze()) {
        await new Promise((r) => setTimeout(r, 1500));
        if (scanId !== this._scanId) return;
      }
      try {
        const buffer = await this._decode(t.path);
        if (scanId !== this._scanId) return;
        t.duration = buffer.duration;
        const prev = this.cache[trackKey(t)] || {};
        let newBeats = prev.beats || null;
        let newAnchor = prev.barAnchorAuto || 0;
        if (!t.analyzed) {
          const res = await detectBPM(buffer, this._range());
          // Manual corrections (÷2×2) and imported Rekordbox grids
          // are preserved, everything else benefits from the fresh grid
          const keepBpm = (prev.manualBpm || prev.manual || prev.manualOffset ||
        prev.gridShift != null || prev.barAnchor != null || prev.rb) && prev.bpm != null;
          t.bpm = keepBpm ? prev.bpm : (res ? res.bpm : null);
          t.beatOffset = keepBpm && prev.beatOffset != null ? prev.beatOffset : (res ? res.beatOffset : null);
          newBeats = keepBpm && prev.beats ? prev.beats : (res ? res.beats : null);
          if (!keepBpm && res) newAnchor = res.barAnchor || 0;
        }
        if (!t.preview || t.previewQ) {
          t.preview = await makePreview(buffer);
          t.previewQ = false;
        }
        // KEY (once per track, kept in the cache)
        let mk = prev.musicKey;
        let keyFail = false;
        if (mk == null) {
          t.keyTried = true;
          const k = await detectKey(buffer).catch(() => null);
          if (k) mk = k.code;
          else keyFail = true;
        }
        if (mk != null) t.musicKey = mk;
        t.analyzed = true;
        this.cache[trackKey(t)] = { ...prev, v: ANALYSIS_V, bpm: t.bpm, beatOffset: t.beatOffset, beats: newBeats, barAnchorAuto: newAnchor, duration: t.duration, preview: t.preview, previewQ: false, musicKey: mk ?? null, keyFail };
        // Save AT MOST every 60 s: the full cache (up to
        // several tens of MB) was written back to disk every 5
        // tracks and fought over the disk head with the files being
        // analyzed. Closing the app is still covered by flushSave().
        if (Date.now() - sinceLastSave.save > 60000) {
          sinceLastSave.save = Date.now();
          this._scheduleSave();
        }
        this.cb.onTrackUpdated(t);
      } catch {
        t.analyzed = true; // unreadable file: don't insist
        t.keyTried = true;
      }
      // (only the ANALYSIS is counted: a failed preview on an unreadable file
      // must not show "1 remaining" forever)
      const remaining = this.tracks.filter(x => !x.analyzed).length;
      this.cb.onStatus(remaining
        ? i18n('library_analyzing_status', { n: this.tracks.length, remaining })
        : i18n('library_analysis_done', { n: this.tracks.length }));
    }
  }

  // QUICK PREVIEWS of local files — including DURING the mix (the full
  // analysis, on the other hand, waits until nothing is playing). One track at a time,
  // with a pause in between while playing: the sound always comes first.
  async _previewQueue(scanId) {
    this._previewWant = scanId;
    if (this._previewBusy) return; // the running loop will restart for this folder
    this._previewBusy = true;
    try {
      for (const t of this.tracks) {
        if (scanId !== this._scanId) return;
        if (t.preview || !t.path) continue;
        try {
          const raw = await window.api.readFile(t.path);
          if (scanId !== this._scanId) return;
          const ab = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
          const q = await makeQuickPreview(ab);
          if (!q || t.preview) continue;
          t.preview = q.url;
          t.previewQ = true;
          if (!t.duration) t.duration = q.duration;
          const key = trackKey(t);
          const c = this.cache[key] || { v: 1 };
          if (!c.preview) {
            c.preview = q.url;
            c.previewQ = true;
            c.previewSrc = 'audio';
            if (!c.duration) c.duration = q.duration;
            this.cache[key] = c;
          }
          this.cb.onTrackUpdated(t);
        } catch { /* unreadable file: the analysis will report it */ }
        const busy = this.cb.canAnalyze && !this.cb.canAnalyze();
        await new Promise((r) => setTimeout(r, busy ? 700 : 30));
      }
      this._scheduleSave();
    } finally {
      this._previewBusy = false;
      // another folder was opened during the loop: process it
      if (this._previewWant === this._scanId && this._previewWant !== scanId) {
        this._previewQueue(this._scanId);
      }
    }
  }

  // SOUNDCLOUD waveforms (published by SoundCloud, a few KB each)
  _queueScWaves(list) {
    for (const t of list) {
      if (t.sc && t.waveform && !t.preview && !t._waveAsked) {
        t._waveAsked = true;
        this._scWaveQueue.push(t);
      }
    }
    const pump = async () => {
      this._scWaveRunning++;
      try {
        while (this._scWaveQueue.length) {
          const t = this._scWaveQueue.shift();
          if (t.preview) continue;
          const res = await window.api.scWaveform(t.waveform).catch(() => null);
          const url = res && res.ok ? previewFromSamples(res.samples) : null;
          if (!url || t.preview) continue;
          t.preview = url;
          t.previewQ = true;
          const key = trackKey(t);
          const c = this.cache[key] || { v: 1 };
          if (!c.preview) {
            c.preview = url;
            c.previewQ = true;
            c.previewSrc = 'sc';
            this.cache[key] = c;
            this._scheduleSave();
          } else if (c.previewSrc === 'audio' || !c.previewQ) {
            t.preview = c.preview; // the color was already there
          }
          this.cb.onTrackUpdated(t);
        }
      } finally {
        this._scWaveRunning--;
      }
    };
    while (this._scWaveRunning < 4 && this._scWaveQueue.length) pump();
    this._queueScColors(list);
    this._queueScKeys(list);
  }

  // TRUE COLORS (low / mid / high) for SoundCloud tracks
  // already listened to: their full audio is in the cache, the quick preview
  // is derived from it like for a PC file — including during the mix, one track
  // at a time. (The waveform published by SoundCloud only has amplitude:
  // that is what stayed all blue.)
  _queueScColors(list) {
    if (!this._scColorQueue) this._scColorQueue = [];
    for (const t of list) {
      const src = (t.sc && t.scId) || (!t.sc && t.path);
      if (src && !t._colorAsked && (!t.preview || t.previewQ)) {
        t._colorAsked = true;
        this._scColorQueue.push(t);
      }
    }
    if (this._scColorRunning) return;
    this._scColorRunning = true;
    (async () => {
      try {
        while (this._scColorQueue.length) {
          const t = this._scColorQueue.shift();
          const key = trackKey(t);
          const c0 = this.cache[key];
          if (c0 && c0.preview && c0.previewSrc === 'audio') {
            if (t.preview !== c0.preview) { t.preview = c0.preview; this.cb.onTrackUpdated(t); }
            continue;
          }
          const p = t.sc ? await window.api.scCachedPath(t.scId).catch(() => null) : t.path;
          if (!p) continue;
          try {
            const raw = await window.api.readFile(p);
            const ab = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
            const q = await makeQuickPreview(ab);
            if (!q) continue;
            const c = this.cache[key] || { v: 1 };
            // a real preview (track already loaded onto a deck) keeps priority
            if (!(c.preview && !c.previewQ)) {
              c.preview = q.url;
              c.previewQ = true;
              c.previewSrc = 'audio';
              this.cache[key] = c;
              t.preview = q.url;
              t.previewQ = true;
              this._scheduleSave();
              this.cb.onTrackUpdated(t);
            }
          } catch { /* unreadable file */ }
          const busy = this.cb.canAnalyze && !this.cb.canAnalyze();
          await new Promise((r) => setTimeout(r, busy ? 600 : 20));
        }
      } finally {
        this._scColorRunning = false;
      }
    })();
  }

  // KEY of SoundCloud tracks already listened to (full audio in the cache):
  // computed when nothing is playing, like the analysis of PC files
  _queueScKeys(list) {
    if (!this._scKeyQueue) this._scKeyQueue = [];
    for (const t of list) {
      if (t.sc && t.scId && t.musicKey == null && !t._keyAsked && t.bpm) {
        t._keyAsked = true;
        this._scKeyQueue.push(t);
      }
    }
    if (this._scKeyRunning) return;
    this._scKeyRunning = true;
    (async () => {
      try {
        while (this._scKeyQueue.length) {
          while (this.cb.canAnalyze && !this.cb.canAnalyze()) {
            await new Promise((r) => setTimeout(r, 1500));
          }
          const t = this._scKeyQueue.shift();
          if (t.musicKey != null) continue;
          const key = trackKey(t);
          if (this.cache[key] && this.cache[key].musicKey != null) {
            t.musicKey = this.cache[key].musicKey;
            this.cb.onTrackUpdated(t);
            continue;
          }
          const p = await window.api.scCachedPath(t.scId).catch(() => null);
          if (!p) continue;
          try {
            const buffer = await this._decode(p);
            const k = await detectKey(buffer);
            if (!k) continue;
            const c = this.cache[key] || { v: 1 };
            c.musicKey = k.code;
            this.cache[key] = c;
            t.musicKey = k.code;
            this._scheduleSave();
            this.cb.onTrackUpdated(t);
          } catch { /* unreadable file: never mind */ }
        }
      } finally {
        this._scKeyRunning = false;
      }
    })();
  }

  // Real color preview (from the deck's peaks) as soon as a track is
  // loaded — replaces the quick / SoundCloud preview
  setPreviewFromPeaks(track, peaks) {
    const key = trackKey(track);
    const c = this.cache[key] || { v: 1 };
    if (c.preview && !c.previewQ) return;
    const url = previewFromPeaks(peaks);
    if (!url) return;
    c.preview = url;
    c.previewQ = false;
    this.cache[key] = c;
    track.preview = url;
    track.previewQ = false;
    this._scheduleSave();
    this.cb.onTrackUpdated(track);
  }

  async _decode(path) {
    const raw = await window.api.readFile(path);
    const ab = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
    return this.audioCtx.decodeAudioData(ab);
  }

  // Loads the track (SoundCloud download if needed, then full decode).
  // isCancelled(): another track was requested on this deck in the meantime — we
  // bail out as early as possible (before decoding, before analysis…)
  async loadForDeck(track, onProgress, isCancelled = () => false) {
    const stop = () => {
      if (isCancelled()) {
        const e = new Error('Loading cancelled');
        e.cancelled = true;
        throw e;
      }
    };
    if (track.sc && !track.path) {
      if (onProgress) onProgress(i18n('sc_downloading'));
      // The account tagged on the track goes with it: its own Go+/private tracks
      const res = await window.api.scFetchTrack(track.scId, track.acctIdx);
      stop();
      if (!res.ok) throw new Error(res.error);
      track.path = res.path;
      // 30 s preview clip (Go+ track without a subscribed account): WARN, and
      // do not burn a clip's BPM into the analysis cache
      if (res.full === false) {
        track.snippet = true;
        this.cb.onStatus(res.warning || i18n('preview_30s_connect'));
      }
    }
    if (onProgress) onProgress(i18n('reading_file'));
    const raw = await window.api.readFile(track.path);
    stop(); // cancelled while reading the file: don't even decode
    if (onProgress) onProgress(i18n('decoding'));
    const buffer = await this.audioCtx.decodeAudioData(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
    stop();
    let { bpm, beatOffset } = track;
    // Freshness is checked in the central CACHE, not in the track's
    // snapshot (history / playlist entries carried an
    // analyzed:true that blocked re-analysis forever)
    const cachedNow = this.cache[trackKey(track)];
    const fresh = cachedNow && cachedNow.v >= ANALYSIS_V && cachedNow.bpm != null;
    if (fresh) {
      bpm = cachedNow.bpm;
      beatOffset = cachedNow.beatOffset != null ? cachedNow.beatOffset : beatOffset;
      track.bpm = bpm;
      track.beatOffset = beatOffset;
    }
    if (!fresh || bpm == null) {
      if (onProgress) onProgress(i18n('analyzing_bpm_progress'));
      const res = await detectBPM(buffer, this._range());
      stop();
      const prev = this.cache[trackKey(track)] || {};
      const keepBpm = (prev.manualBpm || prev.manual || prev.manualOffset ||
        prev.gridShift != null || prev.barAnchor != null || prev.rb) && prev.bpm != null;
      bpm = keepBpm ? prev.bpm : (res ? res.bpm : null);
      beatOffset = keepBpm && prev.beatOffset != null ? prev.beatOffset : (res ? res.beatOffset : null);
      const newBeats = keepBpm && prev.beats ? prev.beats : (res ? res.beats : null);
      const newAnchor = !keepBpm && res ? res.barAnchor || 0 : prev.barAnchorAuto || 0;
      track.bpm = bpm;
      track.beatOffset = beatOffset;
      track.duration = buffer.duration;
      track.analyzed = true;
      // 30 S PREVIEW CLIP: its grid and BPM are WORTHLESS for the real
      // track — do not burn them into the cache, otherwise the track
      // would stay wrong even after the subscribed account is connected
      if (!track.snippet) {
        this.cache[trackKey(track)] = { ...prev, v: ANALYSIS_V, bpm, beatOffset, beats: newBeats, barAnchorAuto: newAnchor, duration: buffer.duration };
        this._scheduleSave();
      } else {
        track.analyzed = false; // to re-analyze once the full track is obtained
      }
      this.cb.onTrackUpdated(track);
    }
    const cached = this.cache[trackKey(track)] || {};
    // Imported Rekordbox grid: realigned ONCE onto our decoder's
    // timeline (LAME mp3s are ~51 ms apart between decoders — otherwise the
    // beat lines land just next to the kicks)
    if (cached.rb && !cached.rbAligned && cached.beats && cached.beats.length > 8) {
      const { beats: shifted, shift } = alignImportedGrid(buffer, cached.beats);
      if (shift) {
        cached.beats = shifted;
        cached.beatOffset = shifted[0];
        beatOffset = shifted[0];
        track.beatOffset = beatOffset;
      }
      cached.rbAligned = true;
      this.cache[trackKey(track)] = cached;
      this._scheduleSave();
    }
    // KEY: known → right away; otherwise computed IN THE BACKGROUND
    // (the track is playable without waiting) then announced to the deck
    if (cached.musicKey != null) {
      track.musicKey = cached.musicKey;
    } else if (!track.snippet && !isCancelled()) {
      detectKey(buffer).then((k) => {
        if (!k) return;
        const c = this.cache[trackKey(track)] || { v: 2 };
        c.musicKey = k.code;
        this.cache[trackKey(track)] = c;
        track.musicKey = k.code;
        this._scheduleSave();
        this.cb.onTrackUpdated(track);
        if (this.cb.onKeyDetected) this.cb.onKeyDetected(track, k.code);
      }).catch(() => {});
    }
    return {
      buffer,
      bpm,
      beatOffset,
      musicKey: cached.musicKey ?? null,
      hotCues: cached.hotCues || [],
      beats: cached.beats || null,
      gridShift: cached.gridShift || 0,
      // manual GRID takes priority, otherwise the detected anchor (downbeat/phrase)
      barAnchor: cached.barAnchor != null ? cached.barAnchor : (cached.barAnchorAuto || 0)
    };
  }

  // Full track data for the USB export (grid, cues…)
  exportData(track) {
    const c = this.cache[trackKey(track)] || {};
    return {
      path: track.path || null,
      name: track.name,
      duration: c.duration || track.duration || null,
      bpm: c.bpm || track.bpm || null,
      beats: c.beats || null,
      hotCues: c.hotCues || null
    };
  }

  // Manual shift / anchoring of the dynamic grid (◀ ▶ arrows and GRID)
  setGridMeta(track, { gridShift, barAnchor }) {
    const key = trackKey(track);
    const c = this.cache[key] || { v: ANALYSIS_V };
    if (gridShift != null) c.gridShift = gridShift;
    if (barAnchor != null) c.barAnchor = barAnchor;
    c.manual = true; // manual adjustment: re-analysis must no longer overwrite it
    this.cache[key] = c;
    this._scheduleSave();
  }

  // Full grid replacement (÷2 / ×2 on a dynamic grid)
  setGridData(track, { beats, barAnchor, bpm }) {
    track.bpm = bpm;
    const key = trackKey(track);
    const c = this.cache[key] || { v: ANALYSIS_V };
    c.beats = beats;
    c.barAnchor = barAnchor || 0;
    c.bpm = bpm;
    c.v = ANALYSIS_V;
    c.manualBpm = true;
    this.cache[key] = c;
    this._scheduleSave();
    this.cb.onTrackUpdated(track);
  }

  // Stores the hot cues set on this track
  setHotCues(track, cues) {
    const key = trackKey(track);
    const c = this.cache[key] || { v: 2, bpm: track.bpm, duration: track.duration, beatOffset: track.beatOffset };
    c.hotCues = cues;
    this.cache[key] = c;
    this._scheduleSave();
  }

  // Stores a BPM octave correction (grid ÷2 / ×2) for this track
  setBpmValue(track, bpm) {
    track.bpm = bpm;
    const key = trackKey(track);
    const c = this.cache[key] || { v: ANALYSIS_V, duration: track.duration, beatOffset: track.beatOffset };
    c.bpm = bpm;
    c.v = ANALYSIS_V;
    c.manualBpm = true; // manual correction: preserved across re-analyses
    this.cache[key] = c;
    this._scheduleSave();
    this.cb.onTrackUpdated(track);
  }

  // Stores the manual grid realignment (GRID button) for this track
  setBeatOffset(track, offset) {
    track.beatOffset = offset;
    const key = trackKey(track);
    const c = this.cache[key] || { v: ANALYSIS_V, bpm: track.bpm, duration: track.duration };
    c.beatOffset = offset;
    c.v = ANALYSIS_V;
    c.manualOffset = true; // manual anchoring: preserved, the BPM can still be refined
    this.cache[key] = c;
    this._scheduleSave();
  }

  // FORCED re-analysis: clears manual corrections and redoes everything
  async reanalyze(track) {
    if (!track.path) throw new Error(i18n('load_track_first'));
    const buffer = await this._decode(track.path);
    const res = await detectBPM(buffer, this._range());
    if (!res) throw new Error(i18n('track_analysis_failed'));
    const key = trackKey(track);
    const c = this.cache[key] || {};
    delete c.manual;
    delete c.manualBpm;
    delete c.manualOffset;
    delete c.gridShift;
    delete c.barAnchor;
    delete c.rb; // explicit re-analysis of the track: start over from our own calculation
    c.v = ANALYSIS_V;
    c.bpm = res.bpm;
    c.beatOffset = res.beatOffset;
    c.beats = res.beats || null;
    c.barAnchorAuto = res.barAnchor || 0;
    c.duration = buffer.duration;
    const k = await detectKey(buffer).catch(() => null);
    if (k) {
      c.musicKey = k.code;
      track.musicKey = k.code;
    }
    this.cache[key] = c;
    track.bpm = res.bpm;
    track.beatOffset = res.beatOffset;
    track.analyzed = true;
    this._scheduleSave();
    this.cb.onTrackUpdated(track);
    return res;
  }

  _scheduleSave() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      window.api.cacheSave(this.cache);
    }, 800);
  }

  // On CLOSE: if a debounced save is pending, write it
  // SYNCHRONOUSLY — otherwise an adjustment made < 800 ms before quitting was lost
  flushSave() {
    if (!this._saveTimer) return;
    clearTimeout(this._saveTimer);
    this._saveTimer = null;
    if (window.api.cacheSaveSync) window.api.cacheSaveSync(this.cache);
  }
}
