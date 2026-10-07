import {readFile,writeFile,mkdir,cp,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {metadata,compareVersions} from '../server.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const out=root+'_site/';
let release=JSON.parse(await readFile(root+'assets/release.json','utf8'));
if(process.argv.includes('--latest')) {
  const response=await fetch('https://api.github.com/repos/bsk193/pkg-manager-x/releases/latest');
  if(!response.ok)throw Error('Release check failed');
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
await writeFile(out+'.nojekyll','');
const files=(await readdir(out,{recursive:true,withFileTypes:true})).filter(e=>e.isFile()).map(e=>(e.parentPath+'/'+e.name).replaceAll('\\','/').slice(out.replaceAll('\\','/').length)).filter(n=>n!=='cache.manifest'&&n!=='.nojekyll').sort();
const hash=createHash('sha256');for(const name of files){hash.update(name);hash.update(await readFile(out+name));}
await writeFile(out+'cache.manifest','CACHE MANIFEST\n# '+hash.digest('hex')+'\nCACHE:\n'+files.join('\n')+'\nNETWORK:\n*\n');
console.log('Built Pages '+release.tag_name+'; tile '+meta.app_version+'; '+files.length+' cached files.');
