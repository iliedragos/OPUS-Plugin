# OPUS 1.6.5: preserve PCM consumed during initial FFmpeg analysis

Baseline: main at `dbabd703a157c83b30d197da5c7688959292ebc3` (1.6.4).
The pre-edit Git/SHA-256 golden fingerprint is in FFMPEG_1.6.5_BASELINE.json.

## Root cause and scope

The input `-fflags +nobuffer+flush_packets` allowed FFmpeg to discard raw PCM
packets consumed during initial stream analysis. On FFmpeg 7.1.5 this caused
the original mono/stereo FFmpeg-to-WASM tests and two-burst drain test to fail.
A one-second stereo diagnostic produced 47 audio packets; removing the input
nobuffer flag produced 51. The loss was in the encoder input, not in the
adaptive queue or WASM decoder. Even a 20 ms PCM input could emit no audio.

Only input nobuffer is removed. The raw PCM format, rate, channel count,
bounded probe size, low-delay flag, encoder settings and output flushing remain.
The buffer controller, Ogg parser, WASM payload and worklet are unchanged.
Version metadata/cache keys move from 1.6.4 to 1.6.5 for a coherent installation.

FFmpeg reference: https://ffmpeg.org/ffmpeg-formats.html#Format-Options

## Verification

Before the fix, all six new PCM preservation cases failed on FFmpeg 7.1.5.
They encode 20, 340 and 680 ms mono/stereo inputs through real FFmpeg/libopus,
then check Ogg end granules and actual decoded sample counts with the bundled
WASM decoder. End padding is allowed only within one 20 ms frame. These checks
do not loosen the original sample-count or packet-count assertions.

The additional live-input test requires an audio packet before stdin closes,
so retaining analysis packets must not turn live encoding into an EOF-only job.
All 13 FFmpeg-specific tests pass locally after the fix. The full 76-test suite
and endurance run separately; GitHub checks are authoritative for the final
commit. CI covers both Ubuntu 24.04 and Debian 13 and repeats the suites three
times. Package revisions are recorded, not assumed identical forever.

The historical 1.6.4 test evidence in CI.md remains historical. VERIFICATION.json
and the archive fingerprint describe the new runtime. Live browser playback
remains unverified; automated FFmpeg/WASM tests do not establish audible output,
native WebCodecs behavior or Windows service compatibility.

## Installation and staging

1. Preserve the current plugin files and FM-DX configuration, then stop FM-DX.
2. Extract packages/OPUS-Plugin-1.6.5.zip into the FM-DX root. It contains only
   the six plugins/ runtime files, including the required third-party notices.
3. Start FM-DX and hard-refresh the listener page. Check the logged encoder
   arguments, initial audio, mono/stereo playback, reconnects and MP3 fallback.
4. In a real browser, test WebCodecs and WASM paths, worklet and scheduler paths,
   suspend/resume and network interruptions. This remains a separate staging step.

This plugin update does not replace Node.js or FFmpeg on a production machine.
The Node security releases announced for 11 November 2026 were not yet published
when this change was prepared. No production service was accessed.
