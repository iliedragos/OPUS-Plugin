'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const {serverModule}=require('./server-helpers');
function processFake(){const p=new EventEmitter();p.stdout=new EventEmitter();p.stderr=new EventEmitter();p.stdin=new EventEmitter();p.stdin.writable=true;p.stdin.write=()=>true;p.kill=()=>p.killed=true;return p;}
function server(){return {Channels:2,SampleRate:48000,FallbackClients:{mp3:new Set(),wav:new Set()},FallbackProvider:{},Clients:new Set(),SetFallback(){},GetStats(){return {Fallback:{mp3:0,wav:0}};},DestroyClient(c){this.Clients.delete(c);c.Socket.emit('close');}};}
function client(s){const c={Socket:new EventEmitter(),sent:0,SendBinary(){this.sent++;}};c.Socket.bufferedAmount=0;c.Socket.readyState=1;s.Clients.add(c);return c;}
test('slow client is removed long before a 512KiB queue and other listeners continue',()=>{
    const m=serverModule({spawn:processFake}),s=server();const provider=m.api.installServerHooks(s,'ffmpeg');
    const slow=client(s),fast=client(s);s.SetFallback(slow,'opus');s.SetFallback(fast,'opus');
    slow.Socket.bufferedAmount=80000;
    provider.SendPacket(slow,Buffer.alloc(240));provider.SendPacket(fast,Buffer.alloc(240));
    assert.equal(s.FallbackClients.opus.has(slow),false);assert.equal(fast.sent,1);
});
test('socket close releases client membership even if no further audio is produced',()=>{
    const m=serverModule({spawn:processFake}),s=server();m.api.installServerHooks(s,'ffmpeg');
    const c=client(s);s.SetFallback(c,'opus');c.Socket.emit('close');
    assert.equal(s.FallbackClients.opus.size,0);assert.equal(s.Clients.size,0);
});
test('persistent transport backlog is disconnected by a shared watchdog',()=>{
    const m=serverModule({spawn:processFake}),s=server();m.api.installServerHooks(s,'ffmpeg');
    const c=client(s);s.SetFallback(c,'opus');c.Socket.bufferedAmount=5000;m.tick();
    m.setNow(12000);m.tick();
    assert.equal(s.FallbackClients.opus.size,0);
});
test('live PCM with a stuck encoder triggers bounded restart without exit event',()=>{
    const processes=[];const m=serverModule({spawn:()=>{const p=processFake();processes.push(p);return p;}}),s=server();
    const provider=m.api.installServerHooks(s,'ffmpeg');
    provider.InsertData(Buffer.alloc(3840));m.setNow(14000);provider.InsertData(Buffer.alloc(3840));m.tick();
    assert.equal(processes[0].killed,true);assert.ok(provider.RestartTimer);
});
test('asset publication includes worklet and rejects traversal and symlink destinations',()=>{
    const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
    const m=serverModule({spawn:processFake}),temp=fs.mkdtempSync(path.join(os.tmpdir(),'opus-assets-'));
    const out=path.join(temp,'web');const result=m.api.publishAssets({webPluginDir:out});
    assert.ok(fs.existsSync(path.join(out,'opus-worklet.js')));assert.equal(result.failed,0);
    assert.equal(m.api.publishAssets({webPluginDir:out,assetNames:['../secret']}).failed,1);
    fs.unlinkSync(path.join(out,'opus-worklet.js'));fs.symlinkSync(path.join(temp,'elsewhere'),path.join(out,'opus-worklet.js'));
    assert.equal(m.api.publishAssets({webPluginDir:out,assetNames:['opus-worklet.js']}).failed,1);
    fs.rmSync(temp,{recursive:true,force:true});
});
test('Opus configuration rejects shell syntax and impossible channel/rate combinations',()=>{
    const m=serverModule({spawn:processFake});
    const normalized=m.api.normalizeOpusConfig({opusBitrate:'96k; touch /tmp/unsafe',opusApplication:'$(id)',opusFrameDuration:'evil',samplerateOffset:Infinity},()=>{},2);
    assert.equal(normalized.bitrate,'96k');assert.equal(normalized.application,'audio');assert.equal(normalized.frameDuration,'20');
    assert.throws(()=>m.api.getEffectiveInputSampleRate({SampleRate:NaN},normalized));
});
