//! Decoding (MP3, AAC/M4A, FLAC, ALAC, WAV, AIFF, OGG/Vorbis, MKV/WebM, CAF), resampling and
//! export (WAV 16/24/32-float, FLAC 16/24).

use crate::Stereo;
use anyhow::{anyhow, bail, Context, Result};
use rubato::{FftFixedIn, Resampler};
use std::path::Path;
use symphonia::core::{
    codecs::audio::AudioDecoderOptions,
    errors::Error as SymErr,
    formats::{probe::Hint, FormatOptions, TrackType},
    io::MediaSourceStream,
    meta::MetadataOptions,
};

pub struct Decoded {
    pub rate: u32,
    /// Channel count of the source file (audio is always returned as stereo).
    pub source_channels: usize,
    pub audio: Stereo,
}

impl Decoded {
    pub fn duration(&self) -> f64 {
        self.audio[0].len() as f64 / self.rate as f64
    }
}

pub fn decode(path: &Path) -> Result<Decoded> {
    let file = std::fs::File::open(path).with_context(|| format!("open {}", path.display()))?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }
    let mut format = symphonia::default::get_probe()
        .probe(&hint, mss, FormatOptions::default(), MetadataOptions::default())
        .map_err(|e| anyhow!("unsupported or damaged audio file: {e}"))?;
    let track = format.default_track(TrackType::Audio).ok_or_else(|| anyhow!("no audio track found"))?;
    let params = track
        .codec_params
        .as_ref()
        .and_then(|p| p.audio())
        .ok_or_else(|| anyhow!("no audio codec parameters"))?
        .clone();
    let track_id = track.id;
    let mut decoder = symphonia::default::get_codecs()
        .make_audio_decoder(&params, &AudioDecoderOptions::default())
        .map_err(|e| anyhow!("unsupported codec: {e}"))?;

    let mut rate = params.sample_rate.unwrap_or(0);
    let mut chans = params.channels.as_ref().map(|c| c.count()).unwrap_or(0);
    let mut interleaved: Vec<f32> = Vec::new();
    let mut scratch: Vec<f32> = Vec::new();
    loop {
        let packet = match format.next_packet() {
            Ok(Some(p)) => p,
            Ok(None) => break,
            Err(SymErr::ResetRequired) => break,
            Err(SymErr::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(e) => return Err(anyhow!("read error: {e}")),
        };
        if packet.track_id != track_id {
            continue;
        }
        match decoder.decode(&packet) {
            Ok(buf) => {
                let spec = buf.spec();
                rate = spec.rate();
                chans = spec.channels().count();
                scratch.resize(buf.samples_interleaved(), 0.0);
                buf.copy_to_slice_interleaved(&mut scratch);
                interleaved.extend_from_slice(&scratch);
            }
            Err(SymErr::DecodeError(_)) => continue,
            Err(e) => return Err(anyhow!("decode error: {e}")),
        }
    }
    if chans == 0 || rate == 0 || interleaved.is_empty() {
        bail!("the file contains no decodable audio");
    }
    let frames = interleaved.len() / chans;
    let audio: Stereo = if chans == 1 {
        let m: Vec<f32> = interleaved.clone();
        [m.clone(), m]
    } else {
        [0, 1].map(|c| (0..frames).map(|i| interleaved[i * chans + c]).collect())
    };
    Ok(Decoded { rate, source_channels: chans, audio })
}

/// High-quality FFT resampling. Output length is exactly `len * to / from` (rounded).
pub fn resample(audio: &Stereo, from: u32, to: u32) -> Result<Stereo> {
    if from == to {
        return Ok(audio.clone());
    }
    let n = audio[0].len();
    let want = ((n as u64 * to as u64 + from as u64 / 2) / from as u64) as usize;
    let chunk = 4096;
    let mut rs = FftFixedIn::<f32>::new(from as usize, to as usize, chunk, 2, 2).map_err(|e| anyhow!("{e}"))?;
    let delay = rs.output_delay();
    let mut out: Stereo = [Vec::with_capacity(want + delay), Vec::with_capacity(want + delay)];
    let mut pos = 0;
    while pos + chunk <= n {
        let r = rs.process(&[&audio[0][pos..pos + chunk], &audio[1][pos..pos + chunk]], None).map_err(|e| anyhow!("{e}"))?;
        out[0].extend_from_slice(&r[0]);
        out[1].extend_from_slice(&r[1]);
        pos += chunk;
    }
    if pos < n {
        let r = rs.process_partial(Some(&[&audio[0][pos..], &audio[1][pos..]]), None).map_err(|e| anyhow!("{e}"))?;
        out[0].extend_from_slice(&r[0]);
        out[1].extend_from_slice(&r[1]);
    }
    while out[0].len() < want + delay {
        let r = rs.process_partial::<&[f32]>(None, None).map_err(|e| anyhow!("{e}"))?;
        if r[0].is_empty() {
            break;
        }
        out[0].extend_from_slice(&r[0]);
        out[1].extend_from_slice(&r[1]);
    }
    Ok([0, 1].map(|c| {
        let mut v: Vec<f32> = out[c].iter().skip(delay).take(want).copied().collect();
        v.resize(want, 0.0);
        v
    }))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Format {
    Wav16,
    Wav24,
    Wav32f,
    Flac16,
    Flac24,
}

impl Format {
    pub fn parse(s: &str) -> Option<Format> {
        Some(match s {
            "wav16" => Format::Wav16,
            "wav24" | "wav" => Format::Wav24,
            "wav32f" => Format::Wav32f,
            "flac16" => Format::Flac16,
            "flac24" | "flac" => Format::Flac24,
            _ => return None,
        })
    }
    pub fn extension(self) -> &'static str {
        match self {
            Format::Flac16 | Format::Flac24 => "flac",
            _ => "wav",
        }
    }
}

/// Small, fast PRNG for TPDF dither.
struct Dither(u32);
impl Dither {
    fn next(&mut self) -> f32 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 17;
        self.0 ^= self.0 << 5;
        self.0 as f32 / u32::MAX as f32
    }
    fn tpdf(&mut self) -> f32 {
        self.next() - self.next()
    }
}

fn to_int(audio: &Stereo, bits: u32) -> Vec<i32> {
    let max = ((1i64 << (bits - 1)) - 1) as f32;
    let mut d = Dither(0x9E37_79B9);
    let n = audio[0].len();
    let mut out = Vec::with_capacity(n * 2);
    for i in 0..n {
        for c in 0..2 {
            let mut v = audio[c][i] * max;
            if bits == 16 {
                v += d.tpdf();
            }
            out.push(v.round().clamp(-max - 1.0, max) as i32);
        }
    }
    out
}

pub fn write(path: &Path, audio: &Stereo, rate: u32, format: Format) -> Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    match format {
        Format::Wav16 | Format::Wav24 | Format::Wav32f => {
            let (bits, float) = match format {
                Format::Wav16 => (16, false),
                Format::Wav24 => (24, false),
                _ => (32, true),
            };
            let spec = hound::WavSpec {
                channels: 2,
                sample_rate: rate,
                bits_per_sample: bits,
                sample_format: if float { hound::SampleFormat::Float } else { hound::SampleFormat::Int },
            };
            let mut w = hound::WavWriter::create(path, spec).with_context(|| format!("write {}", path.display()))?;
            if float {
                for i in 0..audio[0].len() {
                    w.write_sample(audio[0][i])?;
                    w.write_sample(audio[1][i])?;
                }
            } else {
                for s in to_int(audio, bits as u32) {
                    w.write_sample(s)?;
                }
            }
            w.finalize()?;
        }
        Format::Flac16 | Format::Flac24 => {
            use flacenc::component::BitRepr;
            use flacenc::error::Verify;
            let bits = if format == Format::Flac16 { 16 } else { 24 };
            let samples = to_int(audio, bits);
            let config = flacenc::config::Encoder::default().into_verified().map_err(|e| anyhow!("{e:?}"))?;
            let source = flacenc::source::MemSource::from_samples(&samples, 2, bits as usize, rate as usize);
            let stream = flacenc::encode_with_fixed_block_size(&config, source, config.block_size)
                .map_err(|e| anyhow!("flac encode: {e:?}"))?;
            let mut sink = flacenc::bitsink::ByteSink::new();
            stream.write(&mut sink).map_err(|e| anyhow!("flac write: {e:?}"))?;
            let mut bytes = sink.as_slice().to_vec();
            // The encoder records the short final block as the stream's minimum block size. The FLAC
            // spec says that field excludes the last block, and strict readers (including the one
            // Contour itself decodes with) reject the file otherwise. This stream uses one fixed block
            // size, so the minimum equals the maximum.
            if bytes.len() > 12 && &bytes[0..4] == b"fLaC" && bytes[4] & 0x7f == 0 {
                let (lo, hi) = bytes.split_at_mut(10);
                lo[8..10].copy_from_slice(&hi[0..2]);
            }
            std::fs::write(path, &bytes).with_context(|| format!("write {}", path.display()))?;
        }
    }
    Ok(())
}

/// Min/max-free peak envelope for waveform drawing: `cols` values in `0..=1`.
pub fn peaks(audio: &Stereo, cols: usize) -> Vec<f32> {
    let n = audio[0].len();
    (0..cols)
        .map(|i| {
            let a = i * n / cols;
            let b = ((i + 1) * n / cols).max(a + 1).min(n);
            let mut p = 0.0f32;
            for j in a..b {
                p = p.max(audio[0][j].abs()).max(audio[1][j].abs());
            }
            p.min(1.0)
        })
        .collect()
}

#[cfg(test)]
mod flac_roundtrip {
    use super::*;
    #[test]
    fn flac_written_by_contour_decodes_back() {
        for (fmt, secs) in [(Format::Flac24, 0.5f32), (Format::Flac16, 0.5), (Format::Flac24, 3.0)] {
            let n = (secs * 44100.0) as usize;
            let v: Vec<f32> = (0..n).map(|i| 0.4 * (2.0 * std::f32::consts::PI * 330.0 * i as f32 / 44100.0).sin()).collect();
            let p = std::env::temp_dir().join(format!("contour-flac-{:?}-{secs}.flac", fmt));
            write(&p, &[v.clone(), v.clone()], 44100, fmt).unwrap();
            let size = std::fs::metadata(&p).unwrap().len();
            let d = decode(&p);
            eprintln!("{fmt:?} {secs}s: {size} bytes → {}", match &d { Ok(x) => format!("decoded {} frames at {} Hz", x.audio[0].len(), x.rate), Err(e) => format!("ERROR {e:#}") });
            let d = d.unwrap();
            assert_eq!(d.audio[0].len(), n);
            let err = d.audio[0].iter().zip(&v).map(|(a, b)| (a - b).abs()).fold(0f32, f32::max);
            assert!(err < 1e-3, "max error {err}");
        }
    }
}
