'use strict';
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const $ = id => document.getElementById(id);
const escapeHtml = value => String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const SR = 44100;
const HIRES = 32768;

// Blue is the interface (selection, playhead, focus, solo); stems use distinct hues at an even
// brightness, so none shouts, none disappears, and none can be mistaken for a selected clip.
const COLORS = {
  original: '#8c97a8', vocals: '#eef2f8', lead: '#ffffff', backing: '#c3ccda',
  vocals_dry: '#f7f9fc', lead_dry: '#f7f9fc', vocals_reverb: '#9aa6b8', lead_reverb: '#9aa6b8',
  instrumental: '#4fd1c5', drums: '#f0806e', bass: '#8fd07a', guitar: '#c8e86b', piano: '#5cc8f2', other: '#3fb8a9',
  take: '#f27fa6', take_tuned: '#f79bbd', music_a: '#4fd1c5', vocals_b: '#c3ccda',
};
const PARENT = {
  lead: 'vocals', backing: 'vocals', vocals_dry: 'vocals', vocals_reverb: 'vocals', lead_dry: 'lead', lead_reverb: 'lead',
  drums: 'instrumental', bass: 'instrumental', guitar: 'instrumental', piano: 'instrumental', other: 'instrumental',
};
const STEMS_HINT = { none: 'Vocals and instrumental.', four: 'Vocals, drums, bass and everything else.', six: 'Vocals, drums, bass, guitar, piano and everything else.' };
const QUALITY_HINT = {
  fast: 'Voc FT with light overlap. The quickest result, close to Balanced.',
  balanced: 'Voc FT with 50% overlap. The everyday choice.',
  max: 'Mel-Band RoFormer: clearly cleaner vocals and instrumentals. Best on a GPU; slow on CPU.',
};
const GOALS = {
  karaoke: { instruments: 'none', on: ['instrumental'], note: 'Keeps the instrumental.' },
  acapella: { instruments: 'none', on: ['vocals'], note: 'Keeps the vocals.' },
  four: { instruments: 'four', on: null, note: 'Keeps all four parts.' },
  six: { instruments: 'six', on: null, note: 'Keeps all six parts.' },
};
const ZOOMS = [1, 2, 4, 8, 16, 32, 64];
// Volume curves are drawn on a dB scale from −∞ (bottom) to +6 dB (top).
const DB_MIN = -48, DB_MAX = 6, PAD = 4;
const ICON = {
  play: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3.4v9.2a.6.6 0 0 0 .9.5l7.4-4.6a.6.6 0 0 0 0-1L5.9 2.9a.6.6 0 0 0-.9.5Z"/></svg>',
  pause: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="4" y="3" width="2.6" height="10" rx=".8"/><rect x="9.4" y="3" width="2.6" height="10" rx=".8"/></svg>',
};
const ACCENT = '#8db8f0';
window.ContourPerf={wavePaints:0,strataPaints:0,pcmRequests:0,analysisSlices:0,frames:0};
const dbOf = g => (g <= 0.0001 ? '−∞ dB' : `${(20 * Math.log10(g)).toFixed(1).replace('-', '−')} dB`);
const panOf = p => (Math.abs(p) < 0.01 ? 'Centre' : `${p < 0 ? 'L' : 'R'} ${Math.round(Math.abs(p) * 100)}`);

const S = {
  mode: 'simple', goal: 'karaoke', quality: 'balanced', instruments: 'none',
  source: null, tracks: [], separated: false, busy: false, lastExport: null, collapsed: new Set(),
  ctx: null, master: null, masterAn: null, nodes: [], playing: false, pos: 0, started: 0, offset: 0,
  loop: false, region: null, nullTest: false, zoom: 0, viewStart: 0, raf: 0, timer: 0, reveal: 0, progress: null,
  session: 0, kind: 'song', actualBackend: '', backendNotes: [], retry: null, job: null, preflighting: false, savedMix: '',
  curves: false, sel: null, hover: null, drag: null, projectPath: null, modelsDir: null,
};

// ───────────────────────── utilities ─────────────────────────
const prefs = (() => { try { return JSON.parse(localStorage.getItem('contour.prefs.v2') || '{}'); } catch { return {}; } })();
// v3: presets were rebuilt and GPU selection fixed, so move people off Max-on-CPU once.
if (!prefs.v3) { if (prefs.quality === 'max') prefs.quality = 'balanced'; if (prefs.device === 'cpu') delete prefs.device; }
function savePrefs() {
  try {
    Object.assign(prefs, { v3: 1, flagship: $('simple-flagship').checked,
      mode: S.mode, goal: S.goal, quality: S.quality, instruments: S.instruments, lead: $('lead-backing').checked, dereverb: $('dereverb').checked,
      device: $('device').value, format: $('format').value, rate: $('rate').value, protect: $('protect').checked,
    });
    localStorage.setItem('contour.prefs.v2', JSON.stringify(prefs));
  } catch { /* storage unavailable */ }
}
const fmt = t => `${Math.floor(Math.max(0, t) / 60)}:${String(Math.floor(Math.max(0, t) % 60)).padStart(2, '0')}`;
const fmtPrecise = t => `${fmt(t)}.${Math.floor((Math.max(0, t) % 1) * 10)}`;
const mb = b => (b >= 1e9 ? (b / 1e9).toFixed(2) + ' GB' : Math.round(b / 1e6) + ' MB');
const duration = () => (S.source ? S.source.duration : 0);
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
function status(text, kind = '') { $('status').textContent = text; $('status').title = text; $('status').className = 'status ' + kind; }
let toastTimer;
function toast(text) { $('toast').textContent = text; ContourMotion.show($('toast'), true); clearTimeout(toastTimer); toastTimer = setTimeout(() => ContourMotion.show($('toast'), false), 8000); }
function setRadio(container, attr, value) { document.querySelectorAll(`${container} [data-${attr}]`).forEach(b => b.setAttribute('aria-checked', String(b.dataset[attr] === value))); }
const track = id => S.tracks.find(t => t.id === id);
const leaves = () => S.tracks.filter(t => t.leaf && t.id !== 'original');

function studioRequest() { return { quality: S.quality, lead_backing: $('lead-backing').checked, instruments: S.instruments, dereverb: $('dereverb').checked }; }
function simpleRequest() { return { quality: $('simple-flagship')?.checked ? 'max' : 'balanced', lead_backing: false, instruments: GOALS[S.goal].instruments, dereverb: false }; }

// ───────────────────────── mode ─────────────────────────
function setMode(mode) {
  if (!['simple', 'studio', 'mashup', 'karaoke'].includes(mode)) mode = 'simple';
  // The crossfade applies the switch a frame later. Remember the newest choice right away and let
  // every pending switch apply that one, so rapid clicks always end on the tab clicked last.
  const previous = S.modeTarget || S.mode;
  S.modeTarget = mode;
  ContourMotion.mode($(previous), $(mode), () => {
  mode = S.modeTarget;
  S.mode = mode;
  queueMicrotask(() => document.dispatchEvent(new CustomEvent('contour:mode', { detail: mode })));
  document.documentElement.dataset.mode = mode;
  ContourProduct.info();
  if (mode === 'simple' && S.busy) requestAnimationFrame(animateProcessing);
  window.ContourBackground?.set({ interval: mode === 'studio' ? 200 : 100 });
  setRadio('.mode', 'mode', mode);
  document.querySelectorAll('main').forEach(el => { el.inert = el.id !== mode; el.setAttribute('aria-hidden',String(el.id !== mode)); });
  savePrefs();
  requestVisuals(); requestAnimationFrame(frame);
  refreshNeeds();
  });
}
document.querySelectorAll('.mode button').forEach(b => (b.onclick = () => setMode(b.dataset.mode)));

// ───────────────────────── busy state & progress ─────────────────────────
function availability() {
  const b = S.busy || S.preflighting, exportingBlocked = b || MASH.pending, has = !!S.source;
  ['choose', 'studio-choose', 'open-project'].forEach(id => ($(id).disabled = b));
  ['save-project', 'simple-save-project', 'mash-save-project'].forEach(id => ($(id).disabled = exportingBlocked));
  $('simple-run').disabled = $('studio-run').disabled = !has || b;
  $('simple-cancel').hidden = $('studio-cancel').hidden = !S.busy;
  document.querySelectorAll('.inspector .seg button, .inspector input, #device, .tile, #simple-flagship, #mash-split, #mash-flagship, .mash-pick, #mash-swap, #mash-again').forEach(el => (el.disabled = b));
  document.querySelectorAll('.mash-controls button, .mash-controls input').forEach(el => (el.disabled = (b && !MASH.rendering) || !MASH.result || MASH.stale || S.kind !== 'mashup'));
  document.querySelectorAll('#simple-results .listen, #lanes button, #lanes input, #mash-rows .listen').forEach(el => (el.disabled = b && S.job?.label !== 'Saving recovery'));
  ['export', 'bounce', 'simple-save'].forEach(id => ($(id).disabled = !S.separated || exportingBlocked));
  ['mash-save', 'mash-stems', 'mash-studio'].forEach(id => ($(id).disabled = !S.separated || S.kind !== 'mashup' || exportingBlocked));
  ['play', 'stop', 'simple-play', 'mash-play'].forEach(id => ($(id).disabled = !has));
  $('download-all').disabled = b;
  $('task-cancel').hidden = !S.busy;
  $('task-cancel').disabled = !S.job?.cancellable || !!S.job?.cancelling;
  $('task-cancel').title = S.job?.cancellable ? 'Cancel the current task and keep the last successful result' : 'This stage must finish before another task can start';
  document.querySelectorAll('#models-table button').forEach(el => (el.disabled = b));
  $('task-retry').hidden = !S.retry || b;
  $('workspace').classList.toggle('busy', S.busy);
  $('mash-stale').hidden = !MASH.stale;
  mashReady();
  window.syncGlassSelects?.();
  ContourProduct.info();
}
function busyStart(label, options = {}) {
  S.jobT0 = performance.now();
  S.retry = null;
  S.job = { label, cancellable: options.cancellable ?? /Separat|Preparing models|Exporting|Downloading/.test(label), cancelling: false, tracker: new ContourWorkflow.PhaseClock() };
  S.busy = true;
  window.ContourBackground?.set({ paused: true });
  $('drop').classList.add('working');
  $('job').hidden = false; $('simple-progress').hidden = false;
  $('task-progress').hidden = false;
  $('task-stage').textContent = label;
  $('task-detail').textContent = '';
  setProgress(0, label, '');
  clearInterval(S.timer);
  const updateTime = () => {
    const elapsed = fmt((performance.now() - S.jobT0) / 1000);
    $('job-time').textContent = elapsed;
    $('task-time').textContent = elapsed + ' elapsed';
  };
  updateTime(); S.timer = setInterval(updateTime, 500);
  availability();
}
function busyEnd() {
  window.ContourBackground?.set({ paused: false });
  $('drop').classList.remove('working');
  S.busy = false; S.job = null;
  clearInterval(S.timer);
  ContourProduct.info();
  $('job').hidden = true; $('simple-progress').hidden = true;
  $('task-progress').hidden = true; $('task-time').textContent = '';
  S.progress = null;
  availability(); drawStrata();
  refreshNeeds();
  if (MASH.again && MASH.result && !MASH.stale && S.kind === 'mashup') { MASH.again = false; mashSchedule(0); }
}
function setProgress(f, stage, detail) {
  if (S.job?.cancelling) { stage = 'Cancelling…'; detail = 'Keeping the last successful result.'; }
  f = clamp(Number(f) || 0, 0, 1);
  S.progress = f;
  const phase = S.job?.tracker.sample(f, stage, detail, performance.now());
  if (phase?.remaining != null) detail = `${detail ? detail + ' · ' : ''}about ${fmt(phase.remaining)} left in this stage`;
  ['job-bar', 'task-bar'].forEach(id => ($(id).style.width = (f * 100).toFixed(1) + '%'));
  ['simple-progress', 'mash-progress'].forEach(id => ($(id).firstElementChild.style.width = (f * 100).toFixed(1) + '%'));
  $('task-progress').setAttribute('aria-valuenow', String(Math.round(f * 100)));
  $('task-progress').setAttribute('aria-valuetext', `${stage}: ${Math.round(f * 100)}%`);
  $('job-pct').textContent = Math.round(f * 100) + '%';
  $('job-stage').textContent = $('task-stage').textContent = stage;
  $('job-detail').textContent = $('task-detail').textContent = detail;

  if (/continuing on CPU|finished on.*CPU/i.test(stage)) setBackend('CPU fallback', [stage]);
  if (/Done$/.test(stage) && detail && !/^\d/.test(detail)) setBackend(detail);
  status(stage, 'busy'); drawStrata();
}
async function cancelTask() {
  if (!S.busy || !S.job?.cancellable || S.job.cancelling) return;
  S.job.cancelling = true; availability();
  setProgress(S.progress, 'Cancelling…', '');
  try { await invoke('cancel'); } catch (e) { S.job.cancelling = false; availability(); toast(String(e)); }
}
$('task-cancel').onclick = cancelTask;
$('task-retry').onclick = () => { const retry = S.retry; S.retry = null; availability(); retry?.(); };
function taskFailed(label, e, retry) {
  const cancelled = String(e) === 'cancelled';
  status(cancelled ? `${label} cancelled` : `${label} stopped`, cancelled ? '' : 'error');
  $('task-stage').textContent = cancelled ? `${label} cancelled` : `${label} failed`;
  $('task-detail').textContent = S.separated ? 'Your last result is still available.' : 'You can try again.';
  if (!cancelled) { S.retry = retry; toast(String(e)); }
}
function setBackend(backend, notes = []) {
  S.actualBackend = backend || S.actualBackend;
  if (backend) S.backendDevice = $('device').value;
  S.backendNotes = notes;
  // Only worth saying when the last run didn't use the chosen processor (e.g. the GPU fell back to CPU).
  const fellBack = /CPU/i.test(S.actualBackend || '') && $('device').value !== 'cpu';
  $('processor-result').textContent = fellBack ? `Ran on ${S.actualBackend}` : '';
  $('processor-result').title = fellBack ? (notes.join('\n') || 'The GPU was unavailable for the last run.') : '';
  $('processor-result').classList.toggle('fallback', fellBack);
}
listen('progress', ({ payload: p }) => { if (S.busy) setProgress(p.fraction, p.stage, p.detail); });

// One session owns every result. Mashup source slots are a draft until built.
function invalidateMash() {
  clearTimeout(MASH.timer); MASH.revision++; MASH.again = false; MASH.pending = false;
  if (MASH.result) MASH.stale = true;
  mashReady();
}
function clearMashDraft() {
  clearTimeout(MASH.timer); MASH.revision++; MASH.again = false; MASH.pending = false;
  MASH.a = MASH.b = MASH.result = null; MASH.stale = false; MASH.keepMix = false;
  MASH.settings = ContourWorkflow.defaultMashSettings();
  $('mash-split').checked = false; $('mash-flagship').checked = false;
  mashShowSlot('a', null); mashShowSlot('b', null); syncMashControls();
}
function resetSessionView(kind) {
  S.session++; S.kind = kind; S.mashProvenance=null; S.projectPath = null; S.lastExport = null;
  S.region = null; S.loop = false; S.nullTest = false; S.sel = null; S.hover = null; S.drag = null;
  S.collapsed.clear(); S.zoom = 0; S.viewStart = 0; S.pos = 0;
  $('loop').setAttribute('aria-pressed', 'false'); $('null').setAttribute('aria-pressed', 'false');
  $('reveal').hidden = $('simple-reveal').hidden = true;
}
function mixFingerprint() {
  return JSON.stringify({ source: S.source?.name, kind:S.kind, tracks:S.tracks.map(t=>[t.id,t.mute,t.solo,t.vol,t.pan,t.env,clipsEdited(t)?t.clips:null,t.label,t.height||0,t.fx]), xfade:S.xfade, region:S.region,loop:S.loop,mash:S.kind==='mashup'?{settings:MASH.settings,a:MASH.a?.name,b:MASH.b?.name,stale:MASH.stale}:null });
}
let confirmResolve = null;
function confirmAction(title, message, action = 'Continue') {
  if (confirmResolve) return Promise.resolve(false);
  const previous = document.activeElement;
  $('confirm-title').textContent = title; $('confirm-message').textContent = message; $('confirm-yes').textContent = action;
  $('confirm-dialog').showModal(); $('confirm-no').focus();
  return new Promise(resolve => { confirmResolve = value => { $('confirm-dialog').close(); confirmResolve = null; previous?.focus(); resolve(value); }; });
}
$('confirm-yes').onclick = () => confirmResolve?.(true);
$('confirm-no').onclick = () => confirmResolve?.(false);
$('confirm-dialog').addEventListener('cancel', e => { e.preventDefault(); confirmResolve?.(false); });

// ───────────────────────── first-run setup ─────────────────────────
// The installer runs Contour once with --setup; the app also offers this on launch if any core
// model is missing. Downloads are verified by SHA-256 in the engine.
const SETUP = { active: false, installer: false, list: [], base: 0, total: 0, current: null };
listen('progress', ({ payload: p }) => {
  if (!SETUP.active) return;
  let f = p.fraction;
  if (SETUP.current) f = (SETUP.base + p.fraction * SETUP.current.size) / Math.max(1, SETUP.total);
  $('setup-bar').style.width = (f * 100).toFixed(1) + '%';
  $('setup-stage').textContent = p.stage;
  $('setup-detail').textContent = p.detail;
});
function renderSetupList() {
  $('setup-list').innerHTML = SETUP.list.map(m => `<li class="${m.present ? 'done' : ''}"><span class="tick" aria-hidden="true"></span><span>${m.label}<small>${m.role}</small></span><span class="size">${m.present ? 'Ready' : mb(m.size)}</span></li>`).join('');
}
async function openSetup({ installer = false } = {}) {
  SETUP.list = await invoke('core_models');
  SETUP.installer = installer;
  const missing = SETUP.list.filter(m => !m.present);
  if (!missing.length && !installer) return;
  SETUP.total = missing.reduce((s, m) => s + m.size, 0);
  renderSetupList();
  $('setup-start').textContent = missing.length ? `Download ${mb(SETUP.total)}` : 'Continue';
  $('setup-skip').textContent = installer ? 'Skip, download later' : 'Skip for now';
  $('setup-error').hidden = true;
  $('setup').hidden = false;
  if (installer) runSetup();
}
async function runSetup() {
  if (SETUP.active) return;
  SETUP.active = true;
  $('setup-start').disabled = true;
  $('setup-error').hidden = true;
  $('setup-progress').hidden = false;
  try {
    SETUP.base = 0;
    for (const m of SETUP.list.filter(x => !x.present)) {
      SETUP.current = m;
      await invoke('models_download', { ids: [m.id] });
      m.present = true;
      SETUP.base += m.size;
      renderSetupList();
    }
    SETUP.current = null;
    await invoke('models_prepare');
    $('setup-stage').textContent = 'Contour is ready';
    $('setup-detail').textContent = '';
    $('setup-bar').style.width = '100%';
    setTimeout(finishSetup, 900);
  } catch (e) {
    SETUP.current = null;
    const msg = String(e);
    $('setup-error').textContent = msg === 'cancelled' ? 'Download paused.' : `Couldn't finish: ${msg}`;
    $('setup-error').hidden = false;
    $('setup-start').textContent = 'Try again';
    $('setup-start').disabled = false;
  } finally {
    SETUP.active = false;
  }
}
function finishSetup() {
  if (SETUP.installer) { invoke('exit_app'); return; }
  $('setup').hidden = true;
  refreshNeeds();
}
$('setup-start').onclick = runSetup;
$('setup-skip').onclick = () => {
  if (SETUP.active) invoke('cancel');
  try { localStorage.setItem('contour.setupSkipped', '1'); } catch { /* storage unavailable */ }
  if (SETUP.installer) { invoke('exit_app'); return; }
  $('setup').hidden = true;
  toast('Models will download the first time you need them.');
};



// ───────────────────────── settings ─────────────────────────
let needsRevision = 0;
function workflowSnapshot(mode = S.mode) {
  const mash = mode === 'mashup';
  return {
    mode, goal: S.goal, session: S.session, mashRevision: MASH.revision,
    request: mash ? { quality: $('mash-flagship').checked ? 'max' : 'balanced', instruments: $('mash-split').checked ? 'four' : 'none', lead_backing: false, dereverb: false } : mode === 'simple' ? simpleRequest() : studioRequest(),
    device: $('device').value,
    region: mode === 'studio' && $('region-sep').checked && S.region ? [...S.region] : null,
    settings: { ...MASH.settings }, split: $('mash-split').checked,
  };
}
async function requirements(snapshot) {
  const requests = [snapshot.request];
  if (snapshot.mode === 'mashup') requests.push({ ...snapshot.request, instruments: 'none' });
  const groups = await Promise.all(requests.map(request => invoke('models_required', { request })));
  return [...new Map(groups.flat().map(m => [m.id, m])).values()];
}
function processorWarning(snapshot) {
  const cpu = snapshot.device === 'cpu' || !(S.devices || []).some(d => !['cpu', 'auto'].includes(d)) || (/CPU/i.test(S.actualBackend) && S.backendDevice === snapshot.device);
  return snapshot.request.quality === 'max' && cpu ? 'Studio quality on CPU can take much longer than the song. Balanced quality is faster.' : '';
}
async function refreshNeeds() {
  if (S.busy || S.preflighting) return;
  const revision = ++needsRevision, snapshot = workflowSnapshot();
  try {
    const list = await requirements(snapshot);
    if (revision !== needsRevision || S.busy || S.preflighting) return;
    const missing = list.filter(m => !m.present), dl = missing.reduce((a, m) => a + m.size, 0);
    $('chain').replaceChildren(...list.map(m => { const row = document.createElement('div'); row.textContent = `${m.label}${m.present ? '' : ` · ${mb(m.size)} download`}`; return row; }));
    let eta = '';
    if (S.source && snapshot.mode !== 'mashup') {
      const est = await invoke('estimate', { request: snapshot.request, device: snapshot.device, region: snapshot.region }).catch(() => null);
      if (est) eta = `≈ ${fmt(est.seconds)}`;
    }
    if (revision !== needsRevision || S.busy || S.preflighting) return;
    $('estimate').textContent = eta;
    const warning = processorWarning(snapshot);
    const downloads = missing.length ? `${mb(dl)} download` : '';
    $('task-stage').textContent = S.retry ? 'Last task failed' : downloads;
    $('task-detail').textContent = [warning, eta].filter(Boolean).join(' · ');
    $('task-detail').classList.toggle('warning', !!warning);
    if (snapshot.mode === 'simple') $('simple-note').textContent = '';
    if (snapshot.mode === 'mashup') mashReady();
  } catch (e) { if (revision === needsRevision && !S.busy) { $('task-stage').textContent = 'Model requirements unavailable'; $('task-detail').textContent = String(e); } }
}
async function preflight(snapshot) {
  if (S.busy || S.preflighting) return false;
  S.preflighting = true; needsRevision++; availability();
  $('task-stage').textContent = 'Checking required models…'; $('task-detail').textContent = '';
  try {
    const missing = (await requirements(snapshot)).filter(m => !m.present);
    const warning = processorWarning(snapshot);
    if (missing.length || warning) {
      const lines = [];
      if (missing.length) lines.push(`Download ${mb(missing.reduce((a, m) => a + m.size, 0))} once for: ${missing.map(m => m.label).join(', ')}. Audio stays on this computer. An internet connection is needed for the download.`);
      if (warning) lines.push(warning);
      if (!await confirmAction('Before processing', lines.join('\n\n'), missing.length ? 'Download & process' : 'Process on CPU')) return false;
    }
    return snapshot.session === S.session && (snapshot.mode !== 'mashup' || snapshot.mashRevision === MASH.revision);
  } catch (e) { toast('Could not check models: ' + e); return false; }
  finally { S.preflighting = false; availability(); refreshNeeds(); }
}
function settingsChanged() {
  ContourMotion.layout(() => {
  $('stems-hint').textContent = STEMS_HINT[S.instruments];
  $('quality-hint').textContent = QUALITY_HINT[S.quality];
  }, $('studio'));
  savePrefs();
  refreshNeeds();
}
document.querySelectorAll('#stems-seg button').forEach(b => (b.onclick = () => { S.instruments = b.dataset.stems; setRadio('#stems-seg', 'stems', S.instruments); settingsChanged(); }));
document.querySelectorAll('#quality-seg button').forEach(b => (b.onclick = () => { S.quality = b.dataset.quality; setRadio('#quality-seg', 'quality', S.quality); settingsChanged(); }));
document.querySelectorAll('.tile').forEach(b => (b.onclick = () => { S.goal = b.dataset.goal; setRadio('.tiles', 'goal', S.goal); settingsChanged(); }));
['lead-backing', 'dereverb'].forEach(id => ($(id).onchange = settingsChanged));
['format', 'rate', 'protect'].forEach(id => ($(id).onchange = savePrefs));
$('device').onchange = () => { savePrefs(); refreshNeeds(); };
$('region-sep').onchange = refreshNeeds;
$('simple-flagship').onchange = () => { savePrefs(); refreshNeeds(); };
// Export drawer on narrower windows
$('export-drawer').onclick = () => { const open = !$('studio').classList.contains('drawer-open'); $('studio').classList.toggle('drawer-open', open); $('export-drawer').setAttribute('aria-pressed', String(open)); };
document.addEventListener('keydown', e => { if (e.key === 'Escape' && $('studio').classList.contains('drawer-open')) $('export-drawer').click(); });
document.addEventListener('pointerdown', e => { if ($('studio').classList.contains('drawer-open') && !e.target.closest('.delivery, #export-drawer, .select-menu')) $('export-drawer').click(); });

// ───────────────────────── loading ─────────────────────────
async function loadPath(path) {
  if (!path || S.busy || S.preflighting) return;
  if (!await ContourProduct.canReplace('import another song')) return;
  const resume = S.playing;
  stop();
  busyStart('Reading the song');
  try {
    const info = await invoke('load_audio', { path });
    resetSessionView('song'); clearMashDraft();
    S.source = info;
    S.separated = false;
    S.region = null;
    S.nullTest = false; $('null').setAttribute('aria-pressed', 'false');
    S.zoom = 0; S.viewStart = 0; S.pos = 0;
    S.tracks = [makeTrack({ id: 'original', label: 'Original', kind: 'mix', leaf: true, peaks: info.peaks })];
    $('now-name').textContent = info.name;
    $('now-name').title = info.path;
    $('now-meta').textContent = `${fmt(info.duration)}   ${(info.rate / 1000).toFixed(1)} kHz   ${info.channels === 1 ? 'mono' : info.channels === 2 ? 'stereo' : info.channels + ' channels'}`;
    $('drop').classList.add('loaded');
    preloadTracks(); // the original is ready before you press play
    $('reveal').hidden = $('simple-reveal').hidden = true;
    showSimpleResults(false);
    window.syncGlassSelects?.();
  renderAll();
    S.savedMix = mixFingerprint(); ContourProduct.session(true,true);
    status('Ready to separate');
  } catch (e) {
    taskFailed('Import', e, () => loadPath(path));
    if (resume) play();
  } finally {
    busyEnd();
    refreshNeeds();
  }
}
$('choose').onclick = $('studio-choose').onclick = async () => loadPath(await invoke('pick_audio'));
try {
  window.__TAURI__.webview.getCurrentWebview().onDragDropEvent(({ payload }) => {
    const over = payload.type === 'enter' || payload.type === 'over';
    $('drop').classList.toggle('drag', over && !S.busy);
    if (payload.type === 'drop' && payload.paths?.length) {
      if (S.mode === 'mashup') mashDrop(payload.paths, payload.position);
      else if (/\.contour$/i.test(payload.paths[0])) openProject(payload.paths[0]);
      else loadPath(payload.paths[0]);
    }
  });
} catch (e) { console.warn('drag and drop unavailable', e); }

// ───────────────────────── separation ─────────────────────────
async function separate(request, snapshot = workflowSnapshot()) {
  if (!S.source || S.busy || S.preflighting) return;
  if(S.separated && !await ContourProduct.canReplace('replace this separation'))return;
  snapshot = { ...snapshot, request: { ...request } };
  if (!await preflight(snapshot)) return;
  const resume = S.playing;
  stop();
  clearTimeout(MASH.timer); MASH.again = false; MASH.pending = false;
  busyStart('Preparing models');
  animateProcessing();
  let cut = false;
  try {
    const res = await invoke('separate', { request: snapshot.request, device: snapshot.device, region: snapshot.region });
    if (snapshot.session !== S.session) return;
    S.kind = 'song'; clearMashDraft();
    const original = track('original');
    const selection=new Map(S.tracks.map(t=>[t.id,t.exportSelected]));
    S.tracks = [original, ...res.stems.map(stem=>({...makeTrack(stem),exportSelected:selection.get(stem.id)}))];
    original.mute = true;
    if (snapshot.mode === 'simple') {
      S.quality = request.quality; setRadio('#quality-seg', 'quality', S.quality);
      // keep Studio's settings in step with what was just run
      S.instruments = request.instruments;
      $('lead-backing').checked = request.lead_backing;
      $('dereverb').checked = request.dereverb;
      setRadio('#stems-seg', 'stems', S.instruments);
      settingsChanged();
      const on = GOALS[snapshot.goal].on;
      for (const t of leaves()) t.mute = on ? !on.includes(t.id) : false;
    }
    S.separated = true;
    $('engine-tag').textContent = res.backend; setBackend(res.backend, res.notes || []);
    ContourProduct.result();
    status(`Separated in ${fmt(res.seconds)} on ${res.backend}`);
    if (res.notes?.length && snapshot.device !== 'cpu') {
      toast(`Running on ${res.backend}. ` + res.notes.join(' '));
      console.warn('accelerator notes', res.notes);
    }
    S.reveal = performance.now();
    cut = true;
    animateProcessing(); // keep drawing through the crossfade into stem colours
    preloadTracks(); // stems load while you look at the result
    showSimpleResults(true);
    window.syncGlassSelects?.();
  renderAll();
  } catch (e) {
    taskFailed('Separation', e, () => separate(snapshot.request, { ...snapshot, session: S.session }));
    if (resume) play();
  } finally {
    busyEnd();
    refreshNeeds();
  }
}
$('simple-run').onclick = () => separate(simpleRequest());
$('studio-run').onclick = () => separate(studioRequest());
$('simple-cancel').onclick = $('studio-cancel').onclick = cancelTask;

// ───────────────────────── tracks ─────────────────────────
function makeTrack(s) {
  return { ...s, color: COLORS[s.id] || '#9aa8b2', mute: !s.leaf, solo: false, vol: 1, pan: 0, env: [], fx: { warmth: 0, clarity: 0, punch: 0, width: 0.5, space: 0 }, buffer: null, hires: null, envNode: null, gain: null, panner: null, analyser: null, level: 0 };
}
function gainFor(t) {
  if (S.nullTest) return t.id === 'original' ? 1 : t.leaf ? -1 : 0;
  if (typeof K !== 'undefined' && K.active) return karaokeGain(t);
  // A "playing set" picked with the number keys is held in the solo flags; removing its last stem
  // leaves silence (soloSilent) until a number or 0 is pressed.
  const anySolo = S.soloSilent || S.tracks.some(x => x.solo);
  return (anySolo ? t.solo : !t.mute) ? t.vol : 0;
}
/** Number key: play only this stem. */
function playOnly(t) { S.tracks.forEach(x => (x.solo = x === t)); S.soloSilent = false; applyMix(); }
/** Shift + number (or a row's On/Off while a set is active): add the stem, or take it out if playing. */
function toggleInPlaying(t) {
  const set = new Set(S.tracks.filter(x => gainFor(x) !== 0));
  if (set.has(t)) set.delete(t); else set.add(t);
  S.tracks.forEach(x => (x.solo = set.has(x)));
  S.soloSilent = set.size === 0;
  applyMix();
}
/** 0: everything back as it was mixed. */
function playAll() { S.tracks.forEach(x => (x.solo = false)); S.soloSilent = false; applyMix(); }
const pickingSet = () => S.soloSilent || S.tracks.some(x => x.solo);
/** A row's On/Off: normally mute/unmute; while a set is picked, add to / remove from that set. */
function toggleRow(t) { if (pickingSet()) toggleInPlaying(t); else { t.mute = !t.mute; applyMix(); } }
function applyMix() {
  if (S.soloSilent && S.tracks.some(x => x.solo)) S.soloSilent = false;
  const vocal = S.kind === 'mashup' ? track('vocals') : null;
  if (vocal && MASH.result) { MASH.settings.vocal_gain_db = vocal.vol > 0 ? 20*Math.log10(vocal.vol) : -48; $('mash-gain').value = MASH.settings.vocal_gain_db; $('mash-gain-v').textContent = dbOf(vocal.vol); }
  for (const t of S.tracks) {
    if (t.gain && S.ctx) t.gain.gain.setTargetAtTime(gainFor(t), S.ctx.currentTime, 0.004);
    if (S.playing && gainFor(t) !== 0 && !t.buffer && !S.busy) loadTrack(t).catch(e=>toast(String(e)));
    if (t.panner && S.ctx) t.panner.pan.setTargetAtTime(t.pan, S.ctx.currentTime, 0.01);
    t.lane?.classList.toggle('silent', gainFor(t) === 0);
    t.lane?.querySelector('.m')?.setAttribute('aria-pressed', String(t.mute));
    t.lane?.querySelector('.s')?.setAttribute('aria-pressed', String(t.solo));
    if (t.row) {
      const on = gainFor(t) !== 0 || (!pickingSet() && !t.mute && t.vol === 0);
      t.row.classList.toggle('off', !on);
      const b = t.row.querySelector('.listen');
      b.setAttribute('aria-pressed', String(on));
      b.textContent = on ? 'On' : 'Off';
    }
  }
  mashRowState();
  ContourProduct.changed();
  drawStrata();
}
function soloOnly(t) { const was = t.solo; S.tracks.forEach(x => (x.solo = false)); t.solo = !was; applyMix(); }
function renderAll() { ContourMotion.layout(() => { showSimpleResults(S.separated); renderSimple(); renderStudio(); renderMash(); renderExportList(); availability(); drawStrata(); }, $(S.mode)); }

// ───────────────────────── simple mode ─────────────────────────
function showSimpleResults(on) { ContourMotion.layout(() => { $('simple-results').hidden = !on; $('pick').hidden = on; }, $('simple')); }
function renderSimple() {
  const list = $('result-list');
  list.innerHTML = '';
  for (const t of leaves()) {
    const row = document.createElement('div');
    row.className = 'result';
    row.style.setProperty('--c', t.color);
    row.innerHTML = `<canvas></canvas><i class="shade" aria-hidden="true"></i><strong>${escapeHtml(t.label)}</strong><button class="listen" aria-pressed="true" aria-label="Include ${escapeHtml(t.label)}">On</button>`;
    row.querySelector('.listen').onclick = () => toggleRow(t);
    row.querySelector('canvas').onclick = e => { const r = e.currentTarget.getBoundingClientRect(); seekTo(((e.clientX - r.left) / r.width) * duration()); };
    t.row = row;
    list.append(row);
  }
  if (S.separated) {
    const again = document.createElement('button');
    again.className = 'ghost';
    again.textContent = 'Separate differently';
    again.style.justifySelf = 'center';
    again.onclick = () => { showSimpleResults(false); refreshNeeds(); };
    list.append(again);
  }
  $('legend').innerHTML = S.separated ? leaves().map(t => `<span><i style="background:${t.color}"></i>${escapeHtml(t.label)}</span>`).join('') : '';
  applyMix();
  requestAnimationFrame(drawResultWaves);
}
function drawResultWaves() {
  if (S.mode !== 'simple') return;
  for (const t of leaves()) {
    const c = t.row?.querySelector('canvas');
    if (!c) continue;
    drawWave(c, t, 0, duration() || 1, 0.85, true);
    // Let the waveform recede under the stem name rather than putting a box behind it.
    const g = c.getContext('2d'), w = c.width / Math.min(2, devicePixelRatio || 1);
    const fade = g.createLinearGradient(0, 0, Math.min(170, w * 0.25), 0);
    fade.addColorStop(0, 'rgba(0,0,0,.82)'); fade.addColorStop(0.55, 'rgba(0,0,0,.55)'); fade.addColorStop(1, 'rgba(0,0,0,0)');
    g.globalCompositeOperation = 'destination-out'; g.globalAlpha = 1; g.fillStyle = fade; g.fillRect(0, 0, Math.min(170, w * 0.25), c.height);
    g.globalCompositeOperation = 'source-over';
  }
}
$('simple-save').onclick = async () => {
  const ids = leaves().filter(t => !t.mute).map(t => t.id);
  if (!ids.length) return toast('Switch on at least one part to save it.');
  const dir = await chooseExportFolder();
  if (!dir) return;
  const o=ContourProduct.exportSettings();if(o)await runExport(ids,dir,o.format,o.rate,o.protect,o.start==null?null:[o.start,o.end]);
};
$('simple-reveal').onclick = () => S.lastExport && invoke('reveal', { path: S.lastExport });
$('simple-play').onclick = togglePlay;

// Strata: the song drawn as stacked layers, one per stem.
const smoothCache = new WeakMap();
function smoothed(peaks, cols) {
  const cached = smoothCache.get(peaks); if(cached?.cols === cols) return cached.out;
  const out = new Float32Array(cols);
  for (let i = 0; i < cols; i++) {
    const a = Math.floor((i * peaks.length) / cols), b = Math.max(a + 1, Math.floor(((i + 1) * peaks.length) / cols));
    let s = 0; for (let j = a; j < b; j++) s += peaks[j] || 0;
    out[i] = s / (b - a);
  }
  const k = new Float32Array(cols);
  for (let i = 0; i < cols; i++) { let s = 0, n = 0; for (let j = -2; j <= 2; j++) { const v = out[i + j]; if (v !== undefined) { s += v; n++; } } k[i] = s / n; }
  smoothCache.set(peaks,{cols,out:k}); return k;
}
let strataQueued = false;
function drawStrata() {
  if (strataQueued) return;
  strataQueued = true;
  requestAnimationFrame(() => { strataQueued = false; paintStrata(); });
}
// The processing texture: a seamless halftone tile in the style of the background, drawn once and
// drifted across the waveform while a song is being separated.
let haloTile = null;
function processingTile() {
  if (haloTile) return haloTile;
  const w = 480, h = 240, step = 7, c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  for (let y = step / 2; y < h; y += step) {
    for (let x = step / 2; x < w; x += step) {
      // diagonal bands, periodic across the tile width so it repeats without a seam
      const band = 0.5 + 0.5 * Math.sin(2 * Math.PI * (2 * x / w + y / h * 0.9));
      const ripple = 0.5 + 0.5 * Math.sin(2 * Math.PI * (4 * x / w - y / h * 1.7));
      const r = 0.35 + 1.75 * Math.pow(band * 0.75 + ripple * 0.25, 1.6);
      g.fillStyle = `rgba(168,200,245,${0.25 + 0.6 * band})`;
      g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
    }
  }
  haloTile = c;
  return c;
}
let processingLoop = 0;
function animateProcessing() {
  cancelAnimationFrame(processingLoop);
  const tick = () => {
    const fading = S.separated && performance.now() - S.reveal < 1000;
    if ((S.busy || fading) && S.mode === 'simple') { drawStrata(); processingLoop = requestAnimationFrame(tick); }
  };
  processingLoop = requestAnimationFrame(tick);
}
function paintStrata() {
  ContourPerf.strataPaints++;
  const c = $('strata');
  if (S.mode !== 'simple') return;
  const r = c.getBoundingClientRect(), dpr = Math.min(2, devicePixelRatio || 1);
  if (!r.width) return;
  c.width = Math.round(r.width * dpr); c.height = Math.round(r.height * dpr);
  const g = c.getContext('2d');
  g.scale(dpr, dpr);
  const W = r.width, H = r.height, mid = H * 0.46, amp = H * 0.34;
  const orig = track('original');
  if (!orig) { paintIdle(g, W, H); return; }
  const cols = Math.max(60, Math.floor(W / 3));
  const base = smoothed(orig.peaks, cols);
  const maxBase = Math.max(0.05, ...base);
  const layers = S.separated ? leaves().map(t => ({ t, p: smoothed(t.peaks, cols) })) : [];
  // k: 0 → processing / unseparated, 1 → stem colours. A plain crossfade, no change in shape.
  const k = S.separated ? 1 - Math.pow(1 - clamp((performance.now() - S.reveal) / 900, 0, 1), 3) : 0;
  const xAt = i => (i / (cols - 1)) * W;
  const env = i => (base[i] / maxBase) * amp;
  const silhouette = () => {
    g.beginPath();
    for (let i = 0; i < cols; i++) g.lineTo(xAt(i), mid - env(i));
    for (let i = cols - 1; i >= 0; i--) g.lineTo(xAt(i), mid + env(i));
    g.closePath();
  };
  const processing = S.busy && !S.separated;
  const texture = processing ? 1 : 1 - k; // the texture fades out as the colours fade in
  silhouette();
  g.fillStyle = `rgba(142,160,182,${(processing ? 0.22 : 0.55) * (1 - k) + 0.04})`;
  g.fill();
  if (texture > 0.001 && (processing || (S.separated && k < 1))) {
    g.save();
    silhouette();
    g.clip();
    const tile = processingTile(), th = H, tw = (tile.width / tile.height) * th;
    const off = ((performance.now() / 1000) * 38) % tw; // a slow, steady drift
    g.globalAlpha = 0.5 * texture * (0.85 + 0.15 * Math.sin(performance.now() / 900));
    for (let x = -off; x < W; x += tw) g.drawImage(tile, x, 0, tw, th);
    g.restore();
  }
  if (layers.length) {
    const cum = new Float32Array(cols);
    const tot = new Float32Array(cols);
    for (const l of layers) for (let i = 0; i < cols; i++) tot[i] += l.p[i];
    for (const l of layers) {
      const fr = i => (tot[i] > 1e-6 ? l.p[i] / tot[i] : 1 / layers.length);
      g.beginPath();
      for (let i = 0; i < cols; i++) g.lineTo(xAt(i), mid - env(i) + 2 * env(i) * cum[i]);
      for (let i = cols - 1; i >= 0; i--) g.lineTo(xAt(i), mid - env(i) + 2 * env(i) * (cum[i] + fr(i)));
      g.closePath();
      g.globalAlpha = (l.t.mute ? 0.2 : 0.92) * k;
      g.fillStyle = l.t.color;
      g.fill();
      for (let i = 0; i < cols; i++) cum[i] += fr(i);
    }
    g.globalAlpha = 1;
    if (k < 1) drawStrata();
  }
  const d = duration();
  if (d) $('strata-cursor').style.transform = `translateX(${Math.round(currentPos()/d*W)}px)`;
}
function paintIdle(g, W, H) {
  g.lineWidth = 1.2;
  for (let k = 0; k < 10; k++) {
    g.beginPath();
    const cx = W * 0.74, cy = H * 0.5, rx = W * (0.05 + k * 0.042), ry = H * (0.07 + k * 0.068);
    for (let a = 0; a <= Math.PI * 2 + 0.05; a += 0.04) {
      const w = 1 + 0.09 * Math.sin(3 * a + k * 0.6) + 0.05 * Math.sin(5 * a - k);
      g.lineTo(cx + rx * w * Math.cos(a), cy + ry * w * Math.sin(a));
    }
    g.strokeStyle = k === 0 ? 'rgba(238,242,248,.7)' : k < 4 ? `rgba(79,209,197,${0.5 - k * 0.07})` : `rgba(141,184,240,${0.34 - (k - 4) * 0.05})`;
    g.stroke();
  }
}
$('strata').addEventListener('click', async e => {
  if (S.busy) return;
  if (!S.source) return loadPath(await invoke('pick_audio'));
  const r = e.currentTarget.getBoundingClientRect();
  seekTo(((e.clientX - r.left) / r.width) * duration());
});

// ───────────────────────── studio mode ─────────────────────────
const viewSpan = () => duration() / ZOOMS[S.zoom];
const viewStart = () => clamp(S.viewStart, 0, Math.max(0, duration() - viewSpan()));
// ── lane management: drag a lane's name to reorder, double-click to rename, drag its bottom edge to resize ──
const parentOf = t => (PARENT[t.id] && S.tracks.some(x => x.id === PARENT[t.id]) ? PARENT[t.id] : null);
/** Rebuild the lane order with `order` for one family (top level, or one group's children). */
function reorderFamily(parent, order) {
  const kids = p => (p === parent ? order : S.tracks.filter(x => parentOf(x) === p));
  const out = [];
  const emit = x => { out.push(x); for (const k of kids(x.id)) emit(k); };
  for (const x of kids(null)) emit(x);
  for (const x of S.tracks) if (!out.includes(x)) out.push(x); // never lose a lane
  S.tracks = out;
}
function attachLaneManagement(lane, t) {
  const name = lane.querySelector('.lane-label');
  // rename
  if (t.id !== 'original') name.addEventListener('dblclick', e => {
    e.stopPropagation();
    const input = document.createElement('input');
    input.className = 'lane-rename'; input.value = t.label; input.maxLength = 40; input.setAttribute('aria-label', 'Lane name');
    name.replaceWith(input); input.focus(); input.select();
    let done = false;
    const finish = keep => {
      if (done) return; done = true;
      const v = input.value.trim();
      if (keep && v && v !== t.label) { t.label = v; ContourProduct.changed(); renderExportList?.(); }
      renderStudio();
    };
    input.addEventListener('keydown', ev => { ev.stopPropagation(); if (ev.key === 'Enter') finish(true); if (ev.key === 'Escape') finish(false); });
    input.addEventListener('blur', () => finish(true));
  });
  // reorder: drag the lane by its name
  name.title = t.id === 'original' ? 'Drag to reorder' : 'Drag to reorder · double-click to rename';
  name.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    const y0 = e.clientY, fam = parentOf(t);
    let dragging = false, target = null, line = null;
    const siblings = () => S.tracks.filter(x => parentOf(x) === fam && x.lane && !x.lane.hidden);
    const move = ev => {
      if (!dragging && Math.abs(ev.clientY - y0) < 5) return;
      if (!dragging) { dragging = true; lane.classList.add('dragging'); line = document.createElement('div'); line.className = 'lane-drop'; $('lanes').append(line); }
      const sib = siblings(), box = $('lanes').getBoundingClientRect();
      target = null;
      for (const s of sib) { const r = s.lane.getBoundingClientRect(); if (ev.clientY < r.top + r.height / 2) { target = s; break; } }
      const ref = target ? target.lane.getBoundingClientRect().top : Math.max(...sib.map(s => s.lane.getBoundingClientRect().bottom));
      line.style.top = `${ref - box.top + $('lanes').scrollTop - 1}px`;
    };
    const up = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
      if (!dragging) return;
      line?.remove(); lane.classList.remove('dragging');
      const order = S.tracks.filter(x => parentOf(x) === fam && x !== t);
      const at = target && target !== t ? order.indexOf(target) : order.length;
      order.splice(at < 0 ? order.length : at, 0, t);
      reorderFamily(fam, order);
      renderStudio(); ContourProduct.changed();
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  });
  // resize: drag the bottom edge
  lane.querySelector('.lane-resize').addEventListener('pointerdown', e => {
    e.preventDefault(); e.stopPropagation();
    const y0 = e.clientY, h0 = lane.getBoundingClientRect().height;
    let raf = 0;
    const move = ev => {
      t.height = Math.round(clamp(h0 + ev.clientY - y0, 44, 260));
      lane.style.height = `${t.height}px`;
      cancelAnimationFrame(raf); raf = requestAnimationFrame(() => drawLane(t));
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); timelineGeometry = null; drawStudio(); ContourProduct.changed(); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  });
}
/** Add any audio file as a new lane. */
async function addLane() {
  if (!S.source || S.busy) return;
  const path = await invoke('pick_audio');
  if (!path) return;
  busyStart('Adding a lane');
  try {
    const info = await invoke('add_lane', { path });
    const t = makeTrack(info);
    t.mute = false;
    S.tracks.push(t);
    renderStudio(); renderExportList?.();
    await loadTrack(t);
    ContourProduct.audioChanged?.();
    status(`Added ${info.label}`);
  } catch (e) { status('Could not add that file', 'error'); toast(String(e)); } finally { busyEnd(); }
}
async function removeLane(t) {
  try { await invoke('remove_stem', { id: t.id }); } catch (e) { toast(String(e)); return; }
  S.tracks = S.tracks.filter(x => x !== t);
  renderStudio(); renderExportList?.(); ContourProduct.audioChanged?.();
}
function renderStudio() {
  timelineGeometry=null;
  const box = $('lanes');
  box.innerHTML = '';
  if (!S.tracks.length) {
    box.innerHTML = '<div class="empty"><div><h2>Your mixer is ready</h2><p>Import a song or open a saved session.</p><div class="empty-actions"><button class="primary" id="empty-import">Import song</button><button class="ghost" id="empty-project">Open project</button></div></div></div>';
    $('empty-import').onclick=()=> $('studio-choose').click(); $('empty-project').onclick=()=>openProject();
    drawStudio();
    return;
  }
  S.tracks.forEach((t, i) => {
    const lane = document.createElement('div');
    const isGroup = !t.leaf && t.id !== 'original';
    lane.className = 'lane' + (PARENT[t.id] ? ' child' : '') + (isGroup ? ' group' : '');
    lane.style.setProperty('--c', t.color);
    lane.innerHTML = `<div class="lane-head">
        <div class="lane-name">${isGroup ? '<button class="fold" aria-label="Collapse"><svg viewBox="0 0 12 12" aria-hidden="true"><path d="m3 4.5 3 3 3-3"/></svg></button>' : ''}<span class="lane-label">${escapeHtml(t.label)}</span><small>${i < 9 ? i + 1 : ''}</small><i class="has-curve" title="Has a volume curve" hidden></i></div>
        <div class="lane-btns"><button class="m" aria-pressed="false" title="Mute">M</button><button class="s" aria-pressed="false" title="Solo (Shift adds)">S</button></div>
        <div class="lane-mix"><input type="range" class="vol" min="0" max="400" value="${Math.round(t.vol * 100)}" aria-label="${escapeHtml(t.label)} level" title="Level"><input type="range" class="pan" min="-100" max="100" value="${Math.round(t.pan * 100)}" aria-label="${escapeHtml(t.label)} pan" title="Pan (double-click to centre)"><div class="lane-meter"><i></i></div></div>
      </div><canvas></canvas>`;
    lane.querySelector('.m').onclick = () => { t.mute = !t.mute; applyMix(); };
    lane.querySelector('.s').onclick = e => { if (e.shiftKey) { t.solo = !t.solo; applyMix(); } else soloOnly(t); };
    const vol = lane.querySelector('.vol'), pan = lane.querySelector('.pan');
    const paint = () => {
      vol.style.setProperty('--p', (t.vol / 4) * 100 + '%');
      const c = 50 + t.pan * 50;
      pan.style.setProperty('--a', Math.min(50, c) + '%');
      pan.style.setProperty('--b', Math.max(50, c) + '%');
      vol.title = `Level ${dbOf(t.vol)}`; vol.setAttribute('aria-valuetext', dbOf(t.vol));
      pan.title = `Pan ${panOf(t.pan)} (double-click to centre)`; pan.setAttribute('aria-valuetext', panOf(t.pan));
    };
    vol.oninput = e => { t.vol = +e.target.value / 100; paint(); applyMix(); readout(e.target, dbOf(t.vol)); };
    vol.ondblclick = () => { vol.value = 100; t.vol = 1; paint(); applyMix(); };
    pan.oninput = e => { t.pan = +e.target.value / 100; if (Math.abs(t.pan) < 0.04) { t.pan = 0; pan.value = 0; } paint(); applyMix(); readout(e.target, panOf(t.pan)); };
    pan.ondblclick = () => { pan.value = 0; t.pan = 0; paint(); applyMix(); };
    [vol, pan].forEach(el => { el.addEventListener('pointerup', hideReadout); el.addEventListener('blur', hideReadout); });
    paint();
    const fold = lane.querySelector('.fold');
    if (fold) fold.onclick = () => { S.collapsed.has(t.id) ? S.collapsed.delete(t.id) : S.collapsed.add(t.id); updateFolds(); };
    if (t.height) lane.style.height = `${t.height}px`;
    lane.insertAdjacentHTML('beforeend', '<div class="lane-resize" aria-hidden="true" title="Drag to resize"></div>');
    attachLaneManagement(lane, t);
    const wave = lane.querySelector('canvas');
    wave.tabIndex = 0;
    wave.setAttribute('role', 'img');
    wave.setAttribute('aria-label', isGroup ? `${t.label} waveform` : `${t.label} waveform. In Curves mode, press Enter to add a volume point.`);
    attachCurveEditing(wave, t, isGroup);
    attachCurveKeys(wave, t, isGroup);
    t.lane = lane;
    t.meterEl = lane.querySelector('.lane-meter i');
    box.append(lane);
  });
  if (S.source) {
    const add = document.createElement('div');
    add.className = 'lane-add';
    add.innerHTML = '<button class="ghost" type="button">+ Add audio lane</button>';
    add.querySelector('button').onclick = addLane;
    box.append(add);
  }
  updateFolds();
  applyMix();
  updateCurveBadges();
}
function readout(el, text) {
  const o = $('readout'), r = el.getBoundingClientRect();
  o.textContent = text;
  o.hidden = false;
  o.style.left = r.left + r.width / 2 + 'px';
  o.style.top = r.top - 6 + 'px';
}
function hideReadout() { $('readout').hidden = true; }
function hiddenByFold(id) { let p = PARENT[id]; while (p) { if (S.collapsed.has(p)) return true; p = PARENT[p]; } return false; }
function updateFolds() {
  ContourMotion.layout(() => {
  for (const t of S.tracks) {
    t.lane?.classList.toggle('collapsed', hiddenByFold(t.id));
    const f = t.lane?.querySelector('.fold');
    if (f) { f.classList.toggle('closed', S.collapsed.has(t.id)); f.setAttribute('aria-label', S.collapsed.has(t.id) ? 'Expand' : 'Collapse'); }
  }
  }, $('studio'));
  drawStudio();
}
const waveCache=new WeakMap();
function drawWave(c, t, start, span, alpha, normalize = false) {
  const r = c.getBoundingClientRect(), dpr = Math.min(2, devicePixelRatio || 1);
  if (!r.width || !r.height) return;
  const width=Math.round(r.width*dpr),height=Math.round(r.height*dpr),p=t.hires||t.peaks,q=t.rms;
  const clipped = typeof clipsEdited === 'function' && clipsEdited(t);
  const key=[width,height,start,span,alpha,normalize,t.color,S.mode,S.region?.join(',')||'',clipped?JSON.stringify(t.clips):''].join('|'),cached=waveCache.get(c);
  if(c.width!==width)c.width=width;if(c.height!==height)c.height=height;
  const g=c.getContext('2d');g.setTransform(1,0,0,1,0,0);g.clearRect(0,0,width,height);
  if(cached && cached.key===key && cached.p===p && cached.q===q){g.drawImage(cached.image,0,0);return;}
  ContourPerf.wavePaints++;g.setTransform(dpr,0,0,dpr,0,0);
  const d = duration() || 1, W = r.width, H = r.height, mid = H / 2;
  const a0 = (start / d) * p.length, a1 = ((start + span) / d) * p.length;
  const peakCol = [], coreCol = [];
  for (let x = 0; x <= W; x++) {
    let i0 = Math.floor(a0 + ((a1 - a0) * x) / W), i1 = Math.max(i0 + 1, Math.floor(a0 + ((a1 - a0) * (x + 1)) / W)), mul = 1;
    if (clipped) { // map this column through the lane's clips: gaps are silent, clips read their source range
      const T0 = start + (span * x) / W, T1 = start + (span * (x + 1)) / W, cl = clipAt(t, (T0 + T1) / 2);
      if (!cl) { peakCol.push(0); coreCol.push(0); continue; }
      const s0 = cl.src0 + (Math.max(T0, cl.pos) - cl.pos), s1 = cl.src0 + (Math.min(T1, clipEnd(cl)) - cl.pos);
      i0 = Math.floor((s0 / d) * p.length); i1 = Math.max(i0 + 1, Math.floor((s1 / d) * p.length)); mul = clipFade(cl, (T0 + T1) / 2);
    }
    let v = 0, s = 0, n = 0;
    for (let j = i0; j < i1 && j < p.length; j++) { v = Math.max(v, p[j] || 0); if (q) { s += q[j] || 0; n++; } }
    peakCol.push(v * mul);
    coreCol.push((q ? (n ? s / n : 0) : v * 0.5) * mul);
  }
  if (!q) { // no RMS yet: approximate the dense core with a softened peak envelope
    const sm = coreCol.slice();
    for (let x = 0; x < sm.length; x++) { let s = 0, n = 0; for (let k = -2; k <= 2; k++) { const v = coreCol[x + k]; if (v !== undefined) { s += v; n++; } } sm[x] = s / n; }
    coreCol.splice(0, coreCol.length, ...sm);
  }
  const peak = normalize ? Math.max(0.02, ...peakCol) : 1, k = (H * 0.47) / peak;
  const shape = (col, floor) => {
    g.beginPath();
    g.moveTo(0, mid - Math.max(floor, col[0] * k));
    for (let x = 1; x < col.length; x++) g.lineTo(x, mid - Math.max(floor, col[x] * k));
    for (let x = col.length - 1; x >= 0; x--) g.lineTo(x, mid + Math.max(floor, col[x] * k));
    g.closePath();
  };
  const grad = g.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, t.color + 'cc'); grad.addColorStop(0.5, t.color); grad.addColorStop(1, t.color + 'cc');
  alpha = Math.min(1, alpha * 1.12);
  g.globalAlpha = alpha * 0.42; g.fillStyle = t.color; shape(peakCol, 0.5); g.fill();
  g.globalAlpha = alpha; g.fillStyle = grad; shape(coreCol, 0.5); g.fill();
  g.globalAlpha = alpha * 0.5; g.fillStyle = t.color; g.fillRect(0, Math.round(mid) - 0.25, W, 0.5);
  if (S.region && S.mode === 'studio') {
    const x0 = ((S.region[0] - start) / span) * W, x1 = ((S.region[1] - start) / span) * W;
    g.globalAlpha = 0.08; g.fillStyle = ACCENT; g.fillRect(x0, 0, x1 - x0, H);
  }
  const image=cached?.image || document.createElement('canvas'); image.width=width;image.height=height;image.getContext('2d').drawImage(c,0,0);waveCache.set(c,{key,p,q,image});
}
function drawStudio() {
  timelineGeometry=null;
  if (S.mode !== 'studio') return;
  const start = viewStart(), span = viewSpan() || 1;
  const viewport=$('lanes').getBoundingClientRect();
  for (const t of S.tracks) {
    if (!t.lane || t.lane.classList.contains('collapsed')) continue;
    const rect=t.lane.getBoundingClientRect();if(rect.bottom<viewport.top || rect.top>viewport.bottom)continue;
    drawLane(t, start, span);
  }
  drawRuler(start, span);
  $('zoom-label').textContent = S.zoom ? `${ZOOMS[S.zoom]}×` : 'Fit';
  placePlayhead();
}
function niceStep(span, px) { const want = (span / px) * 90; for (const s of [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300]) if (s >= want) return s; return 600; }
function drawRuler(start, span) {
  const c = $('ruler'), r = c.getBoundingClientRect(), dpr = Math.min(2, devicePixelRatio || 1);
  if (!r.width) return;
  c.width = Math.round(r.width * dpr); c.height = Math.round(r.height * dpr);
  const g = c.getContext('2d');
  g.scale(dpr, dpr);
  const W = r.width, H = r.height;
  if (S.region) {
    const x0 = ((S.region[0] - start) / span) * W, x1 = ((S.region[1] - start) / span) * W;
    g.fillStyle = S.loop ? 'rgba(141,184,240,.38)' : 'rgba(141,184,240,.16)';
    g.fillRect(x0, 5, x1 - x0, H - 10);
  }
  if (!duration()) return;
  const step = niceStep(span, W);
  g.fillStyle = 'rgba(171,188,210,.62)';
  g.font = '10.5px ' + getComputedStyle(document.body).fontFamily;
  for (let s = Math.ceil(start / step) * step; s <= start + span + 1e-9; s += step) {
    const x = ((s - start) / span) * W;
    g.fillRect(Math.round(x), H - 6, 1, 6);
    g.fillText(step < 1 ? s.toFixed(step < 0.5 ? 2 : 1) : fmt(s), x + 4, 14);
  }
}
let timelineGeometry=null;
function timelineRect(){
  if(timelineGeometry)return timelineGeometry;
  const first=S.tracks.find(t=>t.lane && !t.lane.classList.contains('collapsed'))?.lane.querySelector('canvas');
  if(!first)return null;
  const tl=document.querySelector('.timeline').getBoundingClientRect(),cr=first.getBoundingClientRect();
  return timelineGeometry={left:cr.left-tl.left,width:cr.width};
}
function placePlayhead(){
  const ph=$('playhead'),d=duration();if(S.mode!=='studio'||!d){ph.hidden=true;return;}
  const rect=timelineRect();if(!rect){ph.hidden=true;return;}
  const p=currentPos(),start=viewStart(),span=viewSpan();ph.hidden=p<start||p>start+span;
  ph.style.left=rect.left+'px';ph.style.transform=`translateX(${(p-start)/span*rect.width}px)`;
}
// ruler: drag to set the loop region, click to seek, double-click to clear
(() => {
  const c = $('ruler');
  let anchor = null;
  const at = e => { const r = c.getBoundingClientRect(); return clamp(viewStart() + ((e.clientX - r.left) / r.width) * viewSpan(), 0, duration()); };
  c.addEventListener('mousedown', e => { if (!duration()) return; anchor = at(e); S.region = null; drawStudio(); });
  window.addEventListener('mousemove', e => {
    if (anchor == null) return;
    const t = at(e);
    S.region = Math.abs(t - anchor) > 0.05 ? [Math.min(anchor, t), Math.max(anchor, t)] : null;
    drawStudio();
  });
  window.addEventListener('mouseup', () => {
    if (anchor == null) return;
    const was = anchor;
    anchor = null;
    if (!S.region) seekTo(was);
    else {
      // a new loop region loops straight away, from its start
      S.loop = true;
      $('loop').setAttribute('aria-pressed', 'true');
      seekTo(S.region[0]);
      if (!S.playing && !S.starting) play();
    }
    ContourProduct.changed(); drawStudio();
  });
  c.addEventListener('dblclick', () => { S.region = null; if (S.playing && S.loop) restart(); drawStudio(); ContourProduct.changed(); });
})();
function setZoom(z, anchorTime) {
  if (!duration()) return;
  const old = viewSpan(), oldStart = viewStart();
  S.zoom = clamp(z, 0, ZOOMS.length - 1);
  const t = anchorTime ?? currentPos();
  S.viewStart = t - ((t - oldStart) / old) * viewSpan();
  drawStudio();
}
$('zoom-in').onclick = () => setZoom(S.zoom + 1);
$('zoom-out').onclick = () => setZoom(S.zoom - 1);
$('lanes').addEventListener('wheel', e => {
  if (!duration()) return;
  const c = e.target.closest('.lane canvas');
  if (e.ctrlKey || e.metaKey) {
    e.preventDefault();
    let t;
    if (c) { const r = c.getBoundingClientRect(); t = viewStart() + ((e.clientX - r.left) / r.width) * viewSpan(); }
    setZoom(S.zoom + (e.deltaY < 0 ? 1 : -1), t);
  } else if (S.zoom && (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY))) {
    e.preventDefault();
    S.viewStart = viewStart() + ((e.deltaX || e.deltaY) / 600) * viewSpan();
    drawStudio();
  }
}, { passive: false });
new ResizeObserver(requestVisuals).observe(document.body);
$('lanes').addEventListener('scroll',requestVisuals,{passive:true});

// ───────────────────────── volume curves ─────────────────────────
const gainToY = (g, H) => {
  if (g <= 0) return H - PAD;
  const db = 20 * Math.log10(g);
  return clamp(PAD + (1 - (db - DB_MIN) / (DB_MAX - DB_MIN)) * (H - 2 * PAD), PAD, H - PAD);
};
const yToGain = (y, H) => {
  const db = DB_MIN + (1 - (y - PAD) / (H - 2 * PAD)) * (DB_MAX - DB_MIN);
  if (db <= DB_MIN + 0.5) return 0;
  return Math.pow(10, Math.min(DB_MAX, db) / 20);
};
const dbText = g => (g <= 0 ? '−∞ dB' : `${(20 * Math.log10(g)).toFixed(1).replace('-', '−')} dB`);
function envAt(env, t) {
  if (!env.length) return 1;
  if (t <= env[0].t) return env[0].g;
  for (let i = 0; i < env.length - 1; i++) {
    const a = env[i], b = env[i + 1];
    if (t <= b.t) return a.g + (b.g - a.g) * ((t - a.t) / Math.max(1e-9, b.t - a.t));
  }
  return env[env.length - 1].g;
}
function drawLane(t, start = viewStart(), span = viewSpan() || 1) {
  const c = t.lane?.querySelector('canvas');
  if (!c) return;
  drawWave(c, t, start, span, t.leaf || t.id === 'original' ? 0.85 : 0.6);
  drawClipOverlay(t, c, start, span);
  const editable = !(!t.leaf && t.id !== 'original');
  if (!editable || (!t.env.length && !S.curves)) return;
  const g = c.getContext('2d'), dpr = Math.min(2, devicePixelRatio || 1);
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.globalAlpha = 1;
  const W = c.width / dpr, H = c.height / dpr, X = s => ((s - start) / span) * W;
  if (S.curves) { // unity reference
    g.strokeStyle = 'rgba(255,255,255,.08)'; g.setLineDash([3, 4]); g.beginPath();
    g.moveTo(0, gainToY(1, H) + 0.5); g.lineTo(W, gainToY(1, H) + 0.5); g.stroke(); g.setLineDash([]);
  }
  const env = t.env;
  g.strokeStyle = S.curves ? '#e6eaee' : 'rgba(230,234,238,.5)';
  g.lineWidth = 1.25;
  g.beginPath();
  if (!env.length) { g.moveTo(0, gainToY(1, H)); g.lineTo(W, gainToY(1, H)); }
  else {
    g.moveTo(0, gainToY(envAt(env, start), H));
    for (const p of env) if (p.t > start && p.t < start + span) g.lineTo(X(p.t), gainToY(p.g, H));
    g.lineTo(W, gainToY(envAt(env, start + span), H));
  }
  g.stroke();
  if (!S.curves) return;
  env.forEach((p, i) => {
    const x = X(p.t), y = gainToY(p.g, H);
    if (x < -4 || x > W + 4) return;
    const on = (S.sel?.t === t && S.sel.idx === i) || (S.hover?.t === t && S.hover.idx === i);
    g.fillStyle = on ? '#8db8f0' : '#06122a';
    g.strokeStyle = on ? '#d6e7ff' : '#e9eef6';
    g.lineWidth = 1;
    g.fillRect(Math.round(x) - 3, Math.round(y) - 3, 6, 6);
    g.strokeRect(Math.round(x) - 2.5, Math.round(y) - 2.5, 6, 6);
  });
}
function hitPoint(t, x, y, W, H) {
  const start = viewStart(), span = viewSpan() || 1;
  let best = -1, bd = 49;
  t.env.forEach((p, i) => {
    const dx = ((p.t - start) / span) * W - x, dy = gainToY(p.g, H) - y, d = dx * dx + dy * dy;
    if (d < bd) { bd = d; best = i; }
  });
  return best;
}
function insertPoint(t, time, gain) {
  if (!t.env.length) t.env.push({ t: 0, g: 1 }, { t: duration(), g: 1 });
  const p = { t: clamp(time, 0, duration()), g: gain };
  let i = t.env.findIndex(q => q.t > p.t);
  if (i < 0) i = t.env.length;
  t.env.splice(i, 0, p);
  return i;
}
function updateCurveBadges() { for (const t of S.tracks) t.lane?.querySelector('.has-curve')?.toggleAttribute('hidden', !t.env.length); }
let reschedQueued = false;
function rescheduleCurves() {
  if (!S.playing || reschedQueued) return;
  reschedQueued = true;
  requestAnimationFrame(() => {
    reschedQueued = false;
    if (!S.playing) return;
    const when = S.ctx.currentTime + 0.01, from = currentPos() + 0.01;
    for (const t of S.tracks) scheduleEnv(t, when, from);
  });
}
function curvesChanged(t) { if (t) drawLane(t); updateCurveBadges(); rescheduleCurves(); ContourProduct.changed(); }
/** Schedule a track's curve sample-accurately from `from` seconds (song time) at `when` (context time), unrolling loops. */
function scheduleEnv(t, when, from) {
  const p = t.envNode?.gain;
  if (!p) return;
  p.cancelScheduledValues(0);
  const env = S.nullTest ? [] : t.env;
  if (!env.length) { p.setValueAtTime(1, when); return; }
  const looping = S.loop, [a, b] = looping ? loopBounds() : [0, duration()];
  let pos = clamp(from, 0, duration()), at = when;
  p.setValueAtTime(envAt(env, pos), at);
  for (let pass = 0; pass < 200; pass++) {
    const end = looping ? b : duration();
    for (const q of env) if (q.t > pos && q.t < end) p.linearRampToValueAtTime(q.g, at + (q.t - pos));
    const tEnd = at + Math.max(0, end - pos);
    p.linearRampToValueAtTime(envAt(env, end), tEnd);
    if (!looping || b - a < 0.02 || tEnd - when > 1800) break;
    pos = a; at = tEnd;
    p.setValueAtTime(envAt(env, a), at);
  }
}
function showReadout(e, text) { const r = $('readout'); r.textContent = text; r.style.left = e.clientX + 'px'; r.style.top = e.clientY + 'px'; r.hidden = false; }
function openMenu(e, items) {
  const m = $('menu');
  m.innerHTML = '';
  for (const [label, fn] of items) { const b = document.createElement('button'); b.setAttribute('role', 'menuitem'); b.textContent = label; b.onclick = () => { closeMenu(); fn(); }; m.append(b); }
  m.hidden = false;
  const r = m.getBoundingClientRect();
  m.style.left = Math.min(e.clientX, innerWidth - r.width - 6) + 'px';
  m.style.top = Math.min(e.clientY, innerHeight - r.height - 6) + 'px';
  m.querySelector('button')?.focus();
}
function closeMenu() { $('menu').hidden = true; }
window.addEventListener('mousedown', e => { if (!e.target.closest('#menu')) closeMenu(); });
window.addEventListener('keydown', e => { if (e.key === 'Escape') closeMenu(); });
function attachCurveEditing(c, t, isGroup) {
  const local = e => { const r = c.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top, W: r.width, H: r.height, time: viewStart() + ((e.clientX - r.left) / r.width) * viewSpan() }; };
  c.addEventListener('mousedown', e => {
    const p = local(e);
    if (!S.curves && clipMouseDown(e, c, t)) return;
    if (!S.curves || isGroup || e.button !== 0) { if (e.button === 0) seekTo(p.time); return; }
    e.preventDefault();
    let idx = hitPoint(t, p.x, p.y, p.W, p.H);
    if (e.altKey) { if (idx >= 0) { t.env.splice(idx, 1); S.sel = null; curvesChanged(t); } return; }
    if (idx < 0) idx = insertPoint(t, p.time, yToGain(p.y, p.H));
    S.sel = { t, idx };
    S.drag = { t, idx, c };
    showReadout(e, `${fmtPrecise(t.env[idx].t)}   ${dbText(t.env[idx].g)}`);
    curvesChanged(t);
  });
  c.addEventListener('mousemove', e => {
    if (!S.curves) clipHover(e, c, t);
    if (!S.curves || isGroup || S.drag) return;
    const p = local(e), idx = hitPoint(t, p.x, p.y, p.W, p.H);
    const was = S.hover?.t === t ? S.hover.idx : -1;
    S.hover = idx >= 0 ? { t, idx } : null;
    c.style.cursor = idx >= 0 ? 'grab' : '';
    if (idx !== was) drawLane(t);
    if (idx >= 0) showReadout(e, dbText(t.env[idx].g)); else hideReadout();
  });
  c.addEventListener('mouseleave', () => { if (S.drag) return; if (S.hover?.t === t) { S.hover = null; drawLane(t); } hideReadout(); });
  c.addEventListener('contextmenu', e => {
    e.preventDefault();
    if (isGroup) return;
    const p = local(e), idx = hitPoint(t, p.x, p.y, p.W, p.H);
    const items = clipMenuItems(t, p.time);
    if (idx >= 0) items.push(['Delete point', () => { t.env.splice(idx, 1); S.sel = null; curvesChanged(t); }]);
    if (!S.curves) items.push(['Edit volume curves', () => $('curves').click()]);
    if (t.env.length) items.push([`Clear ${t.label} curve`, () => { t.env = []; S.sel = null; curvesChanged(t); }]);
    if (S.tracks.some(x => x.env.length)) items.push(['Clear all curves', () => { S.tracks.forEach(x => (x.env = [])); S.sel = null; drawStudio(); curvesChanged(); }]);
    if (items.length) openMenu(e, items);
  });
}
window.addEventListener('mousemove', e => {
  const d = S.drag;
  if (!d) return;
  const r = d.c.getBoundingClientRect(), env = d.t.env, p = env[d.idx];
  const prev = env[d.idx - 1], next = env[d.idx + 1];
  const time = viewStart() + ((e.clientX - r.left) / r.width) * viewSpan();
  p.t = clamp(time, prev ? prev.t + 0.001 : 0, next ? next.t - 0.001 : duration());
  let g = yToGain(e.clientY - r.top, r.height);
  if (!e.shiftKey && g > 0 && Math.abs(20 * Math.log10(g)) < 0.75) g = 1; // snap to 0 dB; hold Shift for fine moves
  p.g = g;
  showReadout(e, `${fmtPrecise(p.t)}   ${dbText(p.g)}`);
  drawLane(d.t);
  rescheduleCurves();
});
window.addEventListener('mouseup', () => { if (!S.drag) return; const t = S.drag.t; S.drag = null; hideReadout(); curvesChanged(t); });
$('curves').onclick = () => {
  if (!S.separated) return toast('Separate a song first, then draw volume curves on its lanes.');
  S.curves = !S.curves;
  $('curves').setAttribute('aria-pressed', String(S.curves));
  document.querySelector('.timeline').classList.toggle('curves-on', S.curves);
  if (!S.curves) { S.sel = S.hover = null; hideReadout(); }
  status(S.curves ? 'Curves: click a lane to add a point, drag to shape, Alt-click to delete' : 'Curves off');
  drawStudio();
};


// Keyboard editing of a lane's curve (the waveform is focusable): Enter adds a point at the
// playhead · ← → select the previous/next point · ↑ ↓ change its level by 0.5 dB (Shift: 0.1 dB)
// · , . move it by 0.1 s (Shift: 1 s) · Delete removes it.
function attachCurveKeys(c, t, isGroup) {
  c.addEventListener('keydown', e => {
    if (isGroup || !S.curves) return;
    const sel = S.sel?.t === t ? S.sel.idx : -1;
    const env = t.env, step = e.shiftKey ? 0.1 : 0.5;
    const announce = i => { if (env[i]) status(`${t.label}: point at ${fmtPrecise(env[i].t)}, ${dbText(env[i].g)}`); };
    let handled = true;
    if (e.key === 'Enter') {
      const pos = currentPos(), idx = insertPoint(t, pos, envAt(env, pos));
      S.sel = { t, idx }; curvesChanged(t); announce(idx);
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      if (!env.length) { handled = false; } else {
        const next = sel < 0 ? (e.key === 'ArrowRight' ? 0 : env.length - 1) : clamp(sel + (e.key === 'ArrowRight' ? 1 : -1), 0, env.length - 1);
        S.sel = { t, idx: next }; drawLane(t); announce(next);
      }
    } else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && sel >= 0) {
      const p = env[sel], db = p.g > 0 ? 20 * Math.log10(p.g) : DB_MIN;
      const nd = clamp(db + (e.key === 'ArrowUp' ? step : -step), DB_MIN, DB_MAX);
      p.g = nd <= DB_MIN ? 0 : Math.pow(10, nd / 20);
      curvesChanged(t); announce(sel);
    } else if ((e.key === ',' || e.key === '.') && sel >= 0) {
      const p = env[sel], prev = env[sel - 1], next = env[sel + 1], dt = (e.shiftKey ? 1 : 0.1) * (e.key === '.' ? 1 : -1);
      p.t = clamp(p.t + dt, prev ? prev.t + 0.001 : 0, next ? next.t - 0.001 : duration());
      curvesChanged(t); announce(sel);
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && sel >= 0) {
      env.splice(sel, 1); S.sel = null; curvesChanged(t); status(`${t.label}: point deleted`);
    } else handled = false;
    if (handled) { e.preventDefault(); e.stopPropagation(); }
  });
}

// ───────────────────────── playback ─────────────────────────
const yieldUI = () => new Promise(resolve => setTimeout(resolve,0));
function audioContext() { return (S.ctx ??= new AudioContext({sampleRate:SR,latencyHint:'playback'})); }
async function fetchBuffer(t,valid=()=>true) {
  ContourPerf.pcmRequests++;
  const ctx = audioContext(), raw = await invoke('pcm',{id:t.id,depth:16});
  if(!valid())return null;
  const scale = new DataView(raw).getFloat32(0,true)/32768;
  const pcm = new Int16Array(raw,4), n=pcm.length/2;
  if(!Number.isInteger(n) || !n) throw new Error('Invalid playback audio');
  const buf=ctx.createBuffer(2,n,SR);
  for(let c=0;c<2;c++) {
    const dest=buf.getChannelData(c), base=c*n;
    for(let i=0;i<n;i+=65536) {
      if(!valid())return null;
      const end=Math.min(n,i+65536); for(let j=i;j<end;j++)dest[j]=pcm[base+j]*scale;
      if(end<n)await yieldUI();
    }
  }
  return buf;
}
function loadTrack(t) {
  if(t.buffer || !S.tracks.includes(t))return Promise.resolve();
  if(t._loading)return t._loading;
  t._loading=(async()=>{
    const buf=await fetchBuffer(t,()=>S.tracks.includes(t));
    if(!buf || !S.tracks.includes(t))return;
    t.buffer=buf; t.lastUsed=performance.now();trimBuffers();
    if(S.playing)startTrack(t,S.ctx.currentTime+.03,currentPos()+.03);
    scheduleAnalysis(t);
  })().finally(()=>{t._loading=null;});
  return t._loading;
}
const idle=window.requestIdleCallback || (fn=>setTimeout(()=>fn({timeRemaining:()=>4}),20));
function scheduleAnalysis(t) {
  if(!t.buffer || t.hires || t._analysis)return;
  t._analysis=true;
  const buffer=t.buffer, a=buffer.getChannelData(0),b=buffer.getChannelData(1),n=buffer.length;
  const size=Math.min(HIRES,n),hi=new Float32Array(size),rms=new Float32Array(size); let k=0;
  const slice=()=>{
    if(!S.tracks.includes(t)||t.buffer!==buffer){t._analysis=false;return;}
    const started=performance.now();ContourPerf.analysisSlices++;
    for(;k<size;k++) {
      const i0=Math.floor(k*n/size),i1=Math.max(i0+1,Math.floor((k+1)*n/size));let peak=0,sum=0;
      for(let i=i0;i<i1;i++){const l=a[i],r=b[i];peak=Math.max(peak,Math.abs(l),Math.abs(r));sum+=(l*l+r*r)*.5;}
      hi[k]=Math.min(1,peak);rms[k]=Math.min(1,Math.sqrt(sum/(i1-i0))*1.41);
      if((k&31)===31 && performance.now()-started>4){k++;idle(slice);return;}
    }
    t.hires=hi;t.rms=rms;t._analysis=false;requestVisuals();
  };idle(slice);
}
function trimBuffers() {
  let bytes=S.tracks.reduce((n,t)=>n+(t.buffer?t.buffer.length*8:0),0);
  const candidates=S.tracks.filter(t=>t.buffer && gainFor(t)===0 && !t._loading).sort((a,b)=>(a.lastUsed||0)-(b.lastUsed||0));
  for(const t of candidates){if(bytes<=1024*1024*1024)break;bytes-=t.buffer.length*8;try{t.sourceNode?.stop();t.sourceNode?.disconnect();}catch{}S.nodes=S.nodes.filter(n=>n!==t.sourceNode);t.gain?.disconnect();t.panner?.disconnect();t.envNode?.disconnect();t.sourceNode=t.gain=t.panner=t.envNode=null;t.buffer=null;}
  ContourPerf.bufferBytes=bytes;
}
let preloadScheduled=false;
function preloadTracks() {
  if(preloadScheduled)return;preloadScheduled=true;
  // Start straight away (not at idle time): stems should be ready to switch on the moment they exist.
  Promise.resolve().then(async()=>{
    preloadScheduled=false;
    for(const t of [...S.tracks].sort((x,y)=>(gainFor(y)!==0)-(gainFor(x)!==0))) {
      if(!S.tracks.includes(t))break;
      // Every stem is loaded, audible ones first (see the sort below), so switching a stem on or off
      // during playback is a gain change with no loading delay: usable like DJ stem toggles.
      if(!t.buffer)await loadTrack(t).catch(()=>{});
    }
  });
}
async function ensureBuffers() {
  audioContext();
  // Every switchable stem is loaded before playback starts, so turning any of them on is instant.
  const needed=S.tracks.filter(t=>!t.buffer && (gainFor(t)!==0 || t.leaf));
  await Promise.all(needed.map(t=>loadTrack(t)));
}
let visualFrame=0;
function requestVisuals(){if(visualFrame)return;visualFrame=requestAnimationFrame(()=>{visualFrame=0;drawStudio();drawStrata();drawResultWaves();drawMashWaves();});}
const loopBounds = () => S.region || [0, duration()];
function currentPos() {
  if (!S.playing) return S.pos;
  let p = S.offset + Math.max(0, S.ctx.currentTime - S.started);
  if (S.loop) { const [a, b] = loopBounds(); if (p > b && b - a > 0.01) p = a + ((p - a) % (b - a)); }
  return Math.min(duration(), p);
}
/** Song position at a context time (follows loops). */
function posAt(ctxTime) {
  if (!S.playing) return S.pos;
  let p = S.offset + Math.max(0, ctxTime - S.started);
  if (S.loop) { const [a, b] = loopBounds(); if (p > b && b - a > 0.01) p = a + ((p - a) % (b - a)); }
  return Math.min(duration(), p);
}
const FADE = 0.004; // de-click time constant (~15 ms to silence): inaudible as a fade, removes clicks
/**
 * Stop playback without a click: every lane fades out over a few milliseconds, then its nodes are
 * released. `at` (context time) lets a restart crossfade: the old audio fades out exactly as the new
 * audio fades in, so seeks and edits during playback have no gap.
 */
function stop(reset = false, at = null) {
  S.playRequest=(S.playRequest||0)+1;S.starting=false;
  const now = S.ctx ? S.ctx.currentTime : 0, from = Math.max(now, at ?? now);
  S.pos = reset ? (S.loop && S.region ? S.region[0] : 0) : (S.playing ? posAt(from) : S.pos);
  S.playing = false;
  clearInterval(S.loopTimer);
  const nodes = S.nodes, chains = S.tracks.filter(t => t.gain).map(t => [t.envNode, t.fxNode, t.gain, t.panner, t.send]);
  for (const [, g] of chains) { try { g.gain.cancelScheduledValues(from); g.gain.setTargetAtTime(0, from, FADE); } catch { /* released */ } }
  for (const n of nodes) { try { n.onended = null; n.stop(from + FADE * 6); } catch { /* already stopped */ } }
  if (nodes.length || chains.length) setTimeout(() => {
    for (const n of nodes) { try { n.disconnect(); } catch { /* gone */ } }
    for (const ch of chains) for (const x of ch) { try { x?.disconnect(); } catch { /* gone */ } }
  }, Math.max(0, (from - now + FADE * 6) * 1000) + 80);
  S.nodes = [];
  for (const t of S.tracks) { t.envNode = t.fxNode = t.send = t.gain = t.panner = t.analyser = null; t.level = 0; }
  cancelAnimationFrame(S.raf);
  ['play', 'simple-play', 'mash-play','global-play'].forEach(id => { $(id).innerHTML = ICON.play; $(id).setAttribute('aria-label', 'Play');$(id).removeAttribute('aria-busy'); });
  frame();
}
/** Create and start one track's nodes at context time `when`, song position `offset`. */
function startTrack(t, when, offset) {
  if (!t.buffer || t.gain) return;
  const [a, b] = loopBounds(), looping = S.loop && b - a > 0.02;
  if (looping && (offset >= b || offset < a)) offset = a + ((((offset - a) % (b - a)) + (b - a)) % (b - a));
  t.gain = S.ctx.createGain();
  t.gain.gain.value = 0;
  t.gain.gain.setValueAtTime(0, when);
  t.gain.gain.setTargetAtTime(gainFor(t), when, FADE);
  t.panner = S.ctx.createStereoPanner();
  t.panner.pan.value = t.pan;
  t.analyser = S.ctx.createAnalyser();
  t.analyser.fftSize = 512;
  t.envNode = S.ctx.createGain();
  if (S.fxReady) {
    t.fxNode = new AudioWorkletNode(S.ctx, 'contour-stem-fx', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit' });
    t.fxNode.port.postMessage(t.fx);
    t.envNode.connect(t.fxNode).connect(t.gain).connect(t.panner);
    t.send = S.ctx.createGain();
    t.send.gain.value = Math.pow(Math.max(0, Math.min(1, t.fx.space)), 1.5);
    t.panner.connect(t.send).connect(S.reverbIn);
  } else t.envNode.connect(t.gain).connect(t.panner);
  t.panner.connect(t.analyser);
  t.panner.connect(S.master);
  scheduleEnv(t, when, offset);
  if (looping) {
    scheduleClips(t, when, offset, b);
    // a lane joining mid-loop also gets the passes already scheduled for the others
    for (let w = when + (b - offset); S.loopNext && w < S.loopNext - 1e-3; w += b - a) scheduleClips(t, w, a, b);
  } else scheduleClips(t, when, offset, duration());
  t.sourceNode = null;
}
async function play(opts = {}) {
  if (!S.source || S.playing || S.starting) return;
  const request= S.playRequest=(S.playRequest||0)+1; S.starting=true;
  ['play','simple-play','mash-play','global-play'].forEach(id=>{$(id).innerHTML=ICON.pause;$(id).setAttribute('aria-label','Cancel playback loading');$(id).setAttribute('aria-busy','true');});
  try {
    await ensureBuffers();
    if(request!==S.playRequest)return;
    await S.ctx.resume();
    if(request!==S.playRequest)return;
    S.starting=false;
    if (!S.master) {
      S.master = S.ctx.createGain();
      S.masterAn = S.ctx.createAnalyser();
      S.masterAn.fftSize = 1024;
      S.master.connect(S.masterAn);
      S.master.connect(S.ctx.destination);
    }
    if (S.fxReady === undefined) {
      try { await S.ctx.audioWorklet.addModule('fx-worklet.js'); S.fxReady = true; } catch { S.fxReady = false; } // the browser preview has no worklet file
      if (request !== S.playRequest) return;
    }
    if (S.fxReady && !S.limiter) {
      S.limiter = new AudioWorkletNode(S.ctx, 'contour-limiter', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
      S.master.disconnect(S.ctx.destination);
      S.master.connect(S.limiter).connect(S.ctx.destination);
      S.reverbIn = S.ctx.createGain();
      S.reverb = new AudioWorkletNode(S.ctx, 'contour-reverb', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
      S.reverbIn.connect(S.reverb).connect(S.master);
    }
    S.master.gain.value = +$('volume').value / 100;
    const [a, b] = loopBounds();
    if (S.loop && (S.pos < a || S.pos >= b)) S.pos = a;
    if (S.pos >= duration() - 0.02) S.pos = 0;
    const when = Math.max(S.ctx.currentTime + 0.012, opts.when ?? S.ctx.currentTime + 0.04);
    S.loopNext = 0;
    for (const t of S.tracks) if (t.buffer) startTrack(t, when, S.pos);
    clearInterval(S.loopTimer);
    if (S.loop) { S.loopNext = when + (loopBounds()[1] - S.pos); S.loopTimer = setInterval(loopSchedule, 200); loopSchedule(); }
    S.started = when;
    S.offset = S.pos;
    S.playing = true;
    ['play', 'simple-play', 'mash-play','global-play'].forEach(id => { $(id).innerHTML = ICON.pause; $(id).setAttribute('aria-label', 'Pause');$(id).removeAttribute('aria-busy'); });
    tick();
  } catch (e) {
    if(request!==S.playRequest)return;
    stop();
    toast('Playback failed: ' + e);
  }
}
function restart() {
  if (!S.playing) return;
  const at = S.ctx.currentTime + 0.02;
  stop(false, at);
  play({ when: at });
}
/** One play/pause for every button and Space; also cancels a start that is still loading. */
function togglePlay() { if (S.playing || S.starting) stop(); else play(); }
const scratch = new Float32Array(1024);
function level(an) {
  if (!an) return 0;
  const buf = scratch.subarray(0, an.fftSize);
  an.getFloatTimeDomainData(buf);
  let s = 0; for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
  return Math.min(1, Math.sqrt(s / buf.length) * 2.6);
}
function frame() {
  ContourPerf.frames++;
  const p = currentPos();
  ContourProduct.text('time',fmtPrecise(p)); ContourProduct.text('duration','/ '+fmt(duration()));
  const clock=`${fmt(p)} / ${fmt(duration())}`; ContourProduct.text('simple-clock',clock);ContourProduct.text('mash-clock',clock);ContourProduct.text('global-clock',clock);
  if(document.activeElement!==$('global-seek'))$('global-seek').value=duration()?Math.round(p/duration()*1000):0;
  if($('global-seek').getAttribute('aria-valuetext')!==clock)$('global-seek').setAttribute('aria-valuetext',clock);
  for (const t of S.tracks) {
    const l = S.mode==='studio' && S.playing && gainFor(t) !== 0 ? level(t.analyser) : 0;
    t.level = Math.max(l, t.level * 0.86);
    if (t.meterEl) t.meterEl.style.height = (t.level * 100).toFixed(0) + '%';
  }
  const mm = $('master-meter').getContext('2d'), ml = S.playing ? level(S.masterAn) : 0;
  mm.clearRect(0, 0, 80, 10); mm.fillStyle = 'rgba(173,205,250,.12)'; mm.fillRect(0, 4, 80, 2);
  mm.fillStyle = ml > 0.95 ? '#e0846f' : ACCENT; mm.fillRect(0, 4, 80 * ml, 2);
  if (S.mode === 'studio' && S.playing && S.zoom) {
    const start = viewStart(), span = viewSpan();
    if (p > start + span * 0.92 || p < start) { S.viewStart = p - span * 0.08; drawStudio(); }
  }
  placePlayhead();
  placeShades(p);
  if (S.mode==='simple' && duration()) $('strata-cursor').style.transform=`translateX(${Math.round(p/duration()*$('strata').clientWidth)}px)`;
}
function placeShades(p) {
  const d = duration();
  // Nothing is dimmed until playback has started; then the unplayed part recedes.
  const f = d && (S.playing || p > 0.05) ? clamp(p / d, 0, 1) : 1;
  if (S.mode === 'simple') for (const t of leaves()) { const s = t.row?.querySelector('.shade'); if (s) s.style.transform = `scaleX(${1 - f})`; }
  const shade = $('timeline-shade'), first = S.tracks.find(t => t.lane && !t.lane.classList.contains('collapsed'))?.lane.querySelector('canvas');
  if (!shade) return;
  if (S.mode !== 'studio' || !first || !d || f === 1) { shade.hidden = true; return; }
  const start=viewStart(),span=viewSpan()||1,rect=timelineRect();if(!rect)return;
  const x=clamp(((p-start)/span)*rect.width,0,rect.width);
  shade.hidden = false;
  shade.style.left=rect.left+'px';shade.style.width=rect.width+'px';shade.style.transformOrigin='right';shade.style.transform=`scaleX(${1-x/Math.max(1,rect.width)})`;
}
function tick(now=performance.now()) {
  if(!S.lastFrame || now-S.lastFrame>=1000/60-1){S.lastFrame=now;frame();}
  if(!S.playing || document.hidden)return;
  if(!S.loop && currentPos()>=duration()-.01){stop(true);return;}
  S.raf=requestAnimationFrame(tick);
}
function seekTo(t) {
  t = clamp(t, 0, duration());
  if (!S.playing) { if (S.starting) stop(); S.pos = t; frame(); return; }
  const at = S.ctx.currentTime + 0.02;
  stop(false, at);
  S.pos = t;
  frame();
  play({ when: at });
}
$('play').onclick = togglePlay;
$('stop').onclick = () => seekTo(S.loop && S.region ? S.region[0] : 0);
$('loop').onclick = () => { S.loop = !S.loop; $('loop').setAttribute('aria-pressed', String(S.loop)); restart(); drawStudio(); ContourProduct.changed(); };
$('null').onclick = () => {
  if (!S.separated) return toast('Separate the song first. The null test compares the stems with the original.');
  S.nullTest = !S.nullTest;
  $('null').setAttribute('aria-pressed', String(S.nullTest));
  applyMix();
  rescheduleCurves();
  status(S.nullTest ? 'Null test on: you hear only what the stems miss' : 'Null test off');
};
$('volume').oninput = () => { if (S.master) S.master.gain.setTargetAtTime(+$('volume').value/100,S.ctx.currentTime,.008); };

document.addEventListener('keydown', e => {
  if ($('confirm-dialog').open || $('setup').hidden === false || !$('export-options').hidden) return;
  if (S.busy && !['Space', 'ArrowLeft', 'ArrowRight'].includes(e.code)) return;
  // Only typing fields and dropdowns keep the keyboard; after clicking a button, slider or switch the
  // shortcuts still work (arrow keys stay with a focused slider).
  if (e.target.closest('input:not([type=range]):not([type=checkbox]),select,textarea,[role=listbox],[contenteditable]') || e.altKey || !$('models-modal').hidden) return;
  if (e.target.closest('input[type=range]') && /^Arrow/.test(e.key)) return;
  if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) { e.preventDefault(); saveProject(e.shiftKey); return; }
  if ((e.ctrlKey || e.metaKey) && (e.key === 'o' || e.key === 'O')) { e.preventDefault(); openProject(); return; }
  if ((e.ctrlKey || e.metaKey) && (e.key === '=' || e.key === '+')) { e.preventDefault(); setZoom(S.zoom + 1); return; }
  if ((e.ctrlKey || e.metaKey) && e.key === '-') { e.preventDefault(); setZoom(S.zoom - 1); return; }
  if (e.ctrlKey || e.metaKey) return;
  if (e.code === 'Space') { e.preventDefault(); if (!e.repeat) togglePlay(); }
  else if (e.key === '0') { playAll(); mashRowState?.(); }
  else if (/^Digit[1-9]$/.test(e.code) && e.shiftKey) { const t = S.tracks[+e.code.slice(5) - 1]; if (t) { toggleInPlaying(t); mashRowState?.(); } }
  else if (/^[1-9]$/.test(e.key)) { const t = S.tracks[+e.key - 1]; if (t) { playOnly(t); mashRowState?.(); } }
  else if (e.key === 'n' || e.key === 'N') $('null').click();
  else if (e.key === 'l' || e.key === 'L') $('loop').click();
  else if ((e.key === 'a' || e.key === 'A') && S.mode === 'studio') $('curves').click();
  else if (e.key === '?') { $('open-models').click(); }
  else if ((e.key === 'Delete' || e.key === 'Backspace') && S.sel && !e.target.closest('canvas')) { S.sel.t.env.splice(S.sel.idx, 1); const t = S.sel.t; S.sel = null; curvesChanged(t); }
  else if (e.key === 'ArrowRight') seekTo(currentPos() + 5);
  else if (e.key === 'ArrowLeft') seekTo(currentPos() - 5);
  else if (e.key === 'Escape' && S.region) { S.region = null; drawStudio(); }
});

// ───────────────────────── export ─────────────────────────
function renderExportList() {
  const box=$('export-list');
  const items=S.tracks.filter(t=>t.id!=='original');
  if(!items.length){box.innerHTML='<p class="dim">Separate a song first.</p>';return;}
  box.replaceChildren(...items.map(t=>{
    const label=document.createElement('label'),input=document.createElement('input'); input.type='checkbox';input.value=t.id;input.checked=t.exportSelected ?? t.leaf;
    input.onchange=()=>{t.exportSelected=input.checked;};label.append(input,document.createTextNode(t.label));return label;
  }));
}
function rangeArgs() {
  if (!$('range-only').checked) return [null, null];
  if (!S.region) { toast('Drag across the ruler to set a loop region first.'); return undefined; }
  return S.region;
}
async function runExport(ids, dir, format, rate, protect, range) {
  if (S.busy || S.preflighting || MASH.pending) return;
  busyStart('Exporting');
  try {
    const envelopes = {};
    if ($('apply-curves')?.checked) for (const t of S.tracks) if (t.env.length && ids.includes(t.id)) envelopes[t.id] = t.env.map(p => [p.t, p.g]);
    const files = await invoke('export', { ids, dir, format, rate, protect, start: range ? range[0] : null, end: range ? range[1] : null, envelopes, clips: allClipPayloads(ids), labels: Object.fromEntries(S.tracks.map(t => [t.id, t.label])), fx: Object.fromEntries(S.tracks.map(t => [t.id, t.fx])) });
    S.lastExport = files[0];
    $('reveal').hidden = $('simple-reveal').hidden = false;
    status(`Saved ${files.length} file${files.length > 1 ? 's' : ''}`);
  } catch (e) {
    taskFailed('Export', e, () => runExport(ids, dir, format, rate, protect, range));
  } finally {
    busyEnd();
  }
}
$('export').onclick = async () => {
  const ids = [...document.querySelectorAll('#export-list input:checked')].map(i => i.value);
  if (!ids.length) return toast('Tick at least one stem to export.');
  const range = rangeArgs();
  if (range === undefined) return;
  const dir = await chooseExportFolder();
  if (!dir) return;
  await runExport(ids, dir, $('format').value, $('rate').value ? +$('rate').value : null, $('protect').checked, range[0] == null ? null : range);
};
$('bounce').onclick = async () => {
  if (S.nullTest) return toast('Turn off the null test before bouncing a mix.');
  const parts = S.tracks.map(t => ({ id: t.id, gain: gainFor(t), pan: t.pan, envelope: $('apply-curves').checked ? t.env.map(p => [p.t, p.g]) : [], clips: clipsPayload(t), fx: t.fx })).filter(p => p.gain > 0);
  if (!parts.length) return toast('Nothing is audible. Unmute at least one lane.');
  const range = rangeArgs();
  if (range === undefined) return;
  const dir = await chooseExportFolder();
  if (!dir) return;
  busyStart('Bouncing mix');
  try {
    const file = await invoke('export_mix', {
      parts, name: 'Mix', dir, format: $('format').value, rate: $('rate').value ? +$('rate').value : null,
      protect: $('protect').checked, start: range[0], end: range[1],
    });
    S.lastExport = file;
    $('reveal').hidden = false;
    status('Mix bounced');
  } catch (e) {
    taskFailed('Bounce mix', e, () => $('bounce').click());
  } finally {
    busyEnd();
  }
};
$('reveal').onclick = () => S.lastExport && invoke('reveal', { path: S.lastExport }).catch(e => toast(String(e)));

// ───────────────────────── models ─────────────────────────
async function renderModels() {
  const list = await invoke('models_list');
  const box = $('models-table');
  box.innerHTML = '';
  for (const m of list) {
    const row = document.createElement('div');
    row.className = 'model-row';
    row.innerHTML = `<span class="${m.present ? 'ok' : ''}">${m.present ? '●' : '○'}</span><span>${m.label}<br><small>${m.id}</small></span><small>${m.role}</small><small>${mb(m.size)}</small>`;
    const b = document.createElement('button');
    b.textContent = m.present ? 'Delete' : 'Download';
    b.disabled = S.busy || S.preflighting || MASH.pending;
    b.onclick = async () => {
      if (S.busy || S.preflighting || MASH.pending) return;
      if (m.present) { try { await invoke('models_delete', { id: m.id }); } catch (e) { toast(String(e)); } }
      else await downloadModels([m.id]);
      renderModels(); refreshNeeds();
    };
    row.append(b);
    box.append(row);
    ContourMotion.enter(row, Math.min(box.children.length - 1, 4) * 15);
  }
  const missing = list.filter(m => !m.present);
  $('models-total').textContent = missing.length ? `${missing.length} not downloaded, ${mb(missing.reduce((a, m) => a + m.size, 0))} in total` : 'Every model is on this computer.';
  $('download-all').hidden = !missing.length;
  $('download-all').onclick = async () => { await downloadModels(missing.map(m => m.id)); renderModels(); refreshNeeds(); };
}
async function downloadModels(ids) {
  if (S.busy || S.preflighting || MASH.pending) return;
  busyStart('Downloading models');
  try { await invoke('models_download', { ids }); status('Models ready'); }
  catch (e) { taskFailed('Model download', e, () => downloadModels(ids)); }
  finally { busyEnd(); }
}
$('open-models').onclick = () => { ContourMotion.show($('models-modal'), true); renderModels(); $('close-models').focus(); };
function closeModels() { ContourMotion.show($('models-modal'), false); $('open-models').focus(); }
$('close-models').onclick = closeModels;
$('models-modal').onclick = e => { if (e.target === $('models-modal')) closeModels(); };
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('models-modal').hidden) closeModels(); });

// ───────────────────────── projects ─────────────────────────
// Save: the song, every stem (lossless), the mixer, curves, loop and view. Reopen: instantly,
// without separating again.
function projectState() {
  return {
    version: 2, sessionKind: S.kind === 'rendered-mashup' ? 'mashup' : S.kind, mashup: S.kind === 'mashup' ? { settings: { ...(MASH.result?.settings || MASH.settings) }, a: MASH.result?.a, b: MASH.result?.b, plan: MASH.result?.plan, rendered: true } : S.mashProvenance || null, exportOptions:{format:$('format').value,rate:$('rate').value,protect:$('protect').checked,applyCurves:$('apply-curves').checked,rangeOnly:$('range-only').checked}, mode: S.kind === 'mashup' ? 'studio' : S.mode, goal: S.goal, quality: S.quality, instruments: S.instruments,
    lead: $('lead-backing').checked, dereverb: $('dereverb').checked,
    tracks: S.tracks.map(t => ({ id: t.id, label: t.label, kind: t.kind, leaf: t.leaf, mute: t.mute, solo: t.solo, vol: t.vol, pan: t.pan, env: t.env.map(p => [p.t, p.g]), clips: clipsEdited(t) ? t.clips.map(c => ({ ...c })) : null, height: t.height || null, fx: { ...t.fx }, exportSelected:t.exportSelected ?? t.leaf })), xfade: S.xfade, lyrics: (typeof LY !== 'undefined' && LY.data) ? { language: LY.data.language, lines: LY.data.lines } : null,
    region: S.region, loop: S.loop, zoom: S.zoom, viewStart: S.viewStart, collapsed: [...S.collapsed], separated: S.separated,
  };
}
async function saveProject(saveAs = false) {
  if (!S.source) return toast('Import a song first, then save it as a project.');
  if (S.busy || S.preflighting || MASH.pending) return toast('Wait for the current task to finish.');
  let path = saveAs ? null : S.projectPath;
  if (!path) {
    path = await invoke('pick_project_save', { name: (S.source.name || 'Song').replace(/\.[^.]+$/, '') });
    if (!path) return;
  }
  busyStart('Saving project');
  try {
    S.projectPath = await invoke('save_project', { path, ui: projectState() });
    S.savedMix = MASH.stale ? '' : mixFingerprint();
    ContourProduct.saved();
    status(`Saved ${S.projectPath.split(/[\\/]/).pop()}`);
  } catch (e) {
    taskFailed('Save project', e, () => saveProject(saveAs));
  } finally {
    busyEnd();
  }
}
async function openProject(path) {
  if (S.busy || S.preflighting) return toast('Wait for the current task to finish.');
  path = path || (await invoke('pick_project_open'));
  if (!path) return;
  if(!await ContourProduct.canReplace('open another project'))return;
  const resume = S.playing; stop();
  busyStart('Opening project');
  try {
    const res = await invoke('open_project', { path });
    resetSessionView('song'); clearMashDraft();
    const ui = res.ui || {}, meta = new Map((ui.tracks || []).map(t => [t.id, t]));
    S.source = res.source;
    S.projectPath = path;
    const original = makeTrack({ id: 'original', label: 'Original', kind: 'mix', leaf: true, peaks: res.source.peaks });
    S.tracks = [original, ...res.stems.map(s => { const m = meta.get(s.id) || {}; return makeTrack({ ...s, kind: m.kind || 'stem', leaf: m.leaf ?? true }); })];
    for (const t of S.tracks) {
      const m = meta.get(t.id);
      if (!m) continue;
      Object.assign(t, { mute: !!m.mute, solo: !!m.solo, vol: m.vol ?? 1, pan: m.pan ?? 0, env: (m.env || []).map(([tt, g]) => ({ t: tt, g })), clips: m.clips ? m.clips.map(c => ({ ...c })) : null, exportSelected:m.exportSelected, height: m.height || null, ...(m.fx ? { fx: { ...t.fx, ...m.fx } } : {}), ...(m.label && t.id !== 'original' ? { label: m.label } : {}) });
    }
    if (Array.isArray(ui.tracks)) { const at = new Map(ui.tracks.map((x, i) => [x.id, i])); S.tracks.sort((x, y) => (at.get(x.id) ?? 1e9) - (at.get(y.id) ?? 1e9)); }
    S.xfade = typeof ui.xfade === 'number' ? ui.xfade : 30;
    if (typeof LY !== 'undefined') { LY.data = ui.lyrics ? { ...ui.lyrics, for: res.source.path } : null; }
    S.separated = res.stems.length > 0;
    S.region = ui.region || null; S.loop = !!ui.loop; S.zoom = ui.zoom || 0; S.viewStart = ui.viewStart || 0;
    S.collapsed = new Set(ui.collapsed || []);
    $('loop').setAttribute('aria-pressed', String(S.loop));
    if (ui.goal) { S.goal = ui.goal; setRadio('.tiles', 'goal', S.goal); }
    if (ui.quality) { S.quality = ui.quality; setRadio('#quality-seg', 'quality', S.quality); }
    if (ui.instruments) { S.instruments = ui.instruments; setRadio('#stems-seg', 'stems', S.instruments); }
    $('now-name').textContent = res.source.name;
    $('now-name').title = path;
    $('now-meta').textContent = `${fmt(res.source.duration)}   ${(res.source.rate / 1000).toFixed(1)} kHz   project`;
    $('drop').classList.add('loaded');
    S.reveal = performance.now() - 2000; // already separated: show the stem colours straight away
    showSimpleResults(S.separated);
    renderAll();
    if (ui.sessionKind === 'mashup' || ui.mode === 'mashup') {
      S.kind = 'rendered-mashup'; setMode('studio');
      toast('Opened the saved mashup audio and mixer in Studio. To change song matching, create a new mashup from the source songs.');
    } else if (ui.mode && ui.mode !== S.mode) setMode(ui.mode);
    $('lead-backing').checked = !!ui.lead; $('dereverb').checked = !!ui.dereverb;
    S.mashProvenance=ui.mashup||null;
    const output=ui.exportOptions;if(output){if([...$('format').options].some(o=>o.value===output.format))$('format').value=output.format;if([...$('rate').options].some(o=>o.value===output.rate))$('rate').value=output.rate;$('protect').checked=output.protect!==false;$('apply-curves').checked=output.applyCurves!==false;$('range-only').checked=!!output.rangeOnly;}
    window.syncGlassSelects?.();
    S.savedMix = mixFingerprint(); ContourProduct.session(true,true);
    preloadTracks();
    status(`Opened ${path.split(/[\\/]/).pop()}`);
  } catch (e) {
    taskFailed('Open project', e, () => openProject(path));
    if (resume) play();
  } finally {
    busyEnd();
    refreshNeeds();
  }
}
$('save-project').onclick = () => saveProject(false);
$('open-project').onclick = () => openProject();
$('simple-save-project').onclick = () => saveProject(false);

// ───────────────────────── settings ─────────────────────────
function exportDir() { return prefs.askExport === false && prefs.exportDir ? prefs.exportDir : null; }
async function chooseExportFolder(forceDialog) {
  if (S.busy || S.preflighting || MASH.pending) return null;
  const fixed = exportDir();
  if (fixed && !forceDialog) return fixed;
  const dir = await invoke('pick_folder', { start: prefs.exportDir || null });
  if (dir) { prefs.exportDir = dir; savePrefs(); renderSettings(); }
  return dir;
}
async function renderSettings() {
  $('setting-export-dir').textContent = prefs.exportDir || 'Not chosen yet';
  $('setting-ask').checked = prefs.askExport !== false;
  try {
    const [dir, bytes] = await invoke('models_storage');
    $('setting-storage').textContent = `${mb(bytes)} in ${dir}`;
    S.modelsDir = dir;
  } catch { $('setting-storage').textContent = ''; }
}
$('setting-change-dir').onclick = async () => { const d = await invoke('pick_folder', { start: prefs.exportDir || null }); if (d) { prefs.exportDir = d; savePrefs(); renderSettings(); } };
$('setting-ask').onchange = () => { prefs.askExport = $('setting-ask').checked; savePrefs(); };
$('setting-show-models').onclick = () => S.modelsDir && invoke('reveal', { path: S.modelsDir }).catch(e => toast(String(e)));

// ───────────────────────── keyboard access ─────────────────────────
// Focus stays inside an open dialog; Tab and Shift+Tab cycle through its controls.
document.addEventListener('keydown', e => {
  if (e.key !== 'Tab') return;
  const dlg = ['setup', 'export-options', 'models-modal'].map($).find(d => d && !d.hidden);
  if (!dlg) return;
  const items = [...dlg.querySelectorAll('button, [href], input, select, [tabindex]:not([tabindex="-1"])')].filter(el => !el.disabled && el.offsetParent !== null);
  if (!items.length) return;
  const first = items[0], last = items[items.length - 1];
  if (!dlg.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
  else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
});
// Simple-mode tiles behave as one radio group: arrow keys move the choice.
document.querySelector('.tiles')?.addEventListener('keydown', e => {
  const tiles = [...document.querySelectorAll('.tile')], i = tiles.indexOf(document.activeElement);
  if (i < 0) return;
  const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
  if (!d) return;
  e.preventDefault();
  const next = tiles[(i + d + tiles.length) % tiles.length];
  next.click(); next.focus();
});
function syncTileFocus() { document.querySelectorAll('.tile').forEach(t => (t.tabIndex = t.getAttribute('aria-checked') === 'true' ? 0 : -1)); }
new MutationObserver(syncTileFocus).observe(document.querySelector('.tiles'), { subtree: true, attributes: true, attributeFilter: ['aria-checked'] });
syncTileFocus();
$('open-models').addEventListener('click', renderSettings);

// ───────────────────────── Mashup Lab ─────────────────────────
// Vocals from song A over the music of song B, in time and in key. Both songs are separated once;
// every adjustment afterwards only re-renders the vocal (seconds), and the result plays through the
// normal mixer: so Studio, curves, export and projects all work on a mashup.
const MASH = {
  a: null, b: null, result: null, timer: 0, rendering: false, again: false,
  revision: 0, stale: false, pending: false,
  settings: ContourWorkflow.defaultMashSettings(),
};
function mashDrawWave(slotEl, peaks, color) {
  const c = slotEl.querySelector('.mash-wave'), r = c.getBoundingClientRect(), dpr = Math.min(2, devicePixelRatio || 1);
  if (!r.width) return;
  c.width = Math.round(r.width * dpr); c.height = Math.round(r.height * dpr);
  const g = c.getContext('2d'); g.scale(dpr, dpr);
  if (!peaks) return;
  const W = r.width, H = r.height, cols = Math.floor(W / 2);
  g.fillStyle = color; g.globalAlpha = 0.75;
  for (let i = 0; i < cols; i++) {
    const a = Math.floor((i * peaks.length) / cols), b = Math.max(a + 1, Math.floor(((i + 1) * peaks.length) / cols));
    let v = 0; for (let j = a; j < b; j++) v = Math.max(v, peaks[j]);
    const h = Math.max(0.6, v * H * 0.45);
    g.fillRect(i * 2, H / 2 - h, 1.4, 2 * h);
  }
}
function mashShowSlot(slot, info) {
  MASH[slot] = info;
  const el = $(`slot-${slot}`);
  el.classList.toggle('filled', !!info);
  el.querySelector('.mash-name').textContent = info ? info.name : 'Choose a song';
  el.querySelector('.mash-name').title = info ? info.name : '';
  el.querySelector('.mash-meta').textContent = info ? `${Math.round(info.bpm)} BPM · ${info.key} · ${fmt(info.duration)}` : '';
  el.querySelector('.mash-pick').textContent = info ? 'Change…' : 'Choose…';
  requestAnimationFrame(() => mashDrawWave(el, info?.peaks, slot === 'a' ? COLORS.vocals : COLORS.instrumental));
  mashReady();
}
function mashReady() {
  const ok = MASH.a && MASH.b;
  $('mash-run').disabled = !ok || S.busy || S.preflighting;
  $('mash-run').textContent = MASH.result ? 'Rebuild mashup' : 'Make mashup';
  $('mash-go').hidden = !!MASH.result && !MASH.stale;
  if (!S.busy && !S.preflighting) $('mash-note').textContent = MASH.stale ? 'Settings changed. Rebuild to update.' : '';
}
function syncMashControls() {
  const v = MASH.settings;
  $('mash-nudge').value = v.nudge_ms; $('mash-nudge-v').textContent = `${v.nudge_ms} ms`;
  $('mash-gain').value = v.vocal_gain_db; $('mash-gain-v').textContent = `${v.vocal_gain_db} dB`;
  $('mash-lock').checked = v.lock_beats;
  setRadio('#mash-tempo', 'tempo', v.tempo);
  $('mash-key').textContent = v.semitones == null ? 'auto' : String(v.semitones);
  $('mash-entry').textContent = '0:00';
}
function drawMashWaves() {
  if (S.mode !== 'mashup') return;
  ['a', 'b'].forEach(slot => mashDrawWave($(`slot-${slot}`), MASH[slot]?.peaks, slot === 'a' ? COLORS.vocals : COLORS.instrumental));
  for (const t of S.tracks) if (t.mrow?.isConnected) drawWave(t.mrow.querySelector('canvas'), t, 0, duration() || 1, 0.85, true);
}
function renderMash() {
  $('mash-result').hidden = !(S.kind === 'mashup' && MASH.result);
  if (S.kind === 'mashup' && MASH.result) { mashRows(); mashSummary(MASH.result.plan); }
  $('mash-stale').hidden = !MASH.stale;
  mashReady(); requestAnimationFrame(drawMashWaves);
}
async function mashLoad(slot, path, reserved = false) {
  if (!path || S.busy || (S.preflighting && !reserved)) return false;
  busyStart(`Reading the ${slot === 'a' ? 'vocals' : 'music'} song`, { cancellable: false });
  try {
    const info = await invoke('mashup_load', { slot, path });
    invalidateMash(); mashShowSlot(slot, info);
    status(`${slot === 'a' ? 'Vocals' : 'Music'} song ready`);
    return true;
  } catch (e) { taskFailed('Import song', e, () => mashLoad(slot, path)); return false; }
  finally { busyEnd(); }
}
document.querySelectorAll('.mash-slot').forEach(el => {
  el.querySelector('.mash-pick').onclick = async () => {
    if (S.busy || S.preflighting) return;
    try { await mashLoad(el.dataset.slot, await invoke('pick_audio')); } catch (e) { toast(String(e)); }
  };
});
$('mash-swap').onclick = async () => {
  if (S.busy || S.preflighting) return;
  busyStart('Swapping songs', { cancellable: false });
  try { const [a, b] = await invoke('mashup_swap'); invalidateMash(); mashShowSlot('a', a); mashShowSlot('b', b); }
  catch (e) { taskFailed('Swap songs', e, () => $('mash-swap').click()); }
  finally { busyEnd(); }
};
async function mashDrop(paths, position) {
  if (S.busy || S.preflighting) return;
  let slot = null;
  if (position) {
    const el = document.elementFromPoint(position.x / (devicePixelRatio || 1), position.y / (devicePixelRatio || 1));
    slot = el?.closest?.('.mash-slot')?.dataset.slot || null;
  }
  if (!slot) slot = !MASH.a ? 'a' : !MASH.b ? 'b' : 'a';
  // Reserve the entire drop, including the gap between the two awaited imports.
  S.preflighting = true; availability();
  try {
    const loaded = await mashLoad(slot, paths[0], true);
    if (loaded && paths[1]) await mashLoad(slot === 'a' ? 'b' : 'a', paths[1], true);
  } finally { S.preflighting = false; availability(); refreshNeeds(); }
}
['mash-split', 'mash-flagship'].forEach(id => $(id).onchange = () => { invalidateMash(); availability(); refreshNeeds(); });

function mashSummary(p) {
  const pct = p.stretch_percent, sign = pct >= 0 ? '+' : '−';
  const semis = p.semitones === 0 ? 'no shift' : `${p.semitones > 0 ? '+' : '−'}${Math.abs(p.semitones)} semitone${Math.abs(p.semitones) === 1 ? '' : 's'}`;
  const feel = p.tempo_factor === 2 ? ' · double-time' : p.tempo_factor === 0.5 ? ' · half-time' : '';
  $('mash-summary').innerHTML = [
    `Tempo <b>${Math.round(p.vocal_bpm)} → ${Math.round(p.music_bpm)} BPM</b> (${sign}${Math.abs(pct).toFixed(1)}%${feel})`,
    `Key <b>${p.vocal_key} → ${p.shifted_key}</b> (${semis}) · ${p.fit} with ${p.music_key}`,
    p.locked_beats ? `<b>${p.locked_beats}</b> beats locked` : 'Constant tempo',
  ].map(t => `<span class="mash-chip">${t}</span>`).join('');
  $('mash-key').textContent = MASH.settings.semitones == null ? `auto (${p.auto_semitones > 0 ? '+' : ''}${p.auto_semitones})` : `${p.semitones > 0 ? '+' : ''}${p.semitones}`;
  $('mash-entry').textContent = fmtPrecise(p.entry);
}
function mashRows() {
  const box = $('mash-rows');
  box.innerHTML = '';
  for (const t of S.tracks.filter(x => x.id !== 'original')) {
    const row = document.createElement('div');
    row.className = 'result';
    row.style.setProperty('--c', t.color);
    row.style.setProperty('--i', box.children.length);
    row.innerHTML = `<canvas></canvas><i class="shade" aria-hidden="true"></i><strong>${escapeHtml(t.label)}</strong><input class="lane-level" type="range" min="0" max="150" value="${Math.round(t.vol * 100)}" aria-label="${escapeHtml(t.label)} level"><button class="listen" aria-pressed="true" aria-label="Include ${escapeHtml(t.label)}">On</button>`;
    row.querySelector('.listen').onclick = () => { toggleRow(t); mashRowState(); };
    const lvl = row.querySelector('.lane-level');
    lvl.oninput = () => { t.vol = +lvl.value / 100; applyMix(); };
    lvl.onchange = () => ContourProduct.changed?.();
    row.querySelector('canvas').onclick = e => { const r = e.currentTarget.getBoundingClientRect(); seekTo(((e.clientX - r.left) / r.width) * duration()); };
    t.mrow = row;
    box.append(row);
    requestAnimationFrame(() => drawWave(row.querySelector('canvas'), t, 0, duration() || 1, 0.85, true));
  }
  mashRowState();
}
function mashRowState() {
  for (const t of S.tracks) if (t.mrow) {
    t.mrow.classList.toggle('off', t.mute);
    const b = t.mrow.querySelector('.listen');
    b.setAttribute('aria-pressed', String(!t.mute)); b.textContent = t.mute ? 'Off' : 'On';
  }
}
/** Install a rendered mashup into the player, keeping the listener's mutes, levels and position. */
async function mashApply(res,initial=false) {
  const session=S.session,revision=MASH.revision,prev=new Map(S.tracks.map(t=>[t.id,t]));
  const next=[makeTrack({id:'original',label:'Full mashup',kind:'mix',leaf:true,peaks:res.source.peaks}),...res.stems.map(makeTrack)];
  next[0].mute=true;
  for(let i=0;i<next.length;i++) {
    const t=next[i],old=prev.get(t.id);
    if(old && MASH.keepMix)Object.assign(t,{mute:old.mute,solo:old.solo,vol:old.vol,pan:old.pan,env:old.env,exportSelected:old.exportSelected});
    // A's vocal and A's music are re-fitted on every render; B's lanes are unchanged and kept as they are
    if(!initial && old && t.id!=='vocals' && t.id!=='music_a' && t.id!=='original'){Object.assign(old,{label:t.label,peaks:t.peaks});next[i]=old;}
    // a new mashup starts as the classic mix: A's vocal over B's music: with the other two lanes ready
    if(initial && !(old && MASH.keepMix) && (t.id==='music_a' || t.id==='vocals_b'))t.mute=true;
  }
  const vocal=next.find(t=>t.id==='vocals');
  if(initial && vocal)vocal.vol=Math.pow(10,MASH.settings.vocal_gain_db/20);
  // Prepare only the changed vocal before touching the audible graph. Music buffers/nodes survive.
  if(!initial && vocal && gainFor(vocal)!==0)vocal.buffer=await fetchBuffer(vocal,()=>session===S.session && revision===MASH.revision);
  if(session!==S.session || revision!==MASH.revision){MASH.again=true;return;}
  const wasPlaying=S.playing,pos=initial?0:currentPos();
  const hot=wasPlaying && !initial && !S.nullTest;
  if(!hot)stop();
  else {
    const old=prev.get('vocals'),when=S.ctx.currentTime+.025;
    if(old?.gain){old.gain.gain.cancelScheduledValues(S.ctx.currentTime);old.gain.gain.setTargetAtTime(0,S.ctx.currentTime,.008);}
    const source=old?.sourceNode;
    setTimeout(()=>{try{source?.stop();source?.disconnect();}catch{}old?.gain?.disconnect();old?.panner?.disconnect();old?.envNode?.disconnect();S.nodes=S.nodes.filter(n=>n!==source);},55);
    if(vocal?.buffer){startTrack(vocal,when,pos+.025);vocal.gain.gain.setValueAtTime(0,when);vocal.gain.gain.linearRampToValueAtTime(gainFor(vocal),when+.02);}
  }
  if(initial)resetSessionView('mashup');
  S.source=res.source;S.kind='mashup';S.tracks=next;S.separated=true;S.reveal=performance.now()-2000;
  MASH.result={...res,settings:{...MASH.settings}};MASH.stale=false;MASH.keepMix=true;
  $('now-name').textContent=res.source.name;$('now-meta').textContent=`${fmt(res.source.duration)}   mashup`;
  mashShowSlot('a',res.a);mashShowSlot('b',res.b);mashSummary(res.plan);
  renderAll();if(res.backend)setBackend(res.backend,res.notes||[]);S.pos=Math.min(pos,duration());
  if(wasPlaying && !hot)play();else preloadTracks();frame();
}
async function mashBuild() {
  if (!MASH.a || !MASH.b || S.busy || S.preflighting) return;
  if(S.kind!=='mashup' && !await ContourProduct.canReplace('replace the current session with a mashup'))return;
  const snapshot = workflowSnapshot('mashup');
  if (!await preflight(snapshot)) return;
  $('mash-progress').hidden = false;
  clearTimeout(MASH.timer); MASH.again = false; MASH.pending = false;
  busyStart('Separating songs', { cancellable: true });
  MASH.keepMix = false;
  try {
    const res = await invoke('mashup_build', { quality: snapshot.request.quality, split: snapshot.split, device: snapshot.device, settings: {...snapshot.settings,vocal_gain_db:0} });
    if (snapshot.session !== S.session || snapshot.mashRevision !== MASH.revision) return;
    await mashApply(res, true); ContourProduct.result();
    if (res.notes?.length) toast(`Running on ${res.backend}. ${res.notes.join(' ')}`);
    status('Mashup ready');
  } catch (e) { taskFailed('Mashup', e, mashBuild); }
  finally { $('mash-progress').hidden = true; busyEnd(); }
}
$('mash-run').onclick = mashBuild;
// Serialize revisions. Inputs remain responsive, but session mutations wait for each render.
function mashSchedule(delay = 220) {
  clearTimeout(MASH.timer);
  MASH.timer = setTimeout(async () => {
    if (!MASH.result || MASH.stale || S.kind !== 'mashup') { MASH.pending = false; availability(); return; }
    if (MASH.rendering || S.busy || S.preflighting) { MASH.again = true; return; }
    const session = S.session, revision = MASH.revision, settings = { ...MASH.settings };
    MASH.rendering = true;
    busyStart('Updating preview', { cancellable: false });
    // Allow adjustment controls during a render; importing, building, and exporting stay locked.
    document.querySelectorAll('.mash-controls button, .mash-controls input').forEach(el => (el.disabled = false));
    try {
      const res = await invoke('mashup_render', { settings:{...settings,vocal_gain_db:0} });
      if (session === S.session && revision === MASH.revision && S.kind === 'mashup' && !MASH.stale) { MASH.pending = false; await mashApply(res); ContourProduct.audioChanged(); status('Mashup updated'); }
      else MASH.again = true;
    } catch (e) {
      MASH.pending = false;
      if (revision === MASH.revision && MASH.result?.settings) { MASH.settings = { ...MASH.result.settings }; syncMashControls(); mashSummary(MASH.result.plan); }
      else if (revision !== MASH.revision) MASH.again = true;
      taskFailed('Update mashup', e, () => { Object.assign(MASH.settings, settings); MASH.pending = true; mashSchedule(0); });
    }
    finally { MASH.rendering = false; if (MASH.again) MASH.pending = true; busyEnd(); }
  }, delay);
}
const mashSet = patch => {
  if (!MASH.result || MASH.stale || S.kind !== 'mashup' || (S.busy && !MASH.rendering)) return;
  Object.assign(MASH.settings, patch); MASH.revision++; MASH.pending = true; availability();
  // immediate feedback; the render catches up a moment later
  if ('semitones' in patch) $('mash-key').textContent = patch.semitones == null ? 'auto' : `${patch.semitones > 0 ? '+' : ''}${patch.semitones}`;
  ContourProduct.changed();mashSchedule();
};
$('mash-key-down').onclick = () => mashSet({ semitones: (MASH.settings.semitones ?? MASH.result?.plan.auto_semitones ?? 0) - 1 });
$('mash-key-up').onclick = () => mashSet({ semitones: (MASH.settings.semitones ?? MASH.result?.plan.auto_semitones ?? 0) + 1 });
$('mash-key-auto').onclick = () => mashSet({ semitones: null });
document.querySelectorAll('#mash-result [data-move]').forEach(b => (b.onclick = () => {
  const d = +b.dataset.move, total = MASH.settings.bar_offset * 4 + MASH.settings.beat_offset + d;
  mashSet({ bar_offset: Math.trunc(total / 4), beat_offset: total % 4 });
}));
$('mash-nudge').oninput = e => { $('mash-nudge-v').textContent = `${+e.target.value > 0 ? '+' : ''}${e.target.value} ms`; mashSet({ nudge_ms: +e.target.value }); };
$('mash-gain').oninput=e=>{const t=track('vocals');if(!t)return;MASH.settings.vocal_gain_db=Number(e.target.value);t.vol=Math.pow(10,MASH.settings.vocal_gain_db/20);applyMix();const v=t.lane?.querySelector('.vol');if(v){v.value=t.vol*100;v.style.setProperty('--p',t.vol/4*100+'%');}};
$('mash-lock').onchange = e => mashSet({ lock_beats: e.target.checked });
document.querySelectorAll('#mash-tempo [data-tempo]').forEach(b => b.addEventListener('click', () => { setRadio('#mash-tempo', 'tempo', b.dataset.tempo); mashSet({ tempo: b.dataset.tempo }); }));
$('mash-play').onclick = togglePlay;
$('mash-studio').onclick = () => setMode('studio');
$('mash-again').onclick = async () => {
  if (S.busy || S.preflighting) return;
  S.preflighting = true; availability();
  try {
    if (S.source && S.savedMix !== mixFingerprint() && !await confirmAction('Start a new mashup?', 'The current audio and unsaved mixer edits will be cleared. Save your project first if you want to keep them.', 'Start new')) return;
    // Freeze player access while the native session is being reset.
    stop();
    await invoke('clear_audio');
    resetSessionView('song'); clearMashDraft(); S.source = null; S.tracks = []; S.separated = false; S.savedMix = '';
    $('drop').classList.remove('loaded'); $('now-name').textContent = 'No song loaded'; $('now-meta').textContent = '';
    renderAll(); frame(); ContourProduct.session(); status('Ready');
  } catch (e) { toast('Could not reset: ' + e); }
  finally { S.preflighting = false; availability(); refreshNeeds(); }
};
$('mash-save-project').onclick = () => saveProject(false);
$('mash-save').onclick = async () => {
  if (S.busy || S.preflighting || MASH.pending || S.kind !== 'mashup') return;
  const parts = S.tracks.map(t => ({ id: t.id, gain: gainFor(t), pan: t.pan, envelope: $('apply-curves').checked ? t.env.map(p => [p.t, p.g]) : [], clips: clipsPayload(t) })).filter(p => p.gain > 0);
  if (!parts.length) return toast('Switch on at least one part.');
  if(!ContourProduct.exportSettings())return;
  const dir = await chooseExportFolder();
  if (!dir) return;
  busyStart('Saving mashup');
  try {
    parts.forEach(p => (p.fx = track(p.id)?.fx));
    S.lastExport = await invoke('export_mix', { parts, name: 'Mashup', dir, ...ContourProduct.exportSettings() });
    status('Mashup saved');
    toast(`Saved to ${S.lastExport}`);
  } catch (e) { taskFailed('Save mashup', e, () => $('mash-save').click()); } finally { busyEnd(); }
};
$('mash-stems').onclick = async () => {
  if (S.busy || S.preflighting || MASH.pending || S.kind !== 'mashup') return;
  const ids = S.tracks.filter(t => t.id !== 'original' && !t.mute).map(t => t.id);
  if (!ids.length) return toast('Switch on at least one part.');
  const dir = await chooseExportFolder();
  const o=ContourProduct.exportSettings(); if(dir && o)await runExport(ids,dir,o.format,o.rate,o.protect,o.start==null?null:[o.start,o.end]);
};
// keep the mashup clock and play button in step with the shared player
// All transport clocks share frame(). No idle polling timer.

// ───────────────────────── start ─────────────────────────
ContourProduct.init();
(async () => {
  const info = await invoke('app_info');
  S.devices = info.devices;
  const names = { auto: 'Automatic', cpu: `CPU, ${info.threads} threads`, cuda: 'NVIDIA CUDA', directml: 'DirectML (any GPU)', coreml: 'Apple CoreML' };
  $('device').innerHTML = info.devices.map(d => `<option value="${d}">${names[d] || d}</option>`).join('');
  $('models-dir').textContent = info.models_dir;
  S.quality = prefs.quality || 'balanced';
  S.instruments = prefs.instruments || 'none';
  S.goal = prefs.goal || 'karaoke';
  setRadio('#quality-seg', 'quality', S.quality);
  setRadio('#stems-seg', 'stems', S.instruments);
  setRadio('.tiles', 'goal', S.goal);
  $('lead-backing').checked = !!prefs.lead;
  $('simple-flagship').checked = !!prefs.flagship;
  $('dereverb').checked = !!prefs.dereverb;
  if (prefs.device && info.devices.includes(prefs.device)) $('device').value = prefs.device;
  if (prefs.format) $('format').value = prefs.format;
  if (prefs.rate !== undefined) $('rate').value = prefs.rate;
  if (prefs.protect !== undefined) $('protect').checked = prefs.protect;
  setMode(prefs.mode || 'simple');
  setBackend('');
  settingsChanged();
  window.syncGlassSelects?.();
  renderAll();
  frame(); ContourProduct.startup();
  // First-run setup: from the installer (--setup), or when core models are missing.
  let skipped = false;
  try { skipped = localStorage.getItem('contour.setupSkipped') === '1'; } catch { /* storage unavailable */ }
  if (info.setup_mode) openSetup({ installer: true });
  else if (!window.__CONTOUR_PREVIEW__ && !skipped) openSetup();
  if (info.launch_file && /\.contour$/i.test(info.launch_file)) await openProject(info.launch_file);
  else if (info.launch_file) {
    await loadPath(info.launch_file);
    if (info.autorun && S.source) (S.mode === 'simple' ? $('simple-run') : $('studio-run')).click();
  }
})();

// Real OS glass: when the native layer reports Mica, Acrylic or vibrancy, let it show through.
window.__TAURI__?.core.invoke('window_glass').then(kind => {
  if (!kind) return;
  document.documentElement.classList.add('os-glass');
  document.documentElement.dataset.glass = kind;
}).catch(() => { /* browser preview or older backend: keep the painted background */ });

// Space never also "clicks" the focused button or switch (that would toggle a stem or replay).
document.addEventListener('keyup', e => {
  if (e.code === 'Space' && e.target.closest?.('button,input[type=checkbox]') && !e.target.closest('dialog,.modal')) e.preventDefault();
}, true);
