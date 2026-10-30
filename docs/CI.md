# CI verification

The [Verify OPUS workflow](../.github/workflows/verify.yml) runs on every push,
pull request (including fork PRs) and manual `workflow_dispatch`. Its two jobs
run the existing `npm test` and `npm run test:endurance` commands independently.
Each command runs three times in separate Node processes. All three executions
must pass; these are repetitions to expose instability, not retries after failure.
Bash runs with `-e -o pipefail`, so a failure stops that job even when piped to
`tee`. The other job continues. A job has a 15-minute limit.

## Environment and reproduction

| Input | Configuration |
| --- | --- |
| Runner | `ubuntu-24.04` |
| Node.js | `24.22.1` |
| FFmpeg | Ubuntu `ffmpeg` package; preflight requires the `libopus` encoder |
| Upstream fixture | `NoobishSVK/fm-dx-webserver` at `447a4d618647ff4ddccdea241dffd301d3e384d4` |
| Dependencies | Node built-ins and shipped decoder; no npm installation in either checkout |
| Actions | Checkout, setup-node and upload-artifact pinned to full commit SHAs |

The upstream revision is checked against both its actual Git HEAD and
`VERIFICATION.json`. The three 3LAS source files used by the frontend harness
must exist. The upstream server is never started; its dependencies are not
installed. No production server, receiver or credentials are used.

From a fresh plugin checkout on Ubuntu 24.04, with Node 24.22.1 available:

```sh
sudo apt-get update
sudo apt-get install --no-install-recommends -y ffmpeg
git clone https://github.com/NoobishSVK/fm-dx-webserver.git .test-upstream
git -C .test-upstream checkout --detach 447a4d618647ff4ddccdea241dffd301d3e384d4
export FM_DX_WEBSERVER_DIR="$PWD/.test-upstream"
test "$(git -C "$FM_DX_WEBSERVER_DIR" rev-parse HEAD)" = 447a4d618647ff4ddccdea241dffd301d3e384d4
ffmpeg -hide_banner -encoders
bash -eo pipefail <<'SH'
for attempt in 1 2 3; do
  npm test
done
for attempt in 1 2 3; do
  npm run test:endurance
done
SH
```

Check that the encoder listing contains `libopus`. The complete preflight,
including release SHA-256 validation, is in the workflow.

This fixes the fixture, Node version and action code, but is not a bit-for-bit
container image: GitHub updates the Ubuntu runner and Ubuntu package revisions
can change. Each job records Node/npm, FFmpeg/build details, FFmpeg/libopus package
versions, OS/kernel, runner image version, checked-out plugin/fixture commits and
runtime hashes. Use that evidence when comparing runs. Updating the fixture or
Node version should be an explicit reviewed workflow change.

## Evidence and failure handling

Each job uploads `verification-regression` or `verification-endurance` with a
14-day retention period, even after failure when files are available. They contain
environment metadata, encoder capabilities, the runtime hash manifest and each
attempt's output. A failure during checkout or installation may precede creation
of those files; inspect the Actions step logs in that case.

Before testing, the runtime hashes must match the historical release record in
`VERIFICATION.json`. After testing, the workflow checks the runtime manifest and
rejects tracked changes to `plugins/` or `VERIFICATION.json`. That record is not
rewritten by CI: `testsPassed: 69` and `liveBrowserVerified: false` describe the
original verification, not a newly generated CI result. A future intentional
runtime release must update its verification fingerprints through review.

The token has only `contents: read`, checkout credentials are not persisted, and
the workflow uses `pull_request`, not `pull_request_target`. No secrets are
required. Superseded runs of the same event/ref are cancelled; a push does not
cancel the corresponding pull request run.

## Automatic coverage and its limits

| Check | What actually executes | What it does not establish |
| --- | --- | --- |
| Regression | 69 existing cases covering configuration, parsing, buffering, recovery, connection lifecycle and frontend behavior | Complete upstream server or browser integration |
| FFmpeg integration | Real child processes encode PCM with `libopus`; shipped WASM decodes the resulting packets | Native browser WebCodecs behavior or audible output quality |
| Frontend/worklet | JavaScript VM harness with simulated DOM, Web Audio, timers and worklet rendering | Browser scheduling, audio hardware clocks, autoplay policies, secure contexts or background-tab throttling |
| Endurance | One simulated scheduler hour, 2,000 reset/reconnection cycles, worklet ring checks and 100 server pressure/reset cycles after warmup | An hour of real-time playback, real network reconnects or a complete process memory/CPU profile |

The endurance script checks bounded sources/timers, ring storage reuse and less
than 2 MiB retained heap growth in its server pressure loop with explicit GC.
Its elapsed time is informational. A passing result does not certify absence of
all memory leaks, CPU spikes or playback defects.

Potential instability to monitor: real FFmpeg process exit/drain events depend
on OS scheduling; the retained-heap assertion depends on V8/GC behavior. Most
frontend timing is simulated. Three green runs are useful evidence, not proof
that no test can be flaky. Do not hide failures with retries or loosen assertions
without diagnosing the failing attempt and preserving its environment/logs.

### Initial reproducibility check (2026-10-30)

The workflow's preflight, repetition and postflight shell blocks were also
executed locally with Node 24.22.1, Ubuntu 24.04 FFmpeg 6.1.1 and the pinned
fixture. All three regression runs passed 69/69 tests with zero skipped tests;
all three endurance runs passed. Each reported at most 18 active playback
sources, zero remaining sources/connection timers/server timers and a 384,000-byte
ring allocation. Retained heap deltas in the server loop were -29,480, -48,696 and
-29,480 bytes. No intermittent failure was observed in this sample.

Negative checks rejected an incorrect fixture revision and a modified runtime
file in a temporary copy. A piped-command failure stopped the repetition loop
immediately. SHA-256 comparison of every original tracked file confirmed that
only README changed; runtime, tests and `VERIFICATION.json` stayed identical.
These local results do not establish GitHub-hosted runner success; consult the
PR checks and their artifacts for that separate result.

Live playback remains **unverified**. A separate manual session is needed to
confirm actual audible output, WebCodecs and WASM fallback, AudioWorklet and
scheduler fallback, HTTPS/autoplay behavior, real network loss/recovery and
background/resume behavior across supported browsers. Record browser/OS versions,
selected paths, duration and observations separately; simulated test results
must never change `liveBrowserVerified` to `true`.
