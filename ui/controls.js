// Framework-free ports of two React Bits controls (reactbits.dev, MIT):
//  · RubberSegment: segmented control whose thumb stretches across a move, lands with a small
//    squash, and can be dragged or flicked.  Applied to every .seg.rubber / .mode.rubber group.
//  · SquishSwitch: switch whose thumb springs between ends, lengthens with speed, swells on
//    hover, and can be dragged.  Applied to every label.switch.
// The existing markup and app.js handlers are untouched: these controls read and drive the same
// buttons (aria-checked) and checkboxes (checked + change event).
(() => {
  'use strict';
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  // ── a tiny animation engine: springs and ease-out tweens on plain numbers ──
  const live = new Set();
  let raf = 0, last = 0;
  function loop(now) {
    const dt = Math.min(0.1, last ? (now - last) / 1000 : 0.016); // real time, so dropped frames don't slow motion down
    last = now;
    for (const v of [...live]) step(v, dt, now);
    raf = live.size ? requestAnimationFrame(loop) : 0;
    if (!raf) last = 0;
  }
  function kick(v) { live.add(v); if (!raf) raf = requestAnimationFrame(loop); }
  function step(v, dt, now) {
    const before = v.x;
    if (v.mode === 'tween') {
      const t = clamp((now - v.t0) / (v.dur * 1000), 0, 1), e = 1 - Math.pow(1 - t, 5); // ≈ cubic-bezier(.23,1,.32,1)
      v.x = v.from + (v.to - v.from) * e;
      v.vel = dt ? (v.x - before) / dt : 0;
      if (t >= 1) finish(v);
    } else if (v.mode === 'spring') {
      const n = Math.max(2, Math.ceil(dt / 0.004)), h = dt / n;
      for (let i = 0; i < n; i++) {
        const a = (-v.k * (v.x - v.to) - v.c * v.vel) / v.m;
        v.vel += a * h; v.x += v.vel * h;
      }
      if (Math.abs(v.x - v.to) < 0.02 && Math.abs(v.vel) < 2) { v.x = v.to; v.vel = 0; finish(v); }
    } else live.delete(v);
    v.onUpdate?.();
  }
  function finish(v) { v.mode = null; live.delete(v); const d = v.done; v.done = null; d?.(); }
  const value = (x, onUpdate) => ({ x, vel: 0, mode: null, onUpdate });
  function stop(v) { v.mode = null; v.done = null; live.delete(v); }
  function jump(v, x) { stop(v); v.x = x; v.vel = 0; v.onUpdate?.(); }
  function tween(v, to, dur) { v.mode = 'tween'; v.from = v.x; v.to = to; v.t0 = performance.now(); v.dur = dur; v.done = null; kick(v); }
  // Duration/bounce springs, in the spirit of motion's { type:'spring', duration, bounce }.
  function spring(v, to, { duration = 0.3, bounce = 0, velocity } = {}) {
    const zeta = 1 - bounce, omega = (bounce ? 5.6 : 6.6) / duration;
    v.mode = 'spring'; v.to = to; v.m = 1; v.k = omega * omega; v.c = 2 * zeta * omega;
    if (velocity !== undefined) v.vel = velocity;
    v.done = null; kick(v);
    return new Promise(res => (v.done = res));
  }
  function physical(v, to, { stiffness, damping, mass }) { v.mode = 'spring'; v.to = to; v.k = stiffness; v.c = damping; v.m = mass; v.done = null; kick(v); }

  // ═════════════════ RubberSegment ═════════════════
  const DILATE = 0.12, HANDOFF = 0.10, FLICK = 110, MAX_V = 2000, DEADZONE = 4, SLOP = 10, RUBBER = 0.55;
  const rubber = (over, dim) => (over * dim * RUBBER) / (dim + RUBBER * Math.abs(over));
  const project = (v, glide) => { const d = 1 - 0.1 * Math.pow(0.05, glide / 100); return ((v / 1000) * d) / (1 - d); };

  function rubberSegment(track, { stretch = 100, squash = 1, glide = 75 } = {}) {
    const buttons = [...track.querySelectorAll('[role="radio"]')];
    if (!buttons.length) return;
    const inset = parseFloat(getComputedStyle(track).getPropertyValue('--rs-inset')) || 3;
    const thumb = document.createElement('div');
    thumb.className = 'rubber-thumb';
    thumb.setAttribute('aria-hidden', 'true');
    buttons.forEach(b => { const s = document.createElement('span'); s.className = 'rubber-copy'; s.textContent = b.textContent; thumb.append(s); });
    track.append(thumb);

    let radius = 6, slots = [], innerW = 0, gen = 0, handoff = 0, drag = null, pendingLand = null, suppressClick = false;
    const paint = () => {
      const r = radius;
      thumb.style.clipPath = `inset(0 ${Math.max(0, innerW - R.x)}px 0 ${Math.max(0, L.x)}px round ${r}px)`;
    };
    const L = value(0, paint), R = value(0, paint);
    const current = () => Math.max(0, buttons.findIndex(b => b.getAttribute('aria-checked') === 'true'));
    let committed = current();

    function measure() {
      radius = parseFloat(getComputedStyle(track).getPropertyValue('--rs-thumb-radius')) || 6;
      const rect = track.getBoundingClientRect();
      innerW = rect.width - inset * 2;
      slots = buttons.map(b => { const r = b.getBoundingClientRect(); return { l: r.left - rect.left - inset, r: r.right - rect.left - inset }; });
      if (!drag) { jump(L, slots[committed]?.l ?? 0); jump(R, slots[committed]?.r ?? 0); }
    }
    function land(to, v, flick, withSquash) {
      const b = slots[to]; if (!b) return;
      const g = ++gen;
      const dir = Math.sign((b.l + b.r) / 2 - (L.x + R.x) / 2) || 1;
      const [lead, leadTo, trail, trailTo] = dir > 0 ? [R, b.r, L, b.l] : [L, b.l, R, b.r];
      const vel = e => clamp(v === null ? e.vel : v, -MAX_V, MAX_V);
      spring(lead, leadTo, flick ? { duration: 0.4, bounce: 0.06, velocity: vel(lead) } : { duration: 0.22, velocity: vel(lead) });
      if (!withSquash || squash <= 0) { spring(trail, trailTo, { duration: 0.22, velocity: vel(trail) }); return; }
      spring(trail, trailTo + dir * squash, { duration: 0.22, velocity: vel(trail) }).then(() => { if (gen === g) spring(trail, trailTo, { duration: 0.16 }); });
    }
    function travel(from, to) {
      const a = slots[from], b = slots[to]; if (!a || !b) return;
      clearTimeout(handoff); gen++;
      if (reduced()) { jump(L, b.l); jump(R, b.r); return; }
      const u = stretch / 100;
      tween(L, b.l + (Math.min(a.l, b.l) - b.l) * u, DILATE);
      tween(R, b.r + (Math.max(a.r, b.r) - b.r) * u, DILATE);
      handoff = setTimeout(() => land(to, null, false, true), HANDOFF * 1000);
    }
    // The app changes aria-checked (taps, keyboard, settings sync): follow it.
    new MutationObserver(() => {
      const i = current();
      buttons.forEach((b, k) => (b.tabIndex = k === i ? 0 : -1));
      if (i === committed) return;
      const from = committed; committed = i;
      if (pendingLand && pendingLand.to === i) { const p = pendingLand; pendingLand = null; reduced() ? (jump(L, slots[i].l), jump(R, slots[i].r)) : land(i, p.v, p.flick, p.flick); }
      else if (!track.offsetParent) { jump(L, slots[i]?.l ?? 0); jump(R, slots[i]?.r ?? 0); }
      else travel(from, i);
    }).observe(track, { subtree: true, attributes: true, attributeFilter: ['aria-checked'] });

    const localX = e => e.clientX - track.getBoundingClientRect().left - inset;
    track.addEventListener('click', e => { if (suppressClick) { suppressClick = false; e.stopPropagation(); e.preventDefault(); } }, true);
    buttons.forEach((btn, i) => {
      btn.addEventListener('pointerdown', e => {
        if (btn.disabled || drag || e.button !== 0) return;
        measure();
        const x = localX(e), onThumb = x >= L.x && x <= R.x;
        drag = { id: e.pointerId, x0: x, slot: i, onThumb, live: false, offset: 0, w: 0, hist: [[e.timeStamp, x]], el: btn };
        try { btn.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
        if (onThumb) { clearTimeout(handoff); gen++; stop(L); stop(R); }
        else if (!reduced()) btn.dataset.pressed = '';
      });
      btn.addEventListener('pointermove', e => {
        const d = drag; if (!d || d.id !== e.pointerId || !d.onThumb) return;
        const x = localX(e);
        d.hist.push([e.timeStamp, x]); if (d.hist.length > 8) d.hist.shift();
        if (!d.live) {
          if (Math.abs(x - d.x0) < DEADZONE) return;
          d.live = true; d.offset = x - L.x; d.w = R.x - L.x; track.dataset.held = '';
        }
        const l = x - d.offset, maxL = innerW - d.w;
        if (reduced()) { const c = clamp(l, 0, maxL); L.x = c; R.x = c + d.w; }
        else if (l < 0) { L.x = 0; R.x = d.w - rubber(-l, d.w); }
        else if (l > maxL) { R.x = innerW; L.x = maxL + rubber(l - maxL, d.w); }
        else { L.x = l; R.x = l + d.w; }
        paint();
      });
      const end = (e, cancelled) => {
        const d = drag; if (!d || d.id !== e.pointerId) return;
        drag = null; delete track.dataset.held; delete d.el.dataset.pressed;
        if (!d.live) return; // a plain tap: the native click selects, and the observer animates
        suppressClick = true; setTimeout(() => (suppressClick = false), 0);
        if (cancelled) { land(committed, null, false, false); return; }
        const recent = d.hist.filter(([t]) => e.timeStamp - t <= 100);
        let v = 0;
        if (recent.length >= 2) { const [t0, x0] = recent[0], [t1, x1] = recent[recent.length - 1]; if (t1 - t0 >= 8) v = ((x1 - x0) / (t1 - t0)) * 1000; }
        const flick = Math.abs(v) > FLICK, centre = (L.x + R.x) / 2 + project(v, glide);
        let to = 0;
        slots.forEach((s, k) => { if (Math.abs((s.l + s.r) / 2 - centre) < Math.abs((slots[to].l + slots[to].r) / 2 - centre)) to = k; });
        if (flick && to === committed) to = clamp(to + Math.sign(v), 0, buttons.length - 1);
        if (to === committed) { land(to, v, flick, flick); return; }
        pendingLand = { to, v, flick };
        setTimeout(() => buttons[to].click(), 0);
      };
      btn.addEventListener('pointerup', e => end(e, false));
      btn.addEventListener('pointercancel', e => end(e, true));
      btn.addEventListener('keydown', e => {
        const lastI = buttons.length - 1, now = current();
        let next = null;
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = Math.min(lastI, now + 1);
        else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = Math.max(0, now - 1);
        else if (e.key === 'Home') next = 0;
        else if (e.key === 'End') next = lastI;
        if (next === null) return;
        e.preventDefault();
        if (next !== now && !buttons[next].disabled) { buttons[next].click(); buttons[next].focus(); }
      });
    });
    new ResizeObserver(measure).observe(track);
    document.fonts?.ready.then(measure);
    measure();
    buttons.forEach((b, k) => (b.tabIndex = k === committed ? 0 : -1));
  }

  // ═════════════════ SquishSwitch ═════════════════
  function squishSwitch(label, { speed = 50, stretch = 36, hoverScale = 1.015 } = {}) {
    const input = label.querySelector('input[type=checkbox]'), track = label.querySelector('i');
    if (!input || !track) return;
    label.classList.add('squish');
    const thumb = document.createElement('span');
    thumb.className = 'squish-thumb';
    track.append(thumb);
    const geom = () => {
      const w = track.clientWidth, h = track.clientHeight, inset = Math.max(3, Math.round(h * 0.15)), size = h - inset * 2;
      return { min: inset, max: w - inset - size, size, inset };
    };
    let g = geom(), flow = 0, swell = 1, swellTarget = 1, lastT = 0;
    const gain = () => (reduced() ? 0 : clamp(stretch, 0, 100) / 100);
    const paint = () => {
      const now = performance.now(), dt = lastT ? Math.min(0.05, (now - lastT) / 1000) : 0.016; lastT = now;
      flow += (x.vel - flow) * (1 - Math.exp(-dt / 0.035));
      swell += (swellTarget - swell) * (1 - Math.exp(-dt / 0.06));
      const s = 1 + Math.min(0.4, Math.abs(flow) / 600) * gain();
      thumb.style.transform = `translateX(${x.x}px) scale(${s * swell}, ${swell / s})`;
      if (Math.abs(flow) > 1 || Math.abs(swell - swellTarget) > 0.001) kick(ticker); // keep easing the squash out after the thumb stops
    };
    const x = value(input.checked ? g.max : g.min, paint);
    const ticker = { x: 0, vel: 0, mode: 'idle', onUpdate: paint }; // re-paints while the stretch relaxes
    ticker.mode = null;
    const spr = { stiffness: 170 - (50 - clamp(speed, 0, 100)) * 1.1, damping: 21.5, mass: 0.9 };
    const settle = () => {
      label.toggleAttribute('data-on', input.checked);
      const target = input.checked ? g.max : g.min;
      if (reduced() || !label.offsetParent) jump(x, target); else physical(x, target, spr);
    };
    // Programmatic `input.checked = …` (settings sync) must move the thumb too.
    const proto = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked');
    Object.defineProperty(input, 'checked', {
      configurable: true,
      get() { return proto.get.call(this); },
      set(v) { const was = proto.get.call(this); proto.set.call(this, v); if (was !== !!v) settle(); },
    });
    input.addEventListener('change', settle);

    let grip = null, skipClick = false;
    label.addEventListener('click', e => { if (skipClick) { skipClick = false; e.preventDefault(); e.stopPropagation(); } }, true);
    track.addEventListener('pointerdown', e => {
      if (input.disabled || e.button !== 0) return;
      g = geom();
      const r = track.getBoundingClientRect();
      grip = { id: e.pointerId, grab: e.clientX - r.left - x.x, startX: e.clientX, moved: false, slop: e.pointerType === 'touch' ? 8 : 4, was: input.checked };
      try { track.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
      label.dataset.held = '';
    });
    track.addEventListener('pointermove', e => {
      if (!grip || grip.id !== e.pointerId) return;
      if (!grip.moved && Math.abs(e.clientX - grip.startX) > grip.slop) { grip.moved = true; stop(x); }
      if (!grip.moved) return;
      const r = track.getBoundingClientRect(), nx = clamp(e.clientX - r.left - grip.grab, g.min, g.max);
      const prev = x.x; x.x = nx; x.vel = (nx - prev) * 60; paint();
      const on = nx > (g.min + g.max) / 2;
      if (on !== input.checked) { proto.set.call(input, on); label.toggleAttribute('data-on', on); input.dispatchEvent(new Event('change', { bubbles: true })); }
    });
    const up = (e, cancelled) => {
      if (!grip || grip.id !== e.pointerId) return;
      const gr = grip; grip = null; delete label.dataset.held;
      if (gr.moved) {
        skipClick = true; setTimeout(() => (skipClick = false), 0);
        if (cancelled && input.checked !== gr.was) { proto.set.call(input, gr.was); input.dispatchEvent(new Event('change', { bubbles: true })); }
        settle();
      }
    };
    track.addEventListener('pointerup', e => up(e, false));
    track.addEventListener('pointercancel', e => up(e, true));
    track.addEventListener('pointerenter', e => { if (e.pointerType === 'mouse' && !input.disabled) { swellTarget = hoverScale; kick(ticker); } });
    track.addEventListener('pointerleave', () => { swellTarget = 1; kick(ticker); });
    new ResizeObserver(() => { g = geom(); jump(x, input.checked ? g.max : g.min); }).observe(track);
    label.toggleAttribute('data-on', input.checked);
    jump(x, input.checked ? g.max : g.min);
  }

  const init = () => {
    document.querySelectorAll('.seg.rubber, .mode.rubber').forEach(t => rubberSegment(t));
    document.querySelectorAll('label.switch').forEach(l => squishSwitch(l));
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
  window.ContourControls = { rubberSegment, squishSwitch };
})();
