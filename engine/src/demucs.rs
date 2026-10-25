//! HT-Demucs waveform models (ONNX exports with input `mix [1,2,N]`, output `stems [1,S,2,N]`).

use crate::{envelope, Stereo, Tick};
use anyhow::{anyhow, Result};
use ort::{session::Session, value::Tensor};

pub const SEGMENT: usize = 343_980; // 7.8 s at 44.1 kHz

/// A finished stretch, in input-sample coordinates: one peak envelope per model source.
pub struct DemucsView {
    pub from: usize,
    pub to: usize,
    pub bin0: usize,
    pub window: Option<(usize, usize)>,
    pub sources: Vec<Vec<f32>>,
}
pub type DemucsSink<'a> = Option<&'a (dyn Fn(DemucsView) + Sync)>;

pub struct Demucs {
    session: Session,
    pub sources: Vec<String>,
}

#[derive(Clone, Copy, Debug)]
pub struct DemucsOptions {
    /// Fraction of each segment shared with its neighbour (0.1..0.9).
    pub overlap: f32,
    /// Also run with left/right swapped and average.
    pub swap: bool,
}

impl Demucs {
    pub fn new(session: Session, sources: &[&str]) -> Self {
        Demucs { session, sources: sources.iter().map(|s| s.to_string()).collect() }
    }

    pub fn separate(&mut self, mix: &Stereo, opt: DemucsOptions, tick: Tick, sink: DemucsSink) -> Result<Vec<Stereo>> {
        if !opt.swap {
            return self.separate_once(mix, opt, tick, sink);
        }
        let a = self.separate_once(mix, opt, &mut |f| tick(f * 0.5), sink)?;
        let sw: Stereo = [mix[1].clone(), mix[0].clone()];
        let b = self.separate_once(&sw, opt, &mut |f| tick(0.5 + f * 0.5), sink)?;
        Ok(a.iter()
            .zip(&b)
            .map(|(x, y)| [0, 1].map(|c| x[c].iter().zip(&y[1 - c]).map(|(p, q)| 0.5 * (p + q)).collect()))
            .collect())
    }

    fn separate_once(&mut self, mix: &Stereo, opt: DemucsOptions, tick: Tick, sink: DemucsSink) -> Result<Vec<Stereo>> {
        let n = mix[0].len();
        let s = self.sources.len();
        let ov = ((SEGMENT as f32 * opt.overlap.clamp(0.1, 0.9)) as usize).max(1);
        let stride = SEGMENT - ov;
        let chunks = n.div_ceil(stride).max(1);
        let mut window = vec![1.0f32; SEGMENT];
        for i in 0..ov {
            let w = i as f32 / (ov - 1).max(1) as f32;
            window[i] = w;
            window[SEGMENT - 1 - i] = w;
        }
        let mut out: Vec<Stereo> = (0..s).map(|_| [vec![0.0; n], vec![0.0; n]]).collect();
        let mut weight = vec![0.0f32; n];
        tick(0.0)?;
        for k in 0..chunks {
            let start = k * stride;
            if start >= n {
                break;
            }
            let end = (start + SEGMENT).min(n);
            let len = end - start;
            let last = end == n;
            // No fade at the very start or end of the song: nothing overlaps there.
            let w_at = |j: usize| -> f32 {
                if (start == 0 && j < ov) || (last && j >= ov) { 1.0 } else { window[j] }
            };
            let mut input = vec![0.0f32; 2 * SEGMENT];
            input[..len].copy_from_slice(&mix[0][start..end]);
            input[SEGMENT..SEGMENT + len].copy_from_slice(&mix[1][start..end]);
            let tensor = Tensor::from_array(([1usize, 2, SEGMENT], input)).map_err(|e| anyhow!("tensor: {e}"))?;
            let res = self.session.run(ort::inputs!["mix" => tensor]).map_err(|e| anyhow!("inference failed: {e}"))?;
            let (_, data) = res["stems"].try_extract_tensor::<f32>().map_err(|e| anyhow!("{e}"))?;
            for src in 0..s {
                for c in 0..2 {
                    let off = (src * 2 + c) * SEGMENT;
                    let o = &mut out[src][c][start..end];
                    for j in 0..len {
                        o[j] += data[off + j] * w_at(j);
                    }
                }
            }
            for j in 0..len {
                weight[start + j] += w_at(j);
            }
            if let Some(sink) = sink {
                // Samples before the next segment's start are final.
                let next = (k + 1 < chunks && (k + 1) * stride < n).then_some((k + 1) * stride);
                let (from, to) = (k * stride, next.unwrap_or(n));
                let from = if k == 0 { 0 } else { from };
                let mut bin0 = 0;
                let sources = (0..s)
                    .map(|src| {
                        let (b, env) = envelope(from, to, n, |i| (out[src][0][i].abs().max(out[src][1][i].abs())) / weight[i].max(1e-8));
                        bin0 = b;
                        env
                    })
                    .collect();
                sink(DemucsView { from, to, bin0, window: next.map(|w| (w, (w + SEGMENT).min(n))), sources });
            }
            tick((k + 1) as f32 / chunks as f32)?;
        }
        for st in out.iter_mut() {
            for c in 0..2 {
                for (x, w) in st[c].iter_mut().zip(&weight) {
                    *x /= w.max(1e-8);
                }
            }
        }
        Ok(out)
    }
}
