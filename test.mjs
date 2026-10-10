import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createServer, startServer, metadata, compareVersions, setup, consoleStatus, json, shouldStartJob, installErrorMessage} from './server.mjs';
import {offsetsFor} from './public/ps4_offsets.js';
import {createServer as httpServer} from 'node:http';

class InactiveXHR {
  open() {} send() {this.status=200; this.responseText='{"active":false}'; this.onload();}
}
test('retry cleanup never displays failure and confirmed success wins over late errors', async () => {
  const timers=[],nodes={};
  const context={XMLHttpRequest:InactiveXHR,navigator:{userAgent:'PlayStation 4 13.52',onLine:true},window:{},
    location:{pathname:'/jb.html'},setTimeout:f=>timers.push(f),
    document:{getElementById:id=>nodes[id] ||= {removeAttribute(){}},createElement:()=>({}),body:{appendChild(){}}}};
  vm.runInNewContext(await readFile(new URL('./public/boot.js',import.meta.url),'utf8'),context);
  context.window.hostEvent('AUTO-RETRY','read miss');
  context.window.hostEvent('HOST-FINISHED','failed');
  assert.equal(nodes.message.textContent,'Retrying jailbreak…'); assert.equal(timers.length,0);
  context.window.hostEvent('PROOF-OK','PAYLOAD-RUNNING rc=0');
  context.window.hostEvent('THREW','late cleanup error');
  context.window.hostEvent('HOST-FINISHED','failed');
  assert.match(nodes.message.textContent,/Jailbreak active/);assert.equal(timers.length,1);assert.equal(nodes.retry.hidden,true);
});
test('ambiguous chain failure reconciles live service or ends as unconfirmed without rerunning', async () => {
  for(const live of [true,false]) {
    const timers=[],nodes={};let calls=0,loads=0;
    class XHR {open(){} send(){this.status=200;this.responseText=JSON.stringify({active:++calls>1&&live});this.onload();}}
    const context={XMLHttpRequest:XHR,navigator:{userAgent:'PlayStation 4 13.52',onLine:true},window:{},
      location:{pathname:'/jb.html'},setTimeout:f=>timers.push(f),
      document:{getElementById:id=>nodes[id] ||= {removeAttribute(){}},createElement:()=>({}),body:{appendChild(){loads++;}}}};
    vm.runInNewContext(await readFile(new URL('./public/boot.js',import.meta.url),'utf8'),context);
    context.window.hostEvent('THREW','uncertain result');context.window.hostEvent('HOST-FINISHED','failed');
    assert.equal(timers.length,1);assert.match(nodes.message.textContent,/Confirming/);
    timers.shift()();
    if(live){assert.match(nodes.message.textContent,/Jailbreak active/);assert.equal(calls,2);}
    else {while(timers.length)timers.shift()();assert.match(nodes.message.textContent,/Could not confirm jailbreak/);assert.equal(calls,4);}
    assert.equal(loads,1);
  }
});
test('duplicate BGFT task errors explain targeted cleanup', () => {
  assert.match(installErrorMessage('error',0x80990015|0),/only the failed PKG Manager download/);
  assert.match(installErrorMessage('Install failed (0x80990015)'),/Retry installation/);
  assert.equal(installErrorMessage('Something else',0x8099002c),'Something else');
});
test('a staged fix replaces the old resident payload before installation checks', async () => {
  let sends=0, versions=0, checked=false;
  const job={};
  await setup('192.168.1.3','192.168.1.2:8080',job,{
    releases:async()=>({expectedVersion:'1.0.0-fixed',meta:{app_version:'01.00'},elf:Buffer.alloc(0)}),
    send:async()=>{sends++;},wait:async()=>{},
    request:async(url)=>{
      if(url.endsWith('/version'))return {version:++versions===1?'1.0.0':'1.0.0-fixed'};
      if(url.endsWith('/upload/check')){assert.equal(sends,1);assert.equal(versions,2);checked=true;return {is_installed:true,installed_version:'01.00'};}
      throw Error('Unexpected installer call');
    }
  });
  assert.equal(checked,true);assert.equal(job.failed,false);assert.equal(job.progress,100);
});
test('index routes to JB without checking console status', async () => {
  let target='', checks=0;
  const nodes={};
  vm.runInNewContext(await readFile(new URL('./public/boot.js',import.meta.url),'utf8'),{
    navigator:{userAgent:'PlayStation 4 13.52',onLine:true},window:{},
    location:{pathname:'/index.html',replace:url=>target=url},
    XMLHttpRequest:function(){checks++;},setTimeout:()=>{},
    document:{getElementById:id=>nodes[id] ||= {removeAttribute(){}}}
  });
  assert.equal(target,'jb.html'); assert.equal(checks,0);
});
test('running and failed jobs cannot be resubmitted by page reload', () => {
  assert.equal(shouldStartJob(undefined),true);
  assert.equal(shouldStartJob({done:false},true),false);
  assert.equal(shouldStartJob({done:true,failed:true}),false);
  assert.equal(shouldStartJob({done:true,failed:true},true),true);
  assert.equal(shouldStartJob({done:true,finishedAt:100},false,200),false);
  assert.equal(shouldStartJob({done:true,finishedAt:100},false,60100),true);
});
test('installer resumes an active tile task, exposes progress and preserves native error code', async () => {
  const job={}, packageUrl='http://192.168.1.2:8080/packages/tile.pkg'; let polls=0,observed;
  await setup('192.168.1.3','192.168.1.2:8080',job,{
    releases:async()=>({meta:{app_version:'01.00'},tile:{name:'tile.pkg'}}),
    wait:async()=>{if(polls===2)observed=job.progress;},
    request:async(url)=>{
      if(url.endsWith('/version'))return {};
      if(url.endsWith('/upload/check'))return {can_install:true,is_installed:false};
      if(url.endsWith('/install'))throw Error('Duplicate install submission');
      if(url.endsWith('/status')) {
        polls++;
        return polls===1 ? {is_installing:true,pkg_path:packageUrl} : polls===2 ? {pkg_path:packageUrl,progress:42} : {pkg_path:packageUrl,failed:true,error_code:0x8099006a|0,status:'System install error'};
      }
      throw Error('Unexpected request');
    }
  });
  assert.equal(observed,42); assert.equal(job.errorCode,'0x8099006A');
  assert.equal(job.failed,true); assert.equal(job.done,true); assert.notEqual(job.progress,100);
});

test('live console checks accept manager text and FTP but not saved state or unrelated responses', async () => {
  const live = await consoleStatus('192.168.1.3', {fetch:async()=>({ok:true,text:async()=>'1.0.0'}),ftp:async()=>{throw Error('Should not probe FTP');}});
  assert.equal(live.active,true); assert.equal(live.source,'pkg-manager');
  const ftp = await consoleStatus('192.168.1.3',{fetch:async()=>{throw Error('offline');},ftp:async()=>true});
  assert.equal(ftp.active,true); assert.equal(ftp.source,'ftp');
  const absent = await consoleStatus('192.168.1.3',{fetch:async()=>({ok:true,text:async()=>'<html>not manager</html>'}),ftp:async()=>false});
  assert.equal(absent.active,false); assert.equal(absent.conclusive,false);
});
test('manager request accepts the real plain-text version endpoint', async () => {
  const server=httpServer((req,res)=>{res.setHeader('Content-Type','text/plain');res.end('1.0.0');});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try { assert.deepEqual(await json(`http://127.0.0.1:${server.address().port}/api/version`),{version:'1.0.0'}); }
  finally { await new Promise(resolve=>server.close(resolve)); }
});
test('reopening JB while active skips the exploit and restores home URL without navigation', async () => {
  for (const pathname of ['/jb.html']) {
    let loads=0, replaced='', setupScheduled=0; const nodes={};
    class ActiveXHR {open(){} send(){this.status=200;this.responseText='{"active":true}';this.onload();}}
    const context={XMLHttpRequest:ActiveXHR,navigator:{userAgent:'PlayStation 4 13.52',onLine:true},
      window:{history:{replaceState:(a,b,url)=>replaced=url}},location:{pathname,replace:()=>{throw Error('Unexpected navigation');}},
      setTimeout:()=>setupScheduled++,document:{getElementById:id=>nodes[id] ||= {removeAttribute:function(){}},createElement:()=>({}),body:{appendChild:()=>loads++}}};
    vm.runInNewContext(await readFile(new URL('./public/boot.js',import.meta.url),'utf8'),context);
    assert.equal(loads,0); assert.equal(replaced,'index.html'); assert.equal(setupScheduled,1);
    assert.match(nodes.message.textContent,/Jailbreak active/);
  }
});

test('startup skips occupied ports and handles exhaustion and invalid ports', async () => {
  const occupied = await startServer({port:18080,host:'127.0.0.1'});
  const port = occupied.address().port, busy = [];
  let fallback;
  try {
    fallback = await startServer({port, host:'127.0.0.1', onBusy: value => busy.push(value)});
    assert.ok(fallback.address().port > port);
    assert.equal(busy[0], port);
    assert.equal((await fetch(`http://127.0.0.1:${fallback.address().port}/`)).status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status, 200);
    await assert.rejects(startServer({port, attempts:1, host:'127.0.0.1'}), /No free port/);
    for (const invalid of [0, -1, 65536, NaN, 8080.5]) await assert.rejects(startServer({port:invalid}), /PORT must be/);
  } finally {
    if (fallback) await new Promise(resolve => fallback.close(resolve));
    await new Promise(resolve => occupied.close(resolve));
  }
});

test('exact firmware gate and no override', async () => {
  const code = await readFile(new URL('./public/boot.js', import.meta.url),'utf8');
  for (const version of ['13.52','13.50','13.02','13.520','9.00','']) {
    let loads = 0; const nodes = {}, handlers = {}, timers = [];
    const context = {XMLHttpRequest: InactiveXHR, navigator:{userAgent:'PlayStation 4 ' + version,onLine:true},location:{pathname:'/index.html',search:'?force=1',replace:()=>loads++},
      setTimeout:f=>timers.push(f),document:{getElementById:id=>nodes[id] ||= {removeAttribute:function(){}},createElement:()=>({}),body:{appendChild:()=>loads++}},
      window:{applicationCache:{status:2,CHECKING:2,DOWNLOADING:3,UPDATEREADY:4,addEventListener:(n,f)=>handlers[n]=f}}};
    vm.runInNewContext(code, context);
    assert.equal(loads,0);
    if (version === '13.52') { handlers.cached(); handlers.noupdate(); assert.equal(loads,1); }
    else { assert.match(nodes.message.textContent,/13\.52/); assert.equal(Object.keys(handlers).length,0); }
    assert.equal(!!offsetsFor(context.navigator.userAgent).off, version === '13.52');
  }
});
test('offline boot launches once and failed proof does not install', async () => {
  let loads=0, timers=0; const nodes={};
  const context={XMLHttpRequest: InactiveXHR, navigator:{userAgent:'PlayStation 4 13.52',onLine:false},window:{},setTimeout:()=>timers++,location:{pathname:'/jb.html',search:''},document:{getElementById:id=>nodes[id] ||= {removeAttribute:function(){}},createElement:()=>({}),body:{appendChild:()=>loads++}}};
  vm.runInNewContext(await readFile(new URL('./public/boot.js',import.meta.url),'utf8'),context);
  assert.equal(loads,1); context.window.hostEvent('PROOF-FAIL','PAYLOAD-RUNNING'); assert.equal(timers,0);
  context.window.hostEvent('PROOF-OK','PAYLOAD-RUNNING rc=0'); context.window.hostEvent('PROOF-OK','PAYLOAD-RUNNING rc=0'); assert.equal(timers,1);
});
test('execution document starts without waiting on or touching application cache', async () => {
  const html = await readFile(new URL('./public/jb.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /\smanifest\s*=/i);
  let scripts = 0;
  const nodes = {}, win = {};
  Object.defineProperty(win, 'applicationCache', {get() { throw Error('Execution page touched cache'); }});
  vm.runInNewContext(await readFile(new URL('./public/boot.js', import.meta.url), 'utf8'), {
    XMLHttpRequest: InactiveXHR, navigator:{userAgent:'PlayStation 4 13.52',onLine:true},window:win,
    location:{pathname:'/jb.html'},setTimeout:()=>{},
    document:{getElementById:id=>nodes[id] ||= {removeAttribute:function(){}},createElement:()=>({}),body:{appendChild:script=>{assert.equal(script.src,'jb.js');scripts++;}}}
  });
  assert.equal(scripts,1);
});
test('release identity, checksums and numeric version comparisons', async () => {
  const release=JSON.parse(await readFile(new URL('./assets/release.json',import.meta.url),'utf8'));
  for (const asset of release.assets.filter(a=>/_ps4(\.elf|-tile\.pkg)$/.test(a.name))) {
    const bytes=await readFile(new URL('./assets/'+asset.name,import.meta.url));
    assert.equal(bytes.length,asset.size);
    assert.equal('sha256:'+createHash('sha256').update(bytes).digest('hex'),asset.digest);
    if (asset.name.endsWith('.pkg')) { const meta=metadata(bytes); assert.equal(meta.title_id,'PKGX00001'); assert.equal(meta.app_version,'01.02'); }
  }
  assert.equal(compareVersions('01.00','1.0.0'),0); assert.equal(compareVersions('01.10','01.09'),1);
  assert.equal(compareVersions('x-v1.0.0','x-v2.0.0'),-1); assert.throws(()=>compareVersions('bad','1.0'));
});
test('HTTP host serves cache files, ranges and rejects unsafe requests', async () => {
  const server=createServer(); await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+server.address().port;
  try {
    assert.equal((await fetch(base+'/')).status,200);
    const manifest=await fetch(base+'/cache.manifest'); assert.equal(manifest.headers.get('content-type'),'text/cache-manifest');
    const entries=(await manifest.text()).split('CACHE:')[1].split('NETWORK:')[0].trim().split(/\r?\n/);
    for (const entry of entries) assert.equal((await fetch(base+'/'+entry)).status,200,entry);
    const range=await fetch(base+'/packages/pkg-manager-x_v1.0.2_ps4-tile.pkg',{headers:{Range:'bytes=0-3'}});
    assert.equal(range.status,206); assert.equal(Buffer.from(await range.arrayBuffer()).toString('hex'),'7f434e54');
    assert.equal((await fetch(base+'/packages/pkg-manager-x_v1.0.2_ps4-tile.pkg',{headers:{Range:'bytes=999999999-'}})).status,416);
    assert.equal((await fetch(base+'/server.mjs')).status,404);
    assert.equal((await fetch(base+'/patches/1350.bin')).status,404);
    assert.equal((await fetch(base+'/api/ready',{method:'POST',headers:{Origin:'http://unrelated.example'}})).status,403);
    assert.equal((await fetch(base+'/api/ready',{method:'POST'})).status,403);
  } finally { await new Promise(resolve=>server.close(resolve)); }
});
test('package orchestration installs absent/older versions, skips current/newer, and reports failures', async () => {
  for (const mode of ['absent','older','equal','newer','failed','loader-failed','busy']) {
    let installed = 0, checks = 0, sent = 0;
    const job = {}, packageUrl='http://192.168.1.2:8080/packages/tile.pkg';
    await setup('192.168.1.3','192.168.1.2:8080',job,{
      releases:async()=>({meta:{app_version:'01.01'},tile:{name:'tile.pkg'},elf:Buffer.alloc(0)}),
      wait:async()=>{},send:async()=>{sent++; throw Error('BinLoader unavailable');},
      request:async(url,body)=>{
        if (url.endsWith('/version')) { if (mode==='loader-failed') throw Error('offline'); return {}; }
        if (url.endsWith('/upload/check')) {
          checks++;
          return {can_install:true,is_installed:mode!=='absent'||checks>1,installed_version:checks>1?'01.01':mode==='newer'?'01.02':mode==='equal'?'01.01':'01.00'};
        }
        if (url.endsWith('/install')) { installed++; assert.equal(body.path,packageUrl); return {success:true}; }
        if (url.endsWith('/status')) return installed ? {pkg_path:packageUrl,failed:mode==='failed',completed:mode!=='failed'} : {is_installing:mode==='busy'};
        throw Error('Unexpected request');
      }
    });
    assert.equal(job.done,true);
    assert.equal(installed,['absent','older','failed'].includes(mode)?1:0);
    if (['absent','older'].includes(mode)) { assert.equal(checks,2); assert.match(job.message,/is installed/); }
    if (['equal','newer'].includes(mode)) assert.match(job.message,/up to date/);
    if (mode==='failed') assert.match(job.message,/failed/);
    if (mode==='busy') assert.match(job.message,/Another package/);
    if (mode==='loader-failed') { assert.equal(sent,1); assert.match(job.message,/BinLoader/); }
  }
});





 test('BinLoader errors distinguish refusal, transfer timeout and early disconnect', async () => {
  const {sendPayload}=await import('./server.mjs');
  const {EventEmitter}=await import('node:events');
  for (const mode of ['refused','timeout','closed','success']) {
    const socket=new EventEmitter(); socket.destroy=()=>{}; socket.setTimeout=(ms,cb)=>socket.timeout=cb;
    socket.end=(data,cb)=>{assert.equal(data.toString(),'payload');if(mode==='success')cb();};
    const pending=sendPayload('192.168.1.146',Buffer.from('payload'),()=>socket);
    if(mode==='refused')socket.emit('error',Object.assign(new Error('refused'),{code:'ECONNREFUSED'}));
    else {socket.emit('connect');if(mode==='timeout')socket.timeout();if(mode==='closed')socket.emit('close');}
    if(mode==='success')await pending;
    else await assert.rejects(pending,mode==='refused'?/connection failed.*ECONNREFUSED/:mode==='timeout'?/transfer timed out.*ETIMEDOUT/:/disconnected before/);
  }
});

test('BinLoader readiness retries refusals, stops after 30 seconds and never retries an ambiguous transfer', async () => {
  const {sendPayloadWhenReady,sendPayload}=await import('./server.mjs');
  const {EventEmitter}=await import('node:events');
  for(const mode of ['late','absent','reset']) {
    let attempts=0, transfers=0, waits=0, notices=0;
    const connect=()=>{
      const socket=new EventEmitter(); socket.destroy=()=>{}; socket.setTimeout=()=>{};
      socket.end=(data,cb)=>{transfers++;if(mode==='reset')socket.emit('error',Object.assign(new Error('reset'),{code:'ECONNRESET'}));else cb();};
      attempts++;
      queueMicrotask(()=>{if(mode==='absent'||(mode==='late'&&attempts<4))socket.emit('error',Object.assign(new Error('refused'),{code:'ECONNREFUSED'}));else socket.emit('connect');});
      return socket;
    };
    const pending=sendPayloadWhenReady('192.168.1.146',Buffer.from('payload'),{
      send:(ip,payload)=>sendPayload(ip,payload,connect),
      wait:async ms=>{assert.equal(ms,2000);waits++;},onWait:()=>notices++
    });
    if(mode==='late'){await pending;assert.equal(attempts,4);assert.equal(transfers,1);assert.equal(waits,3);}
    else {await assert.rejects(pending,mode==='absent'?/ECONNREFUSED/:/ECONNRESET/);assert.equal(attempts,mode==='absent'?16:1);assert.equal(transfers,mode==='absent'?0:1);assert.equal(waits,mode==='absent'?15:0);}
    assert.equal(notices,waits);
  }
});

test('three-step UI advances on real milestones and shows success only after package verification', async () => {
  const nodes={},timers=[];
  class XHR {open(method,url){this.url=url;} send(){this.status=this.url==='/api/ready'?202:200;this.responseText=JSON.stringify(this.url==='/api/console'?{active:false}:{stage:'Ready',progress:100,done:true,failed:false,message:'Ready'});this.onload();}}
  const context={XMLHttpRequest:XHR,navigator:{userAgent:'PlayStation 4 13.52',onLine:true},window:{},location:{pathname:'/jb.html'},setTimeout:f=>timers.push(f),document:{getElementById:id=>nodes[id]||={removeAttribute(){}},createElement:()=>({}),body:{appendChild(){}}}};
  vm.runInNewContext(await readFile(new URL('./public/boot.js',import.meta.url),'utf8'),context);
  assert.equal(nodes.step0.className,'segment active');assert.equal(nodes.step1.className,'segment');
  context.window.hostEvent('PRIMITIVE-OK','');
  assert.equal(nodes.step0.className,'segment done');assert.equal(nodes.step1.className,'segment active');
  context.window.hostEvent('PROOF-OK','PAYLOAD-RUNNING rc=0');
  assert.equal(nodes.step2.className,'segment active');assert.equal(nodes.success.hidden,true);
  timers.shift()();
  for(const id of ['step0','step1','step2'])assert.equal(nodes[id].className,'segment done');
  assert.equal(nodes.success.hidden,false);assert.equal(nodes.retry.hidden,true);
});

test('Pages keeps jailbreak unconfirmed until services respond and preserves failure after thread exit', async () => {
 for (const confirmed of [false,true]) {
  const nodes={};
  const context={navigator:{userAgent:'PlayStation 4 13.52'},window:{PS4_STANDALONE:true},location:{pathname:'/jb.html',search:'?diagnostics=1'},setTimeout:()=>{},document:{getElementById:id=>nodes[id]||={},createElement:()=>({}),body:{appendChild(){}}}};
  vm.runInNewContext(await readFile(new URL('./public/boot.js',import.meta.url),'utf8'),context);
  const event=context.window.hostEvent;
  event('PRIMITIVE-OK','');
  for(const [tag,detail] of [['PROOF-OK','PAYLOAD-RUNNING rc=0'],['ALREADY-ROOT',''],['HOST-FINISHED','ok']]) {
   event(tag,detail);
   assert.equal(nodes.step1.className,'segment active');assert.equal(nodes.step2.className,'segment');
  }
  if(confirmed) event('CONSOLE-SETUP',JSON.stringify({serviceReady:true,stage:'Package setup',message:'BinLoader connected'}));
  event('CONSOLE-SETUP',JSON.stringify({stage:'Installation stopped',message:'Service unavailable',failed:true}));
  event('HOST-FINISHED','ok');
  assert.equal(nodes.step1.className,confirmed?'segment done':'segment error');
  assert.equal(nodes.step2.className,confirmed?'segment error':'segment');
  assert.equal(nodes.diagnostics.textContent,'Service unavailable');assert.equal(nodes.success.hidden,true);
 }
});
