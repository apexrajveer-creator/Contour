# Contour product polish and optimization

This package implements the remaining review items (21–45), on top of the earlier 1–20 changes. It retains the frosted blue visual language and the existing separation algorithms.

## What changed

| Items | Delivered behavior |
| --- | --- |
| 21–23 | Clear workflow roles; direct Simple → Studio action; current-song buttons in both Mashup slots. The native command shares decoded audio and reuses compatible full-length separation stems; otherwise the requested separation still runs. |
| 24–25 | Shared play/pause, elapsed/total time and seeking in every tab. Navigation leaves the audio context and source nodes running. Buffered playback requests can be cancelled before they start. |
| 26–27 | Timing/key updates retain mixer edits and position. During ordinary playback, the music node/buffer survives and the newly prepared vocal fades in. Vocal gain updates through the audio mixer immediately, without a render command. |
| 28 | Simple and Mashup show an actionable indicator when solos, curves, loops or null testing affect playback. |
| 29–31 | Tab direction follows Simple → Studio → Mashup. The outgoing view retains its actual grid/flex layout. Mashup sections participate in the shared motion system, with interruptible transitions. |
| 32 | Waveforms redraw on entry/resize/scroll through a coalesced render request. |
| 33–35 | Shared control, spacing and timing tokens in product.css; shorter settling on elastic controls; targeted text observers; 140 redundant unconditional CSS declarations removed. |
| 36–38 | A common export-options sheet applies format, rate, peak protection, curves and region consistently. Editable projects and exported audio have distinct labels. Stem selections survive view rebuilds, compatible result updates and project save/open. |
| 39 | Modified-state indicator; replacement/close protection; disk recovery checkpoints with alternating audio generations. Once audio is checkpointed, ordinary mixer edits update only the small project metadata. Recovery opens the saved audio/mixer as an unsaved session. |
| 40 | Bounded undo/redo for levels, pans, mutes, solos, automation, regions, loops and Mashup matching settings. Pointer drags are grouped into a single history entry. History contains edit parameters, not audio buffers. |
| 41–42 | Global save/open/undo/redo shortcuts work with buttons focused. Escape closes only the foremost active surface; exit animations do not consume an extra Escape. |
| 43 | Studio has import/open actions in its empty workspace. Mashup exposes source readiness and analysis through the shared task presentation. |
| 44–45 | Browser acceptance checks cover three workflow tabs, long filenames, six stems, reduced motion, failure/cancellation paths and effective viewport sizes corresponding to 100/125/150% zoom. Real Windows display scaling remains a native verification item. |

Saved Mashups continue to reopen as rendered audio/mixer sessions in Studio. Their two original matching sources are not reconstructed from project files; the UI explains this explicitly.

## Performance changes

- Simple playback moves a lightweight cursor over a static waveform instead of repainting the full layered shape every frame.
- Waveform base images and downsampled geometry are cached. Automation redraws reuse their underlying waveform, and offscreen Studio lanes are skipped until scrolled into view.
- Peak and RMS analysis share one scan, split into approximately 4 ms UI slices. PCM conversion yields in bounded chunks, and obsolete source loads stop conversion early.
- Playback fetches audible tracks instead of preloading every muted group/duplicate stem. A soft 192 MiB preview-buffer budget evicts inaudible buffers when possible; audible buffers and native inference memory can exceed that budget.
- Mashup updates reuse unchanged music buffers and audio nodes. Existing decoded source audio and compatible separation buffers are shared through native Arc references.
- Background shader work runs less often; static uniform values and locations are cached. Its scheduler does not wake every animation frame just to skip rendering, and pauses during processing/hidden windows.
- Playback drawing is capped at 60 Hz, hidden-window visual work stops, clocks avoid identical DOM writes, dropdowns skip unchanged rebuilds, and the global text observer no longer processes every clock/meter mutation.
- Saving project audio no longer clones an entire stereo buffer when scaling is unnecessary. Individual audio files are written through temporary files before replacement.
- Recovery retains two audio generations; small edits update metadata instead of re-encoding every stem.

These changes target avoidable UI work, memory duplication, repeated imports and Mashup updates. They do not replace the neural models with lower-quality models or promise a specific native inference speedup.

## Validation and profiling

`npm test` runs the workflow/history unit tests. After installing Playwright Chromium, `npm run test:ui` runs both browser suites.

```sh
npm install
npx playwright install chromium
npm test
npm run test:ui
```

The suites use synthetic audio and mocked IPC. Rust syntax was parsed successfully, but this environment did not compile the Tauri application or execute real GPU inference.

A controlled 1.5-second Chromium playback sample at 1280×720, with reduced motion enabled for both versions, observed 19 full Simple waveform repaints before this update and 0 afterward. That confirms removal of continuous waveform painting; it is not an overall CPU/FPS benchmark or a Windows hardware result. See tests/PERFORMANCE.md for scope.

Before release, build on the Windows development machine and verify hardware acceleration, native file dialogs/close handling, real model downloads, recovery after process termination, and Windows display scaling.

```sh
npm run build
```
