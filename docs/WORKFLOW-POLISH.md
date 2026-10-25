# Contour workflow polish — items 1–20

This update changes the existing Simple, Studio and Mashup workflows. The separation models and DSP algorithms are unchanged.

## Session and result behavior

- Separation captures its initiating view, goal, quality, processor and loop region before checking models or starting work. Navigating to another tab cannot change its result configuration.
- All views render the same active source and tracks. Mashup source slots are an explicit draft until a build succeeds. Result replacement refreshes Simple, Studio and Mashup together.
- Mixer mute changes update both result lists as well as the Studio lanes.
- A successful new import clears the previous project path, export destination indicator, loop/null-test state and Mashup draft. Failed imports preserve the previous session.
- Changing or swapping a Mashup source, quality or split setting marks its previous result as outdated. Rebuild is required before further matching adjustments; the previous audio remains available.
- New mashup checks for unsaved mixer/result changes and resets sources, tracks, settings and project identity together after confirmation.
- Dropping two songs reserves the operation and imports them sequentially.
- Export folder and ask-before-saving preferences survive restarts.

## Projects

Saving a Mashup writes its rendered audio and mixer, with matching settings and source metadata retained as provenance. Reopening intentionally opens that rendered mix in Studio. It does **not** claim to restore editable matching sources or cached separation state. A notice explains how to create a fresh Mashup if source matching must be changed. Resaving a reopened mix preserves this rendered-Mashup identity.

## Processing

- One shared status bar and processor selector remain available in all three tabs.
- Active tasks show stage, progress and elapsed time; cancellable tasks expose Cancel. Non-interruptible import, analysis, preview-render and project-save stages identify that they must finish first.
- Mashup's existing progress bar follows the same actual events as Simple and Studio.
- Controls that would conflict with a task are disabled. Matching controls remain responsive while a preview update is being rendered; later edits are serialized and supersede older renders.
- Revision and session guards prevent an older response from becoming the visible result. Exports and project saving wait for pending matching changes.
- Failed adjustments restore the last successful controls/audio and expose Retry. Separation, imports, exports, model downloads and project open/save failures also expose a retry action where applicable.
- The native separation command retains existing stems until a replacement succeeds. Cancelled final Mashup matching restores the previous audio session.
- Remaining-time estimates are based on percentage progress within one processing stage. Downloads, analysis, setup, restarted stages and insufficient samples do not get invented estimates.
- Last-run processor and fallback notes are visible globally, including Mashup responses.
- Required model names/download sizes and likely slow CPU flagship runs are explained before processing. Routine runs with models already present proceed directly.

## Validation

Run the small workflow regression suite with `npm test`.

Run browser workflow checks with:

```sh
npm install
npx playwright install chromium
npm run test:ui
```

The browser suite runs the synthetic preview with controlled IPC delays and failures. It checks cross-tab completion, two-file import, cancellation/progress, mute synchronization, latest-adjustment ordering, failure/retry, stale-source rebuilds, rendered-project reopening, preference persistence, CPU/download preflight, session reset and shared controls at three laptop viewport sizes. It does not validate native inference quality, real model downloads, Windows GPU execution or installer behavior.

Build on the Windows development machine using the project's existing Tauri prerequisites:

```sh
npm install
npm run build
```

A native Windows build and real GPU/audio verification are still required. No Windows executable is included in this source archive.
