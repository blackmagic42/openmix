// Bibliothèque à deux sources : fichiers locaux et SoundCloud.
// Analyse BPM + beat grid en arrière-plan (avec cache), sélection au
// clavier / à la manette, chargement vers un deck.

import { detectBPM, alignImportedGrid } from './bpm.js';
import { computeBandPeaks } from './waveform.js';
import { detectKey, camelot } from './key.js';
import { t as i18n } from './i18n.js';

// Mini-aperçu waveform coloré (RGB par fréquences) encodé en dataURL
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

// Même aperçu, mais tiré des pics DÉJÀ calculés pour le deck (aucun
// recalcul : le chargement d'un morceau produit son vrai aperçu gratuitement)
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

// APERÇU RAPIDE d'un fichier local SANS l'analyse complète : décodage
// directement en 11 kHz (rééchantillonné hors du fil principal par le
// navigateur — 4× moins de mémoire qu'un décodage normal) puis deux filtres
// à un pôle pour la couleur basses/médiums/aigus. Assez léger pour tourner
// PENDANT le mix : la bibliothèque montre la forme des sons sans les charger.
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
    // rend la main de temps en temps : jamais de gel de l'interface
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

// Aperçu d'une piste SOUNDCLOUD à partir de la forme d'onde que SoundCloud
// publie lui-même (quelques Ko, aucun téléchargement du son) : amplitude
// seule — teinte bleue, l'aperçu complet en couleurs arrive au chargement.
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
    // Les masters modernes sont « en brique » (presque tout à fond) : la
    // courbe au cube fait ressortir breaks et montées au lieu d'un bloc plein
    const r = Math.pow(v / max, 3);
    // plus c'est fort, plus c'est clair (le relief du morceau d'un coup d'oeil)
    ctx.fillStyle = `rgb(${Math.round(40 + 140 * r)},${Math.round(110 + 110 * r)},${Math.round(230 + 25 * r)})`;
    const h = Math.max(1, r * (H * 0.48));
    ctx.fillRect(x, mid - h, 1, h * 2);
  }
  return c.toDataURL('image/png');
}

// --- TRI de la liste (clic sur un en-tête de colonne) ---
// Les lignes de navigation (dossiers, playlists, comptes…) restent en tête,
// dans leur ordre ; seuls les MORCEAUX sont triés.
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
  // ordre de la roue Camelot : 1A 1B 2A 2B … 12B
  key: (t) => {
    const c = camelot(t.musicKey);
    return c ? c.num * 2 + (c.letter === 'B' ? 1 : 0) : null;
  }
};

const trackKey = (t) => t.key || (t.sc ? `sc:${t.scId}` : `${t.path}|${t.size}|${Math.round(t.mtime)}`);

// Version de l'algorithme d'analyse : l'augmenter force la ré-analyse
// (les corrections manuelles et les aperçus sont toujours conservés)
// v12 = analyse par sections (basses/chill) : ré-ancrage à chaque reprise
const ANALYSIS_V = 13;

export class Library {
  constructor(audioCtx, callbacks) {
    this.audioCtx = audioCtx;
    this.cb = callbacks; // { onListChanged, onTrackUpdated, onStatus }
    this.mode = 'local'; // 'local' | 'sc' | 'hist'
    this.tracks = [];    // fichiers locaux
    this.scTracks = [];  // pistes ou playlists SoundCloud
    this.history = [];   // derniers morceaux joués
    this.playlists = []; // playlists créées par l'utilisateur
    this.plOpen = null;  // playlist actuellement ouverte
    this.scTitle = null;
    // Multi-comptes SoundCloud (b2b) : la vue courante appartient toujours à
    // UN compte (scAcctIdx) et chaque compte garde sa liste de playlists en
    // cache pour que ⬅ retombe sur LES SIENNES, pas celles du pote
    this.scAcctIdx = 0;
    this.scPlaylistsByAcct = {};
    this.scAccountsView = false; // la vue « liste des comptes » est affichée
    this.scAccountCount = 0;     // rafraîchi par refreshScStatus (app.js)
    this.filtered = [];
    this.selection = 0;
    this.search = '';
    this.cache = {};
    this.played = {};    // sons joués PENDANT CETTE SÉANCE (clé → date), voir isTaken
    this._scanId = 0;
    this._saveTimer = null;
    // tri choisi en cliquant sur les en-têtes (mémorisé)
    this.sort = { col: null, dir: 1 };
    try {
      const sv = JSON.parse(localStorage.getItem('libSort'));
      if (sv && SORTERS[sv.col]) this.sort = { col: sv.col, dir: sv.dir === -1 ? -1 : 1 };
    } catch { /* tri par défaut */ }
    this._previewBusy = false;
    this._scWaveQueue = [];
    this._scWaveRunning = 0;
  }

  // Clic sur un en-tête : tri croissant → décroissant → ordre d'origine
  toggleSort(col) {
    if (this.sort.col !== col) this.sort = { col, dir: 1 };
    else if (this.sort.dir === 1) this.sort = { col, dir: -1 };
    else this.sort = { col: null, dir: 1 };
    try { localStorage.setItem('libSort', JSON.stringify(this.sort)); } catch { /* rien */ }
    const cur = this.filtered[this.selection];
    this.applyFilter();
    // la sélection suit le morceau, pas sa position
    const ni = cur ? this.filtered.indexOf(cur) : -1;
    if (ni >= 0 && ni !== this.selection) {
      this.selection = ni;
      this.cb.onListChanged();
    }
  }

  // Reprend du cache central tout ce qu'on sait déjà d'un morceau
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

  // Plage BPM d'analyse choisie dans les paramètres (défaut : 85-170)
  _range() {
    const r = localStorage.getItem('bpmRange') || '85-170';
    if (r === 'auto') return { lo: 85, hi: 170 };
    const [a, b] = r.split('-').map(Number);
    return a && b ? { lo: a, hi: b } : { lo: 85, hi: 170 };
  }

  // Invalide toutes les analyses (changement de plage BPM, par exemple).
  // Les grilles importées de Rekordbox sont conservées : elles sont la
  // référence, pas un calcul à refaire.
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

  // Importe les grilles de battements calculées par Rekordbox (fichiers ANLZ
  // sur ce PC). Correspondance par nom de fichier, départage par durée.
  // La grille importée devient la référence du morceau (flag rb) : la
  // ré-analyse ne l'écrase plus, mais GRID / ÷2×2 manuels restent prioritaires.
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
      // Le dernier temps ne peut pas dépasser la fin du fichier : sinon ce
      // n'est pas le même morceau (homonyme d'une autre version)
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
      // La grille Rekordbox REMPLACE beats : les calages manuels relatifs à
      // l'ANCIEN tableau n'ont plus de sens — on les efface (invariant :
      // gridShift/barAnchor sont toujours relatifs au beats sauvegardé)
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
    // VUE RACINES (« de base ») : SoundCloud, Playlists et les racines du
    // PC — le point de départ de la balade à l'encodeur, comme la colonne
    // de gauche. Les noms des racines portent déjà leur icône.
    if (this.rootsView) {
      return [
        { scRootRow: true, name: 'SoundCloud' },
        { plRootRow: true, name: 'Playlists' },
        ...(this.fsDirs || []).map(d => ({ fsRow: true, path: d.path, name: d.native ? i18n('dl_native_root') : d.name }))
      ];
    }
    // Mode local : ligne « .. » (remonter) puis sous-dossiers navigables
    // AU-DESSUS des morceaux — même un dossier vide reste navigable
    const dirRows = (this.fsDirs || []).map(d => ({
      fsRow: true,
      path: d.path,
      name: `📁 ${d.name}`
    }));
    if (this.fsDir) dirRows.unshift({ fsUpRow: true, name: i18n('parent_folder') });
    return dirRows.length ? [...dirRows, ...this.tracks] : this.tracks;
  }

  // Revenir au POINT DE DÉPART de la navigation (racines du PC + SoundCloud
  // + Playlists) — là où RETOUR finit toujours par ramener
  async showRoots() {
    this._scanId++; // coupe un scan en cours
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
    // Les marques « déjà joué » ne valent QUE pour la séance en cours : à
    // chaque lancement, tout repart en blanc (demande David). On nettoie
    // l'ancienne version permanente si elle traîne dans le cache.
    this.played = {};
    delete this.cache.__played;
    this._refoldOctaves();
    this.playlists = this.cache.__playlists || [];
    this.plOpen = null;
    const last = this.cache.__folder;
    if (last) await this.scan(last);
    else await this.showRoots(); // premier lancement : la balade commence aux racines
  }

  // UNE FOIS : les analyses déjà en cache au-dessus du plafond d'octave
  // (double tempo, ex. Bon Appétit lu 212 au lieu de 106 — voir FOLD_HI dans
  // bpm.js) sont remises à analyser. Un BPM saisi / ÷2×2 à la main et les
  // grilles Rekordbox sont respectés ; les retouches de calage (◀ ▶, GRID)
  // faites sur une grille au double tempo n'ont plus de sens : effacées.
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
      c.v = 2; // BPM gardé à l'affichage, ré-analyse au prochain passage
      n++;
    }
    this.cache.__octFold = 1;
    if (n) console.log(`[midi] analyse : ${n} sons au double tempo remis à analyser`);
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
      // Compte SoundCloud d'origine : le téléchargement en dur d'une piste
      // privée/Go+ doit repartir avec LE MÊME jeton
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

  // Historique : appelé à chaque chargement d'un morceau sur un deck
  // Morceaux DÉJÀ JOUÉS PENDANT CETTE SÉANCE (chargés sur un deck depuis
  // le lancement d'OpenMix) : écrits en vert dans l'explorateur. Rien n'est
  // gardé d'une séance à l'autre : à la relance, tout est de nouveau blanc.
  isTaken(t) {
    if (!t || !t.name) return false;
    return !!this.played[trackKey(t)];
  }

  // Un fichier a été RANGÉ ailleurs (déplacé ou copié) : son analyse (BPM,
  // grille, cues, tonalité) le suit sous sa nouvelle clé, et les playlists /
  // l'historique pointent vers le nouvel emplacement s'il a été déplacé
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

  // Fichier déplacé / renommé hors de la vue (dossier déplacé, renommé…) :
  // { from, to, size, mtime } — son analyse, ses playlists suivent
  relocateMoved(m) {
    const name = String(m.to).split(/[\\/]/).pop().replace(/\.[^.]+$/, '');
    this.relocateTrack({ path: m.from, size: m.size, mtime: m.mtime },
      { path: m.to, size: m.size, mtime: m.mtime, moved: true, name });
  }

  // Retirer la marque d'un morceau (clic droit) ou de tous
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
    this.played[entry.key] = entry.at; // marque « déjà joué » permanente
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
    // Navigation façon Rekordbox : les SOUS-DOSSIERS s'affichent en tête de
    // liste (l'encodeur y entre, RETOUR remonte au dossier parent)
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
    // La vue appartient désormais à ce compte : ⬅ et les téléchargements
    // repartiront avec SON jeton. Si on change de compte sans connaître ses
    // playlists, on oublie celles de l'ancien — ⬅ ne doit jamais afficher
    // les playlists du pote sous le mauvais nom
    const switching = this.scAcctIdx !== acctIdx;
    this.scAcctIdx = acctIdx;
    this.scAccountsView = false;
    if (this.scPlaylistsByAcct[acctIdx]) this.scPlaylists = this.scPlaylistsByAcct[acctIdx];
    else if (switching) this.scPlaylists = null;
    if (res.kind === 'user') {
      const rows = res.playlists.map(p => ({ ...p, acctIdx }));
      this.scTracks = rows;
      this.scPlaylists = rows;
      this.scTitle = `Playlists de ${res.title}`;
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
      // Récupère ce qu'on sait déjà (BPM, tonalité, aperçu) du cache
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

  // Recherche dans TOUT le catalogue SoundCloud — au-delà des playlists.
  // Les résultats se chargent/streament comme n'importe quelle piste SC.
  async searchSc(query) {
    this.cb.onStatus(i18n('sc_searching', { query }));
    // La recherche part avec le jeton du compte COURANT : un résultat Go+
    // doit se télécharger avec le bon compte, pas en anonyme
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
    // BPM, tonalité et aperçus déjà connus récupérés du cache
    for (const t of this.scTracks) this._fromCache(t);
    this._queueScWaves(this.scTracks);
    this.scTitle = `Recherche : ${query}`;
    this.search = ''; // les résultats ne doivent pas être re-filtrés localement
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
      // ordre stable ; les valeurs inconnues (BPM pas encore analysé…) en fin
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
    // Historique / playlists : leurs entrées gardaient l'aperçu (souvent
    // vide ou bleu) du moment où elles ont été ajoutées — on les remet à
    // jour depuis le cache et on complète les couleurs manquantes
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

  // Retour ⬅ dans l'onglet SoundCloud — 3 niveaux en b2b : pistes d'une
  // playlist → playlists du compte courant → liste des comptes (et seulement
  // 2 niveaux comme avant quand il n'y a qu'un compte)
  scBack() {
    if (this.scAccountsView) return false; // déjà tout en haut
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

  // Liste des comptes SoundCloud connectés — le niveau RACINE de l'onglet
  // quand on mixe en b2b (≥ 2 comptes) : chacun retrouve SES sons chez lui
  async loadScAccounts() {
    const s = await window.api.scStatus();
    const accounts = (s && s.accounts) || [];
    this.scAccountCount = accounts.length;
    this.scTracks = accounts.map((a, i) => ({
      scAccountRow: true,
      acctIdx: i,
      name: `${a.name || `Compte ${i + 1}`}${a.expired ? ' (reconnecter)' : ''}`
    }));
    this.scAccountsView = true;
    this.scTitle = 'Comptes SoundCloud';
    this.setMode('sc');
    this.selection = 0;
    this.applyFilter();
    this.cb.onStatus(i18n('sc_accounts_status', { n: accounts.length }));
    return true;
  }

  // Playlists du compte SoundCloud demandé (défaut : compte 0 = comme avant)
  async loadScMine(acctIdx = 0) {
    this.cb.onStatus(i18n('sc_fetching_playlists'));
    const res = await window.api.scMyPlaylists(acctIdx);
    if (!res.ok) {
      this.cb.onStatus(i18n('sc_error', { error: res.error }));
      return res;
    }
    // Chaque ligne (❤️ Likes comprise) est taguée avec SON compte : le bon
    // jeton suivra la playlist jusqu'au téléchargement des pistes
    const rows = res.playlists.map(p => ({ ...p, acctIdx }));
    this.scAcctIdx = acctIdx;
    this.scAccountsView = false;
    this.scPlaylistsByAcct[acctIdx] = rows;
    this.scTracks = rows;
    this.scPlaylists = rows;
    this.scTitle = `Playlists de ${res.username}`;
    this.setMode('sc');
    this.selection = 0;
    this.applyFilter();
    this.cb.onStatus(i18n('sc_user_playlists_status', { n: rows.length, user: res.username }));
    return res;
  }

  // Les sons LIKÉS du compte demandé, présentés comme une playlist
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
    // ⬅ doit retomber sur les playlists de CE compte (ou rien si inconnues)
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
    // En b2b on précise À QUI sont ces likes — en solo, libellé historique
    this.scTitle = (this.scAccountCount >= 2 && res.username)
      ? `❤ Likes de ${res.username}`
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

  // POCHETTE d'un morceau : lue une fois (tags du fichier ou jaquette
  // SoundCloud), réduite en 64 px et mémorisée dans le cache — null aussi
  // mémorisé (on ne relit pas un fichier sans pochette à chaque chargement)
  async coverFor(track) {
    const key = trackKey(track);
    const c = this.cache[key];
    // On ne fait confiance qu'au cache POSITIF : un null mémorisé se
    // re-tente (une jaquette peut apparaître après coup, ex. artwork SC)
    if (c && c.cover) return c.cover;
    // SoundCloud : la JAQUETTE en ligne d'abord — le mp3 téléchargé du
    // cache n'a pas de tags, il masquait la pochette
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
      } catch { /* pas de pochette */ }
    }
    const entry = this.cache[key] || { v: 2 };
    entry.cover = url;
    this.cache[key] = entry;
    this._scheduleSave();
    return url;
  }

  // ANALYSE PARALLÈLE : plusieurs morceaux traités EN MÊME TEMPS, un par
  // « voie ». Décodage et filtrage tournent dans les threads natifs de
  // Chromium : à 3 voies, une machine multi-cœurs analyse une bibliothèque
  // ~3× plus vite qu'en file indienne. Plafonné pour ne pas saturer la RAM
  // (chaque morceau décodé pèse plusieurs dizaines de Mo).
  async _analyzeQueue(scanId) {
    const cores = navigator.hardwareConcurrency || 4;
    const voies = Math.max(1, Math.min(3, Math.floor(cores / 2)));
    let next = 0;
    const state = { save: Date.now() };
    const suivant = () => {
      while (next < this.tracks.length) {
        const t = this.tracks[next++];
        if (!(t.analyzed && t.preview && !t.previewQ) || (t.musicKey == null && !t.keyTried)) return t;
      }
      return null;
    };
    await Promise.all(
      Array.from({ length: voies }, () => this._analyzeVoie(scanId, suivant, state))
    );
    if (scanId === this._scanId) this._scheduleSave();
  }

  async _analyzeVoie(scanId, suivant, state) {
    let sinceLastSave = state; // horodatage partagé entre les voies
    for (let t = suivant(); t; t = suivant()) {
      if (scanId !== this._scanId) return;
      // JAMAIS d'analyse pendant qu'un deck joue : les décodages + détection
      // BPM saturaient le CPU → « le son lag ». L'analyse attend sagement et
      // reprend toute seule dès que la lecture s'arrête (comme Demucs).
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
          // Les corrections manuelles (÷2×2) et les grilles Rekordbox
          // importées sont préservées, le reste profite de la grille fraîche
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
        // TONALITÉ (une fois par morceau, gardée en cache)
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
        // Sauvegarde AU PLUS toutes les 60 s : le cache complet (jusqu'à
        // plusieurs dizaines de Mo) repartait sur le disque tous les 5
        // morceaux et se disputait la tête de lecture avec les fichiers en
        // cours d'analyse. La fermeture reste couverte par flushSave().
        if (Date.now() - sinceLastSave.save > 60000) {
          sinceLastSave.save = Date.now();
          this._scheduleSave();
        }
        this.cb.onTrackUpdated(t);
      } catch {
        t.analyzed = true; // fichier illisible : on n'insiste pas
        t.keyTried = true;
      }
      // (on ne compte que l'ANALYSE : une preview ratée sur fichier illisible
      // ne doit pas afficher « 1 restants » pour l'éternité)
      const remaining = this.tracks.filter(x => !x.analyzed).length;
      this.cb.onStatus(remaining
        ? i18n('library_analyzing_status', { n: this.tracks.length, remaining })
        : i18n('library_analysis_done', { n: this.tracks.length }));
    }
  }

  // APERÇUS RAPIDES des fichiers locaux — y compris PENDANT le mix (l'analyse
  // complète, elle, attend que plus rien ne joue). Un morceau à la fois,
  // avec une pause entre deux quand ça joue : le son passe toujours avant.
  async _previewQueue(scanId) {
    this._previewWant = scanId;
    if (this._previewBusy) return; // la boucle en cours relancera pour ce dossier
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
        } catch { /* fichier illisible : l'analyse le signalera */ }
        const busy = this.cb.canAnalyze && !this.cb.canAnalyze();
        await new Promise((r) => setTimeout(r, busy ? 700 : 30));
      }
      this._scheduleSave();
    } finally {
      this._previewBusy = false;
      // un autre dossier a été ouvert pendant la boucle : on le traite
      if (this._previewWant === this._scanId && this._previewWant !== scanId) {
        this._previewQueue(this._scanId);
      }
    }
  }

  // Formes d'onde SOUNDCLOUD (publiées par SoundCloud, quelques Ko chacune)
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
            t.preview = c.preview; // la couleur était déjà là
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

  // VRAIES COULEURS (basses / médiums / aigus) pour les pistes SoundCloud
  // déjà écoutées : leur son complet est dans le cache, on en tire l'aperçu
  // rapide comme pour un fichier du PC — y compris pendant le mix, une piste
  // à la fois. (La forme d'onde publiée par SoundCloud n'a que l'amplitude :
  // c'est elle qui restait toute bleue.)
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
            // un vrai aperçu (morceau déjà chargé sur un deck) reste prioritaire
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
          } catch { /* fichier illisible */ }
          const busy = this.cb.canAnalyze && !this.cb.canAnalyze();
          await new Promise((r) => setTimeout(r, busy ? 600 : 20));
        }
      } finally {
        this._scColorRunning = false;
      }
    })();
  }

  // TONALITÉ des pistes SoundCloud déjà écoutées (son complet en cache) :
  // calculée quand plus rien ne joue, comme l'analyse des fichiers du PC
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
          } catch { /* fichier illisible : tant pis */ }
        }
      } finally {
        this._scKeyRunning = false;
      }
    })();
  }

  // Vrai aperçu en couleurs (tiré des pics du deck) dès qu'un morceau est
  // chargé — remplace l'aperçu rapide / SoundCloud
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

  // Charge le morceau (téléchargement SoundCloud si besoin, puis décodage complet).
  // isCancelled() : un autre son a été demandé sur ce deck entre-temps — on
  // abandonne au plus tôt (avant le décodage, avant l'analyse…)
  async loadForDeck(track, onProgress, isCancelled = () => false) {
    const stop = () => {
      if (isCancelled()) {
        const e = new Error('Chargement annulé');
        e.cancelled = true;
        throw e;
      }
    };
    if (track.sc && !track.path) {
      if (onProgress) onProgress(i18n('sc_downloading'));
      // Le compte tagué sur la piste part avec elle : ses Go+/privées à lui
      const res = await window.api.scFetchTrack(track.scId, track.acctIdx);
      stop();
      if (!res.ok) throw new Error(res.error);
      track.path = res.path;
      // Extrait de 30 s (piste Go+ sans compte abonné) : on PRÉVIENT, et on
      // ne grave pas le BPM d'un extrait dans le cache d'analyse
      if (res.full === false) {
        track.snippet = true;
        this.cb.onStatus(res.warning || i18n('preview_30s_connect'));
      }
    }
    if (onProgress) onProgress(i18n('reading_file'));
    const raw = await window.api.readFile(track.path);
    stop(); // annulé pendant la lecture du fichier : on ne décode même pas
    if (onProgress) onProgress(i18n('decoding'));
    const buffer = await this.audioCtx.decodeAudioData(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
    stop();
    let { bpm, beatOffset } = track;
    // La fraîcheur se vérifie dans le CACHE central, pas dans l'instantané du
    // morceau (les entrées d'historique / de playlists portaient un
    // analyzed:true qui bloquait la ré-analyse pour toujours)
    const cachedNow = this.cache[trackKey(track)];
    const fresh = cachedNow && cachedNow.v >= ANALYSIS_V && cachedNow.bpm != null;
    if (fresh) {
      bpm = cachedNow.bpm;
      beatOffset = cachedNow.beatOffset != null ? cachedNow.beatOffset : beatOffset;
      track.bpm = bpm;
      track.beatOffset = beatOffset;
    }
    if (!fresh || bpm == null) {
      if (onProgress) onProgress('Analyse BPM…');
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
      // EXTRAIT DE 30 S : sa grille et son BPM ne valent RIEN pour le vrai
      // morceau — on ne les grave pas dans le cache, sinon le morceau
      // resterait faussé même après connexion du compte abonné
      if (!track.snippet) {
        this.cache[trackKey(track)] = { ...prev, v: ANALYSIS_V, bpm, beatOffset, beats: newBeats, barAnchorAuto: newAnchor, duration: buffer.duration };
        this._scheduleSave();
      } else {
        track.analyzed = false; // à réanalyser une fois le morceau entier obtenu
      }
      this.cb.onTrackUpdated(track);
    }
    const cached = this.cache[trackKey(track)] || {};
    // Grille Rekordbox importée : recalage UNE FOIS sur la timeline de notre
    // décodeur (les mp3 LAME ont ~51 ms d'écart entre décodeurs — sinon les
    // traits tombent juste à côté des kicks)
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
    // TONALITÉ : connue → tout de suite ; sinon calculée EN TÂCHE DE FOND
    // (le morceau est jouable sans attendre) puis annoncée au deck
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
      // GRID manuel prioritaire, sinon l'ancre détectée (downbeat/phrase)
      barAnchor: cached.barAnchor != null ? cached.barAnchor : (cached.barAnchorAuto || 0)
    };
  }

  // Données complètes d'un morceau pour l'export USB (grille, cues…)
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

  // Décalage / ancrage manuels de la grille dynamique (flèches ◀ ▶ et GRID)
  setGridMeta(track, { gridShift, barAnchor }) {
    const key = trackKey(track);
    const c = this.cache[key] || { v: ANALYSIS_V };
    if (gridShift != null) c.gridShift = gridShift;
    if (barAnchor != null) c.barAnchor = barAnchor;
    c.manual = true; // calage manuel : la ré-analyse ne doit plus l'écraser
    this.cache[key] = c;
    this._scheduleSave();
  }

  // Remplacement complet de la grille (÷2 / ×2 sur grille dynamique)
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

  // Mémorise les hot cues posés sur ce morceau
  setHotCues(track, cues) {
    const key = trackKey(track);
    const c = this.cache[key] || { v: 2, bpm: track.bpm, duration: track.duration, beatOffset: track.beatOffset };
    c.hotCues = cues;
    this.cache[key] = c;
    this._scheduleSave();
  }

  // Mémorise une correction d'octave du BPM (grille ÷2 / ×2) pour ce morceau
  setBpmValue(track, bpm) {
    track.bpm = bpm;
    const key = trackKey(track);
    const c = this.cache[key] || { v: ANALYSIS_V, duration: track.duration, beatOffset: track.beatOffset };
    c.bpm = bpm;
    c.v = ANALYSIS_V;
    c.manualBpm = true; // correction manuelle : préservée lors des ré-analyses
    this.cache[key] = c;
    this._scheduleSave();
    this.cb.onTrackUpdated(track);
  }

  // Mémorise le recalage manuel de la grille (bouton GRID) pour ce morceau
  setBeatOffset(track, offset) {
    track.beatOffset = offset;
    const key = trackKey(track);
    const c = this.cache[key] || { v: ANALYSIS_V, bpm: track.bpm, duration: track.duration };
    c.beatOffset = offset;
    c.v = ANALYSIS_V;
    c.manualOffset = true; // ancrage manuel : préservé, le BPM peut se raffiner
    this.cache[key] = c;
    this._scheduleSave();
  }

  // Ré-analyse FORCÉE : efface les corrections manuelles et refait tout
  async reanalyze(track) {
    if (!track.path) throw new Error(i18n('load_track_first'));
    const buffer = await this._decode(track.path);
    const res = await detectBPM(buffer, this._range());
    if (!res) throw new Error('Analyse impossible sur ce morceau');
    const key = trackKey(track);
    const c = this.cache[key] || {};
    delete c.manual;
    delete c.manualBpm;
    delete c.manualOffset;
    delete c.gridShift;
    delete c.barAnchor;
    delete c.rb; // ré-analyse explicite du morceau : on repart de notre calcul
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

  // À la FERMETURE : si une sauvegarde débouncée est en attente, on l'écrit
  // en SYNCHRONE — sinon un calage fait < 800 ms avant de quitter était perdu
  flushSave() {
    if (!this._saveTimer) return;
    clearTimeout(this._saveTimer);
    this._saveTimer = null;
    if (window.api.cacheSaveSync) window.api.cacheSaveSync(this.cache);
  }
}
