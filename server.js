'use strict';
/**
 * ESP-Router cloud server.
 *
 * Matches the firmware protocol in wifi/src/modules/CloudLink.{h,cpp}:
 *   - Device WebSocket link:  WS(S) <base>/link
 *       device -> {"type":"hello","device","version","board","token"}
 *       server -> {"type":"auth","ok":true|false}
 *       server -> {"type":"command","id","cmd",...params}
 *       device -> {"type":"result","id","ok","error","state"}
 *       device -> {"type":"alert","alert","message","device"}
 *   - Cloud OTA:  GET <base>/ota/manifest.json
 *       {"version","esp32dev":{"url","size","sha256"},"esp32c5":{...}}
 *   - Cloud logs: POST <base>/logs  (Authorization: Bearer <DEVICE_TOKEN>)
 *       {"device","version","lines":[{"seq","ms","level","msg"}]}
 *
 * Extra admin/control surface (not used by the firmware):
 *   - GET  /health, GET /api/ota/manifest?board=, GET /firmware/:board/firmware.bin
 *   - POST /api/logs (alias of /logs, also accepts X-Device-Token)
 *   - GET  /api/logs?limit=, GET /api/devices
 *   - WS   /ws/device (alias of /link), WS /ws/control
 *   - GET  /  tiny admin page
 *
 * Env: PORT (Render sets it), DEVICE_TOKEN, ADMIN_TOKEN.
 * Deps: only "ws". Plain Node http for everything else.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = parseInt(process.env.PORT || '3000', 10);
const DEVICE_TOKEN = process.env.DEVICE_TOKEN || 'esp-router-dev-token';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || ''; // empty = /api/logs + /api/devices + /ws/control open (dev only)
const VERSION = '0.3.0'; // must match -DESP_ROUTER_VERSION in wifi/platformio.ini
const BOARDS = ['esp32dev', 'esp32c5'];
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const LOG_FILE = path.join(DATA_DIR, 'logs.jsonl');
const MAX_LOGS = 1000;
const COMMAND_TIMEOUT_MS = 30000;

if (!process.env.DEVICE_TOKEN) {
  console.warn('[warn] DEVICE_TOKEN not set, using default dev token "esp-router-dev-token" - CHANGE IT on Render.');
}
if (!ADMIN_TOKEN) console.warn('[warn] ADMIN_TOKEN not set, admin endpoints are open - set one on Render.');

// ---------------------------------------------------------------- firmware
const FIRMWARE = {};
for (const board of BOARDS) {
  const file = path.join(ROOT, 'firmware', board, 'firmware.bin');
  if (fs.existsSync(file)) {
    const buf = fs.readFileSync(file);
    FIRMWARE[board] = {
      size: buf.length,
      sha256: crypto.createHash('sha256').update(buf).digest('hex'),
      file,
    };
  } else {
    console.warn(`[warn] firmware missing for ${board}: ${file}`);
  }
}

// ---------------------------------------------------------------- state
// logs: [{ts, device, version, seq, ms, level, msg}]
let logs = [];
// devices: name -> {name, board, version, ip, lastSeen, ws, stats}
const devices = new Map();
// pending control commands: id -> {control, device, timer}
const pending = new Map();
let cmdSeq = 0;

function storeLog(entry) {
  logs.push(entry);
  if (logs.length > MAX_LOGS) logs = logs.slice(-MAX_LOGS);
  try {
    fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n');
  } catch (e) { /* disk is ephemeral on Render free tier; memory is the source of truth */ }
}

// Restore recent logs from disk on (re)start.
try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(LOG_FILE)) {
    const lines = fs.readFileSync(LOG_FILE, 'utf8').split('\n').filter(Boolean).slice(-MAX_LOGS);
    for (const line of lines) { try { logs.push(JSON.parse(line)); } catch (e) {} }
    console.log(`[init] restored ${logs.length} log entries from disk`);
  }
} catch (e) { console.warn('[warn] could not restore logs:', e.message); }

// ---------------------------------------------------------------- helpers
function baseUrlOf(req) {
  const proto = (req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  return `${proto}://${req.headers.host}`;
}

function manifestFor(req) {
  const base = baseUrlOf(req);
  const m = { version: VERSION };
  for (const board of BOARDS) {
    const fw = FIRMWARE[board];
    if (fw) m[board] = { url: `${base}/firmware/${board}/firmware.bin`, size: fw.size, sha256: fw.sha256 };
  }
  return m;
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readJsonBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch (e) { reject(new Error('invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function deviceTokenOf(req) {
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
  return (req.headers['x-device-token'] || '').trim();
}

function adminOk(req, url) {
  if (!ADMIN_TOKEN) return true;
  const q = url.searchParams.get('token');
  const h = (req.headers['x-admin-token'] || '').trim();
  const auth = req.headers.authorization || '';
  return q === ADMIN_TOKEN || h === ADMIN_TOKEN || auth === `Bearer ${ADMIN_TOKEN}`;
}

function publicDevices() {
  return [...devices.values()].map((d) => ({
    device: d.name, board: d.board, version: d.version,
    online: !!d.ws && d.ws.readyState === 1,
    lastSeen: d.lastSeen ? new Date(d.lastSeen).toISOString() : null,
    ip: d.ip, stats: d.stats || null,
  }));
}

function broadcastControl(obj) {
  const text = JSON.stringify(obj);
  for (const ws of controlClients) {
    if (ws.readyState === 1) ws.send(text);
  }
}

// ---------------------------------------------------------------- HTTP
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;

    if (req.method === 'GET' && p === '/health') return sendJson(res, 200, { ok: true });

    if (req.method === 'GET' && p === '/') {
      const file = path.join(ROOT, 'public', 'index.html');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return fs.createReadStream(file).pipe(res);
    }

    // Firmware OTA manifest (exact path the device fetches).
    if (req.method === 'GET' && p === '/ota/manifest.json') {
      return sendJson(res, 200, manifestFor(req));
    }

    // Admin alias: manifest for one board.
    if (req.method === 'GET' && p === '/api/ota/manifest') {
      const board = url.searchParams.get('board');
      if (!board || !FIRMWARE[board]) return sendJson(res, 404, { ok: false, error: 'unknown board, use esp32dev or esp32c5' });
      const fw = FIRMWARE[board];
      return sendJson(res, 200, {
        version: VERSION, board,
        url: `${baseUrlOf(req)}/firmware/${board}/firmware.bin`,
        size: fw.size, sha256: fw.sha256,
      });
    }

    // Firmware binary download (the device GETs this URL from the manifest).
    if (req.method === 'GET' && p.startsWith('/firmware/') && p.endsWith('/firmware.bin')) {
      const board = p.split('/')[2];
      const fw = FIRMWARE[board];
      if (!fw) return sendJson(res, 404, { ok: false, error: 'unknown board' });
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': fw.size,
        'Content-Disposition': `attachment; filename="${board}-firmware.bin"`,
      });
      return fs.createReadStream(fw.file).pipe(res);
    }

    // Device log upload: firmware POSTs here every 30 s (Bearer token).
    // /api/logs is the same endpoint with X-Device-Token also accepted.
    if (req.method === 'POST' && (p === '/logs' || p === '/api/logs')) {
      if (deviceTokenOf(req) !== DEVICE_TOKEN) return sendJson(res, 401, { ok: false, error: 'bad device token' });
      const body = await readJsonBody(req);
      const lines = Array.isArray(body.lines) ? body.lines : [];
      const now = new Date().toISOString();
      for (const l of lines) {
        storeLog({
          ts: now, device: body.device || 'unknown', version: body.version || '',
          seq: l.seq ?? null, ms: l.ms ?? null, level: l.level || 'I', msg: String(l.msg ?? ''),
        });
      }
      return sendJson(res, 200, { ok: true, stored: lines.length });
    }

    if (req.method === 'GET' && p === '/api/logs') {
      if (!adminOk(req, url)) return sendJson(res, 401, { ok: false, error: 'bad admin token' });
      const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '100', 10) || 100, 1), MAX_LOGS);
      return sendJson(res, 200, { logs: logs.slice(-limit) });
    }

    if (req.method === 'GET' && p === '/api/devices') {
      if (!adminOk(req, url)) return sendJson(res, 401, { ok: false, error: 'bad admin token' });
      return sendJson(res, 200, { devices: publicDevices() });
    }

    return sendJson(res, 404, { ok: false, error: 'not found' });
  } catch (e) {
    if (!res.headersSent) sendJson(res, 400, { ok: false, error: e.message });
  }
});

// ---------------------------------------------------------------- WebSocket
const wss = new WebSocketServer({ noServer: true });
const controlClients = new Set();

// Control command name -> firmware cmd name + param mapping.
// Control client sends: {id, device, command, params}
// Firmware receives:    {type:"command", id, cmd, ...flat params}
const COMMAND_MAP = {
  status: 'status',
  get_stats: 'stats',
  get_logs: 'logs',
  reboot: 'reboot',
  factory_reset: 'factory_reset',
  ota_check: 'ota_check',
  ota_update: 'ota_update',
  block_client: 'client_block',
  unblock_client: 'client_unblock',
  rename_client: 'client_rename',
  set_client_limit: 'client_limit',
  set_ap: 'ap_set',
  set_wan: 'wan_set',
  cloud_set: 'cloud_set',
};

function sendCommandToDevice(deviceName, controlWs, msg) {
  const d = devices.get(deviceName);
  if (!d || !d.ws || d.ws.readyState !== 1) {
    controlWs.send(JSON.stringify({ id: msg.id, ok: false, error: 'device offline' }));
    return;
  }
  // Native firmware format passthrough: {type:"command", cmd, ...flat params}
  if (msg.type === 'command' && msg.cmd) {
    const id = msg.id || `c${++cmdSeq}`;
    pending.set(id, { control: controlWs, device: deviceName, timer: setTimeout(() => {
      pending.delete(id);
      if (controlWs.readyState === 1) controlWs.send(JSON.stringify({ id, ok: false, error: 'device timeout' }));
    }, COMMAND_TIMEOUT_MS) });
    const { type, id: _id, cmd, ...flat } = msg;
    d.ws.send(JSON.stringify({ type: 'command', id, cmd, ...flat }));
    return;
  }
  const cmd = COMMAND_MAP[msg.command];
  if (!cmd) {
    controlWs.send(JSON.stringify({ id: msg.id, ok: false, error: 'unknown command: ' + msg.command }));
    return;
  }
  if (cmd === 'factory_reset' && !(msg.params && msg.params.confirm === true)) {
    controlWs.send(JSON.stringify({ id: msg.id, ok: false, error: 'factory_reset requires params.confirm=true' }));
    return;
  }
  const id = msg.id || `c${++cmdSeq}`;
  pending.set(id, { control: controlWs, device: deviceName, timer: setTimeout(() => {
    pending.delete(id);
    if (controlWs.readyState === 1) controlWs.send(JSON.stringify({ id, ok: false, error: 'device timeout' }));
  }, COMMAND_TIMEOUT_MS) });
  d.ws.send(JSON.stringify({ type: 'command', id, cmd, ...(msg.params || {}) }));
}

function handleDeviceSocket(ws, req) {
  let device = null;
  const ip = req.socket.remoteAddress || '';
  let helloTimer = setTimeout(() => { if (!device) ws.close(4001, 'no hello'); }, 10000);

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch (e) { return; }
    if (!device) {
      // First message must be the hello with the device token.
      if (msg.type !== 'hello' || msg.token !== DEVICE_TOKEN) {
        try { ws.send(JSON.stringify({ type: 'auth', ok: false })); } catch (e) {}
        ws.close(4003, 'bad token');
        return;
      }
      clearTimeout(helloTimer);
      device = {
        name: String(msg.device || 'unknown'), board: String(msg.board || ''),
        version: String(msg.version || ''), ip, lastSeen: Date.now(), ws, stats: null,
      };
      devices.set(device.name, device);
      ws.send(JSON.stringify({ type: 'auth', ok: true }));
      console.log(`[device] ${device.name} (${device.board} ${device.version}) online from ${ip}`);
      broadcastControl({ type: 'device', device: device.name, online: true, board: device.board, version: device.version });
      return;
    }
    device.lastSeen = Date.now();
    if (msg.type === 'pong') return;
    if (msg.type === 'alert') {
      const entry = { ts: new Date().toISOString(), device: device.name, version: device.version,
        seq: null, ms: null, level: 'W', msg: `[alert:${msg.alert || 'alert'}] ${msg.message || ''}` };
      storeLog(entry);
      broadcastControl({ type: 'alert', device: device.name, alert: msg.alert, message: msg.message });
      return;
    }
    if (msg.type === 'result') {
      const p = pending.get(msg.id);
      if (p) {
        clearTimeout(p.timer);
        pending.delete(msg.id);
        if (p.control.readyState === 1) {
          p.control.send(JSON.stringify({ id: msg.id, ok: !!msg.ok, error: msg.error || undefined, result: msg.state || undefined }));
        }
      }
      return;
    }
    if (msg.type === 'stats') { device.stats = msg; return; }
    // Unknown types are ignored (firmware does the same).
  });

  ws.on('close', () => {
    clearTimeout(helloTimer);
    if (device) {
      if (devices.get(device.name) === device) devices.delete(device.name);
      console.log(`[device] ${device.name} offline`);
      broadcastControl({ type: 'device', device: device.name, online: false });
    }
  });
  ws.on('error', () => {});
}

function handleControlSocket(ws, req) {
  controlClients.add(ws);
  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch (e) { ws.send(JSON.stringify({ ok: false, error: 'invalid JSON' })); return; }
    // Local helpers (no device needed).
    if (msg.command === 'list_devices') {
      ws.send(JSON.stringify({ id: msg.id, ok: true, result: { devices: publicDevices() } }));
      return;
    }
    if (msg.command === 'get_cloud_logs') {
      const limit = Math.min(Math.max(parseInt((msg.params && msg.params.limit) || '100', 10) || 100, 1), MAX_LOGS);
      ws.send(JSON.stringify({ id: msg.id, ok: true, result: { logs: logs.slice(-limit) } }));
      return;
    }
    if (!msg.device) { ws.send(JSON.stringify({ id: msg.id, ok: false, error: 'missing device' })); return; }
    sendCommandToDevice(msg.device, ws, msg);
  });
  ws.on('close', () => controlClients.delete(ws));
  ws.on('error', () => {});
  // Push current device list on connect.
  ws.send(JSON.stringify({ type: 'devices', devices: publicDevices() }));
}

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  if (p === '/link' || p === '/ws/device') {
    wss.handleUpgrade(req, socket, head, (ws) => handleDeviceSocket(ws, req));
  } else if (p === '/ws/control') {
    if (ADMIN_TOKEN && url.searchParams.get('token') !== ADMIN_TOKEN) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => handleControlSocket(ws, req));
  } else {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
  }
});

// Device keepalive: JSON ping every 30 s (firmware replies {"type":"pong"}).
setInterval(() => {
  for (const d of devices.values()) {
    if (d.ws.readyState === 1) {
      try { d.ws.send(JSON.stringify({ type: 'ping' })); } catch (e) {}
      try { d.ws.ping(); } catch (e) {}
    }
  }
}, 30000);

server.listen(PORT, () => {
  console.log(`[esp-cloud] listening on :${PORT} (version ${VERSION})`);
  for (const b of BOARDS) {
    const fw = FIRMWARE[b];
    console.log(`[esp-cloud] firmware ${b}: ${fw ? `${fw.size} bytes sha256=${fw.sha256}` : 'MISSING'}`);
  }
});
