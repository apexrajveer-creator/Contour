# Changelog

## 1.0.0: first release

**Separation**
- On-device stem separation with Mel-Band RoFormer (flagship), UVR-MDX-Net and HT-Demucs (4- and 6-stem); lead/backing vocals and de-reverb.
- GPU acceleration via DirectML (any DirectX 12 GPU) with automatic CPU fallback and recovery from GPU resets; optional CUDA build.
- Models download once, verified by SHA-256; the installer fetches the core set so the app works offline.

**Simple:** drop a song, pick a goal, switch stems on and off, export.

**Studio**
- Lanes with mute, solo, level, pan and volume curves; null test; loop from the ruler.
- Non-destructive clips: split, move, trim, fade, duplicate, copy and paste; automatic crossfades; box select; Alt-drag precision; snapping; undo and redo.
- The per-stem Sound drawer: presets, Level to +12 dB, Space, Warmth, Clarity, Punch and Width, heard live and rendered identically on export; Level out; a safety limiter.
- Recording onto new lanes; add any audio file as a lane; reorder, rename and resize lanes.

**Mashup:** beat-grid and key matching, four lanes (both vocals, both bands), fast re-renders.

**Sing**
- Lyrics transcribed on-device with Whisper large-v3-turbo, timed to the sung syllables, shown in an Apple Music style.
- Live pitch, gentle per-line scoring, grades and personal bests.
- Tune it (melody or key, natural to robotic, vibrato kept); import takes with automatic alignment; save your version.

**Everywhere**
- The new wave icon across Windows (taskbar, Start, installer), the app header and the setup screen.
- A three-column header: long song titles truncate cleanly and never touch the mode tabs; no default scrollbars anywhere.
- Projects with automatic recovery; exports never overwrite; a command palette (Ctrl+K); remembered settings and window position; taskbar progress; pause when headphones are unplugged.
- A layout audited from 980 × 640 to 1920 × 1080.
