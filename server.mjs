import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import { readFile, writeFile, stat, rename } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('.', import.meta.url));
const assets = path.join(root, 'assets');
const jobs = new Map();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export function compareVersions(a, b) {
  const parse = v => { const m = /^(?:x-v|v)?(\d+(?:\.\d+)*)$/.exec(v); if (!m) throw Error('Unrecognized version'); return m[1].split('.').map(Number); };
  const x = parse(a), y = parse(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0) ? 1 : -1; }
  return 0;
}
export function installErrorMessage(message, code) {
  if ((Number(code) >>> 0) === 0x80990015 || /0x80990015/i.test(message)) {
    return 'A previous PKG Manager download is still registered (0x80990015). In PS4 Notifications > Downloads, cancel/delete only the failed PKG Manager download, then choose Retry installation.';
  }
  return message;
}
export function metadata(pkg) {
  if (pkg.readUInt32BE(0) !== 0x7f434e54) throw Error('Invalid PS4 package');
  const n = pkg.readUInt32BE(16), table = pkg.readUInt32BE(24);
  if (n > 2048 || table + n * 32 > pkg.length) throw Error('Invalid package table');
  for (let i = 0; i < n; i++) {
    const e = table + i * 32;
    if (pkg.readUInt32BE(e) !== 0x1000) continue;
    const offset = pkg.readUInt32BE(e + 16), size = pkg.readUInt32BE(e + 20);
    if (offset + size > pkg.length) throw Error('Invalid SFO bounds');
    const sfo = pkg.subarray(offset, offset + size);
    if (sfo.readUInt32LE(0) !== 0x46535000) throw Error('Invalid SFO');
    const keys = sfo.readUInt32LE(8), data = sfo.readUInt32LE(12), count = sfo.readUInt32LE(16), values = {};
    if (count > 1024 || 20 + count * 16 > size) throw Error('Invalid SFO entries');
    for (let j = 0; j < count; j++) {
      const k = 20 + j * 16, start = keys + sfo.readUInt16LE(k), end = sfo.indexOf(0, start);
      const value = data + sfo.readUInt32LE(k + 12), len = sfo.readUInt32LE(k + 4);
      if (start >= size || end < start || value + len > size) throw Error('Invalid SFO value');
      values[sfo.toString('utf8', start, end)] = sfo.toString('utf8', value, value + len).replace(/\0+$/, '');
    }
    if (values.TITLE_ID !== 'PKGX00001' || !/^\d+\.\d+$/.test(values.APP_VER)) throw Error('Unexpected package identity');
    return { title_id: values.TITLE_ID, app_version: values.APP_VER, content_id: values.CONTENT_ID || '', pkg_type: 'base', platform: 'ps4' };
  }
  throw Error('Package has no metadata');
}
export async function json(url, body) {
  const r = await fetch(url, { method: body ? 'POST' : 'GET', headers: { 'User-Agent': 'jb1352-local', ...(body ? {'Content-Type':'application/json'} : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw Error(`Service returned HTTP ${r.status}`);
  if (url.endsWith('/version')) {
    const version = (await r.text()).trim();
    if (!/^(?:v)?\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(version)) throw Error('Unexpected manager version response');
    return {version};
  }
  return r.json();
}
export async function consoleStatus(ip, deps = {}) {
  const fetcher = deps.fetch || fetch;
  try {
    const response = await fetcher(`http://${ip}:8844/api/version`, {signal:AbortSignal.timeout(1800)});
    if (response.ok && /^(?:v)?\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test((await response.text()).trim())) return {active:true,source:'pkg-manager'};
  } catch {}
  // A PS4 FTP greeting is a live homebrew service, not a remembered success.
  const ftp = deps.ftp || (address => new Promise(resolve => {
    const socket = net.connect(2121,address); let settled=false, banner='';
    const done = active => {if (settled) return; settled=true; socket.destroy(); resolve(active);};
    socket.setTimeout(1200,()=>done(false)); socket.on('error',()=>done(false)); socket.on('end',()=>done(false));
    socket.on('data',chunk=>{banner += chunk.toString('ascii'); if (/^220[ -]/.test(banner)) done(true); else if (banner.length>512 || banner.includes('\n')) done(false);});
  }));
  if (await ftp(ip)) return {active:true,source:'ftp'};
  return {active:false,source:'no-live-service',conclusive:false};
}
function select(release, ending) {
  const asset = release.assets.find(a => a.name.endsWith(ending));
  if (!asset || !/^pkg-manager-x_[a-zA-Z0-9._-]+$/.test(asset.name) || !asset.browser_download_url.startsWith('https://github.com/bsk193/pkg-manager-x/releases/download/')) throw Error('Release assets incomplete');
  return asset;
}
async function verifiedAsset(asset) {
  const destination = path.join(assets, asset.name);
  function verify(buf) {
    if (buf.length !== asset.size || asset.digest !== 'sha256:' + createHash('sha256').update(buf).digest('hex')) throw Error('Release checksum mismatch');
    return buf;
  }
  try { return verify(await readFile(destination)); } catch {}
  const r = await fetch(asset.browser_download_url, {signal: AbortSignal.timeout(120000)});
  if (!r.ok) throw Error('Release download failed');
  const buf = verify(Buffer.from(await r.arrayBuffer()));
  await writeFile(destination + '.part', buf); await rename(destination + '.part', destination);
  return buf;
}
let releaseWork;
export async function localFix(releaseTag) {
  let fix;
  try { fix = JSON.parse(await readFile(path.join(assets,'local-fix.json'),'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (fix.baseRelease !== releaseTag) return null;
  async function checked(asset) {
    if (!/^pkg-manager-x_[a-zA-Z0-9._-]+$/.test(asset.name)) throw Error('Invalid local fix filename');
    const data = await readFile(path.join(assets,asset.name));
    if (data.length !== asset.size || 'sha256:' + createHash('sha256').update(data).digest('hex') !== asset.digest) throw Error('Local fix checksum mismatch');
    return data;
  }
  const elf = await checked(fix.elf), tile = await checked(fix.tile);
  return {tile:fix.tile,elf,meta:metadata(tile),expectedVersion:fix.version,sourceCommit:fix.commit};
}
async function releaseAssets() {
  // Serialize downloads across consoles; refresh the release on every jailbreak.
  if (releaseWork) return releaseWork;
  releaseWork = (async () => {
    let release = JSON.parse(await readFile(path.join(assets, 'release.json'), 'utf8')), offline = false;
    try {
      const latest = await json('https://api.github.com/repos/bsk193/pkg-manager-x/releases/latest');
      if (!latest.draft && !latest.prerelease && compareVersions(latest.tag_name, release.tag_name) >= 0) {
        await verifiedAsset(select(latest, '_ps4.elf')); await verifiedAsset(select(latest, '_ps4-tile.pkg'));
        await writeFile(path.join(assets, 'release.json'), JSON.stringify(latest, null, 2)); release = latest;
      }
    } catch { offline = true; }
    const fixed = await localFix(release.tag_name);
    if (fixed) return {...fixed,offline};
    const tile = select(release, '_ps4-tile.pkg'), elf = await verifiedAsset(select(release, '_ps4.elf'));
    return {tile, elf, meta: metadata(await verifiedAsset(tile)), expectedVersion: release.tag_name.replace(/^x-v/, ''), offline};
  })();
  try { return await releaseWork; } finally { releaseWork = null; }
}
export async function sendPayload(ip, payload, connect = net.connect) {
  return new Promise((resolve, reject) => {
    const socket = connect(9090, ip); let settled = false, connected = false;
    const finish = err => { if (settled) return; settled = true; socket.destroy(); err ? reject(err) : resolve(); };
    socket.setTimeout(20000, () => finish(Error(`BinLoader ${connected ? 'transfer' : 'connection'} timed out at ${ip}:9090 (ETIMEDOUT). Toggle GoldHEN BinLoader off/on, then choose Retry installation.`)));
    socket.on('error', error => {
      const failure = Error(`BinLoader ${connected ? 'transfer' : 'connection'} failed at ${ip}:9090 (${error.code || error.message}). Toggle GoldHEN BinLoader off/on, then choose Retry installation.`);
      failure.retryableBeforeTransfer = !connected && error.code === 'ECONNREFUSED';
      finish(failure);
    });
    socket.on('close', () => { if (!settled) finish(Error(`BinLoader disconnected before the transfer finished at ${ip}:9090. Toggle GoldHEN BinLoader off/on, then choose Retry installation.`)); });
    socket.on('connect', () => { connected = true; socket.end(payload, () => finish()); });
  });
}
export async function sendPayloadWhenReady(ip, payload, {send = sendPayload, wait = sleep, onWait = () => {}} = {}) {
  // Only a refused connection is safe to retry: no payload bytes were sent.
  for (let attempt = 0; ; attempt++) {
    try { await send(ip, payload); return; }
    catch (error) {
      if (!error.retryableBeforeTransfer || attempt >= 15) throw error;
      onWait('Waiting for GoldHEN BinLoader…');
      await wait(2000);
    }
  }
}
export async function setup(ip, hostAddress, job, deps = {}) {
  const request = deps.request || json, releases = deps.releases || releaseAssets, send = deps.send || sendPayload, wait = deps.wait || sleep;
  const api = `http://${ip}:8844/api`, set = message => { job.message = message; };
  job.failed = false; job.progress = null; job.stage = 'Package setup';
  try {
    set('Checking PKG Manager updates…');
    const release = await releases();
    try {
      const running = await request(api + '/version');
      if (release.expectedVersion && running.version !== release.expectedVersion) throw Error('Corrected payload required');
    }
    catch {
      set('Starting PKG Manager…');
      await sendPayloadWhenReady(ip, release.elf, {send, wait, onWait: set});
      set('Waiting for PKG Manager…');
      let running = false;
      for (let i = 0; i < 15; i++) { await wait(2000); try { const current = await request(api + '/version'); if (!release.expectedVersion || current.version === release.expectedVersion) {running = true; break;} } catch {} }
      if (!running) throw Error('PKG Manager did not respond with the expected version after payload transfer.');
    }
    const check = await request(api + '/upload/check', release.meta);
    if (check.is_installed && compareVersions(check.installed_version, release.meta.app_version) >= 0) {
      job.stage = 'Ready'; job.progress = 100;
      set(release.offline ? 'Ready. PKG Manager installed; online update check unavailable.' : 'Ready. PKG Manager is up to date.'); return;
    }
    if (!check.can_install) throw Error(check.install_disabled_reason || 'PKG Manager refused installation.');
    const status = await request(api + '/status');
    const packageUrl = `http://${hostAddress}/packages/${release.tile.name}`;
    if (status.is_installing && status.pkg_path !== packageUrl) throw Error('Another package is installing. Retry when it finishes.');
    set(status.is_installing ? 'Resuming installation progress…' : check.is_installed ? 'Updating PKG Manager…' : 'Installing PKG Manager…');
    job.stage = 'Installation';
    if (!status.is_installing) {
      const install = await request(api + '/install', {path: packageUrl});
      if (!install.success) throw Error(install.error || 'Installation refused.');
    }
    for (let i = 0; i < 240; i++) {
      await wait(2500); const current = await request(api + '/status');
      if (current.pkg_path !== packageUrl) throw Error('Installation status changed; check console Downloads.');
      job.progress = typeof current.progress === 'number' && Number.isFinite(current.progress) ? Math.max(0,Math.min(99,current.progress)) : null;
      if (current.failed || current.error_code) {
        const code = Number(current.error_code);
        job.errorCode = code ? '0x' + (code >>> 0).toString(16).toUpperCase().padStart(8,'0') : null;
        throw Error((current.status || 'Package installation failed.') + (job.errorCode ? ' (' + job.errorCode + ')' : ''));
      }
      if (current.completed) {
        job.stage = 'Verifying tile'; job.progress = null; set('Confirming the tile is installed…');
        const confirmed = await request(api + '/upload/check', release.meta);
        if (!confirmed.is_installed || compareVersions(confirmed.installed_version, release.meta.app_version) < 0) throw Error('Installation not yet confirmed. Check console Downloads.');
        job.stage = 'Ready'; job.progress = 100;
        set(release.offline ? 'Ready. PKG Manager installed; online update check unavailable.' : 'Ready. PKG Manager is installed.'); return;
      }
    }
    throw Error('Installation timed out. Check console Downloads.');
  } catch (e) {
    job.failed = true; job.stage = 'Installation stopped'; job.progress = null;
    set('Jailbreak finished. ' + installErrorMessage(e.message,job.errorCode));
    console.error(`[${ip}] ${job.message}`);
  }
  finally { job.done = true; job.finishedAt = Date.now(); }
}
export function shouldStartJob(job, retry = false, now = Date.now()) {
  if (!job) return true;
  if (!job.done) return false;
  if (job.failed) return retry;
  return now - job.finishedAt >= 60000;
}
export function createServer() {
  return http.createServer(async (req, res) => {
    const respond = (code, value) => { res.writeHead(code, {'Content-Type':'application/json','Cache-Control':'no-store'}); res.end(JSON.stringify(value)); };
    try {
      const url = new URL(req.url, 'http://localhost'), ip = req.socket.remoteAddress.replace(/^::ffff:/, '');
      if (url.pathname === '/api/console' && req.method === 'GET') {
        if (!/PlayStation\s+4[\/ ]13\.52(?:\D|$)/.test(req.headers['user-agent'] || '') || !/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip)) return respond(403, {});
        return respond(200, await consoleStatus(ip));
      }
      if (url.pathname === '/api/ready' && req.method === 'POST') {
        const origin = req.headers.origin;
        if (origin && origin !== `http://${req.headers.host}`) return respond(403, {});
        if (!/PlayStation\s+4[\/ ]13\.52(?:\D|$)/.test(req.headers['user-agent'] || '') || !/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip)) return respond(403, {});
        let job = jobs.get(ip);
        if (shouldStartJob(job, url.searchParams.get('retry') === '1')) {
          job = {message:'Preparing package setup…',done:false}; jobs.set(ip, job);
          const address = req.socket.localAddress.replace(/^::ffff:/, '') + ':' + req.socket.localPort;
          void setup(ip, address, job);
        }
        return respond(202, job);
      }
      if (url.pathname === '/api/job') return respond(200, jobs.get(ip) || {message:'Package setup has not started.',done:true});
      if (!['GET','HEAD'].includes(req.method)) return respond(405, {});
      const packageName = /^\/packages\/(pkg-manager-x_[a-zA-Z0-9._-]+_ps4-tile\.pkg)$/.exec(url.pathname);
      const publicName = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).slice(1);
      const allowed = ['index.html','jb.html','boot.js','cache.manifest','jb.js','core.js','mem.js','int64.js','rpc_worker.js','ps4_offsets.js','goldhen.bin','patches/1352.bin'];
      if (!packageName && !allowed.includes(publicName)) return respond(404, {});
      const file = packageName ? path.join(assets,packageName[1]) : path.join(root,'public',publicName);
      const info = await stat(file); let start = 0, end = info.size - 1, code = 200;
      if (req.headers.range) {
        const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range);
        if (!range) return respond(416, {});
        start = Number(range[1]); end = range[2] ? Math.min(Number(range[2]), end) : end;
        if (start > end || start >= info.size) return respond(416, {}); code = 206;
      }
      const types = {'.html':'text/html','.js':'application/javascript','.manifest':'text/cache-manifest'};
      const headers = {'Content-Type':types[path.extname(file)] || 'application/octet-stream','Content-Length':end-start+1,'Accept-Ranges':'bytes','Cache-Control':'no-cache'};
      if (code === 206) headers['Content-Range'] = `bytes ${start}-${end}/${info.size}`;
      res.writeHead(code, headers);
      if (req.method === 'HEAD') return res.end();
      const stream = createReadStream(file, {start,end}); stream.on('error', () => res.destroy()); stream.pipe(res);
    } catch { if (!res.headersSent) respond(404, {error:'Unavailable'}); else res.destroy(); }
  });
}
export async function startServer({port = 8080, attempts = 20, host = '0.0.0.0', onBusy = () => {}} = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('PORT must be an integer between 1 and 65535.');
  for (let candidate = port; candidate < Math.min(port + attempts, 65536); candidate++) {
    const server = createServer();
    try {
      await new Promise((resolve, reject) => {
        const failed = error => { server.removeListener('listening', listening); reject(error); };
        const listening = () => { server.removeListener('error', failed); resolve(); };
        server.once('error', failed);
        server.once('listening', listening);
        server.listen(candidate, host);
      });
      return server;
    } catch (error) {
      if (error.code !== 'EADDRINUSE') throw error;
      onBusy(candidate);
    }
  }
  throw Error(`No free port found between ${port} and ${Math.min(port + attempts - 1, 65535)}. Set PORT to another port and retry.`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const server = await startServer({port: Number(process.env.PORT || 8080), onBusy: port => console.log(`Port ${port} is occupied; trying another port…`)});
    const port = server.address().port;
    server.on('error', error => { console.error(`Server error: ${error.message}`); process.exitCode = 1; });
    console.log('Open one of these addresses in the PS4 browser:');
    for (const group of Object.values(os.networkInterfaces())) for (const n of group || []) if (n.family === 'IPv4' && !n.internal) console.log(`http://${n.address}:${port}/`);
  } catch (error) {
    console.error(`Could not start the host: ${error.message}`);
    process.exitCode = 1;
  }
}



