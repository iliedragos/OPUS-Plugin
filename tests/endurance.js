'use strict';
const assert=require('node:assert/strict');
const {frontend,worklet}=require('./helpers');
const f=frontend({AudioDecoder:class{},EncodedAudioChunk:class{}});
const planes=[new Float32Array(960).fill(.2),new Float32Array(960).fill(-.2)];
let maxNodes=0,maxSources=0;
for(let i=0;i<180000;i++) {
    f.reader.OnPcm(planes,48000,960);
    f.advance(20);
    if(i%12===0)f.tick();
    maxNodes=Math.max(maxNodes,f.fallback.Audio.sources.size);
    maxSources=Math.max(maxSources,f.reader.Playback.sources.size);
    if(i%6000===0&&i>0){f.reader.PurgeData();f.reader.OnPcm(planes,48000,960);}
}
assert.ok(maxNodes<40);assert.ok(maxSources<40);assert.equal(f.reader.GetBufferDiagnostics().catchUpDrops,0);
f.reader.Reset();assert.equal(f.fallback.Audio.sources.size,0);assert.equal(f.timers.size,0);assert.equal(f.fallback.Audio.events.size,0);
for(let i=0;i<2000;i++){f.reader.OnPcm(planes,48000,960);f.reader.Reset();}
assert.equal(f.fallback.Audio.sources.size,0);assert.equal(f.timers.size,0);
const w=worklet();w.send({type:'config',target:1/3,rate:1});const left=w.processor.left,right=w.processor.right;
for(let i=0;i<50000;i++){
    if(i%15===0)w.send({type:'pcm',planes,sampleRate:48000});
    w.render(64);
    if(i%5000===0)w.send({type:'reset'});
    assert.ok(w.processor.count<=48000);
}
assert.equal(w.processor.left,left);assert.equal(w.processor.right,right);
console.log(JSON.stringify({simulatedSchedulerHours:1,reconnectCycles:2000,maxActiveSources:maxSources,remainingSources:f.fallback.Audio.sources.size,remainingConnectionTimers:f.timers.size,ringAllocatedBytes:left.byteLength+right.byteLength}));
// Server queue retention under repeated pressure and reset. The fake writable
// holds its accepted bytes until each explicit reset; timings are informational.
const {EventEmitter}=require('node:events'),{serverModule}=require('./server-helpers');
let child;
const m=serverModule({spawn(){child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.stdin=new EventEmitter();child.stdin.writable=true;child.stdin.writableLength=0;child.stdin.write=b=>{child.stdin.writableLength+=b.length;return false;};child.kill=()=>{};return child;}});
const p=new m.api.OpusProvider({Channels:2,SampleRate:48000,FallbackClients:{opus:new Set()}},'ffmpeg');
const tiny=Buffer.alloc(4),burst=Buffer.alloc(65280);
function pressureCycle(){p.InsertData(burst);for(let i=0;i<10000;i++)p.InsertData(tiny);assert.ok(p.PendingPcmFrames.length<256);p.ResetPcmPipeline();child.stdin.writableLength=0;assert.equal(p.PendingPcmBytes,0);}
for(let i=0;i<10;i++)pressureCycle();global.gc?.();const heapBefore=process.memoryUsage().heapUsed,started=performance.now();
for(let i=0;i<100;i++)pressureCycle();global.gc?.();const heapDelta=process.memoryUsage().heapUsed-heapBefore;
assert.ok(heapDelta<2*1024*1024,`retained heap growth=${heapDelta}`);
p.Dispose();assert.equal(m.timers.size,0);
console.log(JSON.stringify({serverTinyChunkInserts:1000000,pressureResetCycles:100,elapsedMs:Math.round(performance.now()-started),retainedHeapDeltaBytes:heapDelta,remainingServerTimers:m.timers.size}));
