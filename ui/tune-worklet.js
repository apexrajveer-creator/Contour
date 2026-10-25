// Contour · live tune (easter egg). Runs entirely on the audio thread for minimal latency:
// YIN pitch tracking → snap to the nearest semitone → a two-tap delay-line pitch shifter
// (~12 ms of added delay), plus an optional slightly detuned double for shimmer.
class ContourLiveTune extends AudioWorkletProcessor {
  constructor() {
    super();
    this.N = 16384;
    this.buf = new Float32Array(this.N);
    this.w = 0;
    this.strength = 1;
    this.shimmer = true;
    this.ratio = 1;
    this.target = 1;
    this.p1 = 0;
    this.p2 = 0.37;
    this.W = Math.round(0.025 * sampleRate); // shifter window: latency ≈ W / 2
    this.sinceDetect = 0;
    this.hist = [0, 0, 0];
    this.level = 0;
    this.gate = 0;
    this.sincePost = 0;
    this.note = null;
    this.port.onmessage = e => {
      const d = e.data || {};
      if (typeof d.strength === 'number') this.strength = Math.max(0, Math.min(1, d.strength));
      if (typeof d.shimmer === 'boolean') this.shimmer = d.shimmer;
    };
  }
  detect() {
    // YIN on the last 2048 input samples, decimated by 2
    const n = 2048, half = n >> 1, fs = sampleRate / 2, win = 300;
    const d = new Float32Array(half);
    for (let i = 0; i < half; i++) {
      const j = (this.w - n + 2 * i + this.N * 2) % this.N;
      d[i] = 0.5 * (this.buf[j] + this.buf[(j + 1) % this.N]);
    }
    let e = 0;
    for (let i = 0; i < win; i++) e += d[i] * d[i];
    if (Math.sqrt(e / win) < 0.008) return 0;
    const tmin = Math.floor(fs / 1000), tmax = Math.min(half - win - 2, Math.ceil(fs / 70));
    const cm = new Float32Array(tmax + 2);
    let run = 0;
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
        const sh = Math.abs(den) > 1e-9 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den)) : 0;
        return fs / (tau + sh);
      }
    }
    return 0;
  }
  read(delay) {
    // linear-interpolated read `delay` samples behind the write head
    const pos = this.w - delay;
    const i = Math.floor(pos), f = pos - i;
    const a = this.buf[(i + this.N * 4) % this.N], b = this.buf[(i + 1 + this.N * 4) % this.N];
    return a + (b - a) * f;
  }
  process(inputs, outputs) {
    const inp = inputs[0] && inputs[0][0], out = outputs[0];
    if (!out || !out[0]) return true;
    const L = out[0], R = out[1] || out[0], n = L.length, W = this.W;
    const glide = 1 - Math.exp(-1 / (0.006 * sampleRate)); // ~6 ms snap: the hard-tuned sound
    for (let i = 0; i < n; i++) {
      const x = inp ? inp[i] : 0;
      this.buf[this.w % this.N] = x;
      this.w++;
      this.level = Math.max(Math.abs(x), this.level * 0.9995);
      this.ratio += (this.target - this.ratio) * glide;
      // two taps, half a window apart, crossfaded with sin² windows (they always sum to 1)
      const step = (1 - this.ratio) / W;
      this.p1 = (this.p1 + step + 1) % 1;
      const q1 = (this.p1 + 0.5) % 1;
      const g1 = Math.sin(Math.PI * this.p1) ** 2, g2 = 1 - g1;
      let y = this.read(this.p1 * W + 1) * g1 + this.read(q1 * W + 1) * g2;
      if (this.shimmer) {
        // a second voice 9 cents up, its own window phase: a gentle doubled shimmer
        const r2 = this.ratio * 1.0052;
        this.p2 = (this.p2 + (1 - r2) / W + 1) % 1;
        const q2 = (this.p2 + 0.5) % 1, h1 = Math.sin(Math.PI * this.p2) ** 2;
        y = 0.72 * y + 0.38 * (this.read(this.p2 * W + 1 + 220) * h1 + this.read(q2 * W + 1 + 220) * (1 - h1));
      }
      // a soft gate keeps the room quiet between phrases; a soft clip keeps peaks safe
      this.gate += ((this.level > 0.01 ? 1 : 0) - this.gate) * 0.002;
      y *= this.gate;
      y = Math.tanh(1.4 * y) / 1.4;
      L[i] = y;
      if (R !== L) R[i] = y;
    }
    this.sinceDetect += n;
    if (this.sinceDetect >= 512) {
      this.sinceDetect = 0;
      const f = this.detect();
      this.hist.shift(); this.hist.push(f);
      const voiced = this.hist.filter(v => v > 0).sort((a, b) => a - b);
      const f0 = voiced.length >= 2 ? voiced[voiced.length >> 1] : 0;
      if (f0 > 0) {
        const m = 69 + 12 * Math.log2(f0 / 440), tm = Math.round(m);
        this.target = Math.pow(2, ((tm - m) / 12) * this.strength);
        this.note = { midi: tm, cents: Math.round((m - tm) * 100) };
      } else {
        this.target = 1;
        this.note = null;
      }
    }
    this.sincePost += n;
    if (this.sincePost >= sampleRate / 12) {
      this.sincePost = 0;
      this.port.postMessage({ note: this.note, level: this.level });
    }
    return true;
  }
}
registerProcessor('contour-live-tune', ContourLiveTune);
