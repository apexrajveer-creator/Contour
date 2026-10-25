//! "Tune it": pitch-correct a sung take to a song's melody (or to its key), with formants preserved.
//!
//! Per 10 ms frame: the take's pitch is compared with a target — the original singer's note moved into
//! the singer's own octave (Melody), or the nearest note of the key (Key, and the fallback wherever
//! the original is silent). The correction is scaled by Strength, smoothed by Retune speed (0 ms =
//! instant snap), and measured from each note's centre when vibrato is kept, so expression survives.

use crate::{stretch, Stereo, SR};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct TuneSettings {
    /// "melody" or "key".
    pub mode: String,
    /// 0 … 1: how far each note moves toward its target.
    pub strength: f32,
    /// How quickly a note settles on its target, ms (0 = instant, the "robotic" sound).
    pub retune_ms: f32,
    /// Correct each note's centre, leaving vibrato and slides as sung.
    pub keep_vibrato: bool,
    /// The song's key (pitch class of the tonic, 0 = C) and mode.
    pub key: u8,
    pub minor: bool,
}

impl Default for TuneSettings {
    fn default() -> Self {
        TuneSettings { mode: "melody".into(), strength: 1.0, retune_ms: 60.0, keep_vibrato: true, key: 0, minor: false }
    }
}

/// Pitch curves for display: what was sung, the target, and the result (Hz per frame, 0 = silent).
#[derive(Clone, Debug, Serialize)]
pub struct TuneCurves {
    pub sung: Vec<f32>,
    pub target: Vec<f32>,
    pub tuned: Vec<f32>,
    pub fps: usize,
    /// Share of sung frames that end within 25 cents of their target.
    pub in_tune_before: f32,
    pub in_tune_after: f32,
}

const MAJOR: [i32; 7] = [0, 2, 4, 5, 7, 9, 11];
const MINOR: [i32; 7] = [0, 2, 3, 5, 7, 8, 10];
fn midi(hz: f32) -> f32 {
    69.0 + 12.0 * (hz / 440.0).log2()
}
fn hz(m: f32) -> f32 {
    440.0 * 2f32.powf((m - 69.0) / 12.0)
}

/// Nearest note of the key to a (fractional) MIDI pitch.
pub fn snap_to_key(m: f32, key: u8, minor: bool) -> f32 {
    let scale = if minor { &MINOR } else { &MAJOR };
    let base = m.floor() as i32;
    let mut best = m.round();
    let mut bd = f32::MAX;
    for cand in base - 2..=base + 2 {
        let pc = (cand - key as i32).rem_euclid(12);
        if scale.contains(&pc) {
            let d = (cand as f32 - m).abs();
            if d < bd { bd = d; best = cand as f32; }
        }
    }
    best
}

/// The correction (semitones per frame) and display curves for a take, given its pitch and the melody.
pub fn plan(sung: &[f32], melody: &[f32], s: &TuneSettings) -> (Vec<f32>, TuneCurves) {
    let n = sung.len();
    let fps = crate::analysis::MELODY_FPS;
    // note centres: a ±70 ms average of the sung pitch within each voiced stretch
    let sm: Vec<f32> = sung.iter().map(|f| if *f > 0.0 { midi(*f) } else { 0.0 }).collect();
    let centre: Vec<f32> = (0..n)
        .map(|i| {
            if sm[i] == 0.0 { return 0.0; }
            let (mut sum, mut k) = (0.0, 0.0);
            for j in i.saturating_sub(7)..(i + 8).min(n) {
                if sm[j] == 0.0 { continue; }
                sum += sm[j]; k += 1.0;
            }
            sum / k
        })
        .collect();
    let mut target = vec![0f32; n];
    let mut raw = vec![0f32; n];
    for i in 0..n {
        if sm[i] == 0.0 { continue; }
        let base = if s.keep_vibrato { centre[i] } else { sm[i] };
        let reference = if s.mode == "melody" {
            (0..=5).flat_map(|d| [i + d, i.wrapping_sub(d)]).filter_map(|j| melody.get(j).copied()).find(|f| *f > 0.0)
        } else {
            None
        };
        let t = match reference {
            Some(r) => {
                let rm = midi(r);
                rm + 12.0 * ((base - rm) / 12.0).round() // the original's note, in the singer's octave
            }
            None => snap_to_key(base, s.key, s.minor),
        };
        target[i] = t;
        raw[i] = (t - base).clamp(-7.0, 7.0) * s.strength.clamp(0.0, 1.0);
    }
    // retune speed: a one-pole glide toward each frame's correction (restarting at each new phrase)
    let a = if s.retune_ms <= 0.5 { 1.0 } else { 1.0 - (-1000.0 / (s.retune_ms * fps as f32)).exp() };
    let mut semis = vec![0f32; n];
    let mut state = 0f32;
    for i in 0..n {
        if sm[i] == 0.0 { state = 0.0; continue; }
        if i == 0 || sm[i - 1] == 0.0 { state = raw[i] * a; }
        state += (raw[i] - state) * a;
        semis[i] = state;
    }
    let tuned: Vec<f32> = (0..n).map(|i| if sm[i] > 0.0 { hz(sm[i] + semis[i]) } else { 0.0 }).collect();
    let in_tune = |m: &dyn Fn(usize) -> f32| {
        let (mut ok, mut tot) = (0.0, 0.0);
        for i in 0..n {
            if sm[i] == 0.0 || target[i] == 0.0 { continue; }
            tot += 1.0;
            if (m(i) - target[i]).abs() <= 0.25 { ok += 1.0; }
        }
        if tot > 0.0 { ok / tot } else { 0.0 }
    };
    let before = in_tune(&|i| centre[i]);
    let after = in_tune(&|i| centre[i] + semis[i]);
    let curves = TuneCurves {
        sung: sung.to_vec(),
        target: target.iter().map(|m| if *m > 0.0 { hz(*m) } else { 0.0 }).collect(),
        tuned,
        fps,
        in_tune_before: before,
        in_tune_after: after,
    };
    (semis, curves)
}

/// Tune a take (`sung` is its pitch from `analysis::melody`).
pub fn tune(take: &Stereo, sung: &[f32], melody: &[f32], s: &TuneSettings) -> (Stereo, TuneCurves) {
    let (semis, curves) = plan(sung, melody, s);
    let hop = SR as usize / crate::analysis::MELODY_FPS;
    (stretch::retune(take, &semis, hop), curves)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::analysis::melody;

    /// A "voice" singing `notes` (Hz, seconds), with short gaps between them.
    fn sing(notes: &[(f32, f32)]) -> Stereo {
        let mut v = Vec::new();
        let mut phase = 0f32;
        for (f, secs) in notes {
            for i in 0..(secs * SR as f32) as usize {
                let t = i as f32 / SR as f32;
                let fv = f * (1.0 + 0.003 * (2.0 * std::f32::consts::PI * 5.0 * t).sin());
                phase += 2.0 * std::f32::consts::PI * fv / SR as f32;
                let env = (t / 0.02).min(1.0) * ((secs - t) / 0.02).min(1.0);
                v.push(env * (0.35 * phase.sin() + 0.2 * (2.0 * phase).sin() + 0.1 * (3.0 * phase).sin()));
            }
            v.extend(std::iter::repeat(0.0).take((0.15 * SR as f32) as usize));
        }
        [v.clone(), v]
    }
    fn median_hz(track: &[f32], from: f32, to: f32) -> f32 {
        let mut v: Vec<f32> = track[(from * 100.0) as usize..(to * 100.0) as usize].iter().copied().filter(|f| *f > 0.0).collect();
        v.sort_by(|a, b| a.total_cmp(b));
        v[v.len() / 2]
    }

    #[test]
    fn off_key_notes_are_pulled_onto_the_melody() {
        // The melody: A3, C#4, E4. The singer: 40 cents sharp, 60 cents flat, 35 cents sharp.
        let cents = |f: f32, c: f32| f * 2f32.powf(c / 1200.0);
        let reference = sing(&[(220.0, 0.8), (277.18, 0.8), (329.63, 0.8)]);
        let take = sing(&[(cents(220.0, 40.0), 0.8), (cents(277.18, -60.0), 0.8), (cents(329.63, 35.0), 0.8)]);
        let mel = melody(&reference);
        let sung = melody(&take);
        let (out, curves) = tune(&take, &sung, &mel, &TuneSettings { strength: 1.0, retune_ms: 20.0, ..TuneSettings::default() });
        let after = melody(&out);
        let mut t = 0.0;
        for target in [220.0f32, 277.18, 329.63] {
            let (b, a) = (median_hz(&sung, t + 0.25, t + 0.65), median_hz(&after, t + 0.25, t + 0.65));
            let (cb, ca) = (1200.0 * (b / target).log2(), 1200.0 * (a / target).log2());
            assert!(ca.abs() < 12.0, "{target} Hz: {cb:.0} cents off before, still {ca:.0} after");
            t += 0.95;
        }
        assert!(curves.in_tune_after > 0.9 && curves.in_tune_before < 0.2, "in tune before {:.2}, after {:.2}", curves.in_tune_before, curves.in_tune_after);
        assert_eq!(out[0].len(), take[0].len());
    }

    #[test]
    fn strength_zero_leaves_the_pitch_alone() {
        let take = sing(&[(233.0, 0.8)]); // between A3 and B♭3
        let mel = melody(&sing(&[(220.0, 0.8)]));
        let sung = melody(&take);
        let (out, _) = tune(&take, &sung, &mel, &TuneSettings { strength: 0.0, ..TuneSettings::default() });
        let c = 1200.0 * (median_hz(&melody(&out), 0.25, 0.65) / 233.0).log2();
        assert!(c.abs() < 8.0, "moved {c:.1} cents at strength 0");
    }

    #[test]
    fn key_mode_snaps_to_the_scale() {
        assert_eq!(snap_to_key(57.78, 0, false), 57.0); // between A and B♭ in C major → A
        assert_eq!(snap_to_key(60.7, 0, false), 60.0); // a sharp C, with no C♯ in C major → C
        assert_eq!(snap_to_key(61.2, 0, false), 62.0); // nearer D than C
        assert_eq!(snap_to_key(61.2, 9, false), 61.0); // C♯ is in A major
    }

    #[test]
    fn tuning_does_not_shift_the_take_in_time() {
        let take = sing(&[(220.0, 0.5), (330.0, 0.5)]);
        let sung = melody(&take);
        let (out, _) = tune(&take, &sung, &sung, &TuneSettings::default());
        let onset = |x: &[f32]| x.iter().position(|v| v.abs() > 0.05).unwrap() as f32 / SR as f32;
        let second = |x: &[f32]| { let s = (0.6 * SR as f32) as usize; s + x[s..].iter().position(|v| v.abs() > 0.05).unwrap() } as f32 / SR as f32;
        assert!((onset(&out[0]) - onset(&take[0])).abs() < 0.01, "first note moved");
        assert!((second(&out[0]) - second(&take[0])).abs() < 0.01, "second note moved");
    }
}
