import {readFile,writeFile,mkdir,cp,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {metadata,compareVersions} from '../server.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const out=root+'_site/';
let release=JSON.parse(await readFile(root+'assets/release.json','utf8'));
if(process.argv.includes('--latest')) {
  const headers={'Accept':'application/vnd.github+json','User-Agent':'malveira-jb-pages'};
  if(process.env.GH_TOKEN)headers.Authorization='Bearer '+process.env.GH_TOKEN;
  const response=await fetch('https://api.github.com/repos/bsk193/pkg-manager-x/releases/latest',{headers,signal:AbortSignal.timeout(30000)});
  if(!response.ok)throw Error('Release check failed: HTTP '+response.status);
  const latest=await response.json();
  if(!latest.draft&&!latest.prerelease&&compareVersions(latest.tag_name,release.tag_name)>=0)release=latest;
}
await mkdir(out,{recursive:true});await cp(root+'public',out,{recursive:true});
await mkdir(out+'packages',{recursive:true});
const select=ending=>{
  const asset=release.assets.find(a=>a.name.endsWith(ending));
  if(!asset||!/^pkg-manager-x_[\w.-]+$/.test(asset.name)||!asset.browser_download_url.startsWith('https://github.com/bsk193/pkg-manager-x/releases/download/'))throw Error('Invalid asset');
  return asset;
};
async function bytes(asset) {
  const valid=b=>b.length===asset.size&&'sha256:'+createHash('sha256').update(b).digest('hex')===asset.digest;
  let b;try{b=await readFile(root+'assets/'+asset.name);}catch{}
  if(!b||!valid(b)){
    const r=await fetch(asset.browser_download_url);if(!r.ok)throw Error('Download failed');b=Buffer.from(await r.arrayBuffer());
  }
  if(!valid(b))throw Error('Asset checksum failed');return b;
}
const elf=select('_ps4.elf'),tile=select('_ps4-tile.pkg');
const elfBytes=await bytes(elf),tileBytes=await bytes(tile),meta=metadata(tileBytes);
await writeFile(out+'packages/'+elf.name,elfBytes);await writeFile(out+'packages/'+tile.name,tileBytes);
await writeFile(out+'manager.json',JSON.stringify({version:release.tag_name.replace(/^x-v/,''),appVersion:meta.app_version,elf:'packages/'+elf.name,elfSize:elf.size,tile:'packages/'+tile.name},null,2));
await writeFile(out+'pages-mode.js','window.PS4_STANDALONE = true;\n');
for(const name of ['index.html','jb.html']){
  let html=await readFile(out+name,'utf8');html=html.replace('<script src="boot.js">','<script src="pages-mode.js"></script><script src="boot.js">');await writeFile(out+name,html);
}
// Separate uncached URLs avoid an older AppCache swallowing a query-only diagnostic request.
await mkdir(out+'diagnostics',{recursive:true});
for (const entry of await readdir(root+'public',{withFileTypes:true})) {
  if (entry.name === 'cache.manifest') continue;
  await cp(root+'public/'+entry.name,out+'diagnostics/'+entry.name,{recursive:true});
}
const diagnosticConfig=JSON.parse(await readFile(out+'manager.json','utf8'));
diagnosticConfig.elf='../'+diagnosticConfig.elf; diagnosticConfig.tile='../'+diagnosticConfig.tile;
await writeFile(out+'diagnostics/manager.json',JSON.stringify(diagnosticConfig));
for (const name of ['index.html','jb.html']) {
  let html=await readFile(out+'diagnostics/'+name,'utf8');
  html=html.replace(' manifest="cache.manifest"','').replace('<script src="boot.js">','<script>window.PS4_STANDALONE=true;window.PS4_DIAGNOSTICS=true;</script><script src="boot.js">');
  html=html.replace('<p id="diagnostics" role="status" hidden></p>','<p id="diagnostics" role="status">Diagnostics loading…</p>');
  await writeFile(out+'diagnostics/'+name,html);
}
// A new directory for each diagnostic build bypasses both HTTP and module caches.
const diagnosticHash=createHash('sha256');
for(const name of ['boot.js','jb.js','console-setup.js','jailbreak-status.js'])diagnosticHash.update(await readFile(root+'public/'+name));
const diagnosticId=diagnosticHash.digest('hex').slice(0,12);
const diagnosticDirectory='diagnostics-'+diagnosticId;
await cp(out+'diagnostics',out+diagnosticDirectory,{recursive:true});
for(const name of ['index.html','jb.html']){
  const path=out+diagnosticDirectory+'/'+name;
  let html=await readFile(path,'utf8');
  html=html.replace('window.PS4_DIAGNOSTICS=true;','window.PS4_DIAGNOSTICS=true;window.PS4_DIAGNOSTIC_BUILD="'+diagnosticId+'";');
  await writeFile(path,html);
}
await writeFile(out+'diagnostic-build.json',JSON.stringify({build:diagnosticId,url:diagnosticDirectory+'/jb.html'}));
// Stable entry point resolves a fresh, content-addressed diagnostic build.
await writeFile(out+'diagnostics/index.html',`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Malveira diagnostics</title><style>body{background:#101218;color:#eef0f6;font:20px Arial;text-align:center;padding:20vh 24px}</style><p id="status">Opening current diagnostics…</p><script>(function(){var r=new XMLHttpRequest();r.open('GET','../diagnostic-build.json?t='+Date.now());r.timeout=10000;function fail(){document.getElementById('status').textContent='Could not load diagnostics. Connect to the internet and reload.';}r.onload=function(){try{var d=JSON.parse(r.responseText);if(r.status!==200||!/^diagnostics-[a-f0-9]{12}\\/jb\\.html$/.test(d.url))throw Error();location.replace('../'+d.url);}catch(e){fail();}};r.onerror=r.ontimeout=fail;r.send();})();</script></html>`);

await writeFile(out+'.nojekyll','');
const files=(await readdir(out,{recursive:true,withFileTypes:true})).filter(e=>e.isFile()).map(e=>(e.parentPath+'/'+e.name).replaceAll('\\','/').slice(out.replaceAll('\\','/').length)).filter(n=>n!=='cache.manifest'&&n!=='.nojekyll'&&!/^diagnostics(?:-|\/)/.test(n)).sort();
const hash=createHash('sha256');for(const name of files){hash.update(name);hash.update(await readFile(out+name));}
await writeFile(out+'cache.manifest','CACHE MANIFEST\n# '+hash.digest('hex')+'\nCACHE:\n'+files.join('\n')+'\nNETWORK:\n*\n');
console.log('Built Pages '+release.tag_name+'; tile '+meta.app_version+'; '+files.length+' cached files.');
