// Contour · the header's live wave: three thin lines in the icon's colours. They flow while audio
// plays (a little livelier with the music's loudness) and ease down to a calm, still line when it
// stops. Animates only while something is changing; pauses in the background; still for reduced motion.
'use strict';
(() => {
  const cv = document.getElementById('brand-wave');
  if (!cv) return;
  const g = cv.getContext('2d');
  const COLORS = ['#a6ecff', '#4ea6ff', '#b383ff']; // the icon's cyan, blue and violet
  const REST = 0.12;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  let amp = REST, phase = 0, level = 0, last = 0, raf = 0, W = 0, H = 0;
  const size = () => {
    const r = cv.getBoundingClientRect(), dpr = Math.min(2, devicePixelRatio || 1);
    W = r.width; H = r.height;
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  const loudness = () => {
    const an = typeof S !== 'undefined' && S.masterAn;
    if (!an) return 0;
    const buf = (loudness.buf ||= new Float32Array(an.fftSize));
    an.getFloatTimeDomainData(buf);
    let s = 0; for (let i = 0; i < buf.length; i += 4) s += buf[i] * buf[i];
    return Math.sqrt(s / (buf.length / 4));
  };
  const draw = () => {
    if (!W) size();
    g.clearRect(0, 0, W, H);
    const mid = H / 2;
    COLORS.forEach((col, i) => {
      const y0 = mid + (i - 1) * 5.2, a = amp * (H * 0.16) * (1 - i * 0.12), k = (Math.PI * 2) / (W * 0.55);
      g.beginPath();
      for (let x = 0; x <= W; x += 1.5) {
        const y = y0 + Math.sin(x * k + phase + i * 0.7) * a;
        x ? g.lineTo(x, y) : g.moveTo(x, y);
      }
      g.strokeStyle = col; g.lineWidth = 1.6; g.lineCap = 'round'; g.globalAlpha = 0.95;
      g.stroke();
    });
    // soft ends, so the lines dissolve instead of stopping
    g.globalAlpha = 1; g.globalCompositeOperation = 'destination-in';
    const fade = g.createLinearGradient(0, 0, W, 0);
    fade.addColorStop(0, 'rgba(0,0,0,0)'); fade.addColorStop(0.18, '#000'); fade.addColorStop(0.82, '#000'); fade.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = fade; g.fillRect(0, 0, W, H);
    g.globalCompositeOperation = 'source-over';
  };
  const playing = () => typeof S !== 'undefined' && !!S.playing;
  const tick = now => {
    raf = 0;
    const dt = Math.min(0.05, last ? (now - last) / 1000 : 0.016);
    last = now;
    const on = playing();
    level += ((on ? loudness() : 0) - level) * Math.min(1, dt * 6);
    const target = on ? 0.55 + 0.45 * Math.min(1, level * 4) : REST;
    amp += (target - amp) * Math.min(1, dt * 3.2);
    if (on) phase += dt * (1.6 + level * 3);
    draw();
    if (on || Math.abs(amp - target) > 0.002) raf = requestAnimationFrame(tick); // rest when nothing changes
    else last = 0;
  };
  const wake = () => { if (!raf && !reduced.matches && !document.hidden) raf = requestAnimationFrame(tick); };
  // a cheap check for playback starting or stopping; the animation itself runs only while needed
  setInterval(() => { if (playing() || Math.abs(amp - REST) > 0.002) wake(); }, 250);
  document.addEventListener('visibilitychange', wake);
  window.addEventListener('resize', () => { size(); draw(); });
  reduced.addEventListener?.('change', () => { amp = reduced.matches ? 0.35 : amp; draw(); });
  if (reduced.matches) amp = 0.35; // a gentle, still wave
  requestAnimationFrame(() => { size(); draw(); });
})();
