// Contour · easter egg: type "tune" anywhere to hear yourself, live and hard-tuned, in your headphones.
'use strict';
(() => {
  const LT = { typed: '', at: 0, nullBefore: null, ctx: null, node: null, stream: null, on: false };
  const NOTES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
  const card = document.getElementById('livetune'), $l = id => document.getElementById(id);

  // ── the trigger: t-u-n-e typed within a couple of seconds, outside text fields ──
  document.addEventListener('keydown', e => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
    if (e.target.closest?.('input:not([type=range]):not([type=checkbox]),select,textarea,[contenteditable]')) return;
    const k = e.key.toLowerCase();
    if (!/^[a-z]$/.test(k)) return;
    const now = performance.now();
    if (now - LT.at > 1800) LT.typed = '';
    if (LT.typed === '' && k === 't') LT.nullBefore = typeof S !== 'undefined' ? S.nullTest : null;
    LT.typed = (LT.typed + k).slice(-4);
    LT.at = now;
    if (LT.typed === 'tune') {
      LT.typed = '';
      // the "n" in "tune" is also the Null test shortcut: undo that side effect
      if (LT.nullBefore != null && typeof S !== 'undefined' && S.nullTest !== LT.nullBefore) document.getElementById('null')?.click();
      openCard();
    }
  }, true);

  function openCard() {
    card.hidden = false;
    requestAnimationFrame(() => card.classList.add('open'));
    $l('lt-phones').focus();
    hint();
  }
  function closeCard() { stop(); card.classList.remove('open'); setTimeout(() => (card.hidden = true), 220); }
  function hint(msg) {
    $l('lt-hint').textContent = msg || 'Headphones only: speakers would feed back.';
  }

  async function start() {
    if (!$l('lt-phones').checked) { hint('Put on headphones and tick the box first.'); return; }
    if (typeof K !== 'undefined' && K.singing) { hint('Finish singing first, then try this.'); return; }
    try {
      LT.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, latency: 0 } });
      // its own context, tuned for the lowest latency the device allows
      LT.ctx = new AudioContext({ latencyHint: 'interactive' });
      await LT.ctx.audioWorklet.addModule('tune-worklet.js');
      LT.node = new AudioWorkletNode(LT.ctx, 'contour-live-tune', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
      LT.node.port.onmessage = e => show(e.data);
      sync();
      LT.ctx.createMediaStreamSource(LT.stream).connect(LT.node).connect(LT.ctx.destination);
      await LT.ctx.resume();
      LT.on = true;
      const label = LT.stream.getAudioTracks()[0]?.label || '';
      const inLat = LT.stream.getAudioTracks()[0]?.getSettings?.().latency || 0;
      const ms = Math.round(((LT.ctx.baseLatency || 0) + (LT.ctx.outputLatency || 0) + inLat + 0.0125) * 1000);
      $l('lt-start').textContent = 'Stop';
      $l('lt-latency').textContent = `≈ ${ms} ms`;
      hint('Sing. You\'re snapped to the nearest note.'); void label;
    } catch (err) {
      stop();
      hint(/addModule|worklet/i.test(String(err)) ? 'This needs the desktop app.' : 'Contour needs microphone access for this.');
    }
  }
  function stop() {
    LT.on = false;
    try { LT.node?.disconnect(); } catch { /* gone */ }
    LT.stream?.getTracks().forEach(t => t.stop());
    LT.ctx?.close().catch(() => {});
    LT.ctx = LT.node = LT.stream = null;
    $l('lt-start').textContent = 'Start';
    $l('lt-note').textContent = '-';
    $l('lt-cents').style.transform = 'translateX(0)';
    $l('lt-latency').textContent = '';
  }
  function sync() { LT.node?.port.postMessage({ strength: +$l('lt-strength').value / 100, shimmer: $l('lt-shimmer').checked }); }
  function show({ note, level }) {
    if (!LT.on) return;
    $l('lt-note').textContent = note ? `${NOTES[((note.midi % 12) + 12) % 12]}${Math.floor(note.midi / 12) - 1}` : '-';
    $l('lt-cents').style.transform = `translateX(${note ? Math.max(-50, Math.min(50, note.cents)) : 0}px)`;
    $l('lt-level').style.transform = `scaleX(${Math.min(1, level * 3).toFixed(3)})`;
  }

  $l('lt-start').onclick = () => (LT.on ? stop() : start());
  $l('lt-close').onclick = closeCard;
  $l('lt-strength').oninput = e => { $l('lt-strength-v').textContent = `${e.target.value}%`; sync(); };
  $l('lt-shimmer').onchange = sync;
  card.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); closeCard(); } });
  window.addEventListener('beforeunload', stop);
})();
