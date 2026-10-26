// Contour · the Sound drawer (per stem: presets, Level, Space, Warmth, Clarity, Punch, Width, Level out)
// and recording in Studio. Everything is heard live through ui/fx-worklet.js, which mirrors the engine's
// renderer, so exports sound exactly like the preview.
'use strict';
(() => {
  const NEUTRAL = { warmth: 0, clarity: 0, punch: 0, width: 0.5, space: 0 };
  const PRESETS = {
    vocal: { Clean: { warmth: 0.15, clarity: 0.35, punch: 0.3, width: 0.5, space: 0.12 }, Radio: { warmth: 0.1, clarity: 0.6, punch: 0.65, width: 0.4, space: 0.06 },
      Dreamy: { warmth: 0.25, clarity: 0.3, punch: 0.2, width: 0.7, space: 0.55 }, 'Lo-fi': { warmth: 0.5, clarity: -0.6, punch: 0.5, width: 0.3, space: 0.15 },
      Stadium: { warmth: 0.2, clarity: 0.45, punch: 0.55, width: 0.6, space: 0.4 } },
    drums: { Tight: { warmth: 0.1, clarity: 0.3, punch: 0.7, width: 0.5, space: 0.03 }, 'Big room': { warmth: 0.3, clarity: 0.2, punch: 0.5, width: 0.7, space: 0.4 },
      Vintage: { warmth: 0.45, clarity: -0.4, punch: 0.4, width: 0.4, space: 0.1 } },
    bass: { Warm: { warmth: 0.5, clarity: -0.2, punch: 0.3, width: 0.35, space: 0 }, Deep: { warmth: 0.8, clarity: -0.3, punch: 0.4, width: 0.3, space: 0 },
      Gritty: { warmth: 0.3, clarity: 0.5, punch: 0.8, width: 0.4, space: 0 } },
    music: { Open: { warmth: 0.1, clarity: 0.3, punch: 0.15, width: 0.65, space: 0.1 }, Soft: { warmth: 0.25, clarity: -0.35, punch: 0.1, width: 0.5, space: 0.15 },
      Wide: { warmth: 0.1, clarity: 0.15, punch: 0.1, width: 0.9, space: 0.12 } },
  };
  const kindOf = t => (isVocal?.(t) || /^take|^rec_/.test(t.id) ? 'vocal' : t.id === 'drums' ? 'drums' : t.id === 'bass' ? 'bass' : 'music');
  const sendOf = space => Math.pow(Math.max(0, Math.min(1, space)), 1.5);
  const dB = v => (v <= 0.0005 ? -Infinity : 20 * Math.log10(v));

  /** Apply Sound settings to a stem: heard at once. `commit` records an undo step. */
  function setFx(t, patch, commit = true) {
    Object.assign(t.fx, patch);
    t.fxNode?.port.postMessage(t.fx);
    if (t.send && S.ctx) t.send.gain.setTargetAtTime(sendOf(t.fx.space), S.ctx.currentTime, 0.02);
    if (commit) ContourProduct.changed();
  }
  const same = (a, b) => ['warmth', 'clarity', 'punch', 'width', 'space'].every(k => Math.abs((a[k] ?? NEUTRAL[k]) - (b[k] ?? NEUTRAL[k])) < 1e-3);

  function drawer(t) {
    const el = document.createElement('div');
    el.className = 'fx-drawer';
    el.id = `fx-${t.id}`;
    el.setAttribute('role', 'region');
    el.setAttribute('aria-label', `${t.label} sound`);
    el.style.setProperty('--c', t.color);
    const presets = PRESETS[kindOf(t)];
    const row = (key, label, min, max, val, fmt, hint) => `<label class="fx-row" title="${hint}"><span>${label}</span><input type="range" data-k="${key}" min="${min}" max="${max}" value="${val}" step="1"><output>${fmt}</output></label>`;
    const lvl = Math.max(-24, Math.min(12, dB(t.vol)));
    el.innerHTML = `
      <div class="fx-presets">${Object.keys(presets).map(n => `<button type="button" class="chip${same(t.fx, presets[n]) ? ' on' : ''}" data-p="${n}">${n}</button>`).join('')}</div>
      <div class="fx-grid">
        <div class="fx-level">${row('level', 'Level', -24, 12, Math.round(lvl * 2) / 2, fmtDb(lvl), 'Volume of this stem, up to +12 dB')}<div class="fx-meter" aria-hidden="true"><i></i><b></b></div></div>
        ${row('space', 'Space', 0, 100, Math.round(t.fx.space * 100), pct(t.fx.space), 'Reverb: how much room around the sound')}
        ${row('warmth', 'Warmth', 0, 100, Math.round(t.fx.warmth * 100), pct(t.fx.warmth), 'Body in the low end')}
        ${row('clarity', 'Clarity', -100, 100, Math.round(t.fx.clarity * 100), signed(t.fx.clarity), 'Brighter to the right, softer to the left')}
        ${row('punch', 'Punch', 0, 100, Math.round(t.fx.punch * 100), pct(t.fx.punch), 'Evens out and tightens the hits')}
        ${row('width', 'Width', 0, 100, Math.round(t.fx.width * 100), width(t.fx.width), '50 = as recorded; left narrows, right widens')}
      </div>
      <div class="fx-actions">
        <button type="button" class="ghost fx-level-out" title="Even out loud and quiet parts so the whole stem sits at one volume">Level out</button>
        <button type="button" class="ghost fx-sync" ${syncable(t) ? 'title="Pull this lane\'s hits onto the song\'s beat"' : 'disabled title="Separated stems are already in time with the song"'}>Sync to beat</button>
        ${t.modified ? '<button type="button" class="ghost fx-restore" title="Undo Level out and Sync to beat">Restore original</button>' : ''}
        <button type="button" class="ghost fx-reset" title="Every knob back to neutral">Reset</button>
      </div>`;
    const sliders = el.querySelectorAll('input[type=range]');
    sliders.forEach(s => {
      // the double-click reset target; setting it would also move an untouched slider, so restore the value
      const v = s.value;
      s.defaultValue = s.dataset.k === 'level' ? 0 : s.dataset.k === 'width' ? 50 : 0;
      s.value = v;
      s.addEventListener('input', () => {
        const v = +s.value, out = s.nextElementSibling;
        if (s.dataset.k === 'level') {
          t.vol = v <= -24 ? 0 : Math.pow(10, v / 20);
          out.textContent = fmtDb(v <= -24 ? -Infinity : v);
          applyMix?.();
          const lane = t.lane?.querySelector('.vol'); if (lane) lane.value = Math.round(t.vol * 100);
        } else {
          const val = s.dataset.k === 'clarity' ? v / 100 : v / 100;
          setFx(t, { [s.dataset.k]: val }, false);
          out.textContent = s.dataset.k === 'clarity' ? signed(val) : s.dataset.k === 'width' ? width(val) : pct(val);
        }
        markPresets();
      });
      s.addEventListener('change', () => ContourProduct.changed());
    });
    const markPresets = () => el.querySelectorAll('.chip').forEach(c => c.classList.toggle('on', same(t.fx, presets[c.dataset.p])));
    const sync = () => sliders.forEach(s => {
      if (s.dataset.k === 'level') return;
      const v = t.fx[s.dataset.k];
      s.value = Math.round(v * 100);
      s.nextElementSibling.textContent = s.dataset.k === 'clarity' ? signed(v) : s.dataset.k === 'width' ? width(v) : pct(v);
    });
    // presets: hover to hear, click to keep
    let before = null;
    el.querySelectorAll('.chip').forEach(c => {
      c.addEventListener('mouseenter', () => { before = { ...t.fx }; setFx(t, presets[c.dataset.p], false); sync(); });
      c.addEventListener('mouseleave', () => { if (before) { setFx(t, before, false); sync(); before = null; markPresets(); } });
      c.addEventListener('click', () => { before = null; setFx(t, { ...presets[c.dataset.p] }); sync(); markPresets(); status?.(`${t.label}: ${c.dataset.p}`); });
    });
    // a hover preview must never outlive the drawer (closing, or a redraw, restores your real settings)
    el._restore = () => { if (before) { setFx(t, before, false); before = null; } };
    el.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); el._toggle?.(); } });
    el.querySelector('.fx-reset').onclick = () => { setFx(t, { ...NEUTRAL }); sync(); markPresets(); };
    el.querySelector('.fx-level-out').onclick = e => audioAction(t, e.currentTarget, 'level');
    el.querySelector('.fx-sync').onclick = e => audioAction(t, e.currentTarget, 'sync');
    el.querySelector('.fx-restore')?.addEventListener('click', e => audioAction(t, e.currentTarget, 'restore'));
    // a live meter for the stem, with the sweet spot shaded
    const bar = el.querySelector('.fx-meter i'), peak = el.querySelector('.fx-meter b');
    let hold = 0;
    const tick = () => {
      if (!el.isConnected) return;
      const lvl = t.level || 0, d = lvl > 0 ? 20 * Math.log10(lvl) : -60, x = Math.max(0, Math.min(1, (d + 48) / 48));
      bar.style.transform = `scaleX(${x.toFixed(3)})`;
      bar.classList.toggle('hot', d > -3);
      hold = Math.max(x, hold - 0.006);
      peak.style.transform = `translateX(${(hold * 100).toFixed(1)}%)`;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    return el;
  }
  const pct = v => `${Math.round(v * 100)}%`;
  const signed = v => (Math.abs(v) < 0.005 ? '0' : `${v > 0 ? '+' : '−'}${Math.round(Math.abs(v) * 100)}`);
  const width = v => (Math.abs(v - 0.5) < 0.005 ? 'as is' : `${Math.round(v * 200)}%`);
  const fmtDb = v => (v === -Infinity ? '−∞' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(1)} dB`);

  /** Recordings, added audio and takes can be synced; separated stems are already in time. */
  const syncable = t => /^(rec_|lane_|take)/.test(t.id);
  /** Level out, Sync to beat, Restore original: rendered by the engine, so preview, waveform and export agree. */
  async function audioAction(t, btn, kind) {
    if (S.busy || btn.disabled) return;
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = { level: 'Levelling…', sync: 'Syncing…', restore: 'Restoring…' }[kind];
    try {
      const res = await invoke(kind === 'level' ? 'level_stem' : kind === 'sync' ? 'sync_stem' : 'restore_stem', { id: t.id });
      const info = res.stem || res;
      if (kind === 'sync' && !res.moved) { status?.(`${t.label} is already on the beat`); return; }
      const buf = await fetchBuffer(t, () => true);
      if (buf) { t.buffer = buf; t.peaks = info.peaks; t.hires = null; scheduleAnalysis?.(t); }
      t.modified = kind !== 'restore';
      S.mode === 'studio' ? renderStudio() : renderSimple();
      renderAll?.(); if (S.playing) restart();
      ContourProduct.audioChanged?.();
      status?.(kind === 'level' ? `${t.label} levelled out` : kind === 'sync' ? `${t.label}: ${res.moved} hit${res.moved === 1 ? '' : 's'} moved onto the beat` : `${t.label} restored`);
    } catch (e) { toast(String(e)); } finally { if (btn.isConnected) { btn.disabled = false; btn.textContent = label; } }
  }
  const levelOut = (t, btn) => audioAction(t, btn, 'level');

  // ── opening and closing: in place (nothing else redraws), interruptible, latest intent wins ──
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  function slide(el, open, done) {
    const now = el.getBoundingClientRect().height; // where it is right now, even mid-animation
    const running = !!el._anim;
    el._anim?.cancel();
    el._anim = null;
    if (reduced()) { el.style.height = ''; el.style.overflow = ''; if (!open) done?.(); return; }
    el.style.height = '';
    const full = el.getBoundingClientRect().height;
    const cs = getComputedStyle(el), pt = parseFloat(cs.paddingTop), pb = parseFloat(cs.paddingBottom), bw = parseFloat(cs.borderBottomWidth);
    const from = running ? now : open ? 0 : full, to = open ? full : 0;
    // padding and border shrink with the height, so the drawer truly reaches zero
    const frame = (h, o) => { const k = full > 0 ? Math.min(1, h / full) : 0; return { height: `${h}px`, paddingTop: `${pt * k}px`, paddingBottom: `${pb * k}px`, borderBottomWidth: `${bw * k}px`, opacity: o }; };
    const ms = Math.round(160 + 120 * Math.min(1, Math.abs(to - from) / 260)); // shorter trips take less time
    el.style.overflow = 'hidden';
    const a = el.animate([frame(from, running ? 1 : open ? 0 : 1), frame(to, open ? 1 : 0)],
      { duration: ms, easing: open ? 'cubic-bezier(.2,.9,.25,1)' : 'cubic-bezier(.4,0,.6,1)', fill: 'forwards' });
    el._anim = a;
    a.onfinish = () => {
      if (el._anim !== a) return;
      el._anim = null;
      a.cancel(); // drop the fill: the drawer goes back to its natural height
      el.style.overflow = '';
      if (open) el.scrollIntoView({ block: 'nearest', behavior: reduced() ? 'auto' : 'smooth' });
      else done?.();
    };
  }
  function toggleDrawer(t, host, btn) {
    t.fxOpen = !t.fxOpen;
    btn.setAttribute('aria-expanded', String(t.fxOpen));
    let el = host.nextElementSibling?.classList?.contains('fx-drawer') ? host.nextElementSibling : null;
    if (t.fxOpen) {
      if (!el) { el = drawer(t); el._toggle = () => toggleDrawer(t, host, btn); host.after(el); }
      el.inert = false;
      slide(el, true);
    } else if (el) {
      el._restore?.();
      el.inert = true; // no focus or clicks inside a closing drawer
      if (el.contains(document.activeElement)) btn.focus();
      slide(el, false, () => { if (!t.fxOpen) el.remove(); });
    }
  }

  // ── drawers in Studio lanes and Simple rows ──
  const fxButton = t => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'fx-btn'; b.setAttribute('aria-expanded', String(!!t.fxOpen));
    b.title = 'Sound: level, space, warmth, clarity, punch, width'; b.setAttribute('aria-label', `${t.label} sound`);
    b.innerHTML = '<svg viewBox="0 0 12 12" width="10" height="10"><path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    b.setAttribute('aria-controls', `fx-${t.id}`);
    b.addEventListener('pointerdown', e => e.stopPropagation()); // never starts a lane drag
    b.onclick = e => { e.stopPropagation(); toggleDrawer(t, b.closest('.lane, .result'), b); };
    return b;
  };
  if (typeof window.renderStudio === 'function') {
    const raw = window.renderStudio;
    window.renderStudio = (...a) => {
      document.querySelectorAll('.lanes .fx-drawer').forEach(d => d._restore?.());
      raw(...a);
      for (const t of S.tracks) {
        if (!t.lane || !t.leaf) continue;
        const b = fxButton(t);
        t.lane.querySelector('.lane-btns')?.append(b);
        if (t.fxOpen) { const d = drawer(t); d._toggle = () => toggleDrawer(t, t.lane, b); t.lane.after(d); }
      }
    };
  }
  if (typeof window.renderSimple === 'function') {
    const raw = window.renderSimple;
    window.renderSimple = (...a) => {
      document.querySelectorAll('#result-list .fx-drawer').forEach(d => d._restore?.());
      raw(...a);
      for (const t of leaves()) {
        if (!t.row) continue;
        const b = fxButton(t); b.classList.add('in-row');
        t.row.querySelector('.listen')?.before(b);
        if (t.fxOpen) { const d = drawer(t); d._toggle = () => toggleDrawer(t, t.row, b); t.row.after(d); }
      }
    };
  }

  // ── recording in Studio ──
  const REC = { on: false };
  async function startRecording() {
    if (!S.source || REC.on || S.busy) return;
    const ctx = audioContext();
    try {
      const saved = (() => { try { return JSON.parse(localStorage.getItem('contour.choices.v1') || '{}')['sing-mic']; } catch { return null; } })();
      REC.stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: saved ? { ideal: saved } : undefined, echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    } catch { toast('Contour needs microphone access to record.'); return; }
    REC.src = ctx.createMediaStreamSource(REC.stream);
    REC.sink = ctx.createGain(); REC.sink.gain.value = 0;
    REC.chunks = []; REC.frame0 = null; REC.rate = ctx.sampleRate;
    const keep = (frame, data) => {
      if (!REC.on) return;
      if (REC.frame0 == null) { if (!S.playing) return; REC.frame0 = frame; REC.song0 = S.offset + (frame / REC.rate - S.started); }
      REC.chunks.push({ frame, data });
    };
    try {
      if (!REC.worklet) { await ctx.audioWorklet.addModule('recorder-worklet.js'); REC.worklet = true; }
      REC.node = new AudioWorkletNode(ctx, 'contour-recorder', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: 'explicit' });
      REC.node.port.onmessage = e => keep(e.data.frame, e.data.data);
    } catch {
      REC.node = ctx.createScriptProcessor(4096, 1, 1);
      REC.node.onaudioprocess = e => keep(Math.round((e.playbackTime - e.inputBuffer.duration) * REC.rate), new Float32Array(e.inputBuffer.getChannelData(0)));
    }
    REC.src.connect(REC.node).connect(REC.sink).connect(ctx.destination);
    REC.on = true;
    $('rec').setAttribute('aria-pressed', 'true'); $('rec').classList.add('live');
    status?.('Recording… press R or Space to stop');
    if (!S.playing) play();
  }
  async function stopRecording() {
    if (!REC.on) return;
    try { REC.node.port?.postMessage('stop'); } catch { /* script processor */ }
    await new Promise(r => setTimeout(r, 60));
    REC.on = false;
    try { REC.src.disconnect(); REC.node.disconnect(); REC.sink.disconnect(); } catch { /* gone */ }
    REC.stream.getTracks().forEach(x => x.stop());
    $('rec').setAttribute('aria-pressed', 'false'); $('rec').classList.remove('live');
    if (!REC.chunks.length) { status?.('Nothing was recorded'); return; }
    const last = REC.chunks[REC.chunks.length - 1], total = last.frame + last.data.length - REC.frame0, take = new Float32Array(total);
    for (const c of REC.chunks) { const at = c.frame - REC.frame0; if (at >= 0 && at + c.data.length <= total) take.set(c.data, at); }
    const ctx = S.ctx, inLat = REC.stream.getAudioTracks()[0]?.getSettings?.().latency || 0;
    const latency = (ctx.outputLatency || 0) + (ctx.baseLatency || 0) + inLat;
    const offset = Math.round((REC.song0 - latency) * SR);
    try {
      const info = await invoke('add_recording', new Uint8Array(take.buffer), { headers: { 'x-offset': String(offset), 'x-rate': String(REC.rate) } });
      const t = makeTrack(info); t.mute = false;
      S.tracks.push(t);
      renderStudio(); renderExportList?.();
      await loadTrack(t);
      ContourProduct.audioChanged?.();
      status?.(`${info.label} added`);
    } catch (e) { toast(String(e)); }
  }
  const toggleRecording = () => (REC.on ? stopRecording() : startRecording());
  $('rec')?.addEventListener('click', toggleRecording);
  document.addEventListener('keydown', e => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.target.closest?.('input:not([type=range]),select,textarea,[contenteditable]')) return;
    if (S.mode !== 'studio') return;
    if (e.key.toLowerCase() === 'r') { e.preventDefault(); toggleRecording(); }
    else if (e.key === ' ' && REC.on) { e.preventDefault(); e.stopImmediatePropagation(); stopRecording().then(() => S.playing && togglePlay()); }
  }, true);

  // Escape closes the drawer you're pointing at or working in (focus need not be inside it)
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || e.defaultPrevented) return;
    const open = [...document.querySelectorAll('.fx-drawer:not([inert])')];
    const d = open.find(x => x.contains(document.activeElement)) || open.find(x => x.matches(':hover'));
    if (d?._toggle) { e.preventDefault(); d._toggle(); }
  });
  window.ContourSound = { setFx, PRESETS, kindOf, levelOut, audioAction, toggleRecording, REC };
})();
