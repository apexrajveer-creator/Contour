# Third-party notices

Contour's own code is MIT-licensed (see `LICENSE`). It includes or downloads the following
third-party components, which remain under their own licenses.

## Models (downloaded at runtime, pinned by URL and SHA-256 in `engine/src/models.rs`)

| Model | Source | License |
|---|---|---|
| UVR-MDX-Net Voc FT, Kim Vocal 2, Karaoke 2, Reverb HQ | Ultimate Vocal Remover project | MIT |
| HT-Demucs, HT-Demucs 6-stem | Meta AI Research (`facebookresearch/demucs`) | MIT |
| Mel-Band RoFormer (Kim), ONNX export | Kimberley Jensen et al.; ONNX by `phuongnse/mel-roformer-kim-onnx` | See the model card; confirm terms before commercial distribution |
| Whisper large-v3-turbo (4-bit encoder, 8-bit decoder), ONNX export | OpenAI; ONNX by `onnx-community/whisper-large-v3-turbo` | MIT |

## Bundled source

| Component | Location | License |
|---|---|---|
| Signalsmith Stretch, Signalsmith Linear | `engine/vendor/signalsmith/` | MIT (see the license files in that folder) |
| Bricolage Grotesque | `ui/fonts/` | SIL Open Font License 1.1 |

## Libraries (via Cargo and npm)

Notable dependencies include ONNX Runtime (MIT, via the `ort` crate), Tauri (MIT / Apache-2.0),
Symphonia (MPL-2.0: source available at https://github.com/pdeljanov/Symphonia, used unmodified),
rubato (MIT), realfft and rustfft (MIT / Apache-2.0), flacenc (Apache-2.0), serde (MIT / Apache-2.0)
and ureq (MIT / Apache-2.0).

For a complete, current list with license texts, run:

```bash
cargo install cargo-about && cargo about generate about.hbs > licenses.html
```
