'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {frontend}=require('./helpers');
function trace(delay){const c=frontend().reader.Controller;let min=1,max=1,lastNow=0;
    for(let media=0;media<=60000;media+=20){const now=Math.max(lastNow,media+delay(media));lastNow=now;c.arrival(now,20);c.update(now,c.target);min=Math.min(min,c.rate);max=Math.max(max,c.rate);}
    return {c,min,max};
}
test('a temporary 160ms transport delay cannot cause a false clock slowdown',()=>{
    const t=trace(media=>media>=4800&&media<5800?160:0);
    assert.ok(t.min>=.999,`min rate=${t.min}`);assert.ok(t.max<=1.001,`max rate=${t.max}`);
});
test('a lasting latency step is not a change in media clock rate',()=>{
    const t=trace(media=>media>=4800?160:0);
    assert.ok(t.min>=.999,`min rate=${t.min}`);assert.ok(t.max<=1.001,`max rate=${t.max}`);
});
test('regular 340ms delivery bursts do not bias the media clock estimator',()=>{
    const t=trace(media=>Math.floor(media/340)*340-media);
    assert.ok(t.min>=.999,`min rate=${t.min}`);assert.ok(t.max<=1.001,`max rate=${t.max}`);
});
test('variable delivery bursts cannot create a sustained false clock correction',()=>{
    const c=frontend().reader.Controller;let media=0,seed=77,min=1,max=1;
    while(media<120000){seed=(Math.imul(seed,1664525)+1013904223)>>>0;const frames=4+seed%20;
        for(let i=0;i<frames;i++){c.arrival(media,20);c.update(media,c.target);min=Math.min(min,c.rate);max=Math.max(max,c.rate);}
        media+=frames*20;
    }
    assert.ok(min>=.999,`min=${min}`);assert.ok(max<=1.001,`max=${max}`);
});
test('a 160ms delay and catch-up preserve worklet audio without a 2% speed excursion',()=>{
    const {worklet}=require('./helpers'),c=frontend().reader.Controller,w=worklet();
    const packet={type:'pcm',planes:[new Float32Array(960).fill(.2)],sampleRate:48000};
    let media=0,lastArrival=0,nextUpdate=0,min=1,max=1;
    for(let block=0;block<22500;block++){
        const now=block*128/48;
        while(media<=now){const arrival=Math.max(lastArrival,media+(media>=4800&&media<5800?160:0));if(arrival>now)break;
            c.arrival(arrival,20);w.send(packet);lastArrival=arrival;media+=20;}
        w.render();
        if(now>=nextUpdate){c.update(now,w.processor.count/48000);w.send({type:'config',target:c.target,rate:c.rate});nextUpdate+=250;min=Math.min(min,c.rate);max=Math.max(max,c.rate);}
    }
    assert.ok(min>=.995-1e-9,`min=${min}`);assert.ok(max<=1.005+1e-9,`max=${max}`);
    assert.equal(w.processor.underruns,0);assert.equal(w.processor.resyncs,0);
});
test('clock evidence stays bounded and reset/pause clears observations without losing learned drift',()=>{
    const c=frontend().reader.Controller;
    for(let i=0;i<360000;i++)c.arrival(i*20,20);
    assert.ok(c.clockAnchors.length<=32);
    c.clockRate=1.02;c.resetTiming();
    assert.equal(c.clockAnchors.length,0);assert.equal(c.clockWindowSample,null);assert.equal(c.clockRate,1.02);
    c.arrival(8000000,20);c.arrival(8003000,20);
    assert.equal(c.clockAnchors.length,0);assert.equal(c.clockMediaMs,0);
});
test('clock confirmation rejects changing burst extrema across 200 deterministic patterns',()=>{
    for(let initial=0;initial<200;initial++){
        const c=frontend().reader.Controller;let media=0,seed=initial;
        while(media<120000){seed=(Math.imul(seed,1664525)+1013904223)>>>0;const frames=4+seed%20;
            for(let i=0;i<frames;i++)c.arrival(media+460,20);
            media+=frames*20;
            assert.ok(Math.abs(c.clockRate-1)<.001,`seed=${initial} time=${media} clock=${c.clockRate}`);
        }
    }
});
for(const cadence of [.98,1.02])test(`real ${cadence} clock drift is learned with variable delivery bursts`,()=>{
    for(let initial=0;initial<10;initial++){
        const c=frontend().reader.Controller;let media=0,seed=initial;
        while(media<300000){seed=(Math.imul(seed,1664525)+1013904223)>>>0;const frames=4+seed%20;
            for(let i=0;i<frames;i++)c.arrival(media/cadence+460,20);
            media+=frames*20;
        }
        assert.ok(Math.abs(c.clockRate-cadence)<.003,`seed=${initial} clock=${c.clockRate}`);
    }
});
for(const step of [160,340,460])for(const at of [16000,32000])test(`late ${step}ms latency step at ${at}ms never becomes clock drift`,()=>{
    const t=trace(media=>media>=at?step:0);
    assert.ok(t.min>=.999,`min=${t.min}`);assert.ok(t.max<=1.001,`max=${t.max}`);
});
for(const cadence of [.98,1.02])test(`variable bursts and ${cadence} drift stay playable in the worklet`,()=>{
    const {worklet}=require('./helpers'),c=frontend().reader.Controller,w=worklet();
    const packet={type:'pcm',planes:[new Float32Array(960).fill(.2)],sampleRate:48000};
    let media=0,seed=3,nextUpdate=0,lastUnderruns=0;
    for(let block=0;block<67500;block++){
        const now=block*128/48;
        while(media/cadence+460<=now){seed=(Math.imul(seed,1664525)+1013904223)>>>0;const frames=4+seed%14;
            for(let i=0;i<frames;i++){c.arrival(media/cadence+460,20);w.send(packet);}media+=frames*20;}
        w.render();
        if(w.processor.underruns>lastUnderruns){c.starve(now);lastUnderruns=w.processor.underruns;}
        if(now>=nextUpdate){c.update(now,w.processor.count/48000);w.send({type:'config',target:c.target,rate:c.rate});nextUpdate+=250;}
    }
    assert.ok(w.processor.underruns<=1,`underruns=${w.processor.underruns}`);
    assert.ok(w.processor.resyncs<=1,`resyncs=${w.processor.resyncs}`);
    assert.ok(Math.abs(c.clockRate-cadence)<.003,`clock=${c.clockRate}`);
});
test('variable burst extrema plus a late latency step do not jointly create false drift',()=>{
    for(let initial=0;initial<200;initial++){
        const c=frontend().reader.Controller;let media=0,seed=initial;
        while(media<300000){seed=(Math.imul(seed,1664525)+1013904223)>>>0;const frames=4+seed%20;
            for(let i=0;i<frames;i++)c.arrival(media+460+(media>=32000?160:0),20);
            media+=frames*20;
            assert.ok(Math.abs(c.clockRate-1)<.001,`seed=${initial} time=${media} clock=${c.clockRate}`);
        }
    }
});
