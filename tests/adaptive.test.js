'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {frontend,worklet}=require('./helpers');
test('repeated starvation increases target and stable playback gradually reduces it',()=>{
    const {reader}=frontend();
    assert.ok(reader.Controller,'adaptive controller must exist');
    const c=reader.Controller;
    const initial=c.target;
    c.starve(1000);c.starve(2000);
    assert.ok(c.target>initial);assert.ok(c.target<=.60);
    const raised=c.target;
    for(let t=3000;t<90000;t+=250)c.update(t,.2);
    assert.ok(c.target<raised);assert.ok(c.target>=.25);
});
test('normal burst does not discard decoded audio at the old 300ms boundary',()=>{
    const {reader,fallback}=frontend();
    const buffer=fallback.Audio.createBuffer(2,960,48000);
    for(let i=0;i<10;i++)reader.OnPcm([buffer.getChannelData(0),buffer.getChannelData(1)],48000,960);
    assert.equal(reader.GetBufferDiagnostics().catchUpDrops,0);
    assert.ok(fallback.Player.NextScheduleTime>.3);
});
test('fallback reset stops and releases scheduled nodes, reinstalls cleanly',()=>{
    const f=frontend();
    f.reader.OnPcm([new Float32Array(960)],48000,960);
    assert.ok(f.fallback.Audio.sources.size>0);
    f.reader.Reset();
    assert.equal(f.fallback.Audio.sources.size,0);
    assert.equal(f.timers.size,f.baselineTimerCount);
    assert.equal(f.fallback.Audio.events.size,0);
});
test('worklet primes, duplicates mono, and bounds extreme input bursts',()=>{
    const w=worklet();
    w.send({type:'config',target:.25,rate:1});
    w.send({type:'pcm',planes:[new Float32Array(960).fill(.5)],sampleRate:48000});
    assert.equal(w.render()[0][127],0);
    for(let i=0;i<12;i++)w.send({type:'pcm',planes:[new Float32Array(960).fill(.5)],sampleRate:48000});
    for(let i=0;i<100;i++)w.render();
    for(let i=0;i<5;i++){const out=w.render();assert.deepEqual(out[0],out[1]);}
    assert.ok(w.render()[0][127]>.4);
    for(let i=0;i<1000;i++)w.send({type:'pcm',planes:[new Float32Array(960).fill(.25)],sampleRate:48000});
    assert.ok(w.processor.count<=48000);
});
test('worklet resamples 48k PCM at 44.1k output without channel inversion',()=>{
    const w=worklet(44100);
    w.send({type:'config',target:.25,rate:1});
    for(let i=0;i<15;i++)w.send({type:'pcm',planes:[new Float32Array(960).fill(.25),new Float32Array(960).fill(-.5)],sampleRate:48000});
    for(let i=0;i<90;i++)w.render();
    const before=w.processor.count;
    for(let i=0;i<4;i++)w.render();
    const out=w.render();
    assert.ok(Math.abs(out[0][127]-.25)<.001);assert.ok(Math.abs(out[1][127]+.5)<.001);
    assert.ok(Math.abs(w.processor.count-(before-640*48000/44100))<3);
});
test('worklet starvation fades to silence, reprimes and terminates explicitly',()=>{
    const w=worklet();w.send({type:'config',target:.25,rate:1});
    for(let i=0;i<15;i++)w.send({type:'pcm',planes:[new Float32Array(960).fill(.4)],sampleRate:48000});
    for(let i=0;i<240;i++)w.render();
    assert.equal(w.render()[0][127],0);
    assert.ok(w.messages.some(m=>m.underruns>0));
    w.send({type:'dispose'});
    assert.equal(w.processor.process([],[[new Float32Array(128),new Float32Array(128)]]),false);
});
