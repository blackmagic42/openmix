// Détection de BPM et de grille.
//
// 1. Basses isolées (passe-bas) puis FORCE D'ATTAQUE (onset) : on mesure les
//    montées d'énergie, pas l'amplitude brute — robuste même quand la basse
//    « wobble » sans transitoires nettes.
// 2. Histogramme des intervalles entre attaques -> BPM approché.
// 3. Ancrage de phase sur les attaques, puis RÉGRESSION LINÉAIRE sur les
//    positions réelles des attaques -> période au ~millième de BPM.
//    Sans cet affinage, un BPM arrondi fait dériver la grille petit à petit.

export async function detectBPM(buffer, range) {
  // Plage BPM de base (défaut 85-170, réglable dans les paramètres).
  // Le choix d'octave intelligent reste actif dans tous les cas.
  const RLO = range && range.lo ? range.lo : 85;
  const RHI = range && range.hi ? range.hi : 170;
  // Morceau analysé EN ENTIER (jusqu'à 10 min) : la régression s'appuie sur
  // des kicks du début À LA FIN — aucune dérive par extrapolation.
  // Rendu à 8 kHz : on ne garde que les basses, c'est 5x plus rapide.
  const seconds = Math.min(buffer.duration, 600);
  const sr = 8000;
  const length = Math.floor(seconds * sr);
  if (length < sr * 5) return null; // morceau trop court

  const off = new OfflineAudioContext(1, length, sr);
  const src = off.createBufferSource();
  src.buffer = buffer;

  const lp = off.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 150;
  lp.Q.value = 1;

  const hp = off.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 35;

  src.connect(lp);
  lp.connect(hp);
  hp.connect(off.destination);
  src.start(0);

  const rendered = await off.startRendering();
  const data = rendered.getChannelData(0);

  // Enveloppe par pas de 5 ms puis force d'attaque
  const hop = Math.max(1, Math.floor(sr * 0.005));
  const nH = Math.floor(data.length / hop);
  if (nH < 200) return null;
  const env = new Float32Array(nH);
  for (let j = 0; j < nH; j++) {
    let m = 0;
    const s0 = j * hop;
    const s1 = s0 + hop;
    for (let i = s0; i < s1; i++) {
      const v = Math.abs(data[i]);
      if (v > m) m = v;
    }
    env[j] = m;
  }
  const onset = new Float32Array(nH);
  for (let j = 1; j < nH; j++) {
    onset[j] = Math.max(0, env[j] - env[j - 1]);
  }

  let maxO = 0;
  for (let j = 0; j < nH; j++) {
    if (onset[j] > maxO) maxO = onset[j];
  }
  if (maxO <= 0) return null;

  // Pics d'attaque (maxima locaux), seuil abaissé jusqu'à en avoir assez
  const minGap = Math.round(0.25 / 0.005); // 240 BPM max
  let peaks = [];
  for (let thr = maxO * 0.5; thr > maxO * 0.06; thr *= 0.72) {
    peaks = [];
    let last = -minGap;
    for (let j = 2; j < nH - 2; j++) {
      if (onset[j] > thr && onset[j] >= onset[j - 1] && onset[j] >= onset[j + 1] && j - last >= minGap) {
        peaks.push(j);
        last = j;
      }
    }
    if (peaks.length >= 60) break;
  }
  if (peaks.length < 8) return null;

  // Position sub-milliseconde de chaque attaque (interpolation parabolique)
  const times = peaks.map((j) => {
    const y1 = onset[j - 1] || 0;
    const y2 = onset[j];
    const y3 = onset[j + 1] || 0;
    const den = y1 - 2 * y2 + y3;
    let delta = den ? (0.5 * (y1 - y3)) / den : 0;
    if (delta > 0.5) delta = 0.5;
    if (delta < -0.5) delta = -0.5;
    return ((j + 0.5 + delta) * hop) / sr;
  });

  // --- Tempo par AUTOCORRÉLATION de la force d'attaque ---
  // La méthode de référence : la périodicité du beat ressort naturellement,
  // même avec des basses en contretemps, du swing ou des breaks (là où les
  // intervalles entre attaques se font piéger).
  const hopSec = hop / sr;
  const acMin = Math.max(4, Math.floor((60 / RHI) / hopSec));
  const acMax = Math.min(nH - 10, Math.ceil((60 / RLO) / hopSec));
  if (acMax <= acMin + 2) return null;
  const acLen = Math.min(nH, Math.floor(240 / hopSec)); // 4 min suffisent
  const acTop = Math.min(acMax * 2 + 1, nH - 2);
  const ac = new Float32Array(acTop + 1);
  for (let lag = acMin; lag <= acTop; lag++) {
    let s = 0;
    const lim = Math.min(acLen, nH - lag);
    for (let j = 0; j < lim; j++) s += onset[j] * onset[j + lag];
    ac[lag] = s;
  }
  // Meilleur lag avec renfort harmonique (le double du lag doit corréler aussi)
  let bestLag = acMin;
  let bestScore = -1;
  for (let lag = acMin; lag <= acMax; lag++) {
    const score = ac[lag] + 0.5 * (lag * 2 <= acTop ? ac[lag * 2] : 0);
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }
  // Affinage parabolique du lag
  const ay1 = ac[bestLag - 1] || 0;
  const ay2 = ac[bestLag];
  const ay3 = ac[bestLag + 1] || 0;
  const aden = ay1 - 2 * ay2 + ay3;
  let dl = aden ? (0.5 * (ay1 - ay3)) / aden : 0;
  if (dl > 0.5) dl = 0.5;
  if (dl < -0.5) dl = -0.5;
  let bpm0 = 60 / ((bestLag + dl) * hopSec);

  // Choix d'octave automatique : en techno/hard, le kick est sur CHAQUE temps,
  // donc la médiane des intervalles entre attaques donne le vrai tempo.
  // Un morceau à 190 BPM ne sera plus affiché 95.
  if (times.length > 10) {
    const ivs = [];
    for (let i = 1; i < times.length; i++) ivs.push(times[i] - times[i - 1]);
    ivs.sort((a, b) => a - b);
    const med = ivs[ivs.length >> 1];
    if (med > 0) {
      const bpmMed = 60 / med;
      let best = bpm0;
      let bestD = Math.abs(Math.log(bpm0 / bpmMed));
      for (const c of [bpm0 / 2, bpm0 * 2]) {
        if (c < 60 || c > 220) continue;
        const dd = Math.abs(Math.log(c / bpmMed));
        if (dd < bestD) {
          bestD = dd;
          best = c;
        }
      }
      bpm0 = best;
    }
  }

  let period = 60 / bpm0;

  // Ancrage : phase qui maximise la force d'attaque aux positions attendues
  let offset = bestPhase(onset, hop, sr, period);

  // Affinage par régression linéaire (3 passes, fenêtre qui se resserre)
  const windows = [0.22, 0.15, 0.12];
  for (const win of windows) {
    const ks = [];
    const ts = [];
    let kMin = Infinity;
    let kMax = -Infinity;
    for (const t of times) {
      const k = Math.round((t - offset) / period);
      const res = t - (offset + k * period);
      if (Math.abs(res) < period * win) {
        ks.push(k);
        ts.push(t);
        if (k < kMin) kMin = k;
        if (k > kMax) kMax = k;
      }
    }
    if (ks.length < 12 || kMax - kMin < 16) break;
    const n = ks.length;
    let sk = 0, st = 0, skk = 0, skt = 0;
    for (let i = 0; i < n; i++) {
      sk += ks[i];
      st += ts[i];
      skk += ks[i] * ks[i];
      skt += ks[i] * ts[i];
    }
    const denom = n * skk - sk * sk;
    if (!denom) break;
    const b = (n * skt - sk * st) / denom;
    const a = (st - b * sk) / n;
    const nb = 60 / b;
    if (!isFinite(nb) || Math.abs(nb - bpm0) > 3) break;
    period = b;
    offset = a;
  }

  // Normalise l'ancrage dans [0, période)
  offset -= Math.floor(offset / period) * period;

  const dur = data.length / sr;

  // --- Enveloppe LARGE BANDE du fichier original (transitoires vrais) ---
  // Construite tôt car elle sert deux fois : départager kick/contretemps
  // pour la phase de la grille rigide, puis recalage final (le passe-bas
  // d'analyse retarde les attaques de quelques ms — retard de groupe).
  const osr = buffer.sampleRate;
  const ch0 = buffer.getChannelData(0);
  const ch1 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : ch0;
  const whop = Math.max(1, Math.floor(osr * 0.002)); // pas de 2 ms
  const wn = Math.floor(Math.min(ch0.length, seconds * osr) / whop);
  const wenv = new Float32Array(wn);
  for (let j = 0; j < wn; j++) {
    let m = 0;
    const s0 = j * whop;
    const s1 = s0 + whop;
    for (let i = s0; i < s1; i += 2) {
      const v = Math.abs((ch0[i] + ch1[i]) * 0.5);
      if (v > m) m = v;
    }
    wenv[j] = m;
  }
  const wons = new Float32Array(wn);
  for (let j = 1; j < wn; j++) wons[j] = Math.max(0, wenv[j] - wenv[j - 1]);
  const whopSec = whop / osr;
  // Plus forte attaque large bande autour d'un instant (rayon en secondes)
  const wPeakNear = (center, radius) => {
    const R = Math.max(1, Math.round(radius / whopSec));
    const jc = Math.round(center / whopSec);
    let bj = -1;
    let bv = 0;
    for (let j = Math.max(1, jc - R); j <= Math.min(wn - 2, jc + R); j++) {
      if (wons[j] > bv) { bv = wons[j]; bj = j; }
    }
    if (bj <= 0) return null;
    const y1 = wons[bj - 1] || 0;
    const y3 = wons[bj + 1] || 0;
    const den = y1 - 2 * wons[bj] + y3;
    let dd = den ? (0.5 * (y1 - y3)) / den : 0;
    if (dd > 0.5) dd = 0.5;
    if (dd < -0.5) dd = -0.5;
    return { t: (bj + dd) * whopSec, v: bv };
  };

  // ---- GRILLE RIGIDE : le vrai système Rekordbox ----
  // Mesuré sur 61 grilles d'analyse ANLZ trouvées sur le disque : 61/61
  // grilles sont parfaitement RIGIDES (un seul tempo, temps équidistants au
  // ms près) et 60/61 ont un BPM ENTIER — la musique électronique est
  // produite en DAW à tempo fixe. Une grille rigide ne PEUT PAS dériver.
  // On cherche donc le BPM constant qui aligne le mieux TOUTES les attaques
  // du morceau (histogramme de phase circulaire : le bon tempo donne un pic
  // net, un tempo faux l'étale), avec verrou sur l'entier. Le suivi
  // beat-par-beat ne sert plus qu'en repli si le tempo varie vraiment
  // (live, vinyle, vieux funk).
  const strengths = peaks.map((j) => onset[j]);
  const histPhase = (p, ts, ws) => {
    const bins = Math.max(48, Math.round(p / 0.002));
    const hist = new Float64Array(bins);
    for (let i = 0; i < ts.length; i++) {
      const ph = ts[i] - Math.floor(ts[i] / p) * p;
      hist[Math.min(bins - 1, Math.floor((ph / p) * bins))] += ws[i];
    }
    // Lissage circulaire triangulaire ±3 bins (≈ ±6 ms)
    const sm = (i) => {
      let s = 0;
      for (let d = -3; d <= 3; d++) s += hist[(i + d + bins) % bins] * (4 - Math.abs(d));
      return s;
    };
    let bestI = 0;
    let best = -1;
    for (let i = 0; i < bins; i++) {
      const s = sm(i);
      if (s > best) { best = s; bestI = i; }
    }
    const y1 = sm((bestI - 1 + bins) % bins);
    const y3 = sm((bestI + 1) % bins);
    const den = y1 - 2 * best + y3;
    let dd = den ? (0.5 * (y1 - y3)) / den : 0;
    if (dd > 0.5) dd = 0.5;
    if (dd < -0.5) dd = -0.5;
    return { score: best, phase: ((((bestI + 0.5 + dd) / bins) * p) % p + p) % p };
  };
  // Série CONTINUE de puissance des basses (env², sous-échantillonnée ×2).
  // Mesuré contre les grilles Rekordbox : son pic de phase tombe 0 à 70 ms
  // après le temps officiel (le sub du kick se développe juste après
  // l'attaque) sur 7 morceaux sur 8 — c'est le marqueur de phase le plus
  // fiable, bien plus que les pics d'onset (qui élisent la bassline en
  // contretemps) ou les transitoires bruts (qui élisent hats et claps).
  const lpT = [];
  const lpW = [];
  for (let j = 0; j < nH; j += 2) {
    lpT.push(j * hopSec);
    lpW.push(env[j] * env[j]);
  }
  // Attaques large bande brutes (maxima locaux ≥ 12 % du max, espacées
  // d'au moins 100 ms) : servent à retrouver l'ATTAQUE du kick juste avant
  // le pic de puissance des basses.
  const wpTimes = [];
  const wpW = [];
  {
    let wMax = 0;
    for (let j = 1; j < wn - 1; j++) if (wons[j] > wMax) wMax = wons[j];
    const gap = Math.round(0.1 / whopSec);
    let last = -gap;
    for (let j = 1; j < wn - 1; j++) {
      if (wons[j] >= wons[j - 1] && wons[j] >= wons[j + 1] && wons[j] > wMax * 0.12 && j - last >= gap) {
        wpTimes.push(j * whopSec);
        wpW.push(wons[j]);
        last = j;
      }
    }
  }
  const scorePhase = (p) => histPhase(p, lpT, lpW);
  const circDist = (a, b, p) => {
    let d = Math.abs(a - b) % p;
    if (d > p / 2) d = p - d;
    return d;
  };
  // Argmax du histogramme lissé restreint à une fenêtre circulaire [lo, hi].
  // pickLatest : prend le DERNIER pic ≥ 60 % du max de la fenêtre (l'attaque
  // du kick est le dernier transitoire avant l'épanouissement du sub).
  const histArgmaxWin = (p, ts, ws, lo, hi, pickLatest) => {
    const bins = Math.max(48, Math.round(p / 0.002));
    const hist = new Float64Array(bins);
    for (let i = 0; i < ts.length; i++) {
      let ph = ts[i] % p;
      if (ph < 0) ph += p;
      hist[Math.min(bins - 1, Math.floor((ph / p) * bins))] += ws[i];
    }
    const sm = (i) => {
      let s = 0;
      for (let d = -3; d <= 3; d++) s += hist[(i + d + bins) % bins] * (4 - Math.abs(d));
      return s;
    };
    let wsize = (hi - lo) % p;
    if (wsize < 0) wsize += p;
    let bestI = -1;
    let best = -1;
    let mass = 0;
    let tot = 0;
    const inWin = []; // {i, s, x} des bins de la fenêtre
    for (let i = 0; i < bins; i++) {
      const s = sm(i);
      tot += s;
      let x = (((i + 0.5) / bins) * p - lo) % p;
      if (x < 0) x += p;
      if (x <= wsize) {
        mass += s;
        inWin.push({ i, s, x });
        if (s > best) { best = s; bestI = i; }
      }
    }
    if (bestI < 0 || best <= 0) return null;
    if (pickLatest) {
      let lx = -1;
      for (const b of inWin) {
        if (b.s >= best * 0.6 && b.x > lx && (b.s >= sm((b.i - 1 + bins) % bins) || b.s >= sm((b.i + 1) % bins))) {
          lx = b.x;
          bestI = b.i;
        }
      }
      best = sm(bestI);
    }
    const y1 = sm((bestI - 1 + bins) % bins);
    const y3 = sm((bestI + 1) % bins);
    const den = y1 - 2 * best + y3;
    let dd = den ? (0.5 * (y1 - y3)) / den : 0;
    if (dd > 0.5) dd = 0.5;
    if (dd < -0.5) dd = -0.5;
    return { phase: ((((bestI + 0.5 + dd) / bins) * p) % p + p) % p, score: best, mass, tot };
  };
  let rigidBpm = null;
  let rigidPhase = 0;
  let rigidDev = -1;
  if (times.length >= 40 && dur > 30) {
    const bpmEst = 60 / period;
    // L'octave est revérifiée ici : kicks un temps sur deux → l'estimation
    // arrive à la moitié du vrai tempo. On balaye chaque octave plausible et
    // celle DANS la plage choisie gagne sauf si elle aligne nettement moins bien.
    // Octaves ET rapports ternaires : les rythmes pointés/triolets piègent
    // l'autocorrélation à ⅔ ou 4/3 du vrai tempo (mesuré : 96 au lieu de
    // 144, 103,3 au lieu de 155, 192 au lieu de 144). Les octaves pures
    // (×2, ×½) peuvent sortir de la plage (un vrai 190 existe) ; les
    // rapports ternaires n'ont le droit de gagner QUE dans la plage —
    // hors plage, un ternaire est toujours une erreur de lecture.
    // Fenêtre ±1,2 autour des octaves, ±3 autour des ternaires (l'erreur
    // d'estimation est amplifiée par le rapport : 1,5 × 94,7 = 142 alors que
    // le vrai tempo est 144 — il faut qu'il soit DANS la fenêtre pour gagner)
    const octs = [bpmEst, bpmEst * 2, bpmEst / 2]
      .filter((c) => c >= 40 && c <= 240)
      .map((c) => ({ c0: c, span: 1.2, tern: false }));
    for (const r of [1.5, 1 / 1.5, 4 / 3, 0.75]) {
      const c = bpmEst * r;
      if (c >= RLO - 1 && c <= RHI + 1) octs.push({ c0: c, span: 3, tern: true });
    }
    for (let i = octs.length - 1; i > 0; i--) {
      if (octs.findIndex((x) => Math.abs(x.c0 - octs[i].c0) < 0.5) < i) octs.splice(i, 1);
    }
    // Score DOUBLE pour chaque candidat : netteté du pic de phase de la
    // puissance des basses ET des transitoires large bande. Les deux se
    // complètent : la basse peut groover (funk) mais les hats sont
    // métronomiques ; les hats peuvent manquer mais le sub est là.
    const dual = (bpm) => {
      const p2 = 60 / bpm;
      return { bpm, s1: scorePhase(p2).score, s2: histPhase(p2, wpTimes, wpW).score };
    };
    const cands = [];
    for (const o of octs) {
      for (let c = Math.max(40, o.c0 - o.span); c <= o.c0 + o.span; c += 0.01) {
        cands.push({ ...dual(c), tern: o.tern });
      }
    }
    // BALAYAGE COMPLET de la plage (le correctif du « 162 au lieu de
    // 145 ») : l'autocorrélation peut accrocher un tempo SANS rapport
    // simple avec le vrai (162/145 = 1,117 — ni octave ni ternaire) et
    // dans ce cas AUCUN candidat proche du vrai n'existait même dans la
    // course. Ici TOUTE la plage concourt : passe grossière (0,5 BPM) sur
    // le double score de phase, puis affinage fin des 3 meilleurs bassins.
    {
      const coarse = [];
      for (let c = RLO; c <= RHI; c += 0.5) coarse.push(dual(c));
      let cm1 = 0;
      let cm2 = 0;
      for (const x of coarse) {
        if (x.s1 > cm1) cm1 = x.s1;
        if (x.s2 > cm2) cm2 = x.s2;
      }
      const cSc = (x) => (cm1 ? x.s1 / cm1 : 0) + (cm2 ? x.s2 / cm2 : 0);
      const tops = [];
      for (const x of coarse) {
        const near = tops.find((t) => Math.abs(t.bpm - x.bpm) < 2.5);
        if (near) {
          if (cSc(x) > cSc(near)) Object.assign(near, x);
        } else {
          tops.push({ ...x });
        }
      }
      tops.sort((a, b) => cSc(b) - cSc(a));
      for (const t of tops.slice(0, 3)) {
        for (let c = Math.max(RLO, t.bpm - 0.6); c <= Math.min(RHI, t.bpm + 0.6); c += 0.02) {
          cands.push({ ...dual(c), tern: false });
        }
      }
    }
    let m1 = 0;
    let m2 = 0;
    for (const x of cands) {
      if (x.s1 > m1) m1 = x.s1;
      if (x.s2 > m2) m2 = x.s2;
    }
    const comb = (x) => (m1 ? x.s1 / m1 : 0) + (m2 ? x.s2 / m2 : 0);
    let bestC = null;
    if (cands.length) {
      let bo = null; // meilleure octave (toutes, même hors plage — un vrai 190 existe)
      let boIn = null; // meilleure octave dans la plage
      let bt = null; // meilleur ternaire (déjà restreint à la plage)
      for (const x of cands) {
        if (!x.tern) {
          if (!bo || comb(x) > comb(bo)) bo = x;
          if (x.bpm >= RLO - 1 && x.bpm <= RHI + 1 && (!boIn || comb(x) > comb(boIn))) boIn = x;
        } else if (!bt || comb(x) > comb(bt)) {
          bt = x;
        }
      }
      bestC = bo;
      if (boIn && bo && comb(boIn) >= comb(bo) * 0.7) bestC = boIn;
      // Un ternaire ne gagne que s'il ÉCRASE l'octave : au sous-harmonique la
      // masse d'alignement se divise en 3 pics (~⅓ chacun), au vrai tempo
      // elle fait UN seul pic — les vraies corrections (96→144) passent ce
      // seuil haut la main, les faux amis du swing jamais.
      if (bt && (!bestC || comb(bt) >= comb(bestC) * 1.15)) bestC = bt;
    }
    if (bestC) {
      // Verrou façon Rekordbox : l'entier (puis le demi) gagne s'il fait
      // quasi aussi bien que le meilleur candidat fractionnaire
      for (const snap of [Math.round(bestC.bpm), Math.round(bestC.bpm * 2) / 2]) {
        if (Math.abs(snap - bestC.bpm) < 0.005) break;
        const sc = dual(snap);
        if (comb(sc) >= comb(bestC) * 0.97) {
          bestC = sc;
          break;
        }
      }
      const p = 60 / bestC.bpm;
      // ANCRE : pic de phase de la puissance des basses (traîne 0-70 ms
      // après le vrai temps), puis on remonte au TRANSITOIRE large bande
      // qui le précède — l'attaque du kick. C'est exactement là que
      // Rekordbox pose ses temps.
      const lp = histPhase(p, lpT, lpW);
      let phiLP = lp.phase;
      const kick = histArgmaxWin(p, wpTimes, wpW, phiLP - 0.09, phiLP + 0.005);
      bestC.phase = kick ? kick.phase : (phiLP - 0.03 + p) % p;
      // Même refusée ensuite, la grille du balayage donne l'octave et la
      // phase de départ du suivi dynamique (corrige les « 73 au lieu de
      // 146 » du choix d'octave par médiane d'intervalles)
      period = p;
      offset = bestC.phase;
      // Le tempo est-il vraiment constant ? Par TRONÇONS : si le pic de
      // puissance des basses garde exactement la même phase du début à la
      // fin, la grille rigide est parfaite (DAW). S'il glisse (live,
      // vinyle) on repasse au suivi dynamique. Les tronçons sans basses
      // (breaks) sont ignorés.
      const CH = Math.max(4, Math.min(10, Math.floor(dur / 30)));
      const clen = dur / CH;
      // Chaque tronçon est jugé sur DEUX signaux : puissance des basses ET
      // transitoires large bande (hats/caisse métronomiques même quand la
      // bassline groove). Le tronçon vaut le meilleur des deux — un
      // changement de pattern touche rarement les deux à la fois.
      const chunkDevList = (Ts, Ws, phi, minCount) => {
        let tot = 0;
        for (const w of Ws) tot += w;
        const out = new Array(CH).fill(null);
        let k0 = 0;
        for (let c = 0; c < CH; c++) {
          const t1 = (c + 1) * clen;
          const ts = [];
          const ws = [];
          let chMass = 0;
          while (k0 < Ts.length && Ts[k0] < t1) {
            ts.push(Ts[k0]);
            ws.push(Ws[k0]);
            chMass += Ws[k0];
            k0++;
          }
          // tronçon quasi muet : pas d'information de phase
          if (ts.length < minCount || chMass < (tot / CH) * 0.15) continue;
          const r = histArgmaxWin(p, ts, ws, phi - p / 5, phi + p / 5);
          if (!r || r.mass < r.tot * 0.08) continue;
          out[c] = circDist(r.phase, phi, p);
        }
        return out;
      };
      const dLP = chunkDevList(lpT, lpW, phiLP, 50);
      const dWB = chunkDevList(wpTimes, wpW, bestC.phase, 20);
      const devs = [];
      for (let c = 0; c < CH; c++) {
        if (dLP[c] != null && dWB[c] != null) devs.push(Math.min(dLP[c], dWB[c]));
        else if (dLP[c] != null) devs.push(dLP[c]);
        else if (dWB[c] != null) devs.push(dWB[c]);
      }
      devs.sort((a, b) => a - b);
      // Seuils volontairement stricts : une grille rigide à MAUVAIS BPM est
      // bien pire qu'un repli dynamique approché (testé : les assouplir
      // faisait accepter 142 au lieu de 144 sur du funk groovy)
      const rigidOk =
        (devs.length >= 3 && devs[devs.length >> 1] <= 0.015 && devs[Math.floor(devs.length * 0.75)] <= 0.03) ||
        (devs.length === 2 && devs[0] <= 0.01 && devs[1] <= 0.02);
      rigidDev = devs.length ? Math.round(devs[devs.length >> 1] * 1000) : 1000;
      if (rigidOk) {
        rigidBpm = Math.round(bestC.bpm * 100) / 100;
        rigidPhase = bestC.phase;
        period = 60 / rigidBpm;
      }
    }
  }

  // ---- GRILLE DYNAMIQUE : suivi battement par battement ----
  // Sert de repli quand le tempo varie, ET de contre-vérification du
  // verrou rigide.
  const buildDynamic = () => {
  const beats = [];
  // Chaque temps est posé sur l'attaque réelle la plus proche de la
  // prédiction (la période s'adapte doucement). Une grille à BPM fixe ne
  // peut pas être parfaite sur un tempo qui varie — celle-ci, si.
  const findPeakNear = (center, radius) => {
    const j0 = Math.max(2, Math.round((center - radius) * sr / hop));
    const j1 = Math.min(nH - 3, Math.round((center + radius) * sr / hop));
    const jc = (center * sr) / hop;
    const jr = (radius * sr) / hop;
    let bj = -1;
    let bv = 0;
    let bScore = 0;
    for (let j = j0; j <= j1; j++) {
      if (onset[j] >= onset[j - 1] && onset[j] >= onset[j + 1]) {
        // Score = force × proximité de la prédiction : on ne saute plus sur
        // une caisse claire voisine juste parce qu'elle est plus forte
        const w = 1 - Math.pow((j - jc) / jr, 2);
        const score = onset[j] * Math.max(0.1, w);
        if (score > bScore) {
          bScore = score;
          bv = onset[j];
          bj = j;
        }
      }
    }
    if (bj < 0) return null;
    const y1 = onset[bj - 1] || 0;
    const y2 = onset[bj];
    const y3 = onset[bj + 1] || 0;
    const den = y1 - 2 * y2 + y3;
    let delta = den ? (0.5 * (y1 - y3)) / den : 0;
    if (delta > 0.5) delta = 0.5;
    if (delta < -0.5) delta = -0.5;
    return { t: ((bj + 0.5 + delta) * hop) / sr, v: bv };
  };

  // --- Découpage en SECTIONS : basses actives vs breaks/moments chill ---
  // Dans les trous sans kick, l'ancien suivi dérivait puis repartait faux
  // pour toute la fin du morceau. Ici chaque section de basses est
  // RE-ANCRÉE sur son propre kick de reprise, et les breaks sont pontés
  // proprement entre deux sections.
  const segStep = Math.max(1, Math.round(0.25 / hopSec)); // pas de 0,25 s
  const nSegs = Math.max(1, Math.floor(nH / segStep));
  const segE = new Float32Array(nSegs);
  for (let s2 = 0; s2 < nSegs; s2++) {
    let acc = 0;
    const j0 = s2 * segStep;
    for (let j = j0; j < j0 + segStep && j < nH; j++) acc += env[j];
    segE[s2] = acc / segStep;
  }
  const sortedE = [...segE].sort((a, b) => a - b);
  const refE = sortedE[Math.floor(nSegs * 0.8)] || 0;
  const smooth = [];
  for (let s2 = 0; s2 < nSegs; s2++) smooth.push(segE[s2] > refE * 0.22);
  // Combler les petits trous (< 2 s) puis retirer les îlots isolés (< 1,5 s)
  const holeMax = Math.round(2 / 0.25);
  const isleMin = Math.round(1.5 / 0.25);
  let i2 = 0;
  while (i2 < nSegs) {
    if (!smooth[i2]) {
      let j2 = i2;
      while (j2 < nSegs && !smooth[j2]) j2++;
      if (i2 > 0 && j2 < nSegs && (j2 - i2) <= holeMax) {
        for (let k2 = i2; k2 < j2; k2++) smooth[k2] = true;
      }
      i2 = j2;
    } else i2++;
  }
  i2 = 0;
  while (i2 < nSegs) {
    if (smooth[i2]) {
      let j2 = i2;
      while (j2 < nSegs && smooth[j2]) j2++;
      if ((j2 - i2) < isleMin) {
        for (let k2 = i2; k2 < j2; k2++) smooth[k2] = false;
      }
      i2 = j2;
    } else i2++;
  }
  const sections = [];
  i2 = 0;
  while (i2 < nSegs) {
    if (smooth[i2]) {
      let j2 = i2;
      while (j2 < nSegs && smooth[j2]) j2++;
      sections.push({ a: i2 * segStep * hopSec, b: j2 * segStep * hopSec });
      i2 = j2;
    } else i2++;
  }
  if (!sections.length) sections.push({ a: 0, b: dur });

  // Kick de reprise d'une section : la plus forte attaque dans ses 2,5 premières secondes
  const anchorIn = (a, b) => {
    const j0 = Math.max(2, Math.round(a / hopSec));
    const j1 = Math.min(nH - 3, Math.round(Math.min(b, a + 2.5) / hopSec));
    let bj = -1;
    let bv = 0;
    for (let j = j0; j <= j1; j++) {
      if (onset[j] > bv && onset[j] >= onset[j - 1] && onset[j] >= onset[j + 1]) {
        bv = onset[j];
        bj = j;
      }
    }
    if (bj < 0) return a;
    const y1 = onset[bj - 1] || 0;
    const y2 = onset[bj];
    const y3 = onset[bj + 1] || 0;
    const den = y1 - 2 * y2 + y3;
    let dd = den ? (0.5 * (y1 - y3)) / den : 0;
    if (dd > 0.5) dd = 0.5;
    if (dd < -0.5) dd = -0.5;
    return (bj + dd) * hopSec;
  };

  let p = period;
  for (const sec of sections) {
    let anchor = anchorIn(sec.a, sec.b);
    if (beats.length) {
      const last = beats[beats.length - 1];
      if (anchor <= last + p * 0.5) {
        anchor = last + p; // sections qui se touchent : continuité simple
      } else {
        // Pont du break : nombre entier de temps réparti uniformément
        const gapBeats = Math.max(1, Math.round((anchor - last) / p));
        const step = (anchor - last) / gapBeats;
        if (step > p * 0.7 && step < p * 1.3) {
          for (let g = 1; g < gapBeats; g++) {
            beats.push(Math.round((last + g * step) * 1000) / 1000);
          }
        } else {
          let tb = last + p;
          while (tb < anchor - p * 0.6) {
            beats.push(Math.round(tb * 1000) / 1000);
            tb += p;
          }
        }
      }
    } else if (anchor > p * 0.6) {
      // Remonter du premier ancrage vers le début du fichier
      const pre = [];
      let tb = anchor - p;
      while (tb > 0.02) {
        pre.push(tb);
        tb -= p;
      }
      pre.reverse().forEach(v => beats.push(Math.round(v * 1000) / 1000));
    }
    // Suivi kick par kick à l'intérieur de la section
    let t = anchor;
    let prev = beats.length ? beats[beats.length - 1] : null;
    while (t < sec.b + p * 0.5 && beats.length < 5000) {
      const found = findPeakNear(t, p * 0.15);
      const bt = found && found.v > maxO * 0.03 ? found.t : t;
      if (!beats.length || bt > beats[beats.length - 1] + p * 0.3) {
        beats.push(Math.round(bt * 1000) / 1000);
      }
      if (prev != null) {
        const d = bt - prev;
        if (d > p * 0.7 && d < p * 1.3) p = 0.92 * p + 0.08 * d; // adaptation douce
      }
      prev = bt;
      t = bt + p;
    }
  }
  // Prolonger jusqu'à la fin du fichier (outro silencieuse)
  if (beats.length) {
    let tb = beats[beats.length - 1] + p;
    while (tb < dur + p * 0.5 && beats.length < 5000) {
      beats.push(Math.round(tb * 1000) / 1000);
      tb += p;
    }
  }
  return beats;
  }; // fin de buildDynamic

  let beats = [];
  if (rigidBpm) {
    // Grille rigide : période constante, une seule ancre — zéro dérive.
    // Précision 0,1 ms (Rekordbox arrondit à la ms).
    // (contre-vérifier par le tracker dynamique a été testé et retiré : le
    // tracker divague sur les contretemps et démolissait des grilles justes)
    for (let t = rigidPhase; t < dur + period * 0.5 && beats.length < 6000; t += period) {
      beats.push(Math.round(t * 10000) / 10000);
    }
  } else {
    beats = buildDynamic();
  }

  // --- Recalage final sur les transitoires LARGE BANDE du fichier original ---
  // Le filtre passe-bas de l'analyse retarde les attaques de quelques ms
  // (retard de groupe) : c'était le micro-décalage constant sur TOUS les sons.
  if (beats.length > 8) {
    const snapAt = (k) => wPeakNear(beats[k], 0.014);
    if (rigidBpm) {
      // Grille rigide : on ne resnappe PAS chaque temps (ça recréerait du
      // jitter) — on mesure le décalage MÉDIAN vers les vrais transitoires
      // et on décale la grille entière une seule fois.
      const deltas = [];
      for (let k = 0; k < beats.length; k++) {
        const f = snapAt(k);
        if (f) deltas.push(f.t - beats[k]);
      }
      if (deltas.length >= 16) {
        deltas.sort((a, b) => a - b);
        const shift = deltas[deltas.length >> 1];
        if (Math.abs(shift) <= 0.016) {
          for (let k = 0; k < beats.length; k++) {
            beats[k] = Math.round((beats[k] + shift) * 10000) / 10000;
          }
        }
      }
    } else {
      for (let k = 0; k < beats.length; k++) {
        const f = snapAt(k);
        if (f && Math.abs(f.t - beats[k]) <= 0.016) {
          beats[k] = Math.round(f.t * 1000) / 1000;
        }
      }
    }
  }

  // Lissage des aberrations : un temps qui casse la régularité locale
  // (accroché sur un contretemps) est repositionné entre ses voisins.
  // Inutile sur une grille rigide (parfaitement régulière par construction).
  if (!rigidBpm && beats.length > 8) {
    const ivs = [];
    for (let i = 1; i < beats.length; i++) ivs.push(beats[i] - beats[i - 1]);
    ivs.sort((a, b) => a - b);
    const med = ivs[ivs.length >> 1];
    for (let pass = 0; pass < 2; pass++) {
      for (let k = 1; k < beats.length - 1; k++) {
        const expected = (beats[k - 1] + beats[k + 1]) / 2;
        if (Math.abs(beats[k] - expected) > med * 0.15) {
          beats[k] = Math.round(expected * 1000) / 1000;
        }
      }
    }
  }

  // --- Détection du « 1 » (downbeat) et des phrases de 4 mesures ---
  // Comme Rekordbox : le trait rouge doit tomber sur le kick qui lance la
  // mesure, et l'ancre de phrase sur celui qui relance après 4/8/16 mesures.
  let barAnchor = 0;
  if (beats.length > 32) {
    const onsB = [];
    const envB = [];
    for (const t of beats) {
      const j = Math.round(t / hopSec);
      let o = 0;
      let e = 0;
      for (let d = -1; d <= 1; d++) {
        if (onset[j + d] > o) o = onset[j + d] || 0;
        if (env[j + d] > e) e = env[j + d] || 0;
      }
      onsB.push(o);
      envB.push(e);
    }
    // Nouveauté : hausse d'énergie après un creux = début de phrase (drop)
    const nB = beats.length;
    const novelty = new Array(nB).fill(0);
    for (let k = 8; k < nB - 8; k++) {
      let prev = 0;
      let next = 0;
      for (let d = 1; d <= 8; d++) {
        prev += envB[k - d];
        next += envB[k + d - 1];
      }
      novelty[k] = Math.max(0, (next - prev) / 8);
    }
    // 1) Downbeat : la phase (mod 4) où les kicks sont les plus marqués
    const s4 = [0, 0, 0, 0];
    for (let k = 0; k < nB; k++) s4[k % 4] += onsB[k] + novelty[k] * 2;
    let p4 = 0;
    for (let p = 1; p < 4; p++) if (s4[p] > s4[p4]) p4 = p;
    // 2) Phrase : parmi les 4 mesures candidates, celle où l'énergie relance
    const s16 = [0, 0, 0, 0];
    for (let k = 0; k < nB; k++) {
      if (k % 4 === p4 % 4) s16[(Math.floor(k / 4) % 4 + 4) % 4] += novelty[k];
    }
    let q = 0;
    for (let i = 1; i < 4; i++) if (s16[i] > s16[q]) q = i;
    barAnchor = p4 + q * 4;
  }

  // BPM affiché : la valeur verrouillée exacte (143.00 comme Rekordbox) en
  // grille rigide, sinon la médiane des périodes réelles
  let bpmOut = 60 / period;
  if (rigidBpm) {
    bpmOut = rigidBpm;
  } else if (beats.length > 8) {
    const ds = [];
    for (let i = 1; i < beats.length; i++) ds.push(beats[i] - beats[i - 1]);
    ds.sort((a, b) => a - b);
    const med = ds[ds.length >> 1];
    if (med > 0) bpmOut = 60 / med;
  }

  return {
    bpm: Math.round(bpmOut * 1000) / 1000,
    beatOffset: beats.length ? beats[0] : Math.round(offset * 10000) / 10000,
    beats: beats.length > 8 ? beats : null,
    barAnchor,
    // Diagnostic (non persisté) : grille rigide ? déviation médiane de phase
    // par tronçons (ms) — grand = tempo variable
    rigid: !!rigidBpm,
    q: rigidDev
  };
}

// Recale une grille IMPORTÉE (Rekordbox) sur la timeline de NOTRE décodeur.
// Mesuré : les mp3 encodés LAME ont ~51 ms d'écart de timeline entre le
// décodeur de Chrome (qui retire le délai d'encodeur) et celui de Rekordbox
// (qui le garde). On mesure le décalage médian grille → transitoires réels
// du fichier décodé et on l'applique une seule fois à toute la grille.
export function alignImportedGrid(buffer, beats) {
  if (!beats || beats.length < 8) return { beats, shift: 0 };
  const osr = buffer.sampleRate;
  const ch0 = buffer.getChannelData(0);
  const ch1 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : ch0;
  const whop = Math.max(1, Math.floor(osr * 0.002)); // pas de 2 ms
  const wn = Math.floor(ch0.length / whop);
  if (wn < 100) return { beats, shift: 0 };
  const wenv = new Float32Array(wn);
  for (let j = 0; j < wn; j++) {
    let m = 0;
    const s0 = j * whop;
    const s1 = s0 + whop;
    for (let i = s0; i < s1; i += 2) {
      const v = Math.abs((ch0[i] + ch1[i]) * 0.5);
      if (v > m) m = v;
    }
    wenv[j] = m;
  }
  const wons = new Float32Array(wn);
  for (let j = 1; j < wn; j++) wons[j] = Math.max(0, wenv[j] - wenv[j - 1]);
  const whopSec = whop / osr;
  const R = Math.round(0.08 / whopSec); // ±80 ms : couvre 0/±26/±51 ms
  const deltas = [];
  for (const b of beats) {
    const jc = Math.round(b / whopSec);
    if (jc < 2 || jc >= wn - 2) continue;
    let bj = -1;
    let bv = 0;
    for (let j = Math.max(1, jc - R); j <= Math.min(wn - 2, jc + R); j++) {
      if (wons[j] > bv) {
        bv = wons[j];
        bj = j;
      }
    }
    if (bj > 0) deltas.push(bj * whopSec - b);
  }
  if (deltas.length < 16) return { beats, shift: 0 };
  deltas.sort((a, b) => a - b);
  const shift = deltas[deltas.length >> 1];
  // sous 4 ms ce n'est pas un écart de décodeur, au-delà de 80 ms c'est louche
  if (Math.abs(shift) < 0.004 || Math.abs(shift) > 0.08) return { beats, shift: 0 };
  return { beats: beats.map((b) => Math.round((b + shift) * 10000) / 10000), shift };
}

function bestPhase(onset, hop, sr, period) {
  const periodH = (period * sr) / hop;
  const steps = 64;
  const spanH = Math.min(onset.length, Math.floor((40 * sr) / hop));
  let best = 0;
  let bestScore = -1;
  for (let s = 0; s < steps; s++) {
    const off0 = (periodH * s) / steps;
    let score = 0;
    for (let x = off0; x < spanH; x += periodH) {
      const j = Math.round(x);
      let m = 0;
      for (let d = -1; d <= 1; d++) {
        const v = onset[j + d] || 0;
        if (v > m) m = v;
      }
      score += m;
    }
    if (score > bestScore) {
      bestScore = score;
      best = off0;
    }
  }
  return (best * hop) / sr;
}
