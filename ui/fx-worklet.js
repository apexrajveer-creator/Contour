// Contour · mixing effects for the live preview. A line-for-line twin of engine/src/fx.rs, so what you
// hear while dragging is what an export renders (checked against the engine on the same test signal).
'use strict';
const FX_SR = typeof sampleRate === 'number' ? sampleRate : 44100;

class Biquad {
  constructor(b, a) { this.b0 = b[0] / a[0]; this.b1 = b[1] / a[0]; this.b2 = b[2] / a[0]; this.a1 = a[1] / a[0]; this.a2 = a[2] / a[0]; this.z1 = [0, 0]; this.z2 = [0, 0]; }
  static lowShelf(f, db) {
    const a = Math.pow(10, db / 40), w = (2 * Math.PI * f) / FX_SR, c = Math.cos(w), alpha = (Math.sin(w) / 2) * Math.SQRT2, s = 2 * Math.sqrt(a) * alpha;
    return new Biquad([a * (a + 1 - (a - 1) * c + s), 2 * a * (a - 1 - (a + 1) * c), a * (a + 1 - (a - 1) * c - s)], [a + 1 + (a - 1) * c + s, -2 * (a - 1 + (a + 1) * c), a + 1 + (a - 1) * c - s]);
  }
  static highShelf(f, db) {
    const a = Math.pow(10, db / 40), w = (2 * Math.PI * f) / FX_SR, c = Math.cos(w), alpha = (Math.sin(w) / 2) * Math.SQRT2, s = 2 * Math.sqrt(a) * alpha;
    return new Biquad([a * (a + 1 + (a - 1) * c + s), -2 * a * (a - 1 + (a + 1) * c), a * (a + 1 + (a - 1) * c - s)], [a + 1 - (a - 1) * c + s, 2 * (a - 1 - (a + 1) * c), a + 1 - (a - 1) * c - s]);
  }
  static peaking(f, q, db) {
    const a = Math.pow(10, db / 40), w = (2 * Math.PI * f) / FX_SR, c = Math.cos(w), alpha = Math.sin(w) / (2 * q);
    return new Biquad([1 + alpha * a, -2 * c, 1 - alpha * a], [1 + alpha / a, -2 * c, 1 - alpha / a]);
  }
  run(ch, x) { const y = this.b0 * x + this.z1[ch]; this.z1[ch] = this.b1 * x - this.a1 * y + this.z2[ch]; this.z2[ch] = this.b2 * x - this.a2 * y; return y; }
}

/** Warmth, Clarity, Punch, Width: mirrors `process_stem`. */
class StemDsp {
  constructor() { this.set({ warmth: 0, clarity: 0, punch: 0, width: 0.5 }); this.env = 0; }
  set(p) {
    const keep = this.warm ? [this.warm, this.pres, this.air] : null;
    const w = Math.min(1, Math.max(0, +p.warmth || 0)), c = Math.min(1, Math.max(-1, +p.clarity || 0)), k = Math.min(1, Math.max(0, +p.punch || 0));
    this.wd = Math.min(1, Math.max(0, p.width ?? 0.5));
    this.neutral = Math.abs(w) < 1e-4 && Math.abs(c) < 1e-4 && Math.abs(k) < 1e-4 && Math.abs(this.wd - 0.5) < 1e-4;
    this.warm = Biquad.lowShelf(220, 6 * w);
    this.pres = Biquad.peaking(3200, 0.9, c > 0 ? 4 * c : 1.5 * c);
    this.air = Biquad.highShelf(8000, c > 0 ? 4 * c : 9 * c);
    if (keep) { this.warm.z1 = keep[0].z1; this.warm.z2 = keep[0].z2; this.pres.z1 = keep[1].z1; this.pres.z2 = keep[1].z2; this.air.z1 = keep[2].z1; this.air.z2 = keep[2].z2; } // no click on change
    this.k = k; this.thr = -8 - 22 * k; this.ratio = 1 + 3 * k;
    this.makeup = Math.pow(10, (k > 0 ? Math.min(9, -this.thr * (1 - 1 / this.ratio) * 0.5) : 0) / 20);
    this.att = 1 - Math.exp(-1 / (0.008 * FX_SR)); this.rel = 1 - Math.exp(-1 / (0.12 * FX_SR));
  }
  process(inL, inR, outL, outR) {
    if (this.neutral) { outL.set(inL); outR.set(inR); return; }
    for (let i = 0; i < inL.length; i++) {
      let l = this.air.run(0, this.pres.run(0, this.warm.run(0, inL[i])));
      let r = this.air.run(1, this.pres.run(1, this.warm.run(1, inR[i])));
      if (this.k > 0) {
        const lvl = Math.max(Math.abs(l), Math.abs(r));
        this.env += (lvl > this.env ? this.att : this.rel) * (lvl - this.env);
        const db = 20 * Math.log10(Math.max(1e-9, this.env));
        const gr = db > this.thr ? (this.thr - db) * (1 - 1 / this.ratio) : 0;
        const g = Math.pow(10, gr / 20) * this.makeup;
        l *= g; r *= g;
      }
      const m = (l + r) * 0.5, s = (l - r) * 0.5 * 2 * this.wd;
      outL[i] = m + s; outR[i] = m - s;
    }
  }
}

/** Freeverb: mirrors `reverb`. Wet output only. */
class FreeverbDsp {
  constructor() {
    const COMBS = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617], APS = [556, 441, 341, 225], SPREAD = 23;
    this.ch = [0, 1].map(c => ({
      combs: COMBS.map(d => ({ buf: new Float64Array(d + (c ? SPREAD : 0)), idx: 0, store: 0 })),
      aps: APS.map(d => ({ buf: new Float64Array(d + (c ? SPREAD : 0)), idx: 0 })),
    }));
  }
  process(inL, inR, outL, outR) {
    const ROOM = 0.84, DAMP = 0.3, IN_GAIN = 0.015, WET = 3;
    for (let c = 0; c < 2; c++) {
      const st = this.ch[c], out = c ? outR : outL;
      for (let i = 0; i < inL.length; i++) {
        const x = (inL[i] + inR[i]) * IN_GAIN;
        let acc = 0;
        for (const cb of st.combs) {
          const y = cb.buf[cb.idx];
          cb.store = y * (1 - DAMP) + cb.store * DAMP;
          cb.buf[cb.idx] = x + cb.store * ROOM;
          cb.idx = (cb.idx + 1) % cb.buf.length;
          acc += y;
        }
        for (const ap of st.aps) {
          const b = ap.buf[ap.idx];
          ap.buf[ap.idx] = acc + b * 0.5;
          acc = b - acc;
          ap.idx = (ap.idx + 1) % ap.buf.length;
        }
        out[i] = acc * WET;
      }
    }
  }
}

/** Safety limiter (−1 dBFS, 5 ms look-ahead): mirrors `limit(…, compensate = false)`. */
class LimiterDsp {
  constructor() {
    this.L = 220; this.ceil = 0.8912509; this.rel = 1 - Math.exp(-1 / (0.08 * FX_SR)); this.g = 1;
    const size = 512; this.size = size;
    this.bl = new Float64Array(size); this.br = new Float64Array(size); this.pk = new Float64Array(size);
    this.t = 0; this.q = new Int32Array(size); this.qh = 0; this.qt = 0; // monotonic queue of sample times
  }
  process(inL, inR, outL, outR) {
    const { L, size } = this;
    for (let i = 0; i < inL.length; i++) {
      const t = this.t++, slot = t % size, p = Math.max(Math.abs(inL[i]), Math.abs(inR[i]));
      this.bl[slot] = inL[i]; this.br[slot] = inR[i]; this.pk[slot] = p;
      while (this.qt > this.qh && this.pk[this.q[(this.qt - 1) % size] % size] <= p) this.qt--;
      this.q[this.qt % size] = t; this.qt++;
      while (this.qt > this.qh && this.q[this.qh % size] + L < t) this.qh++;
      const m = this.pk[this.q[this.qh % size] % size];
      const need = m > this.ceil ? this.ceil / m : 1;
      this.g = need < this.g ? need : this.g + (need - this.g) * this.rel;
      const src = t - L;
      if (src >= 0) { outL[i] = this.bl[src % size] * this.g; outR[i] = this.br[src % size] * this.g; } else { outL[i] = 0; outR[i] = 0; }
    }
  }
}

if (typeof registerProcessor === 'function') {
  const wrap = (name, make) => registerProcessor(name, class extends AudioWorkletProcessor {
    constructor() { super(); this.dsp = make(); this.port.onmessage = e => this.dsp.set?.(e.data); }
    process(inputs, outputs) {
      const i = inputs[0], o = outputs[0];
      if (!o || !o[0]) return true;
      const inL = i && i[0] ? i[0] : new Float32Array(o[0].length), inR = i && i[1] ? i[1] : inL;
      this.dsp.process(inL, inR, o[0], o[1] || o[0]);
      return true;
    }
  });
  wrap('contour-stem-fx', () => new StemDsp());
  wrap('contour-reverb', () => new FreeverbDsp());
  wrap('contour-limiter', () => new LimiterDsp());
}
if (typeof module !== 'undefined') module.exports = { StemDsp, FreeverbDsp, LimiterDsp };
