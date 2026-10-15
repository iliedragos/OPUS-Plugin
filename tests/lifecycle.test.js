'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {frontend}=require('./helpers');
function head(channels=2){const h=new Uint8Array(19);h.set(Buffer.from('OpusHead'));h[8]=1;h[9]=channels;h[10]=56;h[11]=1;return h;}
function webcodecs(){const decoders=[];return {decoders,options:{AudioDecoder:class{constructor(options){this.options=options;this.state='unconfigured';this.decodeQueueSize=0;decoders.push(this);}configure(){this.state='configured';}decode(chunk){this.decodeQueueSize++;this.last=chunk;}reset(){this.decodeQueueSize=0;}close(){this.state='closed';}},EncodedAudioChunk:class{constructor(options){Object.assign(this,options);}}}};}
test('native decoder retention is bounded by audio duration rather than 150 long packets',()=>{
    const w=webcodecs(),f=frontend(w.options);f.reader.PushData(head());
    const native=f.reader.Backend;
    for(let i=0;i<15;i++){f.advance(60);f.reader.PushData(Uint8Array.of(24));}
    assert.notEqual(f.reader.Backend,native);
    assert.equal(w.decoders[0].state,'closed');
    f.reader.Reset();
});
test('old decoder callback after reset cannot schedule audio',()=>{
    const w=webcodecs(),f=frontend(w.options);f.reader.PushData(head());
    const decoder=w.decoders[0];f.reader.Reset();
    let closed=0;
    decoder.options.output({timestamp:0,numberOfFrames:960,numberOfChannels:2,sampleRate:48000,copyTo(p){p.fill(.5);},close(){closed++;}});
    assert.equal(closed,1);assert.equal(f.fallback.Audio.sources.size,0);assert.equal(f.timers.size,f.baselineTimerCount);
});
test('PCM received during suspension is discarded without growing player state',()=>{
    const f=frontend();f.fallback.Audio.state='suspended';
    for(let i=0;i<5000;i++)f.reader.OnPcm([new Float32Array(960)],48000,960);
    assert.equal(f.fallback.Audio.sources.size,0);
    f.fallback.Audio.state='running';f.fallback.Audio.events.get('statechange')?.();
    f.reader.OnPcm([new Float32Array(960)],48000,960);
    assert.ok(f.fallback.Audio.sources.size>0);f.reader.Reset();
});
test('AudioWorklet module resolution after reset does not retain or connect a node',async()=>{
    let resolve;let created=0;
    const f=frontend({AudioWorkletNode:class{constructor(){created++;}}});
    f.fallback.Audio.audioWorklet={addModule:()=>new Promise(r=>resolve=r)};
    f.reader.OnPcm([new Float32Array(960)],48000,960);
    f.reader.Reset();resolve();await Promise.resolve();await Promise.resolve();
    assert.equal(created,0);assert.equal(f.timers.size,f.baselineTimerCount);
});
test('purge clears both player PCM and decoder state without resetting adaptive history',()=>{
    const f=frontend();f.reader.OnPcm([new Float32Array(960)],48000,960);
    f.reader.Controller.starve(1000);const target=f.reader.Controller.target;
    f.reader.PurgeData();
    assert.equal(f.fallback.Audio.sources.size,0);
    assert.equal(f.reader.Controller.target,target);assert.equal(f.fallback.Player.NextScheduleTime,0);
    f.reader.Reset();
});
test('invalid decoded channel count and inconsistent plane lengths never schedule audio',()=>{
    const f=frontend();
    f.reader.OnPcm([new Float32Array(960),new Float32Array(100)],48000,960);
    f.reader.OnPcm([new Float32Array(960),new Float32Array(960),new Float32Array(960)],48000,960);
    assert.equal(f.fallback.Audio.sources.size,0);f.reader.Reset();
});
module.exports={head,webcodecs};
