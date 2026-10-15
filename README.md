# OPUS-Plugin

Opus streaming for [FM-DX Webserver](https://github.com/NoobishSVK/fm-dx-webserver).

Original developer: **mudkip**. Version: **1.6.4**.

FFmpeg/libopus encodes the PCM feed and sends Opus packets over the existing
audio WebSocket. The client uses WebCodecs or the bundled WASM decoder, with
adaptive buffering and clock correction. Tuning does not reset playback.

## Bitrate

Set `audio.opusBitrate` in the active server configuration: `config.json`, or
the configuration file selected with `--config`.

```json
{
  "audio": {
    "opusBitrate": "128k"
  }
}
```

Add the key to your existing `audio` object; keep its other settings.
Stop the server before editing the file, then restart it to apply the change.
Check the `[Opus Stream] Opus provider active` startup log for the applied bitrate.

- Default: `96k`.
- Examples: `128k`, `192k`, `256k`. Numeric values are interpreted as bits/s, e.g. `128000`.
- Accepted range: 6–256 kbps for mono, 6–512 kbps for stereo.
- The value is the total stream bitrate, not a per-channel setting.
- VBR is enabled. The configured bitrate is a target; actual traffic varies.
- Invalid values fall back to `96k` and produce a warning.

## Debugging

Click the audio badge on the listening page for decoder and buffer statistics.
The badge is disabled in admin Settings.

Use `?opus=0` to bypass Opus for the current page, or `&opus=0` if the URL already
has query parameters.

## Tests

Set `FM_DX_WEBSERVER_DIR` to a server source checkout. The fixture revision is
recorded in [VERIFICATION.json](VERIFICATION.json). FFmpeg with `libopus` must be
on PATH. Tests use Node's built-in runner; no npm dependencies are needed.

```sh
npm test
npm run test:endurance
```

Third-party decoder licenses: [THIRD_PARTY_LICENSES.txt](plugins/opus/THIRD_PARTY_LICENSES.txt).
