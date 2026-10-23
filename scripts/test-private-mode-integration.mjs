import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadDeviceRegistry } from '../router/devices.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'computer-connector-private-'));
const tokenA = 'a'.repeat(40);
const tokenB = 'b'.repeat(40);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const trace = (...values) => { if (process.env.CC_TEST_TRACE === '1') console.log('[TRACE]', ...values); };

function deviceConfig(devices) {
  return JSON.stringify({ defaultDeviceId: 'device-a', devices }, null, 2);
}

function toolsForWorker() {
  return [
    'ping',
    'start_process',
    'read_process_output',
    'interact_with_process',
    'force_terminate',
    'kill_process',
    'start_search',
    'get_more_search_results',
    'stop_search',
  ].map((name) => ({
    name,
    description: `Test-only ${name} tool.`,
    inputSchema: { type: 'object', properties: {}, additionalProperties: true },
  }));
}

function respondToTool(deviceId, label, name, args = {}) {
  if (name === 'ping') {
    return { content: [{ type: 'text', text: `pong from ${deviceId}/${label}` }] };
  }
  if (name === 'start_process') {
    return { content: [{ type: 'text', text: `Process started with PID ${args.pid || 4242} (shell: test)\nInitial output:\nready` }] };
  }
  if (name === 'start_search') {
    return { content: [{ type: 'text', text: `Started content search session: search_shared_1\nPattern: "${args.pattern || 'test'}"` }] };
  }
  if (['interact_with_process', 'read_process_output', 'force_terminate', 'kill_process'].includes(name)) {
    return { content: [{ type: 'text', text: `${name} on ${deviceId}/${label} pid ${args.pid}` }] };
  }
  if (['get_more_search_results', 'stop_search'].includes(name)) {
    return { content: [{ type: 'text', text: `${name} on ${deviceId}/${label} ${args.sessionId}` }] };
  }
  return { content: [{ type: 'text', text: `handled ${name} on ${deviceId}/${label}` }] };
}

function connectLogicalWorker({ host, port, deviceId, token, label }) {
  const socket = net.createConnection({ host, port });
  const calls = [];
  let buffer = '';
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  socket.on('error', rejectReady);
  socket.on('close', () => rejectReady(new Error(`Worker ${label} closed before ready.`)));
  socket.setTimeout(10_000, () => socket.destroy(new Error('Fake worker timed out.')));
  socket.on('connect', () => {
    socket.write(JSON.stringify({ type: 'hello', deviceId, name: label, token }) + '\n');
  });
  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const frame = JSON.parse(line);
      if (frame.type === 'ping') {
        socket.write(JSON.stringify({ type: 'pong' }) + '\n');
        continue;
      }
      if (frame.type === 'hello_ack') {
        socket.setTimeout(0);
        resolveReady(frame);
        continue;
      }
      if (frame.type !== 'request') continue;
      const payload = frame.payload || {};
      if (payload.method === 'initialize') {
        calls.push({ name: 'initialize', args: payload.params || {} });
        socket.write(JSON.stringify({
          type: 'response',
          requestId: frame.requestId,
          message: {
            jsonrpc: '2.0',
            id: payload.id,
            result: {
              protocolVersion: '2025-06-18',
              capabilities: { tools: {} },
              serverInfo: { name: `fake-${deviceId}`, version: '1.0.0' },
            },
          },
        }) + '\n');
        continue;
      }
      if (payload.method === 'tools/list') {
        calls.push({ name: 'tools/list', args: {} });
        socket.write(JSON.stringify({
          type: 'response',
          requestId: frame.requestId,
          message: { jsonrpc: '2.0', id: payload.id, result: { tools: toolsForWorker() } },
        }) + '\n');
        continue;
      }
      if (payload.method !== 'tools/call') continue;
      const name = payload.params?.name;
      const args = payload.params?.arguments || {};
      calls.push({ name, args });
      socket.write(JSON.stringify({
        type: 'response',
        requestId: frame.requestId,
        message: {
          jsonrpc: '2.0',
          id: payload.id,
          result: respondToTool(deviceId, label, name, args),
        },
      }) + '\n');
    }
  });
  return { deviceId, label, socket, calls, ready };
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitUntil(predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await sleep(20);
  }
  throw new Error('Timed out waiting for private controller state.');
}

function resultText(result) {
  return result.content.filter((item) => item.type === 'text').map((item) => item.text).join('\n');
}

function deviceStatus(result) {
  return JSON.parse(resultText(result)).devices;
}

function readMcpResponse(text) {
  const data = text.split(/\r?\n/u).filter((line) => line.startsWith('data:'));
  if (data.length) return JSON.parse(data[data.length - 1].slice(5).trim());
  return JSON.parse(text);
}

async function postMcp(baseUrl, state, method, params, id) {
  trace('mcp:start', method, params?.name || '');
  const headers = {
    accept: 'application/json, text/event-stream',
    'content-type': 'application/json',
  };
  if (state.sessionId) headers['mcp-session-id'] = state.sessionId;
  const response = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', ...(method.startsWith('notifications/') ? {} : { id: id ?? ++state.requestId }), method, params }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = await response.text();
  trace('mcp:response', method, response.status, body.slice(0, 160));
  if (method === 'initialize') state.sessionId = response.headers.get('mcp-session-id');
  if (method.startsWith('notifications/')) {
    assert.equal(response.status, 202);
    return null;
  }
  assert.equal(response.status, 200, `${method} returned HTTP ${response.status}: ${body}`);
  assert.ok(state.sessionId, 'MCP initialize must return a session ID.');
  return readMcpResponse(body);
}

async function mcpInitializeAndList(baseUrl) {
  const state = { sessionId: null, requestId: 0 };
  const initialized = await postMcp(baseUrl, state, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'computer-connector-integration-test', version: '1.0.0' },
  }, ++state.requestId);
  assert.equal(initialized.result?.serverInfo?.title, 'Computer Connector');
  await postMcp(baseUrl, state, 'notifications/initialized', {}, ++state.requestId);
  const listed = await postMcp(baseUrl, state, 'tools/list', {}, ++state.requestId);
  assert.ok(Array.isArray(listed.result?.tools));
  return { state, tools: listed.result.tools };
}

async function callTool(baseUrl, state, name, args, hostSession, requestId) {
  const params = { name, arguments: args };
  if (hostSession) params._meta = { 'openai/session': hostSession };
  const response = await postMcp(baseUrl, state, 'tools/call', params, requestId);
  return response.result;
}

async function main() {
  const devicesDir = path.join(tempRoot, 'config');
  fs.mkdirSync(devicesDir, { recursive: true });
  fs.writeFileSync(path.join(devicesDir, 'devices.json'), deviceConfig([
    { deviceId: 'device-a', name: 'Logical A', enabled: true, local: true, token: tokenA },
    { deviceId: 'device-b', name: 'Logical B', enabled: true, local: true, token: tokenB },
  ]));

  const duplicateRoot = path.join(tempRoot, 'duplicate-registry');
  fs.mkdirSync(path.join(duplicateRoot, 'config'), { recursive: true });
  fs.writeFileSync(path.join(duplicateRoot, 'config', 'devices.json'), deviceConfig([
    { deviceId: 'same-id', local: true, token: tokenA },
    { deviceId: 'same-id', local: true, token: tokenB },
  ]));
  assert.throws(() => loadDeviceRegistry(duplicateRoot), /Duplicate deviceId/u);

  const remoteRegistryRoot = path.join(tempRoot, 'remote-registry');
  fs.mkdirSync(path.join(remoteRegistryRoot, 'config'), { recursive: true });
  fs.writeFileSync(path.join(remoteRegistryRoot, 'config', 'devices.json'), JSON.stringify({
    defaultDeviceId: 'remote-good',
    devices: [{
      deviceId: 'remote-good', enabled: true, local: false,
      token: 'c'.repeat(40), allowedIps: ['127.0.0.1'],
    }],
  }));
  const remoteRegistry = loadDeviceRegistry(remoteRegistryRoot);
  assert.deepEqual([...remoteRegistry.get('remote-good').allowedIps], ['127.0.0.1']);

  const legacyRegistryRoot = path.join(tempRoot, 'legacy-remote-registry');
  fs.mkdirSync(path.join(legacyRegistryRoot, 'config'), { recursive: true });
  fs.writeFileSync(path.join(legacyRegistryRoot, 'config', 'devices.json'), JSON.stringify({
    defaultDeviceId: 'legacy-remote',
    devices: [{
      deviceId: 'legacy-remote', enabled: true, local: false,
      token: 'd'.repeat(40), tailscaleIp: '100.64.0.2',
    }],
  }));
  const legacyRegistry = loadDeviceRegistry(legacyRegistryRoot);
  assert.deepEqual([...legacyRegistry.get('legacy-remote').allowedIps], ['100.64.0.2']);

  const invalidRemoteRoot = path.join(tempRoot, 'invalid-remote-registry');
  fs.mkdirSync(path.join(invalidRemoteRoot, 'config'), { recursive: true });
  fs.writeFileSync(path.join(invalidRemoteRoot, 'config', 'devices.json'), JSON.stringify({
    defaultDeviceId: 'invalid-remote',
    devices: [{
      deviceId: 'invalid-remote', enabled: true, local: false,
      allowedIps: ['127.0.0.1'],
    }],
  }));
  assert.throws(() => loadDeviceRegistry(invalidRemoteRoot), /token must be 32-512/u);

  const routerPort = await freePort();
  const workerPort = await freePort();
  fs.writeFileSync(path.join(devicesDir, 'approval-policy.json'), JSON.stringify({
    version: 1, mode: 'off', revision: 0,
  }));
  const controller = spawn(process.execPath, [path.join(rootDir, 'router', 'server.mjs')], {
    cwd: tempRoot,
    env: {
      ...process.env,
      WC_ROUTER_HOST: '127.0.0.1',
      WC_ROUTER_PORT: String(routerPort),
      WC_WORKER_HOST: '127.0.0.1',
      WC_WORKER_PORT: String(workerPort),
      WC_WORKER_REMOTE_HOST: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let controllerOutput = '';
  controller.on('error', (error) => { controllerOutput += String(error); });
  controller.stdout.setEncoding('utf8').on('data', (chunk) => { controllerOutput += chunk; });
  controller.stderr.setEncoding('utf8').on('data', (chunk) => { controllerOutput += chunk; });
  const workers = [];
  let initialized;
  const baseUrl = `http://127.0.0.1:${routerPort}`;
  try {
    await waitUntil(async () => {
      try {
        const response = await fetch(`${baseUrl}/health`);
        return response.ok;
      } catch { return false; }
    });
    const workerA = connectLogicalWorker({
      host: '127.0.0.1', port: workerPort, deviceId: 'device-a', token: tokenA, label: 'a-1',
    });
    workers.push(workerA);
    await workerA.ready;
    const workerB = connectLogicalWorker({
      host: '127.0.0.1', port: workerPort, deviceId: 'device-b', token: tokenB, label: 'b-1',
    });
    workers.push(workerB);
    await workerB.ready;

    initialized = await mcpInitializeAndList(baseUrl);
    const pingTool = initialized.tools.find((tool) => tool.name === 'ping');
    assert.ok(pingTool);
    assert.ok(pingTool.inputSchema.required.includes('deviceId'));

    const devices = await callTool(baseUrl, initialized.state, 'list_devices', {}, null, 10);
    assert.notEqual(devices.isError, true);
    assert.deepEqual(deviceStatus(devices).map((device) => device.deviceId), ['device-a', 'device-b']);
    assert.ok(deviceStatus(devices).every((device) => device.online));

    const pingA = await callTool(baseUrl, initialized.state, 'ping', { deviceId: 'device-a' }, null, 11);
    const pingB = await callTool(baseUrl, initialized.state, 'ping', { deviceId: 'device-b' }, null, 12);
    assert.match(pingA.content[0].text, /device-a\/a-1/u);
    assert.match(pingB.content[0].text, /device-b\/b-1/u);
    assert.equal((await callTool(baseUrl, initialized.state, 'ping', {}, null, 13)).isError, true);
    assert.match(resultText(await callTool(baseUrl, initialized.state, 'ping', { deviceId: 'missing-device' }, null, 14)), /Unknown or disabled deviceId/u);

    const processA = await callTool(baseUrl, initialized.state, 'start_process', {
      deviceId: 'device-a', command: 'safe-test', timeout_ms: 100,
    }, 'conversation-a', 15);
    assert.equal(processA.isError, undefined);
    const processB = await callTool(baseUrl, initialized.state, 'start_process', {
      deviceId: 'device-b', command: 'safe-test', timeout_ms: 100,
    }, 'conversation-b', 16);
    assert.equal(processB.isError, undefined);

    const bCallsBeforeWrongProcess = workerB.calls.filter((call) => call.name === 'interact_with_process').length;
    const wrongProcessDevice = await callTool(baseUrl, initialized.state, 'interact_with_process', {
      deviceId: 'device-b', pid: 4242, input: 'continue',
    }, 'conversation-a', 17);
    assert.equal(wrongProcessDevice.isError, true);
    assert.match(resultText(wrongProcessDevice), /belongs to device device-a/u);
    assert.equal(workerB.calls.filter((call) => call.name === 'interact_with_process').length, bCallsBeforeWrongProcess);
    const correctProcessDevice = await callTool(baseUrl, initialized.state, 'interact_with_process', {
      deviceId: 'device-a', pid: 4242, input: 'continue',
    }, 'conversation-a', 18);
    assert.match(correctProcessDevice.content[0].text, /device-a\/a-1/u);
    const correctSecondProcessDevice = await callTool(baseUrl, initialized.state, 'interact_with_process', {
      deviceId: 'device-b', pid: 4242, input: 'continue',
    }, 'conversation-b', 19);
    assert.match(correctSecondProcessDevice.content[0].text, /device-b\/b-1/u);

    const searchA = await callTool(baseUrl, initialized.state, 'start_search', {
      deviceId: 'device-a', path: '/tmp', pattern: 'needle', searchType: 'content',
    }, 'conversation-a', 20);
    assert.equal(searchA.isError, undefined);
    const searchesBeforeMismatch = workerB.calls.length;
    const wrongSearchDevice = await callTool(baseUrl, initialized.state, 'get_more_search_results', {
      deviceId: 'device-b', sessionId: 'search_shared_1',
    }, 'conversation-a', 21);
    assert.equal(wrongSearchDevice.isError, true);
    assert.match(resultText(wrongSearchDevice), /belongs to device device-a/u);
    assert.equal(workerB.calls.length, searchesBeforeMismatch);

    const searchB = await callTool(baseUrl, initialized.state, 'start_search', {
      deviceId: 'device-b', path: '/tmp', pattern: 'needle',
    }, 'conversation-b');
    assert.notEqual(searchB.isError, true);
    for (const [deviceId, hostSession, expected] of [
      ['device-a', 'conversation-a', /device-a\/a-1/u],
      ['device-b', 'conversation-b', /device-b\/b-1/u],
    ]) {
      const result = await callTool(baseUrl, initialized.state, 'get_more_search_results', {
        deviceId, sessionId: 'search_shared_1',
      }, hostSession);
      assert.notEqual(result.isError, true);
      assert.match(result.content[0].text, expected);
    }
    // Both resources can also be created in one host session: deviceId resolves collisions.
    for (const deviceId of ['device-a', 'device-b']) {
      for (const name of ['start_process', 'start_search']) {
        assert.notEqual((await callTool(baseUrl, initialized.state, name, { deviceId }, 'shared')).isError, true);
      }
    }
    for (const deviceId of ['device-a', 'device-b']) {
      for (const [name, args] of [
        ['read_process_output', { pid: 4242 }],
        ['get_more_search_results', { sessionId: 'search_shared_1' }],
      ]) {
        const result = await callTool(baseUrl, initialized.state, name, { deviceId, ...args }, 'shared');
        assert.notEqual(result.isError, true);
        assert.ok(result.content[0].text.includes(`on ${deviceId}/`));
      }
    }
    const beforeReplacement = workerB.socket;
    const replacedClosed = once(beforeReplacement, 'close');
    const duplicateB = connectLogicalWorker({
      host: '127.0.0.1', port: workerPort, deviceId: 'device-b', token: tokenB, label: 'b-2',
    });
    workers.push(duplicateB);
    await duplicateB.ready;
    await Promise.race([replacedClosed, sleep(10_000).then(() => { throw new Error('Replaced worker did not close.'); })]);
    const duplicatePing = await callTool(baseUrl, initialized.state, 'ping', { deviceId: 'device-b' }, null, 22);
    assert.match(duplicatePing.content[0].text, /device-b\/b-2/u);

    duplicateB.socket.destroy();
    await waitUntil(async () => {
      const current = await callTool(baseUrl, initialized.state, 'list_devices', {}, null, 23);
      return deviceStatus(current).find((device) => device.deviceId === 'device-b')?.online === false;
    });
    const offline = await callTool(baseUrl, initialized.state, 'ping', { deviceId: 'device-b' }, null, 24);
    assert.equal(offline.isError, true);
    assert.match(resultText(offline), /Worker is offline: device-b/u);

    const reconnectedB = connectLogicalWorker({
      host: '127.0.0.1', port: workerPort, deviceId: 'device-b', token: tokenB, label: 'b-3',
    });
    workers.push(reconnectedB);
    await reconnectedB.ready;
    const reconnectPing = await callTool(baseUrl, initialized.state, 'ping', { deviceId: 'device-b' }, null, 25);
    assert.match(reconnectPing.content[0].text, /device-b\/b-3/u);
    const reconnectCalls = reconnectedB.calls.length;
    const reconnectMismatch = await callTool(baseUrl, initialized.state, 'read_process_output', {
      deviceId: 'device-b', pid: 4242,
    }, 'conversation-a');
    assert.equal(reconnectMismatch.isError, true);
    assert.equal(reconnectedB.calls.length, reconnectCalls);
    assert.match((await callTool(baseUrl, initialized.state, 'read_process_output', {
      deviceId: 'device-b', pid: 4242,
    }, 'conversation-b')).content[0].text, /device-b\/b-3/u);
    assert.equal(workerB.calls.filter((call) => call.name === 'ping').length, 1);
    assert.equal(duplicateB.calls.filter((call) => call.name === 'ping').length, 1);

    // Verify the same guards and owner recording through approvals and active grants.
    fs.writeFileSync(path.join(devicesDir, 'approval-policy.json'), JSON.stringify({
      version: 1, mode: 'timed', revision: 1,
    }));
    async function approve(pending, hostSession) {
      const approval_id = pending.structuredContent.approval_id;
      assert.ok(approval_id);
      const card = await callTool(baseUrl, initialized.state, 'request_approval', { approval_id }, hostSession);
      assert.ok(card._meta?.approval_nonce);
      return callTool(baseUrl, initialized.state, 'resolve_pending_action', {
        approval_id, approval_nonce: card._meta.approval_nonce, decision: 'approve',
      }, hostSession);
    }
    const pendingStart = await callTool(baseUrl, initialized.state, 'start_process', {
      deviceId: 'device-a',
    }, 'approved-a');
    const approvedStart = await approve(pendingStart, 'approval-ui');
    assert.equal(approvedStart.structuredContent.action_state, 'consumed');
    const approval_id = pendingStart.structuredContent.approval_id;
    const beforeGrantMismatch = reconnectedB.calls.length;
    assert.equal((await callTool(baseUrl, initialized.state, 'read_process_output', {
      deviceId: 'device-b', pid: 4242, approval_id,
    }, 'approved-a')).isError, true);
    assert.equal(reconnectedB.calls.length, beforeGrantMismatch);
    const grantSearch = await callTool(baseUrl, initialized.state, 'start_search', {
      deviceId: 'device-a', approval_id,
    }, 'grant-search');
    assert.notEqual(grantSearch.isError, true);
    assert.equal((await callTool(baseUrl, initialized.state, 'stop_search', {
      deviceId: 'device-b', sessionId: 'search_shared_1', approval_id,
    }, 'grant-search')).isError, true);
    // Ownership can become known after freezing but before the approved dispatch.
    const pendingFollowUp = await callTool(baseUrl, initialized.state, 'read_process_output', {
      deviceId: 'device-b', pid: 9999,
    }, 'late-owner');
    assert.notEqual((await callTool(baseUrl, initialized.state, 'start_process', {
      deviceId: 'device-a', pid: 9999, approval_id,
    }, 'late-owner')).isError, true);
    const beforeApprovedMismatch = reconnectedB.calls.length;
    const blockedApproved = await approve(pendingFollowUp, 'different-ui-session');
    assert.match(blockedApproved.structuredContent.output, /belongs to device device-a/u);
    assert.equal(reconnectedB.calls.length, beforeApprovedMismatch);

    const malformed = net.createConnection({ host: '127.0.0.1', port: workerPort });
    malformed.on('error', () => {});
    await once(malformed, 'connect');
    const malformedClosed = once(malformed, 'close');
    malformed.write('{invalid-json\n');
    await Promise.race([malformedClosed, sleep(10_000).then(() => { throw new Error('Malformed worker did not close.'); })]);
    assert.match((await callTool(baseUrl, initialized.state, 'ping', { deviceId: 'device-a', approval_id })).content[0].text, /device-a\/a-1/u);
    assert.match((await callTool(baseUrl, initialized.state, 'ping', { deviceId: 'device-b', approval_id })).content[0].text, /device-b\/b-3/u);

    console.log('Computer Connector private-mode integration: PASS');
    console.log('mcp_initialize_and_tools_list=PASS');
    console.log('list_devices_and_ping=PASS');
    console.log('two_device_explicit_routing=PASS');
    console.log('unknown_offline_duplicate_reconnect_malformed=PASS');
    console.log('process_search_device_affinity=PASS');
  } catch (error) {
    const detail = error instanceof Error ? (error.stack || error.message) : String(error);
    throw new Error(detail + '\nRouter output:\n' + controllerOutput, { cause: error });
  } finally {
    if (initialized?.state?.sessionId) {
      await fetch(`${baseUrl}/mcp`, {
        method: 'DELETE',
        headers: { 'mcp-session-id': initialized.state.sessionId },
        signal: AbortSignal.timeout(2000),
      }).catch(() => {});
    }
    for (const worker of workers) worker.socket.destroy();
    if (controller.exitCode === null) {
      const exited = once(controller, 'exit').catch(() => null);
      controller.kill('SIGTERM');
      await Promise.race([exited, sleep(5000)]);
      if (controller.exitCode === null && controller.signalCode === null) {
        controller.kill('SIGKILL');
        await exited;
      }
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error('Computer Connector private-mode integration: FAIL');
  console.error(error?.stack || error);
  fs.rmSync(tempRoot, { recursive: true, force: true });
  process.exitCode = 1;
});
