import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const agentPath = path.join(rootDir, 'worker', 'agent.mjs');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-worker-recovery-'));
const token = 'r'.repeat(40);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fakeDesktopCommanderSource() {
  return `
import readline from 'node:readline';
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', (line) => {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  if (request.method === 'notifications/initialized') return;
  if (request.method === 'initialize') {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0', id: request.id,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'fake-dc', version: '1.0.0' },
      },
    }) + '\\n');
    return;
  }
  if (request.method === 'tools/list') {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0', id: request.id,
      result: {
        tools: [{
          name: 'crash_test',
          description: 'test tool',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        }],
      },
    }) + '\\n');
    return;
  }
  if (request.method === 'tools/call' && request.params?.name === 'crash_test') {
    process.exit(7);
  }
});
`;
}

function workerConnection(socket) {
  let buffer = '';
  let readyResolve;
  let readyReject;
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const pending = new Map();
  let nextRequest = 0;

  socket.setEncoding('utf8');
  socket.on('error', (error) => readyReject(error));
  socket.on('data', (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const frame = JSON.parse(line);
      if (frame.type === 'hello') {
        assert.equal(frame.deviceId, 'recovery-worker');
        assert.equal(frame.token, token);
        socket.write(JSON.stringify({
          type: 'hello_ack',
          deviceId: frame.deviceId,
          connectionId: 'test-' + Date.now(),
          heartbeatMs: 15000,
        }) + '\n');
        readyResolve();
        continue;
      }
      if (frame.type === 'pong') continue;
      if (frame.type === 'response' && pending.has(frame.requestId)) {
        const { resolve, reject, timer } = pending.get(frame.requestId);
        clearTimeout(timer);
        pending.delete(frame.requestId);
        if (frame.error) reject(new Error(String(frame.error)));
        else resolve(frame.message);
      }
    }
  });

  function request(payload, timeoutMs = 5000) {
    const requestId = 'controller-' + (++nextRequest);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error('Timed out waiting for worker response.'));
      }, timeoutMs);
      pending.set(requestId, { resolve, reject, timer });
      socket.write(JSON.stringify({ type: 'request', requestId, payload }) + '\n');
    });
  }

  function notify(payload) {
    socket.write(JSON.stringify({ type: 'notify', payload }) + '\n');
  }

  return { socket, ready, request, notify };
}

async function initialize(connection) {
  const init = await connection.request({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'worker-recovery-test', version: '1.0.0' },
    },
  });
  assert.equal(init.result?.serverInfo?.name, 'fake-dc');
  connection.notify({
    jsonrpc: '2.0',
    method: 'notifications/initialized',
    params: {},
  });
  const tools = await connection.request({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/list',
    params: {},
  });
  assert.equal(tools.result?.tools?.[0]?.name, 'crash_test');
}

const fakeDc = path.join(tempRoot, 'fake-dc.mjs');
fs.writeFileSync(fakeDc, fakeDesktopCommanderSource(), 'utf8');

const server = net.createServer();
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const port = server.address().port;
const accepted = [];
server.on('connection', (socket) => {
  accepted.push(workerConnection(socket));
});

const envFile = path.join(tempRoot, 'worker.env');
fs.writeFileSync(envFile, [
  'WC_DEVICE_ID=recovery-worker',
  'WC_DEVICE_NAME=Recovery Worker',
  'WC_CONTROLLER_HOST=127.0.0.1',
  `WC_CONTROLLER_PORT=${port}`,
  `WC_WORKER_TOKEN=${token}`,
  `WC_DC_NODE=${process.execPath}`,
  `WC_DC_SCRIPT=${fakeDc}`,
  'WC_RECONNECT_MS=250',
].join('\n') + '\n', { mode: 0o600 });

const agent = spawn(process.execPath, [agentPath, envFile], {
  cwd: path.join(rootDir, 'worker'),
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
agent.stdout.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
agent.stderr.setEncoding('utf8').on('data', (chunk) => { output += chunk; });

try {
  const deadline = Date.now() + 8000;
  while (accepted.length < 1 && Date.now() < deadline) await sleep(20);
  assert.ok(accepted[0], 'first worker connection did not arrive');
  await accepted[0].ready;
  await initialize(accepted[0]);

  const firstClosed = once(accepted[0].socket, 'close');
  const crashRequest = accepted[0].request({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'crash_test', arguments: {} },
  }).catch(() => null);
  await Promise.race([
    firstClosed,
    sleep(6000).then(() => { throw new Error('worker connection did not close after Desktop Commander crash'); }),
  ]);
  await crashRequest;

  const reconnectDeadline = Date.now() + 8000;
  while (accepted.length < 2 && Date.now() < reconnectDeadline) await sleep(20);
  assert.ok(accepted[1], 'worker did not reconnect after Desktop Commander restart');
  await accepted[1].ready;
  await initialize(accepted[1]);

  assert.match(output, /Controller connection lost|Connected to controller/u);
  console.log('Computer Connector worker recovery smoke: PASS');
} finally {
  if (agent.exitCode === null) {
    agent.kill('SIGTERM');
    await Promise.race([once(agent, 'exit'), sleep(3000)]).catch(() => {});
    if (agent.exitCode === null && agent.signalCode === null) agent.kill('SIGKILL');
  }
  for (const connection of accepted) connection.socket.destroy();
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
