# Malveira JB

PS4 13.52 host with three progress segments, an icon retry button, and a green checkmark after PKG Manager tile verification.

## GitHub Pages

Site: https://bsk193.github.io/malveira-jb/

The Pages build enables console-local setup. After the existing jailbreak chain finishes its kernel cleanup, a userland syscall bridge sends the bundled PS4 ELF to GoldHEN BinLoader at 127.0.0.1:9090 and talks to PKG Manager at 127.0.0.1:8844. No PC or home-lab service is required by this implementation. GoldHEN BinLoader must be enabled. Refused connections are retried for up to 60 seconds for BinLoader and 10 seconds for each manager request. Retries happen only before sending bytes; payloads and installation requests are not resent after an ambiguous transfer. Diagnostics names the service and port when a connection fails.

User testing of the earlier build on PS4 13.52 confirmed fresh jailbreaks with and without an installed tile, reopening with an installed tile, and already-jailbroken bootstrap without a tile after switching to the PS4 SO_NBIO socket option. The October 10 upstream AIO/stability merge still requires console validation. The automated suite additionally checks protocol parsing, version handling, retry behavior and UI transitions. This does not guarantee every exploit attempt succeeds.

Reopening still needs the browser primitive for native loopback access; the existing already-root guard skips the kernel exploit when active. If an older manager is running, restart the console normally before updating. Success is shown only after the installed tile version is confirmed.

On Pages, root credentials and GoldHEN payload thread creation do not complete the second progress segment. Setup advances only when the existing manager responds or BinLoader accepts the payload connection. If neither is available, jailbreak readiness stays unconfirmed. This service check cannot distinguish GoldHEN failing to load from BinLoader being disabled; diagnostics asks the user to check GoldHEN in Settings.

## Diagnostics

Use https://bsk193.github.io/malveira-jb/?diagnostics=1 to show status and errors on the normal page. The flag is preserved through navigation and retry. Remove it for the text-free UI. The old /diagnostics/ bookmark redirects to this flag. Diagnostics shares the normal offline cache; reopen the root online to receive updates.

## Offline cache

Open the root site online first and allow the cache to complete. AppCache stores the HTML, scripts, GoldHEN, firmware patch, manager configuration and ELF. The cache manifest contains a content hash, so deployments refresh it when files change. Offline jailbreak and launching/checking the cached manager are supported by the implementation, subject to browser cache retention; offline operation still needs a dedicated console test.

A fresh tile install/update still requires internet: the manager downloads its PKG from the Pages URL, and its native HTTP client cannot read the browser's AppCache. The tile PKG is therefore excluded from the browser cache; it remains available on the site for the native installer. If the tile is already current, setup requires only console-local calls. Release update discovery also requires internet. Do not clear website data if you want to retain the offline cache.

## Deployment

.github/workflows/pages.yml runs tests, verifies release asset SHA-256 digests, builds a static _site artifact, and deploys through GitHub Pages Actions. It runs on main pushes, manual dispatch, and a daily release refresh. Only _site is published. Build-time release checks pick the latest stable PKG Manager X release; the console uses the deployed, cached version.

Local checks: node --test test.mjs console-setup.test.mjs
Build: node scripts/build-pages.mjs
Refresh release at build: node scripts/build-pages.mjs --latest

## Optional local host

Run node server.mjs with Node.js 22+ or ./Start.ps1 on Windows. The source public HTML does not enable standalone mode; the Pages build adds that switch. The Node host must share a reachable LAN with the PS4. Dockerfile is provided for Linux host networking. Do not expose its unauthenticated local management API publicly.

## Credits

Host based on psx8/psx8.github.io (1352 directory), with raw13g's September 22 AIO patch and September 25 stability update merged on October 10. GoldHEN by SiSTRo and contributors; PKG Manager X by bsk193 and contributors, based on PLK's PKG Manager. See PROVENANCE.txt, LICENSE.raw13g and assets/release.json. Our existing jailbreak guard avoids automatically reloading GoldHEN; Pages setup adds console-local package orchestration after upstream kernel cleanup. The GoldHEN binary is unchanged.

## Local workspace

The active checkout is malveira-jb. Earlier host versions, reference source, troubleshooting logs and old bundles are preserved in .local-archive, which is excluded from Git, Docker and Pages. Separate PKG Manager and unrelated projects are not part of this archive.
