//! Musical analysis for Mashup Lab: tempo, beat grid, downbeats, key and vocal activity.
//!
//! * Tempo: spectral-flux onset envelope → autocorrelation with harmonic reinforcement and a
//!   log-normal prior around 120 BPM → parabolic refinement.
//! * Beats: dynamic-programming beat tracker (Ellis, 2007) on that envelope, so the grid follows
//!   small tempo drift.
//! * Downbeats: the bar phase (of four) where kick energy and harmonic change concentrate.
//! * Key: chroma correlated with the Krumhansl–Kessler major/minor profiles.

use crate::{Stereo, SR};
use realfft::RealFftPlanner;
use serde::{Deserialize, Serialize};

const HOP: usize = 441; // 100 frames per second
const FPS: f64 = SR as f64 / HOP as f64;
pub const KEY_NAMES: [&str; 12] = ["C", "C♯", "D", "E♭", "E", "F", "F♯", "G", "A♭", "A", "B♭", "B"];

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct SongAnalysis {
    pub bpm: f64,
    /// Beat times in seconds.
    pub beats: Vec<f64>,
    /// Downbeat (bar start) times in seconds.
    pub downbeats: Vec<f64>,
    /// Pitch class of the tonic, 0 = C.
    pub key: u8,
    pub minor: bool,
    /// How clearly the key stands out (correlation margin over the runner-up).
    pub key_confidence: f32,
    /// When the vocal first enters, in seconds (0 when unknown).
    pub vocal_start: f64,
    /// RMS of the vocal while it is active (0 when unknown).
    pub vocal_rms: f32,
}

impl SongAnalysis {
    pub fn key_name(&self) -> String {
        format!("{} {}", KEY_NAMES[self.key as usize % 12], if self.minor { "minor" } else { "major" })
    }
}

fn mono(a: &Stereo) -> Vec<f32> {
    a[0].iter().zip(&a[1]).map(|(l, r)| 0.5 * (l + r)).collect()
}

/// Spectral-flux onset envelope (full band and low band), centred frames at 100 fps.
fn onset_envelopes(x: &[f32]) -> (Vec<f32>, Vec<f32>) {
    let n_fft = 2048;
    let half = n_fft / 2;
    let mut planner = RealFftPlanner::<f32>::new();
    let fft = planner.plan_fft_forward(n_fft);
    let win: Vec<f32> = (0..n_fft).map(|i| 0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / n_fft as f32).cos()).collect();
    let frames = x.len() / HOP + 1;
    let (mut buf, mut spec) = (fft.make_input_vec(), fft.make_output_vec());
    let bins = half + 1;
    let low_bins = (150.0 * n_fft as f64 / SR as f64).ceil() as usize; // kick region
    let top_bins = (11000.0 * n_fft as f64 / SR as f64) as usize;
    let mut prev = vec![0f32; bins];
    let (mut full, mut low) = (vec![0f32; frames], vec![0f32; frames]);
    for t in 0..frames {
        let c = t * HOP;
        for i in 0..n_fft {
            let idx = c as isize + i as isize - half as isize;
            buf[i] = if idx >= 0 && (idx as usize) < x.len() { x[idx as usize] * win[i] } else { 0.0 };
        }
        fft.process(&mut buf, &mut spec).expect("fft");
        let (mut f, mut l) = (0f32, 0f32);
        for b in 1..top_bins.min(bins) {
            let m = (1.0 + 1000.0 * spec[b].norm()).ln();
            let d = (m - prev[b]).max(0.0);
            f += d;
            if b <= low_bins {
                l += d;
            }
            prev[b] = m;
        }
        full[t] = f;
        low[t] = l;
    }
    (normalise(&full), normalise(&low))
}

/// Remove the local mean (half a second) and scale to unit variance.
fn normalise(v: &[f32]) -> Vec<f32> {
    let w = 25usize;
    let n = v.len();
    let mut prefix = vec![0f64; n + 1];
    for i in 0..n {
        prefix[i + 1] = prefix[i] + v[i] as f64;
    }
    let out: Vec<f32> = (0..n)
        .map(|i| {
            let (a, b) = (i.saturating_sub(w), (i + w + 1).min(n));
            (v[i] - ((prefix[b] - prefix[a]) / (b - a) as f64) as f32).max(0.0)
        })
        .collect();
    let mean = out.iter().map(|x| *x as f64).sum::<f64>() / n.max(1) as f64;
    let sd = (out.iter().map(|x| (*x as f64 - mean).powi(2)).sum::<f64>() / n.max(1) as f64).sqrt().max(1e-9);
    out.iter().map(|x| (*x as f64 / sd) as f32).collect()
}

fn autocorr(env: &[f32], lag: usize) -> f64 {
    if lag >= env.len() {
        return 0.0;
    }
    let s: f64 = env.iter().zip(&env[lag..]).map(|(a, b)| (*a as f64) * (*b as f64)).sum();
    s / (env.len() - lag) as f64
}

/// Global tempo in BPM (60–200).
fn estimate_tempo(env: &[f32]) -> f64 {
    let lag_of = |bpm: f64| 60.0 * FPS / bpm;
    let (lo, hi) = (lag_of(200.0).floor() as usize, lag_of(60.0).ceil() as usize);
    let ac: Vec<f64> = (0..=hi * 3 + 2).map(|l| autocorr(env, l)).collect();
    let score = |l: usize| -> f64 {
        let bpm = 60.0 * FPS / l as f64;
        let prior = (-0.5 * ((bpm / 120.0).log2() / 0.9).powi(2)).exp();
        let base = ac[l] + 0.5 * ac.get(2 * l).copied().unwrap_or(0.0) + 0.33 * ac.get(3 * l).copied().unwrap_or(0.0) + 0.25 * ac[l / 2];
        base * prior
    };
    let best = (lo..=hi).max_by(|a, b| score(*a).total_cmp(&score(*b))).unwrap_or(50);
    // parabolic refinement on the raw autocorrelation
    let (y0, y1, y2) = (ac[best - 1], ac[best], ac[best + 1]);
    let denom = y0 - 2.0 * y1 + y2;
    let delta = if denom.abs() > 1e-12 { (0.5 * (y0 - y2) / denom).clamp(-0.5, 0.5) } else { 0.0 };
    60.0 * FPS / (best as f64 + delta)
}

/// Dynamic-programming beat tracker; returns beat frames.
fn track_beats(env: &[f32], bpm: f64) -> Vec<usize> {
    let n = env.len();
    let period = 60.0 * FPS / bpm;
    let tightness = 100.0;
    let mut score = vec![0f64; n];
    let mut back = vec![usize::MAX; n];
    let (pmin, pmax) = ((period * 0.5).round() as usize, (period * 2.0).round() as usize);
    for t in 0..n {
        let mut best = 0f64;
        let mut arg = usize::MAX;
        if t >= pmin {
            for prev in t.saturating_sub(pmax)..=t - pmin {
                let d = (t - prev) as f64 / period;
                let s = score[prev] - tightness * d.ln().powi(2);
                if arg == usize::MAX || s > best {
                    best = s;
                    arg = prev;
                }
            }
        }
        score[t] = env[t] as f64 + if arg == usize::MAX { 0.0 } else { best.max(0.0) };
        back[t] = if arg != usize::MAX && best > 0.0 { arg } else { usize::MAX };
    }
    // end on the strongest beat within the last period
    let tail = n.saturating_sub(period.ceil() as usize);
    let mut t = (tail..n).max_by(|a, b| score[*a].total_cmp(&score[*b])).unwrap_or(0);
    let mut beats = vec![t];
    while back[t] != usize::MAX {
        t = back[t];
        beats.push(t);
    }
    beats.reverse();
    beats
}

/// Chroma vector (12 pitch classes) of a stretch of mono audio, 80 Hz – 2 kHz.
fn chroma(x: &[f32], from: usize, to: usize, fft: &dyn realfft::RealToComplex<f32>, n_fft: usize) -> [f64; 12] {
    let mut c = [0f64; 12];
    let (mut buf, mut spec) = (fft.make_input_vec(), fft.make_output_vec());
    let hop = n_fft / 2;
    let mut s = from;
    while s + n_fft <= to.min(x.len()) {
        for i in 0..n_fft {
            let w = 0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / n_fft as f32).cos();
            buf[i] = x[s + i] * w;
        }
        fft.process(&mut buf, &mut spec).expect("fft");
        for (b, z) in spec.iter().enumerate().skip(1) {
            let f = b as f64 * SR as f64 / n_fft as f64;
            if !(80.0..=2000.0).contains(&f) {
                continue;
            }
            let pc = ((12.0 * (f / 440.0).log2()).round() as i64 + 69).rem_euclid(12) as usize;
            c[pc] += (z.norm() as f64).sqrt();
        }
        s += hop;
    }
    c
}

fn pearson(a: &[f64; 12], b: &[f64; 12]) -> f64 {
    let (ma, mb) = (a.iter().sum::<f64>() / 12.0, b.iter().sum::<f64>() / 12.0);
    let (mut num, mut da, mut db) = (0.0, 0.0, 0.0);
    for i in 0..12 {
        num += (a[i] - ma) * (b[i] - mb);
        da += (a[i] - ma).powi(2);
        db += (b[i] - mb).powi(2);
    }
    num / (da * db).sqrt().max(1e-12)
}

/// Key of harmonic audio: (tonic pitch class, minor, confidence).
pub fn detect_key(harmonic: &Stereo) -> (u8, bool, f32) {
    const MAJOR: [f64; 12] = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
    const MINOR: [f64; 12] = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
    let x = mono(harmonic);
    let n_fft = 8192;
    let fft = RealFftPlanner::<f32>::new().plan_fft_forward(n_fft);
    let c = chroma(&x, 0, x.len(), fft.as_ref(), n_fft);
    let mut scores: Vec<(f64, u8, bool)> = Vec::with_capacity(24);
    for tonic in 0..12u8 {
        for (minor, profile) in [(false, &MAJOR), (true, &MINOR)] {
            let mut rot = [0f64; 12];
            for i in 0..12 {
                rot[(i + tonic as usize) % 12] = profile[i];
            }
            scores.push((pearson(&c, &rot), tonic, minor));
        }
    }
    scores.sort_by(|a, b| b.0.total_cmp(&a.0));
    (scores[0].1, scores[0].2, (scores[0].0 - scores[1].0) as f32)
}

/// Tempo, beats and downbeats of a mix (or any rhythmic audio).
pub fn rhythm(audio: &Stereo, harmonic: Option<&Stereo>) -> (f64, Vec<f64>, Vec<f64>) {
    let x = mono(audio);
    let (env, low) = onset_envelopes(&x);
    if env.len() < 200 {
        return (120.0, vec![], vec![]);
    }
    let bpm = estimate_tempo(&env);
    let mut frames = track_beats(&env, bpm);
    // Off-beat lock guard: if the kick energy sits between the tracked beats rather than on them
    // (hi-hats on the "and" can pull the tracker there), move the grid by half a beat.
    if frames.len() > 8 {
        let at = |f: usize| low[f.saturating_sub(2)..(f + 3).min(low.len())].iter().cloned().fold(0f32, f32::max) as f64;
        let on: f64 = frames.iter().map(|f| at(*f)).sum();
        let mids: Vec<usize> = frames.windows(2).map(|w| (w[0] + w[1]) / 2).collect();
        let off: f64 = mids.iter().map(|f| at(*f)).sum::<f64>() * frames.len() as f64 / mids.len() as f64;
        if off > on * 1.15 {
            frames = mids;
        }
    }
    // Refine the tempo from the tracked grid: a least-squares line through the beat positions gives
    // the period with sub-frame precision (whole-frame intervals would quantise 124 BPM to 125).
    let bpm = if frames.len() > 8 {
        let k = frames.len() as f64;
        let (mx, my) = ((k - 1.0) / 2.0, frames.iter().map(|f| *f as f64).sum::<f64>() / k);
        let (mut sxy, mut sxx) = (0.0, 0.0);
        for (i, f) in frames.iter().enumerate() {
            sxy += (i as f64 - mx) * (*f as f64 - my);
            sxx += (i as f64 - mx).powi(2);
        }
        let period = sxy / sxx.max(1e-9);
        let fitted = 60.0 * FPS / period;
        if (fitted / bpm - 1.0).abs() < 0.08 { fitted } else { bpm }
    } else {
        bpm
    };
    let beats: Vec<f64> = frames.iter().map(|f| *f as f64 / FPS).collect();

    // Bar phase: kick energy plus harmonic change at the beat, summed over every fourth beat.
    let h = harmonic.map(mono).unwrap_or_else(|| x.clone());
    let n_fft = 4096;
    let fft = RealFftPlanner::<f32>::new().plan_fft_forward(n_fft);
    let beat_chroma: Vec<[f64; 12]> = frames
        .windows(2)
        .map(|w| chroma(&h, w[0] * HOP, w[1] * HOP + n_fft, fft.as_ref(), n_fft))
        .collect();
    let novelty: Vec<f64> = (0..frames.len())
        .map(|k| if k == 0 || k >= beat_chroma.len() { 0.0 } else { 1.0 - pearson(&beat_chroma[k - 1], &beat_chroma[k]).max(-1.0) })
        .collect();
    let kick: Vec<f64> = frames.iter().map(|f| {
        let (a, b) = (f.saturating_sub(2), (*f + 3).min(low.len()));
        low[a..b].iter().cloned().fold(0f32, f32::max) as f64
    }).collect();
    let zs = |v: &[f64]| -> Vec<f64> {
        let m = v.iter().sum::<f64>() / v.len().max(1) as f64;
        let sd = (v.iter().map(|x| (x - m).powi(2)).sum::<f64>() / v.len().max(1) as f64).sqrt().max(1e-9);
        v.iter().map(|x| (x - m) / sd).collect()
    };
    let (kz, nz) = (zs(&kick), zs(&novelty));
    let phase = (0..4)
        .max_by(|a, b| {
            let s = |p: usize| (p..frames.len()).step_by(4).map(|k| kz[k] + nz[k]).sum::<f64>();
            s(*a).total_cmp(&s(*b))
        })
        .unwrap_or(0);
    let downbeats = beats.iter().skip(phase).step_by(4).copied().collect();
    (bpm, beats, downbeats)
}

/// When the vocal first sings, and how loud it is while singing.
pub fn vocal_activity(vocals: &Stereo) -> (f64, f32) {
    let x = mono(vocals);
    let win = SR as usize / 20; // 50 ms
    let rms: Vec<f32> = x.chunks(win).map(|c| (c.iter().map(|v| v * v).sum::<f32>() / c.len() as f32).sqrt()).collect();
    let peak = rms.iter().cloned().fold(0f32, f32::max);
    if peak <= 1e-6 {
        return (0.0, 0.0);
    }
    let gate = peak * 0.1; // −20 dB from the loudest phrase
    // the first moment the voice stays above the gate for half a second
    let start = (0..rms.len()).find(|&i| rms[i..(i + 10).min(rms.len())].iter().filter(|v| **v > gate).count() >= 8).unwrap_or(0);
    let active: Vec<f32> = rms.iter().copied().filter(|v| *v > gate).collect();
    let level = (active.iter().map(|v| v * v).sum::<f32>() / active.len().max(1) as f32).sqrt();
    (start as f64 * win as f64 / SR as f64, level)
}


/// Frames per second of `melody`.
pub const MELODY_FPS: usize = 100;

/// The sung melody of an isolated vocal: fundamental frequency in Hz every 10 ms (0 = not singing).
///
/// YIN pitch detection on a 4× decimated signal (11.025 kHz; plenty for voices, 70–1000 Hz), gated by
/// loudness and periodicity, then median-smoothed with octave-error correction.
pub fn melody(vocals: &Stereo) -> Vec<f32> {
    let x = mono(vocals);
    // decimate by 4 with a short low-pass (8-tap triangle) — voices' fundamentals are far below 2.7 kHz
    let k = [1.0f32, 2.0, 3.0, 4.0, 4.0, 3.0, 2.0, 1.0];
    let ks: f32 = k.iter().sum();
    let d: Vec<f32> = (0..x.len() / 4)
        .map(|i| k.iter().enumerate().map(|(j, w)| x.get(i * 4 + j).copied().unwrap_or(0.0) * w).sum::<f32>() / ks)
        .collect();
    let sr = SR as f32 / 4.0;
    let hop = (sr / MELODY_FPS as f32).round() as usize; // ≈110 samples = 10 ms
    let win = (sr * 0.04) as usize; // 40 ms
    let (tmin, tmax) = ((sr / 1000.0) as usize, (sr / 70.0) as usize);
    let frames = d.len() / hop;
    let rms: Vec<f32> = (0..frames)
        .map(|f| { let s = f * hop; let e = (s + win).min(d.len()); (d[s..e].iter().map(|v| v * v).sum::<f32>() / (e - s).max(1) as f32).sqrt() })
        .collect();
    let peak = rms.iter().cloned().fold(0f32, f32::max);
    let gate = peak * 0.06;
    let mut f0 = vec![0f32; frames];
    let mut diff = vec![0f32; tmax + 2];
    for f in 0..frames {
        let s = f * hop;
        if rms[f] < gate || s + win + tmax + 1 >= d.len() {
            continue;
        }
        // difference function and its cumulative-mean normalisation
        for tau in 1..=tmax + 1 {
            let mut acc = 0f32;
            for j in 0..win {
                let v = d[s + j] - d[s + j + tau];
                acc += v * v;
            }
            diff[tau] = acc;
        }
        let mut run = 0f32;
        let mut cmnd = vec![1f32; tmax + 2];
        for tau in 1..=tmax + 1 {
            run += diff[tau];
            cmnd[tau] = if run > 0.0 { diff[tau] * tau as f32 / run } else { 1.0 };
        }
        // first dip under the threshold, walked down to its local minimum
        let mut best = None;
        let mut tau = tmin.max(2);
        while tau <= tmax {
            if cmnd[tau] < 0.15 {
                while tau < tmax && cmnd[tau + 1] < cmnd[tau] { tau += 1; }
                best = Some(tau);
                break;
            }
            tau += 1;
        }
        let Some(t) = best else { continue };
        if cmnd[t] > 0.3 { continue; }
        let (a, b, c) = (cmnd[t - 1], cmnd[t], cmnd[t + 1]);
        let den = a - 2.0 * b + c;
        let shift = if den.abs() > 1e-9 { (0.5 * (a - c) / den).clamp(-0.5, 0.5) } else { 0.0 };
        f0[f] = sr / (t as f32 + shift);
    }
    // smooth: a median of 5 voiced neighbours, folding lone octave jumps back onto the line
    let mut out = f0.clone();
    for i in 0..frames {
        if f0[i] <= 0.0 { continue; }
        let mut n: Vec<f32> = (i.saturating_sub(2)..(i + 3).min(frames)).map(|j| f0[j]).filter(|v| *v > 0.0).collect();
        if n.len() < 3 { continue; }
        n.sort_by(|a, b| a.total_cmp(b));
        let med = n[n.len() / 2];
        let mut v = f0[i];
        let r = v / med;
        if (r - 2.0).abs() < 0.12 { v /= 2.0; } else if (r - 0.5).abs() < 0.06 { v *= 2.0; }
        out[i] = v;
    }
    out
}


/// Where a separately recorded take belongs against a reference (the song's vocal, or its mix):
/// the shift in seconds (positive = the take starts later) that best lines up their onsets, searched
/// within ±`max_lag` seconds. Cross-correlates 100 fps onset envelopes (rises in log energy), which
/// follow phrase and syllable starts regardless of pitch or voice.
pub fn align_offset(reference: &Stereo, take: &Stereo, max_lag: f64) -> f64 {
    fn onsets(a: &Stereo) -> Vec<f32> {
        let x = mono(a);
        let hop = SR as usize / 100;
        let e: Vec<f32> = x.chunks(hop).map(|c| (c.iter().map(|v| v * v).sum::<f32>() / c.len() as f32 + 1e-9).ln()).collect();
        let mut d: Vec<f32> = (0..e.len()).map(|i| if i == 0 { 0.0 } else { (e[i] - e[i - 1]).max(0.0) }).collect();
        let mean = d.iter().sum::<f32>() / d.len().max(1) as f32;
        for v in &mut d { *v = (*v - mean).max(0.0); }
        d
    }
    let (r, t) = (onsets(reference), onsets(take));
    if r.len() < 10 || t.len() < 10 {
        return 0.0;
    }
    let max = (max_lag * 100.0) as i64;
    let (mut best, mut best_lag) = (f64::MIN, 0i64);
    for lag in -max..=max {
        // take frame i sits at reference frame i + lag
        let mut s = 0f64;
        for (i, tv) in t.iter().enumerate() {
            let j = i as i64 + lag;
            if j >= 0 && (j as usize) < r.len() {
                s += (*tv as f64) * (r[j as usize] as f64);
            }
        }
        if s > best { best = s; best_lag = lag; }
    }
    best_lag as f64 / 100.0
}

/// Full analysis of a separated song.
pub fn analyse(mix: &Stereo, vocals: Option<&Stereo>, harmonic: Option<&Stereo>) -> SongAnalysis {
    let (bpm, beats, downbeats) = rhythm(mix, harmonic);
    let (key, minor, key_confidence) = detect_key(harmonic.unwrap_or(mix));
    let (vocal_start, vocal_rms) = vocals.map(vocal_activity).unwrap_or((0.0, 0.0));
    SongAnalysis { bpm, beats, downbeats, key, minor, key_confidence, vocal_start, vocal_rms }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A four-on-the-floor groove with hats and a chord pad, at `bpm`, in A major (I–V–vi–IV).
    fn groove(bpm: f64, secs: f64) -> Stereo {
        let n = (secs * SR as f64) as usize;
        let mut v = vec![0f32; n];
        let beat = 60.0 / bpm;
        let midi = |m: f64| 440.0 * 2f64.powf((m - 69.0) / 12.0);
        let chords = [[57.0, 61.0, 64.0], [52.0, 56.0, 59.0], [54.0, 57.0, 61.0], [50.0, 54.0, 57.0]]; // A E F#m D
        let mut b = 0usize;
        while (b as f64 * beat) < secs - beat {
            let s = (b as f64 * beat * SR as f64) as usize;
            let accent = if b % 4 == 0 { 1.0 } else { 0.7 };
            for j in 0..(0.25 * SR as f64) as usize {
                if s + j >= n { break; }
                let t = j as f64 / SR as f64;
                v[s + j] += (accent * (2.0 * std::f64::consts::PI * (50.0 + 80.0 * (-t * 25.0).exp()) * t).sin() * (-t * 9.0).exp()) as f32 * 0.6;
            }
            let hs = s + (beat * 0.5 * SR as f64) as usize;
            let mut seed = (b as u32).wrapping_mul(2654435761);
            for j in 0..2000 {
                if hs + j >= n { break; }
                seed ^= seed << 13; seed ^= seed >> 17; seed ^= seed << 5;
                v[hs + j] += ((seed as f32 / u32::MAX as f32) - 0.5) * 0.15 * (-(j as f32) / 400.0).exp();
            }
            b += 1;
        }
        let bar = beat * 4.0;
        for i in 0..n {
            let t = i as f64 / SR as f64;
            let ch = chords[((t / bar) as usize) % 4];
            let mut p = 0.0;
            for m in ch { p += (2.0 * std::f64::consts::PI * midi(m) * t).sin() + 0.4 * (2.0 * std::f64::consts::PI * midi(m + 12.0) * t).sin(); }
            v[i] += (p * 0.03) as f32;
        }
        [v.clone(), v]
    }

    #[test]
    fn tempo_and_grid_are_found() {
        for bpm in [92.0, 124.0, 140.0] {
            let g = groove(bpm, 30.0);
            let (est, beats, downbeats) = rhythm(&g, None);
            assert!((est - bpm).abs() < 1.0, "expected {bpm}, got {est:.2}");
            assert!(beats.len() > 30);
            let period = 60.0 / bpm;
            // beats sit on the kicks (multiples of the period), within 25 ms
            for b in beats.iter().skip(2).take(20) {
                let off = (b / period - (b / period).round()).abs() * period;
                assert!(off < 0.025, "{bpm} BPM: beat at {b:.3}s is {:.0} ms off the grid", off * 1000.0);
            }
            // downbeats land on bar starts (every fourth kick)
            let bar = period * 4.0;
            let ok = downbeats.iter().skip(1).take(6).filter(|d| ((*d / bar) - (*d / bar).round()).abs() * bar < 0.04).count();
            assert!(ok >= 5, "{bpm} BPM: only {ok}/6 downbeats on bar starts: {:?}", &downbeats[..downbeats.len().min(7)]);
        }
    }

    #[test]
    fn key_is_found() {
        let (tonic, minor, _) = detect_key(&groove(110.0, 20.0));
        assert_eq!((KEY_NAMES[tonic as usize], minor), ("A", false));
    }

    #[test]
    fn melody_follows_sung_notes() {
        // a "voice": harmonics with a slight vibrato, notes A3 → C#4 → E4, a silence, then A4
        let notes = [(220.0f32, 0.6f32), (277.18, 0.6), (329.63, 0.6), (0.0, 0.4), (440.0, 0.6)];
        let mut v = Vec::new();
        let mut phase = 0f32;
        for (hz, secs) in notes {
            for i in 0..(secs * SR as f32) as usize {
                if hz == 0.0 { v.push(0.0); continue; }
                let t = i as f32 / SR as f32;
                let f = hz * (1.0 + 0.004 * (2.0 * std::f32::consts::PI * 5.5 * t).sin());
                phase += 2.0 * std::f32::consts::PI * f / SR as f32;
                v.push(0.4 * phase.sin() + 0.25 * (2.0 * phase).sin() + 0.12 * (3.0 * phase).sin());
            }
        }
        let m = melody(&[v.clone(), v]);
        let mut start = 0.0f32;
        for (hz, secs) in notes {
            let (a, b) = (((start + 0.12) * 100.0) as usize, ((start + secs - 0.08) * 100.0) as usize);
            let seg: Vec<f32> = m[a..b.min(m.len())].to_vec();
            if hz == 0.0 {
                assert!(seg.iter().all(|f| *f == 0.0), "silence should be unvoiced");
            } else {
                let voiced: Vec<f32> = seg.iter().copied().filter(|f| *f > 0.0).collect();
                assert!(voiced.len() as f32 > seg.len() as f32 * 0.9, "{hz} Hz: only {}/{} frames voiced", voiced.len(), seg.len());
                let mut sorted = voiced.clone(); sorted.sort_by(|a, b| a.total_cmp(b));
                let cents = 1200.0 * (sorted[sorted.len() / 2] / hz).log2();
                assert!(cents.abs() < 15.0, "{hz} Hz detected {} cents off", cents);
            }
            start += secs;
        }
    }

    #[test]
    fn a_take_is_lined_up_with_the_song() {
        // reference "vocal": phrases of a tone with syllable bursts; the take is the same rhythm,
        // sung at a different pitch, starting 1.37 s late, with some noise
        let n = SR as usize * 20;
        let mut rf = vec![0f32; n];
        let mut seed = 7u32;
        let mut noise = || { seed ^= seed << 13; seed ^= seed >> 17; seed ^= seed << 5; (seed as f32 / u32::MAX as f32) - 0.5 };
        let syll = [0.5f32, 0.8, 1.1, 1.6, 2.9, 3.2, 3.4, 4.1, 5.5, 5.75, 6.4, 7.8, 8.1, 9.6, 10.0, 11.2, 12.9, 13.3, 14.0, 15.5];
        let mut tk = vec![0f32; n];
        for (k, s) in syll.iter().enumerate() {
            let len = (0.18 + 0.05 * (k % 3) as f32) * SR as f32;
            for j in 0..len as usize {
                let env = (1.0 - j as f32 / len) * 0.5;
                let i = (s * SR as f32) as usize + j;
                if i < n { rf[i] += env * (2.0 * std::f32::consts::PI * 220.0 * j as f32 / SR as f32).sin(); }
                let i2 = ((s + 1.37) * SR as f32) as usize + j;
                if i2 < n { tk[i2] += env * (2.0 * std::f32::consts::PI * 330.0 * j as f32 / SR as f32).sin(); }
            }
        }
        for v in tk.iter_mut() { *v += noise() * 0.02; }
        let off = align_offset(&[rf.clone(), rf], &[tk.clone(), tk], 5.0);
        assert!((off + 1.37).abs() < 0.03, "found {off:.2} s, expected -1.37 s (the take started 1.37 s late)");
    }
}
