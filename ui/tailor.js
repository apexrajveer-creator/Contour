// Contour · Tailor — live view of separation, drawn from the engine's real output.
//
// The song is the cloth. A glowing needle sits on the window the model is processing right now.
// Behind it the cloth is cut into threads — the actual stem envelopes the model has produced for
// each finished stretch; ahead of it the cloth is still whole. Each newly finished stretch is
// "sewn": its seams glow faintly, then fade. Shown in Simple mode; Studio stays a working space. Cascaded stages (vocals first, then lead/backing or
// drums/bass/other) cut the threads they belong to, so the order of the work is visible.
(() => {
  'use strict';
  const RATE = 50; // envelope bins per second — must match the engine's VIZ_RATE
  const SEW_MS = 1300;
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const fallback = { mix: '#8e9fb8', vocals: '#e0a946', instrumental: '#5fa4b8' };
  const colorOf = id => (typeof COLORS !== 'undefined' && COLORS[id]) || fallback[id] || '#9fb3cc';

  const T = {
    active: false, fading: false, fade: 1,
    duration: 0, peaks: null, nodes: new Map(), window: null, seams: [],
    onFrame: null, onEnd: null, raf: 0, lastT: 0,
  };
  const node = (id, parent) => {
    let n = T.nodes.get(id);
    if (!n) { n = { id, parent, children: [], data: new Float32Array(Math.ceil(T.duration * RATE) + 2).fill(NaN) }; T.nodes.set(id, n); }
    return n;
  };

  T.start = ({ duration, peaks }) => {
    T.active = true; T.fading = false; T.fade = 1;
    T.duration = Math.max(0.1, duration); T.peaks = peaks;
    T.nodes = new Map(); node('mix', null);
    T.window = null; T.seams = [];
    T._baseKey = '';
    loop();
  };

  /** One finished stretch from the engine (a VizChunk). */
  T.chunk = c => {
    if (!T.active || T.fading) return;
    const parent = node(c.parent, null);
    const names = c.layers.map(l => l[0]);
    parent.children = names; // a later pass over the same parent (an ensemble member) re-cuts it
    for (const [name, env] of c.layers) {
      const n = node(name, c.parent);
      n.parent = c.parent;
      for (let i = 0; i < env.length; i++) { const b = c.bin0 + i; if (b < n.data.length) n.data[b] = env[i]; }
    }
    T.window = c.window ? { a: c.window[0], b: c.window[1] } : null;
    T.seams.push({ a: c.from, b: c.to, t: performance.now() });
    if (T.seams.length > 8) T.seams.shift();
  };

  T.finish = () => {
    if (!T.active) return;
    T.fading = true; T.window = null;
    const t0 = performance.now();
    const step = () => {
      T.fade = Math.max(0, 1 - (performance.now() - t0) / 700);
      if (T.fade > 0) requestAnimationFrame(step); else T.stop();
    };
    requestAnimationFrame(step);
  };
  T.stop = () => {
    T.active = false; T.fading = false; cancelAnimationFrame(T.raf); T.raf = 0;
    T.onEnd?.();
  };

  function loop() {
    cancelAnimationFrame(T.raf);
    const frame = now => {
      if (!T.active) return;
      const dt = Math.min(0.05, T.lastT ? (now - T.lastT) / 1000 : 0.016);
      T.lastT = now;
      T.onFrame?.();
      T.raf = requestAnimationFrame(frame);
    };
    T.raf = requestAnimationFrame(frame);
  }

  // ── geometry helpers ──
  function baseEnvelope(cols) {
    const key = cols + ':' + (T.peaks?.length || 0);
    if (T._baseKey === key) return T._base;
    const p = T.peaks || [], out = new Float32Array(cols);
    for (let i = 0; i < cols; i++) {
      const a = Math.floor((i * p.length) / cols), b = Math.max(a + 1, Math.floor(((i + 1) * p.length) / cols));
      let s = 0; for (let j = a; j < b; j++) s += p[j] || 0;
      out[i] = s / (b - a);
    }
    const sm = new Float32Array(cols);
    for (let i = 0; i < cols; i++) { let s = 0, n = 0; for (let k = -4; k <= 4; k++) { const v = out[i + k]; if (v !== undefined) { const w = 5 - Math.abs(k); s += v * w; n += w; } } sm[i] = s / n; }
    const max = Math.max(0.05, ...sm);
    for (let i = 0; i < cols; i++) sm[i] /= max;
    T._baseKey = key; T._base = sm;
    return sm;
  }
  // Threads at one moment: descend the cut tree wherever the children have data there.
  // A thread's strength over a short span of bins (~100 ms), so the cut reads as cloth, not noise.
  // NaN until most of the span has actually been cut.
  function valueAt(n, b0, b1) {
    let s = 0, k = 0;
    for (let b = Math.max(0, b0); b <= b1 && b < n.data.length; b++) { const v = n.data[b]; if (v >= 0) { s += v; k++; } }
    return k >= (b1 - b0 + 1) * 0.6 ? s / k : NaN;
  }
  function leavesAt(b0, b1) {
    const out = [];
    const walk = (id, frac) => {
      const n = T.nodes.get(id);
      if (n && n.children.length) {
        const vals = n.children.map(c => { const cn = T.nodes.get(c); return cn ? valueAt(cn, b0, b1) : NaN; });
        const total = vals.reduce((a, v) => a + v, 0);
        if (vals.every(v => v >= 0) && total > 1e-6) { n.children.forEach((c, i) => walk(c, (frac * vals[i]) / total)); return; }
      }
      out.push([id, frac]);
    };
    walk('mix', 1);
    return out;
  }

  /** Draw the cloth into `g` over the region [x0, x0+W] × [0, H]. */
  T.paint = (g, { x0 = 0, W, H, mid, amp }) => {
    if (!T.active) return;
    const now = performance.now();
    g.save();
    g.globalAlpha = T.fade;
    const step = 2, cols = Math.max(40, Math.floor(W / step)), base = baseEnvelope(cols);
    const seamYs = new Array(cols);
    for (let i = 0; i < cols; i++) {
      const tA = (i / cols) * T.duration, tB = ((i + 1) / cols) * T.duration;
      const h = Math.max(0.6, base[i] * amp);
      let y = mid - h;
      const leaves = leavesAt(Math.floor(tA * RATE) - 3, Math.ceil(tB * RATE) + 3), ys = [];
      // Columns snap to whole pixels so neighbours never overlap (overlap doubles the transparency).
      const xa = Math.round(x0 + i * step), xb = Math.round(x0 + (i + 1) * step);
      for (let k = 0; k < leaves.length; k++) {
        const [id, frac] = leaves[k], hh = frac * 2 * h;
        g.fillStyle = colorOf(id);
        g.globalAlpha = T.fade * (id === 'mix' ? 0.3 : 0.88);
        g.fillRect(xa, y, xb - xa, hh);
        y += hh;
        if (k < leaves.length - 1) ys.push(y);
      }
      seamYs[i] = ys;
    }
    g.globalAlpha = T.fade;

    // Sewing: the seams of each newly finished stretch glow, then fade.
    g.lineWidth = 1; g.lineCap = 'round';
    for (const s of T.seams) {
      const age = (now - s.t) / SEW_MS;
      if (age >= 1) continue;
      const a = Math.pow(1 - age, 2) * 0.6;
      g.strokeStyle = `rgba(205,240,255,${a})`;
      g.shadowColor = 'rgba(120,215,255,.85)'; g.shadowBlur = 6;
      g.beginPath();
      const i0 = Math.max(0, Math.floor((s.a / T.duration) * cols)), i1 = Math.min(cols, Math.ceil((s.b / T.duration) * cols));
      for (let i = i0; i < i1; i += 3) for (const y of seamYs[i] || []) { const x = x0 + i * step; g.moveTo(x - 1.5, y - 1.5); g.lineTo(x + 1.5, y + 1.5); }
      g.stroke();
    }
    g.shadowBlur = 0;

    // The needle: the window being processed, soft-edged like the overlap window it really is.
    if (T.window && !T.fading) {
      const xa = x0 + (T.window.a / T.duration) * W, xb = x0 + (T.window.b / T.duration) * W, xc = (xa + xb) / 2;
      const grad = g.createLinearGradient(xa, 0, xb, 0);
      grad.addColorStop(0, 'rgba(140,215,255,0)'); grad.addColorStop(0.5, 'rgba(140,215,255,.09)'); grad.addColorStop(1, 'rgba(140,215,255,0)');
      g.fillStyle = grad; g.fillRect(xa, mid - amp - 14, xb - xa, 2 * amp + 28);
      const pulse = reduced() ? 0.6 : 0.5 + 0.15 * Math.sin(now / 260);
      g.strokeStyle = `rgba(215,245,255,${pulse})`; g.lineWidth = 1.2;
      g.shadowColor = 'rgba(110,210,255,.9)'; g.shadowBlur = 14;
      g.beginPath(); g.moveTo(xc, mid - amp - 10); g.lineTo(xc, mid + amp + 10); g.stroke();
      g.shadowBlur = 0;
    }

    g.restore();
  };

  window.Tailor = T;
})();
