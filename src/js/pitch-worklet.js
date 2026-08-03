// Transposition temps réel (WSOLA) — le moteur du KEYLOCK et du KEY ±.
//
// Principe : on découpe le son en grains fenêtrés (Hann) qu'on relit PLUS
// VITE ou PLUS LENTEMENT (ce qui monte ou descend la tonalité), puis qu'on
// recolle à la CADENCE D'ORIGINE (ce qui préserve la durée). Le recollage
// cherche à chaque grain le meilleur alignement d'onde (corrélation) : c'est
// ce que fait WSOLA, et c'est ce qui évite le « son doublé / flangé » d'un
// simple délai à deux prises.
//
// Tourne dans le thread audio temps réel : aucune allocation ici.

const N = 2048;        // longueur de grain (~46 ms) : bon compromis musique
const HS = N >> 2;     // saut de synthèse (recouvrement 4x : Hann somme à 2)
const RING = 32768;    // mémoire d'entrée (assez pour un ratio jusqu'à ~3)
const ACC = 8192;      // accumulateur de sortie
// FENÊTRE DE RECHERCHE : elle doit couvrir AU MOINS une période du grave le
// plus bas (60 Hz = 735 éch.) ET le décalage de phase imposé par la
// transposition, qui vaut HS × (ratio − 1) : +255 éch. à +7 demi-tons.
// Une fenêtre trop courte (l'ancienne, ±128) ne trouvait JAMAIS le bon
// alignement dans les aigus ni sur les basses — d'où l'effet flanger.
const SEARCH = 800;    // ± échantillons (~18 ms : jusqu'à 55 Hz)
const CORR = 256;      // longueur comparée pour la corrélation

class PitchProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: 'ratio', defaultValue: 1, minValue: 0.25, maxValue: 4, automationRate: 'k-rate' }];
  }

  constructor() {
    super();
    this.win = new Float32Array(N);
    for (let i = 0; i < N; i++) this.win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
    this.ch = [];          // état par canal, créé à la volée
    this.inWritten = 0;    // échantillons d'entrée reçus (absolu)
    this.readPos = 0;      // tête de lecture dans l'entrée (absolu, flottant)
    this.outPos = 0;       // prochain échantillon à sortir (absolu)
    this.grainPos = 0;     // position de sortie du prochain grain (absolu)
    this.primed = false;
  }

  _chan(i) {
    let c = this.ch[i];
    if (!c) {
      c = this.ch[i] = {
        ring: new Float32Array(RING),
        acc: new Float32Array(ACC),
        tail: new Float32Array(CORR) // fin du grain précédent (référence WSOLA)
      };
    }
    return c;
  }

  // Meilleur décalage d'alignement : on compare le début du futur grain à la
  // fin de ce qui vient d'être synthétisé. Calculé sur le canal 0 seulement
  // et appliqué aux DEUX canaux — la stéréo doit rester cohérente.
  _align(c, base, ratio) {
    if (!this.primed) return 0;
    const ring = c.ring;
    const tail = c.tail;
    // Corrélation NORMALISÉE : sans diviser par l'énergie, la recherche
    // choisissait simplement l'endroit le PLUS FORT au lieu du mieux
    // ALIGNÉ — deuxième cause du son doublé.
    const score = (d, step) => {
      const start = base + d;
      if (start < 0 || start + CORR * ratio >= this.inWritten) return -Infinity;
      let dot = 0;
      let en = 1e-9;
      for (let k = 0; k < CORR; k += step) {
        const p = start + k * ratio;
        const v = ring[((p | 0) % RING + RING) % RING];
        dot += v * tail[k];
        en += v * v;
      }
      return dot / Math.sqrt(en);
    };
    // Passe GROSSIÈRE sur toute la fenêtre, puis affinage au 1/1 autour du
    // meilleur candidat : large ET précis, sans exploser le temps de calcul
    let best = 0;
    let bestScore = -Infinity;
    for (let d = -SEARCH; d <= SEARCH; d += 8) {
      const s = score(d, 2);
      if (s > bestScore) { bestScore = s; best = d; }
    }
    let fine = best;
    let fineScore = bestScore;
    for (let d = best - 7; d <= best + 7; d++) {
      const s = score(d, 2);
      if (s > fineScore) { fineScore = s; fine = d; }
    }
    return fine;
  }

  _grain(nCh, ratio) {
    // Assez d'entrée pour lire tout le grain (fenêtre de recherche comprise) ?
    const need = this.readPos + N * ratio + SEARCH + CORR * ratio + 2;
    if (need >= this.inWritten) {
      // pas encore : on avance quand même pour ne pas décrocher
      this.grainPos += HS;
      this.readPos += HS;
      return;
    }
    const c0 = this._chan(0);
    const delta = this._align(c0, this.readPos, ratio);
    const start = this.readPos + delta;

    for (let ci = 0; ci < nCh; ci++) {
      const c = this._chan(ci);
      const ring = c.ring;
      const acc = c.acc;
      for (let k = 0; k < N; k++) {
        const p = start + k * ratio;
        const i0 = p | 0;
        const fr = p - i0;
        const a = ring[((i0 % RING) + RING) % RING];
        const b = ring[(((i0 + 1) % RING) + RING) % RING];
        const v = (a + (b - a) * fr) * this.win[k];
        const o = ((this.grainPos + k) % ACC + ACC) % ACC;
        acc[o] += v;
      }
      // Mémorise la fin du grain : référence d'alignement du grain suivant
      for (let k = 0; k < CORR; k++) {
        const p = start + (HS + k) * ratio;
        const i0 = p | 0;
        c.tail[k] = ring[((i0 % RING) + RING) % RING];
      }
    }
    this.grainPos += HS;
    this.readPos += HS;
  }

  process(inputs, outputs, params) {
    const input = inputs[0];
    const output = outputs[0];
    if (!output || !output.length) return true;
    const n = output[0].length;
    const nCh = Math.min(output.length, Math.max(1, input && input.length ? input.length : 1));
    const ratio = params.ratio.length > 1 ? params.ratio[0] : params.ratio[0];

    // 1) Entrée -> mémoire circulaire
    for (let ci = 0; ci < nCh; ci++) {
      const c = this._chan(ci);
      const src = input && input[ci] ? input[ci] : null;
      for (let i = 0; i < n; i++) {
        c.ring[((this.inWritten + i) % RING + RING) % RING] = src ? src[i] : 0;
      }
    }
    this.inWritten += n;

    // Court-circuit exact quand il n'y a rien à transposer
    if (Math.abs(ratio - 1) < 0.0005) {
      for (let ci = 0; ci < output.length; ci++) {
        const src = input && input[Math.min(ci, nCh - 1)];
        if (src) output[ci].set(src);
        else output[ci].fill(0);
      }
      // on garde les têtes alignées pour une reprise sans à-coup
      this.readPos = this.inWritten - N;
      this.outPos = this.grainPos = 0;
      this.primed = false;
      for (let ci = 0; ci < nCh; ci++) this._chan(ci).acc.fill(0);
      return true;
    }

    // Amorçage : on attend d'avoir de quoi lire un grain entier
    if (!this.primed) {
      // De quoi lire un grain ET fouiller la fenêtre de recherche en arrière
      if (this.inWritten < N * 4 + SEARCH * 2) {
        for (let ci = 0; ci < output.length; ci++) output[ci].fill(0);
        return true;
      }
      this.readPos = this.inWritten - (N * 2.2 + SEARCH);
      this.grainPos = this.outPos = 0;
      for (let ci = 0; ci < nCh; ci++) this._chan(ci).acc.fill(0);
      this.primed = true;
    }

    // 2) Fabrique assez de grains pour couvrir la sortie demandée
    let guard = 0;
    while (this.grainPos < this.outPos + n && guard++ < 64) this._grain(nCh, ratio);

    // 3) Sortie + remise à zéro des cases consommées (recyclage de l'anneau)
    for (let ci = 0; ci < output.length; ci++) {
      const c = this._chan(Math.min(ci, nCh - 1));
      const out = output[ci];
      for (let i = 0; i < n; i++) {
        const o = ((this.outPos + i) % ACC + ACC) % ACC;
        out[i] = c.acc[o] * 0.5;   // Hann à 4x recouvrement somme à 2
        c.acc[o] = 0;
      }
    }
    this.outPos += n;

    // Dérive : la tête de lecture doit rester à distance constante de
    // l'entrée (sinon on finit par lire du silence ou du passé lointain)
    const lag = this.inWritten - this.readPos;
    const target = N * 2.2 + SEARCH;
    if (lag > target * 2 || lag < N * 1.2 + SEARCH) this.readPos = this.inWritten - target;

    return true;
  }
}

registerProcessor('pitch-shift', PitchProcessor);
