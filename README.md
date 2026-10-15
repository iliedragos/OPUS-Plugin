# OPUS-Plugin

Opus audio streaming plugin for [FM-DX Webserver](https://github.com/NoobishSVK/fm-dx-webserver).

Current version: **1.6.4**.

## Features

- FFmpeg/libopus encoding over the existing audio WebSocket.
- WebCodecs decoding with a bundled WebAssembly decoder fallback.
- Adaptive playback buffering and bounded server/client queues.
- Media-clock estimation that filters temporary latency changes and packet bursts.
- Continuous playback when tuning between stations.
- Slow-client and stalled-encoder watchdogs, with MP3 fallback on decoder failure.
- Local playback diagnostics on the listening page; no false playback badge in admin Settings.

## Requirements

Use an existing FM-DX Webserver installation and its required Node.js version.
FFmpeg must provide the `libopus` encoder. Browser feature availability determines
whether WebCodecs, WebAssembly, or the native MP3 fallback is used.

The plugin was integration-tested against FM-DX Webserver commit
`447a4d618647ff4ddccdea241dffd301d3e384d4`, using Node.js 24 and FFmpeg 6.1.1.
Other server revisions require compatibility testing.

## Installation

1. Back up your existing plugin files.
2. Copy `plugins/opus.js` and the complete `plugins/opus/` directory into the
   corresponding `plugins/` directory of your FM-DX Webserver installation.
3. Enable **Opus Audio Streaming** in the server's plugin settings.
4. Restart FM-DX Webserver and reload the listening page with Ctrl+F5.

The repository's `tests/` and `package.json` are for development and are not
required inside the FM-DX Webserver installation. No core server files need editing.

To compare with the stock MP3/WAV path, append `?opus=0` to the listening URL
(or `&opus=0` when the URL already contains a query string).

## Development and tests

The tests use Node's built-in test runner and the bundled decoder. No npm
packages need installing. FFmpeg must be available on PATH.

From this repository's root, obtain the pinned server sources used by the tests:

```sh
git clone https://github.com/NoobishSVK/fm-dx-webserver.git .test-upstream
git -C .test-upstream checkout 447a4d618647ff4ddccdea241dffd301d3e384d4
npm test
npm run test:endurance
```

Alternatively, set `FM_DX_WEBSERVER_DIR` to an existing checkout of that server
revision. The fixture checkout is ignored by Git; its npm dependencies are not
needed for these isolated tests.

Version 1.6.4 passed 69 tests covering clock estimation, variable packet bursts,
real FFmpeg-to-WASM decoding, tuning continuity, admin scope, malformed input,
backpressure, recovery and cleanup. Endurance checks include one simulated hour
of scheduling, 2,000 reconnect cycles and one million small PCM insertions.
The browser/audio APIs are simulated in automated tests; live listening in the
target browser remains a separate validation step.

## Version 1.6.4

Improves media-clock estimation to reject false speed changes caused by latency
steps and varying packet batch sizes, while retaining compensation for genuine
clock differences. Buffer limits, decoder backends and tuning continuity remain
in place. The runtime files match the tested 1.6.4 distribution.

## Credits and third-party notices

The original plugin descriptor credits **mudkip**. That attribution is retained.
The bundled decoder and its notices are included in
[`plugins/opus/THIRD_PARTY_LICENSES.txt`](plugins/opus/THIRD_PARTY_LICENSES.txt).
Those notices describe the third-party components and their licenses.
