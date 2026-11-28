'use strict';
/**
 * ESP-Router cloud server.
 *
 * Matches the firmware protocol in wifi/src/modules/CloudLink.{h,cpp}:
 *   - Device WebSocket link:  WS(S) <base>/link
 *       device -> {"type":"hello","device","chipId","version","board"}
 *       server -> {"type":"auth","ok":true|false}
 *       server -> {"type":"command","id","cmd",...params}
 *       device -> {"type":"result","id","ok","error","state"}
 *       device -> {"type":"alert","alert","message","device"}
 *   - Cloud OTA:  GET <base>/ota/manifest.json  (X-Device-Id header)
 *       {"version","esp32dev":{"url","size","sha256"},"esp32c5":{...}}
 *   - Cloud logs: POST <base>/logs  (X-Device-Id header)
 *       {"device","chipId","version","lines":[{"seq","ms","level","msg"}]}
 *
 * Auth is TOKEN-FREE for devices: the device identifies itself with its
 * unique chip ID (ESP32 eFuse MAC, 12 hex digits). The server
 * auto-pairs the FIRST chip ID that connects (stored in
 * data/devices.json, survives restarts) and afterwards only accepts
 * that chip ID on /link, /logs, /ota/manifest.json and /api/captures
 * (401 / socket close for anything else). To pair a different device,
 * power the old one off and call POST /api/devices/unpair (admin token)
 * or delete data/devices.json and restart.
 *
 * Extra admin/control surface (not used by the firmware):
 *   - GET  /health, GET /api/ota/manifest?board=, GET /firmware/:board/firmware.bin
 *   - GET  /api/logs?limit= (public read-only), GET /api/devices (public
 *     read-only), POST /api/devices/unpair (admin token)
 *   - POST /api/captures (device upload), GET /api/captures (admin list),
 *     GET /api/captures/:name (admin download), DELETE /api/captures/:name
 *   - WS   /ws/device (alias of /link), WS /ws/control
 *   - GET  /  tiny admin page
 *
 * Env: PORT (Render sets it), ADMIN_TOKEN.
 * Deps: only "ws". Plain Node http for everything else.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = parseInt(process.env.PORT || '3000', 10);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || ''; // gates /ws/control + write endpoints; GET /api/logs + /api/devices are public read-only
const VERSION = '0.3.8'; // must match -DESP_ROUTER_VERSION in wifi/platformio.ini
const BOARDS = ['esp32dev', 'esp32c5'];
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const LOG_FILE = path.join(DATA_DIR, 'logs.jsonl');
const PAIRING_FILE = path.join(DATA_DIR, 'devices.json');
const CAPTURES_DIR = path.join(DATA_DIR, 'captures');
const MAX_CAPTURE_SIZE = 512 * 1024; // bytes per capture file
const CAPTURE_EXTS = ['.pcap', '.hc22000'];
const MAX_LOGS = 1000;
const COMMAND_TIMEOUT_MS = 30000;

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

// ---------------------------------------------------------------- pairing
// Token-free device auth: the server pairs the FIRST chip ID that
// connects and afterwards only accepts that one. Persisted in
// data/devices.json so a restart does not re-open pairing.
let paired = null; // {chipId, device, pairedAt}

function loadPairing() {
  try {
    if (fs.existsSync(PAIRING_FILE)) {
      const p = JSON.parse(fs.readFileSync(PAIRING_FILE, 'utf8'));
      if (p && /^[0-9a-f]{12}$/i.test(p.chipId || '')) {
        paired = { chipId: String(p.chipId).toLowerCase(), device: String(p.device || ''), pairedAt: String(p.pairedAt || '') };
        console.log(`[pair] restored paired device: chip ${paired.chipId} (${paired.device || 'unnamed'})`);
      }
    }
  } catch (e) { console.warn('[warn] could not load pairing:', e.message); }
}

function savePairing() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(PAIRING_FILE, JSON.stringify(paired) + '\n');
  } catch (e) { console.warn('[warn] could not save pairing:', e.message); }
}

function clearPairing() {
  paired = null;
  try { if (fs.existsSync(PAIRING_FILE)) fs.unlinkSync(PAIRING_FILE); } catch (e) {}
}

function normalizeChipId(v) {
  const s = String(v || '').trim().toLowerCase();
  return /^[0-9a-f]{12}$/.test(s) ? s : '';
}

// Authorize a device by chip ID. First valid chip ID auto-pairs;
// afterwards only the paired chip ID is accepted.
// Returns {ok, chipId, pairedNow} or {ok:false, error}.
function authorizeDevice(chipId) {
  const id = normalizeChipId(chipId);
  if (!id) return { ok: false, error: 'missing or invalid chip id' };
  if (!paired) {
    paired = { chipId: id, device: '', pairedAt: new Date().toISOString() };
    savePairing();
    console.log(`[pair] first device paired: chip ${id}`);
    return { ok: true, chipId: id, pairedNow: true };
  }
  if (paired.chipId !== id) return { ok: false, error: 'unknown device (not the paired chip id)' };
  return { ok: true, chipId: id, pairedNow: false };
}

loadPairing();

// ---------------------------------------------------------------- captures
// AP MODE V2 handshake captures uploaded by the device
// (POST /api/captures, raw bytes, X-Device-Id + X-Filename headers).
// Files live in data/captures/ on the server filesystem — ephemeral on
// Render's free tier (gone on restart/redeploy); the device always
// keeps its local copy. The list endpoint reads the directory, so it
// survives a server restart; captureMeta only adds the exact chip ID /
// upload time for files uploaded in this process (on restart we fall
// back to the file mtime and the paired chip ID).
const captureMeta = new Map(); // name -> {chipId, uploadedAt}

// Basename only, no path traversal, .pcap or .hc22000 only.
// Returns the safe name, or '' when invalid.
function validCaptureName(name) {
  if (typeof name !== 'string') return '';
  const n = name.trim();
  if (!n || n.length > 100) return '';
  if (n.includes('/') || n.includes('\\') || n.includes('\0')) return '';
  if (n !== path.basename(n) || n === '.' || n === '..') return '';
  const ext = path.extname(n).toLowerCase();
  if (!CAPTURE_EXTS.includes(ext)) return '';
  return n;
}

function readRawBody(req, limit = MAX_CAPTURE_SIZE) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    let rejected = false;
    req.on('data', (c) => {
      if (rejected) return; // keep draining so the socket stays usable
      size += c.length;
      if (size > limit) {
        rejected = true;
        chunks.length = 0;
        req.resume(); // drain the rest; caller replies 413 on rejection
        reject(new Error('body too large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => { if (!rejected) resolve(Buffer.concat(chunks)); });
    req.on('error', reject);
  });
}

// List captures from the directory (newest first).
function listCaptures() {
  let names = [];
  try { names = fs.readdirSync(CAPTURES_DIR); } catch (e) { return []; }
  const out = [];
  for (const name of names) {
    const safe = validCaptureName(name);
    if (!safe) continue;
    let st;
    try { st = fs.statSync(path.join(CAPTURES_DIR, safe)); } catch (e) { continue; }
    if (!st.isFile()) continue;
    const meta = captureMeta.get(safe);
    out.push({
      name: safe,
      size: st.size,
      chipId: meta ? meta.chipId : (paired ? paired.chipId : null),
      uploadedAt: meta ? meta.uploadedAt : st.mtime.toISOString(),
    });
  }
  out.sort((a, b) => (a.uploadedAt < b.uploadedAt ? 1 : a.uploadedAt > b.uploadedAt ? -1 : 0));
  return out;
}

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

function deviceIdOf(req, body) {
  const h = (req.headers['x-device-id'] || '').trim();
  if (h) return h;
  if (body && typeof body.chipId === 'string') return body.chipId.trim();
  return '';
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
    device: d.name, chipId: d.chipId || null, board: d.board, version: d.version,
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
    // Chip-ID auth: the first chip ID that asks auto-pairs; afterwards
    // only the paired chip ID gets the manifest.
    if (req.method === 'GET' && p === '/ota/manifest.json') {
      const auth = authorizeDevice(req.headers['x-device-id'] || '');
      if (!auth.ok) return sendJson(res, 401, { ok: false, error: auth.error });
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

    // Device log upload: firmware POSTs here every 30 s, identified by
    // X-Device-Id (chip ID). /api/logs is the same endpoint.
    if (req.method === 'POST' && (p === '/logs' || p === '/api/logs')) {
      const body = await readJsonBody(req);
      const auth = authorizeDevice(deviceIdOf(req, body));
      if (!auth.ok) return sendJson(res, 401, { ok: false, error: auth.error });
      const lines = Array.isArray(body.lines) ? body.lines : [];
      const now = new Date().toISOString();
      for (const l of lines) {
        storeLog({
          ts: now, device: body.device || 'unknown', chipId: auth.chipId, version: body.version || '',
          seq: l.seq ?? null, ms: l.ms ?? null, level: l.level || 'I', msg: String(l.msg ?? ''),
        });
      }
      return sendJson(res, 200, { ok: true, stored: lines.length });
    }

    // Public read-only: the admin page shows recent logs without a token.
    if (req.method === 'GET' && p === '/api/logs') {
      const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '100', 10) || 100, 1), MAX_LOGS);
      return sendJson(res, 200, { logs: logs.slice(-limit) });
    }

    // Public read-only: the admin page shows devices without a token.
    if (req.method === 'GET' && p === '/api/devices') {
      return sendJson(res, 200, { devices: publicDevices(), paired: paired || null });
    }

    // Unpair the device (admin only): clears data/devices.json and drops
    // the live link, so the NEXT chip ID that connects pairs instead.
    // Power the old device off first, otherwise it re-pairs on reconnect.
    if (req.method === 'POST' && p === '/api/devices/unpair') {
      if (!adminOk(req, url)) return sendJson(res, 401, { ok: false, error: 'bad admin token' });
      const old = paired;
      clearPairing();
      for (const d of devices.values()) {
        try { d.ws.close(4004, 'unpaired by admin'); } catch (e) {}
      }
      devices.clear();
      console.log(`[pair] unpaired ${old ? old.chipId : '(none)'} - pairing is open again`);
      return sendJson(res, 200, { ok: true, unpaired: old || null });
    }

    // AP MODE V2 handshake captures.
    // Device upload: POST /api/captures, raw bytes,
    // X-Device-Id: <chipId>, X-Filename: <name.pcap | name.hc22000>.
    // Same pairing check as /logs — first chip ID pairs, afterwards
    // only the paired chip ID may upload. Overwrites a same-named file.
    if (req.method === 'POST' && p === '/api/captures') {
      const auth = authorizeDevice(req.headers['x-device-id'] || '');
      if (!auth.ok) return sendJson(res, 401, { ok: false, error: auth.error });
      const name = validCaptureName(req.headers['x-filename'] || '');
      if (!name) return sendJson(res, 400, { ok: false, error: 'invalid filename (basename only, .pcap or .hc22000)' });
      const len = parseInt(req.headers['content-length'] || '0', 10);
      if (len > MAX_CAPTURE_SIZE) return sendJson(res, 413, { ok: false, error: 'file too large (max 512 KB)' });
      let buf;
      try { buf = await readRawBody(req, MAX_CAPTURE_SIZE); }
      catch (e) { return sendJson(res, 413, { ok: false, error: 'file too large (max 512 KB)' }); }
      if (buf.length === 0) return sendJson(res, 400, { ok: false, error: 'empty file' });
      const uploadedAt = new Date().toISOString();
      try {
        fs.mkdirSync(CAPTURES_DIR, { recursive: true });
        fs.writeFileSync(path.join(CAPTURES_DIR, name), buf);
      } catch (e) { return sendJson(res, 500, { ok: false, error: 'could not store capture: ' + e.message }); }
      const rec = { name, size: buf.length, chipId: auth.chipId, uploadedAt };
      captureMeta.set(name, { chipId: auth.chipId, uploadedAt });
      const devName = (paired && paired.device) ? paired.device : 'esp-router';
      storeLog({ ts: uploadedAt, device: devName, chipId: auth.chipId, version: '', seq: null, ms: null, level: 'I', msg: `[capture] ${name} (${buf.length} bytes) uploaded` });
      broadcastControl({ type: 'capture', capture: rec });
      console.log(`[capture] ${name} (${buf.length} bytes) from chip ${auth.chipId}`);
      return sendJson(res, 200, { ok: true, name, size: buf.length, uploadedAt });
    }

    // Admin list (reads the directory, so it survives restarts).
    if (req.method === 'GET' && p === '/api/captures') {
      if (!adminOk(req, url)) return sendJson(res, 401, { ok: false, error: 'bad admin token' });
      return sendJson(res, 200, { captures: listCaptures() });
    }

    // Admin download / delete of one capture.
    if ((req.method === 'GET' || req.method === 'DELETE') && p.startsWith('/api/captures/')) {
      if (!adminOk(req, url)) return sendJson(res, 401, { ok: false, error: 'bad admin token' });
      let name = '';
      try { name = validCaptureName(decodeURIComponent(p.slice('/api/captures/'.length))); } catch (e) { name = ''; }
      if (!name) return sendJson(res, 400, { ok: false, error: 'invalid capture name' });
      const file = path.join(CAPTURES_DIR, name);
      if (req.method === 'DELETE') {
        try { fs.unlinkSync(file); } catch (e) { return sendJson(res, 404, { ok: false, error: 'capture not found' }); }
        captureMeta.delete(name);
        console.log(`[capture] deleted ${name}`);
        return sendJson(res, 200, { ok: true });
      }
      let st;
      try { st = fs.statSync(file); } catch (e) { return sendJson(res, 404, { ok: false, error: 'capture not found' }); }
      if (!st.isFile()) return sendJson(res, 404, { ok: false, error: 'capture not found' });
      const ext = path.extname(name).toLowerCase();
      res.writeHead(200, {
        'Content-Type': ext === '.hc22000' ? 'text/plain; charset=utf-8' : 'application/vnd.tcpdump.pcap',
        'Content-Length': st.size,
        'Content-Disposition': `attachment; filename="${name}"`,
      });
      return fs.createReadStream(file).pipe(res);
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
  apmode_scan: 'apmode_scan',
  apmode_start: 'apmode_start',
  apmode_stop: 'apmode_stop',
  apmode_status: 'apmode_status',
  apmode_captures: 'apmode_captures',
  apmode_delete: 'apmode_delete',
  apmode_delete_all: 'apmode_delete_all',
  deauth_start: 'deauth_start',
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
      // First message must be the hello with the device chip ID.
      // First chip ID ever seen auto-pairs; afterwards only that chip
      // ID is accepted (see authorizeDevice above).
      if (msg.type !== 'hello') {
        try { ws.send(JSON.stringify({ type: 'auth', ok: false, error: 'first message must be hello' })); } catch (e) {}
        ws.close(4003, 'no hello');
        return;
      }
      const auth = authorizeDevice(msg.chipId);
      if (!auth.ok) {
        try { ws.send(JSON.stringify({ type: 'auth', ok: false, error: auth.error })); } catch (e) {}
        ws.close(4003, 'unknown device');
        return;
      }
      clearTimeout(helloTimer);
      device = {
        name: String(msg.device || 'unknown'), chipId: auth.chipId, board: String(msg.board || ''),
        version: String(msg.version || ''), ip, lastSeen: Date.now(), ws, stats: null,
      };
      if (paired) { paired.device = device.name; savePairing(); }
      devices.set(device.name, device);
      ws.send(JSON.stringify({ type: 'auth', ok: true }));
      console.log(`[device] ${device.name} (chip ${device.chipId}, ${device.board} ${device.version}) online from ${ip}`);
      broadcastControl({ type: 'device', device: device.name, chipId: device.chipId, online: true, board: device.board, version: device.version });
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
