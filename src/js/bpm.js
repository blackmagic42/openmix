// BPM and grid detection.
//
// 1. Isolated bass (low-pass) then ONSET STRENGTH: we measure rises in
//    energy, not raw amplitude — robust even when the bass
//    "wobbles" without clear transients.
// 2. Histogram of inter-onset intervals -> approximate BPM.
// 3. Phase anchoring on the onsets, then LINEAR REGRESSION on the
//    actual onset positions -> period to ~a thousandth of a BPM.
//    Without this refinement, a rounded BPM makes the grid drift little by little.

export async function detectBPM(buffer, range) {
  // Base BPM range (default 85-170, adjustable in the settings).
  // Smart octave selection stays active in every case.
  const RLO = range && range.lo ? range.lo : 85;
  const RHI = range && range.hi ? range.hi : 170;
  // OCTAVE CEILING: above it (range +6 %, 180 minimum), a tempo is
  // a DOUBLE TEMPO — eighth-note hi-hats fold perfectly onto
  // 2× the real BPM and always score better there (measured: Bon
  // Appétit 106 → 212, Smells Like Teen Spirit 117 → 236, Say So 111 → 222,
  // T mimi 100 → 200, Raze It Up 93 → 186). The score alone CANNOT
  // decide (a real 174 has the same ratio): the RANGE decides,
  // as in Rekordbox. Range 100-200 = ceiling 212 for hardcore.
  const FOLD_HI = Math.max(RHI * 1.06, 180);
  // Track analyzed IN FULL (up to 10 min): the regression relies on
  // kicks from the start TO THE END — no drift from extrapolation.
  // Rendered at 8 kHz: only the bass is kept, it is 5x faster.
  const seconds = Math.min(buffer.duration, 600);
  const sr = 8000;
  const length = Math.floor(seconds * sr);
  if (length < sr * 5) return null; // track too short

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

  // Envelope in 5 ms steps, then onset strength
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

  // Onset peaks (local maxima), threshold lowered until there are enough
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

  // Sub-millisecond position of each onset (parabolic interpolation)
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

  // --- Tempo by AUTOCORRELATION of the onset strength ---
  // The reference method: the beat periodicity comes out naturally,
  // even with off-beat basslines, swing or breaks (where the
  // inter-onset intervals get fooled).
  const hopSec = hop / sr;
  const acMin = Math.max(4, Math.floor((60 / RHI) / hopSec));
  const acMax = Math.min(nH - 10, Math.ceil((60 / RLO) / hopSec));
  if (acMax <= acMin + 2) return null;
  const acLen = Math.min(nH, Math.floor(240 / hopSec)); // 4 min is enough
  const acTop = Math.min(acMax * 2 + 1, nH - 2);
  const ac = new Float32Array(acTop + 1);
  for (let lag = acMin; lag <= acTop; lag++) {
    let s = 0;
    const lim = Math.min(acLen, nH - lag);
    for (let j = 0; j < lim; j++) s += onset[j] * onset[j + lag];
    ac[lag] = s;
  }
  // Best lag with harmonic reinforcement (twice the lag must correlate too)
  let bestLag = acMin;
  let bestScore = -1;
  for (let lag = acMin; lag <= acMax; lag++) {
    const score = ac[lag] + 0.5 * (lag * 2 <= acTop ? ac[lag * 2] : 0);
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }
  // Parabolic refinement of the lag
  const ay1 = ac[bestLag - 1] || 0;
  const ay2 = ac[bestLag];
  const ay3 = ac[bestLag + 1] || 0;
  const aden = ay1 - 2 * ay2 + ay3;
  let dl = aden ? (0.5 * (ay1 - ay3)) / aden : 0;
  if (dl > 0.5) dl = 0.5;
  if (dl < -0.5) dl = -0.5;
  let bpm0 = 60 / ((bestLag + dl) * hopSec);

  // Automatic octave choice: in techno/hard, the kick is on EVERY beat,
  // so the median inter-onset interval gives the real tempo.
  // A 190 BPM track will no longer be shown as 95.
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
        if (c < 60 || c > FOLD_HI) continue;
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

  // Anchoring: the phase that maximizes onset strength at the expected positions
  let offset = bestPhase(onset, hop, sr, period);

  // Refinement by linear regression (3 passes, narrowing window)
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

  // Normalize the anchor into [0, period)
  offset -= Math.floor(offset / period) * period;

  const dur = data.length / sr;

  // --- WIDEBAND envelope of the original file (true transients) ---
  // Built early because it is used twice: to tell kick from off-beat
  // for the rigid grid's phase, then for the final realignment (the analysis
  // low-pass delays onsets by a few ms — group delay).
  const osr = buffer.sampleRate;
  const ch0 = buffer.getChannelData(0);
  const ch1 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : ch0;
  const whop = Math.max(1, Math.floor(osr * 0.002)); // 2 ms steps
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
  // Strongest wideband onset around a given time (radius in seconds)
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

  // ---- RIGID GRID: the real Rekordbox system ----
  // Measured on 61 ANLZ analysis grids found on disk: 61/61
  // grids are perfectly RIGID (a single tempo, beats equally spaced to
  // the ms) and 60/61 have an INTEGER BPM — electronic music is
  // produced in a DAW at a fixed tempo. A rigid grid CANNOT drift.
  // So we look for the constant BPM that best aligns ALL the onsets
  // of the track (circular phase histogram: the right tempo gives a sharp
  // peak, a wrong tempo smears it out), with a lock on the integer. Beat-by-beat
  // tracking is now only a fallback when the tempo really varies
  // (live, vinyl, old funk).
  const strengths = peaks.map((j) => onset[j]);
  const histPhase = (p, ts, ws) => {
    const bins = Math.max(48, Math.round(p / 0.002));
    const hist = new Float64Array(bins);
    for (let i = 0; i < ts.length; i++) {
      const ph = ts[i] - Math.floor(ts[i] / p) * p;
      hist[Math.min(bins - 1, Math.floor((ph / p) * bins))] += ws[i];
    }
    // Triangular circular smoothing ±3 bins (≈ ±6 ms)
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
  // CONTINUOUS bass power series (env², downsampled ×2).
  // Measured against Rekordbox grids: its phase peak falls 0 to 70 ms
  // after the official beat (the kick's sub builds up just after
  // the attack) on 7 tracks out of 8 — it is the most reliable phase
  // marker, far more than onset peaks (which pick the off-beat
  // bassline) or raw transients (which pick hats and claps).
  const lpT = [];
  const lpW = [];
  for (let j = 0; j < nH; j += 2) {
    lpT.push(j * hopSec);
    lpW.push(env[j] * env[j]);
  }
  // Raw wideband onsets (local maxima ≥ 12 % of the max, spaced
  // at least 100 ms apart): used to find the kick ATTACK just before
  // the bass power peak.
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
  // Argmax of the smoothed histogram restricted to a circular window [lo, hi].
  // pickLatest: takes the LAST peak ≥ 60 % of the window max (the kick
  // attack is the last transient before the sub blooms).
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
    const inWin = []; // {i, s, x} of the bins inside the window
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
    // The octave is re-checked here: kicks on every other beat → the estimate
    // lands at half the real tempo. We sweep every plausible octave and
    // the one INSIDE the chosen range wins unless it aligns clearly worse.
    // Octaves AND ternary ratios: dotted/triplet rhythms trap
    // the autocorrelation at ⅔ or 4/3 of the real tempo (measured: 96 instead of
    // 144, 103.3 instead of 155, 192 instead of 144). Pure octaves
    // (×2, ×½) may fall outside the range (a real 190 exists); ternary
    // ratios are only allowed to win INSIDE the range —
    // outside the range, a ternary is always a misreading.
    // Window ±1.2 around octaves, ±3 around ternaries (the estimation
    // error is amplified by the ratio: 1.5 × 94.7 = 142 while
    // the real tempo is 144 — it has to be INSIDE the window to win)
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
    // DUAL score for each candidate: sharpness of the phase peak of the
    // bass power AND of the wideband transients. The two complement
    // each other: the bass may groove (funk) but the hats are
    // metronomic; the hats may be missing but the sub is there.
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
    // FULL SWEEP of the range (the fix for "162 instead of
    // 145"): the autocorrelation can lock onto a tempo with NO simple
    // ratio to the real one (162/145 = 1.117 — neither octave nor ternary) and
    // in that case NO candidate close to the real one was even in the
    // race. Here the WHOLE range competes: a coarse pass (0.5 BPM) on
    // the dual phase score, then fine refinement of the 3 best basins.
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
      let bo = null; // best octave (all of them, even out of range — a real 190 exists)
      let boIn = null; // best octave inside the range
      let bt = null; // best ternary (already restricted to the range)
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
      // A ternary only wins if it CRUSHES the octave: at the subharmonic the
      // alignment mass splits into 3 peaks (~⅓ each), at the real tempo
      // it forms ONE single peak — genuine corrections (96→144) clear this
      // threshold easily, swing's false friends never do.
      if (bt && (!bestC || comb(bt) >= comb(bestC) * 1.15)) bestC = bt;
      // Above the ceiling: it is the HALF (refined around bpm/2 —
      // the double-tempo estimate is the more precise of the two)
      if (bestC && bestC.bpm > FOLD_HI) {
        const h0 = bestC.bpm / 2;
        let hb = dual(h0);
        for (let c = h0 - 0.1; c <= h0 + 0.1; c += 0.01) {
          const x = dual(c);
          if (comb(x) > comb(hb)) hb = x;
        }
        bestC = { ...hb, tern: false };
      }
    }
    if (bestC) {
      // Rekordbox-style lock: the integer (then the half) wins if it does
      // almost as well as the best fractional candidate
      for (const snap of [Math.round(bestC.bpm), Math.round(bestC.bpm * 2) / 2]) {
        if (Math.abs(snap - bestC.bpm) < 0.005) break;
        const sc = dual(snap);
        if (comb(sc) >= comb(bestC) * 0.97) {
          bestC = sc;
          break;
        }
      }
      const p = 60 / bestC.bpm;
      // ANCHOR: phase peak of the bass power (lags 0-70 ms
      // behind the real beat), then we step back to the wideband TRANSIENT
      // that precedes it — the kick attack. That is exactly where
      // Rekordbox places its beats.
      const lp = histPhase(p, lpT, lpW);
      let phiLP = lp.phase;
      const kick = histArgmaxWin(p, wpTimes, wpW, phiLP - 0.09, phiLP + 0.005);
      bestC.phase = kick ? kick.phase : (phiLP - 0.03 + p) % p;
      // Even if rejected later, the sweep's grid gives the octave and the
      // starting phase for dynamic tracking (fixes the "73 instead of
      // 146" from the octave choice by median interval)
      period = p;
      offset = bestC.phase;
      // Is the tempo really constant? By CHUNKS: if the bass power
      // peak keeps exactly the same phase from start to
      // end, the rigid grid is perfect (DAW). If it slides (live,
      // vinyl) we fall back to dynamic tracking. Chunks without bass
      // (breaks) are ignored.
      const CH = Math.max(4, Math.min(10, Math.floor(dur / 30)));
      const clen = dur / CH;
      // Each chunk is judged on TWO signals: bass power AND
      // wideband transients (hats/snare stay metronomic even when the
      // bassline grooves). The chunk takes the better of the two — a
      // pattern change rarely affects both at once.
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
          // nearly silent chunk: no phase information
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
      // Deliberately strict thresholds: a rigid grid with the WRONG BPM is
      // much worse than an approximate dynamic fallback (tested: loosening them
      // made it accept 142 instead of 144 on groovy funk)
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

  // ---- DYNAMIC GRID: beat-by-beat tracking ----
  // Serves as a fallback when the tempo varies, AND as a cross-check of the
  // rigid lock.
  const buildDynamic = () => {
  const beats = [];
  // Each beat is placed on the actual onset closest to the
  // prediction (the period adapts gently). A fixed-BPM grid cannot
  // be perfect on a varying tempo — this one can.
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
        // Score = strength × closeness to the prediction: no more jumping onto
        // a neighboring snare just because it is louder
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

  // --- Splitting into SECTIONS: active bass vs breaks/chill moments ---
  // In the gaps without a kick, the old tracker drifted and then restarted wrong
  // for the whole rest of the track. Here each bass section is
  // RE-ANCHORED on its own re-entry kick, and breaks are bridged
  // cleanly between two sections.
  const segStep = Math.max(1, Math.round(0.25 / hopSec)); // 0.25 s steps
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
  // Fill small holes (< 2 s) then remove isolated islands (< 1.5 s)
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

  // Re-entry kick of a section: the strongest onset in its first 2.5 seconds
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
        anchor = last + p; // touching sections: simple continuity
      } else {
        // Bridging the break: a whole number of beats spread evenly
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
      // Walk back from the first anchor to the start of the file
      const pre = [];
      let tb = anchor - p;
      while (tb > 0.02) {
        pre.push(tb);
        tb -= p;
      }
      pre.reverse().forEach(v => beats.push(Math.round(v * 1000) / 1000));
    }
    // Kick-by-kick tracking inside the section
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
        if (d > p * 0.7 && d < p * 1.3) p = 0.92 * p + 0.08 * d; // gentle adaptation
      }
      prev = bt;
      t = bt + p;
    }
  }
  // Extend to the end of the file (silent outro)
  if (beats.length) {
    let tb = beats[beats.length - 1] + p;
    while (tb < dur + p * 0.5 && beats.length < 5000) {
      beats.push(Math.round(tb * 1000) / 1000);
      tb += p;
    }
  }
  return beats;
  }; // end of buildDynamic

  let beats = [];
  if (rigidBpm) {
    // Rigid grid: constant period, a single anchor — zero drift.
    // 0.1 ms precision (Rekordbox rounds to the ms).
    // (cross-checking with the dynamic tracker was tested and removed: the
    // tracker wanders off on off-beats and was wrecking correct grids)
    for (let t = rigidPhase; t < dur + period * 0.5 && beats.length < 6000; t += period) {
      beats.push(Math.round(t * 10000) / 10000);
    }
  } else {
    beats = buildDynamic();
  }

  // --- Final realignment on the WIDEBAND transients of the original file ---
  // The analysis low-pass filter delays onsets by a few ms
  // (group delay): that was the constant micro-offset on ALL tracks.
  if (beats.length > 8) {
    const snapAt = (k) => wPeakNear(beats[k], 0.014);
    if (rigidBpm) {
      // Rigid grid: do NOT re-snap each beat (that would recreate
      // jitter) — measure the MEDIAN offset to the true transients
      // and shift the whole grid just once.
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

  // Outlier smoothing: a beat that breaks the local regularity
  // (caught on an off-beat) is repositioned between its neighbors.
  // Useless on a rigid grid (perfectly regular by construction).
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

  // LAST OCTAVE SAFEGUARD (paths without a sweep: few onsets,
  // short track…): a grid above the ceiling keeps EVERY OTHER
  // BEAT — the parity whose onsets are strongest (the beats,
  // not the off-beats)
  if (beats.length > 16) {
    const ivs = [];
    for (let i = 1; i < beats.length; i++) ivs.push(beats[i] - beats[i - 1]);
    ivs.sort((a, b) => a - b);
    const medI = ivs[ivs.length >> 1];
    if (medI > 0 && 60 / medI > FOLD_HI) {
      const strength = [0, 0];
      for (let k = 0; k < beats.length; k++) {
        const j = Math.round(beats[k] / hopSec);
        strength[k % 2] += Math.max(onset[j - 1] || 0, onset[j] || 0, onset[j + 1] || 0);
      }
      const par = strength[1] > strength[0] ? 1 : 0;
      beats = beats.filter((_, k) => k % 2 === par);
      period *= 2;
      if (rigidBpm) rigidBpm = Math.round((rigidBpm / 2) * 100) / 100;
    }
  }

  // --- Detection of the "1" (downbeat) and of 4-bar phrases ---
  // Like Rekordbox: the red line must fall on the kick that starts the
  // bar, and the phrase anchor on the one that kicks back in after 4/8/16 bars.
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
    // Novelty: energy rise after a dip = start of a phrase (drop)
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
    // 1) Downbeat: the phase (mod 4) where the kicks are most pronounced
    const s4 = [0, 0, 0, 0];
    for (let k = 0; k < nB; k++) s4[k % 4] += onsB[k] + novelty[k] * 2;
    let p4 = 0;
    for (let p = 1; p < 4; p++) if (s4[p] > s4[p4]) p4 = p;
    // 2) Phrase: among the 4 candidate bars, the one where the energy picks back up
    const s16 = [0, 0, 0, 0];
    for (let k = 0; k < nB; k++) {
      if (k % 4 === p4 % 4) s16[(Math.floor(k / 4) % 4 + 4) % 4] += novelty[k];
    }
    let q = 0;
    for (let i = 1; i < 4; i++) if (s16[i] > s16[q]) q = i;
    barAnchor = p4 + q * 4;
  }

  // Displayed BPM: the exact locked value (143.00 like Rekordbox) on a
  // rigid grid, otherwise the median of the actual periods
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
    // Diagnostic (not persisted): rigid grid? median phase deviation
    // per chunk (ms) — large = variable tempo
    rigid: !!rigidBpm,
    q: rigidDev
  };
}

// Realigns an IMPORTED grid (Rekordbox) onto OUR decoder's timeline.
// Measured: LAME-encoded mp3s have a ~51 ms timeline offset between
// Chrome's decoder (which strips the encoder delay) and Rekordbox's
// (which keeps it). We measure the median offset grid → real transients
// of the decoded file and apply it once to the whole grid.
export function alignImportedGrid(buffer, beats) {
  if (!beats || beats.length < 8) return { beats, shift: 0 };
  const osr = buffer.sampleRate;
  const ch0 = buffer.getChannelData(0);
  const ch1 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : ch0;
  const whop = Math.max(1, Math.floor(osr * 0.002)); // 2 ms steps
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
  const R = Math.round(0.08 / whopSec); // ±80 ms: covers 0/±26/±51 ms
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
  // under 4 ms it is not a decoder offset, beyond 80 ms it is suspicious
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
