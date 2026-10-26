//! `contour-cli` — command-line separation, batch processing, model management and benchmarking.

use anyhow::{bail, Context, Result};
use contour_engine::{audio, models, pipeline::*, runtime::Device, Stereo, SR};
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::time::Instant;

const HELP: &str = "contour-cli — on-device stem separation

USAGE:
  contour-cli separate <files or folders...> [options]
  contour-cli eval <dataset-dir> [options]      SDR benchmark (MUSDB-style folders: mixture.wav, vocals.wav, drums.wav, bass.wav, other.wav)
  contour-cli models [list | download <id|all>]

OPTIONS:
  -o, --out <dir>           output folder (default: next to each input)
  -q, --quality <q>         fast | balanced | max            (default: balanced)
      --lead-backing        split lead and backing vocals
      --stems <n>           2 (vocals/instrumental) | 4 | 6  (default: 2)
      --dereverb            remove reverb from the (lead) vocal
  -f, --format <f>          wav16 | wav24 | wav32f | flac16 | flac24  (default: wav24)
      --rate <r>            original | 44100 | 48000 | 96000  (default: original)
      --device <d>          auto | cpu | cuda | directml | coreml
      --models <dir>        model folder (default: $CONTOUR_MODELS or ~/.cache/contour/models)
      --recipe <json>       override the quality recipe (research)
";

struct Opts {
    inputs: Vec<PathBuf>,
    out: Option<PathBuf>,
    req: Request,
    format: audio::Format,
    rate: Option<u32>,
    device: Device,
    models: PathBuf,
}

fn default_models_dir() -> PathBuf {
    if let Ok(p) = std::env::var("CONTOUR_MODELS") {
        return PathBuf::from(p);
    }
    let home = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")).unwrap_or_else(|_| ".".into());
    PathBuf::from(home).join(".cache").join("contour").join("models")
}

fn parse(args: &[String]) -> Result<Opts> {
    let mut o = Opts {
        inputs: vec![],
        out: None,
        req: Request::default(),
        format: audio::Format::Wav24,
        rate: None,
        device: Device::Auto,
        models: default_models_dir(),
    };
    let mut i = 0;
    let val = |i: &mut usize| -> Result<String> {
        *i += 1;
        args.get(*i).cloned().context("missing value for option")
    };
    while i < args.len() {
        let a = args[i].as_str();
        match a {
            "-o" | "--out" => o.out = Some(val(&mut i)?.into()),
            "-q" | "--quality" => {
                o.req.quality = match val(&mut i)?.as_str() {
                    "fast" => Quality::Fast,
                    "balanced" => Quality::Balanced,
                    "max" => Quality::Max,
                    q => bail!("unknown quality '{q}'"),
                }
            }
            "--lead-backing" => o.req.lead_backing = true,
            "--dereverb" => o.req.dereverb = true,
            "--stems" => {
                o.req.instruments = match val(&mut i)?.as_str() {
                    "2" => Instruments::None,
                    "4" => Instruments::Four,
                    "6" => Instruments::Six,
                    s => bail!("--stems must be 2, 4 or 6 (got {s})"),
                }
            }
            "-f" | "--format" => {
                let v = val(&mut i)?;
                o.format = audio::Format::parse(&v).with_context(|| format!("unknown format '{v}'"))?
            }
            "--rate" => {
                let v = val(&mut i)?;
                o.rate = if v == "original" { None } else { Some(v.parse().context("bad --rate")?) }
            }
            "--device" => {
                let v = val(&mut i)?;
                o.device = Device::parse(&v).with_context(|| format!("unknown device '{v}'"))?
            }
            "--models" => o.models = val(&mut i)?.into(),
            "--recipe" => o.req.recipe = Some(serde_json::from_str(&val(&mut i)?).context("bad --recipe JSON")?),
            s if s.starts_with('-') => bail!("unknown option {s}\n\n{HELP}"),
            s => o.inputs.push(s.into()),
        }
        i += 1;
    }
    Ok(o)
}

fn reporter() -> impl Fn(Progress) + Sync {
    let last = std::sync::Mutex::new(String::new());
    move |p: Progress| {
        let line = format!("  [{:>3.0}%] {} · {}", p.fraction * 100.0, p.stage, p.detail);
        let mut l = last.lock().unwrap();
        if *l != line {
            eprint!("\r{line:<90}");
            *l = line;
        }
    }
}

fn collect_inputs(inputs: &[PathBuf]) -> Vec<PathBuf> {
    const EXT: &[&str] = &["wav", "mp3", "flac", "m4a", "aac", "ogg", "oga", "opus", "aif", "aiff", "alac", "mp4", "mkv", "webm", "caf"];
    let mut out = vec![];
    for p in inputs {
        if p.is_dir() {
            if let Ok(rd) = std::fs::read_dir(p) {
                let mut v: Vec<PathBuf> = rd
                    .flatten()
                    .map(|e| e.path())
                    .filter(|f| f.extension().and_then(|e| e.to_str()).map(|e| EXT.contains(&e.to_ascii_lowercase().as_str())).unwrap_or(false))
                    .collect();
                v.sort();
                out.extend(v);
            }
        } else {
            out.push(p.clone());
        }
    }
    out
}

fn separate_cmd(o: Opts) -> Result<()> {
    let files = collect_inputs(&o.inputs);
    if files.is_empty() {
        bail!("no input files\n\n{HELP}");
    }
    let cancel = AtomicBool::new(false);
    let report = reporter();
    let mut engine = Engine::new(o.models.clone(), o.device);
    engine.ensure_models(&o.req, &report, &cancel)?;
    for f in files {
        let t0 = Instant::now();
        eprintln!("\n▸ {}", f.display());
        let dec = audio::decode(&f)?;
        let mix = audio::resample(&dec.audio, dec.rate, SR)?;
        let stems = engine.separate(&mix, &o.req, &report, &cancel)?;
        let rate = o.rate.unwrap_or(dec.rate);
        let stem_name = f.file_stem().and_then(|s| s.to_str()).unwrap_or("song").to_string();
        let dir = o.out.clone().unwrap_or_else(|| f.parent().unwrap_or(Path::new(".")).to_path_buf()).join(format!("{stem_name} — stems"));
        for s in &stems {
            let audio = protect(audio::resample(&s.audio, SR, rate)?);
            let p = dir.join(format!("{stem_name} - {}.{}", s.label, o.format.extension()));
            audio::write(&p, &audio, rate, o.format)?;
        }
        eprintln!("\n  ✓ {} stems → {} ({:.1}s, {})", stems.len(), dir.display(), t0.elapsed().as_secs_f32(), engine.backend);
    }
    Ok(())
}

/// Keep sample peaks at or below −1 dBFS.
fn protect(a: Stereo) -> Stereo {
    let p = contour_engine::peak(&a);
    let ceiling = 0.891_250_9;
    if p > ceiling { contour_engine::scale(&a, ceiling / p) } else { a }
}

fn sdr(reference: &Stereo, estimate: &Stereo) -> f64 {
    let (mut num, mut den) = (1e-8f64, 1e-8f64);
    for c in 0..2 {
        for (r, e) in reference[c].iter().zip(&estimate[c]) {
            num += (*r as f64).powi(2);
            den += (*r as f64 - *e as f64).powi(2);
        }
    }
    10.0 * (num / den).log10()
}

fn eval_cmd(o: Opts) -> Result<()> {
    let root = o.inputs.first().context("eval needs a dataset folder")?;
    let mut tracks: Vec<PathBuf> = std::fs::read_dir(root)?.flatten().map(|e| e.path()).filter(|p| p.join("mixture.wav").exists()).collect();
    tracks.sort();
    let cancel = AtomicBool::new(false);
    let report = reporter();
    let mut engine = Engine::new(o.models.clone(), o.device);
    if std::env::var("CONTOUR_VIZ").is_ok() {
        // Debug: print each live-visualisation report.
        engine.viz = Some(std::sync::Arc::new(|c: contour_engine::VizChunk| {
            let layers: Vec<String> = c.layers.iter().map(|(n, v)| format!("{n}:{}bins/peak {:.2}", v.len(), v.iter().cloned().fold(0f32, f32::max))).collect();
            eprintln!("VIZ stage {} {} {:.2}-{:.2}s bin0 {} window {:?} [{}] spectrum {}", c.stage, c.parent, c.from, c.to, c.bin0, c.window.map(|(a, b)| (a as f32, b as f32)), layers.join(", "), c.spectrum.as_ref().map(|s| format!("{}x{}", s.bands, s.cols)).unwrap_or("-".into()));
        }));
    }
    engine.ensure_models(&o.req, &report, &cancel)?;
    let mut table: std::collections::BTreeMap<String, Vec<f64>> = Default::default();
    let t0 = Instant::now();
    for t in &tracks {
        let load = |n: &str| -> Result<Stereo> {
            let d = audio::decode(&t.join(format!("{n}.wav")))?;
            audio::resample(&d.audio, d.rate, SR)
        };
        let mix = load("mixture")?;
        let stems = engine.separate(&mix, &o.req, &report, &cancel)?;
        let refs: Vec<(&str, Stereo)> = ["vocals", "drums", "bass", "other"].iter().filter_map(|n| load(n).ok().map(|s| (*n, s))).collect();
        let get = |n: &str| refs.iter().find(|(k, _)| *k == n).map(|(_, s)| s.clone());
        let mut line = format!("\n{:<28}", t.file_name().unwrap().to_string_lossy());
        if let (Some(v), Some(st)) = (get("vocals"), stems.iter().find(|s| s.id == "vocals")) {
            let x = sdr(&v, &st.audio);
            table.entry("vocals".into()).or_default().push(x);
            line += &format!(" vocals {x:6.2}");
            let inst_ref = contour_engine::sub(&mix, &v);
            let inst = &stems.iter().find(|s| s.id == "instrumental").unwrap().audio;
            let y = sdr(&inst_ref, inst);
            table.entry("instrumental".into()).or_default().push(y);
            line += &format!("  instrumental {y:6.2}");
        }
        for n in ["drums", "bass", "other"] {
            if let (Some(rf), Some(st)) = (get(n), stems.iter().find(|s| s.id == n)) {
                let x = sdr(&rf, &st.audio);
                table.entry(n.into()).or_default().push(x);
                line += &format!("  {n} {x:6.2}");
            }
        }
        eprint!("{line}");
    }
    println!("\n\nMean SDR over {} tracks ({:.0}s, {}):", tracks.len(), t0.elapsed().as_secs_f32(), engine.backend);
    for (k, v) in &table {
        println!("  {k:<13} {:6.2} dB", v.iter().sum::<f64>() / v.len() as f64);
    }
    Ok(())
}

/// `contour-cli mashup <vocals song> <music song> [-o folder]`: vocals of the first over the music
/// of the second, in time and in key.
fn mashup_cmd(o: Opts) -> Result<()> {
    if o.inputs.len() != 2 {
        bail!("mashup needs two songs: the vocals song, then the music song");
    }
    let cancel = AtomicBool::new(false);
    let report = reporter();
    let mut engine = Engine::new(o.models.clone(), o.device);
    let req = Request { quality: o.req.quality, ..Request::default() };
    engine.ensure_models(&req, &report, &cancel)?;
    let mut parts = Vec::new();
    for f in &o.inputs {
        let d = audio::decode(f)?;
        let mix = audio::resample(&d.audio, d.rate, SR)?;
        let stems = engine.separate(&mix, &req, &report, &cancel)?;
        let get = |id: &str| stems.iter().find(|s| s.id == id).map(|s| s.audio.clone()).unwrap();
        let (v, i) = (get("vocals"), get("instrumental"));
        let a = contour_engine::analysis::analyse(&mix, Some(&v), Some(&i));
        eprintln!("\n  {}: {:.1} BPM, {}, vocal from {:.2}s, {} beats", f.display(), a.bpm, a.key_name(), a.vocal_start, a.beats.len());
        parts.push((mix, v, i, a));
    }
    let (_, va, _, aa) = &parts[0];
    let (_, _, ib, ab) = &parts[1];
    let (vocal, plan) = contour_engine::mashup::render(va, aa, ab, ib[0].len(), &contour_engine::mashup::MashupSettings::default());
    eprintln!("  plan: {}", serde_json::to_string(&plan)?);
    let mix: Stereo = [0, 1].map(|c| vocal[c].iter().zip(&ib[c]).map(|(a, b)| a + b).collect());
    let out = o.out.clone().unwrap_or_else(|| PathBuf::from(".")).join("mashup.wav");
    audio::write(&out, &mix, SR, audio::Format::Wav24)?;
    eprintln!("  wrote {}", out.display());
    Ok(())
}

/// `contour-cli lyrics vocals.wav [--models dir]`: transcribe a (separated) vocal with Whisper.
fn lyrics_cmd(o: Opts) -> Result<()> {
    for f in &o.inputs {
        let d = audio::decode(f)?;
        let a = audio::resample(&d.audio, d.rate, SR)?;
        let t = std::time::Instant::now();
        let ly = contour_engine::whisper::transcribe(&a, &o.models, None, &|_| {}, &|| false)?;
        eprintln!("{} [{}] {:.1}s", f.display(), ly.language, t.elapsed().as_secs_f32());
        for l in &ly.lines {
            let words: Vec<String> = l.words.iter().map(|w| format!("{}@{:.2}", w.text, w.start)).collect();
            eprintln!("   [{:5.2} → {:5.2}] {}   ({})", l.start, l.end, l.text, words.join(" "));
        }
    }
    Ok(())
}

/// `contour-cli fxcheck <dir>`: run a fixed test signal through every mixing effect and write the
/// results (raw f32, left then right) so the live-preview twin can be compared sample by sample.
fn fxcheck(dir: &str) -> Result<()> {
    use contour_engine::fx;
    let n = SR as usize * 2;
    let tw = |hz: f32, i: usize| (2.0 * std::f32::consts::PI * hz * i as f32 / SR as f32).sin();
    let sig: [Vec<f32>; 2] = [
        (0..n).map(|i| 0.4 * tw(220.0, i) + 0.2 * tw(3000.0, i) + if (44100..52920).contains(&i) { 1.6 * tw(150.0, i) } else { 0.0 }).collect(),
        (0..n).map(|i| 0.3 * tw(330.0, i) + 0.25 * tw(5000.0, i) + if (44100..52920).contains(&i) { 1.4 * tw(150.0, i) } else { 0.0 }).collect(),
    ];
    let write = |name: &str, a: &[Vec<f32>; 2]| -> Result<()> {
        let mut b = Vec::with_capacity(n * 8);
        for ch in a { for v in ch { b.extend_from_slice(&v.to_le_bytes()); } }
        std::fs::write(std::path::Path::new(dir).join(name), b)?;
        Ok(())
    };
    write("signal.f32", &sig)?;
    write("stem.f32", &fx::process_stem(&sig, &fx::FxParams { warmth: 0.6, clarity: 0.5, punch: 0.7, width: 0.8, space: 0.0 }))?;
    write("dark.f32", &fx::process_stem(&sig, &fx::FxParams { warmth: 0.2, clarity: -0.7, punch: 0.0, width: 0.3, space: 0.0 }))?;
    write("reverb.f32", &fx::reverb(&sig))?;
    write("limit.f32", &fx::limit(&sig, false))?;
    eprintln!("wrote fxcheck files to {dir}");
    Ok(())
}

fn models_cmd(o: Opts) -> Result<()> {
    let args: Vec<String> = o.inputs.iter().map(|p| p.to_string_lossy().into_owned()).collect();
    match args.first().map(|s| s.as_str()) {
        None | Some("list") => {
            println!("Model folder: {}\n", o.models.display());
            for m in models::MODELS {
                let mark = if models::is_present(&o.models, m) { "✓" } else { " " };
                println!("  {mark} {:<20} {:<26} {:>6.0} MB  {}", m.id, m.label, m.size as f64 / 1e6, m.role);
            }
        }
        Some("download") => {
            let which = args.get(1).context("download <id|all>")?;
            let list: Vec<_> = if which == "all" { models::MODELS.iter().collect() } else { vec![models::spec(which)?] };
            for m in list {
                eprint!("{} … ", m.label);
                models::ensure(&o.models, m, &mut |d, t| {
                    eprint!("\r{} … {:.0}%   ", m.label, d as f64 * 100.0 / t as f64);
                    Ok(())
                })?;
                eprintln!("\r{} ✓            ", m.label);
            }
        }
        Some(x) => bail!("unknown models command '{x}'"),
    }
    Ok(())
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let res = match args.first().map(|s| s.as_str()) {
        Some("separate") => parse(&args[1..]).and_then(separate_cmd),
        Some("eval") => parse(&args[1..]).and_then(eval_cmd),
        Some("models") => parse(&args[1..]).and_then(models_cmd),
        Some("mashup") => parse(&args[1..]).and_then(mashup_cmd),
        Some("lyrics") => parse(&args[1..]).and_then(lyrics_cmd),
        Some("windows") => (|| -> Result<()> { let d = audio::decode(std::path::Path::new(&args[1]))?; let a = audio::resample(&d.audio, d.rate, SR)?; let w = contour_engine::whisper::window_plan(&a)?; eprintln!("{} windows: {:?}", w.len(), w.iter().map(|(a, b)| format!("{a:.1}-{b:.1}")).collect::<Vec<_>>()); Ok(()) })(),
        Some("fxcheck") => fxcheck(args.get(1).map(String::as_str).unwrap_or(".")),
        _ => {
            print!("{HELP}");
            Ok(())
        }
    };
    if let Err(e) = res {
        eprintln!("\nerror: {e:#}");
        std::process::exit(1);
    }
}
