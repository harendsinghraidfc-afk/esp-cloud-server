'use strict';
// Local end-to-end test: simulates a device on /link and a control client
// on /ws/control, and checks the command relay works.
// Run with the server already listening on PORT (default 3000).
const WebSocket = require('ws');

const PORT = process.env.PORT || '3000';
const BASE = `ws://127.0.0.1:${PORT}`;
const DEVICE_TOKEN = process.env.DEVICE_TOKEN || 'esp-router-dev-token';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'admin-secret';

function once(ws, event) {
  return new Promise((resolve, reject) => {
    ws.once(event, resolve);
    ws.once('error', reject);
  });
}
function nextMessage(ws) {
  return new Promise((resolve) => ws.once('message', (d) => resolve(JSON.parse(d.toString()))));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // --- fake device ---
  const device = new WebSocket(`${BASE}/link`);
  await once(device, 'open');
  device.send(JSON.stringify({ type: 'hello', device: 'esp-router', version: '0.3.0', board: 'esp32dev', token: DEVICE_TOKEN }));
  const auth = await nextMessage(device);
  console.log('device auth:', JSON.stringify(auth));
  if (!auth.ok) throw new Error('device auth failed');

  // Device answers any command with a canned result (like the firmware does).
  device.on('message', (data) => {
    const m = JSON.parse(data.toString());
    if (m.type === 'command') {
      device.send(JSON.stringify({ type: 'result', id: m.id, ok: true, state: { uptime: 123, heap: 90000, clients: 2 } }));
    }
  });

  // --- bad-token device must be rejected ---
  const bad = new WebSocket(`${BASE}/link`);
  await once(bad, 'open');
  bad.send(JSON.stringify({ type: 'hello', device: 'esp-router', version: '0.3.0', board: 'esp32dev', token: 'wrong' }));
  const badAuth = await nextMessage(bad);
  console.log('bad-token auth:', JSON.stringify(badAuth));
  if (badAuth.ok) throw new Error('bad token was accepted!');

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

  device.close(); control.close(); bad.close();
  await sleep(200);
  console.log('WS TESTS PASSED');
  process.exit(0);
})().catch((e) => { console.error('WS TESTS FAILED:', e.message); process.exit(1); });
