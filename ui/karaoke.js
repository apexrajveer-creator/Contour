// Contour · Sing: karaoke over any song: the original singer's melody as a scrolling note lane,
// your live pitch drawn against it, a score, and your take recorded in time with the song.
'use strict';

const K = {
  active: false, listen: false, singing: false, melody: null, fps: 100, key: '', notes: [], low: 48, high: 72,
  stream: null, source: null, analyser: null, proc: null, sink: null, buf: null,
  rec: [], recStart: 0, latency: 0, trail: [], stats: null, raf: 0, finished: false, takeReady: false,
};

// ───────────────────────── pitch (YIN) ─────────────────────────
/** Fundamental frequency of a mono frame (0 = no clear pitch). Decimates by 2 for speed. */
function yinPitch(x, sr) {
  const n = Math.floor(x.length / 2), d = new Float32Array(n);
  for (let i = 0; i < n; i++) d[i] = 0.5 * (x[2 * i] + x[2 * i + 1]);
  const fs = sr / 2, win = Math.min(n >> 1, Math.round(fs * 0.025)), tmin = Math.floor(fs / 1000), tmax = Math.min(n - win - 2, Math.ceil(fs / 70));
  let e = 0;
  for (let i = 0; i < win; i++) e += d[i] * d[i];
  if (Math.sqrt(e / win) < 0.01) return 0; // too quiet to be singing
  const cm = new Float32Array(tmax + 2);
  let run = 0;
  cm[0] = 1;
  for (let tau = 1; tau <= tmax + 1; tau++) {
    let s = 0;
    for (let j = 0; j < win; j++) { const v = d[j] - d[j + tau]; s += v * v; }
    run += s;
    cm[tau] = run > 0 ? (s * tau) / run : 1;
  }
  for (let tau = Math.max(2, tmin); tau <= tmax; tau++) {
    if (cm[tau] < 0.15) {
      while (tau < tmax && cm[tau + 1] < cm[tau]) tau++;
      if (cm[tau] > 0.3) return 0;
      const a = cm[tau - 1], b = cm[tau], c = cm[tau + 1], den = a - 2 * b + c;
      const shift = Math.abs(den) > 1e-9 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den)) : 0;
      return fs / (tau + shift);
    }
  }
  return 0;
}
const midiOf = hz => 69 + 12 * Math.log2(hz / 440);
const NOTE = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
/** Cents from b to a, ignoring octaves (people sing the melody in their own octave). */
const centsFolded = (a, b) => { const c = 1200 * Math.log2(a / b); return ((((c + 600) % 1200) + 1200) % 1200) - 600; };

// ───────────────────────── melody → notes ─────────────────────────
function buildNotes(hz, fps) {
  const notes = [];
  let cur = null;
  for (let i = 0; i < hz.length; i++) {
    const m = hz[i] > 0 ? midiOf(hz[i]) : null;
    if (m != null && cur && Math.abs(m - cur.mid) < 0.75) { cur.end = (i + 1) / fps; cur.sum += m; cur.n++; cur.mid = cur.sum / cur.n; continue; }
    if (cur && cur.end - cur.start >= 0.08) notes.push(cur);
    cur = m != null ? { start: i / fps, end: (i + 1) / fps, sum: m, n: 1, mid: m, hit: 0, total: 0, done: false } : null;
  }
  if (cur && cur.end - cur.start >= 0.08) notes.push(cur);
  for (const n of notes) n.midi = Math.round(n.mid);
  return notes;
}
function refAt(t) {
  if (!K.melody) return 0;
  const i = Math.round(t * K.fps);
  // best voiced reference within ±60 ms (a little slack for timing)
  for (const d of [0, -1, 1, -2, 2, -3, 3, -4, 4, -5, 5, -6, 6]) { const v = K.melody[i + d]; if (v > 0) return v; }
  return 0;
}

// ───────────────────────── mixing during Sing ─────────────────────────
const isVocal = t => /^(vocals|lead|backing)/.test(t.id) || t.kind === 'vocal';
/** Gains while singing (or listening back): music on, the original voice as a quiet guide. */
function karaokeGain(t) {
  if (t.id === 'original') return 0;
  const tuned = typeof TUNE !== 'undefined' && TUNE.useTuned && S.tracks.some(x => x.id === 'take_tuned' && x.buffer);
  if (t.id === 'take') return K.listen && !tuned ? 1 : 0;
  if (t.id === 'take_tuned') return K.listen && tuned ? 1 : 0;
  if (!t.leaf) return 0;
  if (isVocal(t)) return K.listen ? 0 : (+$('sing-guide').value / 100) * t.vol;
  return t.vol;
}

// ───────────────────────── setup screen ─────────────────────────
const hasVocals = () => S.tracks.some(t => t.id === 'vocals' || t.id === 'lead');
function singRefresh() {
  const songName = S.source?.name?.replace(/\.[^.]+$/, '') || '';
  $('sing-song').textContent = songName || 'Choose a song';
  const writing = !!(typeof LY !== 'undefined' && LY.running);
  const failed = !!(typeof LY !== 'undefined' && LY.failed && !lyricsReady());
  $('sing-start').disabled = !S.source || S.busy || writing;
  $('sing-start').textContent = !S.source ? 'Start singing' : writing ? (LY.startLabel || 'Writing lyrics…') : !hasVocals() ? 'Prepare and sing' : failed ? 'Retry lyrics' : 'Start singing';
  $('sing-sub').textContent = K.key ? K.key : '';
}
async function loadMelody() {
  if (!hasVocals()) return false;
  if (K.melody && K.melodyFor === S.source?.path) return true;
  status('Reading the melody', 'busy');
  const m = await invoke('vocal_melody');
  K.melody = Float32Array.from(m.hz); K.fps = m.fps; K.key = m.key; K.melodyFor = S.source?.path;
  K.notes = buildNotes(K.melody, K.fps);
  const mids = K.notes.map(n => n.midi).sort((a, b) => a - b);
  const lo = mids.length ? mids[Math.floor(mids.length * 0.03)] : 55, hi = mids.length ? mids[Math.floor(mids.length * 0.97)] : 72;
  K.low = Math.min(lo - 3, hi - 15); K.high = Math.max(hi + 3, K.low + 18);
  status('Ready to sing');
  singRefresh();
  return true;
}
async function listMics() {
  try {
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audioinput');
    const sel = $('sing-mic'), keep = sel.value;
    sel.innerHTML = devices.map((d, i) => `<option value="${d.deviceId}">${d.label || 'Microphone ' + (i + 1)}</option>`).join('') || '<option value="">Default microphone</option>';
    if (keep) sel.value = keep;
    window.syncGlassSelects?.();
    micHint();
  } catch { /* no device list yet */ }
}

// ───────────────────────── singing ─────────────────────────
async function startSinging() {
  if (!S.source || S.busy) return;
  if (!hasVocals()) {
    await separate({ quality: 'fast', lead_backing: false, instruments: 'none', dereverb: false }); // Sing always uses the fast model
    if (!hasVocals()) return; // cancelled or failed
    setMode('karaoke');
  }
  // singing starts only with finished lyrics (cached ones are instant); never without them
  if (!lyricsReady()) {
    await ensureLyrics();
    if (!S.source || S.mode !== 'karaoke' || !lyricsReady()) { singRefresh(); return; } // failed, left Sing, or changed song
  }
  try { await loadMelody(); } catch (e) { toast(String(e)); return; }
  const ctx = audioContext();
  try {
    K.stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: $('sing-mic').value ? { exact: $('sing-mic').value } : undefined, echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
  } catch (e) {
    toast('Contour needs microphone access to listen to you sing.');
    return;
  }
  listMics();
  await ctx.resume();
  K.source = ctx.createMediaStreamSource(K.stream);
  K.analyser = ctx.createAnalyser();
  K.analyser.fftSize = 2048;
  K.buf = new Float32Array(K.analyser.fftSize);
  K.sink = ctx.createGain(); K.sink.gain.value = 0;
  K.rec = []; K.recSong = null; K.recFrame0 = null; K.rate = ctx.sampleRate;
  // keep a chunk only while the song plays; remember where the first one sits in the song
  const keep = (frame, data) => {
    if (!K.recording) return;
    if (K.recFrame0 == null && !S.playing) return; // start with the song
    if (K.recFrame0 == null) { K.recFrame0 = frame; K.recSong = S.offset + (frame / K.rate - S.started); }
    K.rec.push({ frame, data });
  };
  try {
    if (!K.workletReady) { await ctx.audioWorklet.addModule('recorder-worklet.js'); K.workletReady = true; }
    K.proc = new AudioWorkletNode(ctx, 'contour-recorder', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: 'explicit' });
    K.proc.port.onmessage = e => keep(e.data.frame, e.data.data);
  } catch {
    // no worklet available (e.g. the browser preview): the main-thread recorder, still frame-stamped
    K.proc = ctx.createScriptProcessor(4096, 1, 1);
    K.proc.onaudioprocess = e => keep(Math.round((e.playbackTime - e.inputBuffer.duration) * K.rate), new Float32Array(e.inputBuffer.getChannelData(0)));
  }
  K.source.connect(K.analyser);
  K.source.connect(K.proc).connect(K.sink).connect(ctx.destination);
  // what the singer hears is late by the output latency; what the mic hears is late by its own
  const inLat = K.stream.getAudioTracks()[0]?.getSettings?.().latency || 0.01;
  K.latency = (ctx.outputLatency || 0) + (ctx.baseLatency || 0) + inLat + (+$('sing-sync').value) / 1000;
  for (const n of K.notes) { n.hit = 0; n.total = 0; n.done = false; }
  K.stats = { on: 0, total: 0, streak: 0, best: 0, notesHit: 0, notesDone: 0 };
  resetLineScoring();
  K.trail = []; K.finished = false; K.takeReady = false; K.listen = false;
  K.active = true; K.singing = true; K.recording = true;
  stop(); S.pos = 0; applyMix();
  $('sing-setup').hidden = true; $('sing-results').hidden = true; $('sing-stage').hidden = false;
  $('sing-vocals').value = $('sing-guide').value;
  renderLyrics();
  ContourBackground?.set?.({ paused: true });
  await play();
  K.last = performance.now();
  cancelAnimationFrame(K.raf);
  K.raf = requestAnimationFrame(singFrame);
}
function singFrame(now) {
  if (!K.singing) return;
  const dt = Math.min(0.1, (now - K.last) / 1000);
  K.last = now;
  const ctx = S.ctx;
  K.analyser.getFloatTimeDomainData(K.buf);
  let level = 0;
  for (let i = 0; i < K.buf.length; i += 4) level = Math.max(level, Math.abs(K.buf[i]));
  const hz = yinPitch(K.buf, ctx.sampleRate);
  const t = currentPos() - K.latency, ref = refAt(t);
  if (ref > 0 && S.playing) {
    K.stats.total += dt;
    let good = 0;
    if (hz > 0) { const c = Math.abs(centsFolded(hz, ref)); good = c <= 50 ? 1 : c <= 100 ? 0.5 : 0; }
    K.stats.on += good * dt;
    const note = K.notes.find(n => t >= n.start && t < n.end);
    if (note) { note.total += dt; note.hit += good * dt; }
  }
  // settle notes that have passed
  for (const n of K.notes) {
    if (n.done || n.end > t) continue;
    n.done = true;
    if (n.total < 0.04) continue;
    K.stats.notesDone++;
    if (n.hit / n.total >= 0.5) { K.stats.notesHit++; K.stats.streak++; K.stats.best = Math.max(K.stats.best, K.stats.streak); } else K.stats.streak = 0;
  }
  if (ref > 0 && hz > 0) LY.good = Math.abs(centsFolded(hz, ref)) <= 50; else if (!(hz > 0)) LY.good = null;
  updateLyrics(currentPos() - (ctx.outputLatency || 0));
  K.trail.push({ t, hz, ref });
  rateLines(t);
  while (K.trail.length && K.trail[0].t < t - 4) K.trail.shift();
  const acc = K.stats.total > 0.5 ? Math.round((100 * K.stats.on) / K.stats.total) : null;
  $('sing-score').textContent = acc == null ? '-' : acc;
  $('sing-notes').textContent = `${K.stats.notesHit}/${K.stats.notesDone}`;
  $('sing-streak').textContent = K.stats.streak;
  $('sing-level').style.transform = `scaleX(${Math.min(1, level * 3).toFixed(3)})`;
  drawSing(t);
  if (!S.playing && !S.starting && currentPos() >= duration() - 0.1) { finishSinging(); return; }
  K.raf = requestAnimationFrame(singFrame);
}
function drawSing(t) {
  const c = $('sing-canvas'), r = c.getBoundingClientRect(), dpr = Math.min(2, devicePixelRatio || 1);
  if (!r.width) return;
  if (c.width !== Math.round(r.width * dpr) || c.height !== Math.round(r.height * dpr)) { c.width = Math.round(r.width * dpr); c.height = Math.round(r.height * dpr); }
  const g = c.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const W = r.width, H = r.height, past = 3, ahead = 6, x0 = W * (past / (past + ahead));
  const X = s => x0 + ((s - t) / (past + ahead)) * W;
  const Y = m => H - ((m - K.low) / (K.high - K.low)) * (H - 24) - 12;
  g.clearRect(0, 0, W, H);
  // semitone grid, Cs labelled
  g.font = '10px ' + getComputedStyle(document.body).fontFamily;
  for (let m = Math.ceil(K.low); m <= K.high; m++) {
    const y = Y(m);
    g.fillStyle = m % 12 === 0 ? 'rgba(173,205,250,.10)' : 'rgba(173,205,250,.04)';
    g.fillRect(0, Math.round(y), W, 1);
    if (m % 12 === 0) { g.fillStyle = 'rgba(173,205,250,.35)'; g.fillText(`C${Math.floor(m / 12) - 1}`, 6, y - 3); }
  }
  // the melody, as notes
  const h = Math.max(6, (H - 24) / (K.high - K.low) * 0.7);
  for (const n of K.notes) {
    if (n.end < t - past || n.start > t + ahead) continue;
    const xa = X(n.start), xb = X(n.end), y = Y(n.mid);
    const passed = n.done, ratio = n.total > 0 ? n.hit / n.total : 0;
    // hit: blue · missed: soft red · too short to score: neutral · upcoming / now: white
    g.fillStyle = passed ? (n.total < 0.04 ? 'rgba(233,241,251,.12)' : ratio >= 0.5 ? 'rgba(141,184,240,.85)' : 'rgba(232,145,126,.35)') : n.start <= t ? 'rgba(233,241,251,.55)' : 'rgba(233,241,251,.18)';
    roundRectPath(g, xa, y - h / 2, Math.max(2, xb - xa), h, h / 2);
    g.fill();
  }
  // your voice, folded into the melody's octave so it sits on the notes
  g.lineWidth = 3; g.lineCap = 'round'; g.lineJoin = 'round';
  g.strokeStyle = '#8db8f0';
  g.beginPath();
  let pen = false, lastY = 0;
  for (const p of K.trail) {
    if (!(p.hz > 0)) { pen = false; continue; }
    let m = midiOf(p.hz);
    const target = p.ref > 0 ? midiOf(p.ref) : (K.low + K.high) / 2;
    while (m - target > 6) m -= 12;
    while (target - m > 6) m += 12;
    const x = X(p.t), y = Y(m);
    if (pen && Math.abs(y - lastY) < H * 0.25) g.lineTo(x, y); else g.moveTo(x, y);
    pen = true; lastY = y;
  }
  g.stroke();
  g.shadowBlur = 0;
  // now line
  g.fillStyle = 'rgba(233,241,251,.6)';
  g.fillRect(Math.round(x0), 0, 1.5, H);
}
async function finishSinging(cancelled = false) {
  if (!K.singing) return;
  K.singing = false;
  cancelAnimationFrame(K.raf);
  stop(true);
  try { K.proc?.port?.postMessage('stop'); } catch { /* not a worklet */ }
  await new Promise(res => setTimeout(res, 60)); // let the recorder hand over its last chunk
  K.recording = false;
  try { K.source?.disconnect(); K.proc?.disconnect(); K.sink?.disconnect(); } catch { /* gone */ }
  ContourBackground?.set?.({ paused: false });
  K.stream?.getTracks().forEach(tr => tr.stop());
  K.stream = null;
  K.active = false; applyMix();
  $('sing-stage').hidden = true;
  if (cancelled) { $('sing-setup').hidden = false; singRefresh(); return; }
  // results
  const acc = K.stats.total > 0 ? Math.round((100 * K.stats.on) / K.stats.total) : 0;
  $('sing-final').textContent = acc;
  rateLines(Infinity); // the last line, if the song ended mid-line
  renderResultsDetail(acc);
  $('sing-verdict').textContent = acc >= 90 ? 'Pitch perfect.' : acc >= 75 ? 'Great singing.' : acc >= 55 ? 'Nice, keep going.' : 'Warm-up done. Again?';
  $('sing-stats').innerHTML = `<span><b>${K.stats.notesHit}</b> of ${K.stats.notesDone} notes</span><span><b>${K.stats.best}</b> best streak</span><span><b>${Math.round(K.stats.on)}</b> s on pitch</span>`;
  $('sing-results').hidden = false;
  $('sing-results').classList.remove('no-score');
  $('sing-listen').disabled = $('sing-save').disabled = $('sing-studio').disabled = $('sing-tune').disabled = $('sing-save-song').disabled = true;
  // store the take as a stem, placed where it was sung
  try {
    if (!K.rec.length || K.recSong == null) { $('sing-again').focus(); return; } // finished before anything was sung
    const last = K.rec[K.rec.length - 1], total = last.frame + last.data.length - K.recFrame0, take = new Float32Array(total);
    for (const c of K.rec) { const at = c.frame - K.recFrame0; if (at >= 0 && at + c.data.length <= total) take.set(c.data, at); }
    // the first recorded sample was sung to song time recSong − latency (heard late, captured late)
    const offset = Math.round(((K.recSong ?? 0) - K.latency) * SR);
    const info = await invoke('add_take', new Uint8Array(take.buffer), { headers: { 'x-offset': String(offset), 'x-rate': String(K.rate) } });
    S.tracks = S.tracks.filter(x => x.id !== 'take' && x.id !== 'take_tuned');
    TUNE.curves = null; $('tune').hidden = true; $('sing-tune').hidden = false; $('tune-score').textContent = '';
    const tk = makeTrack(info);
    tk.mute = false;
    S.tracks.push(tk);
    renderAll();
    await loadTrack(tk);
    ContourProduct.audioChanged?.(); // the take is new audio: recovery saves it, not just the mix
    K.takeReady = true;
    $('sing-listen').disabled = $('sing-save').disabled = $('sing-studio').disabled = $('sing-tune').disabled = $('sing-save-song').disabled = false;
  } catch (e) { toast(`Couldn't keep the take: ${e}`); }
}
async function listenBack() {
  if (K.listen && S.playing) { stop(true); K.listen = false; K.active = false; applyMix(); $('sing-listen').textContent = 'Listen back'; return; }
  K.listen = true; K.active = true; applyMix();
  stop(true); S.pos = 0;
  $('sing-listen').textContent = 'Stop';
  await play();
  const watch = setInterval(() => { if (!S.playing && !S.starting) { clearInterval(watch); K.listen = false; K.active = false; applyMix(); $('sing-listen').textContent = 'Listen back'; } }, 300);
}

// ───────────────────────── wiring ─────────────────────────
$('sing-start').onclick = startSinging;
$('sing-choose').onclick = async () => { const p = await invoke('pick_audio'); if (p) { await loadPath(p); K.melody = null; K.key = ''; singRefresh(); } };
$('sing-stop').onclick = () => finishSinging(false);
$('sing-cancel').onclick = () => finishSinging(true);
$('sing-listen').onclick = listenBack;
$('sing-again').onclick = () => { $('sing-results').hidden = true; $('sing-setup').hidden = false; singRefresh(); $('sing-tune-take').hidden = !track('take'); };
$('sing-save').onclick = async () => {
  const id = TUNE.useTuned && track('take_tuned') ? 'take_tuned' : 'take';
  const dir = await chooseExportFolder();
  if (dir) await runExport([id], dir, $('format').value, $('rate').value ? +$('rate').value : null, $('protect').checked, null);
};
$('sing-studio').onclick = () => {
  K.active = false; K.listen = false;
  const tuned = track('take_tuned'), raw = track('take');
  if (tuned && raw) { tuned.mute = !TUNE.useTuned; raw.mute = TUNE.useTuned; }
  for (const t of S.tracks) if (isVocal(t)) t.mute = true; // your take replaces the original singer
  applyMix(); renderAll(); setMode('studio');
};
$('sing-sync').oninput = e => { const v = +e.target.value; $('sing-sync-v').textContent = v ? `${v > 0 ? '+' : ''}${v} ms` : 'auto'; };
$('sing-guide').oninput = () => { if (K.active) applyMix(); };
document.addEventListener('contour:mode', e => {
  if (e.detail === 'karaoke') { singRefresh(); listMics(); if (hasVocals()) loadMelody().catch(() => {}); }
  else if (K.singing) finishSinging(true);
});

// ───────────────────────── Tune it ─────────────────────────
// Pitch-correct the take to the melody (or the key). The newest settings always win: while a tune is
// running, further changes collapse into one follow-up run, and the current result stays on screen
// (and keeps playing) until its replacement is ready.
const TUNE = { rev: 0, running: false, again: false, curves: null, useTuned: true, timer: 0, runs: 0 };
function keyOf(name) {
  const [tonic, mode] = String(name || '').split(' ');
  const i = NOTE.indexOf(tonic);
  return { key: i < 0 ? 0 : i, minor: mode === 'minor' };
}
function tuneSettings() {
  const v = +$('tune-speed').value / 100;
  return {
    mode: document.querySelector('#tune-mode [aria-checked=true]')?.dataset.tuneMode || 'melody',
    strength: +$('tune-strength').value / 100,
    retune_ms: Math.round(300 * Math.pow(1 - v, 2)),
    keep_vibrato: $('tune-vibrato').checked,
    ...keyOf(K.key),
  };
}
const speedLabel = v => (v >= 96 ? 'Robotic' : v >= 75 ? 'Tight' : v >= 30 ? 'Natural' : 'Gentle');
function scheduleTune(delay = 220) { clearTimeout(TUNE.timer); TUNE.timer = setTimeout(runTune, delay); }
async function runTune() {
  if (!track('take')?.buffer) return; // restored settings or a stray slider event: nothing to tune yet
  const rev = ++TUNE.rev;
  if (TUNE.running) { TUNE.again = true; return; }
  TUNE.running = true;
  $('tune-busy').hidden = false;
  $('tune').setAttribute('aria-busy', 'true');
  try {
    TUNE.runs++;
    const res = await invoke('tune_take', { settings: tuneSettings() });
    if (rev === TUNE.rev) await applyTune(res, rev); // a newer request is queued otherwise; it will apply
  } catch (e) {
    toast(`Couldn't tune the take: ${e}`); // the previous result (if any) stays in place
  } finally {
    TUNE.running = false;
    if (TUNE.again) { TUNE.again = false; runTune(); }
    else { $('tune-busy').hidden = true; $('tune').removeAttribute('aria-busy'); }
  }
}
async function applyTune(res, rev) {
  // Load the new tuning first; the current one keeps playing (and showing) until it's ready.
  const tt = makeTrack(res.stem);
  tt.mute = false;
  const buf = await fetchBuffer(tt, () => rev === TUNE.rev);
  if (!buf || rev !== TUNE.rev) return; // superseded while loading
  tt.buffer = buf;
  TUNE.curves = res.curves;
  const old = track('take_tuned');
  if (old?.gain && S.ctx) { try { old.gain.gain.setTargetAtTime(0, S.ctx.currentTime, FADE); } catch { /* released */ } }
  const i = S.tracks.findIndex(x => x.id === 'take_tuned');
  if (i >= 0) S.tracks[i] = tt; else S.tracks.push(tt);
  scheduleAnalysis(tt);
  ContourProduct.audioChanged?.(); // the tuned take is new audio
  if (S.playing) restart(); // seamless: the new tuning crossfades in where you are
  const b = Math.round(res.curves.in_tune_before * 100), a = Math.round(res.curves.in_tune_after * 100);
  $('tune-score').textContent = `In tune ${b}% → ${a}%`;
  drawTune();
  renderAll();
  applyMix();
}
function drawTune() {
  const c = $('tune-canvas'), cv = TUNE.curves;
  if (!cv) return;
  const r = c.getBoundingClientRect(), dpr = Math.min(2, devicePixelRatio || 1);
  if (!r.width) return;
  c.width = Math.round(r.width * dpr); c.height = Math.round(r.height * dpr);
  const g = c.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const W = r.width, H = r.height, voiced = cv.sung.map((f, i) => (f > 0 ? i : -1)).filter(i => i >= 0);
  if (!voiced.length) { g.fillStyle = 'rgba(173,205,250,.5)'; g.fillText('No singing detected in the take.', 12, 22); return; }
  const i0 = Math.max(0, voiced[0] - 20), i1 = Math.min(cv.sung.length, voiced[voiced.length - 1] + 20);
  const ms = voiced.map(i => midiOf(cv.sung[i])).sort((a, b) => a - b);
  const lo = ms[Math.floor(ms.length * 0.02)] - 2, hi = ms[Math.floor(ms.length * 0.98)] + 2, span = Math.max(8, hi - lo);
  const X = i => ((i - i0) / Math.max(1, i1 - i0)) * W, Y = m => H - ((m - lo) / span) * (H - 16) - 8;
  const line = (arr, style, width, blur) => {
    g.strokeStyle = style; g.lineWidth = width; g.shadowBlur = blur; g.shadowColor = style;
    g.beginPath();
    let pen = false;
    const step = Math.max(1, Math.floor((i1 - i0) / (W * 1.5)));
    for (let i = i0; i < i1; i += step) {
      const f = arr[i];
      if (!(f > 0)) { pen = false; continue; }
      const x = X(i), y = Y(midiOf(f));
      if (pen) g.lineTo(x, y); else { g.moveTo(x, y); g.lineTo(x + 0.01, y); } // lone points show as dots
      pen = true;
    }
    g.lineCap = 'round'; g.lineJoin = 'round';
    g.stroke(); g.shadowBlur = 0;
  };
  g.clearRect(0, 0, W, H);
  line(cv.target, 'rgba(233,241,251,.28)', 6, 0);
  line(cv.sung, 'rgba(232,145,126,.55)', 1.5, 0);
  line(cv.tuned, '#8db8f0', 2, 6);
}
function openTune() {
  $('tune').hidden = false;
  $('sing-tune').hidden = true;
  runTune();
}
$('sing-tune').onclick = openTune;
document.querySelectorAll('#tune-mode [data-tune-mode]').forEach(b => b.addEventListener('click', () => { setRadio('#tune-mode', 'tuneMode', b.dataset.tuneMode); scheduleTune(0); }));
$('tune-strength').oninput = e => { $('tune-strength-v').textContent = `${e.target.value}%`; scheduleTune(); };
$('tune-speed').oninput = e => { $('tune-speed-v').textContent = speedLabel(+e.target.value); scheduleTune(); };
$('tune-vibrato').onchange = () => scheduleTune(0);
$('tune-ab').onchange = e => { TUNE.useTuned = e.target.checked; applyMix(); }; // instant A/B, even mid-playback
window.addEventListener('resize', () => { if (!$('tune').hidden) drawTune(); });

// ───────────────────────── takes from anywhere ─────────────────────────
/** Results screen for a take that wasn't just sung (imported, or reopened from Studio): no score, Tune it ready. */
async function showTakeOnly() {
  if (!track('take')) return;
  if (S.mode !== 'karaoke') setMode('karaoke');
  try { await loadMelody(); } catch { /* Key mode still works with the detected key */ }
  $('sing-setup').hidden = true; $('sing-stage').hidden = true; $('sing-results').hidden = false;
  $('sing-results').classList.add('no-score');
  const ready = !!track('take')?.buffer || await loadTrack(track('take')).then(() => true, () => false);
  $('sing-listen').disabled = $('sing-save').disabled = $('sing-studio').disabled = $('sing-tune').disabled = $('sing-save-song').disabled = !ready;
  openTune();
}
async function importTake() {
  if (!S.source) { toast('Choose the song first, then import your take.'); return; }
  const path = await invoke('pick_audio');
  if (!path) return;
  if (!hasVocals()) {
    await separate({ quality: 'fast', lead_backing: false, instruments: 'none', dereverb: false }); // Sing always uses the fast model
    if (!hasVocals()) return;
  }
  busyStart('Lining up your take');
  try {
    const res = await invoke('import_take', { path });
    S.tracks = S.tracks.filter(x => x.id !== 'take' && x.id !== 'take_tuned');
    const tk = makeTrack(res.stem);
    tk.mute = false;
    S.tracks.push(tk);
    TUNE.curves = null; $('tune-score').textContent = '';
    renderAll();
    await loadTrack(tk);
    ContourProduct.audioChanged?.();
    status(`Take lined up at ${res.offset >= 0 ? '+' : '−'}${Math.abs(res.offset).toFixed(2)} s`);
  } catch (e) {
    status('Could not import the take', 'error'); toast(String(e));
    return;
  } finally { busyEnd(); }
  await showTakeOnly();
}
function tuneFromStudio() { setMode('karaoke'); requestAnimationFrame(() => showTakeOnly()); }
/** Your version: the take you chose (tuned or original) over the instrumental, as one file. */
async function saveSong() {
  const takeId = TUNE.useTuned && track('take_tuned') ? 'take_tuned' : 'take';
  const parts = S.tracks
    .filter(t => t.id === takeId || (t.leaf && !isVocal(t) && t.id !== 'original' && !t.id.startsWith('take')))
    .map(t => ({ id: t.id, gain: t.vol, pan: t.pan, envelope: [], clips: typeof clipsPayload === 'function' ? clipsPayload(t) : [] }));
  if (!parts.some(p => p.id === takeId)) { toast('Record or import a take first.'); return; }
  const dir = await chooseExportFolder();
  if (!dir) return;
  busyStart('Saving your version');
  try {
    const name = 'My version'; // export adds the song's name in front
    parts.forEach(p => (p.fx = track(p.id)?.fx));
    S.lastExport = await invoke('export_mix', { parts, name, dir, ...ContourProduct.exportSettings() });
    status('Your version is saved'); toast(`Saved to ${S.lastExport}`);
  } catch (e) { status('Not saved', 'error'); toast(String(e)); } finally { busyEnd(); }
}
$('sing-import').onclick = importTake;
$('sing-tune-take').onclick = showTakeOnly;
$('sing-save-song').onclick = saveSong;
document.addEventListener('contour:mode', e => {
  if (e.detail === 'karaoke') $('sing-tune-take').hidden = !track('take');
});

function micHint() { $('sing-hint').textContent = 'Use headphones, so the music doesn\'t leak into your take.'; }


// ───────────────────────── lyrics (Apple Music-style) ─────────────────────────
// Lines from on-device Whisper. Rendering is transform/opacity only (compositor-friendly); blur is
// limited to a few lines near the current one; per frame only the current line's words update.
const LY = { data: null, items: [], cur: -1, tops: [], heights: [], view: 'lyrics', raf: 0, good: null };
const vowelGroups = w => { let n = 0, prev = false; for (const c of w) { const v = /[aeiouyàáâãäåèéêëìíîïòóôõöùúûü]/i.test(c) || c.charCodeAt(0) > 127; if (v && !prev) n++; prev = v; } return Math.max(1, n); };
/** Word timings within a line, from syllable estimates (same rule as the engine). */
function estimateWords(start, end, text) {
  const ws = text.split(/\s+/).filter(Boolean), tot = ws.reduce((s, w) => s + vowelGroups(w), 0) || 1;
  let t = start;
  return ws.map(w => { const d = ((end - start) * vowelGroups(w)) / tot, o = { start: t, end: t + d, text: w }; t += d; return o; });
}
function lyricsItems(lines) {
  const items = [];
  let prevEnd = 0;
  for (const l of lines) {
    const intro = items.length === 0;
    if (l.start - prevEnd > (intro ? 2.5 : 4.5)) items.push({ type: 'gap', start: prevEnd, end: l.start }); // the intro or an instrumental break
    items.push({ type: 'line', start: l.start, end: l.end, line: l });
    prevEnd = l.end;
  }
  return items;
}
function renderLyrics() {
  const box = $('lyrics');
  box.innerHTML = '';
  LY.cur = -1;
  const has = !!LY.data?.lines?.length;
  $('sing-stage').classList.toggle('has-lyrics', has && LY.view === 'lyrics');
  $('sing-view').hidden = !has;
  if (!has) return;
  LY.items = lyricsItems(LY.data.lines);
  LY.items.forEach((it, i) => {
    const el = document.createElement('div');
    el.className = it.type === 'gap' ? 'ly-gap' : 'ly-line';
    if (it.type === 'gap') el.innerHTML = '<i></i><i></i><i></i>';
    else {
      el.innerHTML = it.line.words.map(w => `<span class="w">${escapeHtml(w.text)}</span>`).join(' ');
      el.addEventListener('click', () => { if (!K.singing) seekTo(Math.max(0, it.start - 0.15)); });
    }
    it.el = el;
    box.append(el);
  });
  requestAnimationFrame(() => {
    LY.tops = []; LY.heights = [];
    let y = 0;
    for (const it of LY.items) { const h = it.el.offsetHeight; LY.tops.push(y); LY.heights.push(h); y += h + 22; }
    LY.cur = -2;
    updateLyrics(currentPos());
  });
}
function updateLyrics(t) {
  if (!LY.items.length || LY.view !== 'lyrics') return;
  let cur = 0;
  for (let i = 0; i < LY.items.length; i++) if (LY.items[i].start <= t + 0.05) cur = i;
  const box = $('lyrics'), anchor = box.clientHeight * 0.32;
  if (cur !== LY.cur && LY.pending) { LY.pending = false; renderLyrics(); return; }
  if (cur !== LY.cur) {
    LY.cur = cur;
    LY.items.forEach((it, i) => {
      const d = Math.abs(i - cur);
      it.el.style.transitionDelay = `${Math.min(d, 6) * 28}ms`; // staggered: the spring ripples outward
      it.el.style.transform = `translate3d(0, ${LY.tops[i] - LY.tops[cur] + anchor - LY.heights[cur] / 2}px, 0)`;
      it.el.className = (it.type === 'gap' ? 'ly-gap' : 'ly-line') + (d === 0 ? ' ly-now' : d === 1 ? ' ly-near' : d <= 3 ? ' ly-mid' : ' ly-far') + (i < cur ? ' ly-past' : '');
    });
  }
  const it = LY.items[cur];
  if (it.type === 'line') {
    const spans = it.el.children;
    it.line.words.forEach((w, k) => {
      const p = Math.max(0, Math.min(1, (t - w.start) / Math.max(0.05, w.end - w.start)));
      spans[k].style.setProperty('--p', `${(p * 100).toFixed(1)}%`);
      spans[k].classList.toggle('ly-on', p > 0 && t < it.end + 0.4);
    });
    it.el.classList.toggle('ly-good', K.singing && LY.good === true);
    it.el.classList.toggle('ly-bad', K.singing && LY.good === false);
  } else {
    const p = (t - it.start) / Math.max(0.1, it.end - it.start);
    [...it.el.children].forEach((dot, k) => dot.classList.toggle('ly-lit', p > (k + 1) / 4));
  }
}
function lyricsLoop() {
  cancelAnimationFrame(LY.raf);
  const tick = () => {
    if (S.mode !== 'karaoke') return;
    if (!K.singing) updateLyrics(currentPos()); // while singing, singFrame drives it with latency compensation
    LY.raf = requestAnimationFrame(tick);
  };
  LY.raf = requestAnimationFrame(tick);
}
// Lyrics are written in the background: they never lock the app, lines appear as each part of the
// song is done, and finished lyrics are remembered per song (so reopening a song shows them at once).
const LYRICS_CACHE = 'contour.lyrics.v1';
const songKey = () => (S.source ? `${S.source.path || S.source.name}|${Math.round((S.source.duration || duration() || 0) * 10)}` : '');
function cachedLyrics() {
  try { return JSON.parse(localStorage.getItem(LYRICS_CACHE) || '{}')[songKey()] || null; } catch { return null; }
}
function rememberLyrics(data) {
  try {
    const all = JSON.parse(localStorage.getItem(LYRICS_CACHE) || '{}');
    all[songKey()] = { language: data.language, lines: data.lines, at: Date.now() };
    const keys = Object.keys(all).sort((a, b) => (all[b].at || 0) - (all[a].at || 0));
    for (const old of keys.slice(40)) delete all[old]; // bounded: the 40 most recent songs
    localStorage.setItem(LYRICS_CACHE, JSON.stringify(all));
  } catch { /* storage full or unavailable: fine */ }
}
LY.running = false;
LY.job = 0;
function applyLyrics(data, final) {
  const wasEmpty = !LY.data?.lines?.length;
  LY.data = { language: data.language, lines: data.lines, for: S.source?.path };
  lyricsStatus();
  if (final || wasEmpty || !K.singing) renderLyrics(); // while singing, partial updates re-render only between lines
  else LY.pending = true;
}
listen('lyrics-partial', ({ payload }) => { if (LY.running && payload?.lines?.length) applyLyrics(payload, false); });
listen('lyrics-progress', ({ payload: p }) => {
  if (!LY.running) return;
  const n = LY.data?.lines?.length || 0;
  $('sing-lyrics-status').textContent = p.stage === 'Writing lyrics' ? `Writing lyrics · ${Math.round(p.fraction * 100)}%${n ? ` · ${n} lines so far` : ''}` : `${p.stage} · ${p.detail}`;
  LY.startLabel = p.stage === 'Writing lyrics' ? `Writing lyrics · ${Math.round(p.fraction * 100)}%` : 'Getting the lyrics model…';
  if (!K.singing) singRefresh();
});
/** This song's lyrics are finished (an instrumental's empty lyrics count, so it can't lock Sing). */
const lyricsReady = () => !!(LY.data && S.source && LY.data.for === S.source.path);
/** Lyrics for the current song: the cached ones, the job already running, or a new job. Resolves when done. */
function ensureLyrics() {
  const hit = cachedLyrics();
  if (hit?.lines?.length) { applyLyrics(hit, true); return Promise.resolve(); }
  return LY.running ? LY.promise : getLyrics({ auto: true });
}
function getLyrics(opts = {}) {
  if (LY.running) return LY.promise;
  LY.promise = runLyrics(opts);
  return LY.promise;
}
async function runLyrics({ auto = false } = {}) {
  if (!S.source) { if (!auto) toast('Choose a song first.'); return; }
  if (!hasVocals()) {
    if (auto) return; // automatic runs wait for the vocals; they start right after separation
    await separate({ quality: 'fast', lead_backing: false, instruments: 'none', dereverb: false }); // Sing always uses the fast model
    if (!hasVocals()) return;
    setMode('karaoke');
  }
  const job = ++LY.job, song = songKey();
  LY.running = true;
  LY.failed = false;
  LY.startLabel = 'Writing lyrics…';
  $('sing-lyrics-get').disabled = true;
  $('sing-lyrics-status').textContent = 'Writing lyrics…';
  singRefresh();
  try {
    const res = await invoke('transcribe_lyrics', { language: $('sing-lang').value || null, device: $('device')?.value || 'auto' }); // the encoder runs on the chosen GPU
    if (job !== LY.job || song !== songKey()) return; // another song since: drop it
    applyLyrics(res, true);
    rememberLyrics(res);
    ContourProduct.changed();
  } catch (e) {
    if (job === LY.job && !/cancel/i.test(String(e))) {
      LY.failed = true;
      if (!auto) toast(String(e));
    }
  } finally {
    if (job === LY.job) { LY.running = false; $('sing-lyrics-get').disabled = false; lyricsStatus(); singRefresh(); }
  }
}
/** Lyrics without asking: cached ones at once, otherwise a background job once the vocals exist. */
function autoLyrics() {
  if (S.mode !== 'karaoke' || !S.source || LY.running || LY.failed) return; // a failure waits for Retry lyrics
  if (LY.data?.lines?.length && LY.data.for === S.source.path) return;
  if (hasVocals() && typeof loadMelody === 'function') loadMelody().catch(() => {}); // cached per song; Start won't wait for it
  const hit = cachedLyrics();
  if (hit?.lines?.length) { applyLyrics(hit, true); return; }
  if (hasVocals()) getLyrics({ auto: true });
}

function lyricsStatus() {
  const n = LY.data?.lines?.length || 0;
  $('sing-lyrics-status').textContent = n ? `${n} lines${LY.data.language ? ' · ' + LY.data.language.toUpperCase() : ''}` : LY.failed ? "Couldn't write lyrics. Press Retry lyrics to try again." : (LY.data ? 'No singing found' : '');
  $('sing-lyrics-edit').hidden = !n;
  $('sing-lyrics-get').textContent = n ? 'Rewrite lyrics' : 'Get lyrics';
  if (LY.running) $('sing-lyrics-status').textContent = n ? `Writing lyrics · ${n} lines so far` : 'Writing lyrics…';
}
// editor: fix words; timings stay attached (word timings are re-estimated for edited lines)
function openLyricsEditor() {
  const list = $('ly-edit-list');
  list.innerHTML = LY.data.lines.map((l, i) => `<label class="ly-edit-row"><span>${fmt(l.start)}</span><input data-i="${i}" value="${escapeHtml(l.text)}" aria-label="Line at ${fmt(l.start)}"></label>`).join('');
  $('lyrics-editor').hidden = false;
  list.querySelector('input')?.focus();
}
function saveLyricsEditor() {
  const lines = [];
  $('ly-edit-list').querySelectorAll('input').forEach(inp => {
    const l = LY.data.lines[+inp.dataset.i], text = inp.value.trim().replace(/\s+/g, ' ');
    if (!text) return; // emptied: removed
    lines.push(text === l.text ? l : { ...l, text, words: estimateWords(l.start, l.end, text) });
  });
  LY.data.lines = lines;
  $('lyrics-editor').hidden = true;
  lyricsStatus(); renderLyrics(); ContourProduct.changed();
}
$('sing-lyrics-get').onclick = getLyrics;
$('sing-lyrics-edit').onclick = openLyricsEditor;
$('ly-edit-save').onclick = saveLyricsEditor;
$('ly-edit-cancel').onclick = () => ($('lyrics-editor').hidden = true);
$('lyrics-editor').addEventListener('keydown', e => { if (e.key === 'Escape') $('lyrics-editor').hidden = true; e.stopPropagation(); });
document.querySelectorAll('#sing-view [data-view]').forEach(b => b.addEventListener('click', () => {
  LY.view = b.dataset.view; setRadio('#sing-view', 'view', LY.view);
  $('sing-stage').classList.toggle('has-lyrics', LY.view === 'lyrics' && !!LY.data?.lines?.length);
  LY.cur = -2; requestAnimationFrame(() => updateLyrics(currentPos()));
}));
$('sing-vocals').oninput = e => { $('sing-guide').value = e.target.value; if (K.active) applyMix(); };
document.addEventListener('contour:mode', e => {
  if (e.detail !== 'karaoke') return;
  if (LY.data && LY.data.for && S.source && LY.data.for !== S.source.path) LY.data = null; // another song
  lyricsStatus(); renderLyrics(); lyricsLoop();
  autoLyrics();
});
// a different song: stop any lyrics job for the old one
let lyricsSong = '';
setInterval(() => {
  const key = S.source ? songKey() : '';
  if (key !== lyricsSong) {
    if (lyricsSong && LY.running) { invoke('cancel_lyrics').catch(() => {}); LY.job++; LY.running = false; $('sing-lyrics-get').disabled = false; }
    if (lyricsSong !== key) { LY.failed = false; singRefresh(); } // a new song gets a fresh attempt
    lyricsSong = key;
  }
  if (S.mode === 'karaoke' && !LY.running && !LY.failed && !K.singing && hasVocals?.() && !(LY.data?.lines?.length)) autoLyrics(); // vocals just arrived (never re-tries a failure by itself)
}, 700);
window.addEventListener('resize', () => { if (LY.data && S.mode === 'karaoke') renderLyrics(); });

// ───────────────────────── scoring 2.0: a quiet rating per line ─────────────────────────
const RATE = [['perfect', 'Perfect', 0.62], ['great', 'Great', 0.42], ['good', 'Good', 0.22]];
/** The lines to rate: the lyrics' lines, or (without lyrics) the melody's phrases. */
function scoringLines() {
  if (LY.data?.lines?.length) return LY.data.lines.map(l => ({ start: l.start, end: l.end }));
  const m = K.melody || [], fps = K.fps || 100, out = [];
  let s = -1, lastVoiced = -1;
  for (let i = 0; i <= m.length; i++) {
    const v = i < m.length && m[i] > 0;
    if (v) { if (s < 0) s = i; lastVoiced = i; }
    else if (s >= 0 && (i - lastVoiced) / fps > 0.6) { if ((lastVoiced - s) / fps > 0.8) out.push({ start: s / fps, end: (lastVoiced + 1) / fps }); s = -1; }
  }
  return out;
}
function resetLineScoring() {
  K.lines = scoringLines().map(l => ({ ...l, score: null, rating: null }));
  K.lineNext = 0; K.combo = 0; K.bestCombo = 0;
  $('sing-combo').textContent = ''; $('sing-combo').classList.remove('on');
  $('sing-rate-layer').innerHTML = '';
}
/** Rate every line that has just ended (once): the share of its melody you held on pitch. */
function rateLines(t) {
  while (K.lines && K.lineNext < K.lines.length && t > K.lines[K.lineNext].end + 0.15) {
    const l = K.lines[K.lineNext++];
    let ref = 0, on = 0;
    for (const f of K.trail) {
      if (f.t < l.start || f.t > l.end || !(f.ref > 0)) continue;
      ref++;
      if (f.hz > 0 && Math.abs(centsFolded(f.hz, f.ref)) <= 50) on++;
    }
    if (ref < 3) continue; // too little melody to judge
    l.score = on / ref;
    const r = RATE.find(x => l.score >= x[2]);
    l.rating = r ? r[0] : 'miss';
    if (r && r[0] !== 'good') { K.combo++; K.bestCombo = Math.max(K.bestCombo, K.combo); } else K.combo = 0;
    if (r) showRating(r[0], r[1]); // misses pass silently
    const c = $('sing-combo');
    c.textContent = K.combo >= 2 ? `×${K.combo}` : '';
    c.classList.toggle('on', K.combo >= 2);
  }
}
function showRating(kind, word) {
  const el = document.createElement('span');
  el.className = `sing-rate ${kind}`;
  el.textContent = word;
  $('sing-rate-layer').append(el);
  el.addEventListener('animationend', () => el.remove());
}
const GRADES = [['S', 90], ['A', 80], ['B', 65], ['C', 50], ['D', 0]];
/** Results: a soft grade, a slim timeline of every line, the counts, and the personal best. */
function renderResultsDetail(acc) {
  const grade = GRADES.find(g => acc >= g[1])[0];
  $('sing-grade').textContent = grade;
  $('sing-grade').dataset.grade = grade;
  const lines = (K.lines || []).filter(l => l.rating), dur = duration() || 1;
  $('sing-strip').innerHTML = lines.map(l => `<i class="${l.rating}" style="left:${(100 * l.start) / dur}%;width:${Math.max(0.4, (100 * (l.end - l.start)) / dur)}%" title="${fmt(l.start)} · ${l.rating}"></i>`).join('');
  $('sing-strip').hidden = !lines.length;
  const n = k => lines.filter(l => l.rating === k).length;
  const parts = [['perfect', 'Perfect'], ['great', 'Great'], ['good', 'Good']].filter(([k]) => n(k)).map(([k, w]) => `<span class="${k}"><b>${n(k)}</b> ${w}</span>`);
  $('sing-counts').innerHTML = parts.join('<span class="dot">·</span>') + (K.bestCombo >= 3 ? `<span class="dot">·</span><span><b>×${K.bestCombo}</b> best run</span>` : '');
  // personal best for this song
  const key = 'contour.best.v1', id = S.source?.path || S.source?.name || '';
  let bests = {};
  try { bests = JSON.parse(localStorage.getItem(key) || '{}'); } catch { /* fresh */ }
  const prev = bests[id];
  const best = $('sing-best');
  if (!prev || acc > prev.score) {
    bests[id] = { score: acc, grade, at: Date.now() };
    try { localStorage.setItem(key, JSON.stringify(bests)); } catch { /* storage unavailable */ }
    best.textContent = prev ? `New personal best · up from ${prev.score}` : 'Your first score for this song';
    best.classList.toggle('new', !!prev);
  } else {
    best.textContent = `Personal best ${prev.score} · ${prev.grade}`;
    best.classList.remove('new');
  }
}
