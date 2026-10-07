// Console-local transport. Called only while the existing syscall bridge is armed.
// Socket ABI: OpenOrbis musl headers / FreeBSD 9 syscall table.
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
export function parseResponse(raw) {
  const end = raw.indexOf('\r\n\r\n');
  if (end < 0) throw Error('Incomplete manager response');
  const head = raw.slice(0, end), status = /^HTTP\/1\.[01] (\d+)/.exec(head);
  if (!status || Number(status[1]) < 200 || Number(status[1]) >= 300) throw Error('Manager HTTP request failed');
  let body = raw.slice(end + 4);
  if (/transfer-encoding:\s*chunked/i.test(head)) {
    let result = '', at = 0;
    for (;;) {
      const line = body.indexOf('\r\n', at);
      if (line < 0 || !/^[0-9a-f]+(?:;.*)?$/i.test(body.slice(at, line))) throw Error('Invalid chunk');
      const size = parseInt(body.slice(at, line), 16); at = line + 2;
      if (!size) return result;
      if (at + size + 2 > body.length || body.slice(at + size, at + size + 2) !== '\r\n') throw Error('Incomplete chunk');
      result += body.slice(at, at + size); at += size + 2;
    }
  }
  const length = /content-length:\s*(\d+)/i.exec(head);
  if (length && body.length !== Number(length[1])) throw Error('Incomplete manager body');
  return body;
}

export function createTransport({sc, errno, address, wait = pause, now = () => Date.now()}) {
  const fail = label => Object.assign(Error(label + ' (errno ' + errno() + ')'), {nativeCode: errno()});
  async function connect(port) {
    if (port !== 8844 && port !== 9090) throw Error('Unexpected loopback port');
    const fd = sc(97, 2, 1, 0).i32;
    if (fd < 0) throw fail('Socket creation failed');
    try {
      const flags = sc(92, fd, 3, 0).i32;
      if (flags < 0 || sc(92, fd, 4, flags | 4).i32 < 0) throw fail('Nonblocking socket setup failed');
      const sa = new Uint8Array(16); sa[0] = 16; sa[1] = 2; sa[2] = port >>> 8; sa[3] = port & 255; sa[4] = 127; sa[7] = 1;
      const rc = sc(98, fd, address(sa.buffer), 16).i32;
      if (rc < 0) {
        const code = errno();
        if (code !== 36 && code !== 35 && code !== 4) throw Object.assign(Error('Loopback connection failed (errno ' + code + ')'), {nativeCode: code});
        const poll = new ArrayBuffer(8), pv = new DataView(poll); pv.setInt32(0, fd, true); pv.setInt16(4, 4, true);
        const limit = now() + 4000;
        for (;;) {
          pv.setInt16(6, 0, true);
          const result = sc(209, address(poll), 1, 0).i32;
          if (result < 0 && errno() !== 4) throw fail('Loopback poll failed');
          if (result > 0) break;
          if (now() >= limit) throw Error('Loopback connection timed out');
          await wait(50);
        }
        const value = new ArrayBuffer(4), size = new ArrayBuffer(4); new DataView(size).setInt32(0, 4, true);
        if (sc(118, fd, 0xffff, 0x1007, address(value), address(size)).i32 < 0) throw fail('Socket status failed');
        const socketError = new DataView(value).getInt32(0, true);
        if (socketError) throw Object.assign(Error('Loopback connection failed (errno ' + socketError + ')'), {nativeCode: socketError});
      }
      return fd;
    } catch (error) { sc(6, fd); throw error; }
  }
  async function send(fd, bytes) {
    const block = new Uint8Array(16384), ptr = address(block.buffer);
    let offset = 0, deadline = now() + 20000;
    while (offset < bytes.length) {
      const count = Math.min(block.length, bytes.length - offset); block.set(bytes.subarray(offset, offset + count));
      const n = sc(133, fd, ptr, count, 0x4000, 0, 0).i32; // MSG_NOSIGNAL
      if (n > 0) { offset += n; deadline = now() + 20000; }
      else if (n < 0 && errno() !== 35 && errno() !== 4) throw fail('Loopback send failed');
      else if (now() >= deadline) throw Error('Loopback send timed out');
      await wait(0);
    }
  }
  return {
    async payload(bytes) {
      let fd;
      for (let i = 0; ; i++) {
        try { fd = await connect(9090); break; }
        catch (error) { if (error.nativeCode !== 61 || i >= 15) throw error; await wait(2000); }
      }
      try { await send(fd, bytes); } finally { sc(6, fd); }
    },
    async request(path, body) {
      if (!/^\/api\/[a-z/]+$/.test(path)) throw Error('Unexpected API path');
      const data = body ? JSON.stringify(body) : '';
      const text = (body ? 'POST ' : 'GET ') + path + ' HTTP/1.1\r\nHost: 127.0.0.1:8844\r\nConnection: close\r\n' + (body ? 'Content-Type: application/json\r\nContent-Length: ' + data.length + '\r\n' : '') + '\r\n' + data;
      if (/[^\x00-\x7f]/.test(text)) throw Error('Non-ASCII request');
      const bytes = new Uint8Array(text.length); for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
      const fd = await connect(8844);
      try {
        await send(fd, bytes);
        const block = new Uint8Array(8192), ptr = address(block.buffer); let raw = '', deadline = now() + 15000;
        for (;;) {
          const n = sc(3, fd, ptr, block.length).i32;
          if (!n) break;
          if (n > 0) { for (let i = 0; i < n; i++) raw += String.fromCharCode(block[i]); if (raw.length > 262144) throw Error('Manager response too large'); }
          else if (errno() !== 35 && errno() !== 4) throw fail('Loopback receive failed');
          if (now() >= deadline) throw Error('Manager response timed out');
          await wait(25);
        }
        const result = parseResponse(raw);
        return path === '/api/version' ? result.trim() : JSON.parse(result);
      } finally { sc(6, fd); }
    }
  };
}

export function compare(a, b) {
  if (!/^\d+(\.\d+)*$/.test(a) || !/^\d+(\.\d+)*$/.test(b)) throw Error('Invalid installed version');
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0) ? 1 : -1;
  return 0;
}

export async function setupConsole({transport, config, fetchBytes, notify, wait = pause}) {
  const meta = {title_id:'PKGX00001',app_version:config.appVersion,content_id:'IV0000-PKGX00001_00-PKGMANAGERX00000',pkg_type:'base',platform:'ps4'};
  notify({stage:'Package setup',message:'Checking PKG Manager',progress:null});
  let version;
  try { version = await transport.request('/api/version'); } catch (_) {}
  if (version && version !== config.version) throw Error('Another manager version is running. Restart the PS4 before updating.');
  if (!version) {
    const elf = await fetchBytes(config.elf);
    if (elf.length !== config.elfSize || elf[0] !== 127 || elf[1] !== 69 || elf[2] !== 76 || elf[3] !== 70) throw Error('Invalid manager ELF');
    notify({stage:'Package setup',message:'Waiting for BinLoader',progress:null});
    await transport.payload(elf);
    for (let i = 0; i < 15; i++) { await wait(2000); try { version = await transport.request('/api/version'); if (version === config.version) break; } catch (_) {} }
    if (version !== config.version) throw Error('Manager did not start with the expected version');
  }
  const check = await transport.request('/api/upload/check', meta);
  if (check.is_installed && compare(check.installed_version, config.appVersion) >= 0) { notify({stage:'Ready',message:'Ready',progress:100,done:true}); return; }
  if (!check.can_install) throw Error(check.install_disabled_reason || 'Installation refused');
  let status = await transport.request('/api/status');
  if (status.is_installing && status.pkg_path !== config.tile) throw Error('Another package is installing');
  if (!status.is_installing) {
    const start = await transport.request('/api/install', {path:config.tile});
    if (!start.success) throw Error(start.error || 'Installation refused');
  }
  for (let i = 0; i < 240; i++) {
    await wait(2500); status = await transport.request('/api/status');
    if (status.pkg_path !== config.tile) throw Error('Installation status changed');
    if (status.failed || status.error_code) throw Error((status.status || 'Installation failed') + (status.error_code ? ' (0x' + (status.error_code >>> 0).toString(16).toUpperCase() + ')' : ''));
    notify({stage:'Installation',message:'Installing PKG Manager',progress:typeof status.progress === 'number' ? Math.min(99,status.progress) : null});
    if (status.completed) {
      const verified = await transport.request('/api/upload/check', meta);
      if (!verified.is_installed || compare(verified.installed_version,config.appVersion) < 0) throw Error('Tile installation not confirmed');
      notify({stage:'Ready',message:'Ready',progress:100,done:true}); return;
    }
  }
  throw Error('Installation timed out');
}
