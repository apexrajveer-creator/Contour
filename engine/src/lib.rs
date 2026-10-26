//! Contour separation engine.
//!
//! Native, multithreaded, GPU-capable music source separation built on ONNX Runtime.
//! Supports UVR MDX-Net spectrogram models and HT-Demucs waveform models, chained into
//! cascades and ensembles by [`pipeline`].

pub mod analysis;
pub mod audio;
pub mod demucs;
pub mod mashup;
pub mod mdx;
pub mod models;
pub mod pipeline;
pub mod runtime;
pub mod stft;
pub mod stretch;
pub mod tune;
pub mod fx;
pub mod sync;
pub mod whisper;

/// Model sample rate. Every model in the registry runs at 44.1 kHz.
pub const SR: u32 = 44_100;

/// Planar stereo audio: `[left, right]`, equal lengths.
pub type Stereo = [Vec<f32>; 2];

/// Progress callback for long-running work. Receives a local fraction in `0..=1`.
/// Returning `Err` aborts the work (used for cancellation).
pub type Tick<'a> = &'a mut dyn FnMut(f32) -> anyhow::Result<()>;

#[derive(Debug)]
pub struct Cancelled;
impl std::fmt::Display for Cancelled {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("cancelled")
    }
}
impl std::error::Error for Cancelled {}

pub fn is_cancelled(e: &anyhow::Error) -> bool {
    e.downcast_ref::<Cancelled>().is_some()
}

/// Envelope resolution for live visualisation, in bins per second of audio.
pub const VIZ_RATE: usize = 50;
const VIZ_BIN: usize = SR as usize / VIZ_RATE;

/// A compact picture of what a spectrogram model decided for one window: magnitude of the mix and
/// the share the model assigned to its primary stem, on log-spaced bands × time columns (0–255).
#[derive(Clone, Debug, serde::Serialize)]
pub struct Spectrum {
    pub bands: usize,
    pub cols: usize,
    pub mag: Vec<u8>,
    pub mask: Vec<u8>,
}

/// A stretch of the song that a model has finished cutting, for live visualisation.
#[derive(Clone, Debug, serde::Serialize)]
pub struct VizChunk {
    /// Increments with every model pass, so the interface can tell passes apart.
    pub stage: u32,
    /// The part being cut ("mix", "vocals", "instrumental", …).
    pub parent: String,
    /// Seconds, start of the newly finished stretch.
    pub from: f64,
    pub to: f64,
    /// Index of the first envelope bin in `layers` (at VIZ_RATE bins per second).
    pub bin0: usize,
    /// The window the model is working on now, in seconds.
    pub window: Option<(f64, f64)>,
    /// The threads the parent is being cut into, as peak envelopes for the stretch.
    pub layers: Vec<(String, Vec<f32>)>,
    pub spectrum: Option<Spectrum>,
}

/// Peak envelope bins covering samples `[from, to)` of a signal of length `n`.
pub fn envelope(from: usize, to: usize, n: usize, value: impl Fn(usize) -> f32) -> (usize, Vec<f32>) {
    let b0 = from / VIZ_BIN;
    let b1 = to.min(n).div_ceil(VIZ_BIN);
    let bins = (b0..b1)
        .map(|b| {
            let (a, e) = (b * VIZ_BIN, ((b + 1) * VIZ_BIN).min(n));
            (a..e).step_by(4).fold(0.0f32, |m, i| m.max(value(i)))
        })
        .collect();
    (b0, bins)
}

/// `a - b` per channel.
pub fn sub(a: &Stereo, b: &Stereo) -> Stereo {
    [0, 1].map(|c| a[c].iter().zip(&b[c]).map(|(x, y)| x - y).collect())
}

/// Weighted average of several stereo signals of equal length.
pub fn average(items: &[(&Stereo, f32)]) -> Stereo {
    let n = items[0].0[0].len();
    let total: f32 = items.iter().map(|(_, w)| *w).sum();
    let mut out: Stereo = [vec![0.0; n], vec![0.0; n]];
    for (s, w) in items {
        let w = w / total;
        for c in 0..2 {
            for (o, x) in out[c].iter_mut().zip(&s[c]) {
                *o += x * w;
            }
        }
    }
    out
}

pub fn scale(a: &Stereo, g: f32) -> Stereo {
    [0, 1].map(|c| a[c].iter().map(|x| x * g).collect())
}

pub fn peak(a: &Stereo) -> f32 {
    a.iter().flat_map(|c| c.iter()).fold(0.0f32, |m, x| m.max(x.abs()))
}
