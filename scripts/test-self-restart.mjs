import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { RESTART_WCM_TOOL, requestWcmRestart } from '../router/self-restart.mjs';

fs.mkdirSync(path.join(process.cwd(), '.state'), { recursive: true });
const root = fs.mkdtempSync(path.join(process.cwd(), '.state', 'wcm-restart-test-'));
const state = path.join(root, '.state');
fs.mkdirSync(state);
let time = 1_800_000_000_000;
const write = (name, value) => fs.writeFileSync(path.join(state, name), JSON.stringify(value));
const call = (args = {}) => requestWcmRestart({ root, args, now: () => time,
  processAlive: (pid) => pid === 2345 });

try {
  assert.equal(RESTART_WCM_TOOL.name, 'restart_wcm');
  assert.deepEqual(RESTART_WCM_TOOL.inputSchema, {
    type: 'object', properties: {}, additionalProperties: false,
  });
  assert.throws(() => call(), /Supervisor is not ready/u);
  fs.writeFileSync(path.join(state, 'rdc-supervisor.pid'), '2345');
  write('wcm-supervisor-heartbeat.json', { supervisor_pid: 2345, timestamp_ms: time });
  assert.throws(() => call({ command: 'anything' }), /no arguments/u);
  assert.throws(() => call({ approval_id: 'x' }), /no arguments/u);
  assert.throws(() => call({ deviceId: 'remote-worker' }), /no arguments/u);
  assert.throws(() => call([]), /no arguments/u);
  const first = call();
  assert.equal(first.status, 'accepted');
  assert.ok(first.request_id);
  const pending = JSON.parse(fs.readFileSync(path.join(state, 'wcm-restart-request.json')));
  assert.equal(pending.request_id, first.request_id);
  assert.equal(call().status, 'already_pending');
  time += 5_000;
  write('wcm-restart-last.json', { version: 1, request_id: first.request_id, processed_at_ms: time });
  fs.unlinkSync(path.join(state, 'wcm-restart-request.json'));
  write('wcm-supervisor-heartbeat.json', { supervisor_pid: 2345, timestamp_ms: time });
  assert.equal(call().status, 'cooldown');
  time += 60_000;
  write('wcm-supervisor-heartbeat.json', { supervisor_pid: 2345, timestamp_ms: time });
  assert.equal(call().status, 'accepted');
  time += 11_000;
  assert.throws(() => call(), /Supervisor is not ready/u);
  write('wcm-supervisor-heartbeat.json', { supervisor_pid: 9999, timestamp_ms: time });
  assert.throws(() => call(), /Supervisor is not ready/u);
  write('wcm-supervisor-heartbeat.json', { supervisor_pid: 2345, timestamp_ms: time });
  fs.writeFileSync(path.join(state, 'wcm-restart-request.json'), '{invalid');
  assert.throws(() => call(), /Invalid WCM restart state/u);
  console.log('WCM Router-local supervised restart contract: PASS');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
