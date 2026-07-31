// Contrôleurs MIDI (DDJ Pioneer et n'importe quelle platine USB-MIDI).
// Pas de driver à installer : les contrôleurs DJ sont des périphériques MIDI
// standard, reçus via l'API Web MIDI de Chromium.
//
// - Préréglage Pioneer DDJ intégré (détecté par le nom du périphérique)
// - Apprentissage MIDI : n'importe quel bouton/fader/knob physique peut être
//   lié à n'importe quelle action, mémorisé PAR contrôleur (nom du device).

export const ABS_ACTIONS = new Set([
  'volume', 'trim', 'eqHigh', 'eqMid', 'eqLow', 'filter', 'tempo',
  'crossfader', 'masterVol', 'masterFilter', 'fxLevel'
]);
export const REL_ACTIONS = new Set(['jog', 'jogBend', 'browse', 'browseZoom']);

export const MIDI_ACTIONS_DECK = [
  ['play', 'Play / Pause'],
  ['cue', 'CUE (maintenir = pré-écoute)'],
  ['sync', 'SYNC'],
  ['master', 'MASTER'],
  ['grid', 'GRID (recaler)'],
  ['load', 'Charger le morceau sélectionné'],
  ['volume', 'Fader volume'],
  ['trim', 'TRIM'],
  ['eqHigh', 'EQ aigus'],
  ['eqMid', 'EQ médiums'],
  ['eqLow', 'EQ graves'],
  ['filter', 'FILTER (color)'],
  ['tempo', 'Fader tempo'],
  ['jog', 'Jog DESSUS (scratch / déplacer)'],
  ['jogBend', 'Jog CÔTÉ (nudge doux, caler à l\'oreille)'],
  ['jogTouch', 'TOUCHER du disque (pose = coupe, relâche = reprend)'],
  ['padHotcue', 'Mode pads : HOT CUE'],
  ['padJump', 'Mode pads : BEAT JUMP'],
  ['padLoop', 'Mode pads : LOOP'],
  ['padKey', 'Mode pads : KEY'],
  ['padFx', 'Mode pads : PAD FX'],
  ['padSmp', 'Mode pads : SAMPLER'],
  ['pad1', 'Pad 1'], ['pad2', 'Pad 2'], ['pad3', 'Pad 3'], ['pad4', 'Pad 4'],
  ['pad5', 'Pad 5'], ['pad6', 'Pad 6'], ['pad7', 'Pad 7'], ['pad8', 'Pad 8'],
  ['loopIn', 'Loop IN (départ de boucle)'],
  ['loopOut', 'Loop OUT (ferme et lance)'],
  ['reloop', 'RELOOP / EXIT'],
  ['fxOn', 'FX ON/OFF (unité du deck)'],
  ['keyUp', 'KEY + (demi-ton)'],
  ['keyDn', 'KEY − (demi-ton)'],
  ['select', 'CHANNEL SELECT — position de ce deck']
];

export const MIDI_ACTIONS_GLOBAL = [
  ['crossfader', 'Crossfader'],
  ['browse', 'Parcourir la bibliothèque (encodeur)'],
  ['browsePush', 'Encodeur APPUI : entrer dans la playlist / charger'],
  ['browseBack', 'RETOUR : sortir de la playlist'],
  ['viewToggle', 'VIEW : masquer / réafficher la bibliothèque'],
  ['masterVol', 'Volume MASTER'],
  ['masterFilter', 'FILTER MASTER'],
  ['fxLevel', 'Niveau FX (knob)'],
  ['fxBeatsDn', 'FX : durée du beat ÷2 (BEAT ◄)'],
  ['fxBeatsUp', 'FX : durée du beat ×2 (BEAT ►)'],
  ['selectMaster', 'CHANNEL SELECT — position MASTER'],
  ['bpmUp', 'BPM master +0,5'],
  ['bpmDn', 'BPM master −0,5']
];

export class MidiManager {
  constructor(actions) {
    this.actions = actions; // { press(action, deck, on), abs(action, deck, v01), rel(action, deck, delta) }
    this.access = null;
    this.deviceName = null;
    this.output = null;    // premier port de sortie (compat)
    this.outputs = [];     // TOUTES les sorties : LED et vumètres de la platine
    this._outNames = '';
    this.feedback = false; // ÉMISSION COUPÉE : la FLX6 écho-ait nos LED en appuis fantômes
    this._kaTimer = null;  // keep-alive Pioneer (retiré — voir send())
    this._monCount = 0;    // limiteur du moniteur (le keep-alive fait répondre la platine)
    this._monStamp = 0;
    this.map = {};
    this.learning = null;
    this.monitor = false;
    this.monitorAll = false; // production : aucun log par geste
    this.onStatus = () => {};
    this._ledState = new Map(); // dernier état envoyé (n'émet que les changements)
    this._vuState = new Map();
  }

  // --- RETOUR VERS LA PLATINE — DÉSACTIVÉ (this.feedback = false) ---
  // La FLX6 RENVOIE EN ÉCHO les notes qu'on lui envoie : chaque « LED »
  // émise revenait comme un APPUI FANTÔME (channel select qui saute au
  // deck 1, play/boucles qui se déclenchent tout seuls — « tu as cassé le
  // logiciel »). Tant qu'on n'a pas le protocole propriétaire rekordbox,
  // on N'ÉMET RIEN vers la platine. Ne réactiver qu'avec un filtre
  // anti-écho ET le protocole validé.
  _sendRaw(bytes) {
    if (!this.outputs || !this.outputs.length) return;
    // TOUTE émission (keep-alive, LED, vumètre) peut déclencher une
    // RE-DÉCLARATION d'état de la platine : on ouvre la fenêtre de
    // suppression à chaque envoi (les vrais gestes, continus, passent par
    // l'exemption d'activité ; les artefacts isolés sont avalés)
    this._kaSentAt = performance.now();
    for (const o of this.outputs) {
      try {
        o.send(bytes);
      } catch (e) {
        if (!this._sendErrLogged) {
          this._sendErrLogged = true;
          console.log(`[midi] ÉCHEC d'envoi vers ${o.name}: ${String(e)}`);
        }
      }
    }
  }

  send(bytes) {
    if (!this.feedback) return;
    this._sendRaw(bytes);
  }

  // --- ANTI-ÉCHO : la FLX6 peut renvoyer en entrée les notes qu'on lui
  // émet (historique : LED → appuis fantômes, « channel select qui saute »).
  // Chaque triplet émis est mémorisé 250 ms ; s'il revient à l'identique
  // dans ce délai, c'est NOTRE écho → avalé avant tout traitement.
  _pushEcho(bytes) {
    if (!this._echoQ) this._echoQ = [];
    this._echoQ.push({ k: `${bytes[0]},${bytes[1]},${bytes[2] || 0}`, t: performance.now() });
    if (this._echoQ.length > 128) this._echoQ.shift();
  }

  _isEcho(status, d1, d2) {
    if (!this._echoQ || !this._echoQ.length) return false;
    const now = performance.now();
    // Un écho USB revient en QUELQUES millisecondes : fenêtre de 25 ms,
    // même note (velocity ignorée — l'écho peut être ré-encodé). L'ancienne
    // fenêtre de 250 ms sur triplet identique AVALAIT les VRAIS re-appuis :
    // la LED play (note 11, vel 127) armait le piège et l'appui suivant —
    // même note, même vélocité — était pris pour un écho (« délai avant de
    // pouvoir rappuyer »). 25 ms = imbattable pour un humain, large pour
    // l'USB.
    while (this._echoQ.length && now - this._echoQ[0].t > 25) this._echoQ.shift();
    const kShort = `${status},${d1},`;
    for (let i = 0; i < this._echoQ.length; i++) {
      if (this._echoQ[i].k.startsWith(kShort)) {
        this._echoQ.splice(i, 1);
        return true;
      }
    }
    return false;
  }

  // LED d'un bouton (protocole Pioneer, confirmé par le mapping Mixxx :
  // on renvoie LA NOTE DU BOUTON en sortie, velocity 127 = allumé, 0 =
  // éteint). Émission directe protégée par l'anti-écho ci-dessus — c'est
  // LA voie officielle des LED, le flag feedback ne la bloque plus.
  setLed(ch, note, on) {
    const k = `${ch}:${note}`;
    const v = on ? 1 : 0;
    if (this._ledState.get(k) === v) return;
    this._ledState.set(k, v);
    const bytes = [0x90 | ch, note, on ? 0x7f : 0];
    this._pushEcho(bytes);
    this._sendRaw(bytes);
  }

  // Vumètre d'une tranche (Pioneer DDJ : CC 2 du canal du deck, 0-127).
  // SEUL retour autorisé vers la platine : un CC (pas une note), et CC2
  // entrant n'est mappé sur AUCUNE action — même si la platine l'écho-ait,
  // zéro appui fantôme possible (contrairement aux LED de boutons).
  setVu(ch, v01) {
    // FORTEMENT ralenti (200 ms mini par tranche) : CHAQUE émission fait
    // re-déclarer son état à la platine — en continu, elle saturait et
    // PERDAIT des appuis de boutons (CUE muet, relâchers perdus)
    const nowV = performance.now();
    if (!this._vuAt) this._vuAt = new Map();
    if (nowV - (this._vuAt.get(ch) || 0) < 200) return;
    const v = Math.max(0, Math.min(127, Math.round(v01 * 127)));
    const prev = this._vuState.get(ch);
    if (prev != null && Math.abs(prev - v) < 6 && v !== 0 && v !== 127) return;
    this._vuAt.set(ch, nowV);
    this._vuState.set(ch, v);
    this._sendRaw([0xB0 | ch, 2, v]);
  }

  async init() {
    if (!navigator.requestMIDIAccess) return false;
    try {
      // SysEx demandé : certaines platines (Pioneer récentes) ne pilotent
      // leurs LED qu'après une trame de réveil constructeur
      this.access = await navigator.requestMIDIAccess({ sysex: true });
    } catch {
      try {
        this.access = await navigator.requestMIDIAccess({ sysex: false });
      } catch {
        return false;
      }
    }
    console.log(`[midi] accès sysex: ${this.access.sysexEnabled ? 'OUI' : 'NON (le keep-alive Pioneer ne peut pas partir)'}`);
    const hook = () => {
      let first = null;
      for (const input of this.access.inputs.values()) {
        if (!first) first = input;
        input.onmidimessage = (e) => this._onMsg(e.data);
      }
      // Ports de SORTIE : LED et vumètres partent vers TOUTES les sorties
      // (certaines platines exposent plusieurs ports — on ne devine plus)
      const outs = [...this.access.outputs.values()];
      const names = outs.map((o) => o.name).join(' | ');
      if (names !== this._outNames) {
        this._outNames = names;
        this.outputs = outs;
        this.output = outs[0] || null;
        this._ledState.clear();
        this._vuState.clear();
        if (outs.length) console.log(`[midi] sorties: ${names}`);
        // Ouverture EXPLICITE : sous Windows un port pris par une autre
        // appli échoue silencieusement — ici on le voit au journal
        outs.forEach((o) => {
          o.open().then(() => {
            console.log(`[midi] sortie OUVERTE: ${o.name} (state=${o.state}, connection=${o.connection})`);
          }).catch((e) => {
            console.log(`[midi] sortie REFUSÉE: ${o.name} — ${String(e)}`);
          });
        });
        // KEEP-ALIVE PÉRIODIQUE (500 ms) — INDISPENSABLE : sans hôte qui lui
        // parle, la FLX6 désactive certains contrôles, dont LE CROSSFADER
        // (prouvé : muet au câble en écoute passive, vivant sous rekordbox).
        // L'ancien chaos (« l'app ré-applique tout 2×/s ») est réglé par la
        // FENÊTRE DE SUPPRESSION dans _onMsg : les 80 ms qui suivent chaque
        // envoi, les CC absolus entrants (= la RE-DÉCLARATION des positions)
        // sont ignorés ; les vrais gestes, continus, passent entre les pulsations.
        clearInterval(this._kaTimer);
        if (outs.length) {
          const KA = [0xF0, 0x00, 0x40, 0x05, 0x00, 0x00, 0x04, 0x05, 0x00, 0x50, 0x02, 0xF7];
          this._kaSentAt = performance.now();
          this._sendRaw(KA);
          this._kaTimer = setInterval(() => {
            this._kaSentAt = performance.now();
            this._sendRaw(KA);
          }, 500);
        }
      }
      const name = first ? first.name : null;
      if (name !== this.deviceName) {
        this.deviceName = name;
        if (name) {
          console.log(`[midi] device: ${name}`);
          this._loadMap();
        }
      }
      this.onStatus(name);
    };
    this.access.onstatechange = hook;
    hook();
    return true;
  }

  _key(type, ch, d1) {
    return `${type}:${ch}:${d1}`;
  }

  _loadMap() {
    let saved = null;
    try {
      saved = JSON.parse(localStorage.getItem(`midiMap:${this.deviceName}`));
    } catch { /* pas de mapping sauvegardé */ }
    const isPioneer = /ddj|pioneer/i.test(this.deviceName || '');
    if (saved && saved.__v === MidiManager.PRESET_V) {
      this.map = saved.map || {};
    } else {
      // Préréglage neuf (ou version obsolète) : on repart du preset à jour —
      // les liens re-appris via ⚙ écrasent ensuite ce qu'ils veulent
      this.map = isPioneer ? MidiManager.ddjPreset() : {};
      this._saveMap();
    }
  }

  _saveMap() {
    if (this.deviceName) {
      localStorage.setItem(`midiMap:${this.deviceName}`,
        JSON.stringify({ __v: MidiManager.PRESET_V, map: this.map }));
    }
  }

  // Apprentissage : la prochaine action physique (appui / mouvement) est capturée
  learn(action, deck) {
    this.cancelLearn();
    return new Promise((resolve) => {
      this.learning = { action, deck, resolve };
    });
  }

  cancelLearn() {
    if (this.learning) {
      this.learning.resolve(null);
      this.learning = null;
    }
  }

  bindingFor(action, deck) {
    for (const [k, v] of Object.entries(this.map)) {
      if (v.action === action && v.deck === deck) return k;
    }
    return null;
  }

  clearBinding(action, deck) {
    for (const k of Object.keys(this.map)) {
      if (this.map[k].action === action && this.map[k].deck === deck) delete this.map[k];
    }
    this._saveMap();
  }

  _onMsg(data) {
    const [status, d1, d2 = 0] = data;
    const type = status & 0xF0;
    const ch = status & 0x0F;
    if (type !== 0x90 && type !== 0x80 && type !== 0xB0 && type !== 0xE0) return;
    // Écho d'une LED qu'on vient d'émettre : avalé AVANT tout traitement.
    // (rappel diagnostic : toute trace renderer doit commencer par [midi] —
    // main.js filtre le reste)
    if ((type === 0x90 || type === 0x80) && this._isEcho(status, d1, d2)) return;
    // RELEVÉ INTÉGRAL temporaire (diagnostic jog droit) : TOUT est logué,
    // mappé ou non, plafonné à 8 lignes/s
    if (this.monitorAll) {
      const nowS = Math.floor(Date.now() / 1000);
      if (nowS !== this._monStamp) {
        this._monStamp = nowS;
        this._monCount = 0;
      }
      if (this._monCount < 40) { // calibration : haute fidélité temporaire
        this._monCount += 1;
        console.log(`[midi] TOUT: type=0x${type.toString(16)} ch=${ch} d1=${d1} d2=${d2}`);
      }
    }
    // Pitch bend (0xE0) : d1/d2 = valeur 14 bits — la "note" est fixe (0)
    const normType = type === 0x80 ? 0x90 : type; // note-off = note-on relâché
    const key = type === 0xE0 ? this._key(0xE0, ch, 0) : this._key(normType, ch, d1);

    if (this.learning) {
      // On capture appuis et mouvements, pas les relâchers
      if (type === 0x80 || (type === 0x90 && d2 === 0)) return;
      // Supprime l'ancien lien de cette action puis enregistre le nouveau
      for (const k of Object.keys(this.map)) {
        if (this.map[k].action === this.learning.action && this.map[k].deck === this.learning.deck) {
          delete this.map[k];
        }
      }
      this.map[key] = { action: this.learning.action, deck: this.learning.deck };
      this._saveMap();
      this.learning.resolve(key);
      this.learning = null;
      return;
    }

    const b = this.map[key];
    // MONITEUR : on ne logue plus QUE les contrôles NON MAPPÉS (les logs de
    // chaque geste passaient par le pipe IPC et faisaient ramer le son)
    if (!b) {
      if (this.monitor && !(type === 0x90 && d2 === 0) && !(type === 0x80)) {
        // limité à 8 logs/s : la platine répond au keep-alive par des rafales
        const nowS = Math.floor(Date.now() / 1000);
        if (nowS !== this._monStamp) {
          this._monStamp = nowS;
          this._monCount = 0;
        }
        if (this._monCount < 8) {
          this._monCount += 1;
          console.log(`[midi] non mappé : type=0x${type.toString(16)} ch=${ch} d1=${d1} d2=${d2}`);
        }
      }
      return;
    }
    if (type === 0xE0) {
      // pitch bend 14 bits → absolu 0..1 (faders tempo, certains filters)
      if (ABS_ACTIONS.has(b.action)) {
        this.actions.abs(b.action, b.deck, (d2 * 128 + d1) / 16383);
      }
      return;
    }
    if (type === 0xB0) {
      if (ABS_ACTIONS.has(b.action)) {
        // FENÊTRE DE SUPPRESSION INTELLIGENTE : dans les 80 ms qui suivent
        // un keep-alive, la platine RE-DÉCLARE ses positions (state
        // refresh) — on ne jette ces CC QUE si le contrôle était INACTIF.
        // Un vrai geste est un flux continu (< 300 ms entre messages) : il
        // passe INTÉGRALEMENT. L'ancienne fenêtre aveugle avalait ~16 % des
        // mouvements → « des fois il ne détecte pas le volume/fader ».
        const nowP = performance.now();
        if (!this._absLast) this._absLast = new Map();
        const lastP = this._absLast.get(key);
        this._absLast.set(key, nowP);
        if (this._kaSentAt && nowP - this._kaSentAt < 80
            && !(lastP !== undefined && nowP - lastP < 300)) return;
        this.actions.abs(b.action, b.deck, d2 / 127);
      } else if (REL_ACTIONS.has(b.action)) {
        // Même bouclier que les ABS : une re-déclaration d'état peut
        // contenir des CRANS DE JOG non centrés — depuis que le dessus
        // DÉPLACE la position, chaque artefact faisait un micro-seek
        // (« un micro décalage à chaque fois »). Un vrai geste est un flux
        // continu : il passe intégralement.
        const nowR = performance.now();
        if (!this._absLast) this._absLast = new Map();
        const lastR = this._absLast.get(key);
        this._absLast.set(key, nowR);
        if (this._kaSentAt && nowR - this._kaSentAt < 80
            && !(lastR !== undefined && nowR - lastR < 300)) return;
        // DEUX encodages relatifs existent : les JOGS Pioneer sont centrés
        // sur 64 (65 = +1 doux, 63 = −1), les encodeurs browse en
        // complément à deux (1 = +1, 127 = −1). Confondre les deux inversait
        // le sens ET détruisait la précision du geste.
        let delta = b.action.startsWith('jog')
          ? d2 - 64
          : (d2 < 64 ? d2 : d2 - 128);
        // Le dessus « vinyl OFF » (CC35) a une résolution 2× plus fine que
        // le « vinyl ON » (CC34) : sans normalisation, un des deux jogs
        // plafonnait 6× plus bas en vitesse (relevés : ±4 contre ±8)
        if (d1 === 35) delta *= 2;
        this.actions.rel(b.action, b.deck, delta);
      } else if (d2 > 0) {
        this.actions.press(b.action, b.deck, true);
      } else {
        this.actions.press(b.action, b.deck, false);
      }
    } else {
      this.actions.press(b.action, b.deck, type === 0x90 && d2 > 0);
    }
  }

  // Version du préréglage : l'augmenter régénère le mapping des appareils
  static PRESET_V = 38;

  // Base Pioneer DDJ 4 VOIES — relevée EN DIRECT sur la DDJ-FLX6 de David :
  // canaux 0-3 = decks 1-4 (transport, EQ, volume, tempo), canal 6 = mixer
  // (FILTRES CC 23-26, crossfader, browse), canal 4 = section FX
  static ddjPreset() {
    const m = {};
    for (let d = 0; d < 4; d++) {
      // TABLE FINALE (vérifiée par DOUBLE inversion en direct avec David) :
      // PLAY = note 11, CUE = note 14. L'ancien « PLAY réel = 14 » était
      // FAUX — et comme 11 ET 14 pointaient toutes deux sur play, le play
      // marchait par accident et le CUE lançait le son. Ne plus JAMAIS
      // mapper 11 et 14 sur la même action : l'erreur devient invisible.
      m[`144:${d}:11`] = { action: 'play', deck: d };
      m[`144:${d}:14`] = { action: 'cue', deck: d };
      m[`144:${d}:12`] = { action: 'cue', deck: d };
      m[`144:${d}:88`] = { action: 'sync', deck: d };
      m[`144:${d}:16`] = { action: 'loopIn', deck: d };
      m[`144:${d}:17`] = { action: 'loopOut', deck: d };
      m[`144:${d}:77`] = { action: 'reloop', deck: d };
      m[`176:${d}:0`] = { action: 'tempo', deck: d };
      m[`176:${d}:19`] = { action: 'volume', deck: d };
      m[`176:${d}:4`] = { action: 'trim', deck: d };
      m[`176:${d}:7`] = { action: 'eqHigh', deck: d };
      m[`176:${d}:11`] = { action: 'eqMid', deck: d };
      m[`176:${d}:15`] = { action: 'eqLow', deck: d };
      // Jog — DOCTRINE FINALE : les CC 33/34/35 (les dialectes varient d'un
      // jog à l'autre, et une prise de main peut en émettre PLUSIEURS) vont
      // TOUS sur 'jog' ; c'est le CAPTEUR DE TOUCHER (note 54) qui décide :
      // main posée = SCRATCH pur (le tempo n'est jamais touché), main non
      // posée (tranche) = calage léger. Valeurs centrées 64 : > 64 = avancer.
      // TRANCHE (CC33) = micro-calage à l'oreille (bend doux, ne déplace
      // pas) ; DESSUS (CC34/35) = 'jog' : toucher posé → scratch, sans
      // toucher → DÉPLACEMENT dans le son (jamais un changement de BPM —
      // « au lieu de se déplacer tu changes le BPM » : corrigé ici)
      m[`176:${d}:33`] = { action: 'jogBend', deck: d };
      m[`176:${d}:34`] = { action: 'jog', deck: d };
      m[`176:${d}:35`] = { action: 'jog', deck: d };
      m[`144:${d}:54`] = { action: 'jogTouch', deck: d };
      // FILTRES (CFX) : sur le CANAL MIXER 6, CC 23 à 26 (relevé FLX6)
      m[`176:6:${23 + d}`] = { action: 'filter', deck: d };
    }
    // Spec officielle Pioneer (DDJ-FLX6 MIDI Message List) : chaque jog est
    // par CANAL DE DECK — CC34 = dessus vinyl, CC35 = dessus sans vinyl,
    // CC33 = tranche, note 54 = toucher. Rien d'autre à router.
    // Sections FX (canal 4 = gauche, canal 5 = droite) : ON + niveau —
    // la note 71 des DEUX canaux est bien le bouton FX (confirmé par David)
    for (const fc of [4, 5]) {
      m[`144:${fc}:71`] = { action: 'fxOn', deck: null };
      // Niveau FX : le gros knob MERGE FX émet une PAIRE 14 bits —
      // CC2 = valeur (128 crans, largement assez) et CC34 = fraction fine
      // qui défile en DENTS DE SCIE (77→1→28…). Ne mapper QUE CC2 :
      // mapper CC34 (seul ou en plus) fait sauter la jauge de 60 %.
      m[`176:${fc}:2`] = { action: 'fxLevel', deck: null };
      // BEAT ◄ / ► (relevé FLX6 : notes 6 et 7) : durée du FX ÷2 / ×2
      m[`144:${fc}:6`] = { action: 'fxBeatsDn', deck: null };
      m[`144:${fc}:7`] = { action: 'fxBeatsUp', deck: null };
    }
    // CHANNEL SELECT (relevé FLX6) : un bouton par section (gauche = canal 4,
    // droite = canal 5), mêmes notes — la platine envoie une note DIFFÉRENTE
    // par position. Le CYCLE MATÉRIEL SAUTE : 1 → 2 → 4 → MASTER → 3 → 1…
    // (dixit David, « en étant sur master je reviens à 3 »). Notes dans
    // l'ordre des appuis : 28, 29, 31, 20, 30 — ancrées sur position 1 = 28.
    for (const sc of [4, 5]) {
      m[`144:${sc}:28`] = { action: 'select', deck: 0 };       // position 1
      m[`144:${sc}:29`] = { action: 'select', deck: 1 };       // position 2
      m[`144:${sc}:31`] = { action: 'select', deck: 3 };       // position 4
      m[`144:${sc}:20`] = { action: 'selectMaster', deck: null }; // MASTER
      m[`144:${sc}:30`] = { action: 'select', deck: 2 };       // position 3
    }
    // Pads performance — canaux OFFICIELS (spec Pioneer + mapping Mixxx) :
    // deck 1 = canal 7, deck 2 = 9, deck 3 = 11, deck 4 = 13 ; les canaux
    // PAIRS suivants (8/10/12/14) sont les MÊMES pads avec SHIFT. L'ancien
    // [7,9,8,10] routait SHIFT+pad des decks 1/2 vers les decks 3/4 !
    // La NOTE dépend du MODE matériel : HOT CUE 0-7, PAD FX 16-23,
    // BEAT JUMP 32-39, SAMPLER 48-55, BEAT LOOP 96-103 — toutes routées
    // sur pad1-8 : le bouton de mode (ci-dessous) aligne l'onglet du deck,
    // qui décide de l'action. SHIFT+pad = effacer (hot cue / sample).
    const padCh = [7, 9, 11, 13];
    const padBase = [0, 16, 32, 48, 96];
    for (let d = 0; d < 4; d++) {
      for (let p = 0; p < 8; p++) {
        for (const base of padBase) {
          m[`144:${padCh[d]}:${base + p}`] = { action: `pad${p + 1}`, deck: d };
          m[`144:${padCh[d] + 1}:${base + p}`] = { action: `padDel${p + 1}`, deck: d };
        }
      }
      // Boutons de MODE des pads (sur le canal du deck, spec officielle) :
      // ils changent l'onglet du deck à l'écran — HOT CUE 27, PAD FX1 30,
      // PAD FX2 107, BEAT JUMP 32, SAMPLER 34, BEAT LOOP 109,
      // KEYBOARD 105 et KEY SHIFT 111 → onglet KEY
      // SHIFT (capturé en direct : note 63 sur le canal du deck) — l'état
      // est suivi côté app (browse ×10, CUE = retour début, SYNC OFF…) ;
      // pads et boutons de mode ont déjà leur couche SHIFT matérielle
      m[`144:${d}:63`] = { action: 'shift', deck: d };
      // SHIFT+CUE (couche matérielle, capturée : note 72) = retour au début
      m[`144:${d}:72`] = { action: 'cueBack', deck: d };
      m[`144:${d}:27`] = { action: 'padHotcue', deck: d };
      m[`144:${d}:30`] = { action: 'padFx', deck: d };
      m[`144:${d}:107`] = { action: 'padFx', deck: d };
      m[`144:${d}:32`] = { action: 'padJump', deck: d };
      m[`144:${d}:34`] = { action: 'padSmp', deck: d };
      m[`144:${d}:109`] = { action: 'padLoop', deck: d };
      m[`144:${d}:105`] = { action: 'padKey', deck: d };
      m[`144:${d}:111`] = { action: 'padKey', deck: d };
    }
    // LOAD (canal 6, notes 70-73)
    for (let d = 0; d < 4; d++) {
      m[`144:6:${70 + d}`] = { action: 'load', deck: d };
    }
    // CC 8 ch6 = KNOB MASTER (vérifié par David : mappé crossfader il
    // faisait bouger le crossfader depuis le master). VOLUME MASTER :
    m['176:6:8'] = { action: 'masterVol', deck: null };
    // CROSSFADER = CC 31 ch6 (LSB 63 ignoré) — mapping d'ORIGINE, comme la
    // version du dépôt git où il fonctionnait. COMPRÉHENSION FINALE : aux
    // touchers de jog, la platine RE-DÉCLARE la position PHYSIQUE réelle du
    // fader (state refresh) — si l'écran a été bougé à la souris, il « saute »
    // vers la vérité matérielle : comportement normal d'un fader physique,
    // PAS un parasite. Ne JAMAIS filtrer/garder/remapper ce contrôle.
    m['176:6:31'] = { action: 'crossfader', deck: null };
    m['176:6:64'] = { action: 'browse', deck: null };
    // SHIFT + molette (capturé en direct : la platine bascule sur CC 100) :
    // zoom / dézoom des vagues
    m['176:6:100'] = { action: 'browseZoom', deck: null };
    // Encodeur bibliothèque (relevé FLX6) : APPUI = entrer/charger (note 65),
    // bouton RETOUR = sortir de la playlist (note 101)
    m['144:6:65'] = { action: 'browsePush', deck: null };
    m['144:6:101'] = { action: 'browseBack', deck: null };
    m['144:6:122'] = { action: 'viewToggle', deck: null };
    // (pas de masterVol MIDI : le knob MASTER de la FLX6 est analogique)
    return m;
  }
}
