//! Mashup Lab: the vocals of one song over the music of another, in time and in key.
//!
//! The vocal is time-warped onto the music's beat grid — anchor by anchor, so it follows the music's
//! real timing rather than a single average tempo — shifted (with formant preservation) by the
//! smallest interval that lands it in a compatible key, entered on a bar line, and levelled to the
//! loudness of the music's own singer.

use crate::analysis::{SongAnalysis, KEY_NAMES};
use crate::{stretch, Stereo, SR};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct MashupSettings {
    /// Semitones to shift the vocal; `None` chooses the closest compatible key.
    pub semitones: Option<i32>,
    /// "auto", "half" or "double": the vocal's tempo feel relative to the automatic match.
    pub tempo: String,
    /// Move the vocal entry by whole bars and beats on the music's grid.
    pub bar_offset: i32,
    pub beat_offset: i32,
    /// Fine timing, milliseconds.
    pub nudge_ms: f64,
    /// Vocal level relative to the automatic match, dB.
    pub vocal_gain_db: f64,
    /// Follow the music's beat grid beat by beat (true) or use one constant tempo (false).
    pub lock_beats: bool,
}

impl Default for MashupSettings {
    fn default() -> Self {
        MashupSettings { semitones: None, tempo: "auto".into(), bar_offset: 0, beat_offset: 0, nudge_ms: 0.0, vocal_gain_db: 0.0, lock_beats: true }
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct MashupPlan {
    pub vocal_bpm: f64,
    pub music_bpm: f64,
    /// How the vocal's beats map onto the music's: 0.5, 1 or 2.
    pub tempo_factor: f64,
    /// Speed change applied to the vocal, percent (+ is faster).
    pub stretch_percent: f64,
    pub semitones: i32,
    pub auto_semitones: i32,
    pub vocal_key: String,
    pub shifted_key: String,
    pub music_key: String,
    /// "same key", "relative key" or "neighbouring key".
    pub fit: String,
    /// Where the vocal enters in the music, seconds.
    pub entry: f64,
    pub gain_db: f64,
    /// How many beats were locked to the music's grid.
    pub locked_beats: usize,
}

fn wrap_semitones(s: i32) -> i32 {
    let s = s.rem_euclid(12);
    if s > 5 { s - 12 } else { s }
}

fn key_name(tonic: i32, minor: bool) -> String {
    format!("{} {}", KEY_NAMES[tonic.rem_euclid(12) as usize], if minor { "minor" } else { "major" })
}

/// The smallest shift that puts the vocal in a key compatible with the music: the same key, its
/// relative major/minor, or a neighbour a fifth away — preferring the closest and the most consonant.
pub fn auto_shift(vocal: &SongAnalysis, music: &SongAnalysis) -> (i32, &'static str) {
    let (vk, mk) = (vocal.key as i32, music.key as i32);
    // the music's key expressed as a tonic in the vocal's mode
    let (same_tonic, same_label) = match (vocal.minor, music.minor) {
        (false, false) | (true, true) => (mk, "same key"),
        (false, true) => (mk + 3, "relative key"), // music minor → its relative major
        (true, false) => (mk + 9, "relative key"), // music major → its relative minor
    };
    let base_cost = if same_label == "same key" { 0.0 } else { 0.25 };
    let candidates = [(same_tonic, same_label, base_cost), (same_tonic + 7, "neighbouring key", 1.5), (same_tonic + 5, "neighbouring key", 1.5)];
    candidates
        .iter()
        .map(|(t, label, cost)| {
            let s = wrap_semitones(t - vk);
            (s, *label, s.abs() as f64 + cost)
        })
        .min_by(|a, b| a.2.total_cmp(&b.2))
        .map(|(s, l, _)| (s, l))
        .unwrap_or((0, "same key"))
}

fn nearest(v: &[f64], t: f64) -> Option<usize> {
    (0..v.len()).min_by(|a, b| (v[*a] - t).abs().total_cmp(&(v[*b] - t).abs()))
}

pub fn rms_active(a: &Stereo) -> f32 {
    let win = SR as usize / 20;
    let r: Vec<f32> = a[0].chunks(win).zip(a[1].chunks(win)).map(|(l, rr)| (l.iter().chain(rr).map(|v| v * v).sum::<f32>() / (2 * l.len()) as f32).sqrt()).collect();
    let peak = r.iter().cloned().fold(0f32, f32::max);
    let act: Vec<f32> = r.into_iter().filter(|v| *v > peak * 0.1).collect();
    (act.iter().map(|v| v * v).sum::<f32>() / act.len().max(1) as f32).sqrt()
}

/// Render the vocal into the music's timeline (`music_len` samples at 44.1 kHz).
pub fn render(vocals: &Stereo, va: &SongAnalysis, ma: &SongAnalysis, music_len: usize, s: &MashupSettings) -> (Stereo, MashupPlan) {
    let (v, _, plan) = render_with_music(vocals, None, 0.0, va, ma, music_len, s);
    (v, plan)
}

/// Render the vocal of song A — and optionally A's instrumental, through exactly the same time map and
/// key shift — into song B's timeline. The instrumental is levelled to `music_rms` (B's music), with
/// formants left alone (instruments).
pub fn render_with_music(
    vocals: &Stereo,
    music_a: Option<&Stereo>,
    music_rms: f32,
    va: &SongAnalysis,
    ma: &SongAnalysis,
    music_len: usize,
    s: &MashupSettings,
) -> (Stereo, Option<Stereo>, MashupPlan) {
    let sr = SR as f64;
    let n_in = vocals[0].len();
    // Tempo relationship: the factor that brings the vocal's tempo closest to the music's.
    let auto_m = [0.5, 1.0, 2.0].into_iter().min_by(|a, b| ((va.bpm * a / ma.bpm).log2().abs()).total_cmp(&(va.bpm * b / ma.bpm).log2().abs())).unwrap_or(1.0);
    let m = match s.tempo.as_str() {
        "half" => auto_m / 2.0,
        "double" => auto_m * 2.0,
        _ => auto_m,
    };
    let rate = ma.bpm / (va.bpm * m); // vocal playback speed

    // The vocal's beat grid at the chosen feel.
    let vbeats: Vec<f64> = if (m - 2.0).abs() < 1e-9 {
        let mut v = Vec::with_capacity(va.beats.len() * 2);
        for w in va.beats.windows(2) {
            v.push(w[0]);
            v.push(0.5 * (w[0] + w[1]));
        }
        v.extend(va.beats.last());
        v
    } else if (m - 0.5).abs() < 1e-9 {
        let parity = va.downbeats.first().and_then(|d| nearest(&va.beats, *d)).unwrap_or(0) % 2;
        va.beats.iter().enumerate().filter(|(i, _)| i % 2 == parity).map(|(_, b)| *b).collect()
    } else {
        va.beats.clone()
    };

    // Entry: the vocal's bar line just before it starts singing → the music's bar line nearest to
    // where its own singer comes in (or ~8 s in, for instrumentals), then the user's offsets.
    let v_bar = va.downbeats.iter().rev().find(|d| **d <= va.vocal_start + 0.05).copied().or_else(|| va.downbeats.first().copied()).unwrap_or(va.vocal_start);
    // Whether the music had a singer is judged by vocal level, not entry time (some songs open with it).
    let target = if ma.vocal_rms > 1e-4 { ma.vocal_start } else { 8.0 };
    let m_bar = ma.downbeats.iter().min_by(|a, b| (*a - target).abs().total_cmp(&(*b - target).abs())).copied().unwrap_or(target);
    let mut j = nearest(&ma.beats, m_bar).unwrap_or(0) as i64 + (s.bar_offset * 4 + s.beat_offset) as i64;
    j = j.clamp(0, ma.beats.len().saturating_sub(1) as i64);
    let entry = ma.beats.get(j as usize).copied().unwrap_or(m_bar) + s.nudge_ms / 1000.0;

    // Anchors (vocal seconds → music seconds).
    let mut anchors: Vec<(f64, f64)> = Vec::new();
    let mut locked = 0usize;
    if s.lock_beats && vbeats.len() > 4 && ma.beats.len() > 4 {
        let i0 = nearest(&vbeats, v_bar).unwrap_or(0) as i64;
        let j0 = j;
        let k_min = -(i0.min(j0));
        let mut k = k_min;
        while (i0 + k) < vbeats.len() as i64 && (j0 + k) < ma.beats.len() as i64 {
            let (a, b) = (vbeats[(i0 + k) as usize], ma.beats[(j0 + k) as usize] + s.nudge_ms / 1000.0);
            // keep only pairs whose local rate stays within ±15% of the global match (guards against
            // a mistracked beat yanking the vocal around)
            let ok = match anchors.last() {
                Some(&(pa, pb)) => {
                    let local = (a - pa) / (b - pb).max(1e-6);
                    b > pb && a > pa && (local / rate - 1.0).abs() < 0.15
                }
                None => true,
            };
            if ok {
                anchors.push((a, b));
                locked += 1;
            }
            k += 1;
        }
    }
    if anchors.len() < 2 {
        anchors = vec![(v_bar, entry)];
        locked = 0;
    }
    // Extend to the whole vocal at the global rate.
    let (fa, fb) = anchors[0];
    if fa > 0.0 {
        anchors.insert(0, (0.0, fb - fa / rate));
    }
    let (la, lb) = *anchors.last().unwrap();
    let end_in = n_in as f64 / sr;
    if end_in > la + 1e-3 {
        anchors.push((end_in, lb + (end_in - la) / rate));
    }

    // To frames, with the output shifted to start at zero for the stretcher.
    let o_min = anchors[0].1;
    let mut frames: Vec<(usize, usize)> = Vec::with_capacity(anchors.len());
    for (a, b) in &anchors {
        let fi = ((a * sr).round().max(0.0) as usize).min(n_in);
        let fo = ((b - o_min) * sr).round().max(0.0) as usize;
        if frames.last().map_or(true, |&(pi, po)| fi > pi && fo > po) {
            frames.push((fi, fo));
        }
    }

    let (auto_semis, fit) = auto_shift(va, ma);
    let semis = s.semitones.unwrap_or(auto_semis).clamp(-12, 12);
    let warped = stretch::warp(vocals, &frames, semis as f32);

    // Level: match the music's own singer, then the user's adjustment.
    let auto_gain = if ma.vocal_rms > 1e-5 { (ma.vocal_rms / rms_active(&warped).max(1e-6)).clamp(0.25, 4.0) } else { 1.0 };
    let gain = auto_gain * 10f32.powf(s.vocal_gain_db as f32 / 20.0);

    // Place into the music's timeline with short fades at the edges.
    let offset = (o_min * sr).round() as i64;
    let place = |w: &Stereo, g: f32| -> Stereo {
        let mut out: Stereo = [vec![0.0; music_len], vec![0.0; music_len]];
        let len = w[0].len();
        let fade = (0.02 * sr) as usize;
        for i in 0..len {
            let d = offset + i as i64;
            if d < 0 || d as usize >= music_len {
                continue;
            }
            let edge = (i.min(len - 1 - i) as f32 / fade as f32).min(1.0);
            for c in 0..2 {
                out[c][d as usize] = w[c][i] * g * edge;
            }
        }
        out
    };
    let out = place(&warped, gain);
    let music_out = music_a.map(|a| {
        let w = stretch::warp_with(a, &frames, semis as f32, false);
        let g = if music_rms > 1e-5 { (music_rms / rms_active(&w).max(1e-6)).clamp(0.25, 4.0) } else { 1.0 };
        place(&w, g)
    });
    let shifted_tonic = va.key as i32 + semis;
    let plan = MashupPlan {
        vocal_bpm: va.bpm,
        music_bpm: ma.bpm,
        tempo_factor: m,
        stretch_percent: (rate - 1.0) * 100.0,
        semitones: semis,
        auto_semitones: auto_semis,
        vocal_key: key_name(va.key as i32, va.minor),
        shifted_key: key_name(shifted_tonic, va.minor),
        music_key: key_name(ma.key as i32, ma.minor),
        fit: fit.into(),
        entry,
        gain_db: 20.0 * (gain as f64).log10(),
        locked_beats: locked,
    };
    (out, music_out, plan)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn song(bpm: f64, key: u8, minor: bool, secs: f64, vocal_start: f64) -> SongAnalysis {
        let period = 60.0 / bpm;
        let beats: Vec<f64> = (0..).map(|k| 0.3 + k as f64 * period).take_while(|t| *t < secs - period).collect();
        let downbeats = beats.iter().step_by(4).copied().collect();
        SongAnalysis { bpm, beats, downbeats, key, minor, key_confidence: 0.3, vocal_start, vocal_rms: 0.1 }
    }

    #[test]
    fn keys_are_matched_by_the_smallest_compatible_shift() {
        let a = |k, m| song(100.0, k, m, 30.0, 4.0);
        assert_eq!(auto_shift(&a(9, false), &a(0, false)), (3, "same key")); // A major → C major: up 3
        assert_eq!(auto_shift(&a(9, true), &a(0, false)), (0, "relative key")); // A minor fits C major as is
        assert_eq!(auto_shift(&a(2, false), &a(7, false)).1, "neighbouring key"); // D major over G major: a fifth, no shift
        assert_eq!(auto_shift(&a(2, false), &a(7, false)).0, 0);
    }

    #[test]
    fn a_vocal_on_one_grid_lands_on_the_other() {
        // "vocal": a click on every beat of a 92 BPM song, singing from bar 2
        let va = song(92.0, 9, false, 24.0, 0.3 + 4.0 * 60.0 / 92.0);
        let ma = song(124.0, 0, false, 24.0, 0.3 + 8.0 * 60.0 / 124.0);
        let n = 24 * 44100;
        let mut v = vec![0f32; n];
        for b in va.beats.iter().filter(|b| **b >= va.vocal_start - 0.01) {
            let s = (b * 44100.0) as usize;
            for j in 0..300.min(n - s) {
                v[s + j] = (1.0 - j as f32 / 300.0) * (2.0 * std::f32::consts::PI * 1000.0 * j as f32 / 44100.0).sin();
            }
        }
        // A's "instrumental": a click on every one of A's beats (not just while singing)
        let mut inst = vec![0f32; n];
        for b in va.beats.iter() {
            let s = (b * 44100.0) as usize;
            for j in 0..300.min(n - s) {
                inst[s + j] = (1.0 - j as f32 / 300.0) * (2.0 * std::f32::consts::PI * 700.0 * j as f32 / 44100.0).sin();
            }
        }
        let (out, music, plan) = render_with_music(&[v.clone(), v], Some(&[inst.clone(), inst]), 0.1, &va, &ma, n, &MashupSettings::default());
        let music = music.expect("instrumental rendered");
        let mpeak = music[0].iter().cloned().fold(0f32, |m, x| m.max(x.abs()));
        let mut mclicks = vec![];
        let mut i = 0;
        while i < n {
            if music[0][i].abs() > mpeak * 0.3 { mclicks.push(i as f64 / 44100.0); i += 4000; } else { i += 1; }
        }
        assert!(mclicks.len() > 10, "{} instrumental clicks", mclicks.len());
        for c in mclicks.iter().skip(1).take(12) {
            let off = ma.beats.iter().map(|b| (b - c).abs()).fold(f64::MAX, f64::min);
            assert!(off < 0.015, "instrumental click at {c:.3}s is {:.0} ms off the music's beats", off * 1000.0);
        }
        assert_eq!(plan.tempo_factor, 1.0);
        assert!(plan.locked_beats > 10);
        // every click should now fall on a 124 BPM beat, starting at the music's vocal entry
        let mut clicks = vec![];
        let mut i = 0;
        let peak = out[0].iter().cloned().fold(0f32, |m, x| m.max(x.abs()));
        while i < n {
            if out[0][i].abs() > peak * 0.3 { clicks.push(i as f64 / 44100.0); i += 4000; } else { i += 1; }
        }
        assert!(clicks.len() > 10, "{} clicks", clicks.len());
        assert!((clicks[0] - plan.entry).abs() < 0.015, "first click {:.3}s vs entry {:.3}s", clicks[0], plan.entry);
        for c in clicks.iter().take(12) {
            let off = ma.beats.iter().map(|b| (b - c).abs()).fold(f64::MAX, f64::min);
            assert!(off < 0.015, "click at {c:.3}s is {:.0} ms off the music's beats", off * 1000.0);
        }
    }
}
