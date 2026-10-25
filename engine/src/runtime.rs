//! ONNX Runtime session creation with hardware acceleration and automatic fallback.

use anyhow::{anyhow, Result};
use ort::session::Session;
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum Device {
    #[default]
    Auto,
    Cpu,
    Cuda,
    DirectMl,
    CoreMl,
}

impl Device {
    pub fn parse(s: &str) -> Option<Device> {
        Some(match s.to_ascii_lowercase().as_str() {
            "auto" => Device::Auto,
            "cpu" => Device::Cpu,
            "cuda" => Device::Cuda,
            "directml" | "dml" => Device::DirectMl,
            "coreml" => Device::CoreMl,
            _ => return None,
        })
    }
}

/// Accelerators compiled into this build (CPU is always available).
pub fn compiled_devices() -> Vec<Device> {
    #[allow(unused_mut)]
    let mut v = vec![Device::Auto, Device::Cpu];
    #[cfg(feature = "cuda")]
    v.push(Device::Cuda);
    #[cfg(target_os = "windows")]
    v.push(Device::DirectMl);
    #[cfg(target_os = "macos")]
    v.push(Device::CoreMl);
    v
}

static ENV: std::sync::OnceLock<ort::environment::Environment> = std::sync::OnceLock::new();

/// The process-wide ONNX Runtime environment (only one is allowed per process).
pub fn env() -> Result<&'static ort::environment::Environment> {
    if let Some(e) = ENV.get() {
        return Ok(e);
    }
    let e = ort::init().with_name("contour").build().map_err(|e| anyhow!("onnx runtime init: {e}"))?;
    Ok(ENV.get_or_init(|| e))
}

/// Inference threads: one per physical core. Hyper-threads share execution units, and ONNX
/// Runtime's convolution kernels usually run slower when they are oversubscribed.
pub fn threads() -> usize {
    let physical = num_cpus::get_physical().max(1);
    if physical >= 2 { physical } else { num_cpus::get().max(1) }
}

fn level(optimize: bool) -> ort::session::builder::GraphOptimizationLevel {
    use ort::session::builder::GraphOptimizationLevel as L;
    if optimize { L::Level3 } else { L::Disable }
}

fn cpu_session(path: &Path, optimize: bool) -> Result<Session> {
    let b = Session::builder(env()?).map_err(|e| anyhow!("onnx runtime: {e}"))?;
    let b = b.with_optimization_level(level(optimize)).map_err(|e| anyhow!("{e}"))?;
    // Arena and memory-pattern planning stay on: every chunk has the same shape, so the buffers are
    // allocated once and reused, which is markedly faster than allocating per run.
    let mut b = b.with_intra_threads(threads()).map_err(|e| anyhow!("{e}"))?;
    b.commit_from_file(path).map_err(|e| anyhow!("could not load model {}: {e}", path.display()))
}

/// Why each accelerator that was tried could not be used (most recent load only).
static NOTES: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());

/// Reasons the preferred accelerators were skipped during the last model load, e.g.
/// "CUDA: cudnn64_9.dll not found". Empty when the first choice worked.
pub fn accelerator_notes() -> Vec<String> {
    NOTES.lock().map(|n| n.clone()).unwrap_or_default()
}

fn short(e: impl std::fmt::Display) -> String {
    let s = e.to_string();
    let s = s.lines().find(|l| !l.trim().is_empty()).unwrap_or("").trim().to_string();
    if s.chars().count() > 220 { s.chars().take(220).collect::<String>() + "…" } else { s }
}

#[allow(unused_variables, unused_mut)]
fn accelerated(path: &Path, device: Device, optimize: bool, notes: &mut Vec<String>) -> Option<(Session, &'static str)> {
    let mut eps: Vec<(&'static str, ort::ep::ExecutionProviderDispatch)> = Vec::new();
    #[cfg(feature = "cuda")]
    if matches!(device, Device::Auto | Device::Cuda) {
        eps.push((
            "CUDA",
            ort::ep::CUDA::default()
                .with_tf32(true) // Ampere and newer: TF32 tensor cores for fp32 convolutions
                // Heuristic algorithm choice without a maximal workspace: fast to start, and it keeps
                // cuDNN from reserving scratch memory that a 4 GB card does not have.
                .with_conv_algorithm_search(ort::ep::cuda::ConvAlgorithmSearch::Heuristic)
                .with_conv_max_workspace(false)
                .with_arena_extend_strategy(ort::ep::ArenaExtendStrategy::SameAsRequested) // don't over-reserve VRAM on 4 GB cards
                .build(),
        ));
    }
    #[cfg(target_os = "windows")]
    if matches!(device, Device::Auto | Device::DirectMl) {
        // Ask for the high-performance GPU: on laptops the default adapter is often the integrated one.
        eps.push((
            "DirectML",
            ort::ep::DirectML::default()
                .with_performance_preference(ort::ep::directml::PerformancePreference::HighPerformance)
                .with_device_filter(ort::ep::directml::DeviceFilter::Gpu)
                .build(),
        ));
    }
    #[cfg(target_os = "macos")]
    if matches!(device, Device::Auto | Device::CoreMl) {
        eps.push(("CoreML", ort::ep::CoreML::default().build()));
    }
    let env = match env() {
        Ok(e) => e,
        Err(e) => {
            notes.push(short(e));
            return None;
        }
    };
    for (name, ep) in eps {
        let attempt = (|| -> Result<Session> {
            let b = Session::builder(env).map_err(|e| anyhow!(short(e)))?;
            let b = b.with_optimization_level(level(optimize)).map_err(|e| anyhow!(short(e)))?;
            let b = b.with_intra_threads(threads()).map_err(|e| anyhow!(short(e)))?;
            // DirectML requires sequential execution and no memory-pattern planning.
            let b = if name == "DirectML" { b.with_memory_pattern(false).map_err(|e| anyhow!(short(e)))? } else { b };
            let mut b = b.with_execution_providers([ep.error_on_failure()]).map_err(|e| anyhow!(short(e)))?;
            b.commit_from_file(path).map_err(|e| anyhow!(short(e)))
        })();
        match attempt {
            Ok(s) => return Some((s, name)),
            Err(e) => notes.push(format!("{name}: {e}")),
        }
    }
    None
}

/// Load a model, preferring the requested accelerator and falling back to multithreaded CPU.
/// Returns the session and a human-readable backend name.
///
/// `optimize = false` disables ONNX Runtime graph optimisation. The fp16-weight HT-Demucs exports
/// need this: constant-folding their weights balloons load-time memory from ~0.3 GB to over 3.5 GB.
pub fn load_session(path: &Path, device: Device, optimize: bool) -> Result<(Session, String)> {
    let mut notes = Vec::new();
    let result = (|| {
        if device != Device::Cpu {
            if let Some((s, name)) = accelerated(path, device, optimize, &mut notes) {
                return Ok((s, name.to_string()));
            }
        }
        Ok((cpu_session(path, optimize)?, format!("CPU ×{}", threads())))
    })();
    if let Ok(mut n) = NOTES.lock() {
        *n = notes;
    }
    result
}

/// True for errors where the GPU itself went away mid-job (Windows TDR reset, driver crash,
/// out of video memory). The job can be finished on the CPU instead.
pub fn is_device_lost(e: &anyhow::Error) -> bool {
    let s = format!("{e:#}").to_ascii_lowercase();
    ["887a0005", "887a0006", "887a0007", "device instance has been suspended", "device removed", "device_removed",
     "device hung", "out of memory", "e_outofmemory", "cudaerror", "cuda failure", "cudnn", "dmlexecutionprovider"]
        .iter()
        .any(|k| s.contains(k))
}

/// Load a Demucs-style model whose fp16 weights make graph optimisation memory-hungry.
///
/// The first time, the model is optimised once at the basic (device-independent) level and the
/// result is saved next to it as `<name>.opt.onnx`; that single pass folds the fp16→fp32 weight casts.
/// After that, the cached file loads with full optimisation and no memory spike. If anything about
/// the cache fails, the original model is loaded unoptimised, exactly as before.
pub fn load_heavy(path: &Path, device: Device) -> Result<(Session, String)> {
    let cache = path.with_extension("opt.onnx");
    // A marker guards the one-time optimisation (it briefly needs ~3–4 GB of RAM): if the process
    // dies during it, the marker remains and it is never attempted again on this machine.
    let marker = path.with_extension("opt.onnx.building");
    let skip = marker.exists() || std::env::var_os("CONTOUR_NO_MODEL_CACHE").is_some();
    if !cache.exists() && !skip {
        let _ = std::fs::write(&marker, b"");
        let tmp = path.with_extension("opt.onnx.part");
        let built = (|| -> Result<()> {
            let b = Session::builder(env()?).map_err(|e| anyhow!("{e}"))?;
            let b = b.with_optimization_level(ort::session::builder::GraphOptimizationLevel::Level1).map_err(|e| anyhow!("{e}"))?;
            let b = b.with_intra_threads(threads()).map_err(|e| anyhow!("{e}"))?;
            let mut b = b.with_optimized_model_path(&tmp).map_err(|e| anyhow!("{e}"))?;
            drop(b.commit_from_file(path).map_err(|e| anyhow!("{e}"))?);
            std::fs::rename(&tmp, &cache)?;
            Ok(())
        })();
        if built.is_err() {
            let _ = std::fs::remove_file(&tmp);
        }
        let _ = std::fs::remove_file(&marker);
    }
    if cache.exists() {
        if let Ok(s) = load_session(&cache, device, true) {
            return Ok(s);
        }
        let _ = std::fs::remove_file(&cache); // unreadable cache: rebuild next time
    }
    load_session(path, device, false)
}

/// Suggested chunk batch size for a backend.
///
/// DirectML gets one chunk per dispatch: on Windows a single GPU dispatch that runs longer than
/// ~2 s triggers a driver reset (TDR, error 887A0005), and four MDX chunks at once can exceed that
/// on mid-range GPUs.
pub fn batch_for(backend: &str) -> usize {
    match backend {
        "CUDA" => 2,
        _ => 1,
    }
}

/// Largest batch the adaptive sizing may grow to on a backend (CPU stays at 1).
pub fn max_batch_for(backend: &str) -> usize {
    match backend {
        "CUDA" => 8,
        "DirectML" | "CoreML" => 4,
        _ => 1,
    }
}
