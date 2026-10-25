// Contour · Studio clips: non-destructive, DAW-style editing on the stem lanes.
//
// Every lane holds clips that point into the stem's original audio:
//   { id, pos (timeline start, s), src0 / src1 (source range, s), gain (linear), fin / fout (fades, s) }
// Cutting, moving, trimming and fading only change these numbers, so every edit is reversible
// (they live in the undo history and in projects), playback schedules each clip sample-accurately,
// and exports render the same clips in the engine.
'use strict';

const CLIP_MIN = 0.03; // shortest clip, seconds
let clipSeq = 0;
const newClipId = () => `c${++clipSeq}${Math.random().toString(36).slice(2, 6)}`;
Object.assign(S, { tool: 'select', snap: true, clipSel: new Set(), clipboard: null, clipDrag: null, clipHover: null, box: null, xfade: 30 });
const XFADES = [['Off', 0], ['Short', 10], ['Smooth', 30], ['Long', 120]]; // crossfade lengths, ms

// ───────────────────────── model ─────────────────────────
const clipEditable = t => !!t && (t.leaf || t.id === 'original');
const clipLen = c => c.src1 - c.src0;
const clipEnd = c => c.pos + clipLen(c);
function clipsOf(t) {
  if (!t.clips) t.clips = [{ id: newClipId(), pos: 0, src0: 0, src1: duration(), gain: 1, fin: 0, fout: 0 }];
  return t.clips;
}
/** True once a lane differs from "the whole stem, untouched". */
function clipsEdited(t) {
  const cs = t.clips;
  if (!cs) return false;
  if (cs.length !== 1) return true;
  const c = cs[0];
  return !(Math.abs(c.pos) < 1e-6 && Math.abs(c.src0) < 1e-6 && Math.abs(c.src1 - duration()) < 1e-4 && c.gain === 1 && !c.fin && !c.fout);
}
/** Gain multiplier (clip gain × fades) at timeline time T. */
function clipFade(c, T) {
  const L = clipLen(c), k = T - c.pos;
  let g = c.gain;
  if (c.fin > 0 && k < c.fin) g *= Math.max(0, k / c.fin);
  if (c.fout > 0 && L - k < c.fout) g *= Math.max(0, (L - k) / c.fout);
  return g;
}
const clipAt = (t, T) => (clipEditable(t) ? clipsOf(t) : (t.clips || [])).find(c => T >= c.pos && T < clipEnd(c)) || null;
const sortClips = t => t.clips?.sort((a, b) => a.pos - b.pos);
function findClip(id) {
  for (const t of S.tracks) for (const c of t.clips || []) if (c.id === id) return { t, c };
  return null;
}
const selectedClips = () => [...S.clipSel].map(findClip).filter(Boolean);
const editableTracks = () => S.tracks.filter(clipEditable);

/**
 * The clips as they actually play: wherever two clips meet on a lane (and the audio isn't simply
 * continuous, as after a plain split), each reaches half a crossfade into the other, borrowing real
 * audio from beyond its edge, and fades over the overlap. The crossfade shrinks when there isn't enough
 * audio to borrow. Playback and every export use exactly this, so they always sound the same.
 */
function effectiveClips(t) {
  const cs = clipsOf(t).map(c => ({ ...c })).sort((a, b) => a.pos - b.pos);
  const want = S.xfade / 1000 / 2;
  if (want <= 0) return cs;
  for (let i = 0; i + 1 < cs.length; i++) {
    const a = cs[i], b = cs[i + 1];
    if (Math.abs(clipEnd(a) - b.pos) > 0.002) continue; // not touching
    if (Math.abs(a.src1 - b.src0) < 0.0005 && a.gain === b.gain) continue; // continuous audio: nothing to blend
    const half = Math.min(want, b.src0, duration() - a.src1, clipLen(a) / 2, clipLen(b) / 2);
    if (half < 0.001) continue;
    a.src1 += half; a.fout = Math.max(a.fout, 2 * half);
    b.pos -= half; b.src0 -= half; b.fin = Math.max(b.fin, 2 * half);
    a.xout = b.xin = half;
  }
  return cs;
}
/** What the engine needs to render a lane (empty = untouched; a zero-length clip = silent lane). */
function clipsPayload(t) {
  if (!clipsEdited(t)) return [];
  return t.clips.length ? effectiveClips(t).map(c => [c.pos, c.src0, c.src1, c.gain, c.fin, c.fout]) : [[0, 0, 0, 0, 0, 0]];
}
function setXfade(ms) { S.xfade = ms; clipsChanged(); status(ms ? `Crossfades ${ms} ms` : 'Crossfades off'); }
function allClipPayloads(ids) {
  const out = {};
  for (const t of S.tracks) if ((!ids || ids.includes(t.id)) && clipsEdited(t)) out[t.id] = clipsPayload(t);
  return out;
}

/** Remove audio in [a, b) from a lane's clips (except `keep`), splitting or trimming as needed. */
function carve(t, a, b, keep = new Set()) {
  const out = [];
  for (const c of clipsOf(t)) {
    const e = clipEnd(c);
    if (keep.has(c.id) || e <= a || c.pos >= b) { out.push(c); continue; }
    if (c.pos < a) { // keep the part before a
      out.push({ ...c, src1: c.src0 + (a - c.pos), fout: 0 });
    }
    if (e > b) { // keep the part after b
      const d = b - c.pos;
      out.push({ ...c, id: c.pos < a ? newClipId() : c.id, pos: b, src0: c.src0 + d, fin: 0 });
    }
  }
  t.clips = out.filter(c => clipLen(c) >= CLIP_MIN || keep.has(c.id));
  for (const c of t.clips) { c.fin = Math.min(c.fin, clipLen(c)); c.fout = Math.min(c.fout, clipLen(c) - c.fin); }
}

// ───────────────────────── snapping ─────────────────────────
const laneWidth = () => $('ruler')?.getBoundingClientRect().width || 800;
function gridStep() {
  const pxs = laneWidth() / (viewSpan() || 1);
  return [0.01, 0.02, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60].find(s => s * pxs >= 14) || 60;
}
/** Snap to the playhead, loop edges and other clips' edges within 8 px, otherwise to the grid. */
function snapTime(T, e, exclude) {
  if (!S.snap || e?.altKey) return T;
  const tol = 8 / (laneWidth() / (viewSpan() || 1));
  let best = null, bd = tol;
  const consider = v => { const d = Math.abs(v - T); if (d < bd) { bd = d; best = v; } };
  consider(currentPos());
  if (S.region) { consider(S.region[0]); consider(S.region[1]); }
  consider(0); consider(duration());
  for (const t of S.tracks) for (const c of t.clips || []) if (!exclude?.has(c.id)) { consider(c.pos); consider(clipEnd(c)); }
  if (best != null) return best;
  const g = gridStep();
  return Math.round(T / g) * g;
}

// ───────────────────────── committing edits ─────────────────────────
let restartTimer = 0;
function clipsChanged({ restartPlayback = true } = {}) {
  for (const t of S.tracks) sortClips(t);
  for (const id of [...S.clipSel]) if (!findClip(id)) S.clipSel.delete(id);
  drawStudio();
  if (S.mode !== 'studio') requestVisuals?.();
  ContourProduct.changed();
  if (restartPlayback && S.playing) { clearTimeout(restartTimer); restartTimer = setTimeout(restart, 0); }
}
const clipToast = msg => status(msg);

function splitAt(tracks, at) {
  let n = 0;
  for (const t of tracks) {
    const c = clipAt(t, at);
    if (!c || at - c.pos < CLIP_MIN || clipEnd(c) - at < CLIP_MIN) continue;
    const right = { ...c, id: newClipId(), pos: at, src0: c.src0 + (at - c.pos), fin: 0 };
    c.src1 = right.src0; c.fout = 0;
    c.fin = Math.min(c.fin, clipLen(c));
    t.clips.push(right);
    n++;
  }
  if (n) { clipsChanged(); clipToast(`Split ${n} clip${n > 1 ? 's' : ''} at ${fmtPrecise(at)}`); }
}
function deleteSelected() {
  const sel = selectedClips();
  if (!sel.length) return false;
  for (const { t, c } of sel) t.clips = t.clips.filter(x => x !== c);
  S.clipSel.clear();
  clipsChanged();
  clipToast(`Deleted ${sel.length} clip${sel.length > 1 ? 's' : ''}`);
  return true;
}
/** Place copies of clips on their lanes, overwriting what's underneath (like a DAW's paste). */
function placeCopies(items) {
  S.clipSel.clear();
  for (const { t, clip } of items) {
    const end = Math.min(duration(), clip.pos + clipLen(clip));
    if (end - clip.pos < CLIP_MIN || clip.pos < 0) continue;
    const c = { ...clip, id: newClipId(), src1: clip.src0 + (end - clip.pos) };
    c.fout = Math.min(c.fout, clipLen(c));
    carve(t, c.pos, clipEnd(c));
    t.clips.push(c);
    S.clipSel.add(c.id);
  }
  clipsChanged();
}
function duplicateSelected() {
  const sel = selectedClips();
  if (!sel.length) return;
  const byTrack = new Map();
  for (const s of sel) (byTrack.get(s.t) || byTrack.set(s.t, []).get(s.t)).push(s.c);
  const items = [];
  for (const [t, cs] of byTrack) {
    const span = Math.max(...cs.map(clipEnd)) - Math.min(...cs.map(c => c.pos));
    for (const c of cs) items.push({ t, clip: { ...c, pos: c.pos + span } });
  }
  placeCopies(items);
  clipToast(`Duplicated ${sel.length} clip${sel.length > 1 ? 's' : ''}`);
}
function copySelected(cut = false) {
  const sel = selectedClips();
  if (!sel.length) return;
  const first = Math.min(...sel.map(s => s.c.pos));
  S.clipboard = sel.map(({ t, c }) => ({ trackId: t.id, clip: { ...c }, rel: c.pos - first }));
  if (cut) deleteSelected();
  clipToast(`${cut ? 'Cut' : 'Copied'} ${sel.length} clip${sel.length > 1 ? 's' : ''}`);
}
function pasteAtPlayhead() {
  if (!S.clipboard?.length) return;
  const at = currentPos();
  const items = S.clipboard.map(({ trackId, clip, rel }) => ({ t: track(trackId), clip: { ...clip, pos: at + rel } })).filter(i => i.t);
  placeCopies(items);
  clipToast(`Pasted at ${fmtPrecise(at)}`);
}
function nudgeSelected(dir) {
  const sel = selectedClips();
  if (!sel.length) return;
  let d = dir * gridStep();
  for (const { c } of sel) d = clamp(d, -c.pos, duration() - clipEnd(c));
  if (!d) return;
  const keep = new Set(sel.map(s => s.c.id));
  for (const { c } of sel) c.pos += d;
  for (const { t, c } of sel) carve(t, c.pos, clipEnd(c), keep);
  clipsChanged();
}
function gainSelected(db) {
  const sel = selectedClips();
  if (!sel.length) return;
  for (const { c } of sel) c.gain = db === null ? 1 : clamp(c.gain * Math.pow(10, db / 20), 0, 4);
  clipsChanged();
  const g = sel[0].c.gain;
  clipToast(`Clip gain ${g > 0 ? (20 * Math.log10(g) >= 0 ? '+' : '') + (20 * Math.log10(g)).toFixed(1) + ' dB' : '−∞ dB'}`);
}
function selectAllClips() {
  S.clipSel = new Set(editableTracks().flatMap(t => clipsOf(t).map(c => c.id)));
  drawStudio();
}
function setTool(tool) {
  S.tool = tool;
  $('tool-split')?.setAttribute('aria-pressed', String(tool === 'split'));
  document.querySelector('.timeline')?.classList.toggle('tool-split', tool === 'split');
}
function setSnap(on) {
  S.snap = on;
  $('snap')?.setAttribute('aria-pressed', String(on));
}

// ───────────────────────── drawing ─────────────────────────
function hexA(hex, a) {
  const n = parseInt(String(hex).slice(1, 7), 16);
  return Number.isNaN(n) ? `rgba(160,190,230,${a})` : `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
}
function roundRectPath(g, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  g.beginPath();
  g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}
/** Clip frames, fades, handles and gain labels over a Studio lane's waveform. */
function drawClipOverlay(t, cv, start, span) {
  if (!clipEditable(t) || S.mode !== 'studio') return;
  const g = cv.getContext('2d'), dpr = Math.min(2, devicePixelRatio || 1);
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const W = cv.width / dpr, H = cv.height / dpr, X = s => ((s - start) / span) * W;
  const xmap = new Map(effectiveClips(t).filter(e => e.xout).map(e => [e.id, e.xout]));
  for (const c0 of clipsOf(t)) {
    const c = xmap.has(c0.id) ? { ...c0, xout: xmap.get(c0.id) } : c0;
    const x0 = X(c.pos), x1 = X(clipEnd(c));
    if (x1 < -2 || x0 > W + 2) continue;
    const sel = S.clipSel.has(c.id), hov = S.clipHover?.id === c.id, w = Math.max(1, x1 - x0);
    g.globalAlpha = 1;
    roundRectPath(g, x0 + 0.5, 1.5, w - 1, H - 3, 5);
    if (sel) { g.fillStyle = 'rgba(141,184,240,.09)'; g.fill(); }
    g.lineWidth = sel ? 1.5 : 1;
    g.strokeStyle = sel ? 'rgba(141,184,240,.95)' : hexA(t.color, hov ? 0.6 : 0.3);
    g.stroke();
    const fade = (xa, xb, rising) => {
      g.fillStyle = 'rgba(3,8,18,.42)';
      g.beginPath();
      if (rising) { g.moveTo(xa, 2); g.lineTo(xb, 2); g.lineTo(xa, H - 2); }
      else { g.moveTo(xa, 2); g.lineTo(xb, 2); g.lineTo(xb, H - 2); }
      g.closePath(); g.fill();
      g.strokeStyle = hexA(t.color, 0.85); g.lineWidth = 1;
      g.beginPath();
      if (rising) { g.moveTo(xa, H - 2); g.lineTo(xb, 2); } else { g.moveTo(xa, 2); g.lineTo(xb, H - 2); }
      g.stroke();
    };
    if (c.fin > 0) fade(x0, X(c.pos + c.fin), true);
    if (c.fout > 0) fade(X(clipEnd(c) - c.fout), x1, false);
    if (c.xout) { // crossfade into the next clip
      const xa = X(clipEnd(c) - c.xout), xb = X(clipEnd(c) + c.xout);
      g.strokeStyle = 'rgba(233,241,251,.6)'; g.lineWidth = 1;
      g.beginPath(); g.moveTo(xa, 4); g.lineTo(xb, H - 4); g.moveTo(xa, H - 4); g.lineTo(xb, 4); g.stroke();
    }
    if ((sel || hov) && w > 18) {
      g.fillStyle = '#e9f1fb';
      for (const hx of [X(c.pos + c.fin), X(clipEnd(c) - c.fout)]) { g.beginPath(); g.arc(hx, 6, 3.2, 0, Math.PI * 2); g.fill(); }
      g.fillStyle = 'rgba(233,241,251,.55)';
      g.fillRect(x0 + 2, H / 2 - 7, 2, 14);
      g.fillRect(x1 - 4, H / 2 - 7, 2, 14);
    }
    if (Math.abs(c.gain - 1) > 1e-3 && w > 56) {
      const db = c.gain > 0 ? 20 * Math.log10(c.gain) : -Infinity;
      g.font = '500 10.5px ' + getComputedStyle(document.body).fontFamily;
      g.fillStyle = 'rgba(233,241,251,.85)';
      g.textAlign = 'right';
      g.fillText(Number.isFinite(db) ? `${db >= 0 ? '+' : ''}${db.toFixed(1)} dB` : '−∞ dB', x1 - 7, 15);
      g.textAlign = 'left';
    }
  }
}

// ───────────────────────── mouse ─────────────────────────
function clipHit(t, cv, e) {
  const r = cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
  const start = viewStart(), span = viewSpan() || 1, pxs = r.width / span, T = start + x / pxs;
  const partOf = c => {
    const x0 = (c.pos - start) * pxs, x1 = (clipEnd(c) - start) * pxs;
    const fin = x0 + c.fin * pxs, fout = x1 - c.fout * pxs;
    if (y < 13 && Math.abs(x - fin) <= 7) return 'fin';
    if (y < 13 && Math.abs(x - fout) <= 7) return 'fout';
    if (Math.abs(x - x0) <= 6) return 'left';
    if (Math.abs(x - x1) <= 6) return 'right';
    return x >= x0 && x <= x1 ? 'move' : null;
  };
  // The clip under the pointer wins (where two clips touch, the side you're on decides); the edge
  // tolerance only reaches across into gaps.
  const under = clipsOf(t).find(c => { const x0 = (c.pos - start) * pxs, x1 = (clipEnd(c) - start) * pxs; return x >= x0 && x < x1; });
  let hit = null;
  if (under) hit = { c: under, part: partOf(under) };
  else for (const c of clipsOf(t)) { const part = partOf(c); if (part && part !== 'move') { hit = { c, part }; break; } }
  return { hit, T, pxs, x, y };
}
const CURSORS = { move: 'grab', left: 'ew-resize', right: 'ew-resize', fin: 'pointer', fout: 'pointer' };

/** Studio lane mousedown when Curves mode is off. Returns true when handled. */
function clipMouseDown(e, cv, t) {
  if (!clipEditable(t) || e.button !== 0 || S.mode !== 'studio') return false;
  e.preventDefault();
  const { hit, T, pxs } = clipHit(t, cv, e);
  if (e.ctrlKey || e.metaKey) { // Ctrl/Cmd + drag: a selection box from anywhere, even over clips
    S.box = { x0: e.clientX, y0: e.clientY, T, add: e.shiftKey, base: new Set(e.shiftKey ? S.clipSel : []), moved: false };
    return true;
  }
  if (S.tool === 'split') {
    splitAt(e.shiftKey ? editableTracks() : [t], snapTime(T, e));
    return true;
  }
  if (!hit) { // empty lane: a click moves the playhead; a drag draws a selection box across lanes
    S.box = { x0: e.clientX, y0: e.clientY, T, add: e.shiftKey, base: new Set(e.shiftKey ? S.clipSel : []), moved: false };
    return true;
  }
  const { c, part } = hit;
  if (e.shiftKey && S.clipSel.has(c.id) && part === 'move') { S.clipSel.delete(c.id); drawStudio(); return true; }
  if (!S.clipSel.has(c.id)) { if (!e.shiftKey) S.clipSel.clear(); S.clipSel.add(c.id); }
  const group = part === 'move' ? selectedClips() : [{ t, c }];
  S.clipDrag = {
    part, t, c, cv, pxs, x0: e.clientX, lastX: e.clientX, acc: 0, T0: T, moved: false,
    orig: new Map(group.map(s => [s.c.id, { ...s.c }])), group,
  };
  cv.style.cursor = part === 'move' ? 'grabbing' : CURSORS[part];
  drawStudio();
  return true;
}
function clipHover(e, cv, t) {
  if (S.clipDrag || S.curves || S.mode !== 'studio' || !clipEditable(t)) return;
  if (S.tool === 'split') { cv.style.cursor = 'crosshair'; return; }
  const { hit } = clipHit(t, cv, e);
  cv.style.cursor = hit ? CURSORS[hit.part] : '';
  const id = hit?.c.id || null;
  if (S.clipHover?.id !== id) { const prev = S.clipHover?.t; S.clipHover = id ? { id, t } : null; if (prev && prev !== t) drawLane(prev); drawLane(t); }
}
window.addEventListener('mousemove', e => {
  const d = S.clipDrag;
  if (!d) return;
  if (!d.moved && Math.abs(e.clientX - d.x0) < 3) return;
  d.moved = true;
  // Alt = precision: the clip moves at a tenth of the mouse's speed (snapping off). Movement accumulates
  // step by step, so pressing or releasing Alt mid-drag never makes the clip jump.
  const fine = e.altKey;
  d.acc += (e.clientX - d.lastX) * (fine ? 0.1 : 1);
  d.lastX = e.clientX;
  const dT = d.acc / d.pxs, o = d.orig.get(d.c.id), c = d.c;
  const secs = v => (fine ? `${v.toFixed(3)} s` : `${v.toFixed(2)} s`);
  const at = v => (fine ? `${fmt(v)}.${String(Math.round((v % 1) * 1000)).padStart(3, '0')}` : fmtPrecise(v));
  if (d.part === 'move') {
    const ids = new Set(d.orig.keys());
    let np = snapTime(o.pos + dT, e, ids);
    const ne = snapTime(o.pos + clipLen(o) + dT, e, ids) - clipLen(o);
    if (S.snap && !e.altKey && Math.abs(ne - (o.pos + dT)) < Math.abs(np - (o.pos + dT))) np = ne;
    let delta = np - o.pos;
    for (const [id, oo] of d.orig) delta = clamp(delta, -oo.pos, duration() - (oo.pos + clipLen(oo)));
    for (const { c: cc } of d.group) cc.pos = d.orig.get(cc.id).pos + delta;
    showReadout(e, `${at(c.pos)}  (${delta >= 0 ? '+' : '−'}${secs(Math.abs(delta))})${fine ? '  · fine' : ''}`);
  } else if (d.part === 'left') {
    const S0 = clamp(snapTime(o.pos + dT, e, new Set([c.id])), o.pos - o.src0, o.pos + clipLen(o) - CLIP_MIN);
    c.pos = S0; c.src0 = o.src0 + (S0 - o.pos);
    c.fin = Math.min(o.fin, clipLen(c)); c.fout = Math.min(o.fout, clipLen(c) - c.fin);
    showReadout(e, `Start ${at(c.pos)}${fine ? '  · fine' : ''}`);
  } else if (d.part === 'right') {
    const E = clamp(snapTime(o.pos + clipLen(o) + dT, e, new Set([c.id])), o.pos + CLIP_MIN, o.pos + (duration() - o.src0));
    c.src1 = o.src0 + (E - o.pos);
    c.fout = Math.min(o.fout, clipLen(c)); c.fin = Math.min(o.fin, clipLen(c) - c.fout);
    showReadout(e, `End ${at(clipEnd(c))}${fine ? '  · fine' : ''}`);
  } else if (d.part === 'fin') {
    c.fin = clamp(o.fin + dT, 0, clipLen(c) - c.fout);
    showReadout(e, `Fade in ${secs(c.fin)}${fine ? '  · fine' : ''}`);
  } else if (d.part === 'fout') {
    c.fout = clamp(o.fout - dT, 0, clipLen(c) - c.fin);
    showReadout(e, `Fade out ${secs(c.fout)}${fine ? '  · fine' : ''}`);
  }
  for (const tt of new Set(d.group.map(s => s.t).concat(d.t))) drawLane(tt);
});
window.addEventListener('mouseup', e => {
  const d = S.clipDrag;
  if (!d) return;
  S.clipDrag = null;
  hideReadout();
  d.cv.style.cursor = '';
  if (!d.moved) { // a click on a clip selects it and moves the playhead there
    if (d.part === 'move') seekTo(d.T0);
    drawStudio();
    return;
  }
  // Dropping overwrites whatever the clip now covers on its lane (no overlaps).
  const keep = new Set(d.orig.keys());
  for (const { t, c } of d.group) carve(t, c.pos, clipEnd(c), keep);
  clipsChanged();
});

function clipMenuItems(t, T) {
  if (!clipEditable(t) || S.curves || S.mode !== 'studio') return [];
  const c = clipAt(t, T), items = [];
  if (c) {
    if (!S.clipSel.has(c.id)) { S.clipSel.clear(); S.clipSel.add(c.id); drawStudio(); }
    items.push(['Split here', () => splitAt([t], snapTime(T))]);
    items.push(['Duplicate', duplicateSelected], ['Copy', () => copySelected()], ['Cut', () => copySelected(true)], ['Delete', deleteSelected]);
    items.push(['Clip gain +1.5 dB', () => gainSelected(1.5)], ['Clip gain −1.5 dB', () => gainSelected(-1.5)]);
    if (Math.abs(c.gain - 1) > 1e-3) items.push(['Reset clip gain', () => gainSelected(null)]);
    if (c.fin || c.fout) items.push(['Remove fades', () => { for (const s of selectedClips()) { s.c.fin = 0; s.c.fout = 0; } clipsChanged(); }]);
  }
  if (S.clipboard?.length) items.push(['Paste at playhead', pasteAtPlayhead]);
  if (clipsEdited(t)) items.push([`Restore ${t.label}`, () => { t.clips = null; clipsChanged(); }]);
  if ((t.id === 'take' || t.id === 'take_tuned') && typeof tuneFromStudio === 'function') items.push(['Tune in Sing', tuneFromStudio]);
  for (const [name, ms] of XFADES) items.push([`Crossfades: ${name}${ms ? ` (${ms} ms)` : ''}${S.xfade === ms ? ' (current)' : ''}`, () => setXfade(ms)]);
  if (t.id.startsWith('lane_') && typeof removeLane === 'function') items.push([`Remove ${t.label}`, () => removeLane(t)]);
  return items;
}

// ───────────────────────── keyboard ─────────────────────────
window.addEventListener('keydown', e => {
  if (S.mode !== 'studio' || !S.source || e.defaultPrevented) return;
  if (e.target.closest?.('input, select, textarea, [contenteditable], dialog[open], .modal:not([hidden])')) return;
  if (!$('models-modal')?.hidden || document.querySelector('dialog[open]')) return;
  const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
  let done = true;
  if (!mod && !e.altKey && k === 's') splitAt(S.clipSel.size ? [...new Set(selectedClips().map(s => s.t))] : editableTracks(), currentPos());
  else if (!mod && (e.key === 'Delete' || e.key === 'Backspace') && S.clipSel.size && !S.curves) deleteSelected();
  else if (mod && !e.shiftKey && k === 'd') duplicateSelected();
  else if (mod && !e.shiftKey && k === 'c' && S.clipSel.size) copySelected();
  else if (mod && !e.shiftKey && k === 'x' && S.clipSel.size) copySelected(true);
  else if (mod && !e.shiftKey && k === 'v' && S.clipboard) pasteAtPlayhead();
  else if (mod && !e.shiftKey && k === 'a') selectAllClips();
  else if (!mod && e.key === 'Escape' && S.clipSel.size) { S.clipSel.clear(); drawStudio(); }
  else if (!mod && k === 'g') { setSnap(!S.snap); status(S.snap ? 'Snap on' : 'Snap off'); }
  else if (!mod && k === 'c') setTool(S.tool === 'split' ? 'select' : 'split');
  else if (!mod && k === 'v') setTool('select');
  else if (e.altKey && !mod && (e.key === 'ArrowLeft' || e.key === 'ArrowRight') && S.clipSel.size) nudgeSelected(e.key === 'ArrowLeft' ? -1 : 1);
  else if (!mod && (e.key === '+' || e.key === '=') && S.clipSel.size) gainSelected(1);
  else if (!mod && e.key === '-' && S.clipSel.size) gainSelected(-1);
  else done = false;
  if (done) { e.preventDefault(); e.stopImmediatePropagation(); }
}, true);

// ───────────────────────── playback ─────────────────────────
/** Schedule a lane's clips for timeline window [from, to) starting at context time `when`. */
function scheduleClips(t, when, from, to) {
  if (!t.buffer || !t.envNode) return;
  for (const c of effectiveClips(t)) {
    const a = Math.max(c.pos, from), b = Math.min(clipEnd(c), to);
    if (b - a <= 0.0005) continue;
    const src = S.ctx.createBufferSource(), g = S.ctx.createGain();
    src.buffer = t.buffer;
    const at = when + (a - from), p = g.gain, tt = T => at + (T - a);
    p.setValueAtTime(clipFade(c, a), at);
    const finEnd = c.pos + c.fin;
    if (c.fin > 0 && finEnd > a) p.linearRampToValueAtTime(clipFade(c, Math.min(finEnd, b)), tt(Math.min(finEnd, b)));
    const foutStart = clipEnd(c) - c.fout;
    if (c.fout > 0 && b > foutStart) {
      const s = Math.max(foutStart, a);
      p.setValueAtTime(clipFade(c, s), tt(s));
      p.linearRampToValueAtTime(clipFade(c, b), tt(b));
    }
    src.connect(g).connect(t.envNode);
    src.onended = () => { const i = S.nodes.indexOf(src); if (i >= 0) S.nodes.splice(i, 1); try { g.disconnect(); } catch { /* gone */ } };
    src.start(Math.max(at, S.ctx.currentTime), Math.max(0, c.src0 + (a - c.pos) + Math.max(0, S.ctx.currentTime - at)), Math.max(0.0005, b - a - Math.max(0, S.ctx.currentTime - at)));
    S.nodes.push(src);
  }
}
/** Loops: schedule each next pass of every lane a little ahead (works with the window hidden too). */
function loopSchedule() {
  if (!S.playing || !S.loop) return;
  const [a, b] = loopBounds();
  if (b - a < 0.02) return;
  while (S.loopNext - S.ctx.currentTime < 1.5) {
    for (const t of S.tracks) if (t.envNode && t.buffer) scheduleClips(t, S.loopNext, a, b);
    S.loopNext += b - a;
  }
}

// Toolbar
$('tool-split').onclick = () => setTool(S.tool === 'split' ? 'select' : 'split');
$('snap').onclick = () => setSnap(!S.snap);

// ── box select ──
function boxSelect(e) {
  const b = S.box, el = $('select-box');
  const x0 = Math.min(b.x0, e.clientX), x1 = Math.max(b.x0, e.clientX), y0 = Math.min(b.y0, e.clientY), y1 = Math.max(b.y0, e.clientY);
  Object.assign(el.style, { left: x0 + 'px', top: y0 + 'px', width: x1 - x0 + 'px', height: y1 - y0 + 'px' });
  el.hidden = false;
  const sel = new Set(b.base);
  for (const t of S.tracks) {
    if (!clipEditable(t) || !t.lane || t.lane.hidden) continue;
    const cv = t.lane.querySelector('canvas'), r = cv.getBoundingClientRect();
    if (r.bottom < y0 || r.top > y1 || !r.width) continue;
    const ta = viewStart() + ((x0 - r.left) / r.width) * viewSpan(), tb = viewStart() + ((x1 - r.left) / r.width) * viewSpan();
    for (const c of clipsOf(t)) if (clipEnd(c) > ta && c.pos < tb) sel.add(c.id);
  }
  S.clipSel = sel;
  drawStudio();
}
window.addEventListener('mousemove', e => {
  const b = S.box;
  if (!b) return;
  if (!b.moved && Math.hypot(e.clientX - b.x0, e.clientY - b.y0) < 5) return;
  b.moved = true;
  boxSelect(e);
});
window.addEventListener('mouseup', () => {
  const b = S.box;
  if (!b) return;
  S.box = null;
  $('select-box').hidden = true;
  if (!b.moved) { if (!b.add && S.clipSel.size) { S.clipSel.clear(); drawStudio(); } if (!b.noSeek) seekTo(b.T); }
  else if (S.clipSel.size) status(`${S.clipSel.size} clip${S.clipSel.size > 1 ? 's' : ''} selected`);
});

// the empty space below the last lane starts a selection box too
$('lanes').addEventListener('mousedown', e => {
  if (e.button !== 0 || S.mode !== 'studio' || !(e.target === $('lanes') || e.target.classList?.contains('lane-add'))) return;
  S.box = { x0: e.clientX, y0: e.clientY, T: currentPos(), add: e.shiftKey, base: new Set(e.shiftKey ? S.clipSel : []), moved: false, noSeek: true };
});
