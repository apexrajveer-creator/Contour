//! Contour desktop app: Tauri commands wrapping the separation engine.

use contour_engine::{
    audio::{self, Format},
    models,
    pipeline::{Engine, Progress, Request},
    runtime::{self, Device},
    sub, Stereo, SR,
};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{ipc::Response, AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

const PEAK_COLS: usize = 1600;
const AUDIO_EXT: &[&str] = &[
    "wav", "mp3", "flac", "m4a", "aac", "ogg", "oga", "opus", "aif", "aiff", "alac", "mp4", "mkv", "webm", "caf",
];

#[derive(Clone)]
struct Source {
    path: PathBuf,
    name: String,
    rate: u32,
    mix: Arc<Stereo>,
}

#[derive(Clone)]
struct StemData {
    id: String,
    label: String,
    audio: Arc<Stereo>,
}

#[derive(Default)]
struct Inner {
    source: Option<Source>,
    stems: Vec<StemData>,
    engine: Option<Engine>,
    mashup: Mashup,
    last_request: Option<Request>,
    /// Pitch tracks (10 ms frames) of recent audio, keyed by the audio's identity. Bounded: at most 4.
    pitch_cache: Vec<(usize, Arc<Vec<f32>>)>,
    /// The untouched audio of stems that were levelled out or synced, for "Restore original".
    originals: std::collections::HashMap<String, Arc<Stereo>>,
    /// The song's beat grid (seconds), keyed by the mix's identity: computed once for Sync to beat.
    song_beats: Option<(usize, Arc<Vec<f64>>)>,
    /// Stems as they were before a Sing key change (every change starts from these; key 0 restores them).
    key_originals: std::collections::HashMap<String, Arc<Stereo>>,
}

/// Pitch of a stem, computed once per distinct audio (re-tuning with new settings reuses it).
fn cached_pitch(inner: &mut Inner, audio: &Arc<Stereo>) -> Option<Arc<Vec<f32>>> {
    let key = Arc::as_ptr(audio) as usize;
    inner.pitch_cache.iter().find(|(k, _)| *k == key).map(|(_, v)| v.clone())
}
fn store_pitch(inner: &mut Inner, audio: &Arc<Stereo>, pitch: Arc<Vec<f32>>) {
    let key = Arc::as_ptr(audio) as usize;
    inner.pitch_cache.retain(|(k, _)| *k != key);
    inner.pitch_cache.push((key, pitch));
    if inner.pitch_cache.len() > 4 {
        inner.pitch_cache.remove(0);
    }
}

struct AppState {
    inner: Mutex<Inner>,
    cancel: Arc<AtomicBool>,
    busy: AtomicBool,
    models_dir: PathBuf,
}

// ───────────────────────────── time estimates ─────────────────────────────
// Seconds of processing per (cost unit × second of audio), learned per processor from real runs.

fn perf_path(state: &AppState) -> PathBuf {
    state.models_dir.parent().map(|p| p.join("perf.json")).unwrap_or_else(|| PathBuf::from("perf.json"))
}
fn perf_load(state: &AppState) -> std::collections::HashMap<String, f64> {
    std::fs::read_to_string(perf_path(state)).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}
fn device_key(d: Device) -> String {
    format!("{d:?}").to_ascii_lowercase()
}
/// A first guess before anything has been measured on this machine.
fn perf_default(d: Device) -> f64 {
    match d {
        Device::Cpu => 4.0 / runtime::threads() as f64,
        _ => 0.06,
    }
}

#[derive(Serialize)]
struct Estimate {
    seconds: f64,
    calibrated: bool,
}

#[tauri::command]
fn estimate(state: State<'_, AppState>, request: Request, device: Device, region: Option<[f64; 2]>) -> Option<Estimate> {
    let duration = {
        let inner = state.inner.lock().unwrap();
        let src = inner.source.as_ref()?;
        src.mix[0].len() as f64 / SR as f64
    };
    let span = region.map(|[a, b]| (b - a).abs()).filter(|d| *d > 0.05).unwrap_or(duration);
    let perf = perf_load(&state);
    let key = device_key(device);
    let factor = perf.get(&key).copied();
    Some(Estimate { seconds: factor.unwrap_or_else(|| perf_default(device)) * request.cost_units() * span + 2.0, calibrated: factor.is_some() })
}

type CmdResult<T> = Result<T, String>;

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

struct BusyGuard<'a>(&'a AtomicBool);
impl Drop for BusyGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

fn claim(state: &AppState) -> CmdResult<BusyGuard<'_>> {
    if state.busy.swap(true, Ordering::SeqCst) {
        return Err("Contour is still working on the previous task.".into());
    }
    state.cancel.store(false, Ordering::SeqCst);
    Ok(BusyGuard(&state.busy))
}

fn friendly(e: anyhow::Error) -> String {
    if contour_engine::is_cancelled(&e) {
        "cancelled".into()
    } else {
        format!("{e:#}")
    }
}

// ───────────────────────────── info & dialogs ─────────────────────────────

#[derive(Serialize)]
struct AppInfo {
    version: &'static str,
    models_dir: String,
    devices: Vec<Device>,
    threads: usize,
    /// A file passed on the command line ("Open with Contour").
    launch_file: Option<String>,
    /// Separate the launch file immediately (CONTOUR_AUTORUN=1; used for automated testing).
    autorun: bool,
    /// Started by the installer to download the core models (`--setup`).
    setup_mode: bool,
}

#[tauri::command]
fn app_info(state: State<'_, AppState>) -> AppInfo {
    AppInfo {
        version: env!("CARGO_PKG_VERSION"),
        models_dir: state.models_dir.display().to_string(),
        devices: runtime::compiled_devices(),
        threads: runtime::threads(),
        launch_file: std::env::args().skip(1).find(|a| !a.starts_with('-') && std::path::Path::new(a).is_file()),
        autorun: std::env::var("CONTOUR_AUTORUN").is_ok(),
        setup_mode: std::env::args().any(|a| a == "--setup"),
    }
}

#[tauri::command]
async fn pick_audio(app: AppHandle) -> Option<String> {
    app.dialog()
        .file()
        .set_title("Import a song")
        .add_filter("Audio", AUDIO_EXT)
        .blocking_pick_file()
        .and_then(|f| f.into_path().ok())
        .map(|p| p.display().to_string())
}

#[tauri::command]
async fn pick_folder(app: AppHandle, start: Option<String>) -> Option<String> {
    let mut d = app.dialog().file().set_title("Choose where to save the stems");
    if let Some(dir) = start.filter(|p| std::path::Path::new(p).is_dir()) {
        d = d.set_directory(dir);
    }
    d.blocking_pick_folder()
        .and_then(|f| f.into_path().ok())
        .map(|p| p.display().to_string())
}

#[tauri::command]
fn reveal(app: AppHandle, path: String) -> CmdResult<()> {
    app.opener().reveal_item_in_dir(path).map_err(err)
}

// ───────────────────────────── audio ─────────────────────────────

#[derive(Serialize)]
struct SourceInfo {
    name: String,
    path: String,
    duration: f64,
    rate: u32,
    channels: usize,
    peaks: Vec<f32>,
}

#[tauri::command]
async fn load_audio(state: State<'_, AppState>, path: String) -> CmdResult<SourceInfo> {
    let _guard = claim(&state)?;
    let p = PathBuf::from(&path);
    let (dec, mix) = tauri::async_runtime::spawn_blocking(move || -> anyhow::Result<_> {
        let dec = audio::decode(&p)?;
        if dec.duration() < 0.5 {
            anyhow::bail!("this file is shorter than half a second");
        }
        let mix = audio::resample(&dec.audio, dec.rate, SR)?;
        Ok((dec, mix))
    })
    .await
    .map_err(err)?
    .map_err(friendly)?;

    let name = PathBuf::from(&path).file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "song".into());
    let info = SourceInfo {
        name: name.clone(),
        path: path.clone(),
        duration: dec.duration(),
        rate: dec.rate,
        channels: dec.source_channels,
        peaks: audio::peaks(&mix, PEAK_COLS),
    };
    let mut inner = state.inner.lock().unwrap();
    inner.source = Some(Source { path: PathBuf::from(path), name, rate: dec.rate, mix: Arc::new(mix) });
    inner.stems.clear();
    inner.mashup = Mashup::default();
    inner.last_request = None;
    Ok(info)
}

#[tauri::command]
fn clear_audio(state: State<'_, AppState>) -> CmdResult<()> {
    let _guard = claim(&state)?;
    let mut inner = state.inner.lock().unwrap();
    inner.source = None;
    inner.stems.clear();
    inner.mashup = Mashup::default();
    inner.last_request = None;
    Ok(())
}

/// PCM for playback, planar at 44.1 kHz: all left samples, then all right samples.
///
/// `depth: 16` (what the player uses) sends a little-endian f32 scale followed by i16 samples —
/// half the data of f32, with the scale keeping loud stems from clipping. Without it, plain f32.
/// Runs off the main thread so the interface never stalls while a long track is prepared.
#[tauri::command]
async fn pcm(state: State<'_, AppState>, id: String, depth: Option<u32>) -> CmdResult<Response> {
    let audio = {
        let inner = state.inner.lock().unwrap();
        if id == "original" {
            inner.source.as_ref().map(|s| s.mix.clone())
        } else {
            inner.stems.iter().find(|s| s.id == id).map(|s| s.audio.clone())
        }
    }
    .ok_or_else(|| format!("no audio for '{id}'"))?;
    let bytes = tauri::async_runtime::spawn_blocking(move || {
        if depth == Some(16) {
            let scale = contour_engine::peak(&audio).max(1.0);
            let k = 32767.0 / scale;
            let mut bytes = Vec::with_capacity(4 + audio[0].len() * 4);
            bytes.extend_from_slice(&scale.to_le_bytes());
            for ch in audio.iter() {
                for x in ch {
                    bytes.extend_from_slice(&((x * k).round().clamp(-32768.0, 32767.0) as i16).to_le_bytes());
                }
            }
            bytes
        } else {
            let mut bytes = Vec::with_capacity(audio[0].len() * 8);
            for ch in audio.iter() {
                for x in ch {
                    bytes.extend_from_slice(&x.to_le_bytes());
                }
            }
            bytes
        }
    })
    .await
    .map_err(err)?;
    Ok(Response::new(bytes))
}

// ───────────────────────────── projects ─────────────────────────────
// A project is `<name>.contour` (JSON: song, stems, mixer, curves, view) plus a sibling folder
// `<name> audio/` holding the original and every stem as 24-bit FLAC — lossless, compact, and
// openable in any other audio app. Each file stores a scale so stems louder than 0 dBFS survive.

#[derive(serde::Serialize, serde::Deserialize)]
struct ProjectAudio {
    id: String,
    label: String,
    file: String,
    scale: f32,
}

#[derive(serde::Serialize, serde::Deserialize)]
struct ProjectFile {
    app: String,
    version: u32,
    name: String,
    source_path: String,
    source_rate: u32,
    channels: usize,
    original: ProjectAudio,
    stems: Vec<ProjectAudio>,
    /// Interface state (tracks, mixer, curves, loop, settings) — owned by the interface.
    ui: serde_json::Value,
}

#[derive(Serialize)]
struct OpenedProject {
    source: SourceInfo,
    stems: Vec<StemInfo>,
    ui: serde_json::Value,
}

fn audio_dir(project: &std::path::Path) -> PathBuf {
    let stem = project.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "project".into());
    project.with_file_name(format!("{stem} audio"))
}

#[tauri::command]
async fn pick_project_save(app: AppHandle, name: String) -> Option<String> {
    app.dialog()
        .file()
        .set_title("Save project")
        .add_filter("Contour project", &["contour"])
        .set_file_name(format!("{}.contour", sanitize(&name)))
        .blocking_save_file()
        .and_then(|f| f.into_path().ok())
        .map(|p| if p.extension().is_none() { p.with_extension("contour") } else { p })
        .map(|p| p.display().to_string())
}

#[tauri::command]
async fn pick_project_open(app: AppHandle) -> Option<String> {
    app.dialog()
        .file()
        .set_title("Open project")
        .add_filter("Contour project", &["contour"])
        .blocking_pick_file()
        .and_then(|f| f.into_path().ok())
        .map(|p| p.display().to_string())
}


/// Write a project: the audio of every stem (24-bit FLAC, scaled when louder than 0 dBFS) into the
/// sibling audio folder, then the project file itself (atomically, via a temporary file).
fn write_project_files(
    project: &std::path::Path,
    name: &str,
    source_path: &str,
    source_rate: u32,
    original: &Stereo,
    stems: &[(String, String, Arc<Stereo>)],
    ui: serde_json::Value,
    progress: &dyn Fn(usize, usize, &str),
) -> anyhow::Result<()> {
    let dir = audio_dir(project);
    std::fs::create_dir_all(&dir)?;
    let total = stems.len() + 1;
    let mut used = std::collections::HashSet::new();
    let mut write = |i: usize, id: &str, label: &str, audio: &Stereo| -> anyhow::Result<ProjectAudio> {
        progress(i, total, label);
        let scale = contour_engine::peak(audio).max(1.0);
        let scaled;
        let encoded = if scale > 1.0 { scaled = contour_engine::scale(audio, 1.0 / scale); &scaled } else { audio };
        // file names follow the labels, made unique so two stems can never overwrite each other
        let base = sanitize(label);
        let mut stem = base.clone();
        if !used.insert(stem.to_lowercase()) {
            stem = format!("{base} ({})", sanitize(id));
            let mut k = 2;
            while !used.insert(stem.to_lowercase()) { stem = format!("{base} ({}) {k}", sanitize(id)); k += 1; }
        }
        let file = format!("{stem}.flac");
        let temporary = dir.join(format!("{stem}.part.flac"));
        audio::write(&temporary, encoded, SR, Format::Flac24)?;
        std::fs::rename(&temporary, dir.join(&file))?;
        Ok(ProjectAudio { id: id.to_string(), label: label.to_string(), file, scale })
    };
    let original = write(0, "original", "Original", original)?;
    let mut saved = Vec::new();
    for (i, (id, label, audio)) in stems.iter().enumerate() {
        saved.push(write(i + 1, id, label, audio)?);
    }
    let file = ProjectFile {
        app: "Contour".into(),
        version: 1,
        name: name.to_string(),
        source_path: source_path.to_string(),
        source_rate,
        channels: 2,
        original,
        stems: saved,
        ui,
    };
    let tmp = project.with_extension("contour.part");
    std::fs::write(&tmp, serde_json::to_vec_pretty(&file)?)?;
    std::fs::rename(&tmp, project)?;
    Ok(())
}

/// Read a project back: the file, the original, and every stem (padded to the original's length).
fn read_project_files(project: &std::path::Path, progress: &dyn Fn(usize, usize, &str)) -> anyhow::Result<(ProjectFile, Stereo, Vec<(String, String, Stereo)>)> {
    let text = std::fs::read_to_string(project).map_err(|e| anyhow::anyhow!("couldn't read the project: {e}"))?;
    let file: ProjectFile = serde_json::from_str(&text).map_err(|_| anyhow::anyhow!("this isn't a Contour project file"))?;
    let dir = audio_dir(project);
    let total = file.stems.len() + 1;
    let read = |i: usize, a: &ProjectAudio| -> anyhow::Result<Stereo> {
        progress(i, total, &a.label);
        let p = dir.join(&a.file);
        let d = audio::decode(&p).map_err(|e| anyhow::anyhow!("{} is missing or damaged ({e})", p.display()))?;
        let audio = audio::resample(&d.audio, d.rate, SR)?;
        Ok(if a.scale > 1.0 { contour_engine::scale(&audio, a.scale) } else { audio })
    };
    let mix = read(0, &file.original)?;
    let mut stems = Vec::new();
    for (i, a) in file.stems.iter().enumerate() {
        let mut s = read(i + 1, a)?;
        for c in 0..2 { s[c].resize(mix[0].len(), 0.0); }
        stems.push((a.id.clone(), a.label.clone(), s));
    }
    Ok((file, mix, stems))
}

/// The newest complete recovery copy in `root` (A or B), and the slot the next full save should use.
fn recovery_pick(root: &std::path::Path) -> (Option<(PathBuf, String)>, PathBuf) {
    let mut valid = ["A.contour", "B.contour"].iter().filter_map(|name| {
        let path = root.join(name);
        let file = serde_json::from_slice::<ProjectFile>(&std::fs::read(&path).ok()?).ok()?;
        let audio = audio_dir(&path);
        if !audio.join(&file.original.file).is_file() || !file.stems.iter().all(|s| audio.join(&s.file).is_file()) { return None; }
        let modified = path.metadata().ok()?.modified().ok()?;
        Some((modified, path, file.name))
    }).collect::<Vec<_>>();
    valid.sort_by_key(|v| v.0);
    let current = valid.last().map(|v| (v.1.clone(), v.2.clone()));
    let next = if current.as_ref().map(|v| v.0.ends_with("A.contour")).unwrap_or(false) { "B.contour" } else { "A.contour" };
    (current, root.join(next))
}

#[tauri::command]
async fn save_project(app: AppHandle, state: State<'_, AppState>, path: String, ui: serde_json::Value) -> CmdResult<String> {
    let _guard = claim(&state)?;
    let (source, stems) = {
        let inner = state.inner.lock().unwrap();
        let src = inner.source.as_ref().ok_or("Import a song first.")?;
        let source = (src.path.clone(), src.name.clone(), src.rate, src.mix.clone());
        let stems: Vec<(String, String, Arc<Stereo>)> = inner.stems.iter().map(|s| (s.id.clone(), s.label.clone(), s.audio.clone())).collect();
        (source, stems)
    };
    let project = PathBuf::from(&path);
    tauri::async_runtime::spawn_blocking(move || -> anyhow::Result<String> {
        let progress = |i: usize, total: usize, label: &str| {
            let _ = app.emit("progress", Progress { fraction: i as f32 / total as f32, stage: "Saving project".into(), detail: label.to_string() });
        };
        let named: std::collections::HashMap<String, String> = ui.get("tracks").and_then(|t| t.as_array()).map(|a| a.iter().filter_map(|t| Some((t.get("id")?.as_str()?.to_string(), t.get("label")?.as_str()?.to_string()))).collect()).unwrap_or_default();
        let stems: Vec<(String, String, Arc<Stereo>)> = stems.into_iter().map(|(id, label, a)| { let l = named.get(&id).cloned().filter(|l| !l.trim().is_empty()).unwrap_or(label); (id, l, a) }).collect();
        write_project_files(&project, &source.1, &source.0.display().to_string(), source.2, &source.3, &stems, ui, &progress)?;
        let _ = app.emit("progress", Progress { fraction: 1.0, stage: "Project saved".into(), detail: String::new() });
        Ok(project.display().to_string())
    })
    .await
    .map_err(err)?
    .map_err(friendly)
}

#[tauri::command]
async fn open_project(app: AppHandle, state: State<'_, AppState>, path: String) -> CmdResult<OpenedProject> {
    let _guard = claim(&state)?;
    let project = PathBuf::from(&path);
    let (file, mix, stems) = tauri::async_runtime::spawn_blocking(move || -> anyhow::Result<_> {
        let progress = |i: usize, total: usize, label: &str| {
            let _ = app.emit("progress", Progress { fraction: i as f32 / total as f32, stage: "Opening project".into(), detail: label.to_string() });
        };
        read_project_files(&project, &progress)
    })
    .await
    .map_err(err)?
    .map_err(friendly)?;

    let source = SourceInfo {
        name: file.name.clone(),
        path: file.source_path.clone(),
        duration: mix[0].len() as f64 / SR as f64,
        rate: file.source_rate,
        channels: file.channels,
        peaks: audio::peaks(&mix, PEAK_COLS),
    };
    let infos = stems
        .iter()
        .map(|(id, label, a)| StemInfo { id: id.clone(), label: label.clone(), kind: "stem", leaf: true, peaks: audio::peaks(a, PEAK_COLS) })
        .collect();
    let mut inner = state.inner.lock().unwrap();
    inner.source = Some(Source { path: PathBuf::from(&file.source_path), name: file.name.clone(), rate: file.source_rate, mix: Arc::new(mix) });
    inner.stems = stems.into_iter().map(|(id, label, audio)| StemData { id, label, audio: Arc::new(audio) }).collect();
    inner.mashup = Mashup::default();
    inner.last_request = None;
    Ok(OpenedProject { source, stems: infos, ui: file.ui })
}

/// Total size of the downloaded models, for the Storage section of Settings.
#[tauri::command]
fn models_storage(state: State<'_, AppState>) -> (String, u64) {
    let dir = &state.models_dir;
    let bytes = std::fs::read_dir(dir).map(|rd| rd.flatten().filter_map(|e| e.metadata().ok()).filter(|m| m.is_file()).map(|m| m.len()).sum()).unwrap_or(0);
    (dir.display().to_string(), bytes)
}

fn recovery_root(app: &AppHandle) -> CmdResult<PathBuf> {
    let root = app.path().app_data_dir().map_err(err)?.join("recovery");
    std::fs::create_dir_all(&root).map_err(err)?;
    Ok(root)
}
#[tauri::command]
fn recovery_info(app: AppHandle) -> CmdResult<serde_json::Value> {
    let root = recovery_root(&app)?;
    let (current, next) = recovery_pick(&root);
    Ok(serde_json::json!({"path": next.display().to_string(), "restore_path": current.as_ref().map(|v| v.0.display().to_string()), "available": current.is_some(), "name": current.map(|v| v.1)}))
}
#[tauri::command]
fn recovery_update(app: AppHandle, state: State<'_, AppState>, path: String, ui: serde_json::Value) -> CmdResult<()> {
    let _guard = claim(&state)?;
    let root = recovery_root(&app)?;
    let path = PathBuf::from(path);
    if path.parent() != Some(root.as_path()) || !matches!(path.file_name().and_then(|n|n.to_str()),Some("A.contour"|"B.contour")) { return Err("Invalid recovery path".into()); }
    let mut file: ProjectFile = serde_json::from_slice(&std::fs::read(&path).map_err(err)?).map_err(err)?;
    file.ui = ui;
    let temporary = path.with_extension("contour.part");
    std::fs::write(&temporary,serde_json::to_vec_pretty(&file).map_err(err)?).map_err(err)?;
    std::fs::rename(temporary,path).map_err(err)
}
#[tauri::command]
fn recovery_clear(app: AppHandle, state: State<'_, AppState>) -> CmdResult<()> {
    let _guard = claim(&state)?;
    let root = recovery_root(&app)?;
    for name in ["A.contour","B.contour"] {
        let p = root.join(name); if p.exists() { std::fs::remove_file(&p).map_err(err)?; }
        let d = audio_dir(&p); if d.exists() { std::fs::remove_dir_all(d).map_err(err)?; }
    }
    Ok(())
}

// ───────────────────────────── Mashup Lab ─────────────────────────────
// Slot A gives the vocals, slot B the music. Each song is separated once (cached per settings);
// re-rendering with new timing/key/level settings only re-runs the stretcher, which takes seconds.

use contour_engine::analysis::{self, SongAnalysis};
use contour_engine::mashup::{self, MashupPlan, MashupSettings};
use contour_engine::pipeline::{Instruments, Quality};

#[derive(Clone)]
struct SlotSeparation {
    key: (Quality, bool),
    vocals: Arc<Stereo>,
    music: Vec<(String, String, Arc<Stereo>)>, // (id, label, audio): the instrumental, or drums/bass/other
    analysis: SongAnalysis,
}

#[derive(Clone)]
struct Slot {
    name: String,
    path: PathBuf,
    rate: u32,
    mix: Arc<Stereo>,
    bpm: f64,
    key: String,
    peaks: Vec<f32>,
    sep: Option<SlotSeparation>,
}

#[derive(Default)]
struct Mashup {
    a: Option<Slot>,
    b: Option<Slot>,
}

#[derive(Serialize, Clone)]
struct SlotInfo {
    name: String,
    duration: f64,
    bpm: f64,
    key: String,
    peaks: Vec<f32>,
}

fn slot_info(s: &Slot) -> SlotInfo {
    let (bpm, key) = s.sep.as_ref().map(|x| (x.analysis.bpm, x.analysis.key_name())).unwrap_or((s.bpm, s.key.clone()));
    SlotInfo { name: s.name.clone(), duration: s.mix[0].len() as f64 / SR as f64, bpm, key, peaks: s.peaks.clone() }
}

#[derive(Serialize)]
struct MashupResult {
    backend: String,
    notes: Vec<String>,
    plan: MashupPlan,
    a: SlotInfo,
    b: SlotInfo,
    source: SourceInfo,
    stems: Vec<StemInfo>,
}

#[tauri::command]
async fn mashup_load(state: State<'_, AppState>, slot: String, path: String) -> CmdResult<SlotInfo> {
    let _guard = claim(&state)?;
    let p = PathBuf::from(&path);
    let slot_value = tauri::async_runtime::spawn_blocking(move || -> anyhow::Result<Slot> {
        let dec = audio::decode(&p)?;
        if dec.duration() < 5.0 {
            anyhow::bail!("this file is too short for a mashup (under 5 seconds)");
        }
        let mix = audio::resample(&dec.audio, dec.rate, SR)?;
        // A quick read of tempo and key from the full mix; refined after separation.
        let (bpm, _, _) = analysis::rhythm(&mix, None);
        let (k, minor, _) = analysis::detect_key(&mix);
        let key = format!("{} {}", analysis::KEY_NAMES[k as usize], if minor { "minor" } else { "major" });
        let name = p.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "song".into());
        let peaks = audio::peaks(&mix, PEAK_COLS);
        Ok(Slot { name, path: p, rate: dec.rate, mix: Arc::new(mix), bpm, key, peaks, sep: None })
    })
    .await
    .map_err(err)?
    .map_err(friendly)?;
    let info = slot_info(&slot_value);
    let mut inner = state.inner.lock().unwrap();
    if slot == "a" { inner.mashup.a = Some(slot_value) } else { inner.mashup.b = Some(slot_value) }
    Ok(info)
}

/// Copy the active session into a Mashup slot without decoding/resampling again.
/// Compatible separated stems share Arc buffers and only need musical analysis once.
#[tauri::command]
async fn mashup_use_current(state: State<'_, AppState>, slot: String, quality: Quality, split: bool) -> CmdResult<SlotInfo> {
    let _guard = claim(&state)?;
    if slot != "a" && slot != "b" { return Err("Unknown song slot".into()); }
    let (source, stems, request) = {
        let inner = state.inner.lock().unwrap();
        (inner.source.clone().ok_or("Import a song first.")?, inner.stems.clone(), inner.last_request.clone())
    };
    let value = tauri::async_runtime::spawn_blocking(move || -> CmdResult<Slot> {
        if source.mix[0].len() < SR as usize * 5 { return Err("This song is too short for a mashup.".into()); }
        let get = |id: &str| stems.iter().find(|s| s.id == id).map(|s| s.audio.clone());
        let vocals = get("vocals");
        let music = get("instrumental");
        let compatible = request.as_ref().map(|r| r.quality == quality && (!split || r.instruments == Instruments::Four)).unwrap_or(false)
            && vocals.is_some() && music.is_some()
            && (!split || ["drums", "bass", "other"].iter().all(|id| get(id).is_some()));
        let analysis = analysis::analyse(&source.mix, vocals.as_deref(), music.as_deref());
        let sep = if compatible {
            let music_parts = if split {
                ["drums","bass","other"].iter().filter_map(|id| get(id).map(|a| ((*id).to_string(),(*id).to_string(),a))).collect()
            } else { vec![("instrumental".into(),"Music".into(),music.unwrap())] };
            Some(SlotSeparation { key:(quality,split), vocals:vocals.unwrap(), music:music_parts, analysis:analysis.clone() })
        } else { None };
        Ok(Slot { name:source.name, path:source.path, rate:source.rate, peaks:audio::peaks(&source.mix,PEAK_COLS), mix:source.mix, bpm:analysis.bpm, key:analysis.key_name(), sep })
    }).await.map_err(err)??;
    let info = slot_info(&value);
    let mut inner = state.inner.lock().unwrap();
    if slot == "a" { inner.mashup.a = Some(value); } else { inner.mashup.b = Some(value); }
    Ok(info)
}

#[tauri::command]
fn mashup_swap(state: State<'_, AppState>) -> CmdResult<(Option<SlotInfo>, Option<SlotInfo>)> {
    let _guard = claim(&state)?;
    let mut inner = state.inner.lock().unwrap();
    let m = &mut inner.mashup;
    std::mem::swap(&mut m.a, &mut m.b);
    Ok((m.a.as_ref().map(slot_info), m.b.as_ref().map(slot_info)))
}

fn render_mashup(inner: &mut Inner, settings: &MashupSettings) -> Result<MashupResult, String> {
    let (a, b) = match (&inner.mashup.a, &inner.mashup.b) {
        (Some(a), Some(b)) => (a, b),
        _ => return Err("Add a song for the vocals and a song for the music.".into()),
    };
    let (sa, sb) = match (&a.sep, &b.sep) {
        (Some(x), Some(y)) => (x, y),
        _ => return Err("Make the mashup first.".into()),
    };
    let len = b.mix[0].len();
    // Song A's music goes through the same time map and key shift as its vocal, so all four lanes —
    // A's vocal and music, B's vocal and music — stay in time and in tune.
    let sum = |parts: &[(String, String, Arc<Stereo>)]| -> Option<Stereo> {
        let first = parts.first()?;
        let mut m: Stereo = [vec![0.0; first.2[0].len()], vec![0.0; first.2[0].len()]];
        for (_, _, p) in parts {
            for c in 0..2 {
                for (o, x) in m[c].iter_mut().zip(&p[c]) { *o += x; }
            }
        }
        Some(m)
    };
    let music_a = sum(&sa.music);
    let music_b_rms = sum(&sb.music).map(|m| mashup::rms_active(&m)).unwrap_or(0.0);
    let (vocal, music_a_fit, plan) = mashup::render_with_music(&sa.vocals, music_a.as_ref(), music_b_rms, &sa.analysis, &sb.analysis, len, settings);
    let short = |n: &str| n.rsplit_once('.').map(|(s, _)| s.to_string()).unwrap_or_else(|| n.to_string());
    let (an, bn) = (short(&a.name), short(&b.name));
    let mut stems: Vec<(String, String, &'static str, Arc<Stereo>)> = vec![("vocals".into(), format!("Vocals · {an}"), "vocal", Arc::new(vocal))];
    if let Some(m) = music_a_fit {
        stems.push(("music_a".into(), format!("Music · {an}"), "music", Arc::new(m)));
    }
    let mut vb = (*sb.vocals).clone();
    for c in 0..2 { vb[c].resize(len, 0.0); }
    stems.push(("vocals_b".into(), format!("Vocals · {bn}"), "vocal", Arc::new(vb)));
    for (id, label, audio) in &sb.music {
        stems.push((id.clone(), format!("{label} · {bn}"), "music", audio.clone()));
    }
    let mut mix: Stereo = [vec![0.0; len], vec![0.0; len]];
    for (_, _, _, s) in &stems {
        for c in 0..2 {
            for (o, x) in mix[c].iter_mut().zip(&s[c]) {
                *o += x;
            }
        }
    }
    let name = format!("{an} × {bn}");
    let source = SourceInfo { name: name.clone(), path: b.path.display().to_string(), duration: len as f64 / SR as f64, rate: b.rate, channels: 2, peaks: audio::peaks(&mix, PEAK_COLS) };
    let infos = stems.iter().map(|(id, label, kind, s)| StemInfo { id: id.clone(), label: label.clone(), kind, leaf: true, peaks: audio::peaks(s, PEAK_COLS) }).collect();
    let (ai, bi) = (slot_info(a), slot_info(b));
    let path = b.path.clone();
    let rate = b.rate;
    inner.last_request = None;
    inner.source = Some(Source { path, name, rate, mix: Arc::new(mix) });
    inner.stems = stems.into_iter().map(|(id, label, _, audio)| StemData { id, label, audio }).collect();
    let backend = inner.engine.as_ref().map(|e| e.backend.clone()).unwrap_or_default();
    let notes = inner.engine.as_ref().map(|e| e.notes.clone()).unwrap_or_default();
    Ok(MashupResult { backend, notes, plan, a: ai, b: bi, source, stems: infos })
}

#[tauri::command]
async fn mashup_build(app: AppHandle, state: State<'_, AppState>, quality: Quality, split: bool, device: Device, settings: MashupSettings) -> CmdResult<MashupResult> {
    let _guard = claim(&state)?;
    let key = (quality, split);
    // Take what needs separating out of the state (songs stay cached between runs).
    let (jobs, engine) = {
        let mut inner = state.inner.lock().unwrap();
        let (a, b) = match (&inner.mashup.a, &inner.mashup.b) {
            (Some(a), Some(b)) => (a, b),
            _ => return Err("Add a song for the vocals and a song for the music.".into()),
        };
        let mut jobs = Vec::new();
        if a.sep.as_ref().map(|s| s.key) != Some((quality, false)) {
            jobs.push(("a", a.mix.clone(), Request { quality, instruments: Instruments::None, ..Request::default() }));
        }
        if b.sep.as_ref().map(|s| s.key) != Some(key) {
            let instruments = if split { Instruments::Four } else { Instruments::None };
            jobs.push(("b", b.mix.clone(), Request { quality, instruments, ..Request::default() }));
        }
        let engine = match inner.engine.take() {
            Some(e) if e.requested == device => e,
            _ => Engine::new(state.models_dir.clone(), device),
        };
        (jobs, engine)
    };
    let cancel = state.cancel.clone();
    let emitter = app.clone();
    let (engine, results) = tauri::async_runtime::spawn_blocking(move || {
        let mut engine = engine;
        let total = jobs.len().max(1) as f32;
        let mut out = Vec::new();
        for (i, (slot, mix, req)) in jobs.into_iter().enumerate() {
            let label = if slot == "a" { "Vocals song" } else { "Music song" };
            let em = emitter.clone();
            let report = move |p: Progress| {
                let _ = em.emit("progress", Progress { fraction: (i as f32 + p.fraction * 0.95) / total, stage: format!("{label} · {}", p.stage), detail: p.detail });
            };
            let res = engine.ensure_models(&req, &report, &cancel).and_then(|_| engine.separate(&mix, &req, &report, &cancel));
            match res {
                Ok(stems) => {
                    report(Progress { fraction: 1.0, stage: "Analysing tempo and key".into(), detail: String::new() });
                    let get = |id: &str| stems.iter().find(|s| s.id == id).map(|s| s.audio.clone());
                    let vocals = get("vocals").unwrap_or_else(|| [vec![0.0; mix[0].len()], vec![0.0; mix[0].len()]]);
                    let instrumental = get("instrumental").unwrap_or_else(|| sub(&mix, &vocals));
                    let analysis = analysis::analyse(&mix, Some(&vocals), Some(&instrumental));
                    let music: Vec<(String, String, Arc<Stereo>)> = if req.instruments == Instruments::None {
                        vec![("instrumental".into(), "Music".into(), Arc::new(instrumental))]
                    } else {
                        ["drums", "bass", "other"].iter().filter_map(|id| {
                            stems.iter().find(|s| s.id == *id).map(|s| (s.id.clone(), s.label.clone(), Arc::new(s.audio.clone())))
                        }).collect()
                    };
                    out.push(Ok((slot, SlotSeparation { key: (req.quality, false), vocals: Arc::new(vocals), music, analysis })));
                }
                Err(e) => {
                    out.push(Err(e));
                    break;
                }
            }
        }
        (engine, out)
    })
    .await
    .map_err(err)?;
    let mut inner = state.inner.lock().unwrap();
    inner.engine = Some(engine);
    for r in results {
        let (slot, mut sep) = r.map_err(friendly)?;
        sep.key = if slot == "a" { (quality, false) } else { key };
        let target = if slot == "a" { inner.mashup.a.as_mut() } else { inner.mashup.b.as_mut() };
        if let Some(s) = target {
            s.sep = Some(sep);
        }
    }
    if state.cancel.load(Ordering::SeqCst) { return Err("cancelled".into()); }
    let _ = app.emit("progress", Progress { fraction: 0.98, stage: "Matching vocals to the music".into(), detail: String::new() });
    let previous_source = inner.source.clone();
    let previous_stems = inner.stems.clone();
    let result = render_mashup(&mut inner, &settings);
    if state.cancel.load(Ordering::SeqCst) {
        inner.source = previous_source;
        inner.stems = previous_stems;
        return Err("cancelled".into());
    }
    result
}

#[tauri::command]
async fn mashup_render(state: State<'_, AppState>, settings: MashupSettings) -> CmdResult<MashupResult> {
    let _guard = claim(&state)?;
    // An async command runs off the main thread, so re-rendering (stretching one vocal, a few
    // seconds for a full song) never freezes the interface.
    let mut guard = state.inner.lock().unwrap();
    render_mashup(&mut guard, &settings)
}


// ───────────────────────────── karaoke ─────────────────────────────

#[derive(Serialize)]
struct Melody {
    /// Hz every 10 ms (0 = not singing), from the separated vocal.
    hz: Vec<f32>,
    fps: usize,
    key: String,
}

/// The original singer's melody, for karaoke scoring and the note lane.
#[tauri::command]
async fn vocal_melody(state: State<'_, AppState>) -> CmdResult<Melody> {
    let (vocals, mix) = {
        let inner = state.inner.lock().unwrap();
        let v = inner.stems.iter().find(|s| s.id == "vocals").or_else(|| inner.stems.iter().find(|s| s.id == "lead")).map(|s| s.audio.clone());
        (v, inner.source.as_ref().map(|s| s.mix.clone()))
    };
    let vocals = vocals.ok_or("Separate the vocals first.")?;
    tauri::async_runtime::spawn_blocking(move || {
        let hz = contour_engine::analysis::melody(&vocals);
        let key = mix.map(|m| {
            let instrumental = contour_engine::sub(&m, &vocals);
            let (k, minor, _) = contour_engine::analysis::detect_key(&instrumental);
            format!("{} {}", contour_engine::analysis::KEY_NAMES[k as usize], if minor { "minor" } else { "major" })
        });
        Melody { hz, fps: contour_engine::analysis::MELODY_FPS, key: key.unwrap_or_default() }
    })
    .await
    .map_err(err)
}

/// Store a recorded take as the "Your take" stem. The body is raw little-endian f32 mono at 44.1 kHz;
/// the `x-offset` header gives where it starts on the song's timeline, in samples.
#[tauri::command]
fn add_take(state: State<'_, AppState>, request: tauri::ipc::Request<'_>) -> CmdResult<StemInfo> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else { return Err("Expected raw audio.".into()) };
    let offset: i64 = request.headers().get("x-offset").and_then(|v| v.to_str().ok()).and_then(|v| v.parse().ok()).unwrap_or(0);
    // The take arrives at the audio device's real rate (often 48 kHz); convert it properly to 44.1 kHz
    // rather than assuming — reading 48 kHz audio as 44.1 kHz plays it ~8% slow and low.
    let rate: u32 = request.headers().get("x-rate").and_then(|v| v.to_str().ok()).and_then(|v| v.parse().ok()).unwrap_or(SR);
    let mut samples: Vec<f32> = bytes.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect();
    if rate != SR && rate >= 8000 && !samples.is_empty() {
        let st: Stereo = [samples.clone(), samples];
        samples = audio::resample(&st, rate, SR).map_err(err)?[0].clone();
    }
    let mut inner = state.inner.lock().unwrap();
    let len = inner.source.as_ref().map(|s| s.mix[0].len()).ok_or("Import a song first.")?;
    let mut ch = vec![0f32; len];
    for (i, v) in samples.iter().enumerate() {
        let d = offset + i as i64;
        if d >= 0 && (d as usize) < len {
            ch[d as usize] = *v;
        }
    }
    let audio: Stereo = [ch.clone(), ch];
    let info = StemInfo { id: "take".into(), label: "Your take".into(), kind: "take", leaf: true, peaks: audio::peaks(&audio, PEAK_COLS) };
    inner.stems.retain(|s| s.id != "take");
    inner.stems.push(StemData { id: "take".into(), label: "Your take".into(), audio: Arc::new(audio) });
    Ok(info)
}


#[derive(Serialize)]
struct TuneResult {
    stem: StemInfo,
    curves: contour_engine::tune::TuneCurves,
}

/// Tune "Your take" to the song's melody (or key); the result is the "Your take (tuned)" stem. The
/// original take is kept for comparison.
#[tauri::command]
async fn tune_take(state: State<'_, AppState>, settings: contour_engine::tune::TuneSettings) -> CmdResult<TuneResult> {
    let (take, vocals, cached_take, cached_mel) = {
        let mut inner = state.inner.lock().unwrap();
        let take = inner.stems.iter().find(|s| s.id == "take").map(|s| s.audio.clone()).ok_or("Record or import a take first.")?;
        let vocals = inner.stems.iter().find(|s| s.id == "vocals").or_else(|| inner.stems.iter().find(|s| s.id == "lead")).map(|s| s.audio.clone());
        let (ct, cm) = (cached_pitch(&mut inner, &take), vocals.as_ref().and_then(|v| cached_pitch(&mut inner, v)));
        (take, vocals, ct, cm)
    };
    let (take2, vocals2) = (take.clone(), vocals.clone());
    let (out, curves, sung, mel) = tauri::async_runtime::spawn_blocking(move || {
        let sung = cached_take.unwrap_or_else(|| Arc::new(contour_engine::analysis::melody(&take2)));
        let mel = match (cached_mel, &vocals2) {
            (Some(m), _) => m,
            (None, Some(v)) => Arc::new(contour_engine::analysis::melody(v)),
            (None, None) => Arc::new(Vec::new()), // no original vocal: Key mode is used throughout
        };
        let (out, curves) = contour_engine::tune::tune(&take2, &sung, &mel, &settings);
        (out, curves, sung, mel)
    })
    .await
    .map_err(err)?;
    let mut inner = state.inner.lock().unwrap();
    store_pitch(&mut inner, &take, sung);
    if let Some(v) = &vocals {
        store_pitch(&mut inner, v, mel);
    }
    let stem = StemInfo { id: "take_tuned".into(), label: "Your take (tuned)".into(), kind: "take", leaf: true, peaks: audio::peaks(&out, PEAK_COLS) };
    inner.stems.retain(|s| s.id != "take_tuned");
    inner.stems.push(StemData { id: "take_tuned".into(), label: "Your take (tuned)".into(), audio: Arc::new(out) });
    Ok(TuneResult { stem, curves })
}


#[derive(Serialize)]
struct ImportedTake {
    stem: StemInfo,
    /// Where the take was placed on the song's timeline, seconds (found automatically).
    offset: f64,
}

/// Import a vocal recorded elsewhere as "Your take", lined up with the song automatically by matching
/// its onsets against the original vocal (or the mix, if the song isn't separated).
#[tauri::command]
async fn import_take(state: State<'_, AppState>, path: String) -> CmdResult<ImportedTake> {
    let (len, reference) = {
        let inner = state.inner.lock().unwrap();
        let src = inner.source.as_ref().ok_or("Import a song first.")?;
        let r = inner.stems.iter().find(|s| s.id == "vocals").or_else(|| inner.stems.iter().find(|s| s.id == "lead")).map(|s| s.audio.clone()).unwrap_or_else(|| src.mix.clone());
        (src.mix[0].len(), r)
    };
    let p = PathBuf::from(&path);
    let (audio, offset) = tauri::async_runtime::spawn_blocking(move || -> anyhow::Result<(Stereo, f64)> {
        let d = audio::decode(&p)?;
        let a = audio::resample(&d.audio, d.rate, SR)?;
        let m: Vec<f32> = a[0].iter().zip(&a[1]).map(|(l, r)| 0.5 * (l + r)).collect();
        let take: Stereo = [m.clone(), m];
        let offset = contour_engine::analysis::align_offset(&reference, &take, 20.0);
        let shift = (offset * SR as f64).round() as i64;
        let mut ch = vec![0f32; len];
        for (i, v) in take[0].iter().enumerate() {
            let dst = i as i64 + shift;
            if dst >= 0 && (dst as usize) < len { ch[dst as usize] = *v; }
        }
        Ok(([ch.clone(), ch], offset))
    })
    .await
    .map_err(err)?
    .map_err(friendly)?;
    let info = StemInfo { id: "take".into(), label: "Your take".into(), kind: "take", leaf: true, peaks: audio::peaks(&audio, PEAK_COLS) };
    let mut inner = state.inner.lock().unwrap();
    inner.stems.retain(|s| s.id != "take" && s.id != "take_tuned");
    inner.stems.push(StemData { id: "take".into(), label: "Your take".into(), audio: Arc::new(audio) });
    Ok(ImportedTake { stem: info, offset })
}


/// Add any audio file as a new Studio lane, starting at the beginning of the song.
#[tauri::command]
async fn add_lane(state: State<'_, AppState>, path: String) -> CmdResult<StemInfo> {
    let len = { state.inner.lock().unwrap().source.as_ref().map(|s| s.mix[0].len()).ok_or("Import a song first.")? };
    let p = PathBuf::from(&path);
    let label = p.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "Audio".into());
    let audio = tauri::async_runtime::spawn_blocking(move || -> anyhow::Result<Stereo> {
        let d = audio::decode(&p)?;
        let mut a = audio::resample(&d.audio, d.rate, SR)?;
        for c in 0..2 { a[c].resize(len, 0.0); }
        Ok(a)
    })
    .await
    .map_err(err)?
    .map_err(friendly)?;
    let mut inner = state.inner.lock().unwrap();
    let mut k = 1;
    while inner.stems.iter().any(|s| s.id == format!("lane_{k}")) { k += 1; }
    let id = format!("lane_{k}");
    let info = StemInfo { id: id.clone(), label: label.clone(), kind: "lane", leaf: true, peaks: audio::peaks(&audio, PEAK_COLS) };
    inner.stems.push(StemData { id, label, audio: Arc::new(audio) });
    Ok(info)
}

/// Remove a lane that was added (or a take).
#[tauri::command]
fn remove_stem(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    if !(id.starts_with("lane_") || id.starts_with("take") || id.starts_with("rec_")) { return Err("Only added lanes and recordings can be removed.".into()); }
    state.inner.lock().unwrap().stems.retain(|s| s.id != id);
    Ok(())
}


/// Lyrics jobs run in the background (they never hold the app's busy lock, so Sing stays usable);
/// one at a time, with their own cancel.
static LYRICS_RUNNING: AtomicBool = AtomicBool::new(false);
static LYRICS_CANCEL: AtomicBool = AtomicBool::new(false);

#[derive(Serialize, Clone)]
struct LyricsProgress {
    fraction: f32,
    stage: String,
    detail: String,
}

/// Lyrics for the current song, transcribed on this computer from the separated vocal with Whisper.
/// The model is downloaded the first time (once; verified by SHA-256) and kept loaded between songs.
/// Emits `lyrics-progress` and, after every window, `lyrics-partial` with the lines so far.
#[tauri::command]
async fn transcribe_lyrics(app: AppHandle, state: State<'_, AppState>, language: Option<String>, device: Option<Device>) -> CmdResult<contour_engine::whisper::Lyrics> {
    if LYRICS_RUNNING.swap(true, Ordering::SeqCst) {
        return Err("Lyrics are already being written.".into());
    }
    struct Release;
    impl Drop for Release { fn drop(&mut self) { LYRICS_RUNNING.store(false, Ordering::SeqCst); } }
    let _release = Release;
    let vocals = {
        let inner = state.inner.lock().unwrap();
        inner.stems.iter().find(|s| s.id == "vocals").or_else(|| inner.stems.iter().find(|s| s.id == "lead")).map(|s| s.audio.clone()).ok_or("Separate the vocals first.")?
    };
    let dir = state.models_dir.clone();
    LYRICS_CANCEL.store(false, Ordering::SeqCst);
    tauri::async_runtime::spawn_blocking(move || -> anyhow::Result<contour_engine::whisper::Lyrics> {
        let emit = |fraction: f32, stage: &str, detail: String| { let _ = app.emit("lyrics-progress", LyricsProgress { fraction, stage: stage.into(), detail }); };
        let cancelled = || LYRICS_CANCEL.load(Ordering::SeqCst);
        let specs: Vec<_> = contour_engine::whisper::MODEL_IDS.iter().filter_map(|id| models::spec(id).ok()).collect();
        let total: u64 = specs.iter().filter(|m| !models::is_present(&dir, m)).map(|m| m.size).sum();
        let mut done = 0u64;
        for m in &specs {
            if models::is_present(&dir, m) { continue; }
            let base = done;
            models::ensure(&dir, m, &mut |got, _| {
                if cancelled() { anyhow::bail!(contour_engine::Cancelled); }
                emit(((base + got) as f32 / total.max(1) as f32) * 0.25, "Downloading the lyrics model", format!("{} / {} MB", (base + got) / 1_000_000, total / 1_000_000));
                Ok(())
            })?;
            done += m.size;
        }
        emit(0.25, "Writing lyrics", String::new());
        contour_engine::whisper::transcribe_streaming(
            &vocals, &dir, language.as_deref(), device.unwrap_or_default(),
            &|f| emit(0.25 + 0.75 * f, "Writing lyrics", format!("{}%", (f * 100.0).round())),
            &cancelled,
            &|partial| { let _ = app.emit("lyrics-partial", partial); },
        )
    })
    .await
    .map_err(err)?
    .map_err(friendly)
}

/// Stop a lyrics job (for example when another song is opened).
#[tauri::command]
fn cancel_lyrics() {
    LYRICS_CANCEL.store(true, Ordering::SeqCst);
}

/// "Level out": even out the stem's loud and quiet passages (an automatic rider). The original is kept
/// for `restore_stem`.
#[tauri::command]
async fn level_stem(state: State<'_, AppState>, id: String) -> CmdResult<StemInfo> {
    let (audio, label) = {
        let inner = state.inner.lock().unwrap();
        let s = inner.stems.iter().find(|s| s.id == id).ok_or("That stem is gone.")?;
        (s.audio.clone(), s.label.clone())
    };
    let levelled = tauri::async_runtime::spawn_blocking(move || contour_engine::fx::level(&audio)).await.map_err(err)?;
    let info = StemInfo { id: id.clone(), label, kind: "stem", leaf: true, peaks: audio::peaks(&levelled, PEAK_COLS) };
    let mut inner = state.inner.lock().unwrap();
    let prev = inner.stems.iter().find(|s| s.id == id).map(|s| s.audio.clone());
    if let Some(p) = prev { inner.originals.entry(id.clone()).or_insert(p); }
    if let Some(s) = inner.stems.iter_mut().find(|s| s.id == id) { s.audio = Arc::new(levelled); }
    Ok(info)
}

/// Undo "Level out": the stem's original audio comes back.
#[tauri::command]
fn restore_stem(state: State<'_, AppState>, id: String) -> CmdResult<StemInfo> {
    let mut inner = state.inner.lock().unwrap();
    let orig = inner.originals.remove(&id).ok_or("This stem is already original.")?;
    let s = inner.stems.iter_mut().find(|s| s.id == id).ok_or("That stem is gone.")?;
    s.audio = orig;
    Ok(StemInfo { id: s.id.clone(), label: s.label.clone(), kind: "stem", leaf: true, peaks: audio::peaks(&s.audio, PEAK_COLS) })
}

/// A recording made in Studio: mono float samples (raw body) at `x-rate`, placed at song sample
/// `x-offset`. Becomes a new lane, "Recording N".
#[tauri::command]
fn add_recording(state: State<'_, AppState>, request: tauri::ipc::Request<'_>) -> CmdResult<StemInfo> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else { return Err("expected raw audio".into()) };
    let header = |k: &str| request.headers().get(k).and_then(|v| v.to_str().ok()).and_then(|v| v.parse::<i64>().ok());
    let offset = header("x-offset").unwrap_or(0);
    let rate = header("x-rate").unwrap_or(SR as i64) as u32;
    let mut samples: Vec<f32> = bytes.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect();
    if rate != SR && rate >= 8000 && !samples.is_empty() {
        samples = audio::resample(&[samples.clone(), samples], rate, SR).map_err(err)?[0].clone();
    }
    let mut inner = state.inner.lock().unwrap();
    let len = inner.source.as_ref().map(|s| s.mix[0].len()).ok_or("Import a song first.")?;
    let mut ch = vec![0f32; len];
    for (i, v) in samples.iter().enumerate() {
        let d = offset + i as i64;
        if d >= 0 && (d as usize) < len { ch[d as usize] = *v; }
    }
    let mut k = 1;
    while inner.stems.iter().any(|s| s.id == format!("rec_{k}")) { k += 1; }
    let (id, label) = (format!("rec_{k}"), format!("Recording {k}"));
    let audio: Stereo = [ch.clone(), ch];
    let info = StemInfo { id: id.clone(), label: label.clone(), kind: "lane", leaf: true, peaks: audio::peaks(&audio, PEAK_COLS) };
    inner.stems.push(StemData { id, label, audio: Arc::new(audio) });
    Ok(info)
}


/// Sing in your own range: re-pitch every separated stem by `semitones` (formants kept for vocals),
/// always from the untouched originals so steps never accumulate. 0 restores the originals exactly.
#[tauri::command]
async fn sing_transpose(app: AppHandle, state: State<'_, AppState>, semitones: i32) -> CmdResult<Vec<StemInfo>> {
    let _guard = claim(&state)?;
    let semitones = semitones.clamp(-12, 12);
    let work: Vec<(String, String, Arc<Stereo>, bool)> = {
        let mut inner = state.inner.lock().unwrap();
        let ids: Vec<(String, String, Arc<Stereo>)> = inner.stems.iter()
            .filter(|s| !(s.id.starts_with("take") || s.id.starts_with("rec_") || s.id.starts_with("lane_")))
            .map(|s| (s.id.clone(), s.label.clone(), s.audio.clone())).collect();
        ids.into_iter().map(|(id, label, audio)| {
            let orig = inner.key_originals.entry(id.clone()).or_insert(audio).clone();
            let vocal = ["vocal", "lead", "backing"].iter().any(|v| id.contains(v));
            (id, label, orig, vocal)
        }).collect()
    };
    let total = work.len().max(1);
    let done = std::sync::atomic::AtomicUsize::new(0);
    let app2 = app.clone();
    let results: Vec<(String, String, Arc<Stereo>)> = tauri::async_runtime::spawn_blocking(move || {
        std::thread::scope(|sc| {
            let handles: Vec<_> = work.iter().map(|(id, label, audio, vocal)| {
                let (done, app) = (&done, &app2);
                sc.spawn(move || {
                    let out = if semitones == 0 { audio.clone() } else {
                        let n = audio[0].len();
                        let mut w = contour_engine::stretch::warp_with(audio, &[(0, 0), (n, n)], semitones as f32, *vocal);
                        for c in 0..2 { w[c].resize(n, 0.0); }
                        Arc::new(w)
                    };
                    let k = done.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
                    let _ = app.emit("progress", Progress { fraction: k as f32 / total as f32, stage: "Changing key".into(), detail: format!("{k} of {total}") });
                    (id.clone(), label.clone(), out)
                })
            }).collect();
            handles.into_iter().map(|h| h.join().expect("transpose thread")).collect()
        })
    }).await.map_err(err)?;
    let mut inner = state.inner.lock().unwrap();
    let mut infos = Vec::new();
    for (id, label, audio) in results {
        infos.push(StemInfo { id: id.clone(), label, kind: "stem", leaf: true, peaks: audio::peaks(&audio, PEAK_COLS) });
        if let Some(s) = inner.stems.iter_mut().find(|s| s.id == id) { s.audio = audio; }
    }
    if semitones == 0 { inner.key_originals.clear(); }
    Ok(infos)
}


#[derive(Serialize)]
struct SyncResult {
    stem: StemInfo,
    /// How many hits were moved onto the beat (0: it was already in time).
    moved: usize,
}

/// "Sync to beat": pull a lane's hits onto the song's beat grid. The original is kept for
/// `restore_stem`.
#[tauri::command]
async fn sync_stem(state: State<'_, AppState>, id: String) -> CmdResult<SyncResult> {
    let (audio, label, mix, cached) = {
        let inner = state.inner.lock().unwrap();
        let s = inner.stems.iter().find(|s| s.id == id).ok_or("That stem is gone.")?;
        let src = inner.source.as_ref().ok_or("Import a song first.")?;
        let key = Arc::as_ptr(&src.mix) as usize;
        let cached = inner.song_beats.as_ref().filter(|(k, _)| *k == key).map(|(_, b)| b.clone());
        (s.audio.clone(), s.label.clone(), src.mix.clone(), cached)
    };
    let key = Arc::as_ptr(&mix) as usize;
    let (synced, moved, beats) = tauri::async_runtime::spawn_blocking(move || {
        let beats = cached.unwrap_or_else(|| Arc::new(contour_engine::analysis::rhythm(&mix, None).1));
        let (out, moved) = contour_engine::sync::sync_to_beats(&audio, &beats);
        (out, moved, beats)
    })
    .await
    .map_err(err)?;
    let info = StemInfo { id: id.clone(), label, kind: "stem", leaf: true, peaks: audio::peaks(&synced, PEAK_COLS) };
    let mut inner = state.inner.lock().unwrap();
    inner.song_beats = Some((key, beats));
    if moved > 0 {
        let prev = inner.stems.iter().find(|s| s.id == id).map(|s| s.audio.clone());
        if let Some(p) = prev { inner.originals.entry(id.clone()).or_insert(p); }
        if let Some(s) = inner.stems.iter_mut().find(|s| s.id == id) { s.audio = Arc::new(synced); }
    }
    Ok(SyncResult { stem: info, moved })
}

// ───────────────────────────── first-run setup ─────────────────────────────

/// Models installed during setup so every Simple-mode option and the flagship work offline.
const CORE_MODELS: &[&str] = &["voc_ft", "mel_roformer", "htdemucs", "htdemucs_6s", "kara_2"];

#[tauri::command]
fn core_models(state: State<'_, AppState>) -> Vec<ModelInfo> {
    CORE_MODELS
        .iter()
        .filter_map(|id| models::spec(id).ok())
        .map(|m| ModelInfo { id: m.id, label: m.label, role: m.role, size: m.size, present: models::is_present(&state.models_dir, m) })
        .collect()
}

/// One-time optimisation of the HT-Demucs models for this computer (cached next to the models),
/// so the first 4- or 6-stem separation starts immediately.
#[tauri::command]
async fn models_prepare(app: AppHandle, state: State<'_, AppState>) -> CmdResult<()> {
    let _guard = claim(&state)?;
    let dir = state.models_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let heavy: Vec<_> = ["htdemucs", "htdemucs_6s"].iter().filter_map(|id| models::spec(id).ok()).filter(|m| models::is_present(&dir, m)).collect();
        for (i, m) in heavy.iter().enumerate() {
            let _ = app.emit("progress", Progress { fraction: i as f32 / heavy.len().max(1) as f32, stage: "Optimising for this computer".into(), detail: m.label.to_string() });
            let _ = runtime::load_heavy(&models::path(&dir, m), Device::Cpu);
        }
        let _ = app.emit("progress", Progress { fraction: 1.0, stage: "Ready".into(), detail: String::new() });
    })
    .await
    .map_err(err)
}

#[tauri::command]
fn exit_app(app: AppHandle) {
    app.exit(0);
}

// ───────────────────────────── separation ─────────────────────────────

#[derive(Serialize)]
struct StemInfo {
    id: String,
    label: String,
    kind: &'static str,
    leaf: bool,
    peaks: Vec<f32>,
}

#[derive(Serialize)]
struct SeparationResult {
    stems: Vec<StemInfo>,
    backend: String,
    seconds: f64,
    /// Why the GPU wasn't used (or stopped being used). Empty when the first choice worked.
    notes: Vec<String>,
}

#[tauri::command]
async fn separate(app: AppHandle, state: State<'_, AppState>, request: Request, device: Device, region: Option<[f64; 2]>) -> CmdResult<SeparationResult> {
    let _guard = claim(&state)?;
    let (mix, engine) = {
        let mut inner = state.inner.lock().unwrap();
        let mix = inner.source.as_ref().map(|s| s.mix.clone()).ok_or("Import a song first.")?;
        // Publish replacement stems only after successful processing. Keep the last
        // result available to PCM/export after failure or cancellation.
        let engine = match inner.engine.take() {
            Some(e) if e.requested == device => e,
            _ => Engine::new(state.models_dir.clone(), device),
        };
        (mix, engine)
    };
    let cancel = state.cancel.clone();
    let emitter = app.clone();
    let started = std::time::Instant::now();
    let completed_request = request.clone();
    let units = request.cost_units();

    // Only the loop region: separate that slice, then pad the stems back to full length so the
    // timeline stays aligned (outside the region the stems are silent).
    let total_len = mix[0].len();
    let range = region.map(|[a, b]| {
        let (a, b) = (a.min(b).max(0.0), a.max(b));
        let s = ((a * SR as f64) as usize).min(total_len);
        let e = ((b * SR as f64) as usize).clamp(s, total_len);
        (s, e)
    }).filter(|(s, e)| e - s > SR as usize / 10);

    let (engine, result, compute_secs, audio_secs) = tauri::async_runtime::spawn_blocking(move || {
        let mut engine = engine;
        let report = move |p: Progress| {
            let _ = emitter.emit("progress", p);
        };
        let input: Stereo = match range {
            Some((s, e)) => [mix[0][s..e].to_vec(), mix[1][s..e].to_vec()],
            None => (*mix).clone(),
        };
        let audio_secs = input[0].len() as f64 / SR as f64;
        let mut compute = 0.0;
        let res = engine.ensure_models(&request, &report, &cancel).and_then(|_| {
            let t = std::time::Instant::now();
            let out = engine.separate(&input, &request, &report, &cancel);
            compute = t.elapsed().as_secs_f64();
            out
        });
        let res = res.map(|stems| match range {
            None => stems,
            Some((s, _)) => stems
                .into_iter()
                .map(|mut st| {
                    st.audio = [0, 1].map(|c| {
                        let mut full = vec![0.0f32; total_len];
                        let part = &st.audio[c];
                        full[s..s + part.len()].copy_from_slice(part);
                        full
                    });
                    st
                })
                .collect(),
        });
        (engine, res, compute, audio_secs)
    })
    .await
    .map_err(err)?;

    let backend = engine.backend.clone();
    let notes = engine.notes.clone();
    // Learn this machine's speed for future estimates (only from runs that stayed on the requested processor).
    if result.is_ok() && audio_secs > 1.0 && units > 0.0 && (engine.device == device) {
        let mut perf = perf_load(&state);
        let measured = compute_secs / (units * audio_secs);
        let key = device_key(device);
        let next = perf.get(&key).map(|old| old * 0.4 + measured * 0.6).unwrap_or(measured);
        perf.insert(key, next);
        if let Ok(text) = serde_json::to_string(&perf) {
            let _ = std::fs::write(perf_path(&state), text);
        }
    }
    let mut inner = state.inner.lock().unwrap();
    inner.engine = Some(engine);
    let stems = result.map_err(friendly)?;
    if state.cancel.load(Ordering::SeqCst) { return Err("cancelled".into()); }
    let infos = stems
        .iter()
        .map(|s| StemInfo { id: s.id.clone(), label: s.label.clone(), kind: s.kind, leaf: s.leaf, peaks: audio::peaks(&s.audio, PEAK_COLS) })
        .collect();
    inner.stems = stems.into_iter().map(|s| StemData { id: s.id, label: s.label, audio: Arc::new(s.audio) }).collect();
    inner.mashup = Mashup::default();
    inner.last_request = None;
    inner.last_request = if region.is_none() { Some(completed_request) } else { None };
    Ok(SeparationResult { stems: infos, backend, seconds: started.elapsed().as_secs_f64(), notes })
}

#[tauri::command]
fn cancel(state: State<'_, AppState>) {
    state.cancel.store(true, Ordering::SeqCst);
}

// ───────────────────────────── export ─────────────────────────────

fn sanitize(s: &str) -> String {
    s.chars().map(|c| if c.is_alphanumeric() || " ._-()·&".contains(c) { c } else { '_' }).collect::<String>().trim().to_string()
}

/// A file name that isn't taken yet — `Song - Vocals.wav`, then `Song - Vocals (2).wav`, … — so an
/// export never silently overwrites an earlier one.
fn available_path(p: PathBuf) -> PathBuf {
    if !p.exists() {
        return p;
    }
    let stem = p.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let ext = p.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
    (2..10_000).map(|k| p.with_file_name(format!("{stem} ({k}){ext}"))).find(|c| !c.exists()).unwrap_or(p)
}

#[tauri::command]
async fn export(
    app: AppHandle,
    state: State<'_, AppState>,
    ids: Vec<String>,
    dir: String,
    format: Format,
    rate: Option<u32>,
    protect: bool,
    start: Option<f64>,
    end: Option<f64>,
    envelopes: Option<std::collections::HashMap<String, Envelope>>,
    clips: Option<std::collections::HashMap<String, Vec<Clip>>>,
    labels: Option<std::collections::HashMap<String, String>>,
    fx: Option<std::collections::HashMap<String, contour_engine::fx::FxParams>>,
) -> CmdResult<Vec<String>> {
    let _guard = claim(&state)?;
    let (jobs, source_rate, base) = {
        let inner = state.inner.lock().unwrap();
        let src = inner.source.as_ref().ok_or("Import a song first.")?;
        let base = src.path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| src.name.clone());
        let envelopes = envelopes.unwrap_or_default();
        let clips = clips.unwrap_or_default();
        let labels = labels.unwrap_or_default();
        let fx = fx.unwrap_or_default();
        let jobs: Vec<(String, Arc<Stereo>, Envelope, contour_engine::fx::FxParams)> = ids
            .iter()
            .filter_map(|id| {
                let env = envelopes.get(id).cloned().unwrap_or_default();
                let edited = |a: Arc<Stereo>| match clips.get(id) {
                    Some(c) if !c.is_empty() => Arc::new(apply_clips(&a, c)),
                    _ => a,
                };
                if id == "original" {
                    Some(("Original".to_string(), edited(src.mix.clone()), env, fx.get(id).copied().unwrap_or_default()))
                } else {
                    inner.stems.iter().find(|s| &s.id == id).map(|s| (labels.get(id).cloned().filter(|l| !l.trim().is_empty()).unwrap_or_else(|| s.label.clone()), edited(s.audio.clone()), env, fx.get(id).copied().unwrap_or_default()))
                }
            })
            .collect();
        (jobs, src.rate, base)
    };
    if jobs.is_empty() {
        return Err("Choose at least one stem to export.".into());
    }
    let cancel = state.cancel.clone();
    let out_dir = PathBuf::from(dir).join(sanitize(&format!("{base} — stems")));
    tauri::async_runtime::spawn_blocking(move || -> anyhow::Result<Vec<String>> {
        let rate = rate.unwrap_or(source_rate);
        let total = jobs.len();
        let mut written = vec![];
        for (i, (label, audio, envelope, stem_fx)) in jobs.into_iter().enumerate() {
            if cancel.load(Ordering::SeqCst) {
                return Err(contour_engine::Cancelled.into());
            }
            let _ = app.emit("progress", Progress { fraction: i as f32 / total as f32, stage: format!("Exporting {label}"), detail: format!("{} of {}", i + 1, total) });
            let shaped = {
                let mut full: Stereo = [audio[0].clone(), audio[1].clone()];
                if !envelope.is_empty() { apply_envelope(&mut full, &envelope); }
                let mut full = contour_engine::fx::process_stem(&full, &stem_fx);
                let send = stem_fx.send();
                if send > 0.0 {
                    let wet = contour_engine::fx::reverb(&contour_engine::scale(&full, send));
                    for c in 0..2 { for (m, w) in full[c].iter_mut().zip(&wet[c]) { *m += w; } }
                }
                slice(&full, start, end)
            };
            let mut out = audio::resample(&shaped, SR, rate)?;
            if protect {
                let p = contour_engine::peak(&out);
                if p > 0.891_250_9 {
                    out = contour_engine::scale(&out, 0.891_250_9 / p);
                }
            }
            let path = available_path(out_dir.join(sanitize(&format!("{base} - {label}.{}", format.extension()))));
            audio::write(&path, &out, rate, format)?;
            written.push(path.display().to_string());
        }
        let _ = app.emit("progress", Progress { fraction: 1.0, stage: "Export complete".into(), detail: String::new() });
        Ok(written)
    })
    .await
    .map_err(err)?
    .map_err(friendly)
}

/// A volume curve: `[seconds, linear gain]` points, linear between points, held before the first
/// and after the last. Empty means unity gain.
type Envelope = Vec<[f64; 2]>;

/// A Studio clip: `[timeline start, source start, source end, gain, fade in, fade out]`, in seconds
/// (gain linear). A track's clips point into its original audio, so edits are non-destructive.
type Clip = [f64; 6];

/// Render a track's clips onto a timeline as long as the song: each clip copies its source range to
/// its timeline position with its gain and linear fades. Overlapping clips add up — that is how
/// crossfades work: where two clips meet, one fades out while the other fades in over the overlap.
fn apply_clips(audio: &Stereo, clips: &[Clip]) -> Stereo {
    let n = audio[0].len();
    let mut out: Stereo = [vec![0.0; n], vec![0.0; n]];
    let sr = SR as f64;
    for c in clips {
        let [pos, s0, s1, gain, fin, fout] = *c;
        if !(pos.is_finite() && s0.is_finite() && s1.is_finite()) || s1 <= s0 {
            continue;
        }
        let len = s1 - s0;
        let (p0, src0, frames) = ((pos * sr).round() as i64, (s0 * sr).round() as i64, (len * sr).round() as i64);
        let (fin_f, fout_f) = ((fin.max(0.0) * sr) as i64, (fout.max(0.0) * sr) as i64);
        for k in 0..frames {
            let (d, sidx) = (p0 + k, src0 + k);
            if d < 0 || d as usize >= n || sidx < 0 || sidx as usize >= n {
                continue;
            }
            let mut g = gain;
            if fin_f > 0 && k < fin_f {
                g *= k as f64 / fin_f as f64;
            }
            if fout_f > 0 && frames - k <= fout_f {
                g *= (frames - k) as f64 / fout_f as f64;
            }
            let g = g as f32;
            out[0][d as usize] += audio[0][sidx as usize] * g;
            out[1][d as usize] += audio[1][sidx as usize] * g;
        }
    }
    out
}

/// Multiply 44.1 kHz audio by a volume curve, in place.
fn apply_envelope(audio: &mut Stereo, env: &[[f64; 2]]) {
    let mut pts: Vec<[f64; 2]> = env.iter().copied().filter(|p| p[0].is_finite() && p[1].is_finite()).collect();
    if pts.is_empty() {
        return;
    }
    pts.sort_by(|a, b| a[0].total_cmp(&b[0]));
    let mut k = 0usize;
    for i in 0..audio[0].len() {
        let t = i as f64 / SR as f64;
        while k + 1 < pts.len() && pts[k + 1][0] <= t {
            k += 1;
        }
        let g = if t <= pts[0][0] {
            pts[0][1]
        } else if k + 1 >= pts.len() {
            pts[pts.len() - 1][1]
        } else {
            let (a, b) = (pts[k], pts[k + 1]);
            a[1] + (b[1] - a[1]) * ((t - a[0]) / (b[0] - a[0]).max(1e-9))
        } as f32;
        audio[0][i] *= g;
        audio[1][i] *= g;
    }
}

/// Cut `[start, end)` seconds out of 44.1 kHz audio (the whole thing when both are `None`).
fn slice(audio: &Stereo, start: Option<f64>, end: Option<f64>) -> Stereo {
    let n = audio[0].len();
    let a = start.map(|s| (s.max(0.0) * SR as f64) as usize).unwrap_or(0).min(n);
    let b = end.map(|e| (e.max(0.0) * SR as f64) as usize).unwrap_or(n).clamp(a, n);
    [audio[0][a..b].to_vec(), audio[1][a..b].to_vec()]
}

#[derive(serde::Deserialize)]
struct MixPart {
    id: String,
    gain: f32,
    /// −1 (left) … +1 (right), constant-power.
    pan: f32,
    /// Volume curve for this track.
    #[serde(default)]
    envelope: Envelope,
    /// Studio clips for this track (empty: the whole track, unedited).
    #[serde(default)]
    clips: Vec<Clip>,
    /// The Sound drawer: Warmth, Clarity, Punch, Width and the reverb send.
    #[serde(default)]
    fx: Option<contour_engine::fx::FxParams>,
}

/// Render the mixer's current balance (levels, pans, mutes) to a single stereo file.
#[tauri::command]
async fn export_mix(
    app: AppHandle,
    state: State<'_, AppState>,
    parts: Vec<MixPart>,
    name: String,
    dir: String,
    format: Format,
    rate: Option<u32>,
    protect: bool,
    start: Option<f64>,
    end: Option<f64>,
) -> CmdResult<String> {
    let _guard = claim(&state)?;
    let (tracks, source_rate, base) = {
        let inner = state.inner.lock().unwrap();
        let src = inner.source.as_ref().ok_or("Import a song first.")?;
        let base = src.path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| src.name.clone());
        let tracks: Vec<(Arc<Stereo>, f32, f32, Envelope, contour_engine::fx::FxParams)> = parts
            .iter()
            .filter(|p| p.gain > 0.0)
            .filter_map(|p| {
                let audio = if p.id == "original" {
                    Some(src.mix.clone())
                } else {
                    inner.stems.iter().find(|s| s.id == p.id).map(|s| s.audio.clone())
                };
                audio.map(|a| (if p.clips.is_empty() { a } else { Arc::new(apply_clips(&a, &p.clips)) }, p.gain, p.pan.clamp(-1.0, 1.0), p.envelope.clone(), p.fx.unwrap_or_default()))
            })
            .collect();
        (tracks, src.rate, base)
    };
    if tracks.is_empty() {
        return Err("Nothing is audible in the mix — unmute at least one track.".into());
    }
    let out_dir = PathBuf::from(dir).join(sanitize(&format!("{base} — stems")));
    tauri::async_runtime::spawn_blocking(move || -> anyhow::Result<String> {
        let _ = app.emit("progress", Progress { fraction: 0.2, stage: "Bouncing mix".into(), detail: String::new() });
        let n = tracks[0].0[0].len();
        let mut mix: Stereo = [vec![0.0; n], vec![0.0; n]];
        let mut sends: Stereo = [vec![0.0; n], vec![0.0; n]];
        let mut any_send = false;
        for (audio, gain, pan, envelope, fx) in &tracks {
            let angle = (pan + 1.0) * std::f32::consts::FRAC_PI_4;
            let (gl, gr) = (angle.cos() * std::f32::consts::SQRT_2 * gain, angle.sin() * std::f32::consts::SQRT_2 * gain);
            let mut src: Stereo = [audio[0].clone(), audio[1].clone()];
            if !envelope.is_empty() { apply_envelope(&mut src, envelope); }
            // the same order as the live preview: curve → Sound drawer → level/pan → (post-fader) reverb send
            let src = contour_engine::fx::process_stem(&src, fx);
            let send = fx.send();
            any_send |= send > 0.0;
            for i in 0..n {
                let (l, r) = (src[0][i] * gl, src[1][i] * gr);
                mix[0][i] += l;
                mix[1][i] += r;
                if send > 0.0 { sends[0][i] += l * send; sends[1][i] += r * send; }
            }
        }
        if any_send {
            let wet = contour_engine::fx::reverb(&sends);
            for c in 0..2 { for (m, w) in mix[c].iter_mut().zip(&wet[c]) { *m += w; } }
        }
        // the safety limiter, exactly as heard in the preview (look-ahead removed)
        let mix = contour_engine::fx::limit(&mix, true);
        let rate = rate.unwrap_or(source_rate);
        let mut out = audio::resample(&slice(&mix, start, end), SR, rate)?;
        if protect {
            let p = contour_engine::peak(&out);
            if p > 0.891_250_9 {
                out = contour_engine::scale(&out, 0.891_250_9 / p);
            }
        }
        let path = available_path(out_dir.join(sanitize(&format!("{base} - {name}.{}", format.extension()))));
        audio::write(&path, &out, rate, format)?;
        let _ = app.emit("progress", Progress { fraction: 1.0, stage: "Mix bounced".into(), detail: String::new() });
        Ok(path.display().to_string())
    })
    .await
    .map_err(err)?
    .map_err(friendly)
}

// ───────────────────────────── models ─────────────────────────────

#[derive(Serialize)]
struct ModelInfo {
    id: &'static str,
    label: &'static str,
    role: &'static str,
    size: u64,
    present: bool,
}

#[tauri::command]
fn models_list(state: State<'_, AppState>) -> Vec<ModelInfo> {
    models::MODELS
        .iter()
        .map(|m| ModelInfo { id: m.id, label: m.label, role: m.role, size: m.size, present: models::is_present(&state.models_dir, m) })
        .collect()
}

#[tauri::command]
fn models_required(state: State<'_, AppState>, request: Request) -> Vec<ModelInfo> {
    request
        .required_models()
        .into_iter()
        .map(|m| ModelInfo { id: m.id, label: m.label, role: m.role, size: m.size, present: models::is_present(&state.models_dir, m) })
        .collect()
}

#[tauri::command]
async fn models_download(app: AppHandle, state: State<'_, AppState>, ids: Vec<String>) -> CmdResult<()> {
    let _guard = claim(&state)?;
    let dir = state.models_dir.clone();
    let cancel = state.cancel.clone();
    tauri::async_runtime::spawn_blocking(move || -> anyhow::Result<()> {
        for id in ids {
            let m = models::spec(&id)?;
            models::ensure(&dir, m, &mut |done, total| {
                if cancel.load(Ordering::SeqCst) {
                    return Err(contour_engine::Cancelled.into());
                }
                let _ = app.emit("progress", Progress {
                    fraction: done as f32 / total as f32,
                    stage: format!("Downloading {}", m.label),
                    detail: format!("{:.1} / {:.1} MB", done as f64 / 1e6, total as f64 / 1e6),
                });
                Ok(())
            })?;
        }
        Ok(())
    })
    .await
    .map_err(err)?
    .map_err(friendly)
}

#[tauri::command]
fn models_delete(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    if state.busy.load(Ordering::SeqCst) {
        return Err("Wait for the current task to finish.".into());
    }
    let m = models::spec(&id).map_err(err)?;
    if let Some(e) = state.inner.lock().unwrap().engine.as_mut() {
        e.unload();
    }
    let p = models::path(&state.models_dir, m);
    if p.exists() {
        std::fs::remove_file(p).map_err(err)?;
    }
    Ok(())
}

// ───────────────────────────── OS glass ─────────────────────────────

/// Which system material the window is using: "mica", "acrylic", "vibrancy", or "" (none).
struct Glass(&'static str);

/// Put real system glass behind the transparent window: Mica on Windows 11, Acrylic on
/// Windows 10, vibrancy on macOS. Linux has no system material and keeps an opaque window.
#[allow(unused_variables)]
fn apply_glass(window: &tauri::WebviewWindow) -> &'static str {
    #[cfg(target_os = "windows")]
    {
        let _ = window.set_shadow(true);
        if window_vibrancy::apply_mica(window, Some(true)).is_ok() {
            return "mica";
        }
        if window_vibrancy::apply_acrylic(window, Some((6, 12, 24, 170))).is_ok() {
            return "acrylic";
        }
    }
    #[cfg(target_os = "macos")]
    {
        use window_vibrancy::{NSVisualEffectMaterial, NSVisualEffectState};
        if window_vibrancy::apply_vibrancy(window, NSVisualEffectMaterial::UnderWindowBackground, Some(NSVisualEffectState::FollowsWindowActiveState), Some(10.0)).is_ok() {
            return "vibrancy";
        }
    }
    ""
}

#[tauri::command]
fn window_glass(glass: State<'_, Glass>) -> &'static str {
    glass.0
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_window_state::Builder::default().build()) // remembers size, position and maximised state
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let models_dir = app.path().app_data_dir().map(|d| d.join("models")).unwrap_or_else(|_| PathBuf::from("models"));
            app.manage(AppState {
                inner: Mutex::new(Inner::default()),
                cancel: Arc::new(AtomicBool::new(false)),
                busy: AtomicBool::new(false),
                models_dir,
            });
            let glass = app.get_webview_window("main").map(|w| apply_glass(&w)).unwrap_or("");
            app.manage(Glass(glass));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_info,
            pick_audio,
            pick_folder,
            reveal,
            load_audio,
            clear_audio,
            pcm,
            separate,
            cancel,
            export,
            export_mix,
            models_list,
            models_required,
            models_download,
            models_delete,
            window_glass,
            estimate,
            core_models,
            models_prepare,
            exit_app,
            pick_project_save,
            pick_project_open,
            save_project,
            open_project,
            models_storage,
            recovery_info,
            recovery_update,
            recovery_clear,
            mashup_use_current,
            mashup_load,
            mashup_swap,
            mashup_build,
            mashup_render,
            vocal_melody,
            add_take,
            tune_take,
            import_take,
            add_lane,
            remove_stem,
            transcribe_lyrics,
            cancel_lyrics,
            level_stem,
            sync_stem,
            restore_stem,
            add_recording,
            sing_transpose
        ])
        .run(tauri::generate_context!())
        .expect("error while running Contour");
}

#[cfg(test)]
mod clip_tests {
    use super::*;
    #[test]
    fn clips_move_trim_gain_and_fade() {
        let n = SR as usize * 4;
        let ramp: Vec<f32> = (0..n).map(|i| i as f32 / n as f32).collect();
        let a: Stereo = [ramp.clone(), ramp];
        let sr = SR as f64;
        // source 1–2 s placed at 2.5 s, half gain, 0.1 s fades
        let out = apply_clips(&a, &[[2.5, 1.0, 2.0, 0.5, 0.1, 0.1]]);
        let at = |t: f64| out[0][(t * sr) as usize];
        let src = |t: f64| a[0][(t * sr) as usize];
        assert_eq!(at(1.0), 0.0, "before the clip is silent");
        assert!((at(3.0) - 0.5 * src(1.5)).abs() < 1e-4, "middle carries source 1.5 s at half gain");
        assert!(at(2.5 + 0.05) < 0.5 * src(1.05) * 0.6, "fade-in is under way");
        assert_eq!(at(3.6), 0.0, "after the clip is silent");
        // a crossfade: A fades out over 1.0–1.2 s while B fades in over the same span; the sum stays level
        let flat: Stereo = [vec![0.5; n], vec![0.5; n]];
        let x = apply_clips(&flat, &[[0.0, 0.0, 1.2, 1.0, 0.0, 0.2], [1.0, 1.0, 3.0, 1.0, 0.2, 0.0]]);
        for t in [0.5, 1.05, 1.1, 1.15, 2.0] {
            let v = x[0][(t * sr) as usize];
            assert!((v - 0.5).abs() < 0.01, "level at {t}s is {v}, expected 0.5 through the crossfade");
        }
    }
}

#[cfg(test)]
mod project_tests {
    use super::*;

    fn tone(hz: f32, secs: f32, amp: f32) -> Stereo {
        let n = (secs * SR as f32) as usize;
        let v: Vec<f32> = (0..n).map(|i| amp * (2.0 * std::f32::consts::PI * hz * i as f32 / SR as f32).sin()).collect();
        [v.clone(), v]
    }
    fn temp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("contour-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }
    fn close(a: &Stereo, b: &Stereo, tol: f32) -> bool {
        a[0].len() == b[0].len() && a[0].iter().zip(&b[0]).all(|(x, y)| (x - y).abs() <= tol)
    }

    #[test]
    fn a_project_round_trips_including_loud_stems_and_duplicate_labels() {
        let dir = temp("roundtrip");
        let project = dir.join("My song.contour");
        let original = tone(220.0, 1.0, 0.5);
        let stems = vec![
            ("vocals".to_string(), "Vocals".to_string(), Arc::new(tone(440.0, 1.0, 0.3))),
            ("take".to_string(), "Your take".to_string(), Arc::new(tone(330.0, 1.0, 1.7))), // louder than 0 dBFS
            ("vocals_b".to_string(), "Vocals".to_string(), Arc::new(tone(550.0, 1.0, 0.2))), // same label as another stem
        ];
        let ui = serde_json::json!({ "tracks": [{ "id": "take", "mute": false, "clips": [{ "pos": 0.1 }] }], "mode": "studio" });
        write_project_files(&project, "My song", "/music/my song.mp3", 48000, &original, &stems, ui.clone(), &|_, _, _| {}).unwrap();
        let (file, mix, back) = read_project_files(&project, &|_, _, _| {}).unwrap();
        assert_eq!(file.name, "My song");
        assert_eq!(file.ui, ui, "interface state (mixer, clips, …) survives");
        assert!(close(&mix, &original, 1e-4), "original audio survives");
        assert_eq!(back.len(), 3);
        for ((id, label, a), (bid, blabel, b)) in stems.iter().zip(&back) {
            assert_eq!((id, label), (bid, blabel));
            assert!(close(a, b, 3e-4), "{id} audio survives (including above 0 dBFS)");
        }
        let names: std::collections::HashSet<_> = file.stems.iter().map(|s| s.file.to_lowercase()).collect();
        assert_eq!(names.len(), 3, "every stem has its own file: {:?}", file.stems.iter().map(|s| &s.file).collect::<Vec<_>>());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_missing_audio_file_is_reported_clearly() {
        let dir = temp("missing");
        let project = dir.join("Song.contour");
        let stems = vec![("vocals".to_string(), "Vocals".to_string(), Arc::new(tone(440.0, 0.5, 0.3)))];
        write_project_files(&project, "Song", "", 44100, &tone(220.0, 0.5, 0.3), &stems, serde_json::json!({}), &|_, _, _| {}).unwrap();
        std::fs::remove_file(audio_dir(&project).join("Vocals.flac")).unwrap();
        let e = read_project_files(&project, &|_, _, _| {}).err().expect("should fail").to_string();
        assert!(e.contains("Vocals.flac") && e.contains("missing or damaged"), "unclear error: {e}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn recovery_restores_the_newest_complete_copy() {
        let root = temp("recovery");
        let (current, next) = recovery_pick(&root);
        assert!(current.is_none() && next.ends_with("A.contour"), "empty: nothing to restore, first save goes to A");
        let save = |slot: &str, name: &str| {
            let stems = vec![("vocals".to_string(), "Vocals".to_string(), Arc::new(tone(440.0, 0.3, 0.3)))];
            write_project_files(&root.join(slot), name, "", 44100, &tone(220.0, 0.3, 0.3), &stems, serde_json::json!({}), &|_, _, _| {}).unwrap();
        };
        save("A.contour", "older");
        std::thread::sleep(std::time::Duration::from_millis(1100));
        save("B.contour", "newer");
        let (current, next) = recovery_pick(&root);
        assert_eq!(current.as_ref().map(|c| c.1.as_str()), Some("newer"));
        assert!(next.ends_with("A.contour"), "the next full save alternates to the other slot");
        // a half-written copy (audio missing) is never offered
        std::fs::remove_file(audio_dir(&root.join("B.contour")).join("Vocals.flac")).unwrap();
        let (current, _) = recovery_pick(&root);
        assert_eq!(current.map(|c| c.1), Some("older".to_string()), "falls back to the other complete copy");
        let _ = std::fs::remove_dir_all(&root);
    }
}

#[cfg(test)]
mod export_name_tests {
    use super::*;
    #[test]
    fn exports_never_overwrite() {
        let d = std::env::temp_dir().join(format!("contour-names-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        let p = d.join("Song - Vocals.wav");
        assert_eq!(available_path(p.clone()), p);
        std::fs::write(&p, b"x").unwrap();
        assert_eq!(available_path(p.clone()), d.join("Song - Vocals (2).wav"));
        std::fs::write(d.join("Song - Vocals (2).wav"), b"x").unwrap();
        assert_eq!(available_path(p.clone()), d.join("Song - Vocals (3).wav"));
        let _ = std::fs::remove_dir_all(&d);
    }
}
