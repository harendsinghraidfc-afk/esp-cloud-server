# ESP-Router Cloud Server

Cloud server for the ESP-Router firmware (`~/workspace/wifi`): hosts OTA
firmware, collects device logs, and relays live remote-control commands
between control clients (Muse / the admin page) and devices. The exact
wire protocol is documented in [PROTOCOL.md](PROTOCOL.md) — it matches the
firmware's `CloudLink` module, not the other way round.

## What it serves

| Endpoint | Purpose |
|---|---|
| `GET /health` | `{"ok":true}` |
| `GET /ota/manifest.json` | OTA manifest the firmware fetches hourly (`version` + per-board `url`/`size`/`sha256`) — chip-ID auth (`X-Device-Id`) |
| `GET /api/ota/manifest?board=esp32dev\|esp32c5` | Same manifest for one board (admin use) |
| `GET /firmware/:board/firmware.bin` | Firmware binary download (open — the firmware is public) |
| `POST /logs` / `POST /api/logs` | Device log upload (chip-ID auth: `X-Device-Id` header or `chipId` in body) |
| `GET /api/logs?limit=100` | Recent logs (admin token if set) |
| `GET /api/devices` | Online devices, paired chip ID, last-seen, board, version, IP (admin token if set) |
| `POST /api/devices/unpair` | Clear the pairing (admin token) — next chip ID that connects pairs instead |
| `POST /api/captures` | Device handshake-capture upload: raw bytes, `X-Device-Id` + `X-Filename` headers, `.pcap` or `.hc22000`, max 512 KB (chip-ID auth, first upload auto-pairs) |
| `GET /api/captures` | List uploaded captures, newest first (admin token if set) |
| `GET /api/captures/:name` | Download one capture file (admin token if set) |
| `DELETE /api/captures/:name` | Delete one capture file (admin token if set) |
| `WS /link` (alias `/ws/device`) | Device link: hello/auth, commands, results, alerts |
| `WS /ws/control?token=<ADMIN_TOKEN>` | Control clients: send `{id, device, command, params}` |
| `GET /` | Tiny admin page (devices, logs, send a command) |

**Auth — no device token.** The device identifies itself with its unique
chip ID (ESP32 eFuse MAC, 12 hex digits). The server auto-pairs the first
chip ID that connects (stored in `data/devices.json`, survives restarts)
and afterwards only accepts that chip ID on `/link`, `/logs`,
`/ota/manifest.json` and `/api/captures`. To pair a different device, power the old one off
and call `POST /api/devices/unpair` (admin token) or delete
`data/devices.json` and restart.

Capture files uploaded by the device (AP MODE V2 handshakes) are stored
in `data/captures/` on the server filesystem. On Render's free tier that
disk is ephemeral — files survive until the service restarts or
redeploys; the device always keeps its local copy, so re-uploading after
a restart is the recovery path.

Firmware served right now: **version 0.3.0** (from
`wifi/platformio.ini` `-DESP_ROUTER_VERSION="0.3.0"`).
- `esp32dev`: 1,557,296 bytes, sha256 `9a6a60de4da725588fc1f3f2c2dc856235082e87cd6376dc460279730cdf339c`
- `esp32c5`: 1,760,048 bytes, sha256 `d3d929137f58d0a24272e6ebb4a5f76d4ef2bc8c183e964e7dd333d523c26fa5`

To ship a new version: replace the two `firmware/*/firmware.bin` files,
bump `VERSION` in `server.js` to match the firmware's
`-DESP_ROUTER_VERSION`, and redeploy. Devices check the manifest hourly
and self-update when the version is newer.

## Run locally

```sh
npm install
ADMIN_TOKEN=admin-secret PORT=3000 npm start
```

## Deploy on Render (Anit's account)

1. Push this folder to a GitHub repo (or use Render's Blueprint with
   `render.yaml` in this folder — service `esp-router-cloud`, Node, free
   plan, Singapore region, build `npm install`, start `node server.js`).
2. In the Render service settings set environment variables:
   - `ADMIN_TOKEN` — a long random secret for `/api/logs`, `/api/devices`,
     `/api/devices/unpair` and `/ws/control`. If unset, those endpoints
     are open — set one.
   - `PORT` — Render sets this automatically.
   - No `DEVICE_TOKEN` anymore: devices authenticate by chip ID, so
     there is nothing to set for them. (If an old `DEVICE_TOKEN` env var
     is still on the service, it is ignored — you can delete it.)
3. Note the service URL, e.g. `https://esp-router-cloud.onrender.com`.
   The firmware already has this URL as its default cloud URL, so a
   freshly flashed device connects on its own — nothing to enter in the
   panel. The first chip ID that connects auto-pairs; afterwards only
   that device is accepted. To pair a different device, power the old
   one off and call `POST /api/devices/unpair` with the admin token
   (or delete `data/devices.json` on the server and restart).

Notes:
- Render free-tier web services spin down after inactivity; the device
  reconnects automatically (backoff up to 60 s) and re-checks OTA hourly,
  so a cold start only delays the first check.
- Logs are kept in memory (last 1000) and appended to `data/logs.jsonl`.
  The file is restored on restart, but Render's free-tier disk is
  ephemeral — treat the in-memory log as the source of truth and the
  file as a best-effort backup.
- The server never stores WiFi passwords or the admin password; the only
  secret it checks is `ADMIN_TOKEN` (admin reads + control socket).
  Devices authenticate by chip ID, not by a shared secret — the paired
  chip ID lives in `data/devices.json`.
