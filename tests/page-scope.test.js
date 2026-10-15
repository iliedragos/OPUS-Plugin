'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const {frontend}=require('./helpers');
const source=fs.readFileSync(path.join(__dirname,'../plugins/opus/frontend.js'),'utf8');
function dom(admin=false,bodyReady=true){
    const nodes=[],scripts=[],listeners=new Map();
    const document={body:bodyReady?{appendChild:n=>nodes.push(n)}:null,
        head:{appendChild:n=>scripts.push(n)},querySelector:selector=>admin&&selector==='.setup-wrapper.admin-wrapper'?{}:null,
        getElementById:()=>null,createElement:()=>({style:{cssText:''},textContent:'',addEventListener(k,fn){this[k]=fn;}}),
        addEventListener:(k,fn)=>listeners.set(k,fn),removeEventListener:k=>listeners.delete(k)};
    return {document,nodes,scripts,listeners};
}
function withoutPlayer(options={}){
    const d=dom(options.admin,options.bodyReady),timers=new Map();let id=0;
    const context={document:d.document,window:null,location:{search:options.search||'',pathname:'/setup'},performance:{now:()=>0},URLSearchParams,
        setInterval:fn=>{timers.set(++id,fn);return id;},clearInterval:id=>timers.delete(id),
        setTimeout:fn=>{timers.set(++id,fn);return id;},clearTimeout:id=>timers.delete(id),console};
    context.window=context;vm.createContext(context);vm.runInContext(source,context);
    return {...d,context,timers};
}
for(const bodyReady of [true,false])test(`admin bootstrap without 3LAS has no UI or timer side effects (body=${bodyReady})`,()=>{
    const f=withoutPlayer({admin:true,bodyReady});
    assert.equal(f.nodes.length,0);assert.equal(f.timers.size,0);assert.equal(f.scripts.length,0);
    assert.equal(f.listeners.size,0);assert.equal(f.context.__fmDxOpusFrontendPatch,undefined);
});
test('missing playback libraries do not claim MP3 fallback even on non-admin pages',()=>{
    const f=withoutPlayer({admin:false});
    assert.equal(f.nodes.length,0);assert.equal(f.timers.size,0);assert.equal(f.scripts.length,0);
});
test('admin page with inherited playback APIs neither patches nor prewarms decoder',()=>{
    const d=dom(true),f=frontend({document:d.document});
    assert.equal(d.nodes.length,0);assert.equal(d.scripts.length,0);assert.equal(f.timers.size,0);
    assert.equal(f.context.__fmDxOpusFrontendPatch,undefined);assert.equal(f.fallback.SelectedFormatName,'mp3');
});
test('listener badge follows local playback format and renders diagnostic text safely',()=>{
    const d=dom(),f=frontend({document:d.document,AudioDecoder:class{},EncodedAudioChunk:class{}});
    assert.equal(d.nodes.length,2);assert.ok(f.context.__fmDxOpusFrontendPatch.patched);
    f.reader.OnPcm([new Float32Array(960)],48000,960);f.tick();
    const [pill,panel]=d.nodes;assert.match(pill.textContent,/^OPUS/);
    f.fallback.SelectedFormatName='mp3';f.tick();assert.equal(pill.textContent,'MP3');
    f.fallback.SelectedFormatName='<img onerror=alert(1)>';f.tick();
    assert.equal(pill.textContent,'<IMG ONERROR=ALERT(1)>');assert.equal(pill.innerHTML,undefined);
    pill.click();assert.ok(panel.textContent.includes('selected     <img onerror=alert(1)>'));assert.equal(panel.innerHTML,undefined);
    f.context.Stream=null;f.tick();assert.equal(pill.textContent,'AUDIO idle');f.reader.Reset();
});
test('repeated listener script loads keep a single badge and diagnostics timer',()=>{
    const d=dom(),f=frontend({document:d.document,AudioDecoder:class{},EncodedAudioChunk:class{}});
    const count=f.timers.size;
    for(let i=0;i<100;i++)vm.runInContext(source,f.context);
    assert.equal(d.nodes.length,2);assert.equal(f.timers.size,count);
});
