/*
 * fm-dx-webserver :: Opus streaming plugin (server side)
 *
 * Adds an Opus fallback provider to the existing 3LAS StreamServer without
 * modifying fm-dx-webserver core files. PCM is encoded with FFmpeg/libopus,
 * Ogg is demuxed server-side, and bare Opus packets are sent over the existing
 * fallback WebSocket transport.
 */

'use strict';

const { spawn } = require('child_process');
const { performance } = require('perf_hooks');
const fs = require('fs');
const path = require('path');

const audioServer = require('../../server/stream/3las.server');
const checkFFmpeg = require('../../server/stream/checkFFmpeg');
const { serverConfig } = require('../../server/server_config');
const { logInfo, logError, logWarn, logDebug, logFfmpeg } = require('../../server/console');

const TAG = '[Opus Stream]';
const DEFAULT_OPUS_CONFIG = Object.freeze({
    bitrate: '96k',
    application: 'audio',
    frameDuration: '20',
    sampleRateOffset: 0
});
const VALID_APPLICATIONS = new Set(['audio', 'lowdelay', 'voip']);
const VALID_FRAME_DURATIONS = new Set(['2.5', '5', '10', '20', '40', '60']);
const MIN_BITRATE_BPS = 6000;
const MAX_BITRATE_PER_CHANNEL_BPS = 256000;
const MAX_SAMPLE_RATE_OFFSET_HZ = 1000;
const MIN_INPUT_SAMPLE_RATE_HZ = 8000;
const MAX_INPUT_SAMPLE_RATE_HZ = 384000;
const MAX_FAMILY0_OPUS_PACKET_BYTES = 61440;
const MAX_CLIENT_BUFFERED_BYTES = 64 * 1024;
const CLIENT_QUEUE_BUDGET_MS = 750;
const ENCODER_STALL_MS = 3000;
const MIN_PCM_BUDGET_MS = 750;
const MAX_PCM_BUDGET_MS = 1500;
const PCM_QUEUE_BLOCK_BYTES = 16384;
const PCM_BYTES_PER_SAMPLE = 2;
const EMPTY_PCM_BUFFER = Buffer.alloc(0);
const DEFAULT_ASSET_NAMES = Object.freeze(['opus-decoder.min.js', 'opus-worklet.js']);

function parseBitrate(value, maxBitrateBps = MAX_BITRATE_PER_CHANNEL_BPS * 2) {
    if (typeof value === 'number' && Number.isFinite(value)) {
        if (value < MIN_BITRATE_BPS || value > maxBitrateBps) return null;
        return `${Math.round(value / 1000)}k`;
    }
    if (typeof value !== 'string') return null;

    const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*([kKmM]?)$/);
    if (!match) return null;

    let bps = Number(match[1]);
    if (!Number.isFinite(bps)) return null;
    const unit = match[2].toLowerCase();
    if (unit === 'k') bps *= 1000;
    else if (unit === 'm') bps *= 1000000;

    if (bps < MIN_BITRATE_BPS || bps > maxBitrateBps) return null;
    return `${Math.round(bps / 1000)}k`;
}

function normalizeChannelCount(channels, warn = () => {}) {
    const channelCount = Number(channels);
    if (Number.isInteger(channelCount) && (channelCount === 1 || channelCount === 2)) return channelCount;
    warn(`Invalid channels=${String(channels)}; using stereo (2).`);
    return 2;
}

function normalizeOpusConfig(audio = {}, warn = () => {}, channels = 2) {
    const channelCount = normalizeChannelCount(channels, warn);
    const maxBitrateBps = MAX_BITRATE_PER_CHANNEL_BPS * channelCount;
    const result = { ...DEFAULT_OPUS_CONFIG };

    if (audio.opusBitrate !== undefined) {
        const bitrate = parseBitrate(audio.opusBitrate, maxBitrateBps);
        if (bitrate) result.bitrate = bitrate;
        else warn(`Invalid opusBitrate=${String(audio.opusBitrate)}; using ${DEFAULT_OPUS_CONFIG.bitrate}.`);
    }

    if (audio.opusApplication !== undefined) {
        const application = String(audio.opusApplication).toLowerCase();
        if (VALID_APPLICATIONS.has(application)) result.application = application;
        else warn(`Invalid opusApplication=${String(audio.opusApplication)}; using ${DEFAULT_OPUS_CONFIG.application}.`);
    }

    if (audio.opusFrameDuration !== undefined) {
        const frameDuration = String(audio.opusFrameDuration);
        if (VALID_FRAME_DURATIONS.has(frameDuration)) result.frameDuration = frameDuration;
        else warn(`Invalid opusFrameDuration=${String(audio.opusFrameDuration)}; using ${DEFAULT_OPUS_CONFIG.frameDuration}.`);
    }

    if (audio.samplerateOffset !== undefined) {
        const offset = Number(audio.samplerateOffset);
        if (Number.isFinite(offset) && Math.abs(offset) <= MAX_SAMPLE_RATE_OFFSET_HZ) {
            result.sampleRateOffset = offset;
        } else {
            warn(`Invalid samplerateOffset=${String(audio.samplerateOffset)}; using 0.`);
        }
    }

    if (Number(result.frameDuration) < 10 && result.application !== 'lowdelay') {
        warn(`opusFrameDuration=${result.frameDuration}ms requires restricted low-delay mode; using opusApplication=lowdelay.`);
        result.application = 'lowdelay';
    }

    return result;
}

function getEffectiveInputSampleRate(server, opusConfig) {
    const baseRate = Number(server.SampleRate);
    const inputRate = Math.round(baseRate + opusConfig.sampleRateOffset);
    if (!Number.isFinite(baseRate) || !Number.isFinite(inputRate) ||
        inputRate < MIN_INPUT_SAMPLE_RATE_HZ || inputRate > MAX_INPUT_SAMPLE_RATE_HZ) {
        throw new RangeError(`Invalid effective PCM input sample rate=${String(inputRate)} Hz.`);
    }
    return inputRate;
}

function buildFfmpegArguments(server, opusConfig) {
    const channels = String(server.Channels);
    const inRate = getEffectiveInputSampleRate(server, opusConfig);

    return [
        '-hide_banner',
        '-fflags', '+nobuffer+flush_packets', '-flags', 'low_delay',
        '-rtbufsize', '32', '-probesize', '32',
        '-f', 's16le',
        '-ar', String(inRate),
        '-ac', channels,
        '-i', 'pipe:0',
        '-c:a', 'libopus',
        '-ar', '48000',
        '-ac', channels,
        '-b:a', opusConfig.bitrate,
        '-vbr', 'on',
        '-application', opusConfig.application,
        '-frame_duration', opusConfig.frameDuration,
        '-f', 'ogg',
        '-page_duration', '1',
        '-flush_packets', '1',
        '-fflags', '+nobuffer',
        'pipe:1'
    ];
}

function parseOpusHead(head) {
    if (!head || head.length < 19) throw new Error('Invalid OpusHead: minimum length is 19 bytes.');
    const bytes = Buffer.isBuffer(head) ? head : Buffer.from(head);
    if (bytes.toString('ascii', 0, 8) !== 'OpusHead') throw new Error('Invalid OpusHead magic.');
    if (bytes[8] > 15) throw new Error(`Unsupported OpusHead version=${bytes[8]}.`);

    const channels = bytes[9];
    if (channels !== 1 && channels !== 2) throw new Error(`Unsupported OpusHead channel count=${channels}.`);

    const mappingFamily = bytes[18];
    if (mappingFamily !== 0) throw new Error(`Unsupported OpusHead mapping family=${mappingFamily}.`);

    return {
        channels,
        preSkip: bytes.readUInt16LE(10),
        inputSampleRate: bytes.readUInt32LE(12),
        outputGain: bytes.readInt16LE(16),
        mappingFamily
    };
}

function resolvedPath(filePath) {
    try {
        return fs.realpathSync(filePath);
    } catch (_) {
        try {
            return path.join(fs.realpathSync(path.dirname(filePath)), path.basename(filePath));
        } catch (_) {
            return path.resolve(filePath);
        }
    }
}

function isSafeAssetName(name) {
    return typeof name === 'string' &&
        name.length > 0 &&
        name !== '.' &&
        name !== '..' &&
        !name.includes('\0') &&
        !name.includes('/') &&
        !name.includes('\\') &&
        path.basename(name) === name;
}

function publishAssets(options = {}) {
    const pluginDir = options.pluginDir || __dirname;
    const webPluginDir = options.webPluginDir || path.join(__dirname, '../../web/js/plugins/opus');
    const assetNames = options.assetNames === undefined
        ? DEFAULT_ASSET_NAMES
        : (Array.isArray(options.assetNames) ? options.assetNames : []);
    const result = { published: 0, current: 0, missing: 0, failed: 0 };

    try {
        fs.mkdirSync(webPluginDir, { recursive: true });
    } catch (error) {
        logError(`${TAG} Failed to create asset directory ${webPluginDir}: ${error.message}`);
        result.failed += assetNames.length;
        return result;
    }

    for (const name of assetNames) {
        if (!isSafeAssetName(name)) {
            logWarn(`${TAG} Refusing unsafe asset name: ${String(name)}`);
            result.failed++;
            continue;
        }

        const src = path.join(pluginDir, name);
        const dst = path.join(webPluginDir, name);
        if (!fs.existsSync(src)) {
            logWarn(`${TAG} Asset missing: ${name} (WASM decoder path will be unavailable)`);
            result.missing++;
            continue;
        }

        let temporaryPath = null;
        try {
            if (resolvedPath(src) === resolvedPath(dst)) {
                result.current++;
                continue;
            }

            const srcStat = fs.statSync(src);
            if (!srcStat.isFile()) throw new Error(`source is not a regular file: ${src}`);

            let destinationStat = null;
            try {
                destinationStat = fs.lstatSync(dst);
            } catch (error) {
                if (error.code !== 'ENOENT') throw error;
            }

            if (destinationStat && !destinationStat.isFile()) {
                throw new Error(`refusing to replace non-regular destination: ${dst}`);
            }

            if (destinationStat && destinationStat.size === srcStat.size && fs.readFileSync(src).equals(fs.readFileSync(dst))) {
                logDebug(`${TAG} Asset already current: ${name}`);
                result.current++;
                continue;
            }

            temporaryPath = path.join(webPluginDir, `.${name}.tmp-${process.pid}-${Date.now()}`);
            fs.copyFileSync(src, temporaryPath, fs.constants.COPYFILE_EXCL);
            try {
                fs.renameSync(temporaryPath, dst);
                temporaryPath = null;
            } catch (error) {
                if (!destinationStat || !['EEXIST', 'EPERM', 'EACCES'].includes(error.code)) throw error;
                fs.unlinkSync(dst);
                fs.renameSync(temporaryPath, dst);
                temporaryPath = null;
            }
            logInfo(`${TAG} Published asset: ${name} (${srcStat.size} bytes)`);
            result.published++;
        } catch (error) {
            logError(`${TAG} Failed to publish ${name}: ${error.message}`);
            result.failed++;
        } finally {
            if (temporaryPath) {
                try {
                    fs.unlinkSync(temporaryPath);
                } catch (_) {
                    // Best-effort cleanup of an unpublished temporary asset.
                }
            }
        }
    }

    return result;
}

publishAssets();
/* ================================================================== */
/*  Minimal Ogg demuxer                                               */
/*                                                                    */
/*  Page layout (RFC 3533):                                           */
/*    0..3   "OggS"                                                   */
/*    4      stream structure version (0)                             */
/*    5      header type flags (0x01 continued / 0x02 BOS / 0x04 EOS) */
/*    6..13  granule position (int64 LE)                              */
/*    14..17 bitstream serial number                                  */
/*    18..21 page sequence number                                     */
/*    22..25 CRC32                                                    */
/*    26     page_segments (N)                                        */
/*    27..   segment table (N lacing values)                          */
/*                                                                    */
/*  A packet ends at the first lacing value < 255.                    */
/* ================================================================== */
class OggDemuxer {
    constructor(onPacket, options = {}) {
        this.OnPacket = onPacket;
        this.MaxBufferBytes = options.maxBufferBytes || 1024 * 1024;
        this.MaxPacketBytes = options.maxPacketBytes || MAX_FAMILY0_OPUS_PACKET_BYTES;
        this.Buffer = Buffer.alloc(0);
        this.Partial = null;
    }

    Reset() {
        this.Buffer = Buffer.alloc(0);
        this.Partial = null;
    }

    Push(chunk) {
        if (!chunk || chunk.length === 0) return;
        const input = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);

        if (this.Buffer.length + input.length > this.MaxBufferBytes) {
            logWarn(`${TAG} Ogg input buffer exceeded ${this.MaxBufferBytes} bytes; resynchronizing.`);
            this.Buffer = Buffer.alloc(0);
            this.Partial = null;
        }

        const boundedInput = input.length > this.MaxBufferBytes
            ? input.subarray(input.length - this.MaxBufferBytes)
            : input;
        this.Buffer = this.Buffer.length
            ? Buffer.concat([this.Buffer, boundedInput])
            : Buffer.from(boundedInput);
        this.Parse();
    }

    Parse() {
        let offset = 0;
        const buf = this.Buffer;

        for (;;) {
            if (buf.length - offset < 27) break;

            if (!(buf[offset] === 0x4F && buf[offset + 1] === 0x67 &&
                  buf[offset + 2] === 0x67 && buf[offset + 3] === 0x53 &&
                  buf[offset + 4] === 0x00)) {
                const idx = buf.indexOf('OggS', offset + 1, 'latin1');
                if (idx < 0) {
                    offset = Math.max(offset, buf.length - 3);
                    break;
                }
                logDebug(`${TAG} Ogg resync, dropped ${idx - offset} bytes`);
                offset = idx;
                this.Partial = null;
                continue;
            }

            const segCount = buf[offset + 26];
            const headerLen = 27 + segCount;
            if (buf.length - offset < headerLen) break;

            const lacing = buf.subarray(offset + 27, offset + headerLen);
            let payloadLen = 0;
            for (let i = 0; i < segCount; i++) payloadLen += lacing[i];
            if (buf.length - offset < headerLen + payloadLen) break;

            const continued = (buf[offset + 5] & 0x01) !== 0;
            const payload = buf.subarray(offset + headerLen, offset + headerLen + payloadLen);

            let acc = [];
            let accLen = 0;
            let droppingPacket = false;

            if (continued) {
                if (this.Partial) {
                    acc.push(this.Partial);
                    accLen = this.Partial.length;
                } else {
                    droppingPacket = true;
                }
            }
            this.Partial = null;

            let payloadOffset = 0;
            for (let i = 0; i < segCount; i++) {
                const length = lacing[i];
                const segment = payload.subarray(payloadOffset, payloadOffset + length);
                payloadOffset += length;

                if (droppingPacket) {
                    if (length < 255) droppingPacket = false;
                    continue;
                }

                if (accLen + length > this.MaxPacketBytes) {
                    logWarn(`${TAG} Dropping oversized Ogg packet (> ${this.MaxPacketBytes} bytes).`);
                    acc = [];
                    accLen = 0;
                    droppingPacket = length === 255;
                    continue;
                }

                if (length > 0) {
                    acc.push(segment);
                    accLen += length;
                }

                if (length < 255) {
                    if (accLen > 0) this.OnPacket(Buffer.concat(acc, accLen));
                    acc = [];
                    accLen = 0;
                }
            }

            if (!droppingPacket && accLen > 0) {
                this.Partial = Buffer.concat(acc, accLen);
            }

            offset += headerLen + payloadLen;
        }

        this.Buffer = offset ? Buffer.from(buf.subarray(offset)) : buf;
        if (this.Buffer.length > this.MaxBufferBytes) {
            logWarn(`${TAG} Ogg retained buffer exceeded limit; clearing parser state.`);
            this.Reset();
        }
    }
}

/* ================================================================== */
/*  Opus fallback provider                                            */
/* ================================================================== */
class OpusProvider {
    constructor(server, ffmpegPath) {
        this.Server = server;
        this.FFmpegPath = ffmpegPath;
        this.OpusConfig = normalizeOpusConfig(
            serverConfig.audio || {},
            (message) => logWarn(`${TAG} ${message}`),
            server.Channels
        );
        this.OpusHead = null;
        this.Process = null;
        this.RestartTimer = null;
        this.StableTimer = null;
        this.RestartDelayMs = 2000;
        this.MaxRestartDelayMs = 60000;
        this.StableWindowMs = 30000;
        const channelCount = normalizeChannelCount(server.Channels);
        const inputRate = getEffectiveInputSampleRate(server, this.OpusConfig);

        this.PcmBytesPerSecond = inputRate * channelCount * PCM_BYTES_PER_SAMPLE;
        this.PcmFrameBytes = channelCount * PCM_BYTES_PER_SAMPLE;
        this.PcmBurstMs = 0;
        this.PcmBudgetMs = MIN_PCM_BUDGET_MS;
        this.PendingPcmFrames = [];
        this.PendingPcmBytes = 0;
        this.PcmPartial = EMPTY_PCM_BUFFER;
        this.PcmBackpressured = false;
        this.PcmBackpressureEvents = 0;
        this.DroppedPcmBytes = 0;
        this.UnreportedDroppedPcmBytes = 0;
        this.MaxPendingPcmBytesObserved = 0;
        this.LastPcmDropWarnAt = 0;
        this.Demux = new OggDemuxer(this.OnPacket.bind(this));
        this.ClientState = new WeakMap();
        this.Disposed = false;
        this.RetiringProcess = null;
        this.KillTimer = null;
        this.LastPcmInputAt = null;
        this.LastEncodedAt = performance.now();
        this.RateWindowAt = performance.now();
        this.RateWindowBytes = 0;
        this.TransportBytesPerSecond = Math.max(750, Number.parseFloat(this.OpusConfig.bitrate) * 125);
        this.Watchdog = setInterval(() => this.CheckHealth(), 250);
        if (this.Watchdog && typeof this.Watchdog.unref === 'function') this.Watchdog.unref();
        this.Spawn();
    }

    GetFFmpegArguments() {
        return buildFfmpegArguments(this.Server, this.OpusConfig);
    }

    ClearStableTimer() {
        if (!this.StableTimer) return;
        clearTimeout(this.StableTimer);
        this.StableTimer = null;
    }

    ScheduleStableReset(processRef) {
        this.ClearStableTimer();
        this.StableTimer = setTimeout(() => {
            this.StableTimer = null;
            if (this.Process === processRef) {
                this.RestartDelayMs = 2000;
            }
        }, this.StableWindowMs);
    }

    ScheduleRestart(reason) {
        if (this.Disposed) return;
        if (this.RestartTimer) return;
        this.ClearStableTimer();

        const delay = this.RestartDelayMs;
        this.RestartDelayMs = Math.min(this.RestartDelayMs * 2, this.MaxRestartDelayMs);
        logWarn(`${TAG} Opus encoder unavailable (${reason}). Restarting in ${delay / 1000}s...`);

        this.RestartTimer = setTimeout(() => {
            this.RestartTimer = null;
            this.Spawn();
        }, delay);
    }

    HandleEncoderTermination(processRef, reason, logMessage, killProcess = false) {
        if (this.Process !== processRef) return false;
        this.Process = null;
        this.ResetPcmPipeline();
        this.ClearStableTimer();
        if (logMessage) logMessage();
        if (killProcess) this.RetireProcess(processRef);
        this.ScheduleRestart(reason);
        return true;
    }

    RetireProcess(processRef) {
        if (!processRef || typeof processRef.kill !== 'function') return;
        if (processRef.pid) {
            this.RetiringProcess = processRef;
            processRef.once('exit', () => {
                if (this.RetiringProcess !== processRef) return;
                this.RetiringProcess = null;
                if (this.KillTimer) clearTimeout(this.KillTimer);
                this.KillTimer = null;
            });
            this.KillTimer = setTimeout(() => {
                this.KillTimer = null;
                if (this.RetiringProcess !== processRef) return;
                try { processRef.kill('SIGKILL'); } catch (_) {}
            }, 1000);
            if (this.KillTimer && typeof this.KillTimer.unref === 'function') this.KillTimer.unref();
        }
        try { processRef.kill(); } catch (_) {}
    }

    Spawn() {
        if (this.Disposed) return;
        if (this.RetiringProcess) { this.ScheduleRestart('waiting for previous encoder to exit'); return; }
        this.LastPcmInputAt = null;
        this.LastEncodedAt = performance.now();
        const args = this.GetFFmpegArguments();
        logDebug(`${TAG} Launching FFmpeg with args: ${args.join(' ')}`);

        this.Demux.Reset();
        this.OpusHead = null;
        this.ResetPcmPipeline();

        let processRef;
        try {
            processRef = spawn(this.FFmpegPath, args, {
                shell: false,
                detached: false,
                stdio: ['pipe', 'pipe', 'pipe']
            });
        } catch (error) {
            logError(`${TAG} FFmpeg spawn threw: ${error.message}`);
            this.ScheduleRestart('spawn failure');
            return;
        }

        this.Process = processRef;
        this.ScheduleStableReset(processRef);

        processRef.stdout.on('data', (chunk) => {
            if (this.Process === processRef) this.Demux.Push(chunk);
        });
        processRef.stderr.on('data', (data) => logFfmpeg(`[FFmpeg opus stderr]: ${data}`));
        processRef.stdin.on('drain', () => {
            if (this.Process !== processRef) return;
            this.PcmBackpressured = false;
            this.FlushPcmQueue(processRef);
        });
        processRef.stdin.on('error', (error) => {
            const shouldLog = error && error.code !== 'EPIPE';
            this.HandleEncoderTermination(
                processRef,
                'stdin error',
                shouldLog ? () => logWarn(`${TAG} stdin error: ${error.message}`) : null,
                true
            );
        });
        processRef.on('error', (error) => {
            this.HandleEncoderTermination(
                processRef,
                'process error',
                () => logError(`${TAG} FFmpeg spawn error: ${error.message}`),
                true
            );
        });
        processRef.on('exit', (code, signal) => {
            this.HandleEncoderTermination(
                processRef,
                `exit code ${code}`,
                () => logFfmpeg(`[FFmpeg opus exited] code=${code} signal=${signal}`)
            );
        });
    }

    ResetPcmPipeline() {
        this.PcmBackpressured = false;
        this.PendingPcmFrames.length = 0;
        this.PendingPcmBytes = 0;
        this.PcmPartial = EMPTY_PCM_BUFFER;
        this.PcmBurstMs = 0;
        this.PcmBudgetMs = MIN_PCM_BUDGET_MS;
    }

    PcmBytesToMs(bytes) {
        if (!Number.isFinite(this.PcmBytesPerSecond) || this.PcmBytesPerSecond <= 0) return 0;
        return Math.round((bytes * 1000) / this.PcmBytesPerSecond);
    }

    NoteBackpressure() {
        this.PcmBackpressured = true;
        this.PcmBackpressureEvents += 1;
    }

    PipePcmBytes() {
        const bytes = this.Process && this.Process.stdin && this.Process.stdin.writableLength;
        return Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
    }

    TrimPcmQueue(bytes) {
        let remaining = Math.ceil(bytes / this.PcmFrameBytes) * this.PcmFrameBytes;
        let dropped = 0;
        while (remaining > 0 && this.PendingPcmFrames.length) {
            const block = this.PendingPcmFrames[0];
            const length = block.end - block.start;
            const take = Math.min(length, remaining);
            block.start += take;
            this.PendingPcmBytes -= take;
            remaining -= take;
            dropped += take;
            if (block.start === block.end) this.PendingPcmFrames.shift();
        }
        this.RecordPcmDrop(dropped);
    }

    QueuePcmFrame(frame) {
        // Fixed-size blocks also bound object count for tiny input chunks. Never
        // retain subarrays of a potentially huge or mutable source allocation.
        for (let offset = 0; offset < frame.length;) {
            let block = this.PendingPcmFrames[this.PendingPcmFrames.length - 1];
            if (!block || block.end === block.buffer.length) {
                block = {buffer:Buffer.allocUnsafe(PCM_QUEUE_BLOCK_BYTES),start:0,end:0};
                this.PendingPcmFrames.push(block);
            }
            const take = Math.min(frame.length - offset, block.buffer.length - block.end);
            frame.copy(block.buffer, block.end, offset, offset + take);
            block.end += take;
            offset += take;
            this.PendingPcmBytes += take;
        }
        this.MaxPendingPcmBytesObserved = Math.max(this.MaxPendingPcmBytesObserved, this.PendingPcmBytes);
    }

    RecordPcmDrop(bytes) {
        if (!Number.isFinite(bytes) || bytes <= 0) return;
        this.DroppedPcmBytes += bytes;
        this.UnreportedDroppedPcmBytes += bytes;
    }

    WritePcmFrame(processRef, frame) {
        try {
            if (!processRef.stdin.write(frame)) this.NoteBackpressure();
            return true;
        } catch (error) {
            const shouldLog = error && error.code !== 'EPIPE';
            this.HandleEncoderTermination(
                processRef,
                'stdin write failure',
                shouldLog ? () => logWarn(`${TAG} PCM write failed: ${error.message}`) : null,
                true
            );
            return false;
        }
    }

    FlushPcmQueue(processRef) {
        while (this.Process === processRef && processRef.stdin && processRef.stdin.writable &&
               !this.PcmBackpressured && this.PendingPcmFrames.length > 0) {
            const block = this.PendingPcmFrames.shift();
            const frame = block.buffer.subarray(block.start, block.end);
            this.PendingPcmBytes -= frame.length;
            if (!this.WritePcmFrame(processRef, frame)) {
                this.RecordPcmDrop(frame.length);
                return;
            }
        }
    }

    MaybeWarnPcmDrop() {
        if (this.UnreportedDroppedPcmBytes <= 0) return;
        const now = Date.now();
        if (this.LastPcmDropWarnAt !== 0 && now - this.LastPcmDropWarnAt < 5000) return;

        const droppedBytes = this.UnreportedDroppedPcmBytes;
        this.UnreportedDroppedPcmBytes = 0;
        this.LastPcmDropWarnAt = now;
        logWarn(`${TAG} PCM queue overflow: pending=${this.PcmBytesToMs(this.PendingPcmBytes)}ms ` +
                `dropped=${this.PcmBytesToMs(droppedBytes)}ms ` +
                `totalDropped=${this.PcmBytesToMs(this.DroppedPcmBytes)}ms ` +
                `pipe=${this.PcmBytesToMs(this.PipePcmBytes())}ms ` +
                `budget=${Math.round(this.PcmBudgetMs)}ms burst=${Math.round(this.PcmBurstMs)}ms ` +
                `maxPending=${this.PcmBytesToMs(this.MaxPendingPcmBytesObserved)}ms ` +
                `backpressureEvents=${this.PcmBackpressureEvents}.`);
    }

    HandlePcmFrame(processRef, frame) {
        const budget = Math.floor(this.PcmBytesPerSecond * this.PcmBudgetMs / 1000 / this.PcmFrameBytes) * this.PcmFrameBytes;
        const available = Math.max(0, budget - this.PipePcmBytes());
        this.TrimPcmQueue(Math.max(0, this.PendingPcmBytes + frame.length - available));
        const keep = Math.floor(Math.max(0, available - this.PendingPcmBytes) / this.PcmFrameBytes) * this.PcmFrameBytes;
        if (frame.length > keep) {
            this.RecordPcmDrop(frame.length - keep);
            frame = frame.subarray(frame.length - keep);
        }
        if (!frame.length) return;
        if (this.PcmBackpressured || this.PendingPcmFrames.length) this.QueuePcmFrame(frame);
        else if (!this.WritePcmFrame(processRef, Buffer.from(frame))) this.RecordPcmDrop(frame.length);
    }

    InsertData(buffer) {
        if (!Buffer.isBuffer(buffer) || buffer.length === 0) return;
        const processRef = this.Process;
        if (!processRef || !processRef.stdin || !processRef.stdin.writable) return;

        const now = performance.now();
        const elapsed = this.LastPcmInputAt === null ? 0 : Math.max(0, now - this.LastPcmInputAt);
        this.PcmBurstMs = Math.max(buffer.length * 1000 / this.PcmBytesPerSecond,
            this.PcmBurstMs * Math.exp(-elapsed / 30000));
        this.PcmBudgetMs = Math.min(MAX_PCM_BUDGET_MS, Math.max(MIN_PCM_BUDGET_MS, this.PcmBurstMs * 2 + 250));
        this.LastPcmInputAt = now;
        let source = buffer;
        if (this.PcmPartial.length) {
            const needed = this.PcmFrameBytes - this.PcmPartial.length;
            const take = Math.min(needed, source.length);
            const joined = Buffer.concat([this.PcmPartial, source.subarray(0, take)]);
            source = source.subarray(take);
            if (joined.length < this.PcmFrameBytes) {
                this.PcmPartial = joined;
                return;
            }
            this.PcmPartial = EMPTY_PCM_BUFFER;
            this.HandlePcmFrame(processRef, joined);
            if (this.Process !== processRef) return;
        }
        const aligned = source.length - source.length % this.PcmFrameBytes;
        if (aligned) this.HandlePcmFrame(processRef, aligned === source.length ? source : source.subarray(0, aligned));
        if (this.Process !== processRef) return;
        this.PcmPartial = aligned === source.length ? EMPTY_PCM_BUFFER : Buffer.from(source.subarray(aligned));
        this.MaybeWarnPcmDrop();
    }

    OnPacket(pkt) {
        if (pkt.length >= 8) {
            const magic = pkt.toString('latin1', 0, 8);
            if (magic === 'OpusHead') {
                try {
                    parseOpusHead(pkt);
                } catch (error) {
                    logWarn(`${TAG} Dropping invalid OpusHead: ${error.message}`);
                    return;
                }
                this.OpusHead = pkt;
                const live = this.Server.FallbackClients.opus;
                if (live) live.forEach((client) => this.SendHead(client));
                return;
            }
            if (magic === 'OpusTags') return;
        }
        if (!this.OpusHead) return;
        const now = performance.now();
        this.LastEncodedAt = now;
        this.RateWindowBytes += pkt.length;
        const elapsed = now - this.RateWindowAt;
        if (elapsed >= 1000) {
            const measured = this.RateWindowBytes * 1000 / elapsed;
            this.TransportBytesPerSecond = Math.max(750, .8 * this.TransportBytesPerSecond + .2 * measured);
            this.RateWindowBytes = 0;
            this.RateWindowAt = now;
        }
        const live = this.Server.FallbackClients.opus;
        if (live) live.forEach((client) => this.SendPacket(client, pkt));
    }

    TrackClient(client) {
        if (this.ClientState.has(client)) return;
        const state = { pressureAt: null, close: () => this.Server.DestroyClient(client) };
        this.ClientState.set(client, state);
        if (client.Socket && typeof client.Socket.once === 'function') client.Socket.once('close', state.close);
    }

    ForgetClient(client) {
        const state = this.ClientState.get(client);
        if (state && client.Socket && typeof client.Socket.removeListener === 'function') client.Socket.removeListener('close', state.close);
        this.ClientState.delete(client);
    }

    DropClient(client) {
        try { this.Server.DestroyClient(client); } catch (_) {
            this.ForgetClient(client);
            this.Server.FallbackClients.opus.delete(client);
            if (this.Server.Clients) this.Server.Clients.delete(client);
        }
        // A closing handshake may remain behind stalled audio for many seconds.
        if (client.Socket && typeof client.Socket.terminate === 'function') {
            try { client.Socket.terminate(); } catch (_) {}
        }
    }

    CheckClient(client, incomingBytes = 0) {
        const socket = client.Socket;
        if (!socket || (socket.readyState !== undefined && socket.readyState !== 1)) {
            this.DropClient(client);
            return false;
        }
        const buffered = Number(socket.bufferedAmount) || 0;
        const rate = this.TransportBytesPerSecond;
        const hardBytes = Math.min(MAX_CLIENT_BUFFERED_BYTES, Math.max(16 * 1024, rate));
        const state = this.ClientState.get(client);
        const now = performance.now();
        if (state) {
            if (buffered > rate * .20) {
                if (state.pressureAt === null) state.pressureAt = now;
            } else state.pressureAt = null;
        }
        if (buffered + incomingBytes > hardBytes ||
            (state && state.pressureAt !== null && now - state.pressureAt >= CLIENT_QUEUE_BUDGET_MS)) {
            this.DropClient(client);
            return false;
        }
        return true;
    }

    CheckHealth() {
        if (this.Disposed) return;
        const now = performance.now();
        if (this.Process && this.LastPcmInputAt !== null && now - this.LastPcmInputAt < 500 &&
            now - this.LastEncodedAt >= ENCODER_STALL_MS) {
            this.HandleEncoderTermination(this.Process, 'encoder stalled',
                () => logWarn(`${TAG} Encoder stopped producing packets while PCM input is active.`), true);
        }
        const live = this.Server.FallbackClients.opus;
        if (live) for (const client of live) this.CheckClient(client);
    }

    Dispose() {
        if (this.Disposed) return;
        this.Disposed = true;
        clearInterval(this.Watchdog);
        this.ClearStableTimer();
        if (this.RestartTimer) clearTimeout(this.RestartTimer);
        this.RestartTimer = null;
        const processRef = this.Process;
        this.Process = null;
        if (processRef) this.RetireProcess(processRef);
        this.ResetPcmPipeline();
        this.Demux.Reset();
        this.OpusHead = null;
        const live = this.Server.FallbackClients.opus;
        if (live) for (const client of live) this.ForgetClient(client);
    }

    SendPacket(client, packet) {
        try {
            if (!this.CheckClient(client, packet.length)) return;
            client.SendBinary(packet);
        } catch (_) {
            // A failed client must never prevent other listeners receiving audio.
            this.DropClient(client);
        }
    }

    SendHead(client) {
        if (this.OpusHead) this.SendPacket(client, this.OpusHead);
    }

    PrimeClient(client) {
        if (this.OpusHead) this.SendHead(client);
    }
}

/* ================================================================== */
/*  Injection into the live StreamServer instance                     */
/* ================================================================== */
const SERVER_PATCH_MARKER = '__fmDxOpusServerPatch';

function removeClientFromFallbackSets(server, client) {
    if (!server.FallbackClients) return;
    for (const clients of Object.values(server.FallbackClients)) {
        if (clients && typeof clients.delete === 'function') clients.delete(client);
    }
}

function installServerHooks(server, ffmpegPath) {
    if (!server) {
        logError(`${TAG} 3LAS StreamServer instance unavailable — plugin disabled.`);
        return null;
    }

    if (server[SERVER_PATCH_MARKER]) {
        logDebug(`${TAG} Server hooks already installed — skipping duplicate patch.`);
        return server[SERVER_PATCH_MARKER].provider;
    }

    if (!server.FallbackClients) server.FallbackClients = {};
    if (!server.FallbackProvider) server.FallbackProvider = {};
    if (!server.FallbackClients.opus) server.FallbackClients.opus = new Set();

    if (server.FallbackProvider.opus) {
        logWarn(`${TAG} Existing Opus provider detected without plugin marker — leaving server unchanged.`);
        return server.FallbackProvider.opus;
    }

    const provider = new OpusProvider(server, ffmpegPath);
    server.FallbackProvider.opus = provider;

    const originalSetFallback = server.SetFallback.bind(server);
    const originalDestroyClient = server.DestroyClient.bind(server);
    const originalGetStats = server.GetStats.bind(server);

    server.SetFallback = function setFallbackWithOpus(client, format) {
        provider.ForgetClient(client);
        removeClientFromFallbackSets(server, client);
        if (format === 'opus') {
            provider.TrackClient(client);
            server.FallbackClients.opus.add(client);
            provider.PrimeClient(client);
            return;
        }
        return originalSetFallback(client, format);
    };

    server.DestroyClient = function destroyClientWithOpus(client) {
        provider.ForgetClient(client);
        server.FallbackClients.opus.delete(client);
        return originalDestroyClient(client);
    };

    server.GetStats = function getStatsWithOpus() {
        const stats = originalGetStats();
        if (!stats.Fallback) stats.Fallback = {};
        stats.Fallback.opus = server.FallbackClients.opus.size;
        stats.Total = Object.values(stats.Fallback)
            .reduce((total, value) => total + (Number(value) || 0), 0);
        return stats;
    };

    if (server.Server && typeof server.Server.once === 'function') server.Server.once('close', () => provider.Dispose());

    Object.defineProperty(server, SERVER_PATCH_MARKER, {
        configurable: false,
        enumerable: false,
        writable: false,
        value: { provider }
    });

    return provider;
}

audioServer.waitUntilReady
    .then(() => checkFFmpeg())
    .then((ffmpegPath) => {
        const server = audioServer.Server;
        const provider = installServerHooks(server, ffmpegPath);
        if (!provider || !server) return;

        logInfo(`${TAG} Opus provider active — ${provider.OpusConfig.bitrate} ` +
                `${server.Channels === 1 ? 'mono' : 'stereo'}, ` +
                `${provider.OpusConfig.frameDuration}ms frames, application=${provider.OpusConfig.application}`);
    })
    .catch((error) => {
        logError(`${TAG} Initialisation failed: ${error && error.message ? error.message : error}`);
    });


if (process.env.NODE_ENV === 'test') {
    module.exports.__test = {
        DEFAULT_OPUS_CONFIG,
        normalizeChannelCount,
        normalizeOpusConfig,
        getEffectiveInputSampleRate,
        buildFfmpegArguments,
        parseOpusHead,
        isSafeAssetName,
        publishAssets,
        OggDemuxer,
        OpusProvider,
        removeClientFromFallbackSets,
        installServerHooks
    };
}
