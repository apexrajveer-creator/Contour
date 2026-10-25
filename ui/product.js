// Product workflows. Audio buffers stay in the shared session; history contains edits only.
(() => {
  'use strict';
  const history = new ContourWorkflow.EditHistory(64);
  let applying = false, queued = false, gesture = false, recoveryTimer = 0, recoveryRevision = -1;
  let audioRevision = 0, lastRecoveryPath=null, recoveryPath = null, exportReturn = null, lastRecoveryEdit = '', savingRecovery = false;
  const text = (id, value) => { const el = $(id); if (el.textContent !== value) el.textContent = value; };
  function editState() {
    return { tracks: S.tracks.map(t => ({ id: t.id, mute: t.mute, solo: t.solo, vol: t.vol, pan: t.pan, env: t.env.map(p => ({ ...p })), clips: t.clips ? t.clips.map(c => ({ ...c })) : null, label: t.label, height: t.height || null, fx: t.fx ? { ...t.fx } : undefined })), xfade: S.xfade, region: S.region ? [...S.region] : null, loop: S.loop, mash: S.kind === 'mashup' ? { ...MASH.settings } : null };
  }
  const dirty = () => !!S.source && S.savedMix !== mixFingerprint();
  function info() {
    const blocked = S.busy || S.preflighting || MASH.pending || savingRecovery;
    $('undo').disabled = blocked || !history.canUndo; $('redo').disabled = blocked || !history.canRedo;
    $('global-play').disabled = !S.source; $('global-seek').disabled = !S.source;
    text('session-state', dirty() ? 'Unsaved changes' : '');
    $('session-state').classList.toggle('modified', dirty());
    document.title = `${dirty() ? '• ' : ''}${S.source?.name ? S.source.name + ' - ' : ''}Contour`;
    const advanced = [];
    if (S.tracks.some(t => t.solo)) advanced.push('Solo');
    if (S.tracks.some(t => t.env.length)) advanced.push('Volume curves');
    if (S.loop) advanced.push(S.region ? 'Region loop' : 'Loop');
    if (S.nullTest) advanced.push('Null test');
    $('mix-indicator').hidden = !advanced.length || S.mode === 'studio'; text('mix-indicator', advanced.join(' · ') + ' → Studio');
    text('workflow-role', {simple:'Quick extraction',studio:'Mixer & detailed export',mashup:'Combine two songs'}[S.mode]);
    const rate = $('rate').value ? `${Number($('rate').value)/1000} kHz` : 'Source rate';
    const summary = `${$('format').selectedOptions[0]?.textContent || 'WAV'} · ${rate} · ${$('protect').checked ? '−1 dBFS' : 'No peak protection'}${$('range-only').checked ? ' · Loop region' : ''}${$('apply-curves').checked ? ' · Curves' : ''}`;
    document.querySelectorAll('.export-summary').forEach(el => { if (el.textContent !== summary) el.textContent = summary; });
    document.querySelectorAll('.mash-use').forEach(el => el.disabled = blocked || !S.source);
    $('simple-studio').disabled = !S.source;
  }
  function changed() {
    if (queued || applying) return;
    queued = true;
    queueMicrotask(() => {
      queued = false; if (applying || !S.source) { info(); return; }
      if (!gesture) history.push(editState());
      info(); if (dirty()) scheduleRecovery();
    });
  }
  function session(newAudio = true, saved = false) {
    if (newAudio) { audioRevision++; recoveryRevision = -1; }
    history.reset(editState());
    if (saved) S.savedMix = mixFingerprint();
    info(); if (dirty()) scheduleRecovery();
  }
  function audioChanged() { audioRevision++; recoveryRevision = -1; changed(); scheduleRecovery(); }
  function result() { audioRevision++; recoveryRevision = -1; S.savedMix = ''; history.reset(editState()); info(); scheduleRecovery(); }
  async function undo(delta) {
    if (S.busy || S.preflighting || MASH.pending) return;
    const state = history.move(delta); if (!state) return;
    applying = true;
    const oldMash = JSON.stringify(MASH.settings), oldLoop = S.loop, oldRegion = JSON.stringify(S.region), oldClips = JSON.stringify(S.tracks.map(t => t.clips));
    for (const meta of state.tracks) {
      const t = track(meta.id);
      if (!t) continue;
      Object.assign(t, { ...meta, env: meta.env.map(p => ({ ...p })), clips: meta.clips ? meta.clips.map(c => ({ ...c })) : null, fx: meta.fx ? { ...meta.fx } : t.fx });
      t.fxNode?.port.postMessage(t.fx); // the restored sound is heard at once
      if (t.send) t.send.gain.value = Math.pow(Math.max(0, Math.min(1, t.fx.space)), 1.5);
    }
    S.clipSel?.clear();
    // lane order and crossfade length come back too
    { const at = new Map(state.tracks.map((x, i) => [x.id, i])); S.tracks.sort((x, y) => (at.get(x.id) ?? 1e9) - (at.get(y.id) ?? 1e9)); }
    if (typeof state.xfade === 'number') S.xfade = state.xfade;
    S.region = state.region; S.loop = state.loop;
    $('loop').setAttribute('aria-pressed', String(S.loop));
    if (state.mash) { MASH.settings = { ...state.mash }; syncMashControls(); }
    renderAll(); applyMix(); rescheduleCurves();
    if (S.playing && (oldLoop !== S.loop || oldRegion !== JSON.stringify(S.region) || oldClips !== JSON.stringify(S.tracks.map(t => t.clips)))) restart();
    if (state.mash && oldMash !== JSON.stringify(MASH.settings)) {
      const a = JSON.parse(oldMash); delete a.vocal_gain_db; const b = { ...state.mash }; delete b.vocal_gain_db;
      if (JSON.stringify(a) !== JSON.stringify(b)) { MASH.revision++; MASH.pending = true; mashSchedule(0); }
    }
    applying = false; info(); scheduleRecovery(); status(delta < 0 ? 'Undone' : 'Redone');
  }
  async function canReplace(action = 'replace this session') {
    if (!dirty()) return true;
    return confirmAction('Unsaved changes', `Save your project first if you want to keep your current work. Continue and ${action}?`, 'Continue');
  }
  function options(open) {
    if (open) { exportReturn = document.activeElement; window.closeGlassSelects?.(); ContourMotion.show($('export-options'), true); $('close-export-options').focus(); }
    else { window.closeGlassSelects?.(); ContourMotion.show($('export-options'), false); exportReturn?.focus(); }
  }
  function exportSettings() {
    const range = rangeArgs(); if (range === undefined) return null;
    return { format: $('format').value, rate: $('rate').value ? Number($('rate').value) : null, protect: $('protect').checked, start: range[0], end: range[1], curves: $('apply-curves').checked };
  }
  async function useCurrent(slot) {
    if (!S.source || S.busy || S.preflighting) return;
    busyStart('Preparing current song', {cancellable:false});
    try {
      const request = workflowSnapshot('mashup');
      const info = await invoke('mashup_use_current', { slot, quality: request.request.quality, split: slot==='b' && request.split });
      invalidateMash(); mashShowSlot(slot, info); status('Current song ready for the mashup');
    } catch (e) { taskFailed('Use current song', e, () => useCurrent(slot)); }
    finally { busyEnd(); }
  }
  async function saveRecovery() {
    clearTimeout(recoveryTimer);
    if (!dirty() || !S.source || !recoveryPath) return;
    if (S.busy || S.preflighting || MASH.pending || savingRecovery || gesture) { scheduleRecovery(); return; }
    const fingerprint = mixFingerprint();
    if (lastRecoveryEdit === fingerprint && recoveryRevision === audioRevision) return;
    savingRecovery = true; busyStart('Saving recovery', {cancellable:false});
    const generation = audioRevision;
    try {
      if (recoveryRevision !== generation) {
        const target=lastRecoveryPath?lastRecoveryPath.replace(/[AB]\.contour$/,m=>m==='A.contour'?'B.contour':'A.contour'):recoveryPath;
        await invoke('save_project', {path:target, ui:projectState()});lastRecoveryPath=target;
      } else await invoke('recovery_update', {path:lastRecoveryPath,ui:projectState()});
      recoveryRevision = generation; lastRecoveryEdit = fingerprint;
      text('session-state', 'Recovery saved');status('Recovery saved');
    } catch (e) { status('Recovery could not be saved', 'error'); }
    finally { savingRecovery = false; busyEnd(); }
  }
  function scheduleRecovery() { clearTimeout(recoveryTimer); recoveryTimer = setTimeout(saveRecovery, 5000); }
  async function saved() {
    clearTimeout(recoveryTimer); $('recovery-banner').hidden=true; info();
    try { await invoke('recovery_clear'); recoveryRevision = -1; lastRecoveryPath=null; lastRecoveryEdit = ''; } catch { /* user project is already saved */ }
  }
  async function startup() {
    try {
      const data = await invoke('recovery_info'); recoveryPath = data.path;lastRecoveryPath=data.restore_path||null;
      if (data.available) {
        $('recovery-banner').hidden = false; text('recovery-name', `Recover ${data.name || 'your previous session'}?`);
        $('recover-session').onclick = async () => {
          await openProject(data.restore_path||data.path);
          if (S.projectPath === (data.restore_path||data.path)) { S.projectPath = null; S.savedMix = ''; recoveryRevision = audioRevision; $('recovery-banner').hidden = true; info(); }
        };
      }
    } catch { /* recovery unavailable: project saving still works */ }
  }
  function init() {
    $('simple-studio').onclick = $('mix-indicator').onclick = () => setMode('studio');
    $('undo').onclick = () => undo(-1); $('redo').onclick = () => undo(1);
    $('global-play').onclick = togglePlay;
    // Scrubbing: while dragging, move at most every 90 ms (smooth, no stutter); land exactly on release.
    let scrubTimer = 0, scrubAt = 0;
    $('global-seek').oninput = e => {
      scrubAt = Number(e.target.value) / 1000 * duration();
      if (!S.playing) { S.pos = scrubAt; frame(); return; }
      if (!scrubTimer) scrubTimer = setTimeout(() => { scrubTimer = 0; seekTo(scrubAt); }, 90);
    };
    $('global-seek').onchange = e => { clearTimeout(scrubTimer); scrubTimer = 0; seekTo(Number(e.target.value) / 1000 * duration()); };
    document.querySelectorAll('.export-options-open').forEach(b => b.onclick = () => options(true));
    $('close-export-options').onclick = () => options(false);
    $('export-options').onclick = e => { if (e.target === $('export-options')) options(false); };
    document.querySelectorAll('.mash-use').forEach(b => b.onclick = () => useCurrent(b.closest('.mash-slot').dataset.slot));
    $('dismiss-recovery').onclick = async () => { $('recovery-banner').hidden = true; await invoke('recovery_clear').catch(() => {}); };
    document.querySelectorAll('#format,#rate,#protect,#range-only,#apply-curves').forEach(el => el.addEventListener('change', () => { savePrefs(); info(); }));
    // A pointer gesture is one history entry, regardless of how many input/move events it sends.
    document.addEventListener('pointerdown', e => { if (e.target.matches('#lanes input,#lanes canvas,#ruler,#mash-nudge,#mash-gain')) gesture = true; }, true);
    window.addEventListener('pointerup', () => { if (gesture) { gesture = false; changed(); } });
    window.addEventListener('blur', () => { if (gesture) { gesture = false; changed(); } });
    document.addEventListener('input', e => { if (e.target.matches('#lanes input,#mash-nudge,#mash-gain')) changed(); });
    document.addEventListener('click', e => { if (e.target.closest('#lanes,#simple-results,#mash-result,#loop,#null')) changed(); });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') {
        if ($('confirm-dialog').open) return;
        const list = document.querySelector('.select-trigger[aria-expanded=true]');
        if (list) { window.closeGlassSelects(); list.focus(); }
        else if (!$('menu').hidden) closeMenu();
        else if (!$('export-options').hidden && !$('export-options').inert) options(false);
        else if (!$('models-modal').hidden && !$('models-modal').inert) closeModels();
        else if ($('studio').classList.contains('drawer-open')) $('export-drawer').click();
        else if (S.region) { S.region = null; if(S.playing && S.loop)restart(); drawStudio(); changed(); }
        else return;
        e.preventDefault(); e.stopImmediatePropagation(); return;
      }
      if ($('confirm-dialog').open || (!$('models-modal').hidden && !$('models-modal').inert) || (!$('export-options').hidden && !$('export-options').inert) || !$('setup').hidden) return;
      if (e.ctrlKey || e.metaKey) {
        const key = e.key.toLowerCase();
        if (['s','o','z','y'].includes(key)) {
          if (e.target.matches('textarea,input[type=text],[contenteditable=true]') && ['z','y'].includes(key)) return;
          e.preventDefault(); e.stopImmediatePropagation();
          if (key === 's') saveProject(e.shiftKey);
          if (key === 'o') openProject();
          if (key === 'z' || key === 'y') undo(key === 'y' || e.shiftKey ? 1 : -1);
        }
      }
    }, true);
    window.contourCanClose = async () => {
      if (S.busy) return confirmAction('Close Contour?', 'The current task has not finished. Close the app anyway?', 'Close');
      if (!await canReplace('close Contour')) return false;
      return true;
    };
    window.addEventListener('beforeunload', e => { if (!window.__TAURI__?.window && dirty()) { e.preventDefault(); e.returnValue = ''; } });
    document.addEventListener('visibilitychange', () => {
      window.ContourBackground?.set({paused:document.hidden || S.busy});
      if (document.hidden) cancelAnimationFrame(S.raf); else if (S.playing) { S.lastFrame = 0; tick(); }
    });
    info();
  }
  window.ContourProduct = {init,info,changed,session,result,audioChanged,saved,startup,canReplace,exportSettings,useCurrent,history,undo,saveRecovery,dirty,editState,text};
})();
