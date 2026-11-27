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
| `GET /ota/manifest.json` | OTA manifest the firmware fetches hourly (`version` + per-board `url`/`size`/`sha256`) |
| `GET /api/ota/manifest?board=esp32dev\|esp32c5` | Same manifest for one board (admin use) |
| `GET /firmware/:board/firmware.bin` | Firmware binary download |
| `POST /logs` / `POST /api/logs` | Device log upload (`Authorization: Bearer <DEVICE_TOKEN>` or `X-Device-Token`) |
| `GET /api/logs?limit=100` | Recent logs (admin token if set) |
| `GET /api/devices` | Online devices, last-seen, board, version, IP (admin token if set) |
| `WS /link` (alias `/ws/device`) | Device link: hello/auth, commands, results, alerts |
| `WS /ws/control?token=<ADMIN_TOKEN>` | Control clients: send `{id, device, command, params}` |
| `GET /` | Tiny admin page (devices, logs, send a command) |

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
DEVICE_TOKEN=esp-router-dev-token ADMIN_TOKEN=admin-secret PORT=3000 npm start
```

## Deploy on Render (Anit's account)

1. Push this folder to a GitHub repo (or use Render's Blueprint with
   `render.yaml` in this folder — service `esp-router-cloud`, Node, free
   plan, Singapore region, build `npm install`, start `node server.js`).
2. In the Render service settings set environment variables:
   - `DEVICE_TOKEN` — a long random secret. **Must match the token set on
     each device** (panel > System > Cloud > cloud token). Default
     `esp-router-dev-token` is for local testing only.
   - `ADMIN_TOKEN` — a long random secret for `/api/logs`, `/api/devices`
     and `/ws/control`. If unset, those endpoints are open — set one.
   - `PORT` — Render sets this automatically.
3. Note the service URL, e.g. `https://esp-router-cloud.onrender.com`.
   On the device set Cloud base URL to exactly that (panel > System >
   Cloud, or `POST /api/system/cloud` with `{"baseUrl": "..."}`), and the
   cloud token to `DEVICE_TOKEN`. The device connects out to
   `wss://<host>/link`, fetches the manifest from
   `https://<host>/ota/manifest.json`, and posts logs to
   `https://<host>/logs`.

Notes:
- Render free-tier web services spin down after inactivity; the device
  reconnects automatically (backoff up to 60 s) and re-checks OTA hourly,
  so a cold start only delays the first check.
- Logs are kept in memory (last 1000) and appended to `data/logs.jsonl`.
  The file is restored on restart, but Render's free-tier disk is
  ephemeral — treat the in-memory log as the source of truth and the
  file as a best-effort backup.
- The server never stores WiFi passwords or the admin password; the only
  secret it checks is `DEVICE_TOKEN` (device link + log upload) and
  `ADMIN_TOKEN` (admin reads + control socket).
