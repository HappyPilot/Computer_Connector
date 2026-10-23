import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import {
  guardDesktopCommanderMessage,
  resolveMaxDcResponseBytes,
  shouldGuardDesktopCommanderResponse,
} from './response-guard.mjs';

function parseEnv(content) {
  const out = {};
  for (const raw of String(content).split(/\r?\n/u)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const index = line.indexOf('=');
    if (index <= 0) continue;
    out[line.slice(0, index).trim()] = line.slice(index + 1).trim();
  }
  return out;
}

function loadEnv() {
  const file = process.argv[2] ? path.resolve(process.argv[2]) : null;
  const fromFile = file && fs.existsSync(file) ? parseEnv(fs.readFileSync(file, 'utf8')) : {};
  return { ...fromFile, ...process.env };
}

const env = loadEnv();
const deviceId = String(env.WC_DEVICE_ID || '').trim();
const deviceName = String(env.WC_DEVICE_NAME || deviceId).trim();
const controllerHost = String(env.WC_CONTROLLER_HOST || '').trim();
const controllerPort = Number(env.WC_CONTROLLER_PORT || 18100);
const workerToken = String(env.WC_WORKER_TOKEN || '');
const dcNode = String(env.WC_DC_NODE || process.execPath);
const dcScript = path.resolve(String(env.WC_DC_SCRIPT || ''));
const reconnectMs = Number(env.WC_RECONNECT_MS || 3000);
const maxDcResponseBytes = resolveMaxDcResponseBytes(env.WC_MAX_DC_RESPONSE_BYTES);

if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(deviceId)) throw new Error('Invalid WC_DEVICE_ID.');
if (!controllerHost) throw new Error('WC_CONTROLLER_HOST is required.');
if (!Number.isInteger(controllerPort) || controllerPort < 1 || controllerPort > 65535) throw new Error('Invalid WC_CONTROLLER_PORT.');
if (workerToken.length < 32 || workerToken.length > 512) throw new Error('WC_WORKER_TOKEN must be 32-512 characters.');
if (!dcScript || !fs.existsSync(dcScript)) throw new Error('WC_DC_SCRIPT was not found: ' + dcScript);

let child = null;
let socket = null;
let connected = false;
let stopping = false;
let inputBuffer = '';
let dcGeneration = 0;
let lastDcResponseAt = null;
const pendingByRpcId = new Map();
let nextWorkerRpcSequence = 0;
const CONTROL_RPC_TIMEOUT_MS = 10000;

function rpcKey(id) {
  return typeof id + ':' + JSON.stringify(id);
}

function allocateWorkerRpcId() {
  nextWorkerRpcSequence += 1;
  return `wc-worker-${process.pid}-${nextWorkerRpcSequence}`;
}

function writeFrame(value) {
  if (socket && !socket.destroyed) socket.write(JSON.stringify(value) + '\n');
}
function startDesktopCommander() {
  dcGeneration += 1;
  child = spawn(dcNode, [dcScript], {
    cwd: path.dirname(dcScript),
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, DESKTOP_COMMANDER_DISABLE_TELEMETRY: '1' },
  });
  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on('line', (line) => {
    const text = String(line || '').trim();
    if (!text) return;
    let message;
    try { message = JSON.parse(text); }
    catch { return; }
    if (message?.id === undefined || message?.id === null) return;
    const key = rpcKey(message.id);
    const pending = pendingByRpcId.get(key);
    if (!pending) return;
    lastDcResponseAt = Date.now();
    if (pending.timer) clearTimeout(pending.timer);
    if (shouldGuardDesktopCommanderResponse(pending.method)) {
      message = guardDesktopCommanderMessage(message, Buffer.byteLength(text, 'utf8'), maxDcResponseBytes);
    }
    pendingByRpcId.delete(key);
    writeFrame({
      type: 'response',
      requestId: pending.requestId,
      message: { ...message, id: pending.originalRpcId },
    });
  });
  lines.on('close', () => {
    if (!stopping && child && child.exitCode === null && child.signalCode === null) {
      try { child.kill(); } catch {}
    }
  });
  child.stderr.on('data', (chunk) => process.stderr.write('[desktop-commander] ' + chunk.toString('utf8')));
  child.on('exit', () => {
    for (const pending of pendingByRpcId.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      writeFrame({ type: 'response', requestId: pending.requestId, error: 'Desktop Commander exited.' });
    }
    pendingByRpcId.clear();
    lastDcResponseAt = null;
    if (!stopping) {
      try { socket?.destroy(); } catch {}
      setTimeout(startDesktopCommander, 2000);
    }
  });
}
function sendToDesktopCommander(frame) {
  if (!child || child.killed || !child.stdin.writable) {
    if (frame?.type === 'request') {
      writeFrame({ type: 'response', requestId: frame.requestId, error: 'Desktop Commander is unavailable.' });
    }
    return;
  }
  const payload = frame?.payload;
  if (!payload || typeof payload !== 'object') return;
  let outbound = payload;
  if (frame.type === 'request') {
    if (payload.id === undefined || payload.id === null) {
      writeFrame({ type: 'response', requestId: frame.requestId, error: 'Worker requests require a JSON-RPC id.' });
      return;
    }
    const workerRpcId = allocateWorkerRpcId();
    const method = String(payload.method || '');
    const key = rpcKey(workerRpcId);
    const pending = {
      requestId: frame.requestId,
      originalRpcId: payload.id,
      method,
      timer: null,
    };
    if (method === 'initialize' || method === 'tools/list') {
      pending.timer = setTimeout(() => {
        if (pendingByRpcId.get(key) !== pending) return;
        pendingByRpcId.delete(key);
        writeFrame({ type: 'response', requestId: frame.requestId, error: 'Desktop Commander control RPC timed out.' });
        try { child?.kill(); } catch {}
      }, CONTROL_RPC_TIMEOUT_MS);
    }
    pendingByRpcId.set(key, pending);
    outbound = { ...payload, id: workerRpcId };
  }
  child.stdin.write(JSON.stringify(outbound) + '\n');
}

function handleControllerFrame(frame) {
  if (frame?.type === 'hello_ack') {
    connected = true;
    console.log('Connected to controller as ' + deviceId + '.');
    return;
  }
  if (frame?.type === 'ping') {
    writeFrame({
      type: 'pong',
      at: Date.now(),
      dcGeneration,
      dcAlive: Boolean(child && child.exitCode === null && child.signalCode === null),
      lastDcResponseAt,
      pendingCount: pendingByRpcId.size,
    });
    return;
  }
  if (frame?.type === 'request' || frame?.type === 'notify') {
    sendToDesktopCommander(frame);
  }
}
function connectController() {
  if (stopping) return;
  if (!child || child.exitCode !== null || child.signalCode !== null || !child.stdin?.writable) {
    setTimeout(connectController, Math.max(250, reconnectMs));
    return;
  }
  connected = false;
  inputBuffer = '';
  socket = net.createConnection({ host: controllerHost, port: controllerPort });
  socket.setKeepAlive(true, 15000);
  socket.setNoDelay(true);
  socket.on('connect', () => {
    writeFrame({ type: 'hello', deviceId, name: deviceName, token: workerToken || undefined, version: '1' });
  });
  socket.on('data', (chunk) => {
    inputBuffer += chunk.toString('utf8');
    if (Buffer.byteLength(inputBuffer, 'utf8') > 8 * 1024 * 1024) {
      socket.destroy();
      return;
    }
    let newline;
    while ((newline = inputBuffer.indexOf('\n')) >= 0) {
      const line = inputBuffer.slice(0, newline).trim();
      inputBuffer = inputBuffer.slice(newline + 1);
      if (!line) continue;
      try { handleControllerFrame(JSON.parse(line)); }
      catch { socket.destroy(); return; }
    }
  });
  socket.on('error', () => {});
  socket.on('close', () => {
    if (connected) console.log('Controller connection lost for ' + deviceId + '.');
    connected = false;
    pendingByRpcId.clear();
    socket = null;
    if (!stopping) setTimeout(connectController, reconnectMs);
  });
}
function shutdown() {
  if (stopping) return;
  stopping = true;
  try { socket?.destroy(); } catch {}
  try { child?.kill(); } catch {}
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('uncaughtException', (error) => {
  console.error('Worker fatal error:', error.message);
  process.exitCode = 1;
  shutdown();
});

startDesktopCommander();
connectController();
