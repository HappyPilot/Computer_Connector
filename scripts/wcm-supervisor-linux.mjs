import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const HEARTBEAT_INTERVAL_MS = 2_000;
const REQUEST_MIN_AGE_MS = 3_000;
const REQUEST_MAX_AGE_MS = 120_000;
const FUTURE_SKEW_MS = 2_000;
const INVALID_GRACE_MS = 5_000;
const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
const UNIT_RE = /^(?:computer-connector(?:-[A-Za-z0-9_.@:-]+)?|com\.computer-connector-cloud\.[A-Za-z0-9_.@:-]+)\.service$/u;

function atomicWriteJson(file, value) {
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/u, ''));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function validRequest(request) {
  return request &&
    request.version === 1 &&
    typeof request.request_id === 'string' &&
    UUID_RE.test(request.request_id) &&
    Number.isSafeInteger(request.created_at_ms) &&
    request.created_at_ms > 0;
}

export function parseRestartUnits(value) {
  const units = String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  if (!units.length || units.length > 8 || units.some((unit) => !UNIT_RE.test(unit))) {
    throw new Error('WCM_RESTART_UNITS must contain 1-8 systemd user .service unit names.');
  }
  return units;
}

export function processRestartSignal({
  root,
  now = Date.now,
  restart = () => {},
  log = () => {},
} = {}) {
  if (!root) throw new Error('root is required.');
  const stateDir = path.join(root, '.state');
  const requestFile = path.join(stateDir, 'wcm-restart-request.json');
  const lastFile = path.join(stateDir, 'wcm-restart-last.json');
  if (!fs.existsSync(requestFile)) return { status: 'idle' };

  let request;
  try {
    request = readJson(requestFile);
  } catch (error) {
    const age = Date.now() - fs.statSync(requestFile).mtimeMs;
    if (age >= INVALID_GRACE_MS) {
      fs.rmSync(requestFile, { force: true });
      log('discarded malformed restart request');
      return { status: 'discarded_invalid' };
    }
    return { status: 'waiting_invalid' };
  }

  const time = now();
  if (!validRequest(request)) {
    fs.rmSync(requestFile, { force: true });
    log('discarded invalid restart request');
    return { status: 'discarded_invalid' };
  }

  const age = time - request.created_at_ms;
  if (age < -FUTURE_SKEW_MS || age > REQUEST_MAX_AGE_MS) {
    fs.rmSync(requestFile, { force: true });
    log('discarded expired restart request id=' + request.request_id);
    return { status: 'discarded_expired', request_id: request.request_id };
  }
  if (age < REQUEST_MIN_AGE_MS) return { status: 'waiting', request_id: request.request_id };

  const last = readJson(lastFile);
  if (last?.request_id === request.request_id) {
    fs.rmSync(requestFile, { force: true });
    return { status: 'duplicate', request_id: request.request_id };
  }

  restart(request);
  atomicWriteJson(lastFile, {
    version: 1,
    request_id: request.request_id,
    processed_at_ms: now(),
  });
  fs.rmSync(requestFile, { force: true });
  log('accepted supervised restart id=' + request.request_id);
  return { status: 'restarted', request_id: request.request_id };
}

function restartUnits(units) {
  const result = spawnSync('systemctl', ['--user', 'restart', ...units], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      'systemctl restart failed: ' +
      String(result.stderr || result.stdout || 'unknown error').trim(),
    );
  }
}

export function runLinuxSupervisor({
  root = process.env.WCM_ROOT || process.cwd(),
  units = parseRestartUnits(process.env.WCM_RESTART_UNITS),
} = {}) {
  const resolvedRoot = path.resolve(root);
  const stateDir = path.join(resolvedRoot, '.state');
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const pidFile = path.join(stateDir, 'rdc-supervisor.pid');
  const heartbeatFile = path.join(stateDir, 'wcm-supervisor-heartbeat.json');
  fs.writeFileSync(pidFile, String(process.pid) + '\n', { encoding: 'ascii', mode: 0o600 });

  const log = (message) => {
    process.stdout.write('[' + new Date().toISOString() + '] ' + message + '\n');
  };
  const cleanup = () => {
    fs.rmSync(heartbeatFile, { force: true });
    fs.rmSync(pidFile, { force: true });
  };

  const tick = () => {
    try {
      atomicWriteJson(heartbeatFile, {
        supervisor_pid: process.pid,
        timestamp_ms: Date.now(),
      });
      const result = processRestartSignal({
        root: resolvedRoot,
        restart: () => restartUnits(units),
        log,
      });
      if (!['idle', 'waiting', 'waiting_invalid'].includes(result.status)) {
        log('restart signal result=' + result.status);
      }
    } catch (error) {
      log('supervisor error: ' + String(error?.message || error));
    }
  };

  process.on('SIGTERM', () => { cleanup(); process.exit(0); });
  process.on('SIGINT', () => { cleanup(); process.exit(0); });
  process.on('exit', cleanup);
  tick();
  setInterval(tick, HEARTBEAT_INTERVAL_MS);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runLinuxSupervisor();
}