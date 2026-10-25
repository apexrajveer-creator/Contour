// Shared workflow primitives, also executable in Node for regression tests.
(function(root) {
  'use strict';
  class PhaseClock {
    constructor() { this.stage = null; this.start = 0; this.last = 0; this.base = 0; }
    sample(overall, stage, detail, now) {
      // The engine's detail percentage is local to a model/stage; overall progress may
      // reset after downloading or when the second song begins. Never extrapolate it.
      const match = /^\s*(\d+(?:\.\d+)?)%\s*$/.exec(detail || '');
      const local = match ? Number(match[1]) / 100 : null;
      if (stage !== this.stage || (local != null && local < this.last)) {
        this.stage = stage; this.start = now; this.base = local ?? 0;
      }
      this.last = local ?? 0;
      const elapsed = (now - this.start) / 1000, advanced = local == null ? 0 : local - this.base;
      const allowed = !/download|prepar|analys|cancel|done|fallback|continuing/i.test(stage);
      return { remaining: allowed && elapsed >= 5 && advanced >= .08 && local < .98 ? Math.max(0, elapsed * (1 - local) / advanced) : null };
    }
  }
  function defaultMashSettings() { return { semitones: null, tempo: 'auto', bar_offset: 0, beat_offset: 0, nudge_ms: 0, vocal_gain_db: 0, lock_beats: true }; }
  class EditHistory {
    constructor(limit = 64) { this.limit = limit; this.entries = []; this.index = -1; }
    reset(value) { this.entries = [JSON.stringify(value)]; this.index = 0; }
    push(value) {
      const text = JSON.stringify(value);
      if (this.entries[this.index] === text) return false;
      this.entries.splice(this.index + 1); this.entries.push(text);
      if (this.entries.length > this.limit) this.entries.shift();
      this.index = this.entries.length - 1; return true;
    }
    move(delta) { const next = this.index + delta; if (next < 0 || next >= this.entries.length) return null; this.index = next; return JSON.parse(this.entries[next]); }
    get canUndo() { return this.index > 0; }
    get canRedo() { return this.index + 1 < this.entries.length; }
  }
  const api = { PhaseClock, defaultMashSettings, EditHistory };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ContourWorkflow = api;
})(typeof window === 'undefined' ? globalThis : window);
