/*
 * fm-dx-webserver :: Opus streaming plugin (client side)
 *
 * Adds Opus to the existing 3LAS fallback negotiation without modifying
 * fm-dx-webserver core files. The wire format is one OpusHead packet followed
 * by bare Opus packets over the existing /audio WebSocket.
 *
 * Decode backends:
 *   - WebCodecs: preferred; direct packet -> AudioDecoder.decode() hot path.
 *   - WASM: opus-decoder compatibility fallback.
 *
 * Add ?opus=0 to force the stock MP3/WAV negotiation for A/B diagnostics.
 */

(function () {
    'use strict';

    const PLUGIN_VERSION = '1.6.4';
    const PATCH_STATE_KEY = '__fmDxOpusFrontendPatch';
    const OPUS_MIME = 'audio/opus-packets';
    const OPUS_INITIAL_BUFFER = 1 / 3;
    const OPUS_BACKEND = 'auto'; // 'auto' | 'webcodecs' | 'wasm'
    const WASM_URL = 'js/plugins/opus/opus-decoder.min.js';
    const WASM_QUEUE_MAX = 150;
    const WASM_QUEUE_MAX_BYTES = 512 * 1024;
    const WASM_QUEUE_MAX_DURATION_US = 200 * 1000;
    const WEBCODECS_QUEUE_MAX = 150;
    const WEBCODECS_MAX_DURATION_US = 600000;
    const DECODER_STALL_MS = 500;
    const WASM_MAX_DECODE_ERRORS = 3;
    const MAX_OPUS_PACKET_BYTES = 61440;
    const MAX_OPUS_PACKET_DURATION_US = 120 * 1000;

    // Settings loads enabled plugins too, but owns no local audio player.
    // Exit before creating badges, timers or decoder resources in that scope.
    if (typeof AudioFormatReader === 'undefined' || typeof Fallback_Settings === 'undefined' ||
        (typeof document.querySelector === 'function' && document.querySelector('.setup-wrapper.admin-wrapper'))) return;

    // A successful earlier load owns the global patches and diagnostics.
    if (window[PATCH_STATE_KEY] && window[PATCH_STATE_KEY].patched) return;

    /* main.js declares `let Stream;` in a classic script. A top-level lexical
       binding is not a window property, so resolve it as a bare identifier. */
    function getStream() {
        try {
            return typeof Stream !== 'undefined' ? Stream : null;
        } catch (_) {
            return null;
        }
    }

    const Meter = {
        bytes: 0,
        packets: 0,
        kbps: 0,
        pps: 0,
        last: performance.now(),
        sample() {
            const now = performance.now();
            const dt = (now - this.last) / 1000;
            if (dt < 0.5) return;
            this.pps = this.packets / dt;
            this.kbps = (this.bytes * 8) / dt / 1000;
            this.packets = 0;
            this.bytes = 0;
            this.last = now;
        }
    };

    const hasWebCodecs = typeof AudioDecoder !== 'undefined' &&
                         typeof EncodedAudioChunk !== 'undefined';
    let webCodecsHealthy = hasWebCodecs;
    let opusHardFailed = false;
    let stockFallbackInitialBuffer = 1 / 3;
    Object.defineProperty(window, '__fmDxOpusWebCodecsHealthy', {
        configurable: true,
        enumerable: false,
        get: () => webCodecsHealthy
    });

    const Wasm = {
        state: 'idle', // idle | loading | ready | failed
        Ctor: null,
        detail: '',
        promise: null,

        load() {
            if (this.state === 'ready') return Promise.resolve(this.Ctor);
            if (this.state === 'loading' && this.promise) return this.promise;
            if (this.state === 'failed') return Promise.reject(new Error(this.detail || 'WASM decoder unavailable'));

            this.state = 'loading';
            this.promise = new Promise((resolve, reject) => {
                const script = document.createElement('script');
                script.src = WASM_URL;
                script.charset = 'UTF-8';
                script.async = true;
                let settled = false;
                const finish = (error) => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timer);
                    script.onload = null;
                    script.onerror = null;
                    if (error) {
                        this.state = 'failed';
                        this.detail = error.message;
                        if (typeof script.remove === 'function') script.remove();
                        reject(error);
                    } else {
                        this.Ctor = window['opus-decoder'].OpusDecoder;
                        this.state = 'ready';
                        this.detail = '';
                        resolve(this.Ctor);
                    }
                };
                const timer = setTimeout(() => finish(new Error('WASM script load timed out')), 5000);
                script.onload = () => {
                    const namespace = window['opus-decoder'];
                    finish(namespace && namespace.OpusDecoder ? null : new Error('global opus-decoder missing'));
                };
                script.onerror = () => finish(new Error(`${WASM_URL} failed to load`));
                document.head.appendChild(script);
            });
            return this.promise;
        }
    };

    const Badge = (function () {
        let pill = null;
        let panel = null;
        let open = false;
        const info = { reason: 'starting', backend: null, hardFail: false, hardFailText: null };

        function build() {
            if (!document.body || pill) return;

            pill = document.createElement('div');
            pill.style.cssText = [
                'position:fixed', 'left:8px', 'bottom:68px', 'z-index:99999',
                'font:600 11px/1 ui-monospace,Menlo,Consolas,monospace',
                'letter-spacing:.5px', 'padding:6px 9px', 'border-radius:4px',
                'background:rgba(20,20,22,.88)', 'color:#9aa0a6',
                'border:1px solid rgba(255,255,255,.16)',
                'cursor:pointer', 'user-select:none', '-webkit-user-select:none',
                'touch-action:manipulation'
            ].join(';');
            pill.textContent = 'AUDIO ...';

            panel = document.createElement('div');
            panel.style.cssText = [
                'position:fixed', 'left:8px', 'bottom:98px', 'z-index:99999',
                'font:11px/1.5 ui-monospace,Menlo,Consolas,monospace',
                'background:rgba(12,12,14,.95)', 'color:#d8d8d8',
                'padding:9px 11px', 'border-radius:5px',
                'border:1px solid rgba(255,255,255,.16)',
                'white-space:pre', 'max-width:80vw', 'overflow:auto',
                'display:none', 'box-shadow:0 3px 16px rgba(0,0,0,.55)'
            ].join(';');

            pill.addEventListener('click', () => {
                open = !open;
                panel.style.display = open ? 'block' : 'none';
                if (open) refreshPanel();
            });

            document.body.appendChild(pill);
            document.body.appendChild(panel);
            setInterval(tick, 500);
            tick();
        }

        function setPill(text, colour) {
            if (!pill) return;
            pill.textContent = text;
            pill.style.color = colour;
            pill.style.borderColor = colour === '#9aa0a6'
                ? 'rgba(255,255,255,.16)'
                : colour;
        }

        function tick() {
            Meter.sample();
            if (info.hardFail) {
                setPill(info.hardFailText || 'AUDIO error', '#d2564a');
                if (open) refreshPanel();
                return;
            }

            const stream = getStream();
            if (stream && stream.Fallback && stream.Fallback.SelectedFormatName) {
                const codec = stream.Fallback.SelectedFormatName;
                if (codec === 'opus') {
                    const backend = info.backend ? ` ${info.backend}` : '';
                    setPill(`OPUS${backend}`, '#5ac26a');
                } else {
                    setPill(codec.toUpperCase(), '#e0a33a');
                }
            } else {
                setPill('AUDIO idle', '#9aa0a6');
            }
            if (open) refreshPanel();
        }

        function refreshPanel() {
            if (!panel) return;
            const stream = getStream();
            const lines = [
                `opus plugin v${PLUGIN_VERSION}`,
                '-------------------------',
                'script       loaded',
                `secure ctx   ${window.isSecureContext ? 'yes' : 'NO'}`,
                `webcodecs    ${hasWebCodecs ? 'present' : 'MISSING'}`,
                `wasm         ${Wasm.state}${Wasm.detail ? ` (${Wasm.detail})` : ''}`,
                `preference   ${OPUS_BACKEND}`,
                `patches      ${info.reason}`
            ];

            if (window.Fallback_Settings) {
                try {
                    const probe = new window.Fallback_Settings();
                    lines.push(`formats      ${probe.Formats.map((format) => format.Name).join(',')}`);
                    lines.push(`start offset ${(probe.InitialBufferLength * 1000).toFixed(0)}ms`);

                } catch (error) {
                    lines.push(`formats      probe failed: ${error.message}`);
                }
            }

            lines.push('-------------------------');
            if (stream && stream.Fallback) {
                const fallback = stream.Fallback;
                lines.push(`selected     ${fallback.SelectedFormatName || '?'}`);
                if (info.backend) lines.push(`backend      ${info.backend}`);
                const reader = fallback.FormatReader;
                if (reader && reader.Backend && typeof reader.Backend.status === 'function') {
                    lines.push(`decoder      ${reader.Backend.status()}`);
                }
                if (reader && typeof reader.GetBufferDiagnostics === 'function') {
                    const diagnostics = reader.GetBufferDiagnostics();
                    const minimum = diagnostics.minBufferMs === null ? '-' : `${diagnostics.minBufferMs}ms`;
                    lines.push(`min buffer   ${minimum}`);
                    lines.push(`target       ${diagnostics.targetMs}ms`);
                    lines.push(`playback     ${diagnostics.playback}`);
                    lines.push(`jitter       ${diagnostics.jitterMs}ms`);
                    lines.push(`speed        ${diagnostics.rate.toFixed(5)}`);
                    lines.push(`resyncs      ${diagnostics.resyncs}`);
                    lines.push(`catchup drops ${diagnostics.catchUpDrops}`);
                    lines.push(`underruns    ${diagnostics.underruns}`);
                    lines.push(`reprimes     ${diagnostics.reprimes}`);
                    if (diagnostics.lastReprimeReason) {
                        lines.push(`last reprime ${diagnostics.lastReprimeReason}`);
                    }
                }
                if (fallback.Player && fallback.Audio && fallback.Player.NextScheduleTime > 0) {
                    const lead = Math.max(0, fallback.Player.NextScheduleTime - fallback.Audio.currentTime);
                    lines.push(`buffer       ${(lead * 1000).toFixed(0)}ms`);
                }
                if (fallback.Audio && typeof fallback.Audio.outputLatency === 'number') {
                    lines.push(`out latency  ${(fallback.Audio.outputLatency * 1000).toFixed(0)}ms`);
                }
                if (Meter.kbps) lines.push(`rate         ${Meter.pps.toFixed(0)}/s ${Meter.kbps.toFixed(1)} kbps`);
            } else {
                lines.push('stream       stopped (press play)');
            }
            lines.push('-------------------------', 'tap badge to close');
            panel.textContent = lines.join('\n');
        }

        if (document.body) build();
        else document.addEventListener('DOMContentLoaded', build, { once: true });

        return {
            reason(value) { info.reason = value; },
            backend(value) { info.backend = value; },
            fail(short, why) {
                info.reason = why;
                info.hardFail = true;
                info.hardFailText = short;
                tick();
            }
        };
    })();

    let opusDisabled = false;
    try {
        opusDisabled = new URLSearchParams(location.search).get('opus') === '0';
    } catch (_) {
        opusDisabled = /(?:^|[?&])opus=0(?:&|$)/.test(location.search || '');
    }

    if (opusDisabled) {
        Badge.fail('MP3 forced', 'disabled via ?opus=0');
        return;
    }
    if (!hasWebCodecs && OPUS_BACKEND === 'webcodecs') {
        Badge.fail('MP3 no-webcodecs', 'forced webcodecs but AudioDecoder missing');
        return;
    }

    if (OPUS_BACKEND === 'wasm' || (OPUS_BACKEND === 'auto' && !hasWebCodecs)) {
        Wasm.load().catch(() => {});
    }

    function backendAvailable() {
        if (opusHardFailed) return false;
        if (OPUS_BACKEND === 'webcodecs') return hasWebCodecs && webCodecsHealthy;
        if (OPUS_BACKEND === 'wasm') return Wasm.state !== 'failed';
        return (hasWebCodecs && webCodecsHealthy) || Wasm.state !== 'failed';
    }

    function chooseBackend() {
        if (opusHardFailed) return null;
        if (OPUS_BACKEND === 'wasm') return 'wasm';
        if (OPUS_BACKEND === 'webcodecs') return webCodecsHealthy ? 'webcodecs' : null;
        return hasWebCodecs && webCodecsHealthy ? 'webcodecs' : 'wasm';
    }


    function setPlayerStartOffset(player, startOffset) {
        if (!player || !Number.isFinite(startOffset) || startOffset <= 0) return;
        player.StartOffset = startOffset;
        const variance = typeof player.OffsetMax === 'number' && typeof player.OffsetMin === 'number'
            ? Math.max(0, (player.OffsetMax - player.OffsetMin) / 2)
            : 0.2;
        player.OffsetMin = startOffset - variance;
        player.OffsetMax = startOffset + variance;
        if (typeof player.Reset === 'function') {
            try {
                player.Reset();
            } catch (error) {
                console.debug('[Opus] player reset during MP3 fallback ignored:', error);
            }
        }
    }

    function downgradeOpusToMp3(reader, reason) {
        const stream = getStream();
        const fallback = stream && stream.Fallback;
        if (!fallback || fallback.FormatReader !== reader || fallback.SelectedFormatName !== 'opus') return false;
        if (!fallback.Settings || !Array.isArray(fallback.Settings.Formats) || !fallback.Player) return false;
        if (!fallback.WebSocket || typeof fallback.WebSocket.Send !== 'function') return false;

        const mp3 = fallback.Settings.Formats.find((format) =>
            format && format.Name === 'mp3' && format.Mime === 'audio/mpeg'
        );
        if (!mp3 || !AudioFormatReader.CanDecodeTypes([mp3.Mime])) return false;

        let nextReader;
        try {
            nextReader = AudioFormatReader.Create(
                mp3.Mime,
                fallback.Audio,
                fallback.Logger,
                fallback.OnReaderError.bind(fallback),
                fallback.Player.CheckBeforeDecode,
                fallback.OnReaderDataReady.bind(fallback),
                AudioFormatReader.DefaultSettings()
            );
        } catch (error) {
            console.error('[Opus] MP3 fallback reader creation failed:', error);
            return false;
        }

        try {
            fallback.WebSocket.Send(JSON.stringify({ type: 'fallback', data: mp3.Name }));
        } catch (error) {
            try {
                if (nextReader && typeof nextReader.Reset === 'function') nextReader.Reset();
            } catch (_) {
                // Best-effort cleanup of a reader that never became active.
            }
            console.error('[Opus] MP3 fallback negotiation failed:', error);
            return false;
        }

        opusHardFailed = true;
        try {
            reader.Reset();
        } catch (error) {
            console.debug('[Opus] failed Opus reader cleanup ignored:', error);
        }

        fallback.Settings.InitialBufferLength = stockFallbackInitialBuffer;
        setPlayerStartOffset(fallback.Player, stockFallbackInitialBuffer);
        fallback.SelectedFormatMime = mp3.Mime;
        fallback.SelectedFormatName = mp3.Name;
        fallback.FormatReader = nextReader;
        Badge.backend(null);
        Badge.reason(`hard fallback to ${mp3.Name}: ${reason}`);
        console.warn(`[Opus] hard failure (${reason}); renegotiated fallback to ${mp3.Name}.`);
        return true;
    }

    const SILK_US = [10000, 20000, 40000, 60000];
    const CELT_US = [2500, 5000, 10000, 20000];

    function opusPacketDurationUs(packet) {
        if (!packet || packet.length < 1) return 20000;
        const toc = packet[0];
        const config = toc >> 3;
        const code = toc & 0x03;
        let frameUs;
        if (config < 12) frameUs = SILK_US[config & 0x03];
        else if (config < 16) frameUs = (config & 0x01) ? 20000 : 10000;
        else frameUs = CELT_US[config & 0x03];

        let frames;
        if (code === 0) frames = 1;
        else if (code === 1 || code === 2) frames = 2;
        else frames = packet.length >= 2 ? (packet[1] & 0x3F) : 1;

        const durationUs = frameUs * (frames > 0 ? frames : 1);
        return durationUs <= MAX_OPUS_PACKET_DURATION_US ? durationUs : 20000;
    }

    function isMagic(data, text) {
        if (!data || data.length < text.length) return false;
        for (let i = 0; i < text.length; i++) {
            if (data[i] !== text.charCodeAt(i)) return false;
        }
        return true;
    }

    function parseOpusHead(head) {
        if (!head || head.length < 19 || !isMagic(head, 'OpusHead')) {
            throw new Error('Invalid OpusHead: minimum supported header is 19 bytes.');
        }
        if (head[8] > 15) throw new Error(`Unsupported OpusHead version=${head[8]}.`);
        const channels = head[9];
        if (channels !== 1 && channels !== 2) {
            throw new Error(`Unsupported OpusHead channel count=${channels}.`);
        }
        const mappingFamily = head[18];
        if (mappingFamily !== 0) {
            throw new Error(`Unsupported OpusHead mapping family=${mappingFamily}.`);
        }
        return {
            channels,
            preSkip: head[10] | (head[11] << 8)
        };
    }

    function Backend_WebCodecs(head, onAudioData, onError) {
        const header = parseOpusHead(head);
        this.Timestamp = 0;
        this.Dead = false;
        this.Pending = new Map();
        this.PendingDurationUs = 0;
        this.Head = head.slice();
        this.OnAudioData = onAudioData;
        this.OnError = onError;
        this.Channels = header.channels;

        this.Decoder = new AudioDecoder({
            output: (audioData) => {
                try {
                    if (this.Dead) return;
                    for (const [timestamp, pending] of this.Pending) {
                        if (timestamp > audioData.timestamp) break;
                        this.PendingDurationUs -= pending.duration;
                        this.Pending.delete(timestamp);
                    }
                    this.OnAudioData(audioData);
                } catch (error) {
                    console.warn('[Opus] AudioData copy failed:', error);
                    this.OnError();
                } finally {
                    try {
                        audioData.close();
                    } catch (_) {
                        // Already-closed AudioData is harmless during teardown.
                    }
                }
            },
            error: (error) => {
                if (this.Dead) return;
                console.warn('[Opus] AudioDecoder error:', error && error.message ? error.message : error);
                this.OnError();
            }
        });

        try {
            this.configure();
        } catch (error) {
            this.close();
            throw error;
        }
        console.log(`[Opus] WebCodecs backend configured (${header.channels}ch).`);
    }

    Backend_WebCodecs.prototype.configure = function () {
        this.Decoder.configure({
            codec: 'opus',
            sampleRate: 48000,
            numberOfChannels: this.Channels,
            description: this.Head
        });
    };

    // Keep this path deliberately synchronous: packet -> decode() directly.
    Backend_WebCodecs.prototype.push = function (packet) {
        if (!this.Decoder || this.Decoder.state !== 'configured') return;
        const duration = opusPacketDurationUs(packet);
        // A stalled native decoder must not accumulate an unbounded packet queue.
        const oldest = this.Pending.values().next().value;
        if (this.Decoder.decodeQueueSize >= WEBCODECS_QUEUE_MAX ||
            this.PendingDurationUs + duration > WEBCODECS_MAX_DURATION_US ||
            (oldest && this.PendingDurationUs > 200000 && performance.now() - oldest.time > DECODER_STALL_MS)) {
            console.warn('[Opus] WebCodecs decode queue stalled; switching decoder backend.');
            this.close();
            this.OnError();
            return;
        }
        try {
            this.Pending.set(this.Timestamp, {duration,time:performance.now()});
            this.PendingDurationUs += duration;
            this.Decoder.decode(new EncodedAudioChunk({
                type: 'key',
                timestamp: this.Timestamp,
                duration,
                data: packet
            }));
            this.Timestamp += duration;
        } catch (error) {
            console.warn('[Opus] decode() threw:', error);
            this.OnError();
        }
    };

    Backend_WebCodecs.prototype.flushState = function () {
        if (!this.Decoder || this.Decoder.state !== 'configured') return;
        try {
            this.Decoder.reset();
            this.configure();
            this.Timestamp = 0;
            this.Pending.clear();
            this.PendingDurationUs = 0;
        } catch (error) {
            console.warn('[Opus] WebCodecs reset failed:', error);
            this.close();
            this.OnError();
        }
    };

    Backend_WebCodecs.prototype.close = function () {
        this.Dead = true;
        this.Pending.clear();
        this.PendingDurationUs = 0;
        if (!this.Decoder) return;
        try {
            if (this.Decoder.state !== 'closed') this.Decoder.close();
        } catch (_) {
            // Decoder may already be closing after an error callback.
        }
        this.Decoder = null;
    };

    Backend_WebCodecs.prototype.checkHealth = function () {
        if (this.Dead || !this.Pending.size) return;
        const oldest = this.Pending.values().next().value;
        if (performance.now() - oldest.time > DECODER_STALL_MS) {
            this.close();
            this.OnError();
        }
    };

    Backend_WebCodecs.prototype.status = function () {
        return this.Decoder
            ? `${this.Decoder.state} q=${this.Decoder.decodeQueueSize}`
            : 'closed';
    };

    function Backend_Wasm(head, onPcm, onError) {
        const header = parseOpusHead(head);
        this.OnPcm = onPcm;
        this.OnError = onError;
        this.Queue = [];
        this.QueueBytes = 0;
        this.QueueDurationUs = 0;
        this.Dec = null;
        this.Ready = false;
        this.Resetting = false;
        this.Dead = false;
        this.ConsecutiveDecodeErrors = 0;
        this.HasEmittedPcm = false;
        this.NeedsResetWhenReady = false;
        this.LifecyclePromise = null;
        this.LifecycleTimer = null;
        this.ReleasedDecoders = new WeakSet();
        this.LastErrorLogAt = -Infinity;
        this.ErrorResetWindowAt = performance.now();
        this.ErrorResets = 0;

        const options = {
            channels: header.channels,
            preSkip: header.preSkip,
            sampleRate: 48000,
            forceStereo: false,
            streamCount: 1,
            coupledStreamCount: header.channels === 2 ? 1 : 0,
            channelMappingTable: header.channels === 2 ? [0, 1] : [0]
        };

        const initPromise = Wasm.load()
            .then((Ctor) => {
                if (this.Dead) return null;
                this.Dec = new Ctor(options);
                this.LifecycleTimer = setTimeout(() => this.fail('decoder init timed out'), 3000);
                const decoder = this.Dec;
                return Promise.resolve(decoder.ready).then(() => {
                    if (this.Dead) this.releaseDecoder(decoder);
                });
            })
            .then(() => {
                if (this.Dead || !this.Dec) return;
                clearTimeout(this.LifecycleTimer);
                this.LifecycleTimer = null;
                this.Ready = true;
                console.log(`[Opus] WASM backend ready (${header.channels}ch, preSkip ${header.preSkip}), flushing ${this.Queue.length} queued packets.`);
                if (this.NeedsResetWhenReady) {
                    this.NeedsResetWhenReady = false;
                    this.beginReset(false);
                    return;
                }
                this.flushQueue();
            })
            .catch((error) => this.fail('decoder init failed', error));
        this.LifecyclePromise = initPromise;
    }

    Backend_Wasm.prototype.releaseDecoder = function (decoder) {
        if (!decoder || this.ReleasedDecoders.has(decoder)) return;
        try {
            decoder.free();
            this.ReleasedDecoders.add(decoder);
        } catch (_) {
            // Best-effort WASM teardown.
        }
    };

    Backend_Wasm.prototype.clearQueue = function () {
        this.Queue = [];
        this.QueueBytes = 0;
        this.QueueDurationUs = 0;
    };

    Backend_Wasm.prototype.resetState = function () {
        clearTimeout(this.LifecycleTimer);
        this.LifecycleTimer = null;
        this.Dec = null;
        this.Dead = true;
        this.Ready = false;
        this.Resetting = false;
        this.NeedsResetWhenReady = false;
        this.clearQueue();
        this.ConsecutiveDecodeErrors = 0;
        this.HasEmittedPcm = false;
    };

    Backend_Wasm.prototype.fail = function (message, error) {
        if (this.Dead) return;
        const decoder = this.Dec;
        this.resetState();
        this.releaseDecoder(decoder);
        console.error(`[Opus] WASM ${message}:`, error);
        this.OnError();
    };

    Backend_Wasm.prototype.enqueue = function (packet) {
        if (!packet || packet.length > MAX_OPUS_PACKET_BYTES) return;
        const copy = packet.slice();
        const durationUs = opusPacketDurationUs(copy);
        if (!Number.isFinite(durationUs) || durationUs <= 0 || durationUs > WASM_QUEUE_MAX_DURATION_US) return;

        while (this.Queue.length &&
               (this.Queue.length >= WASM_QUEUE_MAX ||
                this.QueueBytes + copy.length > WASM_QUEUE_MAX_BYTES ||
                this.QueueDurationUs + durationUs > WASM_QUEUE_MAX_DURATION_US)) {
            const dropped = this.Queue.shift();
            this.QueueBytes -= dropped.length;
            this.QueueDurationUs = Math.max(0, this.QueueDurationUs - opusPacketDurationUs(dropped));
        }
        if (this.Queue.length < WASM_QUEUE_MAX &&
            this.QueueBytes + copy.length <= WASM_QUEUE_MAX_BYTES &&
            this.QueueDurationUs + durationUs <= WASM_QUEUE_MAX_DURATION_US) {
            this.Queue.push(copy);
            this.QueueBytes += copy.length;
            this.QueueDurationUs += durationUs;
        }
    };

    Backend_Wasm.prototype.flushQueue = function () {
        if (!this.Ready || this.Resetting || this.Dead) return;
        const queued = this.Queue;
        const emitPcm = this.HasEmittedPcm === true;
        this.clearQueue();
        for (let index = 0; index < queued.length; index++) {
            if (this.Dead) break;
            if (this.Resetting) {
                for (; index < queued.length; index++) this.enqueue(queued[index]);
                break;
            }
            this.decodeNow(queued[index], emitPcm);
        }
    };

    Backend_Wasm.prototype.beginReset = function (clearQueue) {
        if (clearQueue) this.clearQueue();
        if (this.Dead || this.Resetting) return;
        if (!this.Dec || !this.Ready) {
            this.NeedsResetWhenReady = true;
            return;
        }

        this.Resetting = true;
        this.Ready = false;
        this.LifecycleTimer = setTimeout(() => this.fail('decoder reset timed out'), 3000);
        let resetResult;
        try {
            resetResult = this.Dec.reset();
        } catch (error) {
            this.fail('reset failed', error);
            return;
        }

        const resetPromise = Promise.resolve(resetResult)
            .then(() => {
                if (this.Dead) return;
                clearTimeout(this.LifecycleTimer);
                this.LifecycleTimer = null;
                this.Resetting = false;
                this.Ready = true;
                this.ConsecutiveDecodeErrors = 0;
                this.flushQueue();
            })
            .catch((error) => this.fail('reset failed', error));
        this.LifecyclePromise = resetPromise;
    };

    Backend_Wasm.prototype.noteDecodeError = function (detail) {
        this.ConsecutiveDecodeErrors++;
        const now = performance.now();
        if (now - this.LastErrorLogAt >= 5000) {
            this.LastErrorLogAt = now;
            console.warn('[Opus] WASM decode failed:', detail);
        }
        if (this.ConsecutiveDecodeErrors < WASM_MAX_DECODE_ERRORS) return;
        if (now - this.ErrorResetWindowAt >= 10000) {
            this.ErrorResetWindowAt = now;
            this.ErrorResets = 0;
        }
        if (++this.ErrorResets > 2) this.fail('repeated decode failures');
        else this.beginReset(false);
    };

    Backend_Wasm.prototype.decodeNow = function (packet, emitPcm = true) {
        if (!this.Dec || this.Dead || this.Resetting) return;
        try {
            const output = this.Dec.decodeFrame(packet);
            const errors = output && Array.isArray(output.errors) ? output.errors : [];
            if (errors.length) {
                this.noteDecodeError(errors[0] && errors[0].message || 'invalid packet');
                return;
            }
            this.ConsecutiveDecodeErrors = 0;
            if (output && output.samplesDecoded > 0 && emitPcm) {
                this.HasEmittedPcm = true;
                this.OnPcm(output.channelData, output.sampleRate || 48000, output.samplesDecoded);
            }
        } catch (error) {
            this.noteDecodeError(error);
        }
    };

    Backend_Wasm.prototype.push = function (packet) {
        if (this.Dead) return;
        if (!this.Ready || this.Resetting) {
            this.enqueue(packet);
            return;
        }
        this.decodeNow(packet);
    };

    Backend_Wasm.prototype.flushState = function () {
        this.beginReset(true);
    };

    Backend_Wasm.prototype.close = function () {
        const decoder = this.Dec;
        const lifecycle = this.LifecyclePromise;
        const deferRelease = this.Resetting || !this.Ready;
        this.resetState();
        if (!decoder) return;

        // Attempt immediate cleanup even when ready/reset never settles. A later
        // completion still gets a guarded cleanup if initialization was incomplete.
        this.releaseDecoder(decoder);
        if (deferRelease && lifecycle && typeof lifecycle.then === 'function') {
            Promise.resolve(lifecycle).then(
                () => this.releaseDecoder(decoder),
                () => this.releaseDecoder(decoder)
            );
            return;
        }
        this.releaseDecoder(decoder);
    };

    Backend_Wasm.prototype.status = function () {
        if (this.Dead) return 'dead';
        if (this.Resetting) return `resetting (q=${this.Queue.length})`;
        if (!this.Ready) return `loading (q=${this.Queue.length})`;
        return 'configured';
    };

    const WORKLET_URL = `js/plugins/opus/opus-worklet.js?v=${PLUGIN_VERSION}`;
    const workletModules = new WeakMap();
    const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

    class AdaptiveBufferController {
        constructor() {
            this.target = OPUS_INITIAL_BUFFER;
            this.rate = 1;
            this.jitterMs = 0;
            this.lastArrival = null;
            this.previousDurationMs = 20;
            this.clockRate = 1;
            this.clockAnchors = [];
            this.clockSlopes = new Float64Array(496);
            this.resetClockEvidence();
            this.transitMs = 0;
            this.transitFloorMs = 0;
            this.jitterWindowAt = null;
            this.lastUpdate = 0;
            this.lastRisk = 0;
            this.lastReduction = 0;
            this.underruns = 0;
        }
        arrival(now, durationMs) {
            if (!Number.isFinite(now) || !Number.isFinite(durationMs) || durationMs <= 0) return;
            if (this.lastArrival !== null) {
                const gap = Math.max(0, now - this.lastArrival);
                if (gap >= 2000) this.resetClockEvidence();
                else this.clockMediaMs += this.previousDurationMs;
                // Keep jitter history independent from clock evidence, with the
                // existing five-second phase reset after temporary queue delays.
                if (this.jitterWindowAt === null || now - this.jitterWindowAt >= 5000) {
                    this.transitMs = 0;
                    this.transitFloorMs = 0;
                    this.jitterWindowAt = now;
                }
                if (gap < 2000) {
                    this.transitMs += gap - this.previousDurationMs / this.clockRate;
                    this.transitFloorMs = Math.min(this.transitFloorMs, this.transitMs);
                    const excess = Math.max(0, this.transitMs - this.transitFloorMs);
                    this.jitterMs = Math.max(excess, this.jitterMs * Math.exp(-gap / 10000));
                    if (excess > 40) this.lastRisk = now;
                } else {
                    this.transitMs = 0;
                    this.transitFloorMs = 0;
                }
            }
            this.observeClock(now);
            this.previousDurationMs = durationMs;
            this.lastArrival = now;
        }
        resetClockEvidence() {
            this.clockWindowAt = null;
            this.clockMediaMs = 0;
            this.clockWindowSample = null;
            this.clockAnchors.length = 0;
            this.clockConfirmedRate = this.clockRate;
            this.clockCandidate = null;
        }
        observeClock(now) {
            if (this.clockWindowAt === null) this.clockWindowAt = now;
            if (now - this.clockWindowAt >= 1000) {
                // Use the least-delayed packet in each window. Burst delivery and
                // one-off latency steps must not masquerade as a media clock change.
                if (this.clockWindowSample) this.clockAnchors.push(this.clockWindowSample);
                if (this.clockAnchors.length > 32) this.clockAnchors.shift();
                if (this.clockAnchors.length >= 4) {
                    const n = this.clockAnchors.length;
                    const a = this.clockAnchors[n-4], b = this.clockAnchors[n-3];
                    const c = this.clockAnchors[n-2], d = this.clockAnchors[n-1];
                    const x = (b.media - a.media) / (b.time - a.time);
                    const y = (c.media - b.media) / (c.time - b.time);
                    const z = (d.media - c.media) / (d.time - c.time);
                    const median = Math.max(Math.min(x, y), Math.min(Math.max(x, y), z));
                    // All three consecutive slopes must agree. A median alone
                    // can still mistake changing burst sizes for a clock drift.
                    if (Number.isFinite(median) && median > 0 &&
                        Math.max(x, y, z) - Math.min(x, y, z) <= .003) {
                        const observed = clamp(median, .97, 1.03);
                        if (Math.abs(observed - this.clockConfirmedRate) <= .001) {
                            this.clockRate += .5 * (observed - this.clockRate);
                            this.clockCandidate = null;
                        } else if (this.clockCandidate && Math.abs(observed - this.clockCandidate.rate) <= .002) {
                            // Confirm a material change with a second, non-overlapping
                            // set of anchors, not several copies of the same delay step.
                            if (a.time >= this.clockCandidate.end) {
                                this.clockConfirmedRate = observed;
                                this.clockRate += .5 * (observed - this.clockRate);
                                this.clockCandidate = null;
                            }
                        } else this.clockCandidate = {rate:observed,end:d.time};
                    } else this.clockCandidate = null;
                }
                const n = this.clockAnchors.length;
                if (n >= 16) this.observeLongClock(n - 16, n, 5000, .01, .015);
                if (n === 32) this.observeLongClock(0, 32, 10000, .005, .005);
                this.clockWindowAt = now;
                this.clockWindowSample = null;
            }
            const phase = now - this.clockMediaMs;
            if (!this.clockWindowSample) this.clockWindowSample = {time:now,media:this.clockMediaMs,phase};
            else if (phase < this.clockWindowSample.phase) {
                this.clockWindowSample.time = now;
                this.clockWindowSample.media = this.clockMediaMs;
                this.clockWindowSample.phase = phase;
            }
        }
        observeLongClock(from, to, minimumElapsed, minimumDrift, minimumMagnitude) {
            // Noisy batching can hide genuine drift from short windows. Use robust
            // slopes over 15-30s, and require the central half to lie clearly
            // beyond the confirmed clock. Fixed storage and one pass per 1s window.
            const slopes = this.sampleClockSlopes(from, to, minimumElapsed);
            if (!slopes || slopes.length < 16) return;
            const count = slopes.length;
            const lower = slopes[Math.floor(count / 4)], upper = slopes[Math.floor(count * 3 / 4)];
            const median = slopes[Math.floor(count / 2)];
            if (!Number.isFinite(median) || median <= 0) return;
            const middle = from + (to - from) / 2;
            const first = this.clockHalfStats(from, middle, minimumElapsed * .6);
            const second = this.clockHalfStats(middle, to, minimumElapsed * .6);
            if (!first || !second) return;
            const slowing = upper < this.clockConfirmedRate - minimumDrift &&
                first.upper < this.clockConfirmedRate - minimumDrift && second.upper < this.clockConfirmedRate - minimumDrift;
            const speeding = lower > this.clockConfirmedRate + minimumDrift &&
                first.lower > this.clockConfirmedRate + minimumDrift && second.lower > this.clockConfirmedRate + minimumDrift;
            // A single latency step biases cross-boundary slopes. Both disjoint
            // temporal halves must independently show the same persistent drift.
            if ((slowing || speeding) && Math.abs(first.median - second.median) <= .004 &&
                Math.abs(median - this.clockConfirmedRate) >= minimumMagnitude) {
                this.clockConfirmedRate = clamp(median, .97, 1.03);
                this.clockRate += .5 * (this.clockConfirmedRate - this.clockRate);
                this.clockCandidate = null;
            } else if (to - from === 32 && Math.abs(this.clockConfirmedRate - 1) > .005 &&
                Math.abs(median - this.clockConfirmedRate) <= .005 &&
                Math.abs(first.median - median) <= .002 && Math.abs(second.median - median) <= .002) {
                // Refine an already-confirmed hardware offset gently using the
                // longer history; a latency step cannot pass both half checks.
                this.clockConfirmedRate += clamp(median - this.clockConfirmedRate, -.0005, .0005);
                this.clockRate += .5 * (this.clockConfirmedRate - this.clockRate);
            } else if (Math.abs(this.clockConfirmedRate - this.clockRate) > .001) {
                this.clockRate += .5 * (this.clockConfirmedRate - this.clockRate);
            }
        }
        sampleClockSlopes(from, to, minimumElapsed) {
            let count = 0;
            for (let i = from; i < to - 1; i++) {
                const a = this.clockAnchors[i];
                for (let j = i + 1; j < to; j++) {
                    const b = this.clockAnchors[j], elapsed = b.time - a.time;
                    if (elapsed >= minimumElapsed) this.clockSlopes[count++] = (b.media - a.media) / elapsed;
                }
            }
            if (count < 3) return null;
            const slopes = this.clockSlopes.subarray(0, count);
            slopes.sort();
            return slopes;
        }
        clockHalfStats(from, to, minimumElapsed) {
            const slopes = this.sampleClockSlopes(from, to, minimumElapsed);
            if (!slopes) return null;
            return {lower:slopes[Math.floor(slopes.length / 4)],
                median:slopes[Math.floor(slopes.length / 2)],
                upper:slopes[Math.floor(slopes.length * 3 / 4)]};
        }
        starve(now) {
            this.underruns++;
            this.target = Math.min(.60, this.target + .04);
            this.lastRisk = now;
            this.lastReduction = now;
        }
        update(now, lead) {
            if (now - this.lastUpdate < 250) return;
            const dt = Math.min(2, Math.max(0, (now - this.lastUpdate) / 1000));
            this.lastUpdate = now;
            this.jitterMs *= Math.exp(-dt / 10);
            const desired = clamp(.25 + this.jitterMs / 1000, .25, .50);
            if (desired > this.target) this.target = desired;
            else if (now - this.lastRisk >= 20000 && now - this.lastReduction >= 5000) {
                this.target = Math.max(desired, this.target - .01);
                this.lastReduction = now;
            }
            if (!Number.isFinite(lead)) return;
            if (lead < .06) this.lastRisk = now;
            const error = lead - this.target;
            const correction = Math.abs(error) < .025 ? 0 : clamp(error * .04, -.005, .005);
            const desiredRate = clamp(this.clockRate + correction, .97, 1.03);
            this.rate += clamp(desiredRate - this.rate, -.001, .001);
        }
        resetTiming() {
            this.lastArrival = null;
            this.resetClockEvidence();
            this.transitMs = 0;
            this.transitFloorMs = 0;
            this.jitterWindowAt = null;
            this.rate = 1;
        }
    }

    // Own only the Opus player's scheduling hooks. Other codecs keep stock 3LAS.
    class AdaptivePlayback {
        constructor(reader, player) {
            this.reader = reader;
            this.player = player;
            this.audio = reader.Audio;
            this.controller = reader.Controller;
            this.sources = new Set();
            this.needsFade = true;
            this.node = null;
            this.dead = false;
            this.status = 'scheduler';
            this.workletBuffer = 0;
            this.workletTime = 0;
            this.workletPlaying = false;
            this.sentFrames = 0;
            this.ackFrames = 0;
            this.reportedUnderruns = 0;
            this.reportedResyncs = 0;
            this.originalPush = player.PushBuffer;
            this.originalReset = player.Reset;
            this.pushHook = (buffer) => this.push(buffer);
            this.resetHook = () => this.reset('player-reset');
            player.PushBuffer = this.pushHook;
            player.Reset = this.resetHook;
            player.StartOffset = this.controller.target;
            this.stateHandler = () => {
                this.reset('context-state');
                this.controller.resetTiming();
            };
            this.audio.addEventListener('statechange', this.stateHandler);
            this.timer = setInterval(() => this.tick(), 250);
            this.initWorklet();
        }
        async initWorklet() {
            if (!this.audio.audioWorklet || typeof AudioWorkletNode !== 'function') return;
            try {
                let loading = workletModules.get(this.audio);
                if (!loading) {
                    // Shared per-context deadline; a blocked fetch cannot retain
                    // disposed connection adapters indefinitely.
                    loading = new Promise((resolve, reject) => {
                        const timer = setTimeout(() => reject(new Error('AudioWorklet load timed out')), 5000);
                        this.audio.audioWorklet.addModule(WORKLET_URL).then(
                            () => { clearTimeout(timer); resolve(); },
                            (error) => { clearTimeout(timer); reject(error); }
                        );
                    });
                    workletModules.set(this.audio, loading);
                }
                await loading;
                if (this.dead) return;
                const node = new AudioWorkletNode(this.audio, 'fm-dx-opus-pcm', {
                    numberOfInputs:0,numberOfOutputs:1,outputChannelCount:[2]
                });
                node.port.onmessage = ({data}) => this.onStatus(data);
                node.onprocessorerror = () => {
                    if (this.dead || this.node !== node) return;
                    this.releaseWorklet();
                    this.status = 'scheduler';
                    this.reset('worklet-error');
                };
                node.connect(this.player.Amplification);
                // Transfer pending scheduled PCM so worklet startup does not lose it.
                const now = this.audio.currentTime;
                this.node = node;
                this.status = 'worklet';
                // Preserve the scheduled presentation phase when module loading
                // finishes after playback has begun, instead of pausing to re-prime.
                this.cleanSources();
                let startDelay = this.controller.target;
                for (const entry of this.sources) startDelay = Math.min(startDelay, Math.max(0, entry.start - now));
                this.configureWorklet(startDelay, this.sources.size > 0);
                for (const entry of this.sources) {
                    const offset = clamp((now - entry.start) * entry.rate, 0, entry.buffer.duration);
                    this.sendBuffer(entry.buffer, Math.floor(offset * entry.buffer.sampleRate));
                }
                this.stopSources();
                this.player.NextScheduleTime = 0;
            } catch (error) {
                if (!this.dead) console.debug('[Opus] AudioWorklet unavailable; using bounded scheduler:', error);
            }
        }
        configureWorklet(startDelay, handover = false) {
            if (this.node) this.node.port.postMessage({type:'config',target:this.controller.target,rate:this.controller.rate,startDelay,handover});
        }
        onStatus(data) {
            if (this.dead || !data || data.type !== 'status' || !Number.isFinite(data.buffer) ||
                data.buffer < 0 || data.buffer > 1 || !Number.isFinite(data.time)) return;
            if (Number.isSafeInteger(data.receivedFrames) && data.receivedFrames >= this.ackFrames && data.receivedFrames <= this.sentFrames) this.ackFrames = data.receivedFrames;
            this.workletBuffer = data.buffer;
            this.workletTime = data.time;
            this.workletPlaying = data.playing === true;
            if (Number.isInteger(data.underruns) && data.underruns > this.reportedUnderruns) {
                this.controller.starve(performance.now());
                this.reader.Underruns += data.underruns - this.reportedUnderruns;
                this.reader.Reprimes++;
                this.reader.LastReprimeReason = 'underrun';
                this.reportedUnderruns = data.underruns;
            }
            if (Number.isInteger(data.resyncs) && data.resyncs > this.reportedResyncs) {
                this.reader.Resyncs += data.resyncs - this.reportedResyncs;
                this.reportedResyncs = data.resyncs;
            }
        }
        lead() {
            if (!this.node) return Math.max(0, this.player.NextScheduleTime - this.audio.currentTime);
            const elapsed = this.workletPlaying ? Math.max(0, this.audio.currentTime - this.workletTime) : 0;
            return Math.max(0, this.workletBuffer - elapsed * this.controller.rate);
        }
        sendBuffer(buffer, offset = 0) {
            const frames = buffer.length - offset;
            if (frames <= 0) return;
            const planes = [];
            for (let i = 0; i < buffer.numberOfChannels; i++) planes.push(buffer.getChannelData(i).slice(offset));
            this.node.port.postMessage({type:'pcm',planes,sampleRate:buffer.sampleRate}, planes.map(p => p.buffer));
            // Account for in-flight messages, not just the last worklet report.
            this.sentFrames += frames;
        }
        push(buffer) {
            if (this.dead || !buffer || !Number.isFinite(buffer.duration) || buffer.duration <= 0 || buffer.duration > .12 ||
                buffer.sampleRate !== 48000 || buffer.numberOfChannels < 1 || buffer.numberOfChannels > 2) return;
            if (this.audio.state && this.audio.state !== 'running') return;
            const now = this.audio.currentTime;
            if (this.node) {
                // A render thread that stops acknowledging data cannot retain unlimited messages.
                if ((this.sentFrames - this.ackFrames + buffer.length) / 48000 > 1) {
                    this.reader.CatchUpDrops++;
                    return;
                }
                this.sendBuffer(buffer);
                return;
            }
            this.cleanSources();
            const lead = this.lead();
            if (this.player.NextScheduleTime > 0 && lead <= 0) {
                this.controller.starve(performance.now());
                this.reader.Underruns++;
                this.reset('underrun');
            } else if (lead + buffer.duration > Math.max(.80, this.controller.target + .35)) {
                this.reader.Resyncs++;
                this.reset('excess-buffer');
            }
            if (this.player.NextScheduleTime <= now) {
                this.player.NextScheduleTime = now + this.controller.target;
            }
            const rate = this.controller.rate;
            const start = this.player.NextScheduleTime;
            const end = start + buffer.duration / rate;
            const source = this.audio.createBufferSource();
            const gain = this.audio.createGain();
            source.buffer = buffer;
            source.loop = false;
            source.playbackRate.value = rate;
            source.connect(gain);
            gain.connect(this.player.Amplification);
            // Only fade initial/recovery boundaries; adjacent frames remain seamless.
            if (this.needsFade) {
                this.needsFade = false;
                gain.gain.setValueAtTime(0, start);
                gain.gain.linearRampToValueAtTime(1, start + Math.min(.005, buffer.duration));
            }
            const entry = {source,gain,start,end,rate,buffer};
            source.onended = () => this.releaseSource(entry);
            this.sources.add(entry);
            try { source.start(start); } catch (error) { this.releaseSource(entry); throw error; }
            this.player.NextScheduleTime = end;
        }
        releaseSource(entry) {
            entry.source.onended = null;
            try { entry.source.disconnect(); entry.gain.disconnect(); } catch (_) {}
            entry.source.buffer = null;
            this.sources.delete(entry);
        }
        cleanSources() {
            const now = this.audio.currentTime;
            for (const entry of this.sources) if (entry.end <= now) this.releaseSource(entry);
        }
        stopSources(fade = false) {
            const now = this.audio.currentTime;
            for (const entry of this.sources) {
                if (fade && entry.start <= now && entry.end > now) {
                    entry.gain.gain.cancelScheduledValues(now);
                    entry.gain.gain.setValueAtTime(1, now);
                    entry.gain.gain.linearRampToValueAtTime(0, now + .005);
                    try { entry.source.stop(now + .005); } catch (_) { this.releaseSource(entry); }
                } else {
                    try { entry.source.stop(); } catch (_) {}
                    this.releaseSource(entry);
                }
            }
        }
        reset(reason) {
            if (this.dead) return;
            this.stopSources(true);
            this.needsFade = true;
            this.player.StartOffset = this.controller.target;
            this.player.NextScheduleTime = 0;
            this.ackFrames = this.sentFrames;
            this.workletBuffer = 0;
            this.workletPlaying = false;
            if (this.node) this.node.port.postMessage({type:'reset'});
            this.configureWorklet();
            this.reader.Reprimes++;
            this.reader.LastReprimeReason = reason;
        }
        tick() {
            if (this.dead) return;
            this.cleanSources();
            const lead = this.lead();
            this.controller.update(performance.now(), lead);
            this.player.StartOffset = this.controller.target;
            this.configureWorklet();
            if (this.node) this.player.NextScheduleTime = this.audio.currentTime + lead;
            this.reader.ObserveScheduledLead(lead);
            this.reader.CheckDecoderHealth();
        }
        releaseWorklet() {
            if (!this.node) return;
            this.node.onprocessorerror = null;
            this.node.port.onmessage = null;
            try { this.node.port.postMessage({type:'dispose'}); this.node.port.close(); this.node.disconnect(); } catch (_) {}
            this.node = null;
        }
        dispose() {
            if (this.dead) return;
            this.stopSources();
            this.releaseWorklet();
            this.dead = true;
            clearInterval(this.timer);
            this.audio.removeEventListener('statechange', this.stateHandler);
            if (this.player.PushBuffer === this.pushHook) this.player.PushBuffer = this.originalPush;
            if (this.player.Reset === this.resetHook) this.player.Reset = this.originalReset;
            this.player.NextScheduleTime = 0;
        }
    }

    function AudioFormatReader_Opus(audio, logger, errorCallback, beforeDecodeCheck, dataReadyCallback) {
        AudioFormatReader.call(this, audio, logger, errorCallback, beforeDecodeCheck, dataReadyCallback);
        this.Backend = null;
        this.Head = null;
        this._OnPcm = this.OnPcm.bind(this);
        this._OnWebCodecsAudioData = this.OnWebCodecsAudioData.bind(this);
        this.OversizedPacketWarned = false;
        this.ResetBufferDiagnostics();
        this.Playback = null;
        return this;
    }

    AudioFormatReader_Opus.prototype = Object.create(AudioFormatReader.prototype);
    AudioFormatReader_Opus.prototype.constructor = AudioFormatReader_Opus;

    AudioFormatReader_Opus.prototype.ResetBufferDiagnostics = function () {
        this.Controller = new AdaptiveBufferController();
        this.Resyncs = 0;
        this.MinScheduledLeadSeconds = null;
        this.CatchUpDrops = 0;
        this.Underruns = 0;
        this.Reprimes = 0;
        this.LastReprimeReason = null;
    };

    AudioFormatReader_Opus.prototype.ObserveScheduledLead = function (lead) {
        if (!Number.isFinite(lead) || lead < 0) return;
        if (this.MinScheduledLeadSeconds === null || lead < this.MinScheduledLeadSeconds) this.MinScheduledLeadSeconds = lead;
    };

    AudioFormatReader_Opus.prototype.GetBufferDiagnostics = function () {
        return {
            targetMs: Math.round(this.Controller.target * 1000),
            jitterMs: Math.round(this.Controller.jitterMs),
            rate: this.Controller.rate,
            playback: this.Playback ? this.Playback.status : 'idle',
            resyncs: this.Resyncs,
            minBufferMs: this.MinScheduledLeadSeconds === null
                ? null
                : Math.round(this.MinScheduledLeadSeconds * 1000),
            catchUpDrops: this.CatchUpDrops,
            underruns: this.Underruns,
            reprimes: this.Reprimes,
            lastReprimeReason: this.LastReprimeReason
        };
    };

    AudioFormatReader_Opus.prototype.EnsurePlayback = function () {
        if (this.Playback && !this.Playback.dead) return this.Playback;
        const stream = getStream();
        const fallback = stream && stream.Fallback;
        if (!fallback || fallback.FormatReader !== this || fallback.Audio !== this.Audio || !fallback.Player) return null;
        this.Playback = new AdaptivePlayback(this, fallback.Player);
        return this.Playback;
    };

    AudioFormatReader_Opus.prototype.CheckDecoderHealth = function () {
        if (this.Audio.state && this.Audio.state !== 'running') return;
        if (this.Backend && typeof this.Backend.checkHealth === 'function') this.Backend.checkHealth();
    };

    AudioFormatReader_Opus.prototype.CreateBackend = function (backend, head) {
        let instance = null;
        const onError = () => this.HandleBackendError(backend, instance);
        instance = backend === 'wasm'
            ? new Backend_Wasm(head, this._OnPcm, onError)
            : new Backend_WebCodecs(head, this._OnWebCodecsAudioData, onError);
        return instance;
    };

    AudioFormatReader_Opus.prototype.SignalHardFailure = function (reason) {
        if (downgradeOpusToMp3(this, reason)) return;
        this.ErrorCallback();
    };

    AudioFormatReader_Opus.prototype.HandleBackendError = function (backend, instance) {
        if (instance && this.Backend !== instance) return;

        if (backend === 'webcodecs') {
            webCodecsHealthy = false;
            this.CloseBackend();
            if (OPUS_BACKEND !== 'webcodecs' && this.Head && Wasm.state !== 'failed') {
                try {
                    this.Backend = this.CreateBackend('wasm', this.Head);
                    Badge.backend('wasm');
                    console.warn('[Opus] WebCodecs failed at runtime; switched to WASM backend.');
                    return;
                } catch (error) {
                    console.error('[Opus] WASM failover failed:', error);
                }
            }
        } else {
            this.CloseBackend();
        }

        this.SignalHardFailure(`${backend} decoder failed`);
    };

    AudioFormatReader_Opus.prototype.Configure = function (head) {
        if (this.Playback) { this.Playback.dispose(); this.Playback = null; }
        this.ResetBufferDiagnostics();
        this.CloseBackend();
        try {
            parseOpusHead(head);
        } catch (error) {
            console.warn('[Opus] Invalid OpusHead:', error && error.message ? error.message : error);
            this.Head = null;
            this.SignalHardFailure('invalid OpusHead');
            return;
        }

        this.Head = head.slice();
        const backend = chooseBackend();
        if (!backend) {
            this.SignalHardFailure('no Opus decoder backend available');
            return;
        }
        try {
            this.Backend = this.CreateBackend(backend, this.Head);
            Badge.backend(backend === 'wasm' ? 'wasm' : 'wc');
        } catch (error) {
            console.error(`[Opus] ${backend} backend failed:`, error);
            if (backend === 'webcodecs' && OPUS_BACKEND !== 'webcodecs') {
                webCodecsHealthy = false;
                try {
                    this.Backend = this.CreateBackend('wasm', this.Head);
                    Badge.backend('wasm');
                    console.warn('[Opus] fell back to WASM backend.');
                    return;
                } catch (fallbackError) {
                    console.error('[Opus] WASM fallback also failed:', fallbackError);
                }
            }
            this.Backend = null;
            this.SignalHardFailure('all Opus decoder backends failed');
        }
    };

    AudioFormatReader_Opus.prototype.CloseBackend = function () {
        if (!this.Backend) return;
        try {
            this.Backend.close();
        } catch (error) {
            console.debug('[Opus] decoder close ignored:', error);
        }
        this.Backend = null;
    };

    AudioFormatReader_Opus.prototype.PushData = function (data) {
        Meter.bytes += data && data.length ? data.length : 0;
        Meter.packets++;
        if (!data || data.length === 0) return;
        if (data.length > MAX_OPUS_PACKET_BYTES) {
            if (!this.OversizedPacketWarned) {
                this.OversizedPacketWarned = true;
                console.warn(`[Opus] Dropping oversized packet (${data.length} bytes). Further warnings are suppressed for this reader.`);
            }
            return;
        }
        if (isMagic(data, 'OpusHead')) {
            this.Configure(data);
            return;
        }
        if (isMagic(data, 'OpusTags')) return;
        this.EnsurePlayback();
        this.Controller.arrival(performance.now(), opusPacketDurationUs(data) / 1000);
        if (this.Backend) this.Backend.push(data);
    };

    AudioFormatReader_Opus.prototype.OnWebCodecsAudioData = function (audioData) {
        window.startTimeConnectionWatchdog = performance.now();
        const frames = audioData && audioData.numberOfFrames;
        const channels = audioData && audioData.numberOfChannels;
        const sampleRate = audioData && audioData.sampleRate ? audioData.sampleRate : 48000;
        if (!frames || (channels !== 1 && channels !== 2) || !Number.isFinite(sampleRate) || sampleRate <= 0) return;
        if (!this.ShouldEmitPcm(sampleRate, frames)) return;

        const buffer = this.Audio.createBuffer(channels, frames, sampleRate);
        for (let channel = 0; channel < channels; channel++) {
            audioData.copyTo(buffer.getChannelData(channel), { planeIndex: channel, format: 'f32-planar' });
        }
        this.OnDataReady(this.Id++, buffer);
    };

    AudioFormatReader_Opus.prototype.ShouldEmitPcm = function (sampleRate, frames) {
        if (sampleRate !== 48000 || !Number.isInteger(frames) || frames <= 0 || frames > 5760) return false;
        const playback = this.EnsurePlayback();
        if (!playback) return false;
        this.ObserveScheduledLead(playback.lead());
        return !this.Audio.state || this.Audio.state === 'running';
    };

    AudioFormatReader_Opus.prototype.OnPcm = function (planes, sampleRate, frames) {
        // 3LAS uses this timestamp for reconnect watchdog activity, including
        // frames intentionally discarded while catching up to live playback.
        window.startTimeConnectionWatchdog = performance.now();
        if (!frames || !planes || planes.length < 1 || planes.length > 2 || !Number.isFinite(sampleRate) || sampleRate <= 0 ||
            planes.some(plane => !(plane instanceof Float32Array) || plane.length < frames)) return;
        if (!this.ShouldEmitPcm(sampleRate, frames)) return;

        try {
            const buffer = this.Audio.createBuffer(planes.length, frames, sampleRate);
            for (let channel = 0; channel < planes.length; channel++) {
                buffer.getChannelData(channel).set(planes[channel].subarray(0, frames));
            }
            this.OnDataReady(this.Id++, buffer);
        } catch (error) {
            console.warn('[Opus] buffer assembly failed:', error);
            this.ErrorCallback();
        }
    };

    AudioFormatReader_Opus.prototype.PurgeData = function () {
        if (this.Playback) this.Playback.reset('purge');
        this.Controller.resetTiming();
        AudioFormatReader.prototype.PurgeData.call(this);
        if (!this.Backend) return;
        try {
            this.Backend.flushState();
        } catch (error) {
            console.warn('[Opus] decoder purge failed:', error);
            this.ErrorCallback();
        }
    };

    AudioFormatReader_Opus.prototype.Reset = function () {
        if (this.Playback) { this.Playback.dispose(); this.Playback = null; }
        this.ResetBufferDiagnostics();
        this.CloseBackend();
        AudioFormatReader.prototype.PurgeData.call(this);
    };

    window.AudioFormatReader_Opus = AudioFormatReader_Opus;

    function installPatches() {
        const originalCanDecodeTypes = AudioFormatReader.CanDecodeTypes;
        const originalCreate = AudioFormatReader.Create;
        const OriginalFallbackSettings = window.Fallback_Settings;

        try {
            const stockSettings = new OriginalFallbackSettings();
            if (Number.isFinite(stockSettings.InitialBufferLength) && stockSettings.InitialBufferLength > 0) {
                stockFallbackInitialBuffer = stockSettings.InitialBufferLength;
            }
            AudioFormatReader.CanDecodeTypes = function (mimeTypes) {
                if (mimeTypes && mimeTypes.length === 1 && mimeTypes[0] === OPUS_MIME) {
                    return backendAvailable();
                }
                return originalCanDecodeTypes.call(this, mimeTypes);
            };

            AudioFormatReader.Create = function (mime, audio, logger, errorCallback, beforeDecodeCheck, dataReadyCallback, settings) {
                if (mime === OPUS_MIME) {
                    return new AudioFormatReader_Opus(audio, logger, errorCallback, beforeDecodeCheck, dataReadyCallback);
                }
                return originalCreate.call(this, mime, audio, logger, errorCallback, beforeDecodeCheck, dataReadyCallback, settings);
            };

            function PatchedFallbackSettings() {
                OriginalFallbackSettings.call(this);
                if (!AudioFormatReader.CanDecodeTypes([OPUS_MIME])) return;
                if (!this.Formats.some((format) => format.Name === 'opus')) {
                    this.Formats.unshift({ Mime: OPUS_MIME, Name: 'opus' });
                }
                this.InitialBufferLength = OPUS_INITIAL_BUFFER;
            }
            PatchedFallbackSettings.prototype = Object.create(OriginalFallbackSettings.prototype);
            PatchedFallbackSettings.prototype.constructor = PatchedFallbackSettings;
            Object.setPrototypeOf(PatchedFallbackSettings, OriginalFallbackSettings);
            window.Fallback_Settings = PatchedFallbackSettings;

            const probe = new window.Fallback_Settings();
            if (!probe.Formats.length || probe.Formats[0].Name !== 'opus') {
                throw new Error('Fallback_Settings patch verification failed');
            }

            window[PATCH_STATE_KEY] = {
                patched: true,
                version: PLUGIN_VERSION,
                originalCanDecodeTypes,
                originalCreate,
                OriginalFallbackSettings
            };
            return ['probe', 'create', 'formats'];
        } catch (error) {
            AudioFormatReader.CanDecodeTypes = originalCanDecodeTypes;
            AudioFormatReader.Create = originalCreate;
            window.Fallback_Settings = OriginalFallbackSettings;
            console.error('[Opus] patch installation failed:', error);
            return [];
        }
    }

    const applied = installPatches();
    if (applied.length === 3) {
        Badge.reason(`ok (${applied.join(',')})`);
        console.log(`[Opus] enabled. backend=${OPUS_BACKEND} webcodecs=${hasWebCodecs} adaptiveBuffer=enabled`);
    } else {
        Badge.fail('MP3 patch-fail', 'patch installation rolled back');
    }
})();
