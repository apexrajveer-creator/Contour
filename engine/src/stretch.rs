//! Time-stretching and formant-preserving pitch-shifting (Signalsmith Stretch, MIT, vendored).

use crate::Stereo;
use std::os::raw::{c_float, c_int};

#[repr(C)]
struct Raw {
    _private: [u8; 0],
}

unsafe extern "C" {
    fn signalsmith_stretch_create_preset_default(channel_count: c_int, sample_rate: c_float) -> *mut Raw;
    fn signalsmith_stretch_destroy(handle: *mut Raw);
    fn signalsmith_stretch_input_latency(handle: *mut Raw) -> usize;
    fn signalsmith_stretch_output_latency(handle: *mut Raw) -> usize;
    fn signalsmith_stretch_seek(handle: *mut Raw, input: *mut c_float, input_length: usize, playback_rate: f64);
    fn signalsmith_stretch_set_transpose_factor_semitones(handle: *mut Raw, semitones: c_float, tonality_limit: c_float);
    fn signalsmith_stretch_set_formant_factor(handle: *mut Raw, multiplier: c_float, compensate_pitch: c_int);
    fn signalsmith_stretch_process(handle: *mut Raw, input: *mut c_float, input_length: usize, output: *mut c_float, output_length: usize);
    fn signalsmith_stretch_flush(handle: *mut Raw, output: *mut c_float, output_length: usize);
}

/// A stereo stretcher at 44.1 kHz.
struct Stretcher(*mut Raw);

impl Stretcher {
    fn new(semitones: f32) -> Self {
        Self::with_formants(semitones, true)
    }
    /// `formants`: compensate formants when shifting pitch (right for voices; instruments sound more
    /// natural without it).
    fn with_formants(semitones: f32, formants: bool) -> Self {
        // SAFETY: creates an owned instance; destroyed in Drop.
        let h = unsafe { signalsmith_stretch_create_preset_default(2, crate::SR as f32) };
        assert!(!h.is_null(), "could not create the stretcher");
        unsafe {
            // Pitch only below ~8 kHz is shifted tonally (the library's recommended setting), and
            // formants are compensated so a shifted voice keeps its natural character.
            signalsmith_stretch_set_transpose_factor_semitones(h, semitones, 8000.0 / crate::SR as f32);
            signalsmith_stretch_set_formant_factor(h, 1.0, if formants { 1 } else { 0 });
        }
        Stretcher(h)
    }
}

impl Drop for Stretcher {
    fn drop(&mut self) {
        unsafe { signalsmith_stretch_destroy(self.0) }
    }
}

fn interleave(a: &Stereo, from: usize, to: usize) -> Vec<f32> {
    let mut v = Vec::with_capacity((to - from) * 2);
    for i in from..to {
        v.push(a[0][i]);
        v.push(a[1][i]);
    }
    v
}

/// Re-time and re-pitch `input` along a monotonic map of `(input frame, output frame)` anchors.
///
/// The output starts at output frame `anchors[0].1` and ends at `anchors.last().1`; between anchors the
/// rate is constant, so a beat grid can be locked anchor-by-anchor. Latency is compensated so the
/// anchors land on the requested output frames.
pub fn warp(input: &Stereo, anchors: &[(usize, usize)], semitones: f32) -> Stereo {
    warp_with(input, anchors, semitones, true)
}

/// `warp`, choosing whether formants are compensated (voices: yes; instruments: no).
pub fn warp_with(input: &Stereo, anchors: &[(usize, usize)], semitones: f32, formants: bool) -> Stereo {
    let n = input[0].len();
    if anchors.len() < 2 || n == 0 {
        return [Vec::new(), Vec::new()];
    }
    let out_total = anchors[anchors.len() - 1].1 - anchors[0].1;
    let st = Stretcher::with_formants(semitones, formants);
    let (in_lat, out_lat) = unsafe { (signalsmith_stretch_input_latency(st.0), signalsmith_stretch_output_latency(st.0)) };
    let first = anchors[0].0.min(n);
    let rate0 = (anchors[1].0 - anchors[0].0) as f64 / (anchors[1].1 - anchors[0].1).max(1) as f64;

    // Pre-roll: give the stretcher its input latency's worth of audio without advancing the output.
    let pre_end = (first + in_lat).min(n);
    let mut pre = interleave(input, first, pre_end);
    pre.resize(in_lat * 2, 0.0);
    unsafe { signalsmith_stretch_seek(st.0, pre.as_mut_ptr(), in_lat, rate0) };

    let mut out: Vec<f32> = Vec::with_capacity(out_total * 2 + out_lat * 2);
    let mut cursor = pre_end; // input consumed so far
    let mut produced = 0usize;
    for w in anchors.windows(2) {
        let (a0, b0) = w[0];
        let (a1, b1) = w[1];
        let seg_rate = (a1 - a0) as f64 / (b1 - b0).max(1) as f64;
        // Input needed by the end of this segment: its anchor plus the latency lead, minus what the
        // output latency (flushed at the end) will still hold back.
        // Input needed by the end of this segment: its anchor plus the stretcher's look-ahead. Past the
        // end of the input this is fed as silence, so input and output stay in exact proportion.
        let _ = seg_rate;
        let want_in = (a1 + in_lat).max(cursor);
        // The stretcher's output runs `out_lat` frames behind; we over-produce by that much and drop
        // the leading frames below, so anchors land exactly (verified against the library's `exact`).
        let want_out = (b1 - anchors[0].1).saturating_sub(produced);
        let mut chunk = if want_in > cursor { interleave(input, cursor.min(n), want_in.min(n)) } else { Vec::new() };
        let in_frames = want_in - cursor;
        chunk.resize(in_frames * 2, 0.0); // silence past the end of the input
        let start = out.len();
        out.resize(start + want_out * 2, 0.0);
        unsafe {
            signalsmith_stretch_process(st.0, chunk.as_mut_ptr(), in_frames, out[start..].as_mut_ptr(), want_out);
        }
        cursor = want_in;
        produced += want_out;
        let _ = (a0, b0);
    }
    let start = out.len();
    out.resize(start + out_lat * 2, 0.0);
    unsafe { signalsmith_stretch_flush(st.0, out[start..].as_mut_ptr(), out_lat) };
    let frames = out.len() / 2;
    let mut res: Stereo = [Vec::with_capacity(frames), Vec::with_capacity(frames)];
    for i in out_lat.min(frames)..frames {
        res[0].push(out[2 * i]);
        res[1].push(out[2 * i + 1]);
    }
    res[0].truncate(out_total);
    res[1].truncate(out_total);
    res
}


/// Pitch-correct `input` (same length out) with a transposition that changes over time: `semis[k]`
/// semitones for the `hop` samples starting at `k * hop`. Formants are preserved. Latency is
/// compensated so corrections line up with the audio they were computed from.
pub fn retune(input: &Stereo, semis: &[f32], hop: usize) -> Stereo {
    let n = input[0].len();
    if n == 0 || hop == 0 {
        return input.clone();
    }
    let st = Stretcher::new(0.0);
    let (in_lat, out_lat) = unsafe { (signalsmith_stretch_input_latency(st.0), signalsmith_stretch_output_latency(st.0)) };
    let pre_end = in_lat.min(n);
    let mut pre = interleave(input, 0, pre_end);
    pre.resize(in_lat * 2, 0.0);
    unsafe { signalsmith_stretch_seek(st.0, pre.as_mut_ptr(), in_lat, 1.0) };
    let total = n + out_lat; // over-produce by the output latency, then drop that many leading frames
    let mut out: Vec<f32> = Vec::with_capacity(total * 2);
    let mut cursor = pre_end;
    let mut produced = 0usize;
    while produced < total {
        let frames = hop.min(total - produced);
        // the block being synthesised now belongs to output time (produced − out_lat)
        let k = produced.saturating_sub(out_lat) / hop;
        let s = semis.get(k).copied().unwrap_or(0.0);
        unsafe { signalsmith_stretch_set_transpose_factor_semitones(st.0, s, 8000.0 / crate::SR as f32) };
        let mut chunk = if cursor < n { interleave(input, cursor, (cursor + frames).min(n)) } else { Vec::new() };
        chunk.resize(frames * 2, 0.0);
        let start = out.len();
        out.resize(start + frames * 2, 0.0);
        unsafe { signalsmith_stretch_process(st.0, chunk.as_mut_ptr(), frames, out[start..].as_mut_ptr(), frames) };
        cursor += frames;
        produced += frames;
    }
    let mut res: Stereo = [Vec::with_capacity(n), Vec::with_capacity(n)];
    for i in out_lat..out_lat + n {
        res[0].push(out[2 * i]);
        res[1].push(out[2 * i + 1]);
    }
    res
}

#[cfg(test)]
mod tests {
    use super::*;

    fn clicks(bpm: f64, secs: f64) -> Stereo {
        let n = (secs * 44100.0) as usize;
        let mut v = vec![0f32; n];
        let period = 60.0 / bpm * 44100.0;
        let mut k = 0.0;
        while (k * period) < n as f64 - 400.0 {
            let s = (k * period) as usize;
            for j in 0..300 {
                v[s + j] += (1.0 - j as f32 / 300.0) * (2.0 * std::f32::consts::PI * 1000.0 * j as f32 / 44100.0).sin();
            }
            k += 1.0;
        }
        [v.clone(), v]
    }

    fn onsets(a: &[f32]) -> Vec<f64> {
        let mut out = vec![];
        let mut i = 0;
        while i < a.len() {
            if a[i].abs() > 0.25 {
                out.push(i as f64 / 44100.0);
                i += 4000;
            } else {
                i += 1;
            }
        }
        out
    }

    #[test]
    fn constant_stretch_lands_clicks_on_the_target_grid() {
        let input = clicks(100.0, 12.0); // a click every 0.6 s
        let n = input[0].len();
        let out_len = (n as f64 * 100.0 / 120.0) as usize; // 100 → 120 BPM: a click every 0.5 s
        let out = warp(&input, &[(0, 0), (n, out_len)], 0.0);
        let found = onsets(&out[0]);
        assert!(found.len() >= 15, "found {} clicks", found.len());
        let errs: Vec<f64> = found.iter().enumerate().skip(1).take(15).map(|(k, t)| (t - k as f64 * 0.5) * 1000.0).collect();
        for (k, e) in errs.iter().enumerate() {
            assert!(e.abs() < 12.0, "click {} is {e:.1} ms off", k + 1);
        }
    }

    #[test]
    fn pitch_shift_moves_a_tone_by_two_semitones() {
        let n = 44100 * 3;
        let tone: Vec<f32> = (0..n).map(|i| 0.5 * (2.0 * std::f32::consts::PI * 440.0 * i as f32 / 44100.0).sin()).collect();
        let out = warp(&[tone.clone(), tone], &[(0, 0), (n, n)], 2.0);
        // zero-crossing frequency estimate over the steady middle second
        let mid = &out[0][44100..88200];
        let crossings = mid.windows(2).filter(|w| w[0] <= 0.0 && w[1] > 0.0).count() as f64;
        let expect = 440.0 * 2f64.powf(2.0 / 12.0);
        assert!((crossings - expect).abs() / expect < 0.01, "measured {crossings} Hz, expected {expect:.1}");
    }
}
