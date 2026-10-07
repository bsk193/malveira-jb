# Malveira JB PS4

Minimal PS4 13.52 host: three progress segments, an icon retry button and a green success indicator. Bundles GoldHEN and verified PKG Manager X 1.0.2 PS4 assets.

## Current working deployment

Run `node server.mjs` with Node.js 22+ or `./Start.ps1` on Windows. Open the printed LAN address on the PS4. Keep the server on a trusted LAN. The host must reach the console on ports 9090 (BinLoader), 8844 (manager), and optionally 2121 (FTP status). The console must reach the host to download the package.

For a Linux home-lab host, build with `docker build -t malveira-jb-ps4 .` and run with `docker run --rm --network host malveira-jb-ps4`. Host networking preserves the direct LAN client address used for console detection. A bridge/NAT or reverse proxy needs explicit routing configuration before use. This container currently uses its writable layer for release downloads; they are lost when removed and will be downloaded again when needed.

Run `node --test test.mjs` for verification.

## GitHub Pages deployment pending

Only `public/` belongs in a Pages artifact. Never deploy the repository root. GitHub Pages cannot run `server.mjs`.

The current UI uses same-origin `/api/console`, `/api/ready`, and `/api/job`. Publishing it unchanged on Pages would break manager setup. Final integration requires the home-lab address, a browser-compatible HTTPS endpoint, narrow cross-origin access controls, and a trustworthy way for the backend to identify and reach the PS4 behind a proxy. A remote friend needs a LAN agent or routed VPN; an internet server cannot reach a private console IP directly.

Pages is not enabled yet. Confirm public website visibility separately from private repository visibility and verify that the account supports Pages from private repositories.

## Provenance

Host based on psx8/psx8.github.io (1352 directory), GoldHEN by SiSTRo and contributors, PKG Manager X by bsk193 and contributors. See PROVENANCE.txt and assets/release.json for pinned versions and checksums. The browser and kernel exploit mechanics are inherited; the custom layer supplies firmware gating, progress UI and manager setup orchestration.
