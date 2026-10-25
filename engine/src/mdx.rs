//! UVR MDX-Net spectrogram-mask models (Voc_FT, Kim_Vocal_2, Inst_HQ_3, KARA_2, Reverb_HQ, …).

use crate::{envelope, stft::Stft, Spectrum, Stereo, Tick};
use anyhow::{anyhow, Result};
use ort::{session::Session, value::Tensor};

pub const HOP: usize = 1024;

/// A finished stretch, in input-sample coordinates.
pub struct ChunkView {
    pub from: usize,
    pub to: usize,
    pub bin0: usize,
    pub window: Option<(usize, usize)>,
    pub primary: Vec<f32>,
    pub residual: Vec<f32>,
    pub spectrum: Option<Spectrum>,
}
pub type MdxSink<'a> = Option<&'a (dyn Fn(ChunkView) + Sync)>;

pub struct Mdx {
    session: Session,
    stft: Stft,
    dim_f: usize,
    dim_t: usize,
    chunk: usize,
    trim: usize,
    input_name: &'static str,
    output_name: &'static str,
    pub batch: usize,
    /// On a GPU: grow or shrink the batch so each dispatch stays well under Windows' ~2 s GPU
    /// watchdog (TDR), measured from real dispatch times. `None` on CPU.
    pub max_batch: Option<usize>,
}

/// Target time for one GPU dispatch: a fraction of the 2 s Windows watchdog.
const DISPATCH_TARGET_MS: f64 = 450.0;

#[derive(Clone, Copy, Debug)]
pub struct MdxOptions {
    /// Fraction of each chunk shared with its neighbour (0..0.95).
    pub overlap: f32,
    /// Also run the polarity-inverted spectrogram and average (UVR "denoise").
    pub denoise: bool,
    /// Also run with left/right swapped and average (test-time augmentation).
    pub swap: bool,
}

impl Mdx {
    pub fn new(session: Session, n_fft: usize, dim_f: usize, dim_t: usize, batch: usize) -> Self {
        Self::with_io(session, n_fft, HOP, dim_f, dim_t, batch, "input", "output")
    }

    /// Any spectrogram-in, spectrogram-out model (MDX-Net, RoFormer) with its own hop and tensor names.
    #[allow(clippy::too_many_arguments)]
    pub fn with_io(session: Session, n_fft: usize, hop: usize, dim_f: usize, dim_t: usize, batch: usize, input_name: &'static str, output_name: &'static str) -> Self {
        let chunk = hop * (dim_t - 1);
        Mdx { session, stft: Stft::new(n_fft, hop, dim_f), dim_f, dim_t, chunk, trim: n_fft / 2, input_name, output_name, batch: batch.max(1), max_batch: None }
    }

    /// Separate the model's primary stem from `mix` (any length, 44.1 kHz stereo).
    pub fn demix(&mut self, mix: &Stereo, opt: MdxOptions, tick: Tick, sink: MdxSink) -> Result<Stereo> {
        if !opt.swap {
            return self.demix_once(mix, opt, tick, sink);
        }
        let a = self.demix_once(mix, opt, &mut |f| tick(f * 0.5), sink)?;
        let swapped: Stereo = [mix[1].clone(), mix[0].clone()];
        let b = self.demix_once(&swapped, opt, &mut |f| tick(0.5 + f * 0.5), sink)?;
        Ok([0, 1].map(|c| a[c].iter().zip(&b[1 - c]).map(|(x, y)| 0.5 * (x + y)).collect()))
    }

    fn demix_once(&mut self, mix: &Stereo, opt: MdxOptions, tick: Tick, sink: MdxSink) -> Result<Stereo> {
        let n = mix[0].len();
        let (chunk, trim, dim_f, dim_t, batch) = (self.chunk, self.trim, self.dim_f, self.dim_t, self.batch);
        let gen_size = chunk - 2 * trim;
        let pad = gen_size + trim - n % gen_size;
        let total = trim + n + pad;
        let padded: Stereo = [0, 1].map(|c| {
            let mut v = vec![0.0f32; total];
            v[trim..trim + n].copy_from_slice(&mix[c]);
            v
        });
        let overlap = opt.overlap.clamp(0.0, 0.95);
        let step = (((1.0 - overlap) * chunk as f32) as usize).max(1);
        let mut starts: Vec<usize> = (0..=total - chunk).step_by(step).collect();
        if *starts.last().unwrap() != total - chunk {
            starts.push(total - chunk);
        }
        let window: Vec<f32> = if overlap == 0.0 {
            vec![1.0; chunk]
        } else {
            let d = (chunk + (1 - chunk % 2) - 1) as f32;
            (0..chunk).map(|i| 0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / d).cos()).collect()
        };
        let spec_len = 4 * dim_f * dim_t;
        let groups: Vec<Vec<usize>> = starts.chunks(batch).map(|g| g.to_vec()).collect();
        let starts_ref = &starts;
        let chunks_total = starts.len();
        let max_batch = self.max_batch;
        let mut next_batch = self.batch;
        let batch_out = &mut next_batch;
        let stft = &self.stft;
        let names = (self.input_name, self.output_name);
        let session = &mut self.session;
        let mut timings: Vec<f64> = Vec::new(); // milliseconds per chunk, per dispatch
        tick(0.0)?;

        let result = 
        // Three-stage pipeline: spectrograms for the next batch and waveforms for the previous one are
        // computed on other cores while the model runs, so the CPU/GPU running the model never waits.
        std::thread::scope(|scope| -> Result<Stereo> {
            let (in_tx, in_rx) = std::sync::mpsc::sync_channel::<(Vec<usize>, Vec<f32>)>(2);
            let (out_tx, out_rx) = std::sync::mpsc::sync_channel::<(Vec<usize>, Vec<f32>, Option<Spectrum>)>(2);
            let padded = &padded;
            let window = &window;
            scope.spawn(move || {
                for g in groups {
                    let mut input = vec![0.0f32; g.len() * spec_len];
                    for (i, &s) in g.iter().enumerate() {
                        stft.forward([&padded[0][s..s + chunk], &padded[1][s..s + chunk]], dim_t, &mut input[i * spec_len..(i + 1) * spec_len]);
                    }
                    if in_tx.send((g, input)).is_err() {
                        break;
                    }
                }
            });
            let consumer = scope.spawn(move || {
                let mut acc: Stereo = [vec![0.0; total], vec![0.0; total]];
                let mut div = vec![0.0f32; total];
                let (mut k, mut finalised) = (0usize, 0usize);
                for (g, out, mut spec) in out_rx {
                    for (i, &s) in g.iter().enumerate() {
                        let wave = stft.inverse(&out[i * spec_len..(i + 1) * spec_len], dim_t, chunk);
                        for c in 0..2 {
                            for j in 0..chunk {
                                acc[c][s + j] += wave[c][j] * window[j];
                            }
                        }
                        for j in 0..chunk {
                            div[s + j] += window[j];
                        }
                        // Everything before the next window's start can receive no more contributions:
                        // report that stretch as finished.
                        if let Some(sink) = sink {
                            let next = starts_ref.get(k + 1).copied();
                            let upto = next.unwrap_or(total);
                            let (from, to) = (finalised.saturating_sub(trim).min(n), upto.saturating_sub(trim).min(n));
                            if to > from {
                                let at = |c: usize, i: usize| acc[c][i + trim] / (div[i + trim] + 1e-8);
                                let (bin0, primary) = envelope(from, to, n, |i| at(0, i).abs().max(at(1, i).abs()));
                                let (_, residual) = envelope(from, to, n, |i| (padded[0][i + trim] - at(0, i)).abs().max((padded[1][i + trim] - at(1, i)).abs()));
                                let window = next.map(|w| (w.saturating_sub(trim).min(n), (w + chunk).saturating_sub(trim).min(n)));
                                sink(ChunkView { from, to, bin0, window, primary, residual, spectrum: spec.take() });
                            }
                            finalised = upto;
                        }
                        k += 1;
                    }
                }
                (acc, div)
            });
            let mut done = 0usize;
            let mut failure: Option<anyhow::Error> = None;
            for (g, mut input) in in_rx.iter() {
                let b = g.len();
                let started = std::time::Instant::now();
                let step_result = (|| -> Result<(Vec<f32>, Option<Spectrum>)> {
                    let mut out = infer(session, names, &input, b, dim_f, dim_t)?;
                    let spec: Option<Spectrum> = None;
                    if opt.denoise {
                        // UVR "denoise": average with the negated prediction of the negated input.
                        input.iter_mut().for_each(|x| *x = -*x);
                        let neg = infer(session, names, &input, b, dim_f, dim_t)?;
                        for (x, y) in out.iter_mut().zip(&neg) {
                            *x = 0.5 * *x - 0.5 * y;
                        }
                    }
                    Ok((out, spec))
                })();
                match step_result {
                    Ok((out, spec)) => {
                        let passes = if opt.denoise { 2.0 } else { 1.0 };
                        timings.push(started.elapsed().as_secs_f64() * 1000.0 / (b as f64 * passes));
                        done += b;
                        let _ = out_tx.send((g, out, spec));
                        if let Err(e) = tick(done as f32 / chunks_total as f32) {
                            failure = Some(e);
                            break;
                        }
                    }
                    Err(e) => {
                        failure = Some(e);
                        break;
                    }
                }
            }
            drop(in_rx);
            drop(out_tx);
            let (acc, div) = consumer.join().map_err(|_| anyhow!("separation worker stopped unexpectedly"))?;
            if let Some(e) = failure {
                return Err(e);
            }
            // Adapt the batch for the next run from steady-state timings (the first dispatch
            // includes one-off shader/kernel compilation, so it is ignored).
            if let Some(max) = max_batch {
                let steady: Vec<f64> = timings.iter().skip(1).copied().collect();
                if !steady.is_empty() {
                    let mut sorted = steady.clone();
                    sorted.sort_by(|a, b| a.total_cmp(b));
                    let per_chunk = sorted[sorted.len() / 2].max(1.0);
                    *batch_out = ((DISPATCH_TARGET_MS / per_chunk).floor() as usize).clamp(1, max);
                }
            }
            Ok([0, 1].map(|c| (0..n).map(|i| acc[c][trim + i] / (div[trim + i] + 1e-8)).collect()))
        });
        self.batch = next_batch;
        result
    }
}

fn infer(session: &mut Session, names: (&str, &str), specs: &[f32], count: usize, dim_f: usize, dim_t: usize) -> Result<Vec<f32>> {
    let tensor = Tensor::from_array(([count, 4, dim_f, dim_t], specs.to_vec())).map_err(|e| anyhow!("tensor: {e}"))?;
    let out = session.run(ort::inputs![names.0 => tensor]).map_err(|e| anyhow!("inference failed: {e}"))?;
    let (_, data) = out[names.1].try_extract_tensor::<f32>().map_err(|e| anyhow!("{e}"))?;
    Ok(data.to_vec())
}
