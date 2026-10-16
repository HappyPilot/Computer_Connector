import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const HEARTBEAT_MAX_AGE_MS = 10_000;
const RESTART_COOLDOWN_MS = 60_000;
const REQUEST_MAX_AGE_MS = 120_000;

export const RESTART_WCM_TOOL = {
  name: 'restart_wcm',
  description: 'Request a supervised restart of this WCM Controller (Router, local Worker, and OAuth sidecar). This Router-local tool requires no WCM approval_id or deviceId. It takes no arguments and cannot execute arbitrary commands or restart remote workers. The call acknowledges a request, not a completed restart; MCP connections may briefly disconnect.',
  inputSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
};

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/u, ''));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new Error('Invalid WCM restart state: ' + path.basename(file));
  }
}

function validTime(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function validId(value) {
  return typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(value);
}

function defaultProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function requestWcmRestart({
  root = process.cwd(),
  args = {},
  now = Date.now,
  processAlive = defaultProcessAlive,
  audit = () => {},
} = {}) {
  if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length) {
    throw new Error('restart_wcm accepts no arguments.');
  }
  const stateDir = path.join(root, '.state');
  const heartbeat = readJson(path.join(stateDir, 'wcm-supervisor-heartbeat.json'));
  const pidFile = path.join(stateDir, 'rdc-supervisor.pid');
  let expectedPid = null;
  try { expectedPid = Number(fs.readFileSync(pidFile, 'utf8').trim()); }
  catch (error) { if (error?.code !== 'ENOENT') throw error; }
  const time = now();
  if (!heartbeat || !Number.isSafeInteger(heartbeat.supervisor_pid) ||
      heartbeat.supervisor_pid <= 0 || heartbeat.supervisor_pid !== expectedPid ||
      !validTime(heartbeat.timestamp_ms) ||
      time < heartbeat.timestamp_ms || time - heartbeat.timestamp_ms > HEARTBEAT_MAX_AGE_MS ||
      !processAlive(heartbeat.supervisor_pid)) {
    throw new Error('WCM Supervisor is not ready; restart request was not submitted.');
  }

  const pendingFile = path.join(stateDir, 'wcm-restart-request.json');
  const lastFile = path.join(stateDir, 'wcm-restart-last.json');
  const last = readJson(lastFile);
  if (last && validTime(last.processed_at_ms) &&
      time >= last.processed_at_ms && time - last.processed_at_ms < RESTART_COOLDOWN_MS) {
    audit(`restart_wcm cooldown last=${last.request_id || '-'}`);
    return { status: 'cooldown', request_id: last.request_id || null,
      message: 'WCM was recently restarted. No new restart was requested.' };
  }
  const pending = readJson(pendingFile);
  if (pending) {
    if (validId(pending.request_id) && validTime(pending.created_at_ms) &&
        time >= pending.created_at_ms && time - pending.created_at_ms <= REQUEST_MAX_AGE_MS) {
      audit(`restart_wcm already_pending id=${pending.request_id}`);
      return { status: 'already_pending', request_id: pending.request_id,
        message: 'A supervised WCM restart has already been requested.' };
    }
    throw new Error('Invalid or stale WCM restart request exists; Supervisor must clear it.');
  }

  const request = { version: 1, request_id: randomUUID(), created_at_ms: time };
  try {
    fs.writeFileSync(pendingFile, JSON.stringify(request), { flag: 'wx', encoding: 'utf8' });
  } catch (error) {
    if (error?.code === 'EEXIST') {
      return { status: 'already_pending', request_id: null,
        message: 'A supervised WCM restart was concurrently requested.' };
    }
    throw error;
  }
  audit(`restart_wcm accepted id=${request.request_id}`);
  return { status: 'accepted', request_id: request.request_id,
    message: 'Supervisor has been asked to restart this WCM Controller. Expect a brief MCP disconnect; verify health after reconnection.' };
}
