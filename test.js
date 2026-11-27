'use strict';
// Local end-to-end test: token-free chip-ID auth.
// Simulates a device on /link and a control client on /ws/control, and
// checks first-connect auto-pairing, unknown-chip rejection, log upload
// and manifest auth, and the admin unpair flow.
// Run with the server already listening on PORT (default 3000) and a
// clean pairing state (rm data/devices.json before starting the server).
const WebSocket = require('ws');
const http = require('http');

const PORT = process.env.PORT || '3000';
const BASE = `ws://127.0.0.1:${PORT}`;
const HTTP_BASE = `http://127.0.0.1:${PORT}`;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'test-admin-token';
const CHIP_A = 'a1b2c3d4e5f6'; // first device: pairs
const CHIP_B = '0123456789ab'; // second device: rejected until unpair

function once(ws, event) {
  return new Promise((resolve, reject) => {
    ws.once(event, resolve);
    ws.once('error', reject);
  });
}
function nextMessage(ws) {
  return new Promise((resolve) => ws.once('message', (d) => resolve(JSON.parse(d.toString()))));
}
function httpReq(path, opts = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(HTTP_BASE + path, { method: opts.method || 'GET', headers: opts.headers || {} }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // --- manifest without chip ID must be rejected ---
  let r = await httpReq('/ota/manifest.json');
  console.log('manifest no chip:', r.status);
  if (r.status !== 401) throw new Error('manifest without chip id should be 401');

  // --- first device pairs via hello ---
  const device = new WebSocket(`${BASE}/link`);
  await once(device, 'open');
  device.send(JSON.stringify({ type: 'hello', device: 'esp-router', chipId: CHIP_A, version: '0.3.0', board: 'esp32dev' }));
  const auth = await nextMessage(device);
  console.log('device A auth:', JSON.stringify(auth));
  if (!auth.ok) throw new Error('first device auth failed (should auto-pair)');

  // Device answers any command with a canned result (like the firmware does).
  device.on('message', (data) => {
    const m = JSON.parse(data.toString());
    if (m.type === 'command') {
      device.send(JSON.stringify({ type: 'result', id: m.id, ok: true, state: { uptime: 123, heap: 90000, clients: 2 } }));
    }
  });

  // --- manifest with the paired chip ID works ---
  r = await httpReq('/ota/manifest.json', { headers: { 'X-Device-Id': CHIP_A } });
  console.log('manifest paired chip:', r.status);
  if (r.status !== 200) throw new Error('manifest with paired chip id should be 200');

  // --- log upload with the paired chip ID works, unknown chip fails ---
  r = await httpReq('/logs', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Device-Id': CHIP_A }, body: JSON.stringify({ device: 'esp-router', chipId: CHIP_A, version: '0.3.0', lines: [{ seq: 1, ms: 100, level: 'I', msg: 'test log' }] }) });
  console.log('logs paired chip:', r.status, r.body);
  if (r.status !== 200) throw new Error('log upload with paired chip id should be 200');
  r = await httpReq('/logs', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Device-Id': CHIP_B }, body: JSON.stringify({ device: 'esp-router', chipId: CHIP_B, version: '0.3.0', lines: [] }) });
  console.log('logs unknown chip:', r.status);
  if (r.status !== 401) throw new Error('log upload with unknown chip id should be 401');

  // --- second device (different chip) must be rejected ---
  const bad = new WebSocket(`${BASE}/link`);
  await once(bad, 'open');
  bad.send(JSON.stringify({ type: 'hello', device: 'esp-router-2', chipId: CHIP_B, version: '0.3.0', board: 'esp32dev' }));
  const badAuth = await nextMessage(bad);
  console.log('device B auth:', JSON.stringify(badAuth));
  if (badAuth.ok) throw new Error('unknown chip id was accepted!');

  // --- control client ---
  const control = new WebSocket(`${BASE}/ws/control?token=${encodeURIComponent(ADMIN_TOKEN)}`);
  await once(control, 'open');
  const welcome = await nextMessage(control); // {type:"devices",...}
  console.log('control welcome:', JSON.stringify(welcome).slice(0, 200));
  control.send(JSON.stringify({ id: 't1', device: 'esp-router', command: 'status', params: {} }));
  const reply = await nextMessage(control);
  console.log('control command reply:', JSON.stringify(reply));
  if (!reply.ok || reply.id !== 't1' || !reply.result || reply.result.uptime !== 123) {
    throw new Error('command relay failed');
  }

  // --- offline device ---
  control.send(JSON.stringify({ id: 't2', device: 'no-such-device', command: 'status', params: {} }));
  const offline = await nextMessage(control);
  console.log('offline device reply:', JSON.stringify(offline));
  if (offline.ok) throw new Error('offline device should fail');

  // --- unpair (admin) re-opens pairing; device B can then pair ---
  device.close();
  await sleep(300);
  r = await httpReq('/api/devices/unpair', { method: 'POST', headers: { 'X-Admin-Token': ADMIN_TOKEN } });
  console.log('unpair:', r.status, r.body);
  if (r.status !== 200) throw new Error('unpair should be 200');
  const deviceB = new WebSocket(`${BASE}/link`);
  await once(deviceB, 'open');
  deviceB.send(JSON.stringify({ type: 'hello', device: 'esp-router-2', chipId: CHIP_B, version: '0.3.0', board: 'esp32dev' }));
  const authB = await nextMessage(deviceB);
  console.log('device B auth after unpair:', JSON.stringify(authB));
  if (!authB.ok) throw new Error('device B should pair after unpair');

  deviceB.close(); control.close(); bad.close();
  await sleep(200);
  console.log('WS TESTS PASSED');
  process.exit(0);
})().catch((e) => { console.error('WS TESTS FAILED:', e.message); process.exit(1); });
