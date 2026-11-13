import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseRestartUnits,
  processRestartSignal,
} from './wcm-supervisor-linux.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wcm-linux-supervisor-'));
const stateDir = path.join(root, '.state');
fs.mkdirSync(stateDir);
const requestFile = path.join(stateDir, 'wcm-restart-request.json');
const lastFile = path.join(stateDir, 'wcm-restart-last.json');
let time = 1_800_000_000_000;
let restarts = 0;
const request = {
  version: 1,
  request_id: '12345678-1234-4123-8123-123456789abc',
  created_at_ms: time,
};

assert.deepEqual(
  parseRestartUnits('computer-connector-shared.service,computer-connector-worker@ai5090.service'),
  ['computer-connector-shared.service', 'computer-connector-worker@ai5090.service'],
);
assert.throws(() => parseRestartUnits(''), /1-8/u);
assert.throws(() => parseRestartUnits('good.service;bad'), /1-8/u);
assert.throws(() => parseRestartUnits('ssh.service'), /1-8/u);
assert.deepEqual(
  parseRestartUnits('computer-connector-local-router.service,com.computer-connector-cloud.abc.service'),
  ['computer-connector-local-router.service', 'com.computer-connector-cloud.abc.service'],
);

assert.equal(processRestartSignal({ root }).status, 'idle');
fs.writeFileSync(requestFile, JSON.stringify(request));

let result = processRestartSignal({
  root,
  now: () => time + 1_000,
  restart: () => { restarts += 1; },
});
assert.equal(result.status, 'waiting');
assert.equal(restarts, 0);

time += 4_000;
result = processRestartSignal({
  root,
  now: () => time,
  restart: () => { restarts += 1; },
});
assert.equal(result.status, 'restarted');
assert.equal(restarts, 1);
assert.equal(fs.existsSync(requestFile), false);
assert.equal(JSON.parse(fs.readFileSync(lastFile, 'utf8')).request_id, request.request_id);

fs.writeFileSync(requestFile, JSON.stringify({ ...request, created_at_ms: time - 5_000 }));
result = processRestartSignal({
  root,
  now: () => time,
  restart: () => { restarts += 1; },
});
assert.equal(result.status, 'duplicate');
assert.equal(restarts, 1);

const expired = {
  ...request,
  request_id: 'abcdefab-1234-4123-8123-123456789abc',
  created_at_ms: time - 121_000,
};
fs.writeFileSync(requestFile, JSON.stringify(expired));
result = processRestartSignal({
  root,
  now: () => time,
  restart: () => { restarts += 1; },
});
assert.equal(result.status, 'discarded_expired');
assert.equal(restarts, 1);

const retryable = {
  ...request,
  request_id: 'fedcba98-1234-4123-8123-123456789abc',
  created_at_ms: time - 5_000,
};
fs.writeFileSync(requestFile, JSON.stringify(retryable));
assert.throws(
  () => processRestartSignal({
    root,
    now: () => time,
    restart: () => { throw new Error('restart failed'); },
  }),
  /restart failed/u,
);
assert.equal(fs.existsSync(requestFile), true, 'failed restart keeps request for recovery');
assert.equal(JSON.parse(fs.readFileSync(lastFile, 'utf8')).request_id, request.request_id);

fs.rmSync(root, { recursive: true, force: true });
console.log('WCM Linux supervisor restart tests: PASS');
