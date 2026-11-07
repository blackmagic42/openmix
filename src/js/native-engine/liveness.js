// OpenMix native engine, renderer proxy (owner: jsproxy, native/engine/SPEC.md §17.6, App. B):
// the liveness rule that decides the engine host is dead or hung.
//
// The host emits `state` (only when the audio thread rendered a new block)
// and `hb` (every 250 ms whatever the audio does). The engine is declared
// dead when NEITHER arrived for >= 3 s, measured only while the renderer's
// own loop was responsive -- a 100 ms interval timer whose ticks count
// towards the 3 s only when they arrive less than 50 ms late, so UI jank
// (detectBPM, computeBandPeaks, alignStems...) never triggers it -- AND a
// clock.ping sent after the silence began got no clock.pong within 1 s
// (counted the same way).

export const LIVENESS_TICK_MS = 100;
export const LIVENESS_LATE_MS = 50;
export const LIVENESS_SILENCE_MS = 3000;
export const LIVENESS_PING_MS = 1000;

export class LivenessMonitor {
  constructor({ env, sendPing, onDead, tickMs = LIVENESS_TICK_MS, lateMs = LIVENESS_LATE_MS,
    silenceMs = LIVENESS_SILENCE_MS, pingMs = LIVENESS_PING_MS }) {
    this.env = env;
    this.sendPing = sendPing;
    this.onDead = onDead;
    this.tickMs = tickMs;
    this.lateMs = lateMs;
    this.silenceMs = silenceMs;
    this.pingMs = pingMs;
    this.silent = 0;        // responsive ms without state/hb
    this.pingWait = -1;     // responsive ms waiting for the pong (-1 = no ping out)
    this.lastTick = 0;
    this.timer = null;
    this.dead = false;
    this.stats = { lateTicks: 0, pings: 0 };
  }

  start() {
    if (this.timer != null) return;
    this.lastTick = this.env.now();
    this.timer = this.env.setInterval(() => this.tick(), this.tickMs);
  }

  stop() {
    if (this.timer != null) this.env.clearInterval(this.timer);
    this.timer = null;
  }

  /** A `state` or `hb` event arrived. */
  heard() {
    this.silent = 0;
    this.pingWait = -1;
  }

  /** A clock.pong arrived: the host's JS thread answers (next liveness ping in 1 s at the earliest). */
  pong() {
    if (this.pingWait < 0) return;
    this.pingWait = -1;
    this.silent = Math.min(this.silent, this.silenceMs - this.pingMs);
  }

  tick() {
    const now = this.env.now();
    const late = now - this.lastTick - this.tickMs;
    this.lastTick = now;
    if (this.dead) return;
    if (late >= this.lateMs) {
      // the renderer itself was busy: this interval proves nothing
      this.stats.lateTicks++;
      return;
    }
    this.silent += this.tickMs;
    if (this.pingWait >= 0) {
      this.pingWait += this.tickMs;
      if (this.pingWait >= this.pingMs) {
        this.dead = true;
        this.stop();
        this.onDead(`no state, heartbeat or clock answer for ${Math.round(this.silent / 100) / 10} s`);
      }
      return;
    }
    if (this.silent >= this.silenceMs) {
      this.pingWait = 0;
      this.stats.pings++;
      this.sendPing();
    }
  }
}
