import {readFile,writeFile,mkdir,cp,readdir,rm,realpath,lstat} from 'node:fs/promises';
import path from 'node:path';
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
try {
  const info=await lstat(out);
  if(info.isSymbolicLink() || await realpath(out)!==path.join(await realpath(root),'_site'))throw Error('Unexpected build output path');
  await rm(out,{recursive:true});
} catch(error) { if(error.code!=='ENOENT')throw error; }
await mkdir(out,{recursive:true});await cp(root+'public',out,{recursive:true});
await cp(root+'LICENSE.raw13g',out+'LICENSE.raw13g');
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
// Preserve the short diagnostic bookmark; diagnostics runs on the normal site.
await mkdir(out+'diagnostics',{recursive:true});
const redirect='<!doctype html><html lang="en"><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=../?diagnostics=1"><title>Diagnostics</title><a href="../?diagnostics=1">Open diagnostics</a><script>location.replace("../?diagnostics=1");</script></html>';
await writeFile(out+'diagnostics/index.html',redirect);
await writeFile(out+'diagnostics/jb.html',redirect);
await writeFile(out+'.nojekyll','');
const files=(await readdir(out,{recursive:true,withFileTypes:true})).filter(e=>e.isFile()).map(e=>(e.parentPath+'/'+e.name).replaceAll('\\','/').slice(out.replaceAll('\\','/').length)).filter(n=>n!=='cache.manifest'&&n!=='.nojekyll'&&!/^diagnostics(?:-|\/)/.test(n)).sort();
const hash=createHash('sha256');for(const name of files){hash.update(name);hash.update(await readFile(out+name));}
// The native installer cannot read AppCache; keep the tile available over HTTP only.
const cachedFiles=files.filter(name=>!name.endsWith('.pkg'));
await writeFile(out+'cache.manifest','CACHE MANIFEST\n# '+hash.digest('hex')+'\nCACHE:\n'+cachedFiles.join('\n')+'\nNETWORK:\n*\n');
console.log('Built Pages '+release.tag_name+'; tile '+meta.app_version+'; '+cachedFiles.length+' cached files.');
