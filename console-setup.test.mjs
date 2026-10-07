import test from 'node:test';
import assert from 'node:assert/strict';
import {parseResponse,createTransport,setupConsole,compare} from './public/console-setup.js';
const config={version:'1.0.2',appVersion:'01.02',elf:'manager.elf',elfSize:4,tile:'https://example.test/tile.pkg'};
test('manager HTTP parser handles framing and rejects errors/truncation',()=>{
  assert.equal(parseResponse('HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\n1.0.2'),'1.0.2');
  assert.equal(parseResponse('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2\r\n{}\r\n0\r\n\r\n'),'{}');
  assert.throws(()=>parseResponse('HTTP/1.1 500 Error\r\n\r\n{}'));
  assert.throws(()=>parseResponse('HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\na'));
  assert.throws(()=>parseResponse('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\na'));
});
test('console setup skips current tiles, resumes jobs and verifies installation before green success',async()=>{
  for(const mode of ['installed','absent','resume','failed','unconfirmed','old-manager']){
    const notices=[];let installs=0,checks=0,loads=0;
    const transport={payload:async()=>loads++,request:async(path)=>{
      if(path==='/api/version')return mode==='old-manager'?'1.0.1':'1.0.2';
      if(path==='/api/upload/check'){checks++;return {can_install:true,is_installed:mode==='installed'||(checks>1&&mode!=='unconfirmed'),installed_version:'v01.02'};}
      if(path==='/api/install'){installs++;return {success:true};}
      if(path==='/api/status')return {is_installing:mode==='resume',pkg_path:config.tile,completed:true,failed:mode==='failed'};
      throw Error('Unexpected API path');
    }};
    const run=setupConsole({transport,config,fetchBytes:async()=>{throw Error('Unneeded ELF');},notify:n=>notices.push(n),wait:async()=>{}});
    if(['failed','unconfirmed','old-manager'].includes(mode)) {await assert.rejects(run);assert.equal(notices.some(n=>n.progress===100),false);}
    else {await run;assert.equal(notices.at(-1).progress,100);}
    assert.equal(loads,0);assert.equal(installs,['absent','failed','unconfirmed'].includes(mode)?1:0);
  }
});
test('manager bootstrap sends one payload and waits for its version',async()=>{
  let versions=0,loads=0;
  await setupConsole({config,notify:()=>{},wait:async()=>{},fetchBytes:async()=>new Uint8Array([127,69,76,70]),transport:{payload:async()=>loads++,request:async(path)=>{
    if(path==='/api/version'){if(++versions<3)throw Error('Not ready');return '1.0.2';}
    if(path==='/api/upload/check')return {is_installed:true,installed_version:'v01.02'};
    throw Error('Unexpected request');
  }}});
  assert.equal(loads,1);assert.equal(versions,3);
});
test('native transport retries refused connections only and handles partial writes',async()=>{
  for(const mode of ['late','reset']){
    let sockets=0,closed=0,err=0,bytes=0,waits=0;
    const sc=(num,...args)=>{
      let value=0;
      if(num===97)value=++sockets;
      if(num===98&&sockets<3&&mode==='late'){err=61;value=-1;}
      if(num===133){if(mode==='reset'){err=54;value=-1;}else{value=Math.min(2,args[2]);bytes+=value;}}
      if(num===6)closed++;
      return {i32:value};
    };
    const transport=createTransport({sc,errno:()=>err,address:b=>b,wait:async ms=>{if(ms===2000)waits++;}});
    if(mode==='late'){await transport.payload(new Uint8Array(7));assert.equal(bytes,7);assert.equal(sockets,3);assert.equal(waits,2);}
    else{await assert.rejects(transport.payload(new Uint8Array(7)),/send failed/);assert.equal(sockets,1);assert.equal(waits,0);}
    assert.equal(closed,sockets);
  }
});

test('installed version comparison accepts the real PS4 v prefix',()=>{
 assert.equal(compare('v01.02','01.02'),0);
 assert.equal(compare('v01.03','01.02'),1);
 assert.equal(compare('v01.01','01.02'),-1);
 assert.throws(()=>compare('unknown','01.02'));
});

test('existing jailbreak skips credential mutation and detects non-root HEN without hiding errors',async()=>{
 const {alreadyJailbroken}=await import('./public/jailbreak-status.js');
 const sys={getuid:24,setuid:23};
 let calls=[];
 assert.equal(alreadyJailbroken((n)=>{calls.push(n);return {i32:0};},sys),true);
 assert.deepEqual(calls,[24]);
 for(const result of [0,-1]){
  calls=[];
  assert.equal(alreadyJailbroken((n,arg)=>{calls.push([n,arg]);return {i32:n===24?1000:result};},sys),result===0);
  assert.deepEqual(calls,[[24,undefined],[23,0]]);
 }
 assert.throws(()=>alreadyJailbroken(()=>{throw Error('bridge failure');},sys),/bridge failure/);
 assert.throws(()=>alreadyJailbroken(()=>({i32:0}),{getuid:24}),/Missing/);
});

test('browser sockets use FIONBIO instead of denied fcntl and close on ioctl failure',async()=>{
 for(const denied of [false,true]){
  let closed=0,nonblock=0;
  const transport=createTransport({address:b=>b,errno:()=>13,wait:async()=>{},sc:(num,...args)=>{
   assert.notEqual(num,92,'Browser fcntl must not be called');
   if(num===97)return {i32:7};
   if(num===54){nonblock++;assert.equal(args[1],0x8004667e);assert.equal(new DataView(args[2]).getInt32(0,true),1);return {i32:denied?-1:0};}
   if(num===133)return {i32:args[2]};
   if(num===6)closed++;
   return {i32:0};
  }});
  if(denied)await assert.rejects(transport.payload(new Uint8Array(4)),/ioctl failed.*13/);
  else await transport.payload(new Uint8Array(4));
  assert.equal(nonblock,1);assert.equal(closed,1);
 }
});
