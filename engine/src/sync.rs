//! "Sync to beat": pull a lane's strong hits onto the song's beat grid (beats and half-beats) and warp
//! the audio smoothly in between. Built for recordings and added audio, which drift; separated stems
//! are already in time. Guardrails keep it clean: only confident hits move (within a third of a
//! subdivision of their target), anchors stay at least 0.25 s apart, and the local stretch is kept
//! within 0.7 … 1.45, short enough stretches that the audio never sounds warped.

use crate::{stretch, Stereo, SR};

/// Strong onsets (seconds) in the audio: rises in 10 ms log energy, at least 0.12 s apart.
fn onsets(a: &Stereo) -> Vec<(f64, f32)> {
    let hop = SR as usize / 100;
    let n = a[0].len();
    let e: Vec<f32> = (0..n / hop)
        .map(|k| { let s = k * hop; ((s..s + hop).map(|i| { let m = 0.5 * (a[0][i] + a[1][i]); m * m }).sum::<f32>() / hop as f32 + 1e-10).sqrt() })
        .collect();
    let lg: Vec<f32> = e.iter().map(|v| (v + 1e-5).ln()).collect();
    let on: Vec<f32> = (0..lg.len()).map(|i| if i < 2 { 0.0 } else { (lg[i] - lg[i - 2]).max(0.0) }).collect();
    let top = on.iter().cloned().fold(0f32, f32::max);
    let loud = e.iter().cloned().fold(0f32, f32::max);
    let mut out: Vec<(f64, f32)> = Vec::new();
    for i in 3..on.len().saturating_sub(3) {
        let v = on[i];
        if v < top * 0.3 || e[i] < loud * 0.05 || !(i - 3..=i + 3).all(|j| on[j] <= v) { continue; }
        // sample-accurate: the first sample where this hit's attack reaches 25% of its peak
        let (lo, hi) = (i.saturating_sub(3) * hop, ((i + 3) * hop).min(n));
        let amp = |j: usize| (0.5 * (a[0][j] + a[1][j])).abs();
        let peak = (lo..hi).map(amp).fold(0f32, f32::max);
        let first = (lo..hi).find(|&j| amp(j) >= peak * 0.25).unwrap_or(i * hop);
        let t = first as f64 / SR as f64;
        match out.last_mut() {
            Some(last) if t - last.0 < 0.12 => { if v > last.1 { *last = (t, v); } }
            _ => out.push((t, v)),
        }
    }
    out
}

/// Sync `stem` to the song's `beats` (seconds). Returns the synced audio and how many hits moved.
pub fn sync_to_beats(stem: &Stereo, beats: &[f64]) -> (Stereo, usize) {
    let n = stem[0].len();
    if beats.len() < 4 || n == 0 { return (stem.clone(), 0); }
    // the grid: beats and the half-beats between them
    let mut grid: Vec<f64> = Vec::with_capacity(beats.len() * 2);
    for w in beats.windows(2) { grid.push(w[0]); grid.push(0.5 * (w[0] + w[1])); }
    grid.push(*beats.last().unwrap());
    let nearest = |t: f64| -> (f64, f64) {
        let k = grid.partition_point(|g| *g < t);
        let cands = [k.saturating_sub(1), k.min(grid.len() - 1)];
        let g = cands.iter().map(|&i| grid[i]).min_by(|a, b| (a - t).abs().total_cmp(&(b - t).abs())).unwrap();
        let i = grid.partition_point(|x| *x < g).min(grid.len() - 1);
        let sub = if i + 1 < grid.len() { grid[i + 1] - grid[i] } else { grid[i] - grid[i.saturating_sub(1)] };
        (g, sub.max(0.05))
    };
    let dur = n as f64 / SR as f64;
    let mut anchors: Vec<(f64, f64)> = vec![(0.0, 0.0)];
    let mut moved: usize = 0;
    for (t, _) in onsets(stem) {
        let (g, sub) = nearest(t);
        if (t - g).abs() > sub / 3.0 { continue; } // not confidently on any beat: leave it
        let (pt, pg) = *anchors.last().unwrap();
        if t - pt < 0.25 || g <= pg { continue; }
        let r = (g - pg) / (t - pt);
        if !(0.7..=1.45).contains(&r) { continue; }
        if (t - g).abs() > 0.008 { moved += 1; } // within 8 ms is already on time
        anchors.push((t, g));
    }
    // finish at the end of the song, without a sharp stretch
    while anchors.len() > 1 {
        let (pt, pg) = *anchors.last().unwrap();
        let r = (dur - pg) / (dur - pt).max(1e-6);
        if (0.7..=1.45).contains(&r) || dur - pt < 0.25 { break; }
        anchors.pop();
        moved = moved.saturating_sub(1);
    }
    anchors.push((dur, dur));
    if moved == 0 { return (stem.clone(), 0); }
    let frames: Vec<(usize, usize)> = anchors.iter().map(|(t, g)| ((t * SR as f64).round() as usize, (g * SR as f64).round() as usize)).collect();
    let mut out = stretch::warp_with(stem, &frames, 0.0, false);
    for c in 0..2 { out[c].resize(n, 0.0); }
    (out, moved)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn clicks(times: &[f64], secs: f64) -> Stereo {
        let n = (secs * SR as f64) as usize;
        let mut x = vec![0f32; n];
        for t in times {
            let s = (t * SR as f64) as usize;
            for j in 0..2000.min(n.saturating_sub(s)) {
                x[s + j] += (1.0 - j as f32 / 2000.0).powi(2) * 0.6 * (2.0 * std::f32::consts::PI * 900.0 * j as f32 / SR as f32).sin();
            }
        }
        [x.clone(), x]
    }
    fn found(a: &Stereo) -> Vec<f64> { onsets(a).into_iter().map(|o| o.0).collect() }
    #[test]
    fn a_drifting_recording_lands_on_the_beat() {
        let beats: Vec<f64> = (0..40).map(|k| 1.0 + k as f64 * 0.5).collect(); // 120 BPM
        // played on every beat, but late and early by up to ±70 ms
        let jitter = [0.06, -0.05, 0.07, -0.03, 0.045, -0.065, 0.02, -0.04];
        let played: Vec<f64> = beats.iter().take(36).enumerate().map(|(k, b)| b + jitter[k % jitter.len()]).collect();
        let take = clicks(&played, 21.0);
        let err = |ts: &[f64]| ts.iter().map(|t| beats.iter().map(|b| (b - t).abs()).fold(f64::MAX, f64::min)).sum::<f64>() / ts.len() as f64;
        let before = err(&found(&take));
        let (synced, moved) = sync_to_beats(&take, &beats);
        let after = err(&found(&synced));
        assert!(moved >= 25, "only {moved} hits moved");
        assert!(after < 0.012 && after < before / 3.0, "mean distance from the beat: {:.0} ms → {:.0} ms", before * 1000.0, after * 1000.0);
        assert_eq!(synced[0].len(), take[0].len(), "same length as the song");
    }
    #[test]
    fn audio_already_on_the_beat_is_left_alone() {
        let beats: Vec<f64> = (0..30).map(|k| 1.0 + k as f64 * 0.5).collect();
        let take = clicks(&beats[..20], 16.0);
        let (synced, moved) = sync_to_beats(&take, &beats);
        assert_eq!(moved, 0);
        assert_eq!(synced, take, "nothing to fix, nothing changed");
    }
}
