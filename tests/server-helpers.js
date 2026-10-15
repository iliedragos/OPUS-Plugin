'use strict';
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
function serverModule(options={}) {
    const logs=[],timers=new Map();let now=10000,id=0;
    const audioServer={waitUntilReady:new Promise(()=>{})};
    const logger=Object.fromEntries(['logInfo','logError','logWarn','logDebug','logFfmpeg'].map(k=>[k,s=>logs.push(s)]));
    const context={Buffer,Uint8Array,process:{env:{NODE_ENV:'test'},pid:123},module:{exports:{}},__dirname:path.resolve(__dirname,'../plugins/opus'),console,Date:{now:()=>now},setTimeout(fn){timers.set(++id,fn);return id;},clearTimeout(i){timers.delete(i);},setInterval(fn){const h={id:++id,unref(){}};timers.set(h,fn);return h;},clearInterval(h){timers.delete(h);},require(name){if(name==='../../server/stream/3las.server')return audioServer;if(name==='../../server/stream/checkFFmpeg')return ()=>Promise.resolve('ffmpeg');if(name==='../../server/server_config')return {serverConfig:{audio:{opusBitrate:'96k'}}};if(name==='../../server/console')return logger;if(name==='perf_hooks')return {performance:{now:()=>now}};if(name==='child_process'&&options.spawn)return {spawn:options.spawn};return require(name);}};
    vm.createContext(context);vm.runInContext(fs.readFileSync(path.join(__dirname,'../plugins/opus/frontend_server.js'),'utf8'),context);
    return {api:context.module.exports.__test,logs,timers,setNow(t){now=t;},tick(){for(const fn of [...timers.values()])fn();}};
}
module.exports={serverModule};
