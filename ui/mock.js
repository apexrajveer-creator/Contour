// Browser preview only. Inside the desktop app window.__TAURI__ exists and this file does nothing.
// Synthesises a 24-second song with real stems so the interface can be explored without the engine.
(() => {
  if (window.__TAURI__) return;
  const SR = 44100, DUR = 24, N = SR * DUR, BPM = 108, BEAT = 60 / BPM;
  const listeners = {};
  const emit = (ev, payload) => (listeners[ev] || []).forEach(f => f({ payload }));
  const hz = m => 440 * Math.pow(2, (m - 69) / 12);
  const chords = [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]]; // Am F C G
  const chordAt = t => chords[Math.floor(t / (BEAT * 4)) % 4];
  let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;

  function make(fn, width = 0.3) {
    const L = new Float32Array(N), R = new Float32Array(N);
    fn(L, R);
    if (width) for (let i = 0; i < N; i++) { const m = (L[i] + R[i]) / 2, s = (L[i] - R[i]) / 2 * (1 + width); L[i] = m + s; R[i] = m - s; }
    return [L, R];
  }
  const parts = {};
  parts.drums = make((L, R) => {
    for (let b = 0; b * BEAT < DUR; b++) {
      const t0 = Math.floor(b * BEAT * SR);
      for (let i = 0; i < SR * 0.35 && t0 + i < N; i++) { const t = i / SR; const v = Math.sin(2 * Math.PI * (45 + 90 * Math.exp(-t * 30)) * t) * Math.exp(-t * 9) * 0.55; L[t0 + i] += v; R[t0 + i] += v; }
      if (b % 2 === 1) for (let i = 0; i < SR * 0.18 && t0 + i < N; i++) { const t = i / SR, v = rnd() * Math.exp(-t * 22) * 0.32; L[t0 + i] += v; R[t0 + i] += v * 0.8; }
      for (let h = 0; h < 2; h++) { const s0 = t0 + Math.floor(h * BEAT / 2 * SR); for (let i = 0; i < SR * 0.04 && s0 + i < N; i++) { const v = rnd() * Math.exp(-i / SR * 90) * 0.12; L[s0 + i] += v * 0.6; R[s0 + i] += v; } }
    }
  }, 0);
  parts.bass = make((L, R) => {
    let ph = 0;
    for (let i = 0; i < N; i++) { const t = i / SR, f = hz(chordAt(t)[0] - 24 + (Math.floor(t / (BEAT * 2)) % 2 ? 7 : 0)); ph += 2 * Math.PI * f / SR; const env = 0.6 + 0.4 * Math.exp(-((t % BEAT) * 6)); const v = (Math.sin(ph) + 0.25 * Math.sin(2 * ph)) * 0.3 * env; L[i] = v; R[i] = v; }
  }, 0);
  parts.guitar = make((L, R) => {
    for (let s = 0; s * BEAT / 2 < DUR; s++) {
      const t0 = Math.floor(s * BEAT / 2 * SR), ch = chordAt(s * BEAT / 2), f = hz(ch[s % 3] + 12);
      for (let i = 0; i < SR * 0.6 && t0 + i < N; i++) { const t = i / SR, v = ((t * f % 1) * 2 - 1) * Math.exp(-t * 6) * 0.07; L[t0 + i] += v * 1.2; R[t0 + i] += v * 0.5; }
    }
  });
  parts.piano = make((L, R) => {
    for (let c = 0; c * BEAT * 4 < DUR; c++) {
      const t0 = Math.floor(c * BEAT * 4 * SR), ch = chords[c % 4];
      for (const m of ch) { const f = hz(m); for (let i = 0; i < SR * BEAT * 4 && t0 + i < N; i++) { const t = i / SR, v = (Math.sin(2 * Math.PI * f * t) + 0.3 * Math.sin(4 * Math.PI * f * t)) * Math.exp(-t * 1.4) * 0.06; L[t0 + i] += v * 0.6; R[t0 + i] += v * 1.1; } }
    }
  });
  parts.other = make((L, R) => {
    for (let i = 0; i < N; i++) { const t = i / SR, ch = chordAt(t); let v = 0; for (const m of ch) v += Math.sin(2 * Math.PI * hz(m - 12) * t + Math.sin(t * 0.7)); v *= 0.025 * (0.6 + 0.4 * Math.sin(t * 0.5)); L[i] = v; R[i] = v * 0.9; }
  });
  const melody = [69, 72, 74, 72, 69, 67, 69, 64, 65, 67, 69, 72, 71, 69, 67, 69];
  function voice(L, R, shift, gain, onlyChorus) {
    let ph = 0;
    for (let i = 0; i < N; i++) {
      const t = i / SR, bar = Math.floor(t / (BEAT * 4)), phrase = Math.floor(t / (BEAT * 8)) % 2;
      if (t < BEAT * 8 || (onlyChorus && bar % 4 < 2)) continue;
      const step = Math.floor(t / BEAT) % 16, inNote = (t % BEAT) / BEAT;
      if (phrase === 1 && step > 12) continue;
      const f = hz(melody[step] + shift) * (1 + 0.006 * Math.sin(2 * Math.PI * 5.5 * t));
      ph += 2 * Math.PI * f / SR;
      const env = Math.min(1, inNote * 12) * (1 - Math.max(0, inNote - 0.8) * 4);
      const v = (Math.sin(ph) + 0.5 * Math.sin(2 * ph) + 0.25 * Math.sin(3 * ph) + 0.12 * Math.sin(5 * ph)) * gain * env;
      L[i] += v; R[i] += v;
    }
  }
  parts.lead_dry = make((L, R) => voice(L, R, 0, 0.13, false), 0);
  parts.backing = make((L, R) => { voice(L, R, -5, 0.04, true); voice(R, L, 3, 0.035, true); }, 0.6);
  parts.lead_reverb = make((L, R) => {
    const d = parts.lead_dry; let l = 0, r = 0;
    for (let i = 0; i < N; i++) { const a = i - 4400, b = i - 6100; const x = (a > 0 ? d[0][a] : 0) * 0.35 + (b > 0 ? d[1][b] : 0) * 0.25; l = l * 0.82 + x * 0.18; r = r * 0.86 + x * 0.14; L[i] = l; R[i] = r; }
  }, 0);
  const sum = (...xs) => [0, 1].map(c => { const o = new Float32Array(N); for (const x of xs) for (let i = 0; i < N; i++) o[i] += x[c][i]; return o; });
  const lead = sum(parts.lead_dry, parts.lead_reverb);
  const vocals = sum(lead, parts.backing);
  const instrumental = sum(parts.drums, parts.bass, parts.guitar, parts.piano, parts.other);
  const original = sum(vocals, instrumental);
  const peaks = (a, cols = 1600) => { const out = []; for (let k = 0; k < cols; k++) { let p = 0; for (let i = Math.floor(k * N / cols); i < Math.floor((k + 1) * N / cols); i++) p = Math.max(p, Math.abs(a[0][i]), Math.abs(a[1][i])); out.push(Math.min(1, p)); } return out; };
  const store = { original };
  let current = [], cancelled = false, currentSource = null, savedProject = null;
  const projects = new Map(); let lastRecovery = null;
  const slots = { a: null, b: null };
  const demoSource = () => ({ name: 'Demo song (synthesised).wav', path: 'demo-song.wav', duration: DUR, rate: 48000, channels: 2, peaks: peaks(original) });
  const MODELS = [
    ['voc_ft', 'UVR-MDX-NET Voc FT', 'Vocals', 66.8e6], ['mel_roformer', 'Mel-Band RoFormer (Kim)', 'Max quality vocals', 464.1e6], ['kim_vocal_2', 'Kim Vocal 2', 'Vocals', 66.8e6], ['kara_2', 'UVR-MDX-NET Karaoke 2', 'Lead / backing', 52.8e6],
    ['reverb_hq', 'Reverb HQ (FoxJoy)', 'De-reverb', 66.8e6], ['htdemucs', 'HT-Demucs 4-stem', 'Drums · bass · other', 165.6e6], ['htdemucs_6s', 'HT-Demucs 6-stem', 'Adds guitar · piano', 136.4e6],
  ].map(([id, label, role, size]) => ({ id, label, role, size, present: id === 'voc_ft' }));

  let handlers;
  handlers = {
    app_info: () => ({ version: '1.1.0-preview', models_dir: 'Browser preview: synthetic engine', devices: ['auto', 'cpu'], threads: navigator.hardwareConcurrency || 4, launch_file: null, autorun: false }),
    pick_audio: () => 'demo-song.wav', pick_folder: () => '~/Music/Stems', reveal: () => null, clear_audio: () => { current = []; currentSource = null; slots.a = slots.b = null; }, cancel: () => { cancelled = true; },
    load_audio: async () => { await new Promise(r => setTimeout(r, 300)); current = []; currentSource = demoSource(); store.original = original; return currentSource; },
    estimate: ({ request }) => ({ seconds: request.quality === 'max' ? 140 : request.quality === 'fast' ? 25 : 45, calibrated: false }),
    core_models: () => MODELS.filter(x => ['voc_ft','mel_roformer','htdemucs','htdemucs_6s','kara_2'].includes(x.id)),
    models_prepare: async () => { await new Promise(r => setTimeout(r, 500)); },
    exit_app: () => null,
    pick_project_save: ({ name }) => `~/Music/${name}.contour`,
    pick_project_open: () => '~/Music/Demo song.contour',
    save_project: ({ path, ui }) => { if(path.includes('/Recovery/'))window.__mock.fullSaves++; const saved={ ui: structuredClone(ui), source: currentSource, stems: current, audio: { ...store } };projects.set(path,saved);if(path.includes('/Recovery/'))lastRecovery=path;else savedProject=saved;return path; },
    open_project: ({path}) => { const saved=projects.get(path)||savedProject;if(!saved)throw 'No project saved in this preview.';Object.assign(store,saved.audio);currentSource=saved.source;current=saved.stems;return {source:currentSource,stems:current,ui:saved.ui}; },
    recovery_info:()=>({path:lastRecovery?.endsWith('A.contour')?'~/Contour/Recovery/B.contour':'~/Contour/Recovery/A.contour',restore_path:lastRecovery,available:!!lastRecovery,name:currentSource?.name}),
    recovery_update:({path,ui})=>{window.__mock.updates++;const saved=projects.get(path);if(saved)saved.ui=structuredClone(ui);},
    recovery_clear:()=>{for(const key of projects.keys())if(key.includes('/Recovery/'))projects.delete(key);lastRecovery=null;},
    mashup_use_current:({slot})=>{const value={name:currentSource?.name||'Current song',duration:DUR,bpm:BPM,key:'A minor',peaks:peaks(original)};slots[slot]=value;return value;},
    models_storage: () => ['Browser preview', 0],
    mashup_load: async ({ slot }) => {
      await new Promise(r => setTimeout(r, 300));
      const info = slot === 'a' ? { name: 'Song A (vocals).wav', duration: DUR, bpm: 96.4, key: 'A minor', peaks: peaks(vocals) } : { name: 'Song B (music).wav', duration: DUR, bpm: 108, key: 'C major', peaks: peaks(instrumental) };
      slots[slot] = info; return info;
    },
    mashup_swap: () => { [slots.a, slots.b] = [slots.b, slots.a]; return [slots.a, slots.b]; },
    mashup_build: async ({ settings }) => {
      cancelled = false;
      for (let k = 0; k <= 20; k++) {
        if (cancelled) throw 'cancelled';
        emit('progress', { fraction: k / 20, stage: k < 10 ? 'Vocals song · UVR-MDX-NET Voc FT' : 'Music song · UVR-MDX-NET Voc FT', detail: `${k < 10 ? k * 10 : (k - 10) * 10}%` });
        await new Promise(r => setTimeout(r, 90));
      }
      const result = await handlers.mashup_render({ settings });
      if (cancelled) throw 'cancelled';
      return result;
    },
    mashup_render: async ({ settings }) => {
      await new Promise(r => setTimeout(r, 250));
      store.vocals = vocals; store.instrumental = instrumental; store.music_a = instrumental; store.vocals_b = vocals; store.original = original;
      const semis = settings.semitones ?? 0, m = settings.tempo === 'half' ? 0.5 : settings.tempo === 'double' ? 2 : 1;
      const keys = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
      const plan = { vocal_bpm: 96.4, music_bpm: 108, tempo_factor: m, stretch_percent: (108 / (96.4 * m) - 1) * 100, semitones: semis, auto_semitones: 0, vocal_key: 'A minor', shifted_key: keys[(9 + semis + 120) % 12] + ' minor', music_key: 'C major', fit: semis === 0 ? 'relative key' : 'neighbouring key', entry: 4.44 + (settings.bar_offset * 4 + settings.beat_offset) * 60 / 108 + settings.nudge_ms / 1000, gain_db: 1.2 + settings.vocal_gain_db, locked_beats: settings.lock_beats ? 38 : 0 };
      const result = { backend: 'Preview engine', notes: [], plan, a: { name: 'Song A (vocals).wav', duration: DUR, bpm: 96.4, key: 'A minor', peaks: peaks(vocals) }, b: { name: 'Song B (music).wav', duration: DUR, bpm: 108, key: 'C major', peaks: peaks(instrumental) },
        source: { name: 'Song A × Song B', path: 'b.wav', duration: DUR, rate: 44100, channels: 2, peaks: peaks(original) },
        stems: [{ id: 'vocals', label: 'Vocals · Song A', kind: 'vocal', leaf: true, peaks: peaks(vocals) }, { id: 'music_a', label: 'Music · Song A', kind: 'music', leaf: true, peaks: peaks(instrumental) }, { id: 'vocals_b', label: 'Vocals · Song B', kind: 'vocal', leaf: true, peaks: peaks(vocals) }, { id: 'instrumental', label: 'Music · Song B', kind: 'music', leaf: true, peaks: peaks(instrumental) }] };
      current = result.stems; currentSource = result.source; return result;
    },
    vocal_melody: () => {
      // the preview's stand-in: track the synthetic vocal with the same detector the app uses live
      const v = store.vocals, step = SR / 100, hz = [];
      for (let i = 0; i + 2048 < N; i += step) hz.push(typeof yinPitch === 'function' ? yinPitch(v[0].subarray(i, i + 2048), SR) : 0);
      return { hz, fps: 100, key: 'A minor' };
    },
    add_take: (body, opts) => {
      const take = new Float32Array(body.buffer ? body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) : body), off = +(opts?.headers?.['x-offset'] || 0);
      const ch = new Float32Array(N);
      for (let i = 0; i < take.length; i++) { const d = off + i; if (d >= 0 && d < N) ch[d] = take[i]; }
      store.take = [ch, ch];
      return { id: 'take', label: 'Your take', kind: 'take', leaf: true, peaks: peaks(store.take) };
    },
    tune_take: async ({ settings }) => {
      // preview stand-in (the real tuning runs in the engine): pitch curves from the take, nudged to semitones
      await new Promise(r => setTimeout(r, 400));
      const take = store.take, step = SR / 100, sung = [], target = [], tuned = [];
      for (let i = 0; i + 2048 < N; i += step) {
        const f = typeof yinPitch === 'function' ? yinPitch(take[0].subarray(i, i + 2048), SR) : 0;
        const m = f > 0 ? 69 + 12 * Math.log2(f / 440) : 0, t = f > 0 ? Math.round(m) : 0;
        sung.push(f); target.push(f > 0 ? 440 * Math.pow(2, (t - 69) / 12) : 0);
        tuned.push(f > 0 ? 440 * Math.pow(2, (m + (t - m) * settings.strength - 69) / 12) : 0);
      }
      store.take_tuned = take;
      return { stem: { id: 'take_tuned', label: 'Your take (tuned)', kind: 'take', leaf: true, peaks: peaks(take) },
        curves: { sung, target, tuned, fps: 100, in_tune_before: 0.31, in_tune_after: 0.3 + 0.6 * settings.strength } };
    },
    import_take: async () => {
      // preview stand-in: a "take" that follows the vocal a fifth higher, placed by the same rule
      await new Promise(r => setTimeout(r, 300));
      const v = store.vocals[0], ch = new Float32Array(N);
      let ph = 0;
      for (let i = 0; i < N; i++) { const a = Math.abs(v[i]); if (a < 0.002) continue; ph += 2 * Math.PI * 330 / SR; ch[i] = 0.25 * Math.sin(ph) * Math.min(1, a * 6); }
      store.take = [ch, ch];
      return { stem: { id: 'take', label: 'Your take', kind: 'take', leaf: true, peaks: peaks(store.take) }, offset: 0 };
    },
    add_lane: async ({ path }) => {
      await new Promise(r => setTimeout(r, 200));
      let k = 1; while (store['lane_' + k]) k++;
      const id = 'lane_' + k, ch = new Float32Array(N);
      for (let i = 0; i < N; i++) ch[i] = 0.15 * Math.sin(2 * Math.PI * 523.25 * i / SR) * (Math.sin(i / SR * 3) > 0 ? 1 : 0);
      store[id] = [ch, ch];
      return { id, label: 'Added sample', kind: 'lane', leaf: true, peaks: peaks(store[id]) };
    },
    remove_stem: ({ id }) => { delete store[id]; },
    transcribe_lyrics: async () => {
      // preview stand-in (the real lyrics come from Whisper in the engine): original placeholder lines on the vocal's phrases
      for (let k = 0; k <= 10; k++) { emit('lyrics-progress', { fraction: k / 10, stage: 'Writing lyrics', detail: `${k * 10}%` }); await new Promise(r => setTimeout(r, 60)); }
      const v = store.vocals[0], hop = SR / 20, rms = [];
      for (let i = 0; i + hop < N; i += hop) { let s = 0; for (let j = i; j < i + hop; j++) s += v[j] * v[j]; rms.push(Math.sqrt(s / hop)); }
      const peak = Math.max(...rms), spans = []; let s0 = -1;
      rms.forEach((r, i) => { if (r > peak * 0.08) { if (s0 < 0) s0 = i; } else if (s0 >= 0) { if (i - s0 > 6) spans.push([s0 / 20, i / 20]); s0 = -1; } });
      const words = ['Under a glass sky we wander slow', 'Counting the lights as the city goes', 'Hold on to the echo, hold on to the sound', 'Paper boats drifting where the rivers run', 'Every little heartbeat finds its way home', 'Singing it louder till the morning comes'];
      const lines = spans.map(([a, b], i) => { const text = words[i % words.length], ws = text.split(' '), d = (b - a) / ws.length; return { start: a, end: b, text, words: ws.map((w, k) => ({ start: a + k * d, end: a + (k + 1) * d, text: w })) }; });
      emit('lyrics-partial', { language: 'en', lines: lines.slice(0, 1) }); await new Promise(r => setTimeout(r, 300));
      return { language: 'en', lines };
    },
    cancel_lyrics: () => null,
    level_stem: async ({ id }) => {
      await new Promise(r => setTimeout(r, 250));
      store.__orig = store.__orig || {}; store.__orig[id] = store.__orig[id] || store[id];
      const [l, r] = store.__orig[id], hop = SR / 20, L = new Float32Array(l.length), R = new Float32Array(r.length);
      let tot = 0, cnt = 0; for (let i = 0; i < l.length; i++) { tot += l[i] * l[i]; cnt++; } const target = Math.sqrt(tot / cnt) || 1e-6;
      for (let k = 0; k * hop < l.length; k++) { let s = 0; const a = k * hop, b = Math.min(l.length, a + hop); for (let i = a; i < b; i++) s += l[i] * l[i]; const rms = Math.sqrt(s / (b - a)), g = rms > target * 0.05 ? Math.min(2.8, Math.max(0.35, target / rms)) : 1; for (let i = a; i < b; i++) { L[i] = l[i] * g; R[i] = r[i] * g; } }
      store[id] = [L, R];
      return { id, label: id, kind: 'stem', leaf: true, peaks: peaks(store[id]) };
    },
    restore_stem: ({ id }) => { if (store.__orig?.[id]) { store[id] = store.__orig[id]; delete store.__orig[id]; } return { id, label: id, kind: 'stem', leaf: true, peaks: peaks(store[id]) }; },
    add_recording: (body, opts) => {
      const take = new Float32Array(body.buffer, body.byteOffset, body.byteLength / 4), off = +(opts?.headers?.['x-offset'] || 0), ch = new Float32Array(N);
      for (let i = 0; i < take.length; i++) { const d = off + i; if (d >= 0 && d < N) ch[d] = take[i]; }
      let k = 1; while (store['rec_' + k]) k++;
      store['rec_' + k] = [ch, ch];
      return { id: 'rec_' + k, label: 'Recording ' + k, kind: 'lane', leaf: true, peaks: peaks(store['rec_' + k]) };
    },
    sync_stem: async ({ id }) => { await new Promise(r => setTimeout(r, 250)); store.__orig = store.__orig || {}; store.__orig[id] = store.__orig[id] || store[id]; return { stem: { id, label: id, kind: 'stem', leaf: true, peaks: peaks(store[id]) }, moved: 12 }; },
    models_list: () => MODELS, models_required: ({ request }) => MODELS.filter(m => (request.quality === 'max' ? m.id === 'mel_roformer' : m.id === 'voc_ft') || (request.lead_backing && m.id === 'kara_2') || (request.dereverb && m.id === 'reverb_hq') || (request.instruments === 'four' && m.id === 'htdemucs') || (request.instruments === 'six' && m.id === 'htdemucs_6s')),
    models_download: async ({ ids }) => { await new Promise(r => setTimeout(r, 600)); MODELS.filter(m => ids.includes(m.id)).forEach(m => m.present = true); }, models_delete: () => null,
    pcm: ({ id, depth }) => {
      const a = store[id];
      if (depth !== 16) { const buf = new Float32Array(N * 2); buf.set(a[0], 0); buf.set(a[1], N); return buf.buffer; }
      let peak = 1; for (const ch of a) for (let i = 0; i < N; i++) peak = Math.max(peak, Math.abs(ch[i]));
      const out = new ArrayBuffer(4 + N * 4), k = 32767 / peak;
      new DataView(out).setFloat32(0, peak, true);
      const pcm = new Int16Array(out, 4);
      for (let c = 0; c < 2; c++) for (let i = 0; i < N; i++) pcm[c * N + i] = Math.max(-32768, Math.min(32767, Math.round(a[c][i] * k)));
      return out;
    },
    export: ({ ids }) => ids.map(i => `~/Music/Stems/Demo song: stems/Demo song - ${i}.wav`),
    export_mix: (args) => { if (window.__mock) window.__mock.lastMix = args; return `~/Music/Stems/Demo song: stems/Demo song - ${args.name}.wav`; },
    separate: async ({ request }) => {
      cancelled = false;
      const stages = ['Vocals · UVR-MDX-NET Voc FT'];
      if (request.lead_backing) stages.push('Lead / backing · Karaoke 2');
      if (request.dereverb) stages.push('De-reverb · Reverb HQ');
      if (request.instruments !== 'none') stages.push('Instruments · HT-Demucs');
      // Emit visualisation data shaped exactly like the engine's, from the synthetic stems.
      const BIN = SR / 50, nb = Math.ceil(N / BIN);
      const env = (arr, b0, b1) => { const o = []; for (let b = b0; b < b1; b++) { let p = 0; for (let i = b * BIN; i < Math.min(N, (b + 1) * BIN); i += 4) p = Math.max(p, Math.abs(arr[0][i]), Math.abs(arr[1][i])); o.push(p); } return o; };
      const vizStages = [{ parent: 'mix', layers: [['vocals', vocals], ['instrumental', instrumental]] }];
      if (request.lead_backing) vizStages.push({ parent: 'vocals', layers: [['backing', parts.backing], ['lead', lead]] });
      if (request.instruments === 'four') vizStages.push({ parent: 'instrumental', layers: [['drums', parts.drums], ['bass', parts.bass], ['other', sum(parts.guitar, parts.piano, parts.other)]] });
      if (request.instruments === 'six') vizStages.push({ parent: 'instrumental', layers: [['drums', parts.drums], ['bass', parts.bass], ['guitar', parts.guitar], ['piano', parts.piano], ['other', parts.other]] });
      const fakeSpectrum = (a, b) => {
        const mag = [], mask = [];
        for (let band = 0; band < 48; band++) for (let c = 0; c < 64; c++) {
          const i = Math.min(a.length - 1, Math.floor((c / 64) * a.length)), v = a[i] || 0, s = b[i] || 0;
          const voice = Math.exp(-Math.pow((band - 24) / 9, 2)), low = Math.exp(-band / 14);
          const m = 0.25 + 0.75 * Math.min(1, (v * voice * 3 + s * (0.6 * low + 0.25)) * (0.8 + 0.2 * Math.sin(c * 0.9 + band * 0.5)));
          mag.push(Math.round(255 * Math.min(1, m)));
          mask.push(Math.round(255 * Math.min(1, (v * voice * 3) / (v * voice * 3 + s * (0.6 * low + 0.25) + 1e-4))));
        }
        return { bands: 48, cols: 64, mag, mask };
      };
      const per = 14, steps = per * vizStages.length;
      for (let k = 0; k < steps; k++) {
        if (cancelled) throw 'cancelled';
        const si = Math.floor(k / per), j = k % per, vs = vizStages[si];
        const b0 = Math.floor((j / per) * nb), b1 = Math.floor(((j + 1) / per) * nb);
        const layers = vs.layers.map(([n, arr]) => [n, env(arr, b0, b1)]);
        emit('viz', {
          stage: si + 1, parent: vs.parent, from: b0 / 50, to: b1 / 50, bin0: b0,
          window: j < per - 1 ? [b1 / 50, Math.min(DUR, b1 / 50 + 6)] : null,
          layers, spectrum: vs.layers.length === 2 ? fakeSpectrum(layers[0][1], layers[1][1]) : null,
        });
        emit('progress', { fraction: (k + 1) / steps, stage: stages[Math.min(stages.length - 1, si)], detail: `${Math.round(((k + 1) / steps) * 100)}%` });
        await new Promise(r => setTimeout(r, 170));
      }

      const S = [];
      const add = (id, label, kind, leaf, a) => { store[id] = a; S.push({ id, label, kind, leaf, peaks: peaks(a) }); };
      const lb = request.lead_backing, dr = request.dereverb, ins = request.instruments;
      add('vocals', 'Vocals', 'vocal', !lb && !dr, vocals);
      if (lb) { add('lead', 'Lead vocal', 'vocal', !dr, lead); add('backing', 'Backing vocals', 'vocal', true, parts.backing); }
      if (dr) { const t = lb ? 'lead' : 'vocals', T = lb ? 'Lead vocal' : 'Vocals'; add(t + '_dry', T + ' · dry', 'vocal', true, lb ? parts.lead_dry : sum(parts.lead_dry, parts.backing)); add(t + '_reverb', T + ' · reverb', 'vocal', true, parts.lead_reverb); }
      add('instrumental', 'Instrumental', 'music', ins === 'none', instrumental);
      if (ins !== 'none') {
        add('drums', 'Drums', 'music', true, parts.drums); add('bass', 'Bass', 'music', true, parts.bass);
        if (ins === 'six') { add('guitar', 'Guitar', 'music', true, parts.guitar); add('piano', 'Piano', 'music', true, parts.piano); add('other', 'Other', 'music', true, parts.other); }
        else add('other', 'Other', 'music', true, sum(parts.guitar, parts.piano, parts.other));
      }
      current = S;
      return { stems: S, backend: 'Preview engine', seconds: 2.8 };
    },
  };
  window.__TAURI__ = {
    core: { invoke: async (cmd, args = {}, opts) => { const h = handlers[cmd]; if (!h) throw `unknown command ${cmd}`; return h(args, opts); } },
    event: { listen: async (ev, f) => { (listeners[ev] ||= []).push(f); return () => {}; } },
    webview: { getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) },
  };
  window.__CONTOUR_PREVIEW__ = true;
  window.__mock = { fullSaves: 0, updates: 0, projects: () => projects };
})();
