# Performance verification

Observed in a synthetic Chromium preview at 1280×720, using the previous workflow-polish package as the baseline. Both versions used reduced motion to hold decorative animation constant. The 1.5-second sample ran while audio was playing.

| Measurement | Previous package | This package |
| --- | ---: | ---: |
| Full Simple waveform repaints | 19 | 0 |
| Time inside full Simple waveform painting | 6.4 ms | 0 ms |
| Long tasks during the sample | 0 | 0 |

Different animation-frame counts were observed in the headless environment, so these figures must not be interpreted as a percentage improvement in overall CPU use or frame rate. The reliable finding is that a moving playback cursor no longer causes full waveform painting.

Browser regressions also verify that vocal-level edits issue no Mashup render command, a key adjustment preserves the music source node and avoids a second PCM read for it, and metadata-only recovery avoids another full audio save.

Not benchmarked: native GPU/CPU inference, native peak/RMS/model analysis, real file encoding throughput, peak process RAM, battery use, or real audio dropouts on Windows hardware. The soft preview-buffer budget does not cap the native model/session buffers or guarantee constant RAM for arbitrary song lengths.
