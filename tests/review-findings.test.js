'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const {frontend,worklet}=require('./helpers'),{serverModule}=require('./server-helpers');
test('closing hung WASM initialization frees decoder without waiting for ready',async()=>{
    let freed=0;
    const f=frontend();const scripts=[]; // capture the already-created prewarm script by creating a fresh loader context below
    f.context.document.head.appendChild=s=>scripts.push(s);
    // prewarm script belongs to initial context; helpers exposes it explicitly.
    const h=new Uint8Array(19);h.set(Buffer.from('OpusHead'));h[8]=1;h[9]=2;
    f.context['opus-decoder']={OpusDecoder:class{constructor(){this.ready=new Promise(()=>{});}free(){freed++;}}};
    f.reader.PushData(h);f.scripts[0].onload();await new Promise(setImmediate);
    f.reader.Reset();assert.equal(freed,1);
});
test('closing hung WASM reset frees decoder without waiting for reset promise',async()=>{
    let freed=0;
    const f=frontend();const h=new Uint8Array(19);h.set(Buffer.from('OpusHead'));h[8]=1;h[9]=2;
    f.context['opus-decoder']={OpusDecoder:class{constructor(){this.ready=Promise.resolve();}reset(){return new Promise(()=>{});}free(){freed++;}}};
    f.reader.PushData(h);f.scripts[0].onload();await new Promise(setImmediate);
    f.reader.PurgeData();f.reader.Reset();assert.equal(freed,1);
});
test('stuck encoder is force-killed and respawn waits until retirement',()=>{
    const children=[];
    const spawn=()=>{const p=new EventEmitter();p.pid=123+children.length;p.stdout=new EventEmitter();p.stderr=new EventEmitter();p.stdin=new EventEmitter();p.stdin.writable=true;p.stdin.write=()=>true;p.signals=[];p.kill=signal=>p.signals.push(signal||'SIGTERM');children.push(p);return p;};
    const m=serverModule({spawn});const s={Channels:2,SampleRate:48000,FallbackClients:{opus:new Set()}};
    const p=new m.api.OpusProvider(s,'ffmpeg');p.InsertData(Buffer.alloc(3840));m.setNow(14000);p.InsertData(Buffer.alloc(3840));p.CheckHealth();
    p.Spawn();assert.equal(children.length,1);
    for(const fn of [...m.timers.values()])fn();
    assert.ok(children[0].signals.includes('SIGKILL'));assert.equal(children.length,1);
    children[0].emit('exit',null,'SIGKILL');p.Spawn();assert.equal(children.length,2);p.Dispose();children[1].emit('exit',null,'SIGKILL');
});
for(const cadence of [.98,1.02])test(`sustained ${cadence} PCM cadence is corrected without repeated starvation`,()=>{
    const c=frontend().reader.Controller,w=worklet();w.send({type:'config',target:.2,rate:1});
    let nextPacket=0,lastUnderruns=0,nextUpdate=0;
    const packet={type:'pcm',planes:[new Float32Array(960).fill(.2)],sampleRate:48000};
    for(let block=0;block<33750;block++){
        const now=block*128/48;
        while(nextPacket<=now){c.arrival(nextPacket,20);w.send(packet);nextPacket+=20/cadence;}
        w.render();
        if(w.processor.underruns>lastUnderruns){c.starve(now);lastUnderruns=w.processor.underruns;}
        if(now>=nextUpdate){c.update(now,w.processor.count/48000);w.send({type:'config',target:c.target,rate:c.rate});nextUpdate+=250;}
    }
    assert.ok(w.processor.underruns<=1,`underruns=${w.processor.underruns}`);
    assert.ok(w.processor.resyncs<=1,`resyncs=${w.processor.resyncs}`);
    assert.ok(Math.abs(c.rate-cadence)<.003,`rate=${c.rate}`);
});
