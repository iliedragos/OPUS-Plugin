'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {spawnSync}=require('node:child_process');
const {serverModule}=require('./server-helpers');
const {frontend,worklet}=require('./helpers');
function decoderNamespace(){
    // Non-worker decoder is the actual shipped WASM bundle. Worker class is unused here.
    const c={console,WebAssembly,Uint8Array,Float32Array,ArrayBuffer,TextDecoder,TextEncoder,performance,setTimeout,clearTimeout,atob,btoa,Worker:class{}};
    c.self=c;c.globalThis=c;vm.createContext(c);vm.runInContext(fs.readFileSync(require('node:path').join(__dirname,'../plugins/opus/opus-decoder.min.js'),'utf8'),c);
    return c['opus-decoder'];
}
for (const channels of [1, 2]) for (const frames of [960, 16320, 32640]) {
    test(`real FFmpeg preserves all ${frames} initial PCM frames (${channels}ch)`, async () => {
        const api = serverModule().api;
        const config = api.normalizeOpusConfig({}, () => {}, channels);
        const result = spawnSync('ffmpeg', api.buildFfmpegArguments({SampleRate:48000, Channels:channels}, config), {
            input: Buffer.alloc(frames * channels * 2), maxBuffer: 1024 * 1024, timeout: 10000
        });
        assert.equal(result.status, 0, result.stderr.toString());
        const packets = [];
        new api.OggDemuxer(packet => packets.push(packet)).Push(result.stdout);
        assert.ok(packets.length >= 3, 'PCM must produce headers and at least one audio packet');
        const header = api.parseOpusHead(packets[0]);
        let endGranule;
        for (let offset = 0; offset < result.stdout.length;) {
            assert.equal(result.stdout.subarray(offset, offset + 4).toString(), 'OggS');
            const segments = result.stdout[offset + 26];
            const sizes = result.stdout.subarray(offset + 27, offset + 27 + segments);
            if (result.stdout[offset + 5] & 4) endGranule = result.stdout.readBigUInt64LE(offset + 6);
            offset += 27 + segments + sizes.reduce((sum, size) => sum + size, 0);
        }
        assert.equal(endGranule, BigInt(frames + header.preSkip), 'EOS granule must account for every input frame plus pre-skip');
        const decoder = new (decoderNamespace().OpusDecoder)({channels, preSkip:header.preSkip, sampleRate:48000,
            forceStereo:false, streamCount:1, coupledStreamCount:channels === 2 ? 1 : 0,
            channelMappingTable:channels === 2 ? [0, 1] : [0]});
        let decodedFrames = 0;
        try {
            await decoder.ready;
            for (const packet of packets.slice(2)) {
                const decoded = decoder.decodeFrame(new Uint8Array(packet));
                assert.equal(decoded.errors.length, 0);
                decodedFrames += decoded.samplesDecoded;
            }
            assert.ok(decodedFrames >= frames && decodedFrames < frames + 960,
                `decoded ${decodedFrames} frames for ${frames} input frames (including at most one frame of end padding)`);
        } finally { decoder.free(); }
    });
}

test('real FFmpeg emits live PCM before stdin closes', {timeout:15000}, async () => {
    const {EventEmitter, once} = require('node:events');
    const socket = new EventEmitter(); socket.readyState = 1; socket.bufferedAmount = 0;
    let resolveAudio;
    const audio = new Promise(resolve => { resolveAudio = resolve; });
    const client = {Socket:socket, SendBinary:packet => {
        if (!['OpusHead', 'OpusTags'].includes(packet.subarray(0, 8).toString())) resolveAudio();
    }};
    const provider = new (serverModule().api.OpusProvider)({Channels:2, SampleRate:48000, FallbackClients:{opus:new Set([client])}}, 'ffmpeg');
    const child = provider.Process;
    const exit = once(child, 'exit');
    let timer;
    try {
        provider.InsertData(Buffer.alloc(65280));
        await Promise.race([audio, new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('No live audio before EOF')), 10000);
        })]);
        assert.equal(child.stdin.writableEnded, false);
        child.stdin.end();
        await exit;
    } finally {
        clearTimeout(timer);
        provider.Dispose();
        if (child.exitCode === null) { child.kill('SIGKILL'); await exit; }
    }
});
for(const channels of [1,2])test(`real FFmpeg libopus -> Ogg parser -> bundled WASM -> adaptive playback (${channels}ch)`,async()=>{
    const api=serverModule().api;
    const settings=api.normalizeOpusConfig({opusBitrate:'96k',opusFrameDuration:'20'},()=>{},channels);
    const args=api.buildFfmpegArguments({SampleRate:48000,Channels:channels},settings);
    const pcm=Buffer.alloc(48000*channels*2);
    for(let i=0;i<48000;i++)for(let c=0;c<channels;c++)pcm.writeInt16LE(Math.round(Math.sin(2*Math.PI*(c?1500:1000)*i/48000)*12000),2*(i*channels+c));
    const result=spawnSync('ffmpeg',args,{input:pcm,maxBuffer:1024*1024});
    assert.equal(result.status,0,result.stderr.toString());
    const packets=[];const demux=new api.OggDemuxer(p=>packets.push(p));
    for(let i=0;i<result.stdout.length;i+=137)demux.Push(result.stdout.subarray(i,i+137));
    const header=api.parseOpusHead(packets[0]);assert.equal(header.channels,channels);assert.ok(header.preSkip>0);
    const decoder=new (decoderNamespace().OpusDecoder)({channels,preSkip:header.preSkip,sampleRate:48000,forceStereo:false,streamCount:1,coupledStreamCount:channels===2?1:0,channelMappingTable:channels===2?[0,1]:[0]});
    await decoder.ready;
    const f=frontend();let total=0,peak=0;
    try {
        for(const packet of packets){if(packet.subarray(0,8).toString()==='OpusHead'||packet.subarray(0,8).toString()==='OpusTags')continue;
            const out=decoder.decodeFrame(new Uint8Array(packet));assert.equal(out.errors.length,0);assert.equal(out.channelData.length,channels);
            total+=out.samplesDecoded;for(const v of out.channelData[0]){assert.ok(Number.isFinite(v));peak=Math.max(peak,Math.abs(v));}
            f.reader.OnPcm(out.channelData,out.sampleRate,out.samplesDecoded);f.advance(out.samplesDecoded/48);f.tick();
        }
        assert.ok(total>=47000&&total<=49000);assert.ok(peak>.25&&peak<.5);assert.equal(f.reader.GetBufferDiagnostics().catchUpDrops,0);
    }finally{decoder.free();f.reader.Reset();}
});
test('malformed OpusHead safely negotiates MP3 and does not emit audio',()=>{
    const f=frontend();const bad=new Uint8Array(19);bad.set(Buffer.from('OpusHead'));bad[9]=255;
    f.reader.PushData(bad);assert.equal(f.fallback.SelectedFormatName,'mp3');assert.equal(f.fallback.Audio.sources.size,0);
});
test('malformed worklet messages cannot corrupt queue or propagate NaNs',()=>{
    const w=worklet();
    for(const data of [null,{}, {type:'pcm',planes:[new Float32Array(100000)],sampleRate:48000},{type:'pcm',planes:[new Float32Array(960)],sampleRate:Infinity},{type:'config',target:NaN,rate:Infinity}])w.send(data);
    assert.equal(w.processor.count,0);
    for(let i=0;i<12;i++)w.send({type:'pcm',planes:[new Float32Array(960).fill(NaN)],sampleRate:48000});
    for(let i=0;i<50;i++)assert.ok(w.render()[0].every(Number.isFinite));
});
test('real server provider emits live Opus packets and retires its FFmpeg child',async()=>{
    const {EventEmitter}=require('node:events');
    const s={Channels:2,SampleRate:48000,FallbackClients:{opus:new Set()}};
    const m=serverModule();const packets=[];
    const socket=new EventEmitter();socket.readyState=1;socket.bufferedAmount=0;
    s.FallbackClients.opus.add({Socket:socket,SendBinary:p=>packets.push(Buffer.from(p))});
    const provider=new m.api.OpusProvider(s,'ffmpeg');const child=provider.Process;
    const exited=new Promise((resolve,reject)=>{child.once('exit',resolve);child.once('error',reject);});
    try {
        provider.InsertData(Buffer.alloc(48000*2*2));child.stdin.end();await exited;
        assert.ok(packets.length>=40);assert.equal(packets[0].subarray(0,8).toString(),'OpusHead');
        assert.equal(provider.Process,null);
    }finally{provider.Dispose();}
});

test('real FFmpeg drains two native-sized PCM bursts without server loss',async()=>{
    const {once}=require('node:events');
    const {EventEmitter}=require('node:events'),packets=[],socket=new EventEmitter();
    socket.readyState=1;socket.bufferedAmount=0;
    const client={Socket:socket,SendBinary:p=>packets.push(Buffer.from(p))};
    const m=serverModule(),provider=new m.api.OpusProvider({Channels:2,SampleRate:48000,FallbackClients:{opus:new Set([client])}},'ffmpeg');
    const child=provider.Process;
    const exit=once(child,'exit');
    try {
        provider.InsertData(Buffer.alloc(65280));provider.InsertData(Buffer.alloc(65280));
        while(provider.PendingPcmBytes)await once(child.stdin,'drain');
        child.stdin.end();await exit;
        assert.equal(provider.DroppedPcmBytes,0);
        const audio=packets.filter(p=>!['OpusHead','OpusTags'].includes(p.subarray(0,8).toString()));
        assert.ok(audio.length>=34,`encoded packets=${audio.length}`);
    }finally{provider.Dispose();}
});
