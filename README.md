# Malveira JB PS4

PS4 13.52 host with three progress segments, an icon retry button, and a green checkmark after PKG Manager tile verification.

## GitHub Pages

Site: https://bsk193.github.io/malveira-jb-ps4/

The Pages build enables console-local setup. After the existing jailbreak chain finishes its kernel cleanup, a userland syscall bridge sends the bundled PS4 ELF to GoldHEN BinLoader at 127.0.0.1:9090 and talks to PKG Manager at 127.0.0.1:8844. No PC or home-lab service is required by this implementation. GoldHEN BinLoader must be enabled. Refused connections are retried for up to 30 seconds; payloads are not resent after an ambiguous transfer.

This console-local transport is new and has not yet been validated on PS4 hardware. Automated tests cover protocol parsing, refusal/partial-write behavior, install/check orchestration, and UI state. They do not prove the native ABI or browser stability on the console. The previously tested Node-hosted version remains available in the original local project.

Reopening still needs the browser primitive for native loopback access; the existing already-root guard skips the kernel exploit when active. If an older manager is running, restart the console normally before updating. Success is shown only after the installed tile version is confirmed.

## Offline cache

Open the root site online first and allow the cache to complete. AppCache stores the HTML, scripts, GoldHEN, firmware patch, manager configuration, ELF and tile. The cache manifest contains a content hash, so deployments refresh it when files change. Offline jailbreak and launching/checking the cached manager are supported by the implementation, subject to PS4 validation and browser cache retention.

A fresh tile install/update still requires internet: the manager downloads its PKG from the Pages URL, and its native HTTP client cannot read the browser's AppCache. Caching the PKG in the browser does not change that. If the tile is already current, setup requires only console-local calls. Release update discovery also requires internet. Do not clear website data if you want to retain the offline cache.

## Deployment

.github/workflows/pages.yml runs tests, verifies release asset SHA-256 digests, builds a static _site artifact, and deploys through GitHub Pages Actions. It runs on main pushes, manual dispatch, and a daily release refresh. Only _site is published. Build-time release checks pick the latest stable PKG Manager X release; the console uses the deployed, cached version.

Local checks: node --test test.mjs console-setup.test.mjs
Build: node scripts/build-pages.mjs
Refresh release at build: node scripts/build-pages.mjs --latest

## Optional local host

Run node server.mjs with Node.js 22+ or ./Start.ps1 on Windows. The source public HTML does not enable standalone mode; the Pages build adds that switch. The Node host must share a reachable LAN with the PS4. Dockerfile is provided for Linux host networking. Do not expose its unauthenticated local management API publicly.

## Credits

Host based on psx8/psx8.github.io (1352 directory); GoldHEN by SiSTRo and contributors; PKG Manager X by bsk193 and contributors, based on PLK's PKG Manager. See PROVENANCE.txt and assets/release.json. The inherited kernel exploit and GoldHEN binary are unchanged; Pages setup adds console-local package orchestration after kernel cleanup.
