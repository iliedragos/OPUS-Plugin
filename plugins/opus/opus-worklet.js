/* Bounded PCM playback for the FM-DX Opus plugin. No allocations in the sample loop. */
'use strict';
class FmDxOpusProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.capacity = 48000; // 1000ms at the Opus output rate, allocated once.
        this.left = new Float32Array(this.capacity);
        this.right = new Float32Array(this.capacity);
        this.read = 0;
        this.count = 0;
        this.fraction = 0;
        this.inputRate = 48000;
        this.target = 1 / 3;
        this.rate = 1;
        this.playing = false;
        this.startAt = null;
        this.startDelay = null;
        this.handover = false;
        this.alive = true;
        this.underruns = 0;
        this.resyncs = 0;
        this.reportFrames = 0;
        this.receivedFrames = 0;
        this.fadeFrames = Math.max(1, Math.round(sampleRate * .005));
        this.fade = 0;
        this.lastLeft = 0;
        this.lastRight = 0;
        this.port.onmessage = ({data}) => this.receive(data);
    }
    receive(data) {
        if (!data || !this.alive) return;
        if (data.type === 'dispose') {
            this.alive = false;
            this.count = 0;
            this.port.onmessage = null;
            return;
        }
        if (data.type === 'reset') {
            this.count = 0;
            this.fraction = 0;
            this.playing = false;
            this.startAt = null;
            this.startDelay = null;
            this.handover = false;
            this.fade = this.fadeFrames;
            return;
        }
        if (data.type === 'config') {
            if (this.startAt === null && Number.isFinite(data.startDelay)) {
                this.startDelay = Math.max(0, Math.min(.60, data.startDelay));
                this.handover = data.handover === true;
            }
            if (Number.isFinite(data.target)) this.target = Math.max(.25, Math.min(.60, data.target));
            if (Number.isFinite(data.rate)) this.rate = Math.max(.97, Math.min(1.03, data.rate));
            return;
        }
        if (data.type !== 'pcm' || !Array.isArray(data.planes) ||
            data.planes.length < 1 || data.planes.length > 2 || data.sampleRate !== 48000) return;
        const l = data.planes[0], r = data.planes[1] || l;
        if (!(l instanceof Float32Array) || !(r instanceof Float32Array) ||
            l.length === 0 || l.length > 5760 || r.length !== l.length) return;
        if (this.startAt === null) this.startAt = currentTime + (this.startDelay === null ? this.target : this.startDelay);
        const hardLimit = Math.round(Math.max(.80, this.target + .35) * this.inputRate);
        if (this.count + l.length > hardLimit) {
            // Emergency only: keep the newest audio, blend the boundary for 5ms.
            const retain = Math.max(0, Math.round(this.target * this.inputRate) - l.length);
            const skip = Math.max(0, this.count - retain);
            this.read = (this.read + skip) % this.capacity;
            this.count -= skip;
            this.fraction = 0;
            this.fade = this.fadeFrames;
            this.resyncs++;
        }
        let write = (this.read + this.count) % this.capacity;
        const first = Math.min(l.length, this.capacity - write);
        this.left.set(l.subarray(0, first), write);
        this.right.set(r.subarray(0, first), write);
        if (first < l.length) {
            this.left.set(l.subarray(first), 0);
            this.right.set(r.subarray(first), 0);
        }
        this.count += l.length;
        this.receivedFrames += l.length;
    }
    report() {
        this.port.postMessage({type:'status',buffer:this.count / this.inputRate,
            underruns:this.underruns,resyncs:this.resyncs,playing:this.playing,time:currentTime,receivedFrames:this.receivedFrames});
    }
    process(_inputs, outputs) {
        if (!this.alive) return false;
        const out = outputs[0];
        if (!out || !out[0]) return true;
        const l = out[0], r = out[1] || null;
        const step = this.inputRate / sampleRate * this.rate;
        if (!this.playing && this.startAt !== null && currentTime >= this.startAt &&
            this.count >= (this.handover ? Math.ceil(step) + 1 : Math.ceil(this.target * this.inputRate))) {
            this.playing = true;
            this.handover = false;
            this.fade = this.fadeFrames;
        }
        for (let i = 0; i < l.length; i++) {
            let a = 0, b = 0;
            if (this.playing && this.count >= Math.ceil(step) + 1) {
                const next = (this.read + 1) % this.capacity;
                a = this.left[this.read] + (this.left[next] - this.left[this.read]) * this.fraction;
                b = this.right[this.read] + (this.right[next] - this.right[this.read]) * this.fraction;
                if (!Number.isFinite(a)) a = 0;
                if (!Number.isFinite(b)) b = 0;
                this.fraction += step;
                const advance = Math.floor(this.fraction);
                this.fraction -= advance;
                this.read = (this.read + advance) % this.capacity;
                this.count -= advance;
            } else if (this.playing) {
                this.playing = false;
                this.startAt = null;
                this.startDelay = null;
                this.handover = false;
                this.count = 0;
                this.fraction = 0;
                this.fade = this.fadeFrames;
                this.underruns++;
                this.report();
            }
            if (this.fade > 0) {
                // Blend both restart and starvation boundaries; no full-frame drop.
                const weight = 1 / this.fade;
                a = this.lastLeft + (a - this.lastLeft) * weight;
                b = this.lastRight + (b - this.lastRight) * weight;
                this.fade--;
            }
            l[i] = a;
            if (r) r[i] = b;
            this.lastLeft = a;
            this.lastRight = b;
        }
        this.reportFrames += l.length;
        if (this.reportFrames >= sampleRate / 10) {
            this.reportFrames = 0;
            this.report();
        }
        return true;
    }
}
registerProcessor('fm-dx-opus-pcm', FmDxOpusProcessor);
