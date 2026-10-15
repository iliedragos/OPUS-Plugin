# OPUS-Plugin

Opus audio streaming for [FM-DX Webserver](https://github.com/NoobishSVK/fm-dx-webserver).

Original developer: **mudkip**. Version: **1.6.4**.

## How it works

The server feeds raw PCM audio into a shared FFmpeg process. FFmpeg encodes it
with `libopus`, using 20 ms frames and variable bitrate (VBR) by default. The
plugin extracts the Opus packets from FFmpeg's Ogg output and sends them through
the existing FM-DX audio WebSocket. Listeners share the encoder; connecting
another listener does not start another FFmpeg process.

In the browser, the plugin selects WebCodecs when available and falls back to
the bundled WebAssembly decoder. Decoded PCM is played through Web Audio, using
an AudioWorklet when supported or an AudioBufferSourceNode scheduler otherwise.
Both decoder paths use the same adaptive buffer controller.

The controller tracks packet timing and buffer occupancy, adjusts the buffer
within bounded limits, and corrects sustained clock drift. Short bursts of
network jitter are filtered out before changing playback speed. Changing the
station keeps the audio pipeline running rather than clearing the buffer.

Server watchdogs detect stalled encoders and persistent client backlogs.
Queues are bounded, and slow connections are handled independently of other
listeners. If Opus cannot be used, the client can fall back to the server's
native MP3 playback. Network outages can still interrupt audio.

## Dependencies and libraries

| Component | Used for | Provided by |
| --- | --- | --- |
| Node.js | Server hooks, encoder lifecycle and packet delivery | Existing FM-DX installation |
| FFmpeg with the `libopus` encoder | PCM-to-Opus encoding | FFmpeg executable resolved by FM-DX |
| FM-DX audio server / 3LAS | PCM source, WebSocket transport and native fallback | Existing FM-DX installation |
| WebCodecs | Native browser Opus decoding | Browser, when supported |
| `opus-decoder` from [wasm-audio-decoders](https://github.com/eshaz/wasm-audio-decoders) | WebAssembly decoding fallback, based on libopus | Bundled `opus-decoder.min.js` |
| Web Audio / AudioWorklet | PCM playback, buffering and sample-rate conversion | Browser; worklet code is bundled |

There are no additional npm packages to install for the plugin. The WASM decoder
is included in the bundle; no separate decoder build or download is required.
Use the Node.js version supported by your FM-DX release. FFmpeg must include
`libopus`; a separate system installation of the libopus development library is
not required when FFmpeg already provides the encoder.

WebCodecs and AudioWorklet availability depends on the browser and secure-context
support. Serve the listening page over HTTPS to make these paths available on
remote clients. The plugin retains decoder and playback fallbacks where supported.

Third-party notices, including the decoder's MIT, libopus BSD and puff/zlib
licenses, are in [THIRD_PARTY_LICENSES.txt](plugins/opus/THIRD_PARTY_LICENSES.txt).

## Plugin installation

1. Stop FM-DX Webserver.
2. Copy this repository's `plugins/opus.js` and entire `plugins/opus/` directory
   into the server's `plugins/` directory. When upgrading, replace all plugin
   files together so the server, frontend, decoder and worklet versions match.
3. Start the server and enable **Opus Audio Streaming** in the admin plugin
   settings. Restart the server after enabling it.
4. Reload the listening page. If upgrading, use a hard refresh to discard cached
   frontend files.

The installed files should be:

```text
plugins/
  opus.js
  opus/
    frontend.js
    frontend_server.js
    opus-decoder.min.js
    opus-worklet.js
    THIRD_PARTY_LICENSES.txt
```

The plugin loader and server module publish the browser assets under
`web/js/plugins/opus/`. Do not copy files there manually. The repository's tests,
`package.json` and verification records are not needed for a runtime installation.

Look for `[Opus Stream] Opus provider active` in the startup log. It includes the
applied bitrate, channel count and frame duration. On the listening page, the
audio badge shows the active playback path.

## Bitrate

Stop the server, open `config.json`, and add `"opusBitrate": "192k"` inside its
existing `audio` object. Keep the other audio settings and use valid JSON commas.
For example, the relevant part of the configuration is:

```json
{
  "audio": {
    "opusBitrate": "192k"
  }
}
```

If the server uses `--config`, edit that configuration file instead. Restart the
server to apply the setting, then check the bitrate in the startup log.

### Choosing a bitrate

| Value | Use |
| --- | --- |
| `96k` | Plugin default; lower bandwidth |
| `128k` | More headroom while keeping traffic modest |
| `192k` | Recommended here for high-quality stereo listening |
| `256k` | Practical upper recommendation here when quality takes priority over bandwidth |

For the best-quality configuration recommended by this project, use **`256k`**
for stereo. `192k` is a reasonable everyday choice. These are conservative
project recommendations, not an official Opus quality ceiling: the result also
depends on the source, and a higher bitrate does not guarantee an audible
improvement. Xiph's [recommended Opus settings](https://wiki.xiph.org/Opus_Recommended_Settings)
use lower targets for typical stereo streaming and music storage.

The plugin's validation range is 6–256 kbps for mono and 6–512 kbps for stereo.
Those are accepted configuration limits, not recommended operating targets.
The value applies to the whole stream, not each channel. Numeric values are
interpreted as bits/s, so `192000` is equivalent to `"192k"`.

VBR is enabled by default: this is a target bitrate, and actual traffic varies.
If `opusBitrate` is absent, the default remains `96k`. Invalid values produce a
warning and fall back to `96k`.

## Diagnostics

Click the audio badge on the listening page for decoder and buffer statistics.
The badge is disabled in admin Settings, where there is no local playback session.

Use `?opus=0` to bypass Opus for the current page, or `&opus=0` if the URL already
has query parameters. This is useful when comparing against native playback.

## Development and tests

Tests use Node's built-in test runner and require no npm dependencies. FFmpeg
with `libopus` must be on PATH for the encoder integration tests.

Point `FM_DX_WEBSERVER_DIR` at an existing FM-DX source checkout. The fixture
revision used for verification is recorded in [VERIFICATION.json](VERIFICATION.json).
From this repository, run:

```sh
export FM_DX_WEBSERVER_DIR=/path/to/fm-dx-webserver
npm test
npm run test:endurance
```

The suite covers configuration validation, packet parsing, bounded queues,
watchdog recovery, client cleanup, asset publication, decoder paths and clock
correction. The endurance test exercises repeated connections and long-running
buffer control with simulated time; it does not replace listening tests in a
real browser.
