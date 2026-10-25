> Developer notes: how Contour is built. For the user guide, see the main [README](../README.md).

> Product update: see [PRODUCT-POLISH.md](PRODUCT-POLISH.md) for changes 21–45, performance work, recovery/undo behavior and native verification limits. The earlier 1–20 changes are documented in [WORKFLOW-POLISH.md](WORKFLOW-POLISH.md).

# Contour — on-device stem separation

Contour separates songs into stems on your own computer. It can produce vocals and
instrumental; lead and backing vocals; dry vocals and vocal reverb; and drums, bass, guitar,
piano and other. It runs MDX-Net and HT-Demucs neural networks through ONNX Runtime on
your CPU or GPU, and **your audio never leaves the machine**.

This is the native successor to the single-file browser version. Moving to Tauri and Rust
removes the browser's limits:

| | Browser version | Contour desktop |
|---|---|---|
| Song length | 5 min / 100 MB | No limit |
| CPU threads | 1 | All cores |
| GPU | WebGPU (when available) | CUDA · DirectML · CoreML, with CPU fallback |
| Stems | 2 | Up to 8 (vocals, lead, backing, dry/reverb, drums, bass, guitar, piano, other) |
| Models | 1 per run | Cascades and ensembles of up to 12 models |
| Formats in | Whatever the browser decodes | MP3, AAC/M4A, ALAC, FLAC, WAV, AIFF, OGG, MKV/WebM, CAF |
| Formats out | WAV at 44.1 kHz | WAV 16/24/32f, FLAC 16/24, at the source rate, 44.1, 48 or 96 kHz |
| Mixer | A/B between 3 tracks | Mute, solo and level per stem, played in sync |
| Batch / automation | — | `contour-cli` with folder batch processing and an SDR benchmark |

## Frosted interface update

The interface uses the supplied PatternWaves silk shaders in a subtle navy background,
with frosted panels, buttons and custom dropdowns. The background runs locally without
React or OGL, caps rendering at 20 FPS, pauses while hidden and respects reduced motion.
A CSS background remains available when WebGL2 cannot initialize.

The results view reserves space for Save stems and playback controls at 100% zoom;
long stem lists scroll within their own region. The song title is centered on the window,
and the transparent title bar shares the continuous background.

The desktop window uses a custom title bar: drag the empty header to move the window,
double-click it to maximize or restore, or use its minimize, maximize and close buttons.
Window controls are disabled in the browser-only preview. Dropdowns support arrow keys,
Home/End, type-to-search, Enter and Escape. Scrollbars are hidden; wheel, trackpad and
keyboard scrolling remain available.

The shared motion layer adds interruptible mode crossfades, gliding segmented selections,
animated dropdown entry/exit, dialog and toast transitions, layout changes, and subtle
control feedback. Reduced-motion preferences disable movement. Playback clocks and audio
meters retain their direct updates.

Validation: JavaScript syntax, DOM checks and Chromium interaction checks passed for
mode changes, rapid reversals, dropdown keyboard/reopen behavior, modal dismissal,
synthetic separation results, reduced motion and 980/1180px layouts. The WebGL background
was visually checked; interaction checks used its CSS fallback to avoid software-GPU
bottlenecks. Native Windows window actions still require verification in a desktop build.

## Interface

- **Simple mode:** drop a song, pick *Remove vocals*, *Isolate vocals*, *Split into 4* or
  *Split into 6*, press **Separate**, switch parts on or off, and **Save stems**. The song is
  drawn as stacked strata, one coloured layer per stem.
- **Studio mode:** a timeline with a ruler, zoom (Ctrl + wheel), and a lane per stem in a
  collapsible tree. Each lane has mute, solo, level, pan and a live meter. You can also:
  - drag on the ruler to set a loop region; looping is sample-accurate;
  - run a **null test** (original minus the stems, so you hear only what the separation missed);
  - export only the loop region;
  - **bounce** exactly what you're hearing to one file.
- Opening `ui/index.html` in a normal browser runs the interface against a built-in
  synthetic engine (`ui/mock.js`), for design work without building the app.

The bundled typeface is Bricolage Grotesque (SIL Open Font License).

## Window

Contour uses real system glass behind its frameless, transparent window: Mica on Windows 11,
Acrylic on Windows 10 and vibrancy on macOS (via `window-vibrancy`). Linux has no system
material, so `src-tauri/tauri.linux.conf.json` keeps the window opaque there. The interface is
lit from one top-left key light, with a soft vignette and fine film grain.

## Performance

- **Presets are chosen from benchmarks.** Fast and Balanced drop passes that cost about 2× for
  under 0.1 dB. Max is a two-model vocal ensemble with the fine-tuned Demucs drum and bass
  models.
- **Time estimates.** Contour shows an estimate before you separate. It learns your machine's
  real speed from each run (stored in `perf.json` in the app data folder).
- **The engine never waits on itself.** Spectrograms for the next chunk and waveforms for the
  previous one are computed on other cores while the model runs. Inference uses one thread per
  physical core, and the vocal models stay loaded between runs.
- **HT-Demucs is optimised once.** On first use it is graph-optimised and cached as
  `*.opt.onnx`, so later loads are fast without a memory spike.
- **GPU.** DirectML asks Windows for the high-performance GPU, so laptops with switchable
  graphics (such as an RTX 3050 with an Intel iGPU) use the NVIDIA card. CUDA builds use TF32
  and conservative video-memory growth.
- **Loop-region separation.** In Studio, "Only the loop region" separates just the selection,
  for previews in seconds.

### Using CUDA (NVIDIA)
Build with `cargo tauri build --features cuda`, then install the CUDA 13 runtime and cuDNN 9 for
CUDA 13 from NVIDIA and make sure their `bin` folders are on PATH. Choose *NVIDIA CUDA* under
Processor. If CUDA can't start, Contour says why and uses DirectML instead.

## Mashup Lab

**The vocals of one song over the music of another, in time and in key.** Choose (or drop) a
*vocals* song and a *music* song and press **Make mashup**. Contour then:

1. **Separates both songs** with the normal engine (Balanced, or the RoFormer flagship with
   "Studio quality"; optionally splitting the music into drums, bass and other).
2. **Analyses them:**
   - *tempo:* spectral-flux onsets, autocorrelation with harmonic reinforcement, and a
     sub-frame fit across the tracked beats;
   - *beat grid:* a dynamic-programming beat tracker, with a guard against locking onto
     off-beats;
   - *downbeats:* kick energy plus harmonic change;
   - *key:* chroma against the Krumhansl–Kessler profiles, on the harmonic stems;
   - where each singer comes in.
3. **Fits the vocal to the music:**
   - it is time-warped onto the music's beat grid beat by beat, so it follows the band's real
     timing;
   - it is pitch-shifted, with formants preserved, by the smallest interval to a compatible key
     (the same key, the relative major/minor, or a neighbour a fifth away);
   - it enters on the bar where the music's own singer came in, at that singer's level.
4. **Plays the result through the normal mixer,** so Studio, volume curves, export and projects
   all work on a mashup.

**Adjust live.** The key (±1 semitone, or Auto), the entry (by bar or beat), a ±250 ms nudge,
the vocal level, the feel (Half / Matched / Double time) and "Lock the vocals to every beat".
Each change only re-renders the vocal, which takes seconds with no re-separation, and
playback continues where you were.

**Accuracy (unit tests in `engine/src`):**
- time-warping lands clicks within ±0.1 ms of their targets;
- a vocal from a 92 BPM song lands on a 124 BPM song's beats within 0.1 ms;
- tempo is exact at 92, 124 and 140 BPM;
- pitch shifts are within 1%.

Time-stretching and pitch-shifting use Signalsmith Stretch (MIT), vendored in
`engine/vendor/signalsmith` and compiled with the normal C++ toolchain; no extra tools are
needed.

**From the command line:**
`contour-cli mashup vocals-song.mp3 music-song.mp3 -o out/` writes `out/mashup.wav` and prints
the plan.


**Four lanes.** A mashup has Vocals A, Music A, Vocals B and Music B (or B's drums, bass and other),
each with its own On/Off and level. Song A's music goes through exactly the same beat-by-beat time map
and key shift as its vocal, with formants left alone, as is right for instruments. It's levelled to
B's music, so all four lanes stay in time and in tune (tested: A's music lands on B's beats within
15 ms). A new mashup starts as the classic mix, A's vocal over B's music, so layering both singers or
both bands is one click away.

**Stem keys** (every mode):
- **1–9** play only that stem.
- **Shift + 1–9** adds a stem, or takes it out if it's already playing; taking out the last one gives
  silence.
- **0** brings back the full mix.

While a selection is active, a row's On/Off adds or removes that stem in the same way.

## The Sound drawer

Every stem (Studio lanes and Simple rows) has a **▾** button that opens its Sound drawer. Everything
is heard live while you drag.

- **Presets for each stem type:** hover to hear one, click to keep it.
  - Vocals: Clean, Radio, Dreamy, Lo-fi, Stadium.
  - Drums: Tight, Big room, Vintage.
  - Bass: Warm, Deep, Gritty.
  - Instrumental: Open, Soft, Wide.
- **Level:** −24 to +12 dB, with a live meter whose green zone is the sweet spot.
- **Space** (reverb), **Warmth**, **Clarity** (softer ← → brighter), **Punch** and **Width**
  (50 = as recorded).
- **Level out:** evens out the stem's loud and quiet passages (an automatic rider, ±9 dB, silence
  untouched); **Restore original** undoes it. **Reset** returns every knob to neutral, and
  double-clicking a slider resets just that one.
- **A safety limiter** (−1 dBFS, 5 ms look-ahead) on the final mix, so nothing can distort.

**Preview = export.** `engine/src/fx.rs` renders exports. `ui/fx-worklet.js` is its line-for-line twin
on the audio thread for the live preview. `contour-cli fxcheck <dir>` writes reference outputs: on the
same test signal, the two agree to within 2.4e-7, and the reverb is bit-exact.

**The DSP:**
- RBJ shelves and a presence peak for Warmth and Clarity;
- a feed-forward compressor with half make-up gain for Punch;
- mid/side for Width;
- one shared Freeverb, fed by each stem's post-fader send;
- a sliding-maximum look-ahead limiter.

**Tested:** Warmth adds about 6 dB at 80 Hz; Clarity lifts or darkens 10 kHz; Punch closes a
loud/quiet gap by more than 8 dB; Width goes from mono to double the stereo difference; the limiter
never passes the ceiling; Level out shrinks a 20 dB phrase gap by more than 8 dB.

**Drawer behaviour:**
- It opens and closes in place: nothing else redraws, and the lanes below glide.
- The height animation includes padding, so it truly reaches zero.
- It's interruptible: clicking mid-animation reverses from the current height.
- A hover preview can never outlive the drawer: closing, Escape or a redraw restores your settings.
- A closing drawer is inert; an opened one scrolls into view.
- It sits above the timeline overlay, so every click reaches its controls.
- Redraws keep drawers open without replaying the animation.

## Layout robustness

An automated layout audit (overlapping controls or text, anything off-screen or cut off by its
container, sideways scrolling, clipped text) passes with **zero issues** on every screen, at
980×640 (the minimum window), 1100×700, 1280×800, 1440×900 and 1920×1080:

- Simple with an open drawer, Studio with an open drawer, Mashup;
- Sing setup, stage and results;
- Settings.

The fixes it drove:
- the header title truncates to its room and hides when there's none (the unsaved dot moves beside
  the logo);
- the transport sheds the Master group, then tightens, as width shrinks;
- Sing scrolls on short windows;
- Simple's ▾ sits beside On/Off;
- Mashup titles clear their button.

Sing's screens, the Tune panel and the lyrics editor arrive with a short, interruptible fade-and-rise
(skipped for reduced motion).

## Recording in Studio

Press **Rec** (or **R**) to record your microphone onto a new lane, "Recording N", from the playhead.
R or Space stops. It uses the same glitch-free audio-thread recorder and latency compensation as Sing.

## The small things

- **Unsaved changes** show as a small white dot beside the song title (no toolbar band); undo and
  redo are on Ctrl+Z / Ctrl+Shift+Z and in the palette.
- **Command palette (Ctrl+K):** fuzzy search over about 30 commands (it tolerates typos: "lop" finds
  Loop), with recent commands first.
- **Sliders:** double-click any slider to reset it. Drag a slider's number sideways to change it
  (hold Alt for fine control), and double-click the number to reset.
- **Every control answers on press:** a subtle press-down, with transitions under 120 ms.
- **Errors in plain words:** a full disk, missing files, no internet, folder permissions, running out
  of memory, a GPU reset and unreadable files each get a sentence saying what happened and what to
  do.
- **Unplugging headphones mid-playback pauses,** instead of carrying on through the speakers.
- **Taskbar:** progress shows on the taskbar, and the icon flashes when a long job finishes while
  you're in another window.
- **Remembered:** window size, position and maximised state (`tauri-plugin-window-state`); the last
  mode; Sing's guide level, sync, language and microphone; Tune and live-tune settings; the Mashup
  split; the crossfade length.
- **Exports never overwrite:** an existing file gets "(2)", "(3)", … (tested).

## Projects

**Reliability (tested in `src-tauri/src/lib.rs`, `project_tests`):**
- **Round trip:** a project saves and reopens with every stem's audio intact, including stems louder
  than 0 dBFS. Every stem gets its own file, even when two share a label. The mixer, clips and other
  interface state survive.
- **Missing audio:** reported by file name.
- **Recovery:** keeps two alternating copies, restores the newest complete one, and never offers a
  half-written copy.
- **Takes:** recording, importing or tuning one triggers a full recovery save, so a crash can't lose
  it.
- **FLAC:** Contour's FLAC files are written spec-correctly (minimum block size excludes the final
  block). Previously they were valid for other apps but Contour's own decoder rejected them, which
  broke reopening projects and re-importing exported FLAC stems.

**Save project** (Ctrl+S; Ctrl+Shift+S to save as) writes `Song.contour` plus a folder,
`Song audio/`, next to it. The folder holds the original and every stem as 24-bit FLAC, so the
files also open in any other audio app. The project file keeps the mixer (levels, pans, mutes,
solos), the volume curves, the loop region, zoom and the separation settings. **Open project…**
(Ctrl+O, or double-click a `.contour` file) restores everything instantly, without separating
again.

## Sing (karaoke)

Sing over any song: the original singer's melody scrolls by as notes, your voice is drawn against
it live, and you get a score.

- **Start:** choose a song (or use the one loaded) and press **Start singing**. If it hasn't been
  separated yet, Sing separates the vocals first.
- **While singing:**
  - the instrumental plays, with the original vocal as an optional quiet **guide**;
  - your pitch is tracked live (YIN, within about 1 cent) and compared with the melody, ignoring
    octaves, so you can sing it in your own register;
  - a note counts as hit when you're within 50 cents for most of it, and the score is the share of
    the melody you sang on pitch.
- **Melody:** extracted in the engine from the separated vocal (`analysis::melody`: YIN on a
  decimated signal, 10 ms frames, octave-error smoothing; unit-tested on notes with vibrato).
- **Your take:** recorded in time with the song (latency-compensated; fine-tune with **Sync**). It
  becomes a normal "Your take" stem: listen back over the instrumental, save it, or open it in
  Studio.
- **Recording:**
  - your mic is recorded on the audio thread (`ui/recorder-worklet.js`), so drawing the interface
    can't delay or drop audio;
  - every block is time-stamped, so the take is rebuilt sample-accurately, and any gap stays a gap
    instead of shifting everything after it;
  - the take is recorded at the device's real rate and converted to 44.1 kHz in the engine;
  - while you sing, the background rests and the pitch line skips its glow;
  - opening a take in Studio mutes the original singer's lanes.
- **Permissions:** the first time, the OS asks for microphone access. On macOS the request text
  comes from `src-tauri/Info.plist`.

### Lyrics (Apple Music–style)

**Get lyrics** on Sing's start screen transcribes the song on this computer, from the separated vocal,
with OpenAI's Whisper large-v3-turbo (MIT). The language is detected automatically, or you can pick
it. The model is downloaded once: about 865 MB, pinned by commit and SHA-256.

- **Engine** (`engine/src/whisper.rs`, ONNX Runtime):
  - only stretches of actual singing reach the model (windows of 28 s or less), so instrumental
    breaks can't produce invented lines;
  - Whisper's log-mel spectrogram matches the reference extractor to 1e-7;
  - decoding is greedy with timestamps (one lyric line per segment), with the audio-side attention
    cache computed once per window;
  - repetition loops are stopped, noise tags like "[Music]" removed, and low-confidence windows
    dropped;
  - word timings are estimated within each line from syllable counts.
- **Why these files:** the 4-bit weight-only encoder matched full precision exactly on LibriSpeech;
  the 8-bit dynamically quantised encoder garbled words and looped. The 8-bit decoder is fine.
- **Measured:** LibriSpeech test sentences come out exactly right. Separated MUSDB18 vocals come out
  as real lyric lines, e.g. "Keep, keep me in your line of sight. / Squeeze, squeeze, squeeze me. /
  Go on, hold me tight.". Expect English to be best, major languages good, and Tamil or other Indian
  languages rough: fix any line in **Edit**.
- **View:**
  - large, bold, left-aligned lines; the current line is bright, the others dimmed and softly
    blurred;
  - springy, staggered scrolling (compositor transforms only) and a word-by-word fill;
  - breathing dots for the intro and instrumental breaks; tap a line to jump to it;
  - the current line glows blue when you're on pitch and tints red when you're off;
  - a **Vocals** slider on stage, and a Lyrics / Notes switch;
  - lyrics are saved in projects.
- **Timing refined from the vocal itself** (`refine` in `whisper.rs`):
  - lines snap to where singing really starts and ends;
  - run-on lines split at the longest breath near their middle;
  - words are placed on the vocal's syllable onsets **by order**, matched by an exact monotonic
    alignment of each word's syllable share to the onset sequence, so uneven sung rhythm is followed.
  - Tested: on uneven rhythm, word starts land within 60 ms of the true syllables, at least three
    times closer than an even split.
- **The view:** a feathered word sweep, a soft glow on sung words, and the current line a touch
  larger.
- **Scoring:** every line (lyric lines, or the melody's phrases without lyrics) is rated as it ends,
  from how much of its melody you held within 50 cents.
  - A small Perfect / Great / Good rises and fades beside it; misses pass silently.
  - A quiet ×N counts lines in a row rated Great or better.
  - **Results:** a soft letter grade (S ≥ 90, A ≥ 80, B ≥ 65, C ≥ 50), a slim timeline of every
    line tinted by its rating, the counts and best run, and your personal best for the song (kept on
    this computer).
- **From the command line:** `contour-cli lyrics vocals.wav --models <models dir>` prints the timed
  lines.

### Tune it

After singing, **Tune it** pitch-corrects your take, then you choose between the tuned and the original
version.

- **Follow:**
  - *Melody* uses the original singer's note at each moment, moved into your octave;
  - *Key* uses the nearest note of the song's scale. Key is also the fallback wherever the original
    singer is silent.
- **Strength** controls how far notes move. **Speed** ranges from *Gentle* to *Robotic*: Robotic is an
  instant snap, the hard-tuned sound. **Keep vibrato** corrects each note's centre and leaves your
  vibrato and slides as sung.
- **Graph:** shows your pitch as sung, the target and the tuned result, with the in-tune share before
  and after.
- **The Tuned switch** compares the tuned and original takes instantly, even mid-playback. Save take
  saves the version you've chosen, and Studio gets both as lanes, with the unused one muted.
- **How it works** (`engine/src/tune.rs`): it tracks the take's pitch, plans a per-10 ms correction,
  and applies a time-varying, formant-preserving pitch shift (Signalsmith Stretch). The pitch
  analyses are cached (bounded), so re-tuning with new settings is quick.
- **While you adjust:** only the latest settings are applied; changes made during a tune collapse into
  one follow-up run. The current result keeps playing until the new one has loaded.
- **Takes from anywhere:**
  - **Import a take…** (Sing's start screen) brings in a vocal recorded elsewhere and lines it up with
    the song automatically, by cross-correlating its onsets with the original vocal (tested: a take
    starting 1.37 s late, at a different pitch and with noise, is placed within 30 ms);
  - **Tune your take** reopens tuning at any time;
  - in Studio, right-click a take lane → **Tune in Sing**.
- **Save song** exports your version: the take you chose, tuned or original, over the instrumental, as
  one file.
- **Unit tests:** notes sung 35–60 cents off land within 12 cents of the melody, and the in-tune share
  goes from under 20% to over 90%. Strength 0 changes nothing, Key mode snaps to the right scale
  notes, and tuning never shifts the take in time.

## Easter egg: hear yourself, tuned

Type **tune** anywhere outside a text field (the stray **n** doesn't toggle the Null test). A card
opens with live monitoring: your voice comes back in your headphones, hard-tuned to the nearest
semitone, with an optional "shimmer" double.

- **Low latency by design:** it uses its own `AudioContext` with an interactive latency hint, and all
  processing runs on the audio thread (`ui/tune-worklet.js`): YIN pitch tracking, a chromatic snap,
  and a two-tap delay-line pitch shifter.
- **Measured offline** (`process()` driven block by block): voices 23–47 cents off snap to within
  1 cent. It adds 12.5 ms on top of the device's own input and output latency, which the card shows.
  Strength 0 leaves the pitch alone, and silence stays silent.
- **Headphones are required:** you confirm before it starts, since speakers would feed back.
  Bluetooth headphones are flagged, because they add a lot of delay.
- It needs the desktop app; the browser preview can't load the audio worklet.

## Studio editing

Studio's lanes are clip-based and non-destructive. Every edit only changes which part of a stem's
original audio plays where, so everything can be undone, saved in projects and exported.

- **Select:** click a clip; Shift adds to the selection; Ctrl+A selects all; Esc clears.
- **Move:** drag a clip, or a whole selection across lanes. Clips snap to the grid (which follows the
  zoom), the playhead, loop edges and other clips' edges; hold **Alt** to move freely, or press **G**
  to turn snapping off. Dropping a clip overwrites what it lands on, so clips never overlap.
- **Trim:** drag either edge of a clip. Trimming outward restores audio that was cut away.
- **Fades:** drag the handles in a clip's top corners.
- **Split:** **S** splits the selected clips (or every lane) at the playhead. With the **Split** tool
  (C), click to split a lane there; Shift-click splits every lane.
- **Edit:** Delete removes clips; Ctrl+D duplicates; Ctrl+C / X / V copy, cut and paste at the
  playhead; Alt+← → nudge by the grid; + / − change clip gain. Right-click a clip for all of these,
  plus Reset clip gain, Remove fades and Restore (the lane's original, unedited audio).
- **Precision:** hold **Alt** while moving, trimming or fading a clip: it follows the mouse at a
  tenth of the speed, with snapping off and the readout in milliseconds (tested: 200 px moves
  5.94 s normally, 0.594 s with Alt). Pressing or releasing Alt mid-drag never makes the clip jump.
- **Box select:** Ctrl/Cmd + drag (or drag in empty space) draws a box that selects clips across
  lanes; Shift adds to the selection.
- **Crossfades:** wherever two different clips meet, each reaches half a crossfade into the other,
  using real audio from beyond its edge, and the two blend over the overlap. Splits of continuous
  audio stay seamless with no crossfade. Off / Short (10 ms) / Smooth (30 ms, the default) / Long
  (120 ms), from a clip's right-click menu. Playback and every export use the same blend; the engine
  sums overlaps, and the level stays constant through a crossfade (tested).
- **Loop from the ruler:** dragging a region on the ruler turns looping on and plays it from its
  start.
- **Lanes:**
  - drag a lane's name to reorder it (groups move with their stems; stems reorder within their
    group); double-click a name to rename; drag a lane's bottom edge to resize;
  - **+ Add audio lane** brings in any file as a new lane, removable from its right-click menu;
  - names, order, heights and the crossfade length are kept in projects and undo, and exported files
    use the lanes' current names.
- **Everywhere else:** playback schedules each clip sample-accurately, including through loops, and
  edits are part of Undo/Redo and projects. Export stems and Export mix render the clips in the
  engine, before volume curves and the loop region.

## Volume curves (Studio)

Press **Curves** (or **A**), then shape any stem's volume over time:

- **Mouse:** click a lane to add a point and drag to shape it. It snaps to 0 dB; hold Shift for
  fine moves. Alt-click or right-click a point to delete it, and right-click a lane to clear its
  curve or all curves.
- **Keyboard:** Tab to a lane's waveform. Enter adds a point at the playhead, ← → select points,
  ↑ ↓ change the level by 0.5 dB (Shift: 0.1 dB), `,` `.` move a point in time, and Delete removes
  it.

Playback follows the curves sample-accurately, including inside loops. **Bounce mix** renders
them, and **Export stems** applies them when "Apply volume curves" is on.

## Settings and keyboard

Settings (the cube icon, or **?**) holds the export folder (or "ask each time"), model storage
with "Show in folder", the full shortcut list, and the model manager. Everything can be reached by
keyboard. Segmented controls and the Simple-mode tiles use arrow keys, focus stays inside open
dialogs, and every control has a visible focus ring.

## Installing and first run

**The Windows installer sets Contour up completely.** After copying the files, it runs Contour
once in setup mode (`contour.exe --setup`). That downloads the core models with a progress
window, verifies each by SHA-256, and optimises HT-Demucs for the computer. The installer waits
for this to finish, so Contour is ready to use offline when it closes. (The hook is in
`src-tauri/windows/hooks.nsh`.)

| Core model | Purpose | Size |
|---|---|---|
| UVR-MDX-NET Voc FT | Vocals (Fast, Balanced) | 67 MB |
| Mel-Band RoFormer (Kim) | Flagship vocals | 464 MB |
| UVR-MDX-NET Karaoke 2 | Lead / backing | 53 MB |
| HT-Demucs 4-stem | Drums, bass, other | 166 MB |
| HT-Demucs 6-stem | Adds guitar, piano | 136 MB |

That's about 890 MB in total. Other models (de-reverb, the fine-tuned Demucs set and so on)
still download the first time they are needed.

If setup was skipped or failed, or on platforms without this installer (MSI, macOS, Linux), the
app shows the same setup screen at launch. "Skip for now" downloads models on demand instead.

## Playback start

Tracks load in the background as soon as they exist: the original when a song is imported, and
the stems the moment separation finishes, audible ones first. Pressing play waits only for what
will be heard; any other track joins sample-accurately as it arrives. Playback audio is sent as
16-bit with a scale factor (half the data, nothing clips); exports always use the full-precision
stems. Waveform detail is computed in idle time.

## Flagship: Mel-Band RoFormer

Contour's top quality tier runs **Kimberley Jensen's Mel-Band RoFormer** vocal model (MIT
licence; ONNX export by audiojs, pinned by commit and SHA-256), a transformer that clearly
outperforms the MDX-Net models. Measured with `contour-cli eval` on MUSDB18 excerpts against Voc FT:

| Song | Voc FT, vocals | RoFormer, vocals | Gain |
|---|---|---|---|
| AM Contra – Heart Peripheral | 12.60 dB | 13.49 dB | +0.9 dB |
| Cristina Vane – So Easy | 17.37 dB | 18.76 dB | +1.4 dB |
| Louis Cressy Band – Good Time | 11.74 dB | 12.24 dB | +0.5 dB |

Instrumentals improve by about the same amount. The old two-model ensemble gained only
~0.05 dB.

- **Where:** Studio → Quality → **Flagship**, or the **Studio quality** switch in Simple mode.
  With 4 or 6 stems, Flagship splits RoFormer's instrumental with HT-Demucs (installed during
  setup, so it works offline).
- **Requirements:** a one-time 464 MB download. Best on a GPU (about a minute per song on an
  RTX 3050-class card). On CPU it works but is several minutes per song, and it needs about 4 GB
  of free RAM. The time estimate shows this before you start.
- **How it runs:** 8 s segments with a 4 s step, the full-band STFT (n_fft 2048, hop 441) computed
  in Contour's pipelined engine, no input normalisation (as documented), one segment per GPU
  dispatch, and the same GPU recovery as every other model.

## Colour

Blue is reserved for the interface: selection, playhead, focus, solo and primary actions. Stems
avoid amber and purple entirely:

- vocals silver-white (backing a cooler grey), instrumental and other teal;
- drums coral-red, bass green, guitar lime, piano sky;
- your takes rose.

Mute is a neutral "off" state, and warnings such as "Unsaved changes" use a soft red.

## Separation feedback (Simple mode)

While a song separates, its waveform fills with a slowly drifting halftone texture, the same
visual language as the background. When the stems are ready, it crossfades into the stem
colours. Studio shows only the job panel. (The engine can still report per-window progress
through `Engine::viz`; set `CONTOUR_VIZ=1` with `contour-cli` to print it.)

## GPU reliability

- **Recovery without restarting.** If the GPU resets mid-step (a Windows TDR, a lost device, a
  CUDA error or running out of video memory), Contour drops its GPU sessions, waits for the
  driver, and retries that step on the GPU. A second failure finishes the job on the CPU from
  that step, instead of starting over. Each new job tries the GPU again.
- **Adaptive batching.** Dispatch times are measured, and batches are sized so each GPU dispatch
  stays around 0.45 s, well under Windows' 2 s watchdog. Strong GPUs get bigger batches; weak
  ones stay safe.
- **Video memory.** On a GPU only the model in use stays loaded, which suits 4 GB laptop cards.
  CUDA uses heuristic convolution selection without a maximal workspace.
- **The right adapter.** DirectML requests the high-performance GPU, so laptops with switchable
  graphics use the discrete card.
- **Low-RAM guard.** If the one-time Demucs optimisation is interrupted, it is never retried.
  `CONTOUR_NO_MODEL_CACHE=1` skips it entirely.

## How it separates

```
mix ─► vocal model(s) ─► VOCALS ─► [Karaoke 2] ─► LEAD / BACKING ─► [Reverb HQ] ─► DRY / REVERB
  └─► mix − vocals ─► INSTRUMENTAL ─► [HT-Demucs] ─► DRUMS / BASS / (GUITAR / PIANO) / OTHER
```

Every split is exact: "backing", "reverb" and "other" are computed by subtraction, so the
stems at each level always add back up to their parent. Solo or export any level.

### Quality presets

| Preset | Vocals | Instruments (4/6 stems) |
|---|---|---|
| **Fast** | Voc FT, 25% overlap | HT-Demucs, 25% overlap |
| **Balanced** | Voc FT + denoise pass, 50% overlap | HT-Demucs, 25% overlap |
| **Max** | Ensemble: Voc FT + Kim Vocal 2 + HT-Demucs FT vocals, denoise | Fine-tuned HT-Demucs specialists, 50% overlap, left/right test-time augmentation |

### Measured quality

Mean SDR (signal-to-distortion ratio; higher is better) on 5 MUSDB18 test excerpts,
measured with `contour-cli eval`:

| Configuration | Vocals | Instrumental | Drums | Bass | Other |
|---|---|---|---|---|---|
| Fast | 11.48 | 16.10 | — | — | — |
| Balanced | 11.57 | 16.19 | — | — | — |
| Voc FT + Kim Vocal 2 ensemble | 11.62 | 16.24 | — | — | — |
| Balanced + Inst HQ 3 blend | 11.57 | 16.27 | — | — | — |
| Fast + HT-Demucs 4-stem | 11.48 | 16.10 | 9.79 | 6.01 | 4.28 |

The **Max** preset (three-model ensemble plus fine-tuned Demucs specialists) has not been
benchmarked yet. Measure it with `contour-cli eval` before relying on it.

These are 7-second excerpts, so treat them as a sanity check rather than a leaderboard
entry. Run `contour-cli eval` on the full MUSDB18-HQ test set for publishable numbers.

## Building

### 1 · Prerequisites (all platforms)

- [Rust](https://rustup.rs) 1.85 or newer
- Tauri CLI: `cargo install tauri-cli --version "^2"`
  (or use `npm install`, then `npm run tauri …`)
- The [Tauri system prerequisites](https://v2.tauri.app/start/prerequisites/) for your OS:
  - **Windows:** Microsoft C++ Build Tools and WebView2 (already present on Windows 10/11).
  - **macOS:** Xcode Command Line Tools.
  - **Linux (Debian/Ubuntu):**
    ```
    sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev libsoup-3.0-dev build-essential
    ```

The build downloads a matching prebuilt ONNX Runtime automatically through the `ort` crate.

### 2 · Run and package

```bash
cargo tauri dev                    # run in development
cargo tauri build                  # installer: .msi/.exe, .dmg/.app, .deb/.rpm/.AppImage
cargo tauri build --features cuda  # NVIDIA GPU build (Linux / Windows)
```

GPU support by platform:

| Platform | Accelerator | Notes |
|---|---|---|
| Windows x64 / ARM64 | DirectML (any DX12 GPU) | Always included |
| Windows x64 | CUDA 13 + TensorRT | `--features cuda`; needs NVIDIA driver, CUDA 13 and cuDNN at runtime |
| Linux x64 | CUDA 13 + TensorRT | `--features cuda` |
| macOS Apple Silicon | CoreML | Always included |
| macOS Intel | CPU only | No prebuilt ONNX Runtime exists; build ORT yourself and set `ORT_LIB_LOCATION` |

If the chosen accelerator fails to initialise, Contour falls back to the multithreaded CPU
automatically. The processor in use is shown above the mixer.

### Command-line tool

```bash
cargo build --release --bin contour-cli         # builds target/release/contour-cli
contour-cli separate song.mp3 -q max --stems 4 --lead-backing -f flac24
contour-cli separate ~/Music/album/ -o ~/Stems        # whole folder
contour-cli models download all                       # pre-fetch every model (≈1.6 GB)
contour-cli eval /path/to/musdb-wav-folders -q balanced
```

`eval` expects one folder per track containing `mixture.wav`, `vocals.wav`, `drums.wav`,
`bass.wav` and `other.wav`. The `--recipe '<json>'` option overrides any preset for
experiments; see `Recipe` in `engine/src/pipeline.rs`.

## Models

Models download on first use, are pinned to exact Hugging Face commits, and are verified by
SHA-256. They are stored in the app data folder (shown in **Models**), or for the CLI in
`~/.cache/contour/models` (override with `CONTOUR_MODELS`).

| ID | Purpose | Size |
|---|---|---|
| `mel_roformer` | Mel-Band RoFormer (Kim): flagship vocals | 464 MB |
| `voc_ft` | UVR-MDX-NET Voc FT: vocals | 67 MB |
| `kim_vocal_2` | Kim Vocal 2: vocals (ensemble) | 67 MB |
| `mdx_main` | UVR-MDX-NET Main: vocals (optional) | 67 MB |
| `inst_hq_3` | UVR-MDX-NET Inst HQ 3: instrumental (optional) | 67 MB |
| `kara_2` | UVR-MDX-NET Karaoke 2: lead / backing | 53 MB |
| `reverb_hq` | Reverb HQ by FoxJoy: de-reverb | 67 MB |
| `htdemucs` | HT-Demucs 4-stem | 166 MB |
| `htdemucs_6s` | HT-Demucs 6-stem (guitar, piano) | 136 MB |
| `htdemucs_ft_*` | Fine-tuned HT-Demucs specialists ×4 | 166 MB each |

**Licensing:** Contour's code is MIT. HT-Demucs weights are MIT (Meta). The UVR MDX-Net
community models are distributed through the Ultimate Vocal Remover project; check each
model's terms, and the training datasets' terms, before any commercial use.

## Project layout

```
engine/            Rust separation engine + `contour-cli` (no UI dependencies)
  src/stft.rs        MDX-Net STFT front end
  src/mdx.rs         MDX-Net chunked inference (overlap-add, denoise, L/R TTA)
  src/demucs.rs      HT-Demucs chunked inference
  src/pipeline.rs    cascades, ensembles, presets
  src/models.rs      pinned registry, verified downloads
  src/runtime.rs     ONNX Runtime sessions, accelerator fallback
  src/audio.rs       decode, resample, WAV/FLAC export
src-tauri/         Desktop shell: commands, progress events, export, model manager
ui/                Interface (plain HTML/CSS/JS, no build step)
```

## GPU troubleshooting

**"The GPU device instance has been suspended" (887A0005).** Windows reset the GPU in the
middle of a job. This happens when a single piece of GPU work runs past the ~2-second
watchdog (TDR) or video memory runs out. Contour now sends DirectML one chunk at a time and,
if the GPU still drops out, finishes the job on the CPU and tells you why.

**Built with `--features cuda`, but the error mentions DirectML.** The Windows CUDA build
includes DirectML too. On *Automatic*, Contour tries CUDA first and falls back to DirectML if
CUDA can't start; the reason is shown after separation. CUDA needs these at runtime:

- an NVIDIA driver that supports CUDA 13;
- the CUDA 13.x runtime (cuBLAS, cuFFT, cudart), from the CUDA Toolkit 13;
- cuDNN 9.x for CUDA 13.

Their `bin` folders must be on `PATH`, or the DLLs copied next to `contour.exe`. Then choose
**NVIDIA CUDA** under Processor; it no longer falls back silently.

**Still resetting on DirectML?** Pick *CPU*, close other GPU-heavy apps, or raise Windows'
GPU timeout. To raise it, set the `TdrDelay` DWORD to `10` under
`HKLM\SYSTEM\CurrentControlSet\Control\GraphicsDrivers`, then reboot. This is a
system-wide setting, so change it only if you're comfortable editing the registry.

## Known limits and next steps

- **MP3 export** isn't included. It needs the LAME encoder, which brings licensing and
  build complexity.
- **RAM:** expect about 1.3 GB peak per MDX model and more for HT-Demucs. Playback keeps
  every stem in memory (about 85 MB per stem for a 4-minute song).
- **The biggest quality jump still available is RoFormer models** (BS-RoFormer,
  Mel-Band RoFormer), which lead current vocal and instrumental benchmarks. Adding them
  needs an ONNX export with the STFT kept outside the graph, which `mdx.rs` already does.
  `pipeline.rs` is built so a new architecture slots into the same cascade.
