// Transposition temps réel (WSOLA) — le moteur du KEYLOCK et du KEY ±.
//
// Principe : on découpe le son en grains fenêtrés (Hann) qu'on relit PLUS
// VITE ou PLUS LENTEMENT (ce qui monte ou descend la tonalité), puis qu'on
// recolle à la CADENCE D'ORIGINE (ce qui préserve la durée). Avant de poser
// un grain, on cherche l'endroit où son onde PROLONGE exactement celle du
// grain précédent (corrélation) : c'est WSOLA, et c'est ce qui évite le
// son doublé / flangé d'un simple délai à deux prises.
//
// DEUX RÈGLES qui font la différence (v2) :
//  1. Recouvrement de 50 % : chaque échantillon de sortie mêle EXACTEMENT
//     deux grains, et ces deux-là ont été alignés l'un sur l'autre. À 4×
//     (l'ancienne version) chaque grain chevauchait aussi les deux d'avant,
//     jamais comparés : leurs ondes s'annulaient en partie — le son « mal
//     superposé », un peu flangé, de KEY +n.
//  2. LATENCE FIXE et CONNUE (LAT échantillons, annoncée au fil principal) :
//     un événement entré à l'instant i ressort à i + LAT, quel que soit le
//     rapport, y compris à 1 (simple retard exact). Le deck lit son morceau
//     avec cette avance : ce qu'on ENTEND tombe pile sur la grille. Avant, la
//     latence (~110 ms) n'était pas compensée : un deck en KEY ou en keylock
//     sonnait en retard sur les autres.
//
// Tourne dans le thread audio temps réel : aucune allocation ici.

const N = 1536;          // grain de 32 ms : assez long pour les basses
const HS = N >> 1;       // saut = moitié du grain (Hann somme à 1)
const OVL = N - HS;      // zone de recouvrement comparée
const SEARCH = 480;      // ± échantillons : une période entière de 50 Hz
const R_MIN = 0.5;
const R_MAX = 1.8;       // KEY +7 avec keylock à −6 % ≈ 1,6
// Latence minimale pour lire un grain entier au rapport maximal, fenêtre
// de recherche comprise, sans jamais dépasser ce qui est déjà arrivé
const LAT = Math.ceil((N * (R_MAX + 1)) / 2 + SEARCH + 16);
const RING = 16384;      // mémoire d'entrée (puissance de 2)
const ACC = 4096;        // accumulateur de sortie (puissance de 2)
const RM = RING - 1;
const AM = ACC - 1;

class PitchProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: 'ratio', defaultValue: 1, minValue: 0.25, maxValue: 4, automationRate: 'k-rate' }];
  }

  constructor(options) {
    super();
    // force de la pénalité d'alignement (réglable pour les bancs d'essai)
    const po = options && options.processorOptions;
    this.pen = po && po.pen != null ? po.pen : 0.1;
    this.win = new Float32Array(N);
    // Hann PÉRIODIQUE : deux fenêtres décalées de N/2 somment exactement à 1
    for (let i = 0; i < N; i++) this.win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
    this.L = { ring: new Float32Array(RING), acc: new Float32Array(ACC) };
    this.R = { ring: new Float32Array(RING), acc: new Float32Array(ACC) };
    this.inW = 0;      // échantillons d'entrée reçus (absolu)
    this.outP = 0;     // échantillons de sortie émis (absolu)
    this.nextG = 0;    // position de sortie du prochain grain
    this.prevS = null; // début de lecture du grain précédent
    this.prevR = 1;
    this.port.postMessage({ lat: LAT });
  }

  // Corrélation normalisée entre la suite naturelle du grain précédent
  // (cont) et un candidat (s), sur la zone de recouvrement, en mono (L+R)
  _score(cont, s, r, step) {
    const rl = this.L.ring;
    const rr = this.R.ring;
    let dot = 0;
    let en = 1e-9;
    let er = 1e-9;
    for (let k = 0; k < OVL; k += step) {
      const pc = (cont + k * r) | 0;
      const ps = (s + k * r) | 0;
      const ref = rl[pc & RM] + rr[pc & RM];
      const v = rl[ps & RM] + rr[ps & RM];
      dot += v * ref;
      en += v * v;
      er += ref * ref;
    }
    // corrélation VRAIMENT normalisée (−1…1) : la pénalité de décalage
    // garde le même poids quel que soit le volume du morceau
    return dot / Math.sqrt(en * er);
  }

  _grain(G, r) {
    // Position « juste » : le centre du grain ressort LAT plus tard
    const S0 = G - LAT - (N * (r - 1)) / 2;
    let S = S0;
    if (this.prevS !== null) {
      const cont = this.prevS + HS * this.prevR;
      if (Math.abs(r - 1) < 1e-4 && Math.abs(this.prevR - 1) < 1e-4 && Math.abs(cont - S0) < 0.5) {
        S = S0; // rien à transposer : simple retard exact, sans recherche
      } else {
        // grossier (pas de 4) sur toute la fenêtre, puis fin au 1/1
        let best = 0;
        let bestS = -Infinity;
        // Légère PÉNALITÉ des grands décalages : sans elle, sur une attaque
        // de kick, l'alignement préférait prolonger la queue du grain
        // précédent et RETARDAIT le kick de ~10 ms (mesuré au banc d'essai :
        // retard ramené à ±1-4 ms, attaque aussi nette)
        for (let d = -SEARCH; d <= SEARCH; d += 4) {
          const sc = this._score(cont, S0 + d, r, 4) - (this.pen * Math.abs(d)) / SEARCH;
          if (sc > bestS) { bestS = sc; best = d; }
        }
        let fine = best;
        let fineS = -Infinity;
        for (let d = best - 3; d <= best + 3; d++) {
          const sc = this._score(cont, S0 + d, r, 2);
          if (sc > fineS) { fineS = sc; fine = d; }
        }
        S = S0 + fine;
      }
    }
    const w = this.win;
    const rl = this.L.ring;
    const rr = this.R.ring;
    const al = this.L.acc;
    const ar = this.R.acc;
    for (let k = 0; k < N; k++) {
      const p = S + k * r;
      const i0 = Math.floor(p);
      const fr = p - i0;
      const j0 = i0 & RM;
      const j1 = (i0 + 1) & RM;
      const o = (G + k) & AM;
      al[o] += (rl[j0] + (rl[j1] - rl[j0]) * fr) * w[k];
      ar[o] += (rr[j0] + (rr[j1] - rr[j0]) * fr) * w[k];
    }
    this.prevS = S;
    this.prevR = r;
  }

  process(inputs, outputs, params) {
    const input = inputs[0];
    const output = outputs[0];
    if (!output || !output.length) return true;
    const n = output[0].length;
    const inL = input && input[0] ? input[0] : null;
    const inR = input && input[1] ? input[1] : inL;
    let r = params.ratio[0];
    if (!(r > 0)) r = 1;
    r = Math.min(R_MAX, Math.max(R_MIN, r));

    // 1) Entrée → anneaux
    const rl = this.L.ring;
    const rr = this.R.ring;
    for (let i = 0; i < n; i++) {
      const p = (this.inW + i) & RM;
      rl[p] = inL ? inL[i] : 0;
      rr[p] = inR ? inR[i] : 0;
    }
    this.inW += n;

    // 2) Grains nécessaires pour couvrir ce bloc de sortie
    while (this.nextG < this.outP + n) {
      this._grain(this.nextG, r);
      this.nextG += HS;
    }

    // 3) Sortie, et remise à zéro des cases consommées
    const oL = output[0];
    const oR = output[1] || null;
    const aL = this.L.acc;
    const aR = this.R.acc;
    for (let i = 0; i < n; i++) {
      const o = (this.outP + i) & AM;
      oL[i] = aL[o];
      if (oR) oR[i] = aR[o];
      aL[o] = 0;
      aR[o] = 0;
    }
    for (let ci = 2; ci < output.length; ci++) output[ci].set(oL);
    this.outP += n;
    return true;
  }
}

registerProcessor('pitch-shift', PitchProcessor);
