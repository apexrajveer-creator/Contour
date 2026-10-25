//! Model registry: pinned download URLs, SHA-256 hashes and architecture parameters.
//! Every file is pinned to a specific Hugging Face commit and verified after download.

use anyhow::{bail, Context, Result};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Primary {
    Vocals,
    Instrumental,
    Dry,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Arch {
    Mdx { n_fft: usize, dim_f: usize, dim_t: usize, compensate: f32, primary: Primary },
    Demucs { sources: &'static [&'static str] },
    /// Band-split / mel-band RoFormer: a spectrogram transformer fed the full-band STFT. Input and
    /// output are `[1, 4, dim_f, dim_t]` (L re, L im, R re, R im); the output is the primary stem.
    Roformer { n_fft: usize, hop: usize, dim_f: usize, dim_t: usize, input: &'static str, output: &'static str },
    /// A file of the Whisper lyrics model (encoder, decoder or tokenizer data), not a separation model.
    Whisper,
}

#[derive(Clone, Copy, Debug, Serialize)]
pub struct ModelSpec {
    pub id: &'static str,
    pub label: &'static str,
    pub role: &'static str,
    pub file: &'static str,
    pub url: &'static str,
    pub sha256: &'static str,
    pub size: u64,
    pub arch: Arch,
}

const FOUR: &[&str] = &["drums", "bass", "other", "vocals"];
const SIX: &[&str] = &["drums", "bass", "other", "vocals", "guitar", "piano"];

macro_rules! uvr {
    ($file:literal) => {
        concat!("https://huggingface.co/Blane187/all_public_uvr_models/resolve/fddec39677560e41e3194f24a9e4c4cd32ef0e83/", $file)
    };
}
macro_rules! ft {
    ($file:literal) => {
        concat!("https://huggingface.co/StemSplitio/htdemucs-ft-onnx/resolve/8616370ed541bc183dbe15fb0d54d5f49918f47e/", $file)
    };
}

pub const MODELS: &[ModelSpec] = &[
    ModelSpec {
        id: "voc_ft", label: "UVR-MDX-NET Voc FT", role: "Vocals",
        file: "UVR-MDX-NET-Voc_FT.onnx", url: uvr!("UVR-MDX-NET-Voc_FT.onnx"),
        sha256: "534b2070fcc7df514b13ef660dc8cbb328679c2374d04354a5c42bb14ecce111", size: 66_762_490,
        arch: Arch::Mdx { n_fft: 7680, dim_f: 3072, dim_t: 256, compensate: 1.021, primary: Primary::Vocals },
    },
    ModelSpec {
        id: "kim_vocal_2", label: "Kim Vocal 2", role: "Vocals",
        file: "Kim_Vocal_2.onnx", url: uvr!("Kim_Vocal_2.onnx"),
        sha256: "ce74ef3b6a6024ce44211a07be9cf8bc6d87728cc852a68ab34eb8e58cde9c8b", size: 66_759_214,
        arch: Arch::Mdx { n_fft: 7680, dim_f: 3072, dim_t: 256, compensate: 1.009, primary: Primary::Vocals },
    },
    ModelSpec {
        id: "mdx_main", label: "UVR-MDX-NET Main", role: "Vocals",
        file: "UVR_MDXNET_Main.onnx", url: uvr!("UVR_MDXNET_Main.onnx"),
        sha256: "8289784cda38543ff431add4070662813311a8cccfc0112ca82f76d9dba2b4ca", size: 66_759_214,
        arch: Arch::Mdx { n_fft: 7680, dim_f: 3072, dim_t: 256, compensate: 1.043, primary: Primary::Vocals },
    },
    ModelSpec {
        id: "inst_hq_3", label: "UVR-MDX-NET Inst HQ 3", role: "Instrumental",
        file: "UVR-MDX-NET-Inst_HQ_3.onnx", url: uvr!("UVR-MDX-NET-Inst_HQ_3.onnx"),
        sha256: "317554b07fe1ea5279a77f2b1520a41ea4b93432560c4ffd08792c30fddf9adc", size: 66_759_214,
        arch: Arch::Mdx { n_fft: 6144, dim_f: 3072, dim_t: 256, compensate: 1.022, primary: Primary::Instrumental },
    },
    ModelSpec {
        id: "kara_2", label: "UVR-MDX-NET Karaoke 2", role: "Lead / backing",
        file: "UVR_MDXNET_KARA_2.onnx", url: uvr!("UVR_MDXNET_KARA_2.onnx"),
        sha256: "bf32e15105a09c0f7dddd2b67346146334d6f3ecb399ed7638eba2ab07cbf5f4", size: 52_786_726,
        arch: Arch::Mdx { n_fft: 5120, dim_f: 2048, dim_t: 256, compensate: 1.065, primary: Primary::Instrumental },
    },
    ModelSpec {
        id: "reverb_hq", label: "Reverb HQ (FoxJoy)", role: "De-reverb",
        file: "Reverb_HQ_By_FoxJoy.onnx", url: uvr!("Reverb_HQ_By_FoxJoy.onnx"),
        sha256: "233bb5c6aaa365e568659a0a81211746fa881f8f47f82d9e864fce1f7692db80", size: 66_780_123,
        arch: Arch::Mdx { n_fft: 6144, dim_f: 3072, dim_t: 512, compensate: 1.0, primary: Primary::Dry },
    },
    ModelSpec {
        id: "mel_roformer", label: "Mel-Band RoFormer (Kim)", role: "Max quality vocals",
        file: "mel-roformer.fp16.onnx",
        url: "https://huggingface.co/phuongnse/mel-roformer-kim-onnx/resolve/9151f81ee8e4f7dd96598dbeeb1b186b939911be/mel-roformer.fp16.onnx",
        sha256: "adcbbb826f12453fbb86652b503242d565a9c81cdef1bca2fe0e54752eba91ef", size: 464_050_097,
        // Kimberley Jensen's vocals model (MIT), ONNX export by audiojs: n_fft 2048, hop 441, 8 s segments.
        arch: Arch::Roformer { n_fft: 2048, hop: 441, dim_f: 1025, dim_t: 801, input: "mix_spec", output: "stems_spec" },
    },
    // Lyrics: Whisper large-v3-turbo (MIT, OpenAI; ONNX export by onnx-community, pinned by commit).
    // The 4-bit weight-only encoder matches full precision on test speech; the 8-bit decoder too.
    ModelSpec {
        id: "whisper_encoder", label: "Whisper large-v3-turbo (encoder)", role: "Lyrics",
        file: "whisper-large-v3-turbo-encoder-q4.onnx", url: "https://huggingface.co/onnx-community/whisper-large-v3-turbo/resolve/360ebcde2559d60bb474678be3c1de9ef347d01a/onnx/encoder_model_q4.onnx",
        sha256: "7e64b20dd7b556cb7a2c1c65d9fbf31af985323c006f993d2a9dd10083547d78", size: 424_942_775, arch: Arch::Whisper,
    },
    ModelSpec {
        id: "whisper_decoder", label: "Whisper large-v3-turbo (decoder)", role: "Lyrics",
        file: "whisper-large-v3-turbo-decoder-int8.onnx", url: "https://huggingface.co/onnx-community/whisper-large-v3-turbo/resolve/360ebcde2559d60bb474678be3c1de9ef347d01a/onnx/decoder_model_merged_quantized.onnx",
        sha256: "61481bd3be3a445d5a4b9070e8f8b2c6cc4fbbbbdc9f0e7ed048a132b8b84e0d", size: 439_936_716, arch: Arch::Whisper,
    },
    ModelSpec {
        id: "whisper_vocab", label: "Whisper vocabulary", role: "Lyrics",
        file: "whisper-vocab.json", url: "https://huggingface.co/onnx-community/whisper-large-v3-turbo/resolve/360ebcde2559d60bb474678be3c1de9ef347d01a/vocab.json",
        sha256: "e2aa043ef015641d363d8288e7c241c85e36a5c761fb303598e0710233344387", size: 1_036_558, arch: Arch::Whisper,
    },
    ModelSpec {
        id: "whisper_added_tokens", label: "Whisper special tokens", role: "Lyrics",
        file: "whisper-added_tokens.json", url: "https://huggingface.co/onnx-community/whisper-large-v3-turbo/resolve/360ebcde2559d60bb474678be3c1de9ef347d01a/added_tokens.json",
        sha256: "3c51f66c4c21f9e126970078f11ae77a78c74aee8df606ee9daba86e467108e0", size: 34_648, arch: Arch::Whisper,
    },
    ModelSpec {
        id: "whisper_generation", label: "Whisper decoding settings", role: "Lyrics",
        file: "whisper-generation_config.json", url: "https://huggingface.co/onnx-community/whisper-large-v3-turbo/resolve/360ebcde2559d60bb474678be3c1de9ef347d01a/generation_config.json",
        sha256: "16f95291d2f47c944d3c2b19390bba7965666555c1ea2a0bdc850d1fab45612f", size: 3_897, arch: Arch::Whisper,
    },
    ModelSpec {
        id: "htdemucs", label: "HT-Demucs 4-stem", role: "Drums · bass · other",
        file: "htdemucs_fp16weights.onnx",
        url: "https://huggingface.co/StemSplitio/htdemucs-onnx/resolve/d54ed9eb60e258ea82131c6ee14578628816456a/htdemucs_fp16weights.onnx",
        sha256: "d05c269d0178d2a72ad484b10b11dd370193fc923201c3b27a99f848745db70a", size: 165_612_636,
        arch: Arch::Demucs { sources: FOUR },
    },
    ModelSpec {
        id: "htdemucs_6s", label: "HT-Demucs 6-stem", role: "Adds guitar · piano",
        file: "htdemucs_6s_fp16weights.onnx",
        url: "https://huggingface.co/StemSplitio/htdemucs-6s-onnx/resolve/49df9b6989cf2150840ea65b0bef77a2e471b678/htdemucs_6s_fp16weights.onnx",
        sha256: "7ce55792e2231c93fbf92de95f5fd5b3a5e6c89f7db690dfd693e8f1dce56869", size: 136_428_532,
        arch: Arch::Demucs { sources: SIX },
    },
    ModelSpec {
        id: "htdemucs_ft_drums", label: "HT-Demucs FT · drums", role: "Max-quality drums",
        file: "htdemucs_ft_drums_fp16weights.onnx", url: ft!("htdemucs_ft_drums_fp16weights.onnx"),
        sha256: "047764dff888cfb87da917013377d4ec7a134f7419cbe486d9c339aa17975ddd", size: 165_612_636,
        arch: Arch::Demucs { sources: FOUR },
    },
    ModelSpec {
        id: "htdemucs_ft_bass", label: "HT-Demucs FT · bass", role: "Max-quality bass",
        file: "htdemucs_ft_bass_fp16weights.onnx", url: ft!("htdemucs_ft_bass_fp16weights.onnx"),
        sha256: "b533037176b14b2df31c92a5d5b3d5660d0811b9b360d3db761964768b079961", size: 165_612_636,
        arch: Arch::Demucs { sources: FOUR },
    },
    ModelSpec {
        id: "htdemucs_ft_other", label: "HT-Demucs FT · other", role: "Max-quality other",
        file: "htdemucs_ft_other_fp16weights.onnx", url: ft!("htdemucs_ft_other_fp16weights.onnx"),
        sha256: "b739171a7057b3107bb0711c6222d4a619b41b13a8f04026431d30f32ad2bd71", size: 165_612_636,
        arch: Arch::Demucs { sources: FOUR },
    },
    ModelSpec {
        id: "htdemucs_ft_vocals", label: "HT-Demucs FT · vocals", role: "Vocal ensemble member",
        file: "htdemucs_ft_vocals_fp16weights.onnx", url: ft!("htdemucs_ft_vocals_fp16weights.onnx"),
        sha256: "0cbe651f535415c9d26a7bb614f7d322dd5a080fa0298f2e50f478030a994dce", size: 165_612_636,
        arch: Arch::Demucs { sources: FOUR },
    },
];


pub fn spec(id: &str) -> Result<&'static ModelSpec> {
    MODELS.iter().find(|m| m.id == id).with_context(|| format!("unknown model '{id}'"))
}

pub fn path(dir: &Path, m: &ModelSpec) -> PathBuf {
    dir.join(m.file)
}

/// Present on disk with the expected size (the hash is verified at download time).
pub fn is_present(dir: &Path, m: &ModelSpec) -> bool {
    std::fs::metadata(path(dir, m)).map(|md| md.len() == m.size).unwrap_or(false)
}

/// Download `m` into `dir` if needed, verifying size and SHA-256. `tick` receives bytes done / total.
pub fn ensure(dir: &Path, m: &ModelSpec, tick: &mut dyn FnMut(u64, u64) -> Result<()>) -> Result<PathBuf> {
    let dest = path(dir, m);
    if is_present(dir, m) {
        return Ok(dest);
    }
    std::fs::create_dir_all(dir).with_context(|| format!("create {}", dir.display()))?;
    let part = dir.join(format!("{}.part", m.file));
    let resp = ureq::get(m.url).call().with_context(|| format!("download {} failed — check your connection", m.label))?;
    let mut reader = resp.into_reader();
    let mut file = std::fs::File::create(&part)?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    let mut done = 0u64;
    loop {
        let k = reader.read(&mut buf)?;
        if k == 0 {
            break;
        }
        hasher.update(&buf[..k]);
        file.write_all(&buf[..k])?;
        done += k as u64;
        if done > m.size + 4096 {
            let _ = std::fs::remove_file(&part);
            bail!("{}: unexpected download size", m.label);
        }
        if let Err(e) = tick(done, m.size) {
            drop(file);
            let _ = std::fs::remove_file(&part);
            return Err(e);
        }
    }
    file.flush()?;
    drop(file);
    let hash = hex::encode(hasher.finalize());
    if done != m.size || hash != m.sha256 {
        let _ = std::fs::remove_file(&part);
        bail!("{} failed its integrity check (got {} bytes, sha256 {}) — please retry", m.label, done, hash);
    }
    std::fs::rename(&part, &dest)?;
    Ok(dest)
}
