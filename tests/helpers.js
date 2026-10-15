'use strict';
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
class Param {
    constructor(value = 1) { this.value = value; }
    cancelScheduledValues() {}
    setValueAtTime(v) { this.value = v; }
    linearRampToValueAtTime(v) { this.value = v; }
    exponentialRampToValueAtTime(v) { this.value = v; }
}
class AudioContext {
    constructor() { this.currentTime = 0; this.sampleRate = 48000; this.state = 'running'; this.destination = {}; this.sources = new Set(); this.events = new Map(); }
    createGain() { return {gain: new Param(), connect() {}, disconnect() {}}; }
    createBuffer(c, n, r) {
        const data = Array.from({length:c},()=>new Float32Array(n));
        return {numberOfChannels:c,length:n,sampleRate:r,duration:n/r,getChannelData:i=>data[i]};
    }
    createBufferSource() {
        const audio = this;
        const source = {playbackRate:new Param(),connect(){},disconnect(){audio.sources.delete(this);},start(t){this.started=t;audio.sources.add(this);},stop(){this.stopped=true;this.onended?.();}};
        return source;
    }
    addEventListener(k,fn) { this.events.set(k,fn); }
    removeEventListener(k,fn) { if(this.events.get(k)===fn)this.events.delete(k); }
}
function frontend(options = {}) {
    let now = 0, nextTimer = 1;
    const timers = new Map(), listeners = new Map(), scripts = [];
    const freq = {textContent:'91.600'};
    const context = {console:{log(){},warn(){},info(){},debug(){},error(){}},AudioContext,Audio:class{canPlayType(){return 'probably';}},performance:{now:()=>now},Date,Uint8Array,Float32Array,ArrayBuffer,DataView,URLSearchParams,location:{search:'',hostname:'localhost',port:'8080'},document:{body:null,head:{appendChild(s){scripts.push(s);}},addEventListener(k,fn){listeners.set(k,fn);},removeEventListener(k,fn){listeners.delete(k);},getElementById:()=>freq,createElement:()=>({})},setInterval(fn){const id=nextTimer++;timers.set(id,fn);return id;},clearInterval(id){timers.delete(id);},setTimeout(fn){const id=nextTimer++;timers.set(id,fn);return id;},clearTimeout(id){timers.delete(id);},isAndroid:false,OSName:'Linux',BrowserName:'Chrome',Logging:class{Log(){}},...options};
    context.window=context;
    vm.createContext(context);
    for (const file of ['3las.formatreader.js','3las.liveaudioplayer.js','3las.fallback.js']) {
        vm.runInContext(fs.readFileSync(path.join(process.env.FM_DX_WEBSERVER_DIR || path.resolve(__dirname,'../.test-upstream'),'web/js/3las/fallback',file),'utf8'),context);
    }
    context.AudioFormatReader_MPEG = function(...args) {context.AudioFormatReader.apply(this,args);};
    context.AudioFormatReader_MPEG.prototype = Object.create(context.AudioFormatReader.prototype);
    vm.runInContext(fs.readFileSync(path.join(__dirname,'../plugins/opus/frontend.js'),'utf8'),context);
    const fallback=new context.Fallback(new context.Logging(),new context.Fallback_Settings());
    fallback.WebSocket={Send(){}};
    context.Stream={Fallback:fallback};
    return {context,fallback,reader:fallback.FormatReader,timers,listeners,scripts,freq,baselineTimerCount:timers.size,setNow(v){now=v;},advance(ms){now+=ms;fallback.Audio.currentTime+=ms/1000;},tick(){for(const fn of [...timers.values()])fn();}};
}
function worklet(rate=48000) {
    const messages=[];
    let Ctor;
    const context={sampleRate:rate,currentTime:0,Float32Array,ArrayBuffer,Number,Math,AudioWorkletProcessor:class{constructor(){this.port={postMessage:m=>messages.push(m),onmessage:null};}},registerProcessor(_name,c){Ctor=c;}};
    vm.createContext(context);
    vm.runInContext(fs.readFileSync(path.join(__dirname,'../plugins/opus/opus-worklet.js'),'utf8'),context);
    const processor=new Ctor();
    return {processor,messages,send(m){processor.port.onmessage({data:m});},render(n=128){const out=[new Float32Array(n),new Float32Array(n)];processor.process([], [out]);context.currentTime+=n/rate;return out;}};
}
module.exports={frontend,worklet,AudioContext};
