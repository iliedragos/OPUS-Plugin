'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {frontend}=require('./helpers');
const head=()=>{const h=new Uint8Array(19);h.set(Buffer.from('OpusHead'));h[8]=1;h[9]=2;return h;};
test('WASM script loading has a deadline and downgrades to MP3',async()=>{
    const f=frontend();f.reader.PushData(head());
    for(const fn of [...f.timers.values()])fn();
    for(let i=0;i<8;i++)await Promise.resolve();
    assert.equal(f.fallback.SelectedFormatName,'mp3');
    assert.equal(f.fallback.Audio.sources.size,0);
});
test('rapid frequency changes preserve scheduled PCM, decoder state and adaptive history',()=>{
    const observers=[],f=frontend({MutationObserver:class{constructor(fn){this.fn=fn;observers.push(this);}observe(){}disconnect(){}}});
    let flushes=0;const backend={flushState(){flushes++;},close(){}};f.reader.Backend=backend;
    for(let i=0;i<10;i++)f.reader.OnPcm([new Float32Array(960)],48000,960);
    const playback=f.reader.Playback,sources=[...playback.sources],end=f.fallback.Player.NextScheduleTime;
    f.reader.Controller.starve(1000);const target=f.reader.Controller.target;
    for(let i=0;i<1000;i++){f.freq.textContent=String(88+i%20);for(const observer of observers)observer.fn();}
    assert.equal(flushes,0);assert.equal(f.reader.Backend,backend);assert.equal(f.reader.Playback,playback);
    assert.equal(f.reader.Controller.target,target);assert.equal(f.fallback.Player.NextScheduleTime,end);
    assert.deepEqual([...playback.sources],sources);assert.equal(observers.length,0);
    f.reader.OnPcm([new Float32Array(960)],48000,960);
    assert.ok(Math.abs(f.fallback.Player.NextScheduleTime-end-.02)<1e-9);
    f.reader.PurgeData();assert.equal(flushes,1);assert.equal(f.fallback.Audio.sources.size,0);
    f.reader.Reset();assert.equal(f.timers.size,f.baselineTimerCount);
});
test('frequency changes preserve active worklet messages and queued PCM',async()=>{
    const observers=[],messages=[];let node;
    class Node{constructor(){node=this;this.port={postMessage:m=>messages.push(m),close(){},onmessage:null};}connect(){}disconnect(){}}
    const f=frontend({AudioWorkletNode:Node,MutationObserver:class{constructor(fn){this.fn=fn;observers.push(this);}observe(){}disconnect(){}}});
    f.fallback.Audio.audioWorklet={addModule:()=>Promise.resolve()};
    for(let i=0;i<17;i++)f.reader.OnPcm([new Float32Array(960)],48000,960);
    await new Promise(setImmediate);
    const adapter=f.reader.Playback,frames=adapter.sentFrames;
    node.port.onmessage({data:{type:'status',buffer:.34,playing:true,time:0,receivedFrames:frames,underruns:0,resyncs:0}});
    const count=messages.length;
    for(let i=0;i<1000;i++){f.freq.textContent=String(88+i%20);for(const observer of observers)observer.fn();}
    assert.equal(messages.length,count);assert.equal(adapter.sentFrames,frames);assert.equal(adapter.workletBuffer,.34);
    assert.equal(adapter.status,'worklet');assert.equal(f.reader.Playback,adapter);
    f.reader.OnPcm([new Float32Array(960)],48000,960);assert.equal(adapter.sentFrames,frames+960);
    assert.ok(!messages.some(m=>m.type==='reset'));
    f.reader.PurgeData();assert.ok(messages.some(m=>m.type==='reset'));
    f.reader.Reset();assert.ok(messages.some(m=>m.type==='dispose'));assert.equal(f.timers.size,f.baselineTimerCount);
});
test('worklet status updates measure actual queue without double-counting underruns',async()=>{
    let node;
    class Node{constructor(){node=this;this.port={postMessage(){},close(){},onmessage:null};}connect(){}disconnect(){}}
    const f=frontend({AudioWorkletNode:Node});f.fallback.Audio.audioWorklet={addModule:()=>Promise.resolve()};
    f.reader.OnPcm([new Float32Array(960)],48000,960);await new Promise(setImmediate);
    node.port.onmessage({data:{type:'status',buffer:0,underruns:1,resyncs:0,playing:false,time:0,receivedFrames:960}});
    f.tick();
    assert.equal(f.reader.GetBufferDiagnostics().underruns,1);assert.ok(Math.abs(f.reader.Controller.target-(1/3+.04))<1e-9);
    f.reader.Reset();assert.equal(node.port.onmessage,null);
});
test('worklet startup rejection leaves working scheduler and clears its deadline',async()=>{
    const f=frontend({AudioWorkletNode:class{}});
    f.fallback.Audio.audioWorklet={addModule:()=>Promise.reject(new Error('CSP denied'))};
    f.reader.OnPcm([new Float32Array(960)],48000,960);await new Promise(setImmediate);
    assert.equal(f.reader.Playback.status,'scheduler');assert.equal(f.fallback.Audio.sources.size,1);
    f.reader.Reset();assert.equal(f.timers.size,f.baselineTimerCount);
});
test('a late successful WASM initialization is freed exactly once after reset',async()=>{
    let resolve,freed=0;
    const f=frontend(),h=new Uint8Array(19);h.set(Buffer.from('OpusHead'));h[8]=1;h[9]=1;
    f.context['opus-decoder']={OpusDecoder:class{constructor(){this.ready=new Promise(r=>resolve=r);}free(){freed++;}}};
    f.reader.PushData(h);f.scripts[0].onload();await new Promise(setImmediate);f.reader.Reset();resolve();await new Promise(setImmediate);
    assert.equal(freed,1);assert.equal(f.fallback.Audio.sources.size,0);
});

for(const elapsed of [600,1500])test(`late worklet resolution handles ${elapsed}ms scheduler age`,async()=>{
    const messages=[];let resolve;
    class Node{constructor(){this.port={postMessage:m=>messages.push(m),close(){}};}connect(){}disconnect(){}}
    const f=frontend({AudioWorkletNode:Node});f.fallback.Audio.audioWorklet={addModule:()=>new Promise(r=>resolve=r)};
    for(let i=0;i<20;i++)f.reader.OnPcm([new Float32Array(960)],48000,960);
    f.advance(elapsed);resolve();await new Promise(setImmediate);
    const config=messages.find(m=>m.type==='config'),pcm=messages.filter(m=>m.type==='pcm');
    assert.equal(config.handover,elapsed===600);
    if(elapsed===600){assert.equal(config.startDelay,0);assert.ok(pcm.length>0);assert.ok(pcm.reduce((n,m)=>n+m.planes[0].length,0)<16000);}
    else{assert.equal(pcm.length,0);assert.equal(config.startDelay,1/3);}
    f.reader.Reset();
});
test('native focus-loss purge and disconnect reset remain effective after tuning cleanup',()=>{
    const f=frontend();let flushes=0,closes=0;
    f.reader.Backend={flushState(){flushes++;},close(){closes++;}};
    for(let i=0;i<10;i++)f.reader.OnPcm([new Float32Array(960)],48000,960);
    f.fallback.LastCheckTime=Date.now()-20000;f.fallback.CheckFocus();
    assert.equal(flushes,1);assert.equal(f.fallback.Audio.sources.size,0);assert.equal(f.fallback.Player.NextScheduleTime,0);
    f.reader.OnPcm([new Float32Array(960)],48000,960);
    assert.ok(f.fallback.Audio.sources.size>0);
    f.fallback.Reset();assert.equal(closes,1);assert.equal(f.fallback.Audio.sources.size,0);
    assert.equal(f.timers.size,f.baselineTimerCount);assert.equal(f.fallback.Audio.events.size,0);assert.equal(f.fallback.WebSocket,null);
});
