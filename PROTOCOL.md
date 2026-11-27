# ESP-Router cloud protocol

Server: `~/workspace/esp-cloud-server/server.js`. Firmware side:
`~/workspace/wifi/src/modules/CloudLink.{h,cpp}` and
`~/workspace/wifi/src/core/ConfigStore.h` (`cloud.baseUrl`). The device
is behind NAT, so **the device always dials out** — the cloud never
connects in to it.

Device configuration (admin panel > System > Cloud, or
`POST /api/system/cloud` on the device):
- `baseUrl`: the cloud server base URL, e.g. `https://esp-router-cloud.onrender.com`
  (http:// for local testing, e.g. `http://192.168.1.50:3000`). Default is
  the Render URL baked into the firmware; empty = all cloud features
  disabled.
- No token, no password, nothing else to enter: the device authenticates
  with its unique **chip ID** (see §0).

## 0. Auth — chip ID + first-connect auto-pairing (no tokens)

The device identifies itself with its chip ID: the ESP32 eFuse MAC as
12 lowercase hex digits (e.g. `a1b2c3d4e5f6`), shown in the panel under
System > Cloud connection. It is sent:
- in the hello frame (`"chipId"`),
- as an `X-Device-Id` header on `GET /ota/manifest.json` and
  `POST /logs` (also accepted as `chipId` in the log-upload JSON body).

The server **auto-pairs the first chip ID that connects** — on any of
`/link`, `/logs` or `/ota/manifest.json` — stores it in
`data/devices.json` (`{"chipId","device","pairedAt"}`, survives restarts),
and afterwards **only accepts that chip ID** on those three endpoints
(anything else gets `401` on HTTP, or `{"type":"auth","ok":false}` and a
closed socket on `/link`).

To pair a **different device**: power the old device off first (otherwise
it re-pairs on reconnect), then either delete `data/devices.json` and
restart the server, or call `POST /api/devices/unpair` with the admin
token — that clears the pairing and drops the live link, so the next chip
ID that connects pairs instead. `GET /api/devices` (admin token) shows
the currently paired chip ID.

## 1. Live link — WebSocket

Device derives the link URL from `baseUrl`:
`https://host` → `wss://host/link`, `http://host` → `ws://host/link`,
`ws(s)://host` → `ws(s)://host/link`. (`/ws/device` on the server is an
alias for `/link`.)

After the WS handshake the device sends:

```json
{"type":"hello","device":"esp-router","chipId":"a1b2c3d4e5f6","version":"0.3.0","board":"esp32dev"}
```

`board` is `esp32c5` when the chip model contains "C5", else `esp32dev`.
The server pairs/authenticates the chip ID (see §0) and replies:

```json
{"type":"auth","ok":true}
```

(`ok:false` and the socket is closed when the chip ID is missing,
malformed, or not the paired one.) The device
executes **no** command before `auth.ok == true`. It sends a WS ping frame
every 30 s and drops the link if nothing is received for 90 s; the server
also sends `{"type":"ping"}` every 30 s and the device replies
`{"type":"pong"}`.

### Commands (server → device)

```json
{"type":"command","id":"c1","cmd":"status"}
```

Extra fields are the command's flat parameters. The device replies:

```json
{"type":"result","id":"c1","ok":true,"state":{...}}
```

On failure: `{"type":"result","id":"c1","ok":false,"error":"..."}`.
`state` is present for `status`/`stats`/`logs`/`ota_check`/`ota_update`/
`cloud_set`.

| cmd | params | effect |
|---|---|---|
| `status` / `stats` | — | `{uptime, heap, clients, staRssi, staConnected, channel, txBytes, rxBytes, txKbps, rxKbps, cloudConnected}` |
| `logs` | — | `state.logs` = `{seq, lines:[{seq,ms,level,msg}]}` (all buffered lines) |
| `reboot` | — | replies ok, reboots ~1.5 s later |
| `factory_reset` | `confirm:true` (required) | replies ok, factory-resets + reboots |
| `ota_check` | — | triggers a manifest check now; `state.ota` = OTA status |
| `ota_update` | — | same as `ota_check` (check → download → install if newer) |
| `cloud_set` | `baseUrl` | changes cloud URL, reconnects |
| `client_block` / `client_unblock` | `mac` | block/unblock a client by MAC |
| `client_rename` | `mac`, `name` | rename a client |
| `client_limit` | `mac`, `kbps` (0=none), `capMB` (0=none) | per-client speed/data limit |
| `ap_set` | `ssid?`, `channel?`, `channelAuto?`, `auth?` (`wpa2`/`wpa3`/`wpa2wpa3`), `band?`, `hidden?`, `maxClients?`, `password?` | AP settings, AP restarts |
| `wan_set` | `ssid?`, `backupSsid?`, `enabled?`, `password?`, `backupPassword?` | upstream WiFi settings, reconnects |

Unknown `cmd` → `{"type":"result","id":...,"ok":false,"error":"unknown command: <cmd>"}`.

### Alerts (device → server, over the link)

```json
{"type":"alert","alert":"wan-down","message":"Upstream WiFi disconnected","device":"esp-router"}
```

Alert types used by the firmware: `wan-down`, `unknown-device`,
`ota-failed`, `cloud-auth`. If the link is down the device falls back to
the configured portal webhook instead.

## 2. Cloud OTA — HTTP

Hourly (first check ~60 s after boot, also on `ota_check` / panel trigger)
the device does `GET <baseUrl>/ota/manifest.json` with an
`X-Device-Id: <chipId>` header (missing/unknown chip ID → `401`, see §0):

```json
{
  "version": "0.3.0",
  "esp32dev": {"url": "https://<host>/firmware/esp32dev/firmware.bin", "size": 1557296, "sha256": "9a6a60de..."},
  "esp32c5":  {"url": "https://<host>/firmware/esp32c5/firmware.bin", "size": 1760048, "sha256": "d3d92913..."}
}
```

- The device reads `version`, then the object for its own board key
  (`esp32dev` or `esp32c5`); if no per-board object exists it falls back to
  top-level `url`/`size`.
- If `version` is not newer than its own (numeric dotted compare), it does
  nothing. If newer, it `GET`s `url` (must be an absolute URL), streams it
  into the OTA partition with `Update`, and reboots ~3 s after success.
  `sha256` is informational (the device does not verify it; the server
  serves the exact file it hashed).
- A failed download/apply is reported as a `ota-failed` alert; the old
  partition stays in place (see OtaGuard rollback in the firmware).

## 3. Cloud logs — HTTP

Every 30 s the device does `POST <baseUrl>/logs` with
`Content-Type: application/json` and an `X-Device-Id: <chipId>` header
(missing/unknown chip ID → `401`, see §0):

```json
{"device":"esp-router","chipId":"a1b2c3d4e5f6","version":"0.3.0","lines":[{"seq":12,"ms":123456,"level":"I","msg":"WAN connected: 192.168.1.5"}]}
```

`lines` are LogBuffer entries since the last push (`seq` = ring sequence,
`ms` = device uptime ms, `level` = `I`/`W`/`E`/`D`/`V`, `msg` = text).
The server must answer 2xx. (`POST /api/logs` on the server is the same
endpoint; the chip ID is also accepted in the JSON body as `chipId`.)

## 4. Control clients (Muse / admin)

Control clients connect to `WS <base>/ws/control?token=<ADMIN_TOKEN>` and
send:

```json
{"id":"web1","device":"esp-router","command":"block_client","params":{"mac":"AA:BB:CC:DD:EE:FF"}}
```

The server translates `command` → firmware `cmd` (e.g. `block_client` →
`client_block`, `set_ap` → `ap_set`, `get_stats` → `stats`,
`get_logs` → `logs`, `ota_check`/`ota_update`/`reboot` pass through) and
returns the device's reply as:

```json
{"id":"web1","ok":true,"result":{...}}
```

(`result` is the device's `state`; `error` is present instead on failure,
e.g. `device offline` / `device timeout` after 30 s.) Local helpers that
need no device: `command:"list_devices"` and `command:"get_cloud_logs"`
(`params.limit`). The server also pushes `{"type":"device","device":...,
"online":true/false}` and `{"type":"alert",...}` events to control clients.

Control clients may also send the firmware-native format directly
(`{"type":"command","cmd":"client_block","mac":"..."}`) — flat params are
forwarded as-is.
