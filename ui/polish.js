// Contour · the small things: command palette, scrubbable numbers, double-click resets, kind errors,
// headphone-unplug safety, taskbar progress, remembered choices, and the unsaved-changes dot.
'use strict';
(() => {
  const $p = id => document.getElementById(id);
  const tauriWin = () => window.__TAURI__?.window?.getCurrentWindow?.();

  // ── unsaved changes: a small white dot beside the song title ──
  const state = $p('session-state'), title = $p('now-name');
  const syncDot = () => {
    const dirty = !!state && /unsaved/i.test(state.textContent || '');
    title?.classList.toggle('unsaved', dirty);
    document.documentElement.toggleAttribute('data-unsaved', dirty); // the logo shows the dot when the title is hidden
    if (title) title.title = dirty ? 'Unsaved changes · Ctrl+S to save' : '';
  };
  if (state) new MutationObserver(syncDot).observe(state, { childList: true, characterData: true, subtree: true });
  syncDot();

  // ── errors that say what happened and what to do ──
  const KIND = [
    [/no space left|disk full|os error (28|112)|not enough space/i, 'Your disk is full. Free some space, or choose another folder.'],
    [/permission denied|access is denied|os error (5|13)\b/i, 'Contour isn\'t allowed to write there. Choose another folder (Documents or Music work well).'],
    [/no such file|cannot find the (file|path)|os error (2|3)\b|not found/i, 'That file has moved or no longer exists.'],
    [/dns|connection (refused|reset)|timed out|network|unreachable|failed to connect/i, 'Couldn\'t reach the internet. Check your connection; the download picks up where it stopped.'],
    [/out of memory|bad_alloc|memory allocation/i, 'Your computer ran out of memory. Close other apps, or use Fast quality.'],
    [/device (removed|lost|hung)|dxgi|887a0005|887a0006/i, 'The graphics card reset. Contour switched to the processor; this job continues there.'],
    [/unsupported or damaged|unsupported format|could not decode/i, 'Contour can\'t read that file. Try MP3, WAV, FLAC, M4A or OGG.'],
  ];
  const kind = msg => { const s = String(msg ?? ''); const k = KIND.find(([re]) => re.test(s)); return k ? k[1] : s; };
  if (typeof window.toast === 'function') { const raw = window.toast; window.toast = text => raw(kind(text)); }

  // ── double-click any slider to reset it; drag a slider's number sideways to change it ──
  const fire = el => { el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); };
  document.addEventListener('dblclick', e => {
    const r = e.target.closest?.('input[type=range]');
    if (!r || r.ondblclick) return; // sliders with their own reset keep it
    r.value = r.defaultValue; fire(r);
  });
  const linked = out => (out.htmlFor && out.htmlFor.length ? $p(out.htmlFor[0]) : out.previousElementSibling?.matches?.('input[type=range]') ? out.previousElementSibling : null);
  document.addEventListener('pointerdown', e => {
    const out = e.target.closest?.('output');
    const r = out && linked(out);
    if (!r || e.button !== 0) return;
    e.preventDefault();
    const x0 = e.clientX, v0 = +r.value, min = +r.min, max = +r.max, step = +r.step || 1;
    out.classList.add('scrubbing');
    const move = ev => {
      const per = (max - min) / (ev.altKey ? 2000 : 240); // Alt: fine
      const v = Math.round((v0 + (ev.clientX - x0) * per) / step) * step;
      const nv = Math.min(max, Math.max(min, v));
      if (+r.value !== nv) { r.value = nv; r.dispatchEvent(new Event('input', { bubbles: true })); }
    };
    const up = () => { out.classList.remove('scrubbing'); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); r.dispatchEvent(new Event('change', { bubbles: true })); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  });
  document.addEventListener('dblclick', e => { const out = e.target.closest?.('output'), r = out && linked(out); if (r) { r.value = r.defaultValue; fire(r); } });
  const markScrubbable = () => document.querySelectorAll('output').forEach(o => { if (linked(o)) { o.classList.add('scrub'); o.title = o.title || 'Drag sideways to change · double-click to reset'; } });
  markScrubbable();

  // ── unplugging headphones pauses, instead of carrying on through the speakers ──
  let outputs = null;
  const countOutputs = async () => (await navigator.mediaDevices?.enumerateDevices?.() || []).filter(d => d.kind === 'audiooutput').length;
  countOutputs().then(n => (outputs = n)).catch(() => {});
  navigator.mediaDevices?.addEventListener?.('devicechange', async () => {
    const n = await countOutputs().catch(() => outputs);
    if (outputs != null && n < outputs && typeof S !== 'undefined' && S.playing) {
      if (typeof togglePlay === 'function') togglePlay();
      window.toast?.('Paused: an audio device was disconnected.');
    }
    outputs = n;
  });

  // ── taskbar progress, and a flash when a long job finishes while you're elsewhere ──
  let jobStart = 0;
  if (typeof window.setProgress === 'function') {
    const raw = window.setProgress;
    window.setProgress = (f, ...rest) => {
      raw(f, ...rest);
      if (!jobStart) jobStart = performance.now();
      tauriWin()?.setProgressBar?.({ status: 'normal', progress: Math.round(Math.max(0, Math.min(1, +f || 0)) * 100) }).catch?.(() => {});
    };
  }
  if (typeof window.busyEnd === 'function') {
    const raw = window.busyEnd;
    window.busyEnd = (...a) => {
      raw(...a);
      const w = tauriWin();
      w?.setProgressBar?.({ status: 'none' }).catch?.(() => {});
      if (jobStart && performance.now() - jobStart > 8000 && (document.hidden || !document.hasFocus())) w?.requestUserAttention?.(2).catch?.(() => {}); // 2 = informational
      jobStart = 0;
    };
  }

  // ── every choice remembered ──
  const KEY = 'contour.choices.v1';
  const load = () => { try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { return {}; } };
  const saved = load();
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(saved)); } catch { /* storage unavailable */ } };
  const remembered = ['sing-guide', 'sing-sync', 'sing-lang', 'sing-mic', 'tune-strength', 'tune-speed', 'tune-vibrato', 'lt-strength', 'lt-shimmer', 'mash-split'];
  for (const id of remembered) {
    const el = $p(id);
    if (!el) continue;
    if (id in saved) {
      if (el.type === 'checkbox') el.checked = !!saved[id]; else el.value = saved[id];
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
    el.addEventListener('change', () => { saved[id] = el.type === 'checkbox' ? el.checked : el.value; save(); });
    if (el.type === 'range') el.addEventListener('input', () => { saved[id] = el.value; save(); });
  }
  if (typeof S !== 'undefined' && typeof saved.xfade === 'number') S.xfade = saved.xfade;
  if (typeof window.setXfade === 'function') { const raw = window.setXfade; window.setXfade = ms => { raw(ms); saved.xfade = ms; save(); }; }
  document.addEventListener('contour:mode', e => { saved.mode = e.detail; save(); });
  if (saved.mode && saved.mode !== 'simple' && typeof setMode === 'function') setTimeout(() => { if (!$p('setup') || $p('setup').hidden) setMode(saved.mode); }, 400);

  // ── command palette (Ctrl+K) ──
  const click = id => () => $p(id)?.click();
  const studio = fn => () => { if (S.mode !== 'studio') setMode('studio'); setTimeout(fn, 60); };
  const C = [
    ['Go to Simple', '', () => setMode('simple')],
    ['Go to Studio', '', () => setMode('studio')],
    ['Go to Mashup', '', () => setMode('mashup')],
    ['Go to Sing', '', () => setMode('karaoke')],
    ['Play / pause', 'Space', () => togglePlay?.()],
    ['Import song…', 'Ctrl+I', click('choose')],
    ['Open project…', 'Ctrl+O', () => openProject?.()],
    ['Save project', 'Ctrl+S', () => (typeof saveProject === 'function' ? saveProject() : $p('save-project')?.click())],
    ['Export stems', '', () => ($p(S.mode === 'studio' ? 'export' : 'simple-save') || $p('export'))?.click()],
    ['Export mix', '', studio(() => $p('bounce')?.click())],
    ['Separate', '', studio(() => $p('studio-run')?.click())],
    ['Undo', 'Ctrl+Z', () => ContourProduct.undo?.(-1)],
    ['Redo', 'Ctrl+Shift+Z', () => ContourProduct.undo?.(1)],
    ['Loop on / off', 'L', studio(() => $p('loop')?.click())],
    ['Snap on / off', 'G', studio(() => $p('snap')?.click())],
    ['Curves on / off', 'A', studio(() => $p('curves')?.click())],
    ['Null test', 'N', studio(() => $p('null')?.click())],
    ['Split at playhead', 'S', studio(() => splitAt?.(editableTracks?.() || [], currentPos()))],
    ['Select all clips', 'Ctrl+A', studio(() => { for (const t of S.tracks) if (clipEditable?.(t)) for (const c of clipsOf(t)) S.clipSel.add(c.id); drawStudio(); })],
    ['Crossfades: off', '', () => setXfade?.(0)],
    ['Crossfades: short (10 ms)', '', () => setXfade?.(10)],
    ['Crossfades: smooth (30 ms)', '', () => setXfade?.(30)],
    ['Crossfades: long (120 ms)', '', () => setXfade?.(120)],
    ['Add audio lane…', '', studio(() => addLane?.())],
    ['Zoom in', 'Ctrl+=', studio(() => $p('zoom-in')?.click())],
    ['Zoom out', 'Ctrl+−', studio(() => $p('zoom-out')?.click())],
    ['Make a mashup', '', () => { setMode('mashup'); setTimeout(() => $p('mash-run')?.click(), 80); }],
    ['Get lyrics', '', () => { setMode('karaoke'); setTimeout(() => getLyrics?.(), 80); }],
    ['Start singing', '', () => { setMode('karaoke'); setTimeout(() => $p('sing-start')?.click(), 80); }],
    ['Import a take…', '', () => { setMode('karaoke'); setTimeout(() => importTake?.(), 80); }],
    ['Tune your take', '', () => showTakeOnly?.()],
    ['Settings', '', click('open-models')],
    ['Keyboard shortcuts', '?', () => document.dispatchEvent(new KeyboardEvent('keydown', { key: '?' }))],
  ].map(([name, keys, run], i) => ({ id: i, name, keys, run }));
  const RECENT = 'contour.palette.recent';
  const recent = () => { try { return JSON.parse(localStorage.getItem(RECENT) || '[]'); } catch { return []; } };
  const score = (q, s) => {
    // subsequence match; consecutive letters and word starts score higher
    q = q.toLowerCase(); s = s.toLowerCase();
    let i = 0, sc = 0, run = 0;
    for (let j = 0; j < s.length && i < q.length; j++) {
      if (s[j] === q[i]) { run++; sc += 1 + run * 2 + (j === 0 || s[j - 1] === ' ' ? 4 : 0); i++; } else run = 0;
    }
    return i === q.length ? sc - s.length * 0.05 : -1;
  };
  const pal = $p('palette'), input = $p('palette-input'), list = $p('palette-list');
  let shown = [], sel = 0;
  const render = () => {
    const q = input.value.trim();
    if (!q) { const r = recent(); shown = [...r.map(name => C.find(c => c.name === name)).filter(Boolean), ...C.filter(c => !r.includes(c.name))]; }
    else shown = C.map(c => [c, score(q, c.name)]).filter(x => x[1] >= 0).sort((a, b) => b[1] - a[1]).map(x => x[0]);
    sel = Math.min(sel, Math.max(0, shown.length - 1));
    list.innerHTML = shown.length
      ? shown.map((c, i) => `<li role="option" aria-selected="${i === sel}" data-i="${i}"><span>${c.name}</span>${c.keys ? `<kbd>${c.keys}</kbd>` : ''}</li>`).join('')
      : '<li class="empty">No matching command</li>';
    list.querySelector('[aria-selected=true]')?.scrollIntoView({ block: 'nearest' });
  };
  const open = () => { pal.hidden = false; input.value = ''; sel = 0; render(); requestAnimationFrame(() => { pal.classList.add('open'); input.focus(); }); };
  const close = () => { pal.classList.remove('open'); setTimeout(() => (pal.hidden = true), 140); };
  const run = c => {
    if (!c) return;
    close();
    try { localStorage.setItem(RECENT, JSON.stringify([c.name, ...recent().filter(n => n !== c.name)].slice(0, 5))); } catch { /* fine */ }
    setTimeout(() => { try { c.run(); } catch (err) { window.toast?.(String(err)); } }, 30);
  };
  input.addEventListener('input', () => { sel = 0; render(); });
  input.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'ArrowDown') { sel = Math.min(shown.length - 1, sel + 1); render(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { sel = Math.max(0, sel - 1); render(); e.preventDefault(); }
    else if (e.key === 'Enter') run(shown[sel]);
    else if (e.key === 'Escape') close();
  });
  list.addEventListener('click', e => { const li = e.target.closest('li[data-i]'); if (li) run(shown[+li.dataset.i]); });
  pal.addEventListener('mousedown', e => { if (e.target === pal) close(); });
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'k') { e.preventDefault(); e.stopPropagation(); pal.hidden ? open() : close(); }
  }, true);
  // ── panels that appear (Sing's screens, Tune, the lyrics editor) arrive with a short fade-and-rise ──
  // Interruptible, never blocks clicks, skipped when reduced motion is preferred.
  const enter = el => {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches || !el.isConnected) return;
    el._enter?.cancel();
    el._enter = el.animate([{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: 220, easing: 'cubic-bezier(.2,.9,.3,1)' });
  };
  const panels = ['sing-setup', 'sing-stage', 'sing-results', 'tune', 'lyrics-editor'].map($p).filter(Boolean);
  const seen = new WeakMap(panels.map(el => [el, el.hidden]));
  new MutationObserver(list => {
    for (const m of list) {
      const el = m.target;
      if (seen.get(el) && !el.hidden) enter(el);
      seen.set(el, el.hidden);
    }
  }).observe(document.body, { attributes: true, attributeFilter: ['hidden'], subtree: true });
  // ── the song title sits exactly in the window's centre ──
  // Both side columns take the width of the wider side (the tabs and window buttons), so the middle
  // column is centred on the window. When that would leave the title less than 220 px, the header
  // falls back to logo | title | tabs, where the title fills the gap: centred or not, it never overlaps.
  const bar = document.querySelector('header.bar'), brandEl = bar?.querySelector('.brand'), rightEl = bar?.querySelector('.bar-right');
  const centreTitle = () => {
    if (!bar || !brandEl || !rightEl) return;
    const side = Math.ceil(Math.max(brandEl.scrollWidth, rightEl.scrollWidth));
    const cs = getComputedStyle(bar), gap = parseFloat(cs.columnGap) || 0;
    const inner = bar.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const room = inner - 2 * side - 2 * gap;
    // what the title needs: its full width, but a long one is happy truncating to 220 px
    const nowEl = bar.querySelector('.now');
    const natural = nowEl ? Math.max(...[...nowEl.children].map(c => c.scrollWidth)) : 0;
    const need = Math.min(220, natural + 4);
    bar.style.setProperty('grid-template-columns', room >= need ? `${side}px minmax(0,1fr) ${side}px` : 'auto minmax(0,1fr) auto', 'important');
  };
  if (bar) { const nowEl0 = bar.querySelector('.now'); if (nowEl0) new MutationObserver(centreTitle).observe(nowEl0, { childList: true, characterData: true, subtree: true }); new ResizeObserver(centreTitle).observe(bar); new ResizeObserver(centreTitle).observe(rightEl); new ResizeObserver(centreTitle).observe(brandEl); centreTitle(); }
  window.ContourPalette = { open, close, commands: C, kind };
})();
