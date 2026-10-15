'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {Writable}=require('node:stream'),{EventEmitter}=require('node:events');
const {serverModule}=require('./server-helpers'),{worklet,frontend}=require('./helpers');
function fixture(){
    const chunks=[],callbacks=[];
    const stdin=new Writable({highWaterMark:16384,write(b,_e,done){chunks.push(Buffer.from(b));callbacks.push(done);}});
    const child=new EventEmitter();Object.assign(child,{stdin,stdout:new EventEmitter(),stderr:new EventEmitter(),kill(){}});
    const m=serverModule({spawn:()=>child}),p=new m.api.OpusProvider({Channels:2,SampleRate:48000,FallbackClients:{opus:new Set()}},'ffmpeg');
    return {p,stdin,chunks,drain:async()=>{while(callbacks.length){callbacks.shift()();await new Promise(setImmediate);}}};
}
test('native-sized 340ms PCM bursts remain intact and ordered through real stdin backpressure',async()=>{
    const f=fixture(),a=Buffer.alloc(65280,17),b=Buffer.alloc(65280,23);
    f.p.InsertData(a);f.p.InsertData(b);b.fill(99);
    assert.equal(f.p.DroppedPcmBytes,0);assert.equal(f.stdin.writableLength,65280);
    await f.drain();assert.deepEqual(Buffer.concat(f.chunks),Buffer.concat([a,Buffer.alloc(65280,23)]));
    assert.equal(f.p.PendingPcmBytes,0);f.p.Dispose();
});
test('persistent encoder pressure bounds combined app and stdin memory, including tiny chunks',()=>{
    const f=fixture();f.p.InsertData(Buffer.alloc(65280));
    for(let i=0;i<100000;i++)f.p.InsertData(Buffer.alloc(4));
    assert.ok(f.p.DroppedPcmBytes>0);
    assert.ok(f.p.PendingPcmBytes+f.stdin.writableLength<=192000*1.5);
    assert.ok(f.p.PendingPcmFrames.length<256);
    assert.ok(f.p.PcmPartial.length<4);f.p.Dispose();
});
test('fragmented channel samples preserve exact PCM bytes',async()=>{
    const f=fixture(),data=Buffer.from([1,2,3,4,5,6,7,8,9,10,11,12]);
    for(let i=0;i<data.length;i++)f.p.InsertData(data.subarray(i,i+1));
    await f.drain();assert.deepEqual(Buffer.concat(f.chunks),data);f.p.Dispose();
});
test('worklet reserves presentation time for burst input and preserves repeated 340ms cadence',()=>{
    const w=worklet(),c=frontend().reader.Controller;let nextBurst=0,nextUpdate=0,lastUnderruns=0;
    for(let block=0;block<22500;block++){
        const now=block*128/48;
        if(now>=nextBurst){for(let i=0;i<17;i++){c.arrival(now,20);w.send({type:'pcm',planes:[new Float32Array(960).fill(.3)],sampleRate:48000});}nextBurst+=340;}
        const out=w.render();
        if(now<300)assert.equal(out[0][127],0);
        if(w.processor.underruns>lastUnderruns){c.starve(now);lastUnderruns=w.processor.underruns;}
        if(now>=nextUpdate){c.update(now,w.processor.count/48000);w.send({type:'config',target:c.target,rate:c.rate});nextUpdate+=250;}
    }
    assert.equal(w.processor.underruns,0);assert.equal(w.processor.resyncs,0);
    assert.ok(c.target>=.25&&c.target<=.6);
});

test('worklet handover preserves an already-running presentation timeline',()=>{
    const w=worklet();w.send({type:'config',target:1/3,rate:1,startDelay:0,handover:true});
    for(let i=0;i<10;i++)w.send({type:'pcm',planes:[new Float32Array(960).fill(.3)],sampleRate:48000});
    w.render();assert.equal(w.processor.playing,true);
    assert.ok(w.render()[0][127]>.29);
    w.send({type:'reset'});
    for(let i=0;i<17;i++)w.send({type:'pcm',planes:[new Float32Array(960).fill(.3)],sampleRate:48000});
    w.render();assert.equal(w.processor.playing,false);
});

test('oversized PCM input keeps only a bounded, aligned recent suffix',async()=>{
    const f=fixture(),data=Buffer.alloc(4*1024*1024+3,7);
    f.p.InsertData(data);
    assert.ok(f.stdin.writableLength<=192000*1.5);
    assert.equal(f.p.PcmPartial.length,3);
    assert.equal(f.p.DroppedPcmBytes+f.stdin.writableLength+3,data.length);
    assert.equal(f.p.PendingPcmBytes,0);
    await f.drain();f.p.Dispose();
});
test('random fragment boundaries preserve byte order across drain and queue coalescing',async()=>{
    const f=fixture(),data=Buffer.alloc(192000);
    for(let i=0;i<data.length;i++)data[i]=i%251;
    let seed=123,offset=0;
    while(offset<data.length){seed=(Math.imul(seed,1664525)+1013904223)>>>0;const size=Math.min(seed%8192+1,data.length-offset);f.p.InsertData(data.subarray(offset,offset+size));offset+=size;}
    // This is a full second without drain; admission intentionally caps it.
    const pipePrefix=f.stdin.writableLength;
    assert.ok(f.p.PendingPcmBytes+f.stdin.writableLength<=192000*1.5);
    assert.ok(f.p.DroppedPcmBytes>0);
    assert.equal(f.p.PcmPartial.length,0);
    await f.drain();
    const actual=Buffer.concat(f.chunks);
    assert.deepEqual(actual.subarray(0,pipePrefix),data.subarray(0,pipePrefix));
    assert.deepEqual(actual.subarray(pipePrefix),data.subarray(data.length-(actual.length-pipePrefix)));
    f.p.Dispose();
});
