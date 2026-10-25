//! Mixing effects for everyone: four plain-language knobs per stem, a shared reverb, a safety limiter,
//! and "level out" (an automatic vocal rider).
//!
//! Every algorithm here is mirrored line for line in `ui/fx-worklet.js`, which runs the live preview
//! on the audio thread, so what you hear while dragging is what an export renders. The two are checked
//! against each other on the same test signal.
//!
//! - Warmth: low shelf at 220 Hz, 0 … +6 dB.
//! - Clarity (−1 … +1): presence peak at 3.2 kHz and an air shelf at 8 kHz; negative values darken.
//! - Punch: feed-forward compressor (threshold −8 … −30 dBFS, ratio 1 … 4, 8 ms / 120 ms) with
//!   half-compensating make-up gain.
//! - Width (0 … 1, 0.5 = as recorded): mid/side, side × 2·width.
//! - Space: post-fader send to one shared Freeverb.
//! - Limiter: −1 dBFS ceiling, 5 ms look-ahead, 80 ms release; latency compensated in exports.

use crate::{Stereo, SR};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct FxParams {
    pub warmth: f32,
    pub clarity: f32,
    pub punch: f32,
    pub width: f32,
    pub space: f32,
}
impl Default for FxParams {
    fn default() -> Self {
        FxParams { warmth: 0.0, clarity: 0.0, punch: 0.0, width: 0.5, space: 0.0 }
    }
}
impl FxParams {
    /// No tonal change at all (the stem passes through untouched).
    pub fn is_neutral(&self) -> bool {
        self.warmth.abs() < 1e-4 && self.clarity.abs() < 1e-4 && self.punch.abs() < 1e-4 && (self.width - 0.5).abs() < 1e-4
    }
    /// Send level into the shared reverb.
    pub fn send(&self) -> f32 {
        self.space.clamp(0.0, 1.0).powf(1.5)
    }
}

// ───────────────────────── filters (RBJ cookbook, transposed direct form II) ─────────────────────────

#[derive(Clone, Copy, Default)]
struct Biquad {
    b0: f64,
    b1: f64,
    b2: f64,
    a1: f64,
    a2: f64,
    z1: [f64; 2],
    z2: [f64; 2],
}
impl Biquad {
    fn new(b: [f64; 3], a: [f64; 3]) -> Self {
        Biquad { b0: b[0] / a[0], b1: b[1] / a[0], b2: b[2] / a[0], a1: a[1] / a[0], a2: a[2] / a[0], ..Default::default() }
    }
    fn low_shelf(f: f64, db: f64) -> Self {
        let a = 10f64.powf(db / 40.0);
        let w = 2.0 * std::f64::consts::PI * f / SR as f64;
        let (c, alpha) = (w.cos(), w.sin() / 2.0 * 2f64.sqrt());
        let s = 2.0 * a.sqrt() * alpha;
        Self::new(
            [a * ((a + 1.0) - (a - 1.0) * c + s), 2.0 * a * ((a - 1.0) - (a + 1.0) * c), a * ((a + 1.0) - (a - 1.0) * c - s)],
            [(a + 1.0) + (a - 1.0) * c + s, -2.0 * ((a - 1.0) + (a + 1.0) * c), (a + 1.0) + (a - 1.0) * c - s],
        )
    }
    fn high_shelf(f: f64, db: f64) -> Self {
        let a = 10f64.powf(db / 40.0);
        let w = 2.0 * std::f64::consts::PI * f / SR as f64;
        let (c, alpha) = (w.cos(), w.sin() / 2.0 * 2f64.sqrt());
        let s = 2.0 * a.sqrt() * alpha;
        Self::new(
            [a * ((a + 1.0) + (a - 1.0) * c + s), -2.0 * a * ((a - 1.0) + (a + 1.0) * c), a * ((a + 1.0) + (a - 1.0) * c - s)],
            [(a + 1.0) - (a - 1.0) * c + s, 2.0 * ((a - 1.0) - (a + 1.0) * c), (a + 1.0) - (a - 1.0) * c - s],
        )
    }
    fn peaking(f: f64, q: f64, db: f64) -> Self {
        let a = 10f64.powf(db / 40.0);
        let w = 2.0 * std::f64::consts::PI * f / SR as f64;
        let (c, alpha) = (w.cos(), w.sin() / (2.0 * q));
        Self::new([1.0 + alpha * a, -2.0 * c, 1.0 - alpha * a], [1.0 + alpha / a, -2.0 * c, 1.0 - alpha / a])
    }
    #[inline]
    fn run(&mut self, ch: usize, x: f64) -> f64 {
        let y = self.b0 * x + self.z1[ch];
        self.z1[ch] = self.b1 * x - self.a1 * y + self.z2[ch];
        self.z2[ch] = self.b2 * x - self.a2 * y;
        y
    }
}

/// The four knobs applied to one stem.
pub fn process_stem(audio: &Stereo, p: &FxParams) -> Stereo {
    if p.is_neutral() {
        return audio.clone();
    }
    let (w, c, k, wd) = (p.warmth.clamp(0.0, 1.0) as f64, p.clarity.clamp(-1.0, 1.0) as f64, p.punch.clamp(0.0, 1.0) as f64, p.width.clamp(0.0, 1.0) as f64);
    let mut warm = Biquad::low_shelf(220.0, 6.0 * w);
    let mut pres = Biquad::peaking(3200.0, 0.9, if c > 0.0 { 4.0 * c } else { 1.5 * c });
    let mut air = Biquad::high_shelf(8000.0, if c > 0.0 { 4.0 * c } else { 9.0 * c });
    let thr = -8.0 - 22.0 * k;
    let ratio = 1.0 + 3.0 * k;
    let makeup = 10f64.powf(if k > 0.0 { (-thr * (1.0 - 1.0 / ratio) * 0.5).min(9.0) } else { 0.0 } / 20.0);
    let (att, rel) = (1.0 - (-1.0 / (0.008 * SR as f64)).exp(), 1.0 - (-1.0 / (0.120 * SR as f64)).exp());
    let mut env = 0.0f64;
    let n = audio[0].len();
    let mut out: Stereo = [vec![0.0; n], vec![0.0; n]];
    for i in 0..n {
        let mut l = audio[0][i] as f64;
        let mut r = audio[1][i] as f64;
        l = air.run(0, pres.run(0, warm.run(0, l)));
        r = air.run(1, pres.run(1, warm.run(1, r)));
        if k > 0.0 {
            let lvl = l.abs().max(r.abs());
            env += (if lvl > env { att } else { rel }) * (lvl - env);
            let db = 20.0 * env.max(1e-9).log10();
            let gr = if db > thr { (thr - db) * (1.0 - 1.0 / ratio) } else { 0.0 };
            let g = 10f64.powf(gr / 20.0) * makeup;
            l *= g;
            r *= g;
        }
        let (m, s) = ((l + r) * 0.5, (l - r) * 0.5 * 2.0 * wd);
        out[0][i] = (m + s) as f32;
        out[1][i] = (m - s) as f32;
    }
    out
}

// ───────────────────────── reverb (Freeverb) ─────────────────────────

const COMBS: [usize; 8] = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
const ALLPASSES: [usize; 4] = [556, 441, 341, 225];
const SPREAD: usize = 23;
const ROOM: f64 = 0.84; // feedback
const DAMP: f64 = 0.3;
const IN_GAIN: f64 = 0.015;
const WET: f64 = 3.0;

/// The shared reverb: input is the sum of every stem's send; output is the wet signal only.
pub fn reverb(input: &Stereo) -> Stereo {
    let n = input[0].len();
    let mut out: Stereo = [vec![0.0; n], vec![0.0; n]];
    for ch in 0..2 {
        let off = if ch == 1 { SPREAD } else { 0 };
        let mut combs: Vec<(Vec<f64>, usize, f64)> = COMBS.iter().map(|&d| (vec![0.0; d + off], 0usize, 0.0f64)).collect();
        let mut aps: Vec<(Vec<f64>, usize)> = ALLPASSES.iter().map(|&d| (vec![0.0; d + off], 0usize)).collect();
        for i in 0..n {
            let x = (input[0][i] as f64 + input[1][i] as f64) * IN_GAIN;
            let mut acc = 0.0;
            for (buf, idx, store) in combs.iter_mut() {
                let y = buf[*idx];
                *store = y * (1.0 - DAMP) + *store * DAMP;
                buf[*idx] = x + *store * ROOM;
                *idx = (*idx + 1) % buf.len();
                acc += y;
            }
            for (buf, idx) in aps.iter_mut() {
                let b = buf[*idx];
                buf[*idx] = acc + b * 0.5;
                acc = b - acc;
                *idx = (*idx + 1) % buf.len();
            }
            out[ch][i] = (acc * WET) as f32;
        }
    }
    out
}

// ───────────────────────── safety limiter ─────────────────────────

pub const CEILING: f32 = 0.891_250_9; // −1 dBFS
pub const LOOKAHEAD: usize = 220; // 5 ms at 44.1 kHz

/// Limit to −1 dBFS with a 5 ms look-ahead. Exports pass `compensate = true` to remove the look-ahead
/// delay; the live preview runs the same thing in real time (and so plays 5 ms late, everywhere alike).
pub fn limit(input: &Stereo, compensate: bool) -> Stereo {
    let n = input[0].len();
    let rel = 1.0 - (-1.0 / (0.080 * SR as f64)).exp();
    let peak: Vec<f64> = (0..n).map(|i| (input[0][i].abs().max(input[1][i].abs())) as f64).collect();
    let mut out: Stereo = [vec![0.0; n], vec![0.0; n]];
    let mut g = 1.0f64;
    let at = |i: usize| -> f64 { if i < n { peak[i] } else { 0.0 } };
    // sliding maximum over the look-ahead window (monotonic queue: O(1) per sample)
    let mut q: std::collections::VecDeque<usize> = std::collections::VecDeque::new();
    for t in 0..n + if compensate { LOOKAHEAD } else { 0 } {
        // sample t enters the look-ahead window; sample t − LOOKAHEAD leaves it and is output
        while q.back().map(|&j| at(j) <= at(t)).unwrap_or(false) { q.pop_back(); }
        q.push_back(t);
        while q.front().map(|&j| j + LOOKAHEAD < t).unwrap_or(false) { q.pop_front(); }
        let m = at(*q.front().unwrap());
        let need = if m > CEILING as f64 { CEILING as f64 / m } else { 1.0 };
        g = if need < g { need } else { g + (need - g) * rel };
        let src = t as isize - LOOKAHEAD as isize;
        let dst = if compensate { src } else { t as isize };
        if src >= 0 && (dst as usize) < n && dst >= 0 {
            out[0][dst as usize] = (input[0][src as usize] as f64 * g) as f32;
            out[1][dst as usize] = (input[1][src as usize] as f64 * g) as f32;
        }
    }
    out
}

// ───────────────────────── level out (automatic rider) ─────────────────────────

/// Even out loud and quiet passages, like a vocal rider: the 50 ms loudness, smoothed over ~0.4 s, is
/// brought toward the stem's typical (median) singing level, within −9 … +9 dB. Silence is left alone.
pub fn level(audio: &Stereo) -> Stereo {
    let hop = SR as usize / 20;
    let n = audio[0].len();
    let rms: Vec<f64> = (0..n.div_ceil(hop))
        .map(|k| {
            let (a, b) = (k * hop, ((k + 1) * hop).min(n));
            let s: f64 = (a..b).map(|i| { let m = 0.5 * (audio[0][i] + audio[1][i]) as f64; m * m }).sum();
            (s / (b - a).max(1) as f64).sqrt()
        })
        .collect();
    // smooth over 8 frames (≈ 0.4 s) so syllables aren't pumped
    let sm: Vec<f64> = (0..rms.len()).map(|k| { let (a, b) = (k.saturating_sub(4), (k + 5).min(rms.len())); rms[a..b].iter().sum::<f64>() / (b - a) as f64 }).collect();
    let top = sm.iter().cloned().fold(0.0, f64::max);
    if top <= 1e-6 { return audio.clone(); }
    let gate = top * 0.03; // −30 dB below the loudest part
    let mut voiced: Vec<f64> = sm.iter().cloned().filter(|v| *v > gate).collect();
    if voiced.is_empty() { return audio.clone(); }
    voiced.sort_by(|a, b| a.total_cmp(b));
    let target = voiced[voiced.len() / 2];
    let want: Vec<f64> = sm.iter().map(|v| if *v > gate { (20.0 * (target / v).log10()).clamp(-9.0, 9.0) } else { 0.0 }).collect();
    // glide between frames (attack 150 ms, release 400 ms in dB) and interpolate per sample
    let (att, rel) = (1.0 - (-1.0f64 / 3.0).exp(), 1.0 - (-1.0f64 / 8.0).exp());
    let mut cur = 0.0f64;
    let gdb: Vec<f64> = want.iter().map(|w| { cur += (if *w < cur { att } else { rel }) * (w - cur); cur }).collect();
    let mut out: Stereo = [vec![0.0; n], vec![0.0; n]];
    for i in 0..n {
        let f = i as f64 / hop as f64 - 0.5;
        let k = f.floor().max(0.0) as usize;
        let t = (f - k as f64).clamp(0.0, 1.0);
        let db = gdb[k.min(gdb.len() - 1)] * (1.0 - t) + gdb[(k + 1).min(gdb.len() - 1)] * t;
        let g = 10f64.powf(db / 20.0) as f32;
        out[0][i] = audio[0][i] * g;
        out[1][i] = audio[1][i] * g;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    fn tone(hz: f32, secs: f32, amp: f32) -> Vec<f32> {
        (0..(secs * SR as f32) as usize).map(|i| amp * (2.0 * std::f32::consts::PI * hz * i as f32 / SR as f32).sin()).collect()
    }
    fn rms(x: &[f32]) -> f32 { (x.iter().map(|v| v * v).sum::<f32>() / x.len() as f32).sqrt() }
    fn db(a: f32, b: f32) -> f32 { 20.0 * (a / b).log10() }

    #[test]
    fn neutral_settings_change_nothing() {
        let x = tone(440.0, 0.5, 0.3);
        let a: Stereo = [x.clone(), x];
        assert_eq!(process_stem(&a, &FxParams::default()), a);
    }
    #[test]
    fn warmth_lifts_lows_and_clarity_lifts_highs() {
        let lo = tone(80.0, 1.0, 0.1);
        let hi = tone(10000.0, 1.0, 0.1);
        let w = process_stem(&[lo.clone(), lo.clone()], &FxParams { warmth: 1.0, ..Default::default() });
        let c = process_stem(&[hi.clone(), hi.clone()], &FxParams { clarity: 1.0, ..Default::default() });
        let d = process_stem(&[hi.clone(), hi.clone()], &FxParams { clarity: -1.0, ..Default::default() });
        let tail = |v: &[f32]| rms(&v[v.len() / 2..]);
        let (gw, gc, gd) = (db(tail(&w[0]), tail(&lo)), db(tail(&c[0]), tail(&hi)), db(tail(&d[0]), tail(&hi)));
        assert!((gw - 6.0).abs() < 0.7, "warmth at 80 Hz: {gw:.2} dB");
        assert!(gc > 3.0 && gc < 6.5, "clarity at 10 kHz: {gc:.2} dB");
        assert!(gd < -6.0, "negative clarity darkens 10 kHz: {gd:.2} dB");
        let mid = tone(1000.0, 1.0, 0.1);
        let m = process_stem(&[mid.clone(), mid.clone()], &FxParams { warmth: 1.0, ..Default::default() });
        assert!(db(tail(&m[0]), tail(&mid)).abs() < 0.8, "1 kHz stays about the same with warmth");
    }
    #[test]
    fn punch_evens_out_loud_and_quiet() {
        let mut x = tone(200.0, 1.0, 0.05);
        x.extend(tone(200.0, 1.0, 0.8));
        let p = process_stem(&[x.clone(), x.clone()], &FxParams { punch: 1.0, ..Default::default() });
        let n = SR as usize;
        let before = db(rms(&x[n + n / 2..]), rms(&x[n / 2..n]));
        let after = db(rms(&p[0][n + n / 2..]), rms(&p[0][n / 2..n]));
        assert!(after < before - 8.0, "loud/quiet gap {before:.1} dB → {after:.1} dB");
    }
    #[test]
    fn width_narrows_and_widens() {
        let l = tone(300.0, 0.3, 0.3);
        let r = tone(300.0, 0.3, 0.1);
        let side = |a: &Stereo| rms(&a[0].iter().zip(&a[1]).map(|(x, y)| x - y).collect::<Vec<_>>());
        let a: Stereo = [l, r];
        let mono = process_stem(&a, &FxParams { width: 0.0, ..Default::default() });
        let wide = process_stem(&a, &FxParams { width: 1.0, ..Default::default() });
        assert!(side(&mono) < 1e-6, "width 0 is mono");
        assert!((side(&wide) / side(&a) - 2.0).abs() < 0.01, "width 1 doubles the stereo difference");
    }
    #[test]
    fn the_limiter_never_lets_a_sample_past_the_ceiling() {
        let mut x = tone(150.0, 1.0, 0.5);
        x.extend(tone(150.0, 0.2, 2.5)); // 8 dB over
        x.extend(tone(150.0, 1.0, 0.5));
        let y = limit(&[x.clone(), x.clone()], true);
        let peak = y[0].iter().fold(0f32, |m, v| m.max(v.abs()));
        assert!(peak <= CEILING + 1e-4, "peak {peak}");
        let quiet = rms(&y[0][(0.2 * SR as f32) as usize..(0.8 * SR as f32) as usize]);
        assert!((quiet / rms(&x[(0.2 * SR as f32) as usize..(0.8 * SR as f32) as usize]) - 1.0).abs() < 1e-3, "quiet parts untouched");
        // compensated: no delay
        let first = y[0].iter().position(|v| v.abs() > 0.1).unwrap();
        let first_in = x.iter().position(|v| v.abs() > 0.1).unwrap();
        assert_eq!(first, first_in);
    }
    #[test]
    fn reverb_is_a_decaying_tail() {
        let mut x = vec![0f32; SR as usize * 3];
        x[100] = 1.0;
        let y = reverb(&[x.clone(), x]);
        let e = |a: f32, b: f32| rms(&y[0][(a * SR as f32) as usize..(b * SR as f32) as usize]);
        assert!(e(0.05, 0.3) > 1e-3, "there is a tail");
        assert!(e(0.05, 0.3) > e(1.0, 1.25) * 3.0, "and it decays");
        assert!(y[0] != y[1], "and it is stereo");
    }
    #[test]
    fn level_out_evens_a_quiet_and_a_loud_phrase() {
        let mut x = tone(220.0, 2.0, 0.05); // quiet phrase (−20 dB)
        x.extend(vec![0.0; SR as usize / 2]);
        x.extend(tone(220.0, 2.0, 0.5)); // loud phrase
        let y = level(&[x.clone(), x.clone()]);
        let n = SR as usize;
        let (q, l) = (rms(&y[0][n / 2..3 * n / 2]), rms(&y[0][3 * n..4 * n]));
        let gap_before = db(rms(&x[3 * n..4 * n]), rms(&x[n / 2..3 * n / 2]));
        let gap_after = db(l, q);
        assert!(gap_after.abs() < gap_before.abs() - 8.0, "phrase gap {gap_before:.1} dB → {gap_after:.1} dB");
        assert!(y[0][2 * n + n / 4].abs() < 1e-6, "silence stays silent");
    }
}
