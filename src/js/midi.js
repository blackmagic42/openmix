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
export const REL_ACTIONS = new Set(['jog', 'jogBend', 'browse']);

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
  ['selectMaster', 'CHANNEL SELECT — position MASTER'],
  ['bpmUp', 'BPM master +0,5'],
  ['bpmDn', 'BPM master −0,5']
];

export class MidiManager {
  constructor(actions) {
    this.actions = actions; // { press(action, deck, on), abs(action, deck, v01), rel(action, deck, delta) }
    this.access = null;
    this.deviceName = null;
    this.map = {};
    this.learning = null;
    this.monitor = false; // diagnostic (contrôles non mappés) — coupé en production
    this.onStatus = () => {};
  }

  async init() {
    if (!navigator.requestMIDIAccess) return false;
    try {
      this.access = await navigator.requestMIDIAccess({ sysex: false });
    } catch {
      return false;
    }
    const hook = () => {
      let first = null;
      for (const input of this.access.inputs.values()) {
        if (!first) first = input;
        input.onmidimessage = (e) => this._onMsg(e.data);
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
        console.log(`[midi] non mappé : type=0x${type.toString(16)} ch=${ch} d1=${d1} d2=${d2}`);
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
        this.actions.abs(b.action, b.deck, d2 / 127);
      } else if (REL_ACTIONS.has(b.action)) {
        // DEUX encodages relatifs existent : les JOGS Pioneer sont centrés
        // sur 64 (65 = +1 doux, 63 = −1), les encodeurs browse en
        // complément à deux (1 = +1, 127 = −1). Confondre les deux inversait
        // le sens ET détruisait la précision du geste.
        const delta = b.action.startsWith('jog')
          ? d2 - 64
          : (d2 < 64 ? d2 : d2 - 128);
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
  static PRESET_V = 10;

  // Base Pioneer DDJ 4 VOIES — relevée EN DIRECT sur la DDJ-FLX6 de David :
  // canaux 0-3 = decks 1-4 (transport, EQ, volume, tempo), canal 6 = mixer
  // (FILTRES CC 23-26, crossfader, browse), canal 4 = section FX
  static ddjPreset() {
    const m = {};
    for (let d = 0; d < 4; d++) {
      m[`144:${d}:11`] = { action: 'play', deck: d };
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
      // Jog : DESSUS (CC 33, scratch / déplacement) et CÔTÉ (CC 34, nudge
      // doux) — David avait les deux surfaces INVERSÉES avec 34=jog
      m[`176:${d}:33`] = { action: 'jog', deck: d };
      m[`176:${d}:34`] = { action: 'jogBend', deck: d };
      // FILTRES (CFX) : sur le CANAL MIXER 6, CC 23 à 26 (relevé FLX6)
      m[`176:6:${23 + d}`] = { action: 'filter', deck: d };
    }
    // Sections FX (canal 4 = gauche, canal 5 = droite) : ON + niveau —
    // la note 71 des DEUX canaux est bien le bouton FX (confirmé par David)
    for (const fc of [4, 5]) {
      m[`144:${fc}:71`] = { action: 'fxOn', deck: null };
      m[`176:${fc}:2`] = { action: 'fxLevel', deck: null };
      m[`176:${fc}:4`] = { action: 'fxLevel', deck: null };
    }
    // CHANNEL SELECT (relevé FLX6) : un seul bouton physique, mais la platine
    // envoie une note DIFFÉRENTE par position — elle nous dit laquelle est
    // choisie, aucun risque de désynchronisation avec un cycle logiciel.
    // Cycle matériel : 28 → 29 → 31 → 20 → 30, soit deck 3, 1, 2, 4, MASTER.
    m['144:5:29'] = { action: 'select', deck: 0 };
    m['144:5:31'] = { action: 'select', deck: 1 };
    m['144:5:28'] = { action: 'select', deck: 2 };
    m['144:5:20'] = { action: 'select', deck: 3 };
    m['144:5:30'] = { action: 'selectMaster', deck: null };
    // Pads performance : deck 1 = canal 7, deck 2 = 9, deck 3 = 8, deck 4 = 10
    const padCh = [7, 9, 8, 10];
    for (let d = 0; d < 4; d++) {
      for (let p = 0; p < 8; p++) {
        m[`144:${padCh[d]}:${p}`] = { action: `pad${p + 1}`, deck: d };
      }
    }
    // LOAD (canal 6, notes 70-73)
    for (let d = 0; d < 4; d++) {
      m[`144:6:${70 + d}`] = { action: 'load', deck: d };
    }
    m['176:6:31'] = { action: 'crossfader', deck: null };
    m['176:6:64'] = { action: 'browse', deck: null };
    // Encodeur bibliothèque (relevé FLX6) : APPUI = entrer/charger (note 65),
    // bouton RETOUR = sortir de la playlist (note 101)
    m['144:6:65'] = { action: 'browsePush', deck: null };
    m['144:6:101'] = { action: 'browseBack', deck: null };
    m['144:6:122'] = { action: 'viewToggle', deck: null };
    m['176:6:8'] = { action: 'masterVol', deck: null };
    return m;
  }
}
