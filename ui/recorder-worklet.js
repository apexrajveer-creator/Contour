// Contour · microphone recorder on the audio thread.
// Runs in the AudioWorklet, so the interface drawing can never delay or drop recorded audio. Every
// chunk carries the context frame it started at, so the take is rebuilt sample-accurately.
class ContourRecorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(8192);
    this.n = 0;
    this.start = 0;
    this.on = true;
    this.port.onmessage = e => { if (e.data === 'stop') { this.flush(); this.on = false; } };
  }
  flush() {
    if (!this.n) return;
    const data = this.buf.slice(0, this.n);
    this.port.postMessage({ frame: this.start, data }, [data.buffer]);
    this.n = 0;
  }
  process(inputs) {
    if (!this.on) return false;
    const ch = inputs[0] && inputs[0][0];
    if (ch && ch.length) {
      if (this.n === 0) this.start = currentFrame;
      else if (currentFrame !== this.start + this.n) { this.flush(); this.start = currentFrame; } // keep stamps exact
      this.buf.set(ch, this.n);
      this.n += ch.length;
      if (this.n + 128 > this.buf.length) this.flush();
    }
    return true;
  }
}
registerProcessor('contour-recorder', ContourRecorder);
