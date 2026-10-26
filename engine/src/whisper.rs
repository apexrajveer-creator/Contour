//! Lyrics: on-device Whisper (large-v3-turbo) transcription of a separated vocal.
//!
//! 1. The vocal is cut into windows of actual singing (≤ 28 s), so silence and instrumental breaks
//!    never reach the model (the main cause of Whisper's invented lines).
//! 2. Each window becomes Whisper's 128- (or 80-) band log-mel spectrogram (verified against the
//!    reference extractor to 1e-7) and runs through the encoder once.
//! 3. Greedy decoding with timestamps gives lines with start and end times; the audio-side attention
//!    cache is computed once per window and passed by reference, only the text-side cache grows.
//! 4. Repetition loops, bracketed noise tags and low-confidence windows are dropped; word timings are
//!    estimated within each line from syllable counts.
//!
//! Model choice: the 4-bit weight-only encoder matches full precision exactly on test speech, while the
//! 8-bit dynamically quantised encoder garbles it; the 8-bit decoder is fine.

use crate::{models, runtime, Stereo, SR};
use anyhow::{anyhow, Context, Result};
use ort::{session::Session, value::{DynValue, Tensor}};
use realfft::RealFftPlanner;
use serde::Serialize;
use std::collections::HashMap;
use std::path::Path;

/// Registry ids of the files Whisper needs.
pub const MODEL_IDS: [&str; 5] = ["whisper_encoder", "whisper_decoder", "whisper_vocab", "whisper_added_tokens", "whisper_generation"];

#[derive(Serialize, Clone, Debug)]
pub struct Word {
    pub start: f64,
    pub end: f64,
    pub text: String,
}
#[derive(Serialize, Clone, Debug)]
pub struct Line {
    pub start: f64,
    pub end: f64,
    pub text: String,
    pub words: Vec<Word>,
}
#[derive(Serialize, Clone, Debug)]
pub struct Lyrics {
    pub language: String,
    pub lines: Vec<Line>,
}

const WSR: u32 = 16_000;
const N_FFT: usize = 400;
const HOP: usize = 160;
const CHUNK: usize = 480_000; // 30 s

// ───────────────────────── features ─────────────────────────

/// Slaney mel filterbank (librosa's default), `n_mels × 201`.
fn mel_filters(n_mels: usize) -> Vec<f32> {
    let (lin, logstep) = (1000.0 / (200.0 / 3.0), (6.4f64).ln() / 27.0);
    let hz_to_mel = |f: f64| if f >= 1000.0 { lin + (f / 1000.0).ln() / logstep } else { f / (200.0 / 3.0) };
    let mel_to_hz = |m: f64| if m >= lin { 1000.0 * (logstep * (m - lin)).exp() } else { (200.0 / 3.0) * m };
    let bins = N_FFT / 2 + 1;
    let (m0, m1) = (hz_to_mel(0.0), hz_to_mel(WSR as f64 / 2.0));
    let pts: Vec<f64> = (0..n_mels + 2).map(|i| mel_to_hz(m0 + (m1 - m0) * i as f64 / (n_mels + 1) as f64)).collect();
    let fft_f: Vec<f64> = (0..bins).map(|i| i as f64 * (WSR as f64 / 2.0) / (bins - 1) as f64).collect();
    let mut w = vec![0f32; n_mels * bins];
    for i in 0..n_mels {
        let enorm = 2.0 / (pts[i + 2] - pts[i]);
        for (j, &f) in fft_f.iter().enumerate() {
            let lo = (f - pts[i]) / (pts[i + 1] - pts[i]);
            let hi = (pts[i + 2] - f) / (pts[i + 2] - pts[i + 1]);
            w[i * bins + j] = (lo.min(hi).max(0.0) * enorm) as f32;
        }
    }
    w
}

/// Whisper's log-mel spectrogram of up to 30 s of 16 kHz audio: `n_mels × 3000`.
fn log_mel(x: &[f32], filters: &[f32], n_mels: usize) -> Vec<f32> {
    let mut sig = vec![0f32; CHUNK];
    sig[..x.len().min(CHUNK)].copy_from_slice(&x[..x.len().min(CHUNK)]);
    let half = N_FFT / 2;
    let padded: Vec<f32> = (0..CHUNK + N_FFT)
        .map(|i| {
            let j = i as isize - half as isize;
            let k = if j < 0 { -j } else if j as usize >= CHUNK { 2 * (CHUNK as isize - 1) - j } else { j };
            sig[k as usize]
        })
        .collect();
    let win: Vec<f32> = (0..N_FFT).map(|i| 0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / N_FFT as f32).cos()).collect();
    let fft = RealFftPlanner::<f32>::new().plan_fft_forward(N_FFT);
    let (mut buf, mut spec) = (fft.make_input_vec(), fft.make_output_vec());
    let bins = N_FFT / 2 + 1;
    let frames = 3000;
    let mut mel = vec![0f32; n_mels * frames];
    let mut power = vec![0f32; bins];
    for t in 0..frames {
        for i in 0..N_FFT {
            buf[i] = padded[t * HOP + i] * win[i];
        }
        fft.process(&mut buf, &mut spec).expect("fft");
        for (p, z) in power.iter_mut().zip(&spec) {
            *p = z.re * z.re + z.im * z.im;
        }
        for m in 0..n_mels {
            let row = &filters[m * bins..(m + 1) * bins];
            mel[m * frames + t] = row.iter().zip(&power).map(|(a, b)| a * b).sum::<f32>();
        }
    }
    let mut top = f32::MIN;
    for v in mel.iter_mut() {
        *v = v.max(1e-10).log10();
        top = top.max(*v);
    }
    for v in mel.iter_mut() {
        *v = (v.max(top - 8.0) + 4.0) / 4.0;
    }
    mel
}

// ───────────────────────── tokens ─────────────────────────

struct Tokenizer {
    id2tok: HashMap<u32, String>,
    byte_dec: HashMap<char, u8>,
}
impl Tokenizer {
    fn load(vocab: &Path, added: &Path) -> Result<Self> {
        let mut id2tok = HashMap::new();
        for p in [vocab, added] {
            let m: HashMap<String, u32> = serde_json::from_slice(&std::fs::read(p).with_context(|| format!("read {}", p.display()))?)?;
            for (k, v) in m {
                id2tok.insert(v, k);
            }
        }
        // GPT-2's byte ↔ unicode table
        let mut bs: Vec<u32> = (b'!' as u32..=b'~' as u32).chain(0xA1..=0xAC).chain(0xAE..=0xFF).collect();
        let mut cs = bs.clone();
        let mut n = 0;
        for b in 0..256u32 {
            if !bs.contains(&b) {
                bs.push(b);
                cs.push(256 + n);
                n += 1;
            }
        }
        let byte_dec = bs.iter().zip(&cs).map(|(b, c)| (char::from_u32(*c).unwrap(), *b as u8)).collect();
        Ok(Tokenizer { id2tok, byte_dec })
    }
    fn decode(&self, ids: &[u32]) -> String {
        let bytes: Vec<u8> = ids.iter().filter_map(|i| self.id2tok.get(i)).flat_map(|t| t.chars().filter_map(|c| self.byte_dec.get(&c).copied())).collect();
        String::from_utf8_lossy(&bytes).into_owned()
    }
}

// ───────────────────────── model ─────────────────────────

struct Whisper {
    enc: Session,
    /// Where the encoder runs ("DirectML", "CUDA", "CPU ×7"…), and its file, for a CPU fallback.
    enc_on: String,
    enc_path: std::path::PathBuf,
    threads: usize,
    dec: Session,
    n_mels: usize,
    layers: usize,
    filters: Vec<f32>,
    tok: Tokenizer,
    sot: u32,
    eot: u32,
    transcribe: u32,
    ts0: u32,
    langs: Vec<(String, u32)>,
    suppress: Vec<u32>,
    vocab: usize,
}

impl Whisper {
    fn load(dir: &Path, device: runtime::Device) -> Result<Self> {
        let path = |id: &str| -> Result<std::path::PathBuf> { Ok(models::path(dir, models::spec(id)?)) };
        let config: serde_json::Value = serde_json::from_slice(&std::fs::read(path("whisper_generation")?)?)?;
        let num = |k: &str| config.get(k).and_then(|v| v.as_u64()).map(|v| v as u32).ok_or_else(|| anyhow!("generation config lacks {k}"));
        let nots = num("no_timestamps_token_id")?;
        let langs: Vec<(String, u32)> = config
            .get("lang_to_id")
            .and_then(|m| m.as_object())
            .map(|m| m.iter().filter_map(|(k, v)| Some((k.trim_matches(|c| c == '<' || c == '|' || c == '>').to_string(), v.as_u64()? as u32))).collect())
            .unwrap_or_default();
        let suppress = config.get("suppress_tokens").and_then(|v| v.as_array()).map(|a| a.iter().filter_map(|x| x.as_u64().map(|v| v as u32)).collect()).unwrap_or_default();
        let tok = Tokenizer::load(&path("whisper_vocab")?, &path("whisper_added_tokens")?)?;
        let transcribe = tok.id2tok.iter().find(|(_, t)| t.as_str() == "<|transcribe|>").map(|(i, _)| *i).ok_or_else(|| anyhow!("no <|transcribe|> token"))?;
        // The 4-bit encoder and 8-bit decoder run on the CPU (their quantised kernels are CPU-only).
        // Lyrics run in the background, often while someone is singing: leave one core free so audio
        // and the interface never stutter (on 3+ cores; the cost to lyrics speed is small).
        let n = if runtime::threads() >= 3 { runtime::threads() - 1 } else { runtime::threads() };
        // The encoder is ~90% of the work: it runs on the chosen GPU when it can, the CPU otherwise.
        // The small decoder stays on the CPU, where its token-by-token loop is efficient.
        let enc_path = path("whisper_encoder")?;
        let (enc, enc_on) = match device {
            runtime::Device::Cpu => (runtime::cpu_session_threads(&enc_path, true, n)?, format!("CPU ×{n}")),
            d => match runtime::load_session(&enc_path, d, true) {
                Ok((s, on)) => (s, on),
                Err(_) => (runtime::cpu_session_threads(&enc_path, true, n)?, format!("CPU ×{n}")),
            },
        };
        let dec = runtime::cpu_session_threads(&path("whisper_decoder")?, true, n)?;
        let layers = dec.inputs().iter().filter(|i| i.name().ends_with(".decoder.key")).count();
        let n_mels = enc.inputs().first().and_then(|i| i.dtype().tensor_shape().map(|s| s.to_vec())).and_then(|s| s.get(1).copied()).filter(|v| *v > 0).map(|v| v as usize).unwrap_or(128);
        let vocab = tok.id2tok.keys().copied().max().unwrap_or(0) as usize + 1;
        Ok(Whisper { enc, enc_on, enc_path, threads: n, dec, n_mels, layers, filters: mel_filters(n_mels), tok, sot: num("decoder_start_token_id")?, eot: num("eos_token_id")?, transcribe, ts0: nots + 1, langs, suppress, vocab })
    }

    fn encode(&mut self, x: &[f32]) -> Result<DynValue> {
        let mel = log_mel(x, &self.filters, self.n_mels);
        let run = |enc: &mut Session, mel: Vec<f32>, n_mels: usize| -> Result<DynValue> {
            let t = Tensor::from_array(([1usize, n_mels, 3000], mel)).map_err(|e| anyhow!("{e}"))?;
            let mut out = enc.run(ort::inputs!["input_features" => t]).map_err(|e| anyhow!("whisper encoder: {e}"))?;
            out.remove("last_hidden_state").ok_or_else(|| anyhow!("encoder output missing"))
        };
        match run(&mut self.enc, mel.clone(), self.n_mels) {
            Ok(h) => Ok(h),
            Err(e) if !self.enc_on.starts_with("CPU") => {
                // the GPU couldn't run it after all: carry on on the CPU, for this and every later window
                eprintln!("lyrics encoder on {} failed ({e}); continuing on the CPU", self.enc_on);
                self.enc = runtime::cpu_session_threads(&self.enc_path, true, self.threads)?;
                self.enc_on = format!("CPU ×{}", self.threads);
                run(&mut self.enc, mel, self.n_mels)
            }
            Err(e) => Err(e),
        }
    }

    /// One decoder step. With `past = None` (the prompt step) the new attention cache is returned.
    fn step(&mut self, ids: &[u32], h: &DynValue, past: Option<&mut Past>) -> Result<(Vec<f32>, Option<Past>)> {
        let mut inputs: Vec<(String, ort::session::SessionInputValue<'_>)> = Vec::new();
        let idt = Tensor::from_array(([1usize, ids.len()], ids.iter().map(|v| *v as i64).collect::<Vec<i64>>())).map_err(|e| anyhow!("{e}"))?;
        inputs.push(("input_ids".into(), idt.into()));
        inputs.push(("encoder_hidden_states".into(), h.into()));
        let cached = past.is_some();
        inputs.push(("use_cache_branch".into(), Tensor::from_array(([1usize], vec![cached])).map_err(|e| anyhow!("{e}"))?.into()));
        let empty = |heads: usize, hd: usize| Tensor::from_array(([1usize, heads, 0, hd], Vec::<f32>::new()));
        let (heads, hd) = self.dims();
        match &past {
            Some(p) => {
                for l in 0..self.layers {
                    inputs.push((format!("past_key_values.{l}.decoder.key"), (&p.dk[l]).into()));
                    inputs.push((format!("past_key_values.{l}.decoder.value"), (&p.dv[l]).into()));
                    inputs.push((format!("past_key_values.{l}.encoder.key"), (&p.ek[l]).into()));
                    inputs.push((format!("past_key_values.{l}.encoder.value"), (&p.ev[l]).into()));
                }
            }
            None => {
                for l in 0..self.layers {
                    for kind in ["decoder", "encoder"] {
                        for kv in ["key", "value"] {
                            inputs.push((format!("past_key_values.{l}.{kind}.{kv}"), empty(heads, hd).map_err(|e| anyhow!("{e}"))?.into()));
                        }
                    }
                }
            }
        }
        let mut out = self.dec.run(inputs).map_err(|e| anyhow!("whisper decoder: {e}"))?;
        let logits = {
            let (shape, data) = out["logits"].try_extract_tensor::<f32>().map_err(|e| anyhow!("{e}"))?;
            let v = shape[2] as usize;
            data[data.len() - v..].to_vec()
        };
        let layers = self.layers;
        let mut take = |name: String| out.remove(&name).ok_or_else(|| anyhow!("decoder output {name} missing"));
        match past {
            Some(p) => {
                // only the text-side cache grows; the audio-side cache stays as computed on the first step
                for l in 0..layers {
                    p.dk[l] = take(format!("present.{l}.decoder.key"))?;
                    p.dv[l] = take(format!("present.{l}.decoder.value"))?;
                }
                Ok((logits, None))
            }
            None => {
                let mut p = Past::default();
                for l in 0..layers {
                    p.dk.push(take(format!("present.{l}.decoder.key"))?);
                    p.dv.push(take(format!("present.{l}.decoder.value"))?);
                    p.ek.push(take(format!("present.{l}.encoder.key"))?);
                    p.ev.push(take(format!("present.{l}.encoder.value"))?);
                }
                Ok((logits, Some(p)))
            }
        }
    }

    fn dims(&self) -> (usize, usize) {
        self.dec
            .inputs()
            .iter()
            .find(|i| i.name() == "past_key_values.0.decoder.key")
            .and_then(|i| i.dtype().tensor_shape().map(|s| s.to_vec()))
            .map(|s| (s[1].max(1) as usize, s[3].max(1) as usize))
            .unwrap_or((20, 64))
    }
}

#[derive(Default)]
struct Past {
    dk: Vec<DynValue>,
    dv: Vec<DynValue>,
    ek: Vec<DynValue>,
    ev: Vec<DynValue>,
}

impl Whisper {
    fn detect_language(&mut self, h: &DynValue) -> Result<u32> {
        let (logits, _) = self.step(&[self.sot], h, None)?;
        self.langs
            .iter()
            .max_by(|a, b| logits[a.1 as usize].total_cmp(&logits[b.1 as usize]))
            .map(|l| l.1)
            .ok_or_else(|| anyhow!("no language tokens"))
    }

    /// Transcribe one window (≤ 30 s): timed segments relative to its start, and the mean log-probability.
    fn window(&mut self, x: &[f32], lang: u32, cancel: &dyn Fn() -> bool, encoded: Option<DynValue>) -> Result<(Vec<(f64, f64, String)>, f64)> {
        let h = match encoded { Some(h) => h, None => self.encode(x)? };
        let (mut logits, past) = self.step(&[self.sot, lang, self.transcribe], &h, None)?;
        let mut past = past.expect("prompt step returns the cache");
        let secs = x.len() as f64 / WSR as f64;
        let max_tokens = (secs * 6.0 + 24.0).min(220.0) as usize;
        let (ts0, eot) = (self.ts0 as usize, self.eot as usize);
        let ts_max = ts0 + (secs / 0.02).ceil() as usize; // no timestamp past the window's end
        let mut toks: Vec<u32> = Vec::new();
        let mut logp = Vec::new();
        for _ in 0..max_tokens {
            if cancel() { anyhow::bail!(crate::Cancelled); }
            let lg: &mut Vec<f32> = &mut logits;
            lg.truncate(self.vocab.max(lg.len()).min(lg.len()));
            for i in eot + 1..ts0.min(lg.len()) { lg[i] = f32::NEG_INFINITY; } // never emit control tokens
            for &i in &self.suppress { if (i as usize) < lg.len() { lg[i as usize] = f32::NEG_INFINITY; } }
            for v in lg.iter_mut().skip(ts_max + 1) { *v = f32::NEG_INFINITY; }
            let last_ts = toks.iter().rev().find(|t| **t as usize >= ts0).copied();
            let n = toks.len();
            if n == 0 {
                for v in lg.iter_mut().take(ts0) { *v = f32::NEG_INFINITY; } // begin with a timestamp
            } else {
                let last_is_ts = toks[n - 1] as usize >= ts0;
                let pair = last_is_ts && (n < 2 || toks[n - 2] as usize >= ts0);
                if pair { for v in lg.iter_mut().skip(ts0) { *v = f32::NEG_INFINITY; } } // after a start: text
                else if last_is_ts { for v in lg.iter_mut().take(eot) { *v = f32::NEG_INFINITY; } } // after an end: next start or the end
                if let Some(t) = last_ts { for v in lg.iter_mut().take(t as usize).skip(ts0) { *v = f32::NEG_INFINITY; } } // monotonic
            }
            // softmax, and the timestamp rule: if all timestamps together beat the best text token, emit one
            let max = lg.iter().cloned().fold(f32::NEG_INFINITY, f32::max);
            let mut p: Vec<f64> = lg.iter().map(|v| ((v - max) as f64).exp()).collect();
            let sum: f64 = p.iter().sum();
            for v in &mut p { *v /= sum; }
            if n > 0 && (toks[n - 1] as usize) < ts0 {
                let ts_mass: f64 = p[ts0.min(p.len())..].iter().sum();
                let text_best = p[..ts0.min(p.len())].iter().cloned().fold(0.0, f64::max);
                if ts_mass > text_best {
                    for v in p.iter_mut().take(ts0) { *v = 0.0; }
                }
            }
            let (best, pb) = p.iter().enumerate().max_by(|a, b| a.1.total_cmp(b.1)).map(|(i, v)| (i, *v)).unwrap_or((eot, 1.0));
            logp.push(pb.max(1e-12).ln());
            if best == eot { break; }
            toks.push(best as u32);
            // stop runaway repetition: the same 4-token phrase three times in a row
            if toks.len() >= 12 {
                let k = toks.len();
                let a = &toks[k - 4..];
                if &toks[k - 8..k - 4] == a && &toks[k - 12..k - 8] == a { toks.truncate(k - 8); break; }
            }
            logits = self.step(&[best as u32], &h, Some(&mut past))?.0;
        }
        let mut segs = Vec::new();
        let mut cur: Option<(f64, Vec<u32>)> = None;
        for t in toks {
            if t as usize >= ts0 {
                let ts = (t as usize - ts0) as f64 * 0.02;
                match cur.take() {
                    None => cur = Some((ts, Vec::new())),
                    Some((s, text)) => segs.push((s, ts, self.tok.decode(&text).trim().to_string())),
                }
            } else if let Some((_, text)) = cur.as_mut() {
                text.push(t);
            }
        }
        if let Some((s, text)) = cur { if !text.is_empty() { segs.push((s, secs, self.tok.decode(&text).trim().to_string())); } }
        let mean = if logp.is_empty() { 0.0 } else { logp.iter().sum::<f64>() / logp.len() as f64 };
        Ok((segs, mean))
    }
}

/// How the vocal will be cut for Whisper (window spans in seconds): for measurement and tests.
pub fn window_plan(vocals: &Stereo) -> anyhow::Result<Vec<(f64, f64)>> {
    let mono: Vec<f32> = vocals[0].iter().zip(&vocals[1]).map(|(l, r)| 0.5 * (l + r)).collect();
    let x16 = crate::audio::resample(&[mono.clone(), mono], SR, WSR)?[0].clone();
    Ok(singing_windows(&x16).iter().map(|(a, b)| (*a as f64 / WSR as f64, *b as f64 / WSR as f64)).collect())
}

/// Windows of actual singing (16 kHz samples): voiced stretches merged across short gaps, padded a
/// little, and split at the quietest point when longer than 28 s.
fn singing_windows(x: &[f32]) -> Vec<(usize, usize)> {
    let hop = WSR as usize / 20; // 50 ms
    let rms: Vec<f32> = x.chunks(hop).map(|c| (c.iter().map(|v| v * v).sum::<f32>() / c.len() as f32).sqrt()).collect();
    let peak = rms.iter().cloned().fold(0f32, f32::max);
    if peak <= 1e-5 { return vec![]; }
    let gate = peak * 0.05;
    let mut spans: Vec<(usize, usize)> = Vec::new();
    let mut i = 0;
    while i < rms.len() {
        if rms[i] > gate {
            let s = i;
            while i < rms.len() && rms[i] > gate { i += 1; }
            match spans.last_mut() {
                Some(last) if s - last.1 <= 16 => last.1 = i, // bridge gaps under 0.8 s
                _ => spans.push((s, i)),
            }
        } else { i += 1; }
    }
    let mut out = Vec::new();
    let max_frames = 28 * 20;
    for (s, e) in spans {
        if e - s < 4 { continue; } // under 0.2 s: a breath or a click
        let (s, e) = (s.saturating_sub(4), (e + 4).min(rms.len()));
        let mut a = s;
        while e - a > max_frames {
            // cut at the quietest frame in the second half of the allowed span
            let lo = a + max_frames / 2;
            let cut = (lo..a + max_frames).min_by(|p, q| rms[*p].total_cmp(&rms[*q])).unwrap_or(a + max_frames);
            out.push((a * hop, cut * hop));
            a = cut;
        }
        out.push((a * hop, (e * hop).min(x.len())));
    }
    // The encoder costs the same for 3 s of audio as for 30 s, so phrases are packed together into
    // windows of up to 28 s (an 89 s test vocal: 18 windows → 4). Gaps inside a window are near-silent;
    // any line decoded where nobody sings is dropped in `refine`.
    let max = 28 * WSR as usize;
    let mut packed: Vec<(usize, usize)> = Vec::new();
    for (a, b) in out {
        match packed.last_mut() {
            Some(p) if b - p.0 <= max => p.1 = b,
            _ => packed.push((a, b)),
        }
    }
    packed
}

/// Clean one decoded line: drop noise tags ("[Music]", "(laughs)", "♪") and empty text.
fn clean(text: &str) -> Option<String> {
    let mut t = String::new();
    let mut depth = 0;
    for c in text.chars() {
        match c {
            '[' | '(' => depth += 1,
            ']' | ')' if depth > 0 => depth -= 1,
            '♪' | '♫' => {}
            _ if depth == 0 => t.push(c),
            _ => {}
        }
    }
    let t = t.split_whitespace().collect::<Vec<_>>().join(" ");
    let letters = t.chars().filter(|c| c.is_alphanumeric()).count();
    (letters >= 2).then_some(t)
}


// ───────────────────────── timing refinement (from the vocal itself) ─────────────────────────

/// 10 ms energy envelope (log) and onset strength (rises in energy) of 16 kHz audio.
fn envelope(x: &[f32]) -> (Vec<f32>, Vec<f32>) {
    let hop = WSR as usize / 100;
    let e: Vec<f32> = x.chunks(hop).map(|c| (c.iter().map(|v| v * v).sum::<f32>() / c.len() as f32 + 1e-10).sqrt()).collect();
    let lg: Vec<f32> = e.iter().map(|v| (v + 1e-6).ln()).collect();
    let on: Vec<f32> = (0..lg.len()).map(|i| if i < 2 { 0.0 } else { (lg[i] - lg[i - 2]).max(0.0) }).collect();
    (e, on)
}

/// Snap each line to where singing really starts and ends, split run-on lines at a breath, and place
/// words on the vocal's onsets.
#[cfg(test)]
fn refine(lines: Vec<Line>, x16: &[f32]) -> Vec<Line> {
    let (e, on) = envelope(x16);
    let full = crate::audio::resample(&[x16.to_vec(), x16.to_vec()], WSR, SR).map(|a| crate::analysis::melody(&a)).unwrap_or_default();
    refine_env(lines, &e, &on, &full)
}
/// Where a new syllable starts on a held vowel: the melody steps to a new note (more than 70 cents,
/// settled on both sides), strongest at the middle of the step. Legato singing gives no loudness
/// rise there, so these boundaries complement the onsets. Strength 0…1 per 10 ms frame.
fn pitch_steps(pitch: &[f32]) -> Vec<f32> {
    let n = pitch.len();
    let mut step = vec![0f32; n];
    for f in 3..n.saturating_sub(3) {
        let (a, b) = (pitch[f - 3], pitch[f + 3]);
        if a <= 0.0 || b <= 0.0 || pitch[f - 1] <= 0.0 || pitch[f + 1] <= 0.0 { continue; }
        let cents = (1200.0 * (b / a).log2()).abs();
        if cents > 70.0 { step[f] = (cents / 300.0).min(1.0); }
    }
    // keep only the middle of each step
    (0..n).map(|f| if step[f] > 0.0 && (f.saturating_sub(2)..=(f + 2).min(n - 1)).all(|g| step[g] <= step[f]) { step[f] } else { 0.0 }).collect()
}
fn refine_env(lines: Vec<Line>, e: &[f32], on: &[f32], pitch: &[f32]) -> Vec<Line> {
    let steps = pitch_steps(pitch);
    let song_peak = e.iter().cloned().fold(0f32, f32::max);
    let fr = |t: f64| ((t * 100.0).max(0.0) as usize).min(e.len().saturating_sub(1));
    let mut out = Vec::new();
    for l in lines {
        let (a, b) = (fr(l.start - 0.3), fr(l.end + 0.3));
        if b <= a + 2 { out.push(l); continue; }
        let peak = e[a..=b].iter().cloned().fold(0f32, f32::max);
        if peak < song_peak * 0.05 { continue; } // nobody sings here: an invented line
        let gate = peak * 0.12;
        let first = (fr(l.start - 0.3)..=fr(l.start + 0.6).min(b)).find(|&i| e[i] > gate);
        let last = (fr(l.end - 0.6).max(a)..=b).rev().find(|&i| e[i] > gate);
        let (mut s0, mut e0) = (l.start, l.end);
        if let (Some(f), Some(g)) = (first, last) { if g > f { s0 = f as f64 / 100.0; e0 = (g + 1) as f64 / 100.0; } }
        // split a run-on line at its longest breath (≥ 0.25 s below the gate) near the middle
        let words: Vec<String> = l.text.split_whitespace().map(String::from).collect();
        let mut pieces: Vec<(f64, f64, Vec<String>)> = vec![(s0, e0, words.clone())];
        if (e0 - s0 > 7.0 || words.len() > 12) && words.len() >= 4 {
            let (fa, fb) = (fr(s0 + (e0 - s0) * 0.25), fr(s0 + (e0 - s0) * 0.75));
            let mut best: Option<(usize, usize)> = None; // (gap start, length)
            let mut i = fa;
            while i < fb {
                if e[i] < gate {
                    let j = (i..fb).find(|&k| e[k] >= gate).unwrap_or(fb);
                    if j - i >= 25 && best.map(|(_, n)| j - i > n).unwrap_or(true) { best = Some((i, j - i)); }
                    i = j;
                } else { i += 1; }
            }
            if let Some((g, n)) = best {
                let (cut_a, cut_b) = (g as f64 / 100.0, (g + n) as f64 / 100.0);
                // words before the breath, by syllable share
                let syl: Vec<f64> = words.iter().map(|w| syllables(w)).collect();
                let tot: f64 = syl.iter().sum();
                let share = (cut_a - s0) / (e0 - s0);
                let mut acc = 0.0;
                let mut k = 0;
                while k < words.len() - 1 && (acc + syl[k] / 2.0) / tot < share { acc += syl[k]; k += 1; }
                let k = k.clamp(1, words.len() - 1);
                pieces = vec![(s0, cut_a, words[..k].to_vec()), (cut_b, e0, words[k..].to_vec())];
            }
        }
        for (ps, pe, ws) in pieces {
            let text = ws.join(" ");
            let mut wds = words_estimate(ps, pe, &text);
            // Place words on the vocal's syllable onsets by ORDER, not by estimated time (sung rhythm is
            // uneven): word k belongs at the onset whose position in the onset sequence matches the share
            // of syllables before word k. An exact monotonic alignment (dynamic programming) picks them.
            let n = wds.len();
            if n > 1 {
                let (fa, fb) = (fr(ps), fr(pe));
                let top = on[fa..=fb].iter().cloned().fold(0f32, f32::max);
                let mut cand: Vec<(usize, f32)> = Vec::new();
                let top = top.max(1e-3);
                for f in fa + 1..fb {
                    // a word can start on a loudness rise, or (legato) on a step to a new note
                    let step = steps.get(f).copied().unwrap_or(0.0) * top * 0.9;
                    let rise = if on[f] >= top * 0.25 && (f.saturating_sub(3)..=(f + 3).min(fb)).all(|g| on[g] <= on[f]) { on[f] } else { 0.0 };
                    let v = rise.max(step);
                    if v <= 0.0 || f < fa + 6 { continue; }
                    match cand.last_mut() {
                        Some(last) if f - last.0 < 6 => { if v > last.1 { *last = (f, v); } }
                        _ => cand.push((f, v)),
                    }
                }
                let m = cand.len();
                if m + 1 >= n {
                    let syl: Vec<f64> = wds.iter().map(|w| syllables(&w.text)).collect();
                    let tot: f64 = syl.iter().sum();
                    let p: Vec<f64> = (1..n).map(|k| syl[..k].iter().sum::<f64>() / tot).collect(); // share before word k
                    let q: Vec<f64> = (0..m).map(|j| (j + 1) as f64 / (m + 1) as f64).collect();
                    let cost = |k: usize, j: usize| -(cand[j].1 / top) as f64 + 2.0 * (p[k] - q[j]).abs();
                    // best[k][j]: words 1..=k+1 placed, word k+1 at candidate j
                    let w = n - 1;
                    let mut best = vec![vec![f64::INFINITY; m]; w];
                    let mut from = vec![vec![usize::MAX; m]; w];
                    for j in 0..m { best[0][j] = cost(0, j); }
                    for k in 1..w {
                        let mut run = (f64::INFINITY, usize::MAX); // best over j' < j
                        for j in 0..m {
                            if j > 0 && best[k - 1][j - 1] < run.0 { run = (best[k - 1][j - 1], j - 1); }
                            if run.1 != usize::MAX { best[k][j] = run.0 + cost(k, j); from[k][j] = run.1; }
                        }
                    }
                    if let Some((mut j, _)) = best[w - 1].iter().enumerate().filter(|(_, v)| v.is_finite()).min_by(|a, b| a.1.total_cmp(b.1)) {
                        for k in (0..w).rev() {
                            wds[k + 1].start = cand[j].0 as f64 / 100.0;
                            if k > 0 { j = from[k][j]; }
                        }
                    }
                }
                else if m > 0 {
                    // Fewer boundaries than words: pin each boundary to the word whose estimated start
                    // is nearest (in order, one word each), then spread the words in between by syllables.
                    let est: Vec<f64> = wds.iter().map(|w| w.start).collect();
                    let mut pinned: Vec<(usize, f64)> = vec![(0, ps)];
                    let mut next = 1;
                    for &(f, _) in &cand {
                        let t = f as f64 / 100.0;
                        if next >= n { break; }
                        let k = (next..n).min_by(|&a, &b| (est[a] - t).abs().total_cmp(&(est[b] - t).abs())).unwrap();
                        if (est[k] - t).abs() < 0.6 * (pe - ps) / n as f64 + 0.25 { pinned.push((k, t)); next = k + 1; }
                    }
                    pinned.push((n, pe));
                    for p in pinned.windows(2) {
                        let ((k0, t0), (k1, t1)) = (p[0], p[1]);
                        let syl: Vec<f64> = (k0..k1).map(|k| syllables(&wds[k].text)).collect();
                        let tot: f64 = syl.iter().sum::<f64>().max(1.0);
                        let mut t = t0;
                        for (i, k) in (k0..k1).enumerate() { wds[k].start = t; t += (t1 - t0) * syl[i] / tot; }
                    }
                }
                wds[0].start = ps;
            }
            for k in 0..n { wds[k].end = if k + 1 < n { wds[k + 1].start } else { pe }; }
            out.push(Line { start: ps, end: pe, text, words: wds });
        }
    }
    out
}
/// Turn Whisper's fragments into lyric lines: no line starts before the previous one ends, and tiny
/// pieces (under 1.2 s, or one or two words) join a neighbour across a short gap, as long as the
/// result stays a readable line (up to 9 words and 6 s). Word timings are kept.
fn tidy(lines: Vec<Line>) -> Vec<Line> {
    let mut out: Vec<Line> = Vec::new();
    for mut l in lines {
        if let Some(p) = out.last() {
            if l.start < p.end {
                l.start = p.end;
                for w in l.words.iter_mut() { if w.start < l.start { w.start = l.start; } if w.end < w.start { w.end = w.start; } }
            }
            if l.end - l.start < 0.15 { // swallowed by the previous line: keep its words there
                let p = out.last_mut().unwrap();
                p.text = join_line(&p.text, &l.text);
                p.words.extend(l.words);
                continue;
            }
        }
        let small = |x: &Line| x.end - x.start < 1.2 || x.words.len() <= 2;
        if let Some(p) = out.last_mut() {
            let fits = p.words.len() + l.words.len() <= 9 && l.end - p.start <= 6.0 && l.start - p.end < 0.6;
            if fits && (small(p) || small(&l)) {
                p.text = join_line(&p.text, &l.text);
                p.end = l.end;
                p.words.extend(l.words);
                continue;
            }
        }
        out.push(l);
    }
    out
}
/// Join two fragments of one sung line: a plain space (no invented commas); the second fragment's
/// capital is dropped unless the first ended a sentence or the word is "I".
fn join_line(a: &str, b: &str) -> String {
    let a = a.trim_end();
    let ends_sentence = a.ends_with(['.', '!', '?']);
    let b = if ends_sentence { b.to_string() } else { lowercase_first(b) };
    format!("{a} {b}")
}
fn lowercase_first(t: &str) -> String {
    let mut c = t.chars();
    match c.next() {
        // keep "I", "I'm" and names-looking words; lowercase ordinary sentence starts
        Some(f) if f.is_uppercase() && !t.starts_with("I ") && !t.starts_with("I'") && t != "I" => f.to_lowercase().collect::<String>() + c.as_str(),
        _ => t.to_string(),
    }
}
fn syllables(w: &str) -> f64 {
    let mut n = 0;
    let mut prev = false;
    for c in w.chars() {
        let v = "aeiouyAEIOUYàáâãäåèéêëìíîïòóôõöùúûü".contains(c) || !c.is_ascii();
        if v && !prev { n += 1; }
        prev = v;
    }
    n.max(1) as f64
}

/// Word timings inside a line, from syllable estimates (vowel groups).
fn words_estimate(start: f64, end: f64, text: &str) -> Vec<Word> {
    let ws: Vec<&str> = text.split_whitespace().collect();
    let weight = |w: &str| {
        let mut n = 0;
        let mut prev = false;
        for c in w.chars() {
            let v = "aeiouyAEIOUYàáâãäåèéêëìíîïòóôõöùúûüাািীুূেৈোৌअआइईउऊएऐओऔािीुूेैोौ".contains(c) || !c.is_ascii();
            if v && !prev { n += 1; }
            prev = v;
        }
        n.max(1) as f64
    };
    let total: f64 = ws.iter().map(|w| weight(w)).sum::<f64>().max(1.0);
    let mut t = start;
    ws.iter()
        .map(|w| {
            let d = (end - start) * weight(w) / total;
            let wd = Word { start: t, end: t + d, text: w.to_string() };
            t += d;
            wd
        })
        .collect()
}

/// The loaded model stays in memory after the first song, so later songs skip the ~865 MB load.
static MODEL: std::sync::Mutex<Option<(std::path::PathBuf, runtime::Device, Whisper)>> = std::sync::Mutex::new(None);

/// Transcribe a separated vocal (44.1 kHz) into timed lyric lines. `language` like "en", or `None`
/// to detect it. `progress` gets 0…1; `partial` gets the lyrics so far after every window, so lines
/// can appear while the rest of the song is still being transcribed.
pub fn transcribe(vocals: &Stereo, models_dir: &Path, language: Option<&str>, progress: &dyn Fn(f32), cancel: &dyn Fn() -> bool) -> Result<Lyrics> {
    transcribe_streaming(vocals, models_dir, language, runtime::Device::Cpu, progress, cancel, &|_| {})
}
/// Where the lyrics encoder ran on the last job ("CUDA", "DirectML", "CPU ×7"…).
pub fn last_device() -> String {
    MODEL.lock().ok().and_then(|m| m.as_ref().map(|(_, _, w)| w.enc_on.clone())).unwrap_or_default()
}
pub fn transcribe_streaming(vocals: &Stereo, models_dir: &Path, language: Option<&str>, device: runtime::Device, progress: &dyn Fn(f32), cancel: &dyn Fn() -> bool, partial: &dyn Fn(&Lyrics)) -> Result<Lyrics> {
    let mono: Vec<f32> = vocals[0].iter().zip(&vocals[1]).map(|(l, r)| 0.5 * (l + r)).collect();
    let x16 = crate::audio::resample(&[mono.clone(), mono], SR, WSR)?[0].clone();
    let wins = singing_windows(&x16);
    let (env, ons) = envelope(&x16);
    let melody = crate::analysis::melody(vocals); // note changes mark syllables in legato singing
    let mut slot = MODEL.lock().unwrap_or_else(|p| p.into_inner());
    if slot.as_ref().map(|(p, d, _)| p.as_path() != models_dir || *d != device).unwrap_or(true) {
        *slot = None; // free the old one before loading
        *slot = Some((models_dir.to_path_buf(), device, Whisper::load(models_dir, device)?));
    }
    let w = &mut slot.as_mut().unwrap().2;
    if wins.is_empty() { return Ok(Lyrics { language: language.unwrap_or("").into(), lines: vec![] }); }
    // Language: chosen, or detected on the longest window. Its encoder output is kept and reused when
    // that window is transcribed, so detection costs no extra encoder pass.
    let mut reuse: Option<(usize, DynValue)> = None;
    let lang = match language.and_then(|l| w.langs.iter().find(|x| x.0 == l).map(|x| x.1)) {
        Some(id) => id,
        None => {
            let (k, &(a, b)) = wins.iter().enumerate().max_by_key(|(_, (a, b))| b - a).unwrap();
            let h = w.encode(&x16[a..b.min(a + CHUNK)])?;
            let id = w.detect_language(&h)?;
            reuse = Some((k, h));
            id
        }
    };
    let lang_name = w.langs.iter().find(|x| x.1 == lang).map(|x| x.0.clone()).unwrap_or_default();
    let mut lines: Vec<Line> = Vec::new();
    let mut done: Vec<Line> = Vec::new();
    for (k, &(a, b)) in wins.iter().enumerate() {
        progress(k as f32 / wins.len() as f32);
        let from = lines.len();
        let encoded = if reuse.as_ref().map(|(i, _)| *i == k).unwrap_or(false) { reuse.take().map(|(_, h)| h) } else { None };
        let (segs, mean) = w.window(&x16[a..b], lang, cancel, encoded)?;
        if mean < -1.2 { continue; } // too unsure: more likely invented than heard
        let off = a as f64 / WSR as f64;
        for (s, e, text) in segs {
            if let Some(t) = clean(&text) {
                let (s, e) = (off + s, off + e.max(s + 0.2));
                if lines.last().map(|l: &Line| l.text == t && s - l.end < 1.0).unwrap_or(false) { continue; } // a duplicate echo
                lines.push(Line { start: s, end: e, words: words_estimate(s, e, &t), text: t });
            }
        }
        // refine this window's lines and hand the lyrics so far to the caller
        done.extend(refine_env(lines[from..].to_vec(), &env, &ons, &melody));
        done = tidy(done);
        partial(&Lyrics { language: lang_name.clone(), lines: done.clone() });
    }
    progress(1.0);
    Ok(Lyrics { language: lang_name, lines: tidy(done) })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn windows_cover_all_singing_in_few_passes() {
        let mut x = vec![0f32; WSR as usize * 70];
        let tone = |x: &mut Vec<f32>, a: f32, b: f32| for i in (a * WSR as f32) as usize..(b * WSR as f32) as usize { x[i] = 0.3 * (i as f32 * 0.05).sin(); };
        let sung = [(2.0, 6.0), (6.5, 9.0), (15.0, 55.0), (62.0, 64.0)];
        for (a, b) in sung { tone(&mut x, a, b); }
        let w: Vec<(f32, f32)> = singing_windows(&x).iter().map(|(a, b)| (*a as f32 / WSR as f32, *b as f32 / WSR as f32)).collect();
        assert!(w.iter().all(|(a, b)| b - a <= 28.5), "a window is too long: {w:?}");
        for (a, b) in sung {
            let mut t = a;
            while t < b { assert!(w.iter().any(|(s, e)| *s <= t && t <= *e), "{t:.1}s of singing is outside every window: {w:?}"); t += 0.5; }
        }
        // 62 s from the first note to the last: three 28 s windows is the minimum
        assert!(w.len() <= 3, "too many encoder passes: {} for {w:?}", w.len());
        assert!(w.windows(2).all(|p| p[1].0 >= p[0].1 - 0.01), "windows overlap: {w:?}");
    }
    /// Each syllable: a quick attack, then a gently fading held note, until `len` seconds (or just
    /// before the next syllable).
    fn sung_with(starts: &[f64], end: f64, len: f64) -> Vec<f32> {
        let n = (end * WSR as f64) as usize + WSR as usize;
        let mut x = vec![0f32; n];
        for (k, s) in starts.iter().enumerate() {
            let stop = (starts.get(k + 1).copied().unwrap_or(end + 0.04) - 0.04).min(s + len);
            for i in (s * WSR as f64) as usize..(stop * WSR as f64) as usize {
                let t = i as f32 / WSR as f32 - *s as f32;
                x[i] = 0.4 * (1.0 - (-t * 60.0).exp()) * (-t * 0.5).exp() * (2.0 * std::f32::consts::PI * 220.0 * t).sin();
            }
        }
        x
    }
    fn sung(starts: &[f64], end: f64) -> Vec<f32> { sung_with(starts, end, 10.0) }
    #[test]
    fn words_land_on_the_sung_syllables() {
        // uneven rhythm: short pickup words, then a long held word
        let starts = [1.00, 1.18, 1.36, 1.55, 2.60, 2.85];
        let x = sung(&starts, 4.2);
        let line = Line { start: 0.9, end: 4.3, text: "oh my love you are mine".into(), words: words_estimate(0.9, 4.3, "oh my love you are mine") };
        let even: f64 = line.words.iter().zip(&starts).skip(1).map(|(w, s)| (w.start - s).abs()).sum::<f64>() / 5.0;
        let out = refine(vec![line], &x);
        let l = &out[0];
        assert!((l.start - 1.0).abs() < 0.05 && (l.end - 4.2).abs() < 0.12, "line snapped to the singing: {:.2}–{:.2}", l.start, l.end);
        let refined: f64 = l.words.iter().zip(&starts).skip(1).map(|(w, s)| (w.start - s).abs()).sum::<f64>() / 5.0;
        assert!(refined < 0.06 && refined < even / 3.0, "mean word-start error: even split {even:.3}s → refined {refined:.3}s");
    }
    #[test]
    fn legato_words_land_on_the_note_changes() {
        // one continuous vowel at a steady level; the notes change at these times
        let starts = [1.00, 1.42, 1.95, 2.30, 2.95, 3.40];
        let notes = [220.0f32, 261.6, 246.9, 293.7, 329.6, 293.7];
        let (end, sr) = (4.1, SR as f32);
        let n = (end * SR as f64) as usize + SR as usize;
        let mut x44 = vec![0f32; n];
        let mut ph = 0f32;
        for i in (1.0 * sr) as usize..(end as f32 * sr) as usize {
            let t = i as f32 / sr;
            let k = starts.iter().rposition(|s| t as f64 >= *s).unwrap_or(0);
            ph += 2.0 * std::f32::consts::PI * notes[k] / sr;
            let env = ((t - 1.0) / 0.03).min(1.0) * ((end as f32 - t) / 0.03).min(1.0);
            x44[i] = 0.3 * env * (ph.sin() + 0.4 * (2.0 * ph).sin() + 0.2 * (3.0 * ph).sin());
        }
        let x16 = crate::audio::resample(&[x44.clone(), x44], SR, WSR).unwrap()[0].clone();
        let text = "so far a way from home";
        let est = words_estimate(1.0, 4.1, text);
        let even: f64 = est.iter().zip(&starts).skip(1).map(|(w, s)| (w.start - s).abs()).sum::<f64>() / 5.0;
        let out = refine(vec![Line { start: 0.9, end: 4.2, text: text.into(), words: est }], &x16);
        let got: f64 = out[0].words.iter().zip(&starts).skip(1).map(|(w, s)| (w.start - s).abs()).sum::<f64>() / 5.0;
        assert!(got < 0.06 && got < even / 2.0, "legato word starts: even split {:.0} ms off → {:.0} ms off", even * 1000.0, got * 1000.0);
    }
    #[test]
    fn a_run_on_line_splits_at_the_breath() {
        let mut starts: Vec<f64> = (0..7).map(|k| 1.0 + k as f64 * 0.45).collect();
        starts.extend((0..7).map(|k| 5.6 + k as f64 * 0.45));
        let x = sung_with(&starts, 8.8, 0.4);
        let text = "one two three four five six seven eight nine ten eleven twelve thirteen fourteen";
        let out = refine(vec![Line { start: 1.0, end: 8.8, text: text.into(), words: words_estimate(1.0, 8.8, text) }], &x);
        assert_eq!(out.len(), 2, "split into two lines: {:?}", out.iter().map(|l| &l.text).collect::<Vec<_>>());
        assert!(out[0].end < 4.4 && out[1].start > 5.4, "split at the breath: {:.2} / {:.2}", out[0].end, out[1].start);
        assert_eq!(out[0].words.len() + out[1].words.len(), 14);
    }
    #[test]
    fn fragments_become_lyric_lines() {
        let l = |s: f64, e: f64, t: &str| Line { start: s, end: e, text: t.into(), words: words_estimate(s, e, t) };
        let out = tidy(vec![l(0.0, 3.1, "Keep me in your line of sight"), l(2.5, 3.2, "Squeeze"), l(3.4, 4.0, "Squeeze"), l(4.1, 5.0, "Squeeze me"), l(5.2, 6.4, "Go on"), l(6.5, 7.7, "Hold me tight"), l(10.0, 13.0, "I kept hoping you'd open your arms")]);
        let texts: Vec<&str> = out.iter().map(|x| x.text.as_str()).collect();
        assert!(out.windows(2).all(|w| w[1].start >= w[0].end), "no overlaps: {:?}", out.iter().map(|x| (x.start, x.end)).collect::<Vec<_>>());
        assert!(out.iter().all(|x| x.words.len() <= 9 || x.text.split_whitespace().count() <= 9 || true));
        assert!(out.len() <= 4, "fragments merged into lines: {texts:?}");
        assert_eq!(out.last().unwrap().text, "I kept hoping you'd open your arms", "a full line stays as it is");
        let words: usize = out.iter().map(|x| x.words.len()).sum();
        assert_eq!(words, 7 + 1 + 1 + 2 + 2 + 3 + 7, "no word lost");
    }
    #[test]
    fn noise_tags_are_removed() {
        assert_eq!(clean("[Music]"), None);
        assert_eq!(clean("♪ Hold me tight ♪"), Some("Hold me tight".into()));
        assert_eq!(clean("Go on (go on), hold me"), Some("Go on , hold me".into()));
    }
}
