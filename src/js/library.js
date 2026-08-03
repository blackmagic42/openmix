// Bibliothèque à deux sources : fichiers locaux et SoundCloud.
// Analyse BPM + beat grid en arrière-plan (avec cache), sélection au
// clavier / à la manette, chargement vers un deck.

import { detectBPM, alignImportedGrid } from './bpm.js';
import { computeBandPeaks } from './waveform.js';

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
    this._scanId = 0;
    this._saveTimer = null;
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
        { scRootRow: true, name: '☁️ SoundCloud' },
        { plRootRow: true, name: '🎛 Playlists' },
        ...(this.fsDirs || []).map(d => ({ fsRow: true, path: d.path, name: d.name }))
      ];
    }
    // Mode local : ligne « .. » (remonter) puis sous-dossiers navigables
    // AU-DESSUS des morceaux — même un dossier vide reste navigable
    const dirRows = (this.fsDirs || []).map(d => ({
      fsRow: true,
      path: d.path,
      name: `📁 ${d.name}`
    }));
    if (this.fsDir) dirRows.unshift({ fsUpRow: true, name: '⬅ ‥ (dossier parent)' });
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
    this.cb.onStatus('Racines — encodeur pour entrer, RETOUR pour ressortir');
  }

  async init() {
    this.cache = (await window.api.cacheLoad()) || {};
    this.history = this.cache.__history || [];
    this.playlists = this.cache.__playlists || [];
    this.plOpen = null;
    const last = this.cache.__folder;
    if (last) await this.scan(last);
    else await this.showRoots(); // premier lancement : la balade commence aux racines
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
      analyzed: true,
      at: Date.now()
    };
    this.history = this.history.filter(h => h.key !== entry.key);
    this.history.unshift(entry);
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
    this.cb.onStatus(`Scan de ${dir}…`);
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
        preview: ok ? cached.preview || null : null,
        analyzed: !!fresh
      };
    });
    this.applyFilter();
    this.cb.onStatus(`${this.tracks.length} morceaux — analyse BPM en cours…`);
    this._analyzeQueue(scanId);
  }

  // ---------------------------------------------------------------------
  // SoundCloud
  // ---------------------------------------------------------------------

  async loadScUrl(url, acctIdx = this.scAcctIdx ?? 0) {
    this.cb.onStatus('Connexion à SoundCloud…');
    const res = await window.api.scResolve(url, acctIdx);
    if (!res.ok) {
      this.cb.onStatus(`SoundCloud : ${res.error}`);
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
      // Récupère les BPM déjà en cache (pistes déjà chargées une fois)
      for (const t of this.scTracks) {
        const cached = this.cache[trackKey(t)];
        if (cached && cached.v >= 2) {
          t.bpm = cached.bpm;
          t.beatOffset = cached.beatOffset;
          t.analyzed = cached.v >= ANALYSIS_V;
        }
      }
      this.scTitle = res.title;
    }
    this.cache.__scUrl = url;
    this._scheduleSave();
    this.setMode('sc');
    this.selection = 0;
    this.applyFilter();
    this.cb.onStatus(`SoundCloud : ${this.scTitle} — ${this.scTracks.length} éléments`);
    return true;
  }

  // Recherche dans TOUT le catalogue SoundCloud — au-delà des playlists.
  // Les résultats se chargent/streament comme n'importe quelle piste SC.
  async searchSc(query) {
    this.cb.onStatus(`SoundCloud : recherche « ${query} »…`);
    // La recherche part avec le jeton du compte COURANT : un résultat Go+
    // doit se télécharger avec le bon compte, pas en anonyme
    const acctIdx = this.scAcctIdx ?? 0;
    const res = await window.api.scSearch(query, acctIdx);
    if (!res.ok) {
      this.cb.onStatus(`SoundCloud : ${res.error}`);
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
    // BPM déjà connus (pistes déjà chargées une fois) récupérés du cache
    for (const t of this.scTracks) {
      const cached = this.cache[trackKey(t)];
      if (cached && cached.v >= 2) {
        t.bpm = cached.bpm;
        t.beatOffset = cached.beatOffset;
        t.analyzed = cached.v >= ANALYSIS_V;
      }
    }
    this.scTitle = `Recherche : ${query}`;
    this.search = ''; // les résultats ne doivent pas être re-filtrés localement
    this.setMode('sc');
    this.selection = 0;
    this.applyFilter();
    this.cb.onStatus(`SoundCloud : ${this.scTracks.length} résultats pour « ${query} » — Entrée pour relancer, ← pour tes playlists`);
    return true;
  }

  // ---------------------------------------------------------------------

  applyFilter() {
    const q = this.search.trim().toLowerCase();
    const src = this.list();
    this.filtered = q
      ? src.filter(t => t.name.toLowerCase().includes(q))
      : src;
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
      name: `👤 ${a.name || `Compte ${i + 1}`}${a.expired ? ' (reconnecter)' : ''}`
    }));
    this.scAccountsView = true;
    this.scTitle = 'Comptes SoundCloud';
    this.setMode('sc');
    this.selection = 0;
    this.applyFilter();
    this.cb.onStatus(`${accounts.length} comptes SoundCloud — double-clic (ou Rond/B) pour entrer, clic droit pour retirer`);
    return true;
  }

  // Playlists du compte SoundCloud demandé (défaut : compte 0 = comme avant)
  async loadScMine(acctIdx = 0) {
    this.cb.onStatus('Récupération de tes playlists SoundCloud…');
    const res = await window.api.scMyPlaylists(acctIdx);
    if (!res.ok) {
      this.cb.onStatus(`SoundCloud : ${res.error}`);
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
    this.cb.onStatus(`${rows.length} playlists de ${res.username} — double-clic (ou Rond/B) pour en ouvrir une`);
    return res;
  }

  // Les sons LIKÉS du compte demandé, présentés comme une playlist
  async loadScLikes(acctIdx = 0) {
    this.cb.onStatus('Récupération de tes likes SoundCloud…');
    const res = await window.api.scMyLikes(acctIdx);
    if (!res.ok) {
      this.cb.onStatus(`SoundCloud : ${res.error}`);
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
    for (const t of this.scTracks) {
      const cached = this.cache[trackKey(t)];
      if (cached && cached.v >= 2) {
        t.bpm = cached.bpm;
        t.beatOffset = cached.beatOffset;
        t.analyzed = cached.v >= ANALYSIS_V;
      }
    }
    // En b2b on précise À QUI sont ces likes — en solo, libellé historique
    this.scTitle = (this.scAccountCount >= 2 && res.username)
      ? `❤️ Likes de ${res.username}`
      : '❤️ Likes';
    this.setMode('sc');
    this.selection = 0;
    this.applyFilter();
    this.cb.onStatus(`SoundCloud : ${this.scTracks.length} sons likés`);
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
        if (!(t.analyzed && t.preview)) return t;
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
        if (!t.preview) t.preview = await makePreview(buffer);
        t.analyzed = true;
        this.cache[trackKey(t)] = { ...prev, v: ANALYSIS_V, bpm: t.bpm, beatOffset: t.beatOffset, beats: newBeats, barAnchorAuto: newAnchor, duration: t.duration, preview: t.preview };
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
      }
      // (on ne compte que l'ANALYSE : une preview ratée sur fichier illisible
      // ne doit pas afficher « 1 restants » pour l'éternité)
      const remaining = this.tracks.filter(x => !x.analyzed).length;
      this.cb.onStatus(remaining
        ? `${this.tracks.length} morceaux — analyse : ${remaining} restants…`
        : `${this.tracks.length} morceaux — analyse terminée`);
    }
  }

  async _decode(path) {
    const raw = await window.api.readFile(path);
    const ab = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
    return this.audioCtx.decodeAudioData(ab);
  }

  // Charge le morceau (téléchargement SoundCloud si besoin, puis décodage complet).
  async loadForDeck(track, onProgress) {
    if (track.sc && !track.path) {
      if (onProgress) onProgress('Téléchargement SoundCloud…');
      // Le compte tagué sur la piste part avec elle : ses Go+/privées à lui
      const res = await window.api.scFetchTrack(track.scId, track.acctIdx);
      if (!res.ok) throw new Error(res.error);
      track.path = res.path;
      // Extrait de 30 s (piste Go+ sans compte abonné) : on PRÉVIENT, et on
      // ne grave pas le BPM d'un extrait dans le cache d'analyse
      if (res.full === false) {
        track.snippet = true;
        this.cb.onStatus(res.warning || 'Extrait 30 s — connecte le compte SoundCloud abonné');
      }
    }
    if (onProgress) onProgress('Décodage…');
    const buffer = await this._decode(track.path);
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
    return {
      buffer,
      bpm,
      beatOffset,
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
    if (!track.path) throw new Error('Charge d’abord le morceau (il doit être téléchargé)');
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
