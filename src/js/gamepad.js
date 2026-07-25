// Contrôle manette (API Gamepad, mapping "standard") — PS et Xbox.
// MULTI-JOUEURS : chaque manette a SON curseur sur la MATRICE DES KNOBS
// (colonnes = decks, rangée du haut = MASTER). Le deck du joueur = sa colonne.
//
// Par manette :
//  Dpad           : matrice des knobs · sous FILTER = mode NAVIGATION
//                   (▲▼ sélection, ◀▶ onglets, ▲ en haut de liste = retour)
// 16 Logo (milieu): couper / réactiver le knob survolé (LOW = basses EXCLUSIVES)
//  0 Croix/A      : Play/Pause · en navigation : ouvrir / CHARGER ET LANCER
//  1 Rond/B       : remet le knob survolé AU NEUTRE (nav : retour) ·
//                   appui LONG = sélection CUT
//  3 Triangle/Y   : CUT groupé des decks sélectionnés (tout coupe / tout revient)
//  2 Carré/X      : court = durée FX (1/2·3/4·1·2) · ENFONCÉ = liste des
//                   effets affichée + l'effet défile petit à petit
// 10 L3           : FILTRE en général ON/OFF (COLOR)
// 11 R3           : FX de la track ON/OFF (rangée master = tous)
//  9 Options/Menu : BEAT SYNC ON/OFF du deck de la colonne
//  4/5 L1/R1      : VOLUME de la piste − / + (rangée master : knob master)
//  6/7 L2/R2      : appuient sur les PADS encadrés L2/R2 (moitié gauche /
//                   droite, la rangée choisit la paire, mode CUE/JUMP/LOOP)
//  8 Share/View   : appui court = mode L2/R2 (CUE→JUMP→LOOP), long = aide
//  Stick gauche   : ▲▼ = knob survolé · ◀▶ (maintenu ½ s) = PITCH BEND jog
//                   (avance/recule légèrement le son pour caler à l'oreille)
//  Stick droit    : ▲▼ = NIVEAU du FX · ◀▶ (maintenu ½ s) = ZOOM des vagues

const DEADZONE = 0.18;

export class GamepadManager {
  constructor(actions) {
    this.actions = actions;
    this.pads = new Map(); // gamepad.index -> état du joueur
  }

  detectType(id) {
    const s = (id || '').toLowerCase();
    if (s.includes('dualshock') || s.includes('dualsense') || s.includes('054c') ||
        s.includes('sony') || s.includes('wireless controller')) {
      return 'ps';
    }
    return 'xbox';
  }

  get connected() {
    return this.pads.size > 0;
  }

  get type() {
    const first = this.pads.values().next().value;
    return first ? first.type : 'xbox';
  }

  padsInfo() {
    return [...this.pads.entries()].map(([gi, st]) => ({
      player: gi + 1,
      deck: st.deck,
      type: st.type,
      name: st.name
    }));
  }

  buttonLabel(idx) {
    const ps = { 0: 'Croix', 1: 'Rond', 2: 'Carré', 3: 'Triangle', 4: 'L1', 5: 'R1', 6: 'L2', 7: 'R2', 8: 'Share', 9: 'Options', 10: 'L3', 11: 'R3', 16: 'Bouton PS' };
    const xb = { 0: 'A', 1: 'B', 2: 'X', 3: 'Y', 4: 'LB', 5: 'RB', 6: 'LT', 7: 'RT', 8: 'View', 9: 'Menu', 10: 'L3', 11: 'R3', 16: 'Bouton Xbox' };
    return (this.type === 'ps' ? ps : xb)[idx] || `B${idx}`;
  }

  _wrapDeck(d) {
    const n = this.actions.deckCount ? this.actions.deckCount() : 4;
    return ((d % n) + n) % n;
  }

  _nextFreeDeck() {
    const used = new Set([...this.pads.values()].map(s => s.deck));
    const n = this.actions.deckCount ? this.actions.deckCount() : 4;
    for (let d = 0; d < n; d++) {
      if (!used.has(d)) return d;
    }
    return 0;
  }

  poll(dt, now) {
    const list = navigator.getGamepads ? navigator.getGamepads() : [];
    const seen = new Set();
    let changed = false;

    for (const gp of list) {
      if (!gp || !gp.connected) continue;
      seen.add(gp.index);
      let st = this.pads.get(gp.index);
      if (!st) {
        const deck = this._nextFreeDeck();
        st = {
          prev: [],
          repeat: {},
          hold: {},     // verrous d'angle des sticks (0,5 s)
          navSel: null, // sélection bibliothèque PROPRE à ce joueur
          mode: 'jump', // mode L2/R2 PROPRE à ce joueur (JUMP/LOOP/CUE/KEY)
          player: gp.index + 1,
          deck,
          type: this.detectType(gp.id),
          name: gp.id,
          cur: { r: 1, c: deck } // départ sur TRIM de son deck (matrice des knobs)
        };
        this.pads.set(gp.index, st);
        changed = true;
      }
      this._pollPad(gp, st, dt, now);
    }

    for (const idx of [...this.pads.keys()]) {
      if (!seen.has(idx)) {
        this.pads.delete(idx);
        changed = true;
      }
    }
    if (changed) this.actions.onConnection(this);
  }

  _pollPad(gp, st, dt, now) {
    const pressed = gp.buttons.map(b => b.pressed);
    const was = (i) => !!st.prev[i];
    const edge = (i) => pressed[i] && !was(i);

    // --- Dpad : matrice des knobs + zone NAVIGATION sous FILTER ---
    // Rangée 0 = master (2 cellules), rangées 1..5 = knobs (1 colonne par
    // deck), rangée NAV (sous FILTER) = bibliothèque : ▲▼ = sélection
    // (▲ tout en haut de la liste = retour sur la matrice), ◀▶ = onglets.
    const rows = this.actions.gridRows ? this.actions.gridRows() : 6;
    const NAV = rows; // rangée virtuelle de navigation
    const clampCur = () => {
      if (st.cur.r >= NAV) return;
      // colonne FX (à droite des knobs) : pas de clamp, le deck ne change pas
      if (st.cur.c === 4) return;
      const n = this.actions.deckCount ? this.actions.deckCount() : 4;
      if (st.cur.c >= n) st.cur.c = n - 1;
      // le deck du joueur = sa colonne (aussi sur la ligne SELECT)
      st.deck = st.cur.c;
    };
    const inNav = () => st.cur.r >= NAV;
    this._withRepeat(st, 12, pressed[12], now, () => {
      if (inNav()) {
        if ((st.navSel || 0) <= 0) {
          st.cur.r = rows - 1; // haut de liste → retour matrice
          st.navSel = null;
          clampCur();
        } else {
          this.actions.navMove(st, -1);
        }
      } else if (st.cur.r > 0) {
        st.cur.r -= 1;
        clampCur();
      }
    });
    this._withRepeat(st, 13, pressed[13], now, () => {
      if (inNav()) {
        this.actions.navMove(st, 1);
      } else {
        st.cur.r += 1; // sous FILTER → mode navigation
        if (inNav() && st.navSel == null && this.actions.navSelIndex) {
          st.navSel = this.actions.navSelIndex();
        }
        clampCur();
      }
    });
    // ◀▶ : déplacement VISUEL — la colonne suivante à l'écran (ordre club
    // 3 1 2 4 puis FX), identique sur TOUTES les rangées (SELECT comprise)
    const stepCol = (dir) => {
      const ord = this.actions.visualOrder ? this.actions.visualOrder() : [0, 1, 2, 3];
      let pos = ord.indexOf(st.cur.c);
      if (pos < 0) pos = 0;
      st.cur.c = ord[(pos + ord.length + dir) % ord.length];
      clampCur();
    };
    this._withRepeat(st, 14, pressed[14], now, () => {
      if (inNav()) { this.actions.navTab(st, -1); return; }
      stepCol(-1);
    });
    this._withRepeat(st, 15, pressed[15], now, () => {
      if (inNav()) { this.actions.navTab(st, 1); return; }
      stepCol(1);
    });
    const D = st.deck;
    const nav = inNav();

    // --- Bouton Xbox/PS (logo, 16) : couper / réactiver le knob survolé.
    // Sur LOW : les basses passent à ce deck (exclusives). Ailleurs :
    // simple enlever / remettre. (La Game Bar Windows est désactivée.)
    if (edge(16) && !nav) this.actions.killKnob(st.cur, st.player - 1);
    // --- Croix/A : Play/Pause — en navigation : ouvre la playlist ou
    // CHARGE ET LANCE le son (re-appuyer = pause) ---
    if (edge(0)) (nav ? this.actions.navEnter(st, D) : this.actions.padPrimary(st, D));
    // --- Rond/B : REMET LE KNOB SURVOLÉ AU NEUTRE (instantané — effet de
    // filtre puis retour à zéro sec) · en navigation : RETOUR · appui
    // long = sélectionner la colonne pour le CUT ---
    // le reset part au RELÂCHER court : un appui long (sélection CUT) ne
    // doit plus déclencher le reset filtre+FX au passage
    if (edge(1)) st.bT = now;
    if (pressed[1] && st.bT != null && now - st.bT >= 500) {
      this.actions.selectToggle(D, st.player - 1);
      st.bT = null;
    }
    if (!pressed[1] && was(1) && st.bT != null) {
      if (nav) this.actions.navBack(st);
      else this.actions.resetKnob(st.cur, D, st.player - 1);
      st.bT = null;
    }
    // --- Triangle/Y : CUT groupé (instantané) ---
    if (edge(3)) this.actions.cutToggle(D);
    // --- L3 : FILTRE en général ON/OFF · R3 : FX de la track ON/OFF ---
    if (edge(10)) this.actions.colorToggle();
    if (edge(11)) this.actions.fxToggle(st);
    // --- Menu/Options (à droite du logo) : BEAT SYNC ON/OFF du deck ---
    if (edge(9)) this.actions.syncToggle(D);

    // --- Carré/X : court = durée FX (1/2·3/4·1·2) · ENFONCÉ = la liste des
    // effets s'affiche et l'effet défile petit à petit tant que c'est tenu ---
    if (edge(2)) {
      st.sqT = now;
      st.sqHeld = false;
    }
    if (pressed[2] && st.sqT != null && now - st.sqT >= 550) {
      this.actions.fxTypeList(st, st.sqHeld ? 'next' : 'show');
      st.sqT = now; // pas suivant toutes les 550 ms tant que maintenu
      st.sqHeld = true;
    }
    if (!pressed[2] && was(2)) {
      if (st.sqHeld) this.actions.fxTypeList(st, 'hide');
      else if (st.sqT != null) this.actions.fxBeatsCycle(st);
      st.sqT = null;
      st.sqHeld = false;
    }

    // --- Share/View : appui court = mode L2/R2 (CUE→JUMP→LOOP), long = aide ---
    if (edge(8)) st.shareT = now;
    if (pressed[8] && st.shareT != null && now - st.shareT >= 600) {
      this.actions.toggleHelp();
      st.shareT = null;
    }
    if (!pressed[8] && was(8) && st.shareT != null) {
      this.actions.cycleMode(st);
      st.shareT = null;
    }

    // --- R1 : en mode SÉLECTION = ↺ RESET du mix (filtres 0, FX coupés,
    // désélection) — sinon VOLUME + · L1 : VOLUME − ---
    if (edge(5) && this.actions.hasSelection && this.actions.hasSelection(st.player - 1)) {
      this.actions.selReset(D, st.cur);
      st.r1Used = true; // le maintien ne doit pas remonter le volume derrière
    }
    if (!pressed[5]) st.r1Used = false;
    if (pressed[5] && !st.r1Used) this.actions.volumeHold(st.cur, 1, dt);
    if (pressed[4]) this.actions.volumeHold(st.cur, -1, dt);

    // --- L2 / R2 : CUE / JUMP / LOOP selon le mode — L recule, R avance,
    // la rangée donne la force (TRIM = 16 → FILTER = 1) ---
    // Appui = action · MAINTENU 1 s sur un cue posé = l'effacer
    if (edge(7)) { this.actions.sideAction(st, 1); st.r2T = now; st.r2Down = true; }
    if (pressed[7] && st.r2T != null && now - st.r2T >= 1000) {
      this.actions.sideHold(st, 1);
      st.r2T = null;
    }
    if (!pressed[7]) {
      st.r2T = null;
      if (st.r2Down) {
        st.r2Down = false;
        // RELÂCHER du trigger : les PAD FX maintenus se coupent ici
        if (this.actions.sideRelease) this.actions.sideRelease(st, 1);
      }
    }
    if (edge(6)) { this.actions.sideAction(st, -1); st.l2T = now; st.l2Down = true; }
    if (pressed[6] && st.l2T != null && now - st.l2T >= 1000) {
      this.actions.sideHold(st, -1);
      st.l2T = null;
    }
    if (!pressed[6]) {
      st.l2T = null;
      if (st.l2Down) {
        st.l2Down = false;
        if (this.actions.sideRelease) this.actions.sideRelease(st, -1);
      }
    }

    // --- Stick GAUCHE : ◀▶ = PITCH BEND façon jog CDJ, IMMÉDIAT
    // (caler à l'oreille — relâcher = retour au tempo), ▲▼ = knob survolé ---
    const lx = gp.axes[0] || 0;
    const ly = gp.axes[1] || 0;
    const lxHold = this._angleHold(st, 'lx', lx, ly, now);
    if (!nav && lxHold !== 0) {
      this.actions.jogNudge(st.cur, lxHold, dt);
      st.lxBend = true;
    } else if (st.lxBend) {
      this.actions.jogRelease();
      st.lxBend = false;
    }
    if (!nav && Math.abs(ly) > DEADZONE && Math.abs(ly) > Math.abs(lx)) {
      const v = (Math.abs(ly) - DEADZONE) / (1 - DEADZONE) * Math.sign(ly);
      this.actions.stickAdjust(st, -v, dt);
    }

    // --- Stick DROIT : ▲▼ = NIVEAU du FX de la track (haut = monter,
    // master = tous) · ◀▶ = ZOOM / DÉZOOM des vagues, immédiat ---
    const rx = gp.axes[2] || 0;
    const ry = gp.axes[3] || 0;
    if (Math.abs(ry) > DEADZONE && Math.abs(ry) > Math.abs(rx)) {
      const v = (Math.abs(ry) - DEADZONE) / (1 - DEADZONE) * Math.sign(ry);
      this.actions.fxLevel(st, -v, dt);
    }
    const rxHold = this._angleHold(st, 'rx', rx, ry, now);
    if (rxHold !== 0) this.actions.zoomWaves(rxHold, dt);

    st.prev = pressed;
  }

  // Verrou d'angle : ne renvoie une valeur horizontale QUE si le stick est
  // poussé clairement à gauche/droite (l'axe X domine nettement). RÉPONSE
  // IMMÉDIATE — plus d'attente de ½ s : le jog doit répondre sous le doigt.
  _angleHold(st, key, x, y) {
    const mag = Math.abs(x);
    if (mag <= DEADZONE || mag <= Math.abs(y) * 1.6) return 0;
    return ((mag - DEADZONE) / (1 - DEADZONE)) * (x > 0 ? 1 : -1);
  }

  _withRepeat(st, idx, isPressed, now, fn) {
    if (isPressed && !st.prev[idx]) {
      fn();
      st.repeat[idx] = now + 350;
    } else if (isPressed && now >= (st.repeat[idx] || 0)) {
      fn();
      st.repeat[idx] = now + 90;
    }
  }
}
