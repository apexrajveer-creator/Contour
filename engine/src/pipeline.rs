//! Separation cascades and ensembles.
//!
//! ```text
//! mix ──► vocal ensemble ──► vocals ──► [karaoke] ──► lead / backing ──► [de-reverb] ──► dry / reverb
//!   └──► mix − vocals (± instrumental models) ──► instrumental ──► [HT-Demucs] ──► drums / bass / (guitar / piano) / other
//! ```
//! "Other" stems are formed by subtraction so every split sums back exactly to its parent.

use crate::demucs::{Demucs, DemucsOptions, DemucsView};
use crate::mdx::{ChunkView, Mdx, MdxOptions};
use crate::models::{self, Arch, ModelSpec, Primary};
use crate::runtime::{self, Device};
use crate::{average, scale, sub, Cancelled, Stereo, VizChunk, SR};
use std::sync::Arc;
use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum Quality {
    Fast,
    #[default]
    Balanced,
    Max,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum Instruments {
    #[default]
    None,
    Four,
    Six,
}

/// Fine-grained control. Normally derived from [`Quality`]; can be overridden for research.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Recipe {
    /// Models whose vocal estimates are averaged. MDX vocal or instrumental models, or Demucs models.
    pub vocal_models: Vec<String>,
    /// Instrumental models blended with `mix − vocals` (empty = pure subtraction, stems sum exactly).
    pub inst_models: Vec<String>,
    pub overlap: f32,
    pub denoise: bool,
    pub swap: bool,
    pub demucs_overlap: f32,
    pub demucs_swap: bool,
    /// Use the four fine-tuned HT-Demucs specialists instead of the single 4-stem model.
    pub ft_bag: bool,
}

impl Recipe {
    /// Presets, chosen from MUSDB18 benchmarks (vocals SDR, 5 excerpts):
    /// Voc FT at 25% overlap 11.48 dB; adding the denoise pass and 50% overlap 11.57 dB at ~3.5× the
    /// time; a Voc FT + Kim Vocal 2 ensemble 11.62 dB at ~8×. Passes that cost 2× for under
    /// 0.1 dB are left out of Fast and Balanced. Max is the RoFormer flagship.
    pub fn for_quality(q: Quality) -> Recipe {
        match q {
            Quality::Fast => Recipe {
                vocal_models: vec!["voc_ft".into()],
                inst_models: vec![],
                overlap: 0.25,
                denoise: false,
                swap: false,
                demucs_overlap: 0.1,
                demucs_swap: false,
                ft_bag: false,
            },
            Quality::Balanced => Recipe {
                vocal_models: vec!["voc_ft".into()],
                inst_models: vec![],
                overlap: 0.5,
                denoise: false,
                swap: false,
                demucs_overlap: 0.25,
                demucs_swap: false,
                ft_bag: false,
            },
            // Flagship: Kim's Mel-Band RoFormer. On MUSDB18 excerpts it beat Voc FT by +0.5 to +1.4 dB
            // vocals SDR (and similarly on instrumentals) — a model-generation jump, where the old
            // two-model ensemble gained ~0.05 dB. 50% overlap = the 4 s step its authors use.
            Quality::Max => Recipe {
                vocal_models: vec!["mel_roformer".into()],
                inst_models: vec![],
                overlap: 0.5,
                denoise: false,
                swap: false,
                demucs_overlap: 0.25,
                demucs_swap: false,
                // The 4-stem HT-Demucs installed during setup, so Flagship works offline out of the box.
                ft_bag: false,
            },
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct Request {
    #[serde(default)]
    pub quality: Quality,
    #[serde(default)]
    pub lead_backing: bool,
    #[serde(default)]
    pub instruments: Instruments,
    #[serde(default)]
    pub dereverb: bool,
    #[serde(default)]
    pub recipe: Option<Recipe>,
}

impl Request {
    /// Relative amount of work per second of audio (the unit time estimates are calibrated in).
    pub fn cost_units(&self) -> f64 {
        let r = self.recipe();
        let unit = |id: &String| models::spec(id).map(|m| model_cost(m, &r)).unwrap_or(0.0);
        let mut total: f64 = r.vocal_models.iter().map(unit).sum::<f64>() + r.inst_models.iter().map(unit).sum::<f64>();
        if self.lead_backing { total += mdx_cost(&r); }
        if self.dereverb { total += mdx_cost(&r); }
        total += match self.instruments {
            Instruments::None => 0.0,
            Instruments::Four if r.ft_bag => 2.0 * demucs_cost(&r),
            _ => demucs_cost(&r),
        };
        total
    }

    pub fn recipe(&self) -> Recipe {
        self.recipe.clone().unwrap_or_else(|| Recipe::for_quality(self.quality))
    }

    pub fn required_models(&self) -> Vec<&'static ModelSpec> {
        let r = self.recipe();
        let mut ids: Vec<String> = r.vocal_models.clone();
        ids.extend(r.inst_models.iter().cloned());
        if self.lead_backing {
            ids.push("kara_2".into());
        }
        if self.dereverb {
            ids.push("reverb_hq".into());
        }
        match self.instruments {
            Instruments::None => {}
            Instruments::Four if r.ft_bag => {
                ids.extend(["htdemucs_ft_drums", "htdemucs_ft_bass"].map(String::from));
            }
            Instruments::Four => ids.push("htdemucs".into()),
            Instruments::Six => ids.push("htdemucs_6s".into()),
        }
        let mut out: Vec<&'static ModelSpec> = Vec::new();
        for id in ids {
            if let Ok(m) = models::spec(&id) {
                if !out.iter().any(|x| x.id == m.id) {
                    out.push(m);
                }
            }
        }
        out
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct Progress {
    pub fraction: f32,
    pub stage: String,
    pub detail: String,
}

pub struct Stem {
    pub id: String,
    pub label: String,
    /// "vocal" or "music".
    pub kind: &'static str,
    /// Part of the finest partition of the mix (leaves sum back to the original).
    pub leaf: bool,
    pub audio: Stereo,
}

enum Loaded {
    Mdx(Mdx),
    Demucs(Demucs),
}

pub struct Engine {
    pub models_dir: PathBuf,
    /// The processor the user asked for.
    pub requested: Device,
    /// The processor actually in use (switches to CPU if the GPU fails mid-job).
    pub device: Device,
    pub backend: String,
    /// Why preferred accelerators were skipped, and any mid-job GPU failure. Shown to the user.
    pub notes: Vec<String>,
    /// Receives live visualisation data while separating (None: nothing is computed for it).
    pub viz: Option<Arc<dyn Fn(VizChunk) + Send + Sync>>,
    stage: u32,
    /// What the next model pass cuts, and into which threads: (parent, [(model output, thread)]).
    view: Option<(String, Vec<(String, String)>)>,
    /// Batch sizes each model settled on for this GPU, kept across the per-model reloads.
    gpu_batch: HashMap<&'static str, usize>,
    cache: HashMap<&'static str, Loaded>,
}

struct Tracker<'a> {
    report: &'a (dyn Fn(Progress) + Sync),
    cancel: &'a AtomicBool,
    base: f64,
    total: f64,
}

impl Tracker<'_> {
    fn step<T>(&mut self, stage: &str, weight: f64, f: impl FnOnce(&mut dyn FnMut(f32) -> Result<()>) -> Result<T>) -> Result<T> {
        let (base, total, report, cancel) = (self.base, self.total.max(1e-9), self.report, self.cancel);
        let mut tick = |x: f32| -> Result<()> {
            if cancel.load(Ordering::Relaxed) {
                return Err(Cancelled.into());
            }
            let fraction = ((base + weight * x.clamp(0.0, 1.0) as f64) / total) as f32;
            report(Progress { fraction, stage: stage.to_string(), detail: format!("{:.0}%", x * 100.0) });
            Ok(())
        };
        let out = f(&mut tick)?;
        self.base += weight;
        Ok(out)
    }
}

fn first_line(e: &anyhow::Error) -> String {
    let s = format!("{e:#}");
    let s = s.lines().next().unwrap_or("").to_string();
    if s.chars().count() > 160 { s.chars().take(160).collect::<String>() + "…" } else { s }
}

/// Relative work per second of audio for one model under a recipe.
fn model_cost(m: &ModelSpec, r: &Recipe) -> f64 {
    match m.arch {
        Arch::Demucs { .. } => demucs_cost(r),
        Arch::Roformer { .. } => 4.0 / (1.0 - r.overlap as f64).max(0.05),
        Arch::Mdx { .. } => mdx_cost(r),
        Arch::Whisper => 0.0,
    }
}

fn mdx_cost(r: &Recipe) -> f64 {
    let passes = (if r.denoise { 2.0 } else { 1.0 }) * (if r.swap { 2.0 } else { 1.0 });
    passes / (1.0 - r.overlap as f64).max(0.05)
}
fn demucs_cost(r: &Recipe) -> f64 {
    3.0 * (if r.demucs_swap { 2.0 } else { 1.0 }) / (1.0 - r.demucs_overlap as f64).max(0.05)
}

impl Engine {
    pub fn new(models_dir: PathBuf, device: Device) -> Self {
        Engine { models_dir, requested: device, device, backend: String::new(), notes: Vec::new(), viz: None, stage: 0, view: None, gpu_batch: HashMap::new(), cache: HashMap::new() }
    }

    /// Release all loaded models (frees RAM / VRAM).
    pub fn unload(&mut self) {
        self.cache.clear();
    }

    fn load(&mut self, m: &'static ModelSpec) -> Result<&mut Loaded> {
        if !self.cache.contains_key(m.id) {
            let path = models::path(&self.models_dir, m);
            if !models::is_present(&self.models_dir, m) {
                bail!("model {} is not downloaded", m.label);
            }
            let is_demucs = matches!(m.arch, Arch::Demucs { .. });
            let on_gpu = !self.backend.is_empty() && !self.backend.starts_with("CPU");
            if on_gpu {
                // Video memory is the scarce resource (4 GB on many laptop GPUs): keep only the
                // model in use resident. Reloading a model from the OS file cache takes well under a second.
                self.cache.clear();
            } else if is_demucs {
                // CPU: keep the vocal models warm; hold at most one Demucs model (each needs ~1.3 GB).
                self.cache.retain(|_, v| matches!(v, Loaded::Mdx(_)));
            }
            let (session, backend) = if is_demucs { runtime::load_heavy(&path, self.device)? } else { runtime::load_session(&path, self.device, true)? };
            for n in runtime::accelerator_notes() {
                if !self.notes.contains(&n) {
                    self.notes.push(n);
                }
            }
            self.backend = backend;
            let loaded = match m.arch {
                Arch::Mdx { n_fft, dim_f, dim_t, .. } => {
                    let mut mdx = Mdx::new(session, n_fft, dim_f, dim_t, runtime::batch_for(&self.backend));
                    let max = runtime::max_batch_for(&self.backend);
                    if max > 1 {
                        mdx.max_batch = Some(max);
                        if let Some(&b) = self.gpu_batch.get(m.id) {
                            mdx.batch = b; // what this GPU sustained last time
                        }
                    }
                    Loaded::Mdx(mdx)
                }
                Arch::Demucs { sources } => Loaded::Demucs(Demucs::new(session, sources)),
                // RoFormer exports take a fixed batch of one segment.
                Arch::Roformer { n_fft, hop, dim_f, dim_t, input, output } => Loaded::Mdx(Mdx::with_io(session, n_fft, hop, dim_f, dim_t, 1, input, output)),
                Arch::Whisper => bail!("{} is part of the lyrics model, not a separation model", m.label),
            };
            self.cache.insert(m.id, loaded);
        }
        Ok(self.cache.get_mut(m.id).unwrap())
    }

    /// Run an MDX model on peak-normalised input and return its primary stem at the input's level.
    fn set_view(&mut self, parent: &str, map: &[(&str, &str)]) {
        self.view = Some((parent.to_string(), map.iter().map(|(a, b)| (a.to_string(), b.to_string())).collect()));
    }

    fn secs(samples: usize) -> f64 {
        samples as f64 / SR as f64
    }

    /// Sink for a spectrogram model: primary and residual become the two threads of the view.
    fn mdx_sink(&mut self) -> Option<Box<dyn Fn(ChunkView) + Sync>> {
        let view = self.view.take();
        let viz = self.viz.clone()?;
        let (parent, map) = view?;
        self.stage += 1;
        let stage = self.stage;
        let name = |i: usize, d: &str| map.get(i).map(|x| x.1.clone()).unwrap_or_else(|| d.to_string());
        let (a, b) = (name(0, "primary"), name(1, "residual"));
        Some(Box::new(move |cv: ChunkView| {
            viz(VizChunk {
                stage,
                parent: parent.clone(),
                from: Self::secs(cv.from),
                to: Self::secs(cv.to),
                bin0: cv.bin0,
                window: cv.window.map(|(x, y)| (Self::secs(x), Self::secs(y))),
                layers: vec![(a.clone(), cv.primary), (b.clone(), cv.residual)],
                spectrum: cv.spectrum,
            })
        }))
    }

    /// Sink for a waveform model: sources are mapped (and summed) onto the view's threads.
    fn demucs_sink(&mut self, sources: &[String]) -> Option<Box<dyn Fn(DemucsView) + Sync>> {
        let view = self.view.take();
        let viz = self.viz.clone()?;
        let (parent, map) = view?;
        self.stage += 1;
        let stage = self.stage;
        let mut threads: Vec<String> = Vec::new();
        let target: Vec<usize> = sources
            .iter()
            .map(|s| {
                let t = map.iter().find(|(src, _)| src == s).map(|x| x.1.clone()).unwrap_or_else(|| s.clone());
                match threads.iter().position(|x| *x == t) {
                    Some(i) => i,
                    None => {
                        threads.push(t);
                        threads.len() - 1
                    }
                }
            })
            .collect();
        Some(Box::new(move |dv: DemucsView| {
            let len = dv.sources.first().map(|v| v.len()).unwrap_or(0);
            let mut sums = vec![vec![0f32; len]; threads.len()];
            for (i, env) in dv.sources.iter().enumerate() {
                for (o, v) in sums[target[i]].iter_mut().zip(env) {
                    *o += v;
                }
            }
            viz(VizChunk {
                stage,
                parent: parent.clone(),
                from: Self::secs(dv.from),
                to: Self::secs(dv.to),
                bin0: dv.bin0,
                window: dv.window.map(|(x, y)| (Self::secs(x), Self::secs(y))),
                layers: threads.iter().cloned().zip(sums).collect(),
                spectrum: None,
            })
        }))
    }

    /// GPU errors that a reset can fix: a Windows driver reset (TDR), a lost device, CUDA errors,
    /// or running out of video memory.
    fn gpu_recoverable(&self, e: &anyhow::Error, attempt: u32) -> bool {
        attempt < 2 && self.device != Device::Cpu && !self.backend.starts_with("CPU") && !crate::is_cancelled(e) && runtime::is_device_lost(e)
    }

    /// First failure: drop every GPU session, give the driver a moment to recover, retry on the GPU
    /// with the smallest batch. Second failure: finish this job on the CPU from this step on.
    fn recover_gpu(&mut self, attempt: u32, e: &anyhow::Error) {
        let gpu = self.backend.clone();
        let detail = format!("{e:#}").lines().next().unwrap_or("").chars().take(140).collect::<String>();
        self.cache.clear();
        self.gpu_batch.clear();
        if attempt == 1 {
            self.notes.push(format!("{gpu} reset during separation; Contour recovered and continued on the GPU. ({detail})"));
            std::thread::sleep(std::time::Duration::from_millis(1500));
        } else {
            self.notes.push(format!("{gpu} failed twice, so Contour finished this job on the CPU. ({detail})"));
            self.device = Device::Cpu;
        }
    }

    fn run_mdx(&mut self, m: &'static ModelSpec, input: &Stereo, r: &Recipe, tick: &mut dyn FnMut(f32) -> Result<()>) -> Result<Stereo> {
        let view = self.view.clone();
        let mut attempt = 0;
        loop {
            self.view = view.clone();
            match self.run_mdx_once(m, input, r, tick) {
                Err(e) if self.gpu_recoverable(&e, attempt) => {
                    attempt += 1;
                    self.recover_gpu(attempt, &e);
                }
                other => return other,
            }
        }
    }

    fn run_mdx_once(&mut self, m: &'static ModelSpec, input: &Stereo, r: &Recipe, tick: &mut dyn FnMut(f32) -> Result<()>) -> Result<Stereo> {
        // MDX-Net models expect peak-normalised input; RoFormer is trained on raw levels.
        let p = if matches!(m.arch, Arch::Roformer { .. }) { 1.0 } else { crate::peak(input).max(1e-9) };
        let norm = scale(input, 1.0 / p);
        let opt = MdxOptions { overlap: r.overlap, denoise: r.denoise, swap: r.swap };
        let sink = self.mdx_sink();
        let Loaded::Mdx(mdx) = self.load(m)? else { bail!("{} is not an MDX model", m.id) };
        let out = mdx.demix(&norm, opt, tick, sink.as_deref());
        if mdx.max_batch.is_some() {
            let b = mdx.batch;
            self.gpu_batch.insert(m.id, b);
        }
        let out = out?;
        Ok(scale(&out, p))
    }

    /// Run a Demucs model with the official mean/std normalisation; returns all its sources.
    fn run_demucs(&mut self, m: &'static ModelSpec, input: &Stereo, r: &Recipe, tick: &mut dyn FnMut(f32) -> Result<()>) -> Result<Vec<(String, Stereo)>> {
        let view = self.view.clone();
        let mut attempt = 0;
        loop {
            self.view = view.clone();
            match self.run_demucs_once(m, input, r, tick) {
                Err(e) if self.gpu_recoverable(&e, attempt) => {
                    attempt += 1;
                    self.recover_gpu(attempt, &e);
                }
                other => return other,
            }
        }
    }

    fn run_demucs_once(&mut self, m: &'static ModelSpec, input: &Stereo, r: &Recipe, tick: &mut dyn FnMut(f32) -> Result<()>) -> Result<Vec<(String, Stereo)>> {
        let n = input[0].len().max(1) as f64;
        let mono: Vec<f64> = (0..input[0].len()).map(|i| (input[0][i] as f64 + input[1][i] as f64) * 0.5).collect();
        let mean = mono.iter().sum::<f64>() / n;
        let std = (mono.iter().map(|x| (x - mean).powi(2)).sum::<f64>() / n).sqrt().max(1e-8);
        let norm: Stereo = [0, 1].map(|c| input[c].iter().map(|x| ((*x as f64 - mean) / std) as f32).collect());
        let opt = DemucsOptions { overlap: r.demucs_overlap, swap: r.demucs_swap };
        let sources: Vec<String> = match m.arch { Arch::Demucs { sources } => sources.iter().map(|s| s.to_string()).collect(), _ => vec![] };
        let sink = self.demucs_sink(&sources);
        let Loaded::Demucs(d) = self.load(m)? else { bail!("{} is not a Demucs model", m.id) };
        let names = d.sources.clone();
        let out = d.separate(&norm, opt, tick, sink.as_deref())?;
        Ok(names
            .into_iter()
            .zip(out)
            .map(|(name, s)| (name, [0, 1].map(|c| s[c].iter().map(|x| (*x as f64 * std + mean) as f32).collect())))
            .collect())
    }

    fn take(sources: Vec<(String, Stereo)>, name: &str) -> Result<Stereo> {
        sources.into_iter().find(|(n, _)| n == name).map(|(_, s)| s).ok_or_else(|| anyhow::anyhow!("model has no '{name}' output"))
    }

    /// Estimate vocals with one model of any architecture.
    fn vocal_estimate(&mut self, m: &'static ModelSpec, mix: &Stereo, r: &Recipe, tick: &mut dyn FnMut(f32) -> Result<()>) -> Result<Stereo> {
        match m.arch {
            Arch::Mdx { primary: Primary::Vocals, .. } => {
                self.set_view("mix", &[("primary", "vocals"), ("residual", "instrumental")]);
                self.run_mdx(m, mix, r, tick)
            }
            Arch::Mdx { primary: Primary::Instrumental, compensate, .. } => {
                self.set_view("mix", &[("primary", "instrumental"), ("residual", "vocals")]);
                let inst = self.run_mdx(m, mix, r, tick)?;
                Ok(sub(mix, &scale(&inst, compensate)))
            }
            Arch::Mdx { .. } => bail!("{} cannot estimate vocals", m.label),
            Arch::Roformer { .. } => {
                self.set_view("mix", &[("primary", "vocals"), ("residual", "instrumental")]);
                let light = Recipe { denoise: false, swap: false, ..r.clone() };
                self.run_mdx(m, mix, &light, tick)
            }
            Arch::Whisper => bail!("{} cannot estimate vocals", m.label),
            Arch::Demucs { .. } => {
                self.set_view("mix", &[("vocals", "vocals"), ("drums", "instrumental"), ("bass", "instrumental"), ("other", "instrumental"), ("guitar", "instrumental"), ("piano", "instrumental")]);
                Self::take(self.run_demucs(m, mix, r, tick)?, "vocals")
            }
        }
    }

    /// Download any missing models for `req`.
    pub fn ensure_models(&self, req: &Request, report: &(dyn Fn(Progress) + Sync), cancel: &AtomicBool) -> Result<()> {
        let missing: Vec<_> = req.required_models().into_iter().filter(|m| !models::is_present(&self.models_dir, m)).collect();
        let total: u64 = missing.iter().map(|m| m.size).sum();
        let mut base = 0u64;
        for m in missing {
            models::ensure(&self.models_dir, m, &mut |done, size| {
                if cancel.load(Ordering::Relaxed) {
                    return Err(Cancelled.into());
                }
                report(Progress {
                    fraction: (base + done) as f32 / total.max(1) as f32,
                    stage: format!("Downloading {}", m.label),
                    detail: format!("{:.1} / {:.1} MB", done as f64 / 1e6, size as f64 / 1e6),
                });
                Ok(())
            })?;
            base += m.size;
        }
        Ok(())
    }

    /// Separate `mix` (44.1 kHz stereo). Models must already be present (see [`Engine::ensure_models`]).
    ///
    /// If the GPU fails part-way (a Windows driver reset, a CUDA error, running out of video memory),
    /// the job restarts on the CPU and the engine stays on the CPU for the rest of the session.
    pub fn separate(&mut self, mix: &Stereo, req: &Request, report: &(dyn Fn(Progress) + Sync), cancel: &AtomicBool) -> Result<Vec<Stem>> {
        // Each job gives the requested processor a fresh chance: most GPU resets are transient.
        if self.device != self.requested {
            self.device = self.requested;
            self.cache.clear();
        }
        match self.separate_on_device(mix, req, report, cancel) {
            Err(e) if self.device != Device::Cpu && !crate::is_cancelled(&e) && !self.backend.starts_with("CPU") && runtime::is_device_lost(&e) => {
                let gpu = self.backend.clone();
                self.notes.push(format!("{gpu} stopped responding during separation, so Contour finished on the CPU. ({})", first_line(&e)));
                report(Progress { fraction: 0.0, stage: format!("{gpu} stopped responding — continuing on CPU"), detail: String::new() });
                self.cache.clear();
                self.device = Device::Cpu;
                self.separate_on_device(mix, req, report, cancel)
            }
            other => other,
        }
    }

    fn separate_on_device(&mut self, mix: &Stereo, req: &Request, report: &(dyn Fn(Progress) + Sync), cancel: &AtomicBool) -> Result<Vec<Stem>> {
        let r = req.recipe();
        if r.vocal_models.is_empty() {
            bail!("recipe needs at least one vocal model");
        }
        let vocal_specs: Vec<&'static ModelSpec> = r.vocal_models.iter().map(|id| models::spec(id)).collect::<Result<_>>()?;
        let inst_specs: Vec<&'static ModelSpec> = r.inst_models.iter().map(|id| models::spec(id)).collect::<Result<_>>()?;
        let cost = |m: &ModelSpec| model_cost(m, &r);

        let mut total: f64 = vocal_specs.iter().map(|m| cost(m)).sum::<f64>() + inst_specs.iter().map(|m| cost(m)).sum::<f64>();
        if req.lead_backing {
            total += mdx_cost(&r);
        }
        if req.dereverb {
            total += mdx_cost(&r);
        }
        total += match req.instruments {
            Instruments::None => 0.0,
            Instruments::Four if r.ft_bag => 2.0 * demucs_cost(&r),
            _ => demucs_cost(&r),
        };
        let mut t = Tracker { report, cancel, base: 0.0, total };
        let mut stems: Vec<Stem> = Vec::new();

        // 1 · Vocals (ensemble) and instrumental.
        let mut estimates = Vec::new();
        for m in &vocal_specs {
            let est = t.step(&format!("Vocals · {}", m.label), cost(m), |tick| self.vocal_estimate(m, mix, &r, tick))?;
            estimates.push(est);
        }
        let vocals = if estimates.len() == 1 {
            estimates.pop().unwrap()
        } else {
            average(&estimates.iter().map(|e| (e, 1.0)).collect::<Vec<_>>())
        };
        drop(estimates);
        let mut instrumental = sub(mix, &vocals);
        if !inst_specs.is_empty() {
            let mut insts = vec![instrumental];
            for m in &inst_specs {
                let est = t.step(&format!("Instrumental · {}", m.label), cost(m), |tick| match m.arch {
                    Arch::Mdx { primary: Primary::Instrumental, .. } => {
                        self.set_view("mix", &[("primary", "instrumental"), ("residual", "vocals")]);
                        self.run_mdx(m, mix, &r, tick)
                    }
                    _ => Ok(sub(mix, &self.vocal_estimate(m, mix, &r, tick)?)),
                })?;
                insts.push(est);
            }
            instrumental = average(&insts.iter().map(|e| (e, 1.0)).collect::<Vec<_>>());
        }

        // 2 · Lead / backing vocals.
        let mut vocal_leaf = vocals.clone();
        let split_lead = req.lead_backing;
        let mut lead_backing: Option<(Stereo, Stereo)> = None;
        if split_lead {
            let kara = models::spec("kara_2")?;
            let comp = match kara.arch { Arch::Mdx { compensate, .. } => compensate, _ => 1.0 };
            self.set_view("vocals", &[("primary", "backing"), ("residual", "lead")]);
            let backing = t.step("Lead / backing · Karaoke 2", mdx_cost(&r), |tick| self.run_mdx(kara, &vocals, &r, tick))?;
            let backing = scale(&backing, comp);
            let lead = sub(&vocals, &backing);
            vocal_leaf = lead.clone();
            lead_backing = Some((lead, backing));
        }

        // 3 · De-reverb (lead if split, otherwise all vocals).
        let mut reverb: Option<(Stereo, Stereo)> = None;
        if req.dereverb {
            let m = models::spec("reverb_hq")?;
            let tgt = if split_lead { "lead" } else { "vocals" };
            let (dry_id, wet_id) = (format!("{tgt}_dry"), format!("{tgt}_reverb"));
            self.set_view(tgt, &[("primary", &dry_id), ("residual", &wet_id)]);
            let dry = t.step("De-reverb · Reverb HQ", mdx_cost(&r), |tick| self.run_mdx(m, &vocal_leaf, &r, tick))?;
            let wet = sub(&vocal_leaf, &dry);
            reverb = Some((dry, wet));
        }

        let target = if split_lead { "lead" } else { "vocals" };
        let target_label = if split_lead { "Lead vocal" } else { "Vocals" };
        stems.push(Stem { id: "vocals".into(), label: "Vocals".into(), kind: "vocal", leaf: !split_lead && !req.dereverb, audio: vocals });
        if let Some((lead, backing)) = lead_backing {
            stems.push(Stem { id: "lead".into(), label: "Lead vocal".into(), kind: "vocal", leaf: !req.dereverb, audio: lead });
            stems.push(Stem { id: "backing".into(), label: "Backing vocals".into(), kind: "vocal", leaf: true, audio: backing });
        }
        if let Some((dry, wet)) = reverb {
            stems.push(Stem { id: format!("{target}_dry"), label: format!("{target_label} · dry"), kind: "vocal", leaf: true, audio: dry });
            stems.push(Stem { id: format!("{target}_reverb"), label: format!("{target_label} · reverb"), kind: "vocal", leaf: true, audio: wet });
        }

        // 4 · Instruments from the instrumental.
        let mut parts: Vec<(String, Stereo)> = Vec::new();
        match req.instruments {
            Instruments::None => {}
            Instruments::Four if r.ft_bag => {
                for (id, name) in [("htdemucs_ft_drums", "drums"), ("htdemucs_ft_bass", "bass")] {
                    let m = models::spec(id)?;
                    self.set_view("instrumental", &[("drums", "drums"), ("bass", "bass"), ("other", "other"), ("vocals", "other"), ("guitar", "guitar"), ("piano", "piano")]);
                    let s = t.step(&format!("Instruments · {}", m.label), demucs_cost(&r), |tick| self.run_demucs(m, &instrumental, &r, tick))?;
                    parts.push((name.into(), Self::take(s, name)?));
                }
            }
            Instruments::Four | Instruments::Six => {
                let (id, keep): (&str, &[&str]) = if req.instruments == Instruments::Six {
                    ("htdemucs_6s", &["drums", "bass", "guitar", "piano"])
                } else {
                    ("htdemucs", &["drums", "bass"])
                };
                let m = models::spec(id)?;
                self.set_view("instrumental", &[("drums", "drums"), ("bass", "bass"), ("other", "other"), ("vocals", "other"), ("guitar", "guitar"), ("piano", "piano")]);
                let s = t.step(&format!("Instruments · {}", m.label), demucs_cost(&r), |tick| self.run_demucs(m, &instrumental, &r, tick))?;
                for (name, audio) in s {
                    if keep.contains(&name.as_str()) {
                        parts.push((name, audio));
                    }
                }
            }
        }
        let has_parts = !parts.is_empty();
        if has_parts {
            let mut other = instrumental.clone();
            for (_, p) in &parts {
                other = sub(&other, p);
            }
            parts.push(("other".into(), other));
        }
        stems.push(Stem { id: "instrumental".into(), label: "Instrumental".into(), kind: "music", leaf: !has_parts, audio: instrumental });
        for (name, audio) in parts {
            let label = match name.as_str() {
                "drums" => "Drums",
                "bass" => "Bass",
                "guitar" => "Guitar",
                "piano" => "Piano",
                _ => "Other",
            };
            stems.push(Stem { id: name.clone(), label: label.into(), kind: "music", leaf: true, audio });
        }
        report(Progress { fraction: 1.0, stage: "Done".into(), detail: self.backend.clone() });
        Ok(stems)
    }
}
