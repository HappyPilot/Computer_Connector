import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_APPROVAL_DURATION_SECONDS = 6 * 60 * 60;
export const MIN_APPROVAL_DURATION_SECONDS = 60;
export const MAX_APPROVAL_DURATION_SECONDS = 7 * 24 * 60 * 60;

const DEFAULT_POLICY = Object.freeze({
  version: 1,
  mode: 'timed',
  revision: 0,
});

function clonePolicy(policy) {
  return {
    version: policy.version,
    mode: policy.mode,
    revision: policy.revision,
  };
}

function hashText(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function parsePolicyText(text) {
  const parsed = JSON.parse(String(text || '').replace(/^\uFEFF/u, ''));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('approval policy must be a JSON object.');
  }
  if (parsed.version !== 1) {
    throw new Error('approval policy version must be 1.');
  }
  if (!['timed', 'off'].includes(parsed.mode)) {
    throw new Error('approval policy mode must be timed or off.');
  }
  if (!Number.isInteger(parsed.revision) || parsed.revision < 0) {
    throw new Error('approval policy revision must be a non-negative integer.');
  }
  return {
    version: 1,
    mode: parsed.mode,
    revision: parsed.revision,
  };
}

function normalizeModeLock(value) {
  if (value == null || String(value).trim() === '') return null;
  const mode = String(value).trim().toLowerCase();
  if (!['timed', 'off'].includes(mode)) {
    throw new Error('WC_APPROVAL_MODE_LOCK must be timed, off, or unset.');
  }
  return mode;
}

function applyModeLock(policy, modeLock) {
  const next = clonePolicy(policy);
  if (modeLock) next.mode = modeLock;
  return next;
}

export function validateApprovalDurationSeconds(value = DEFAULT_APPROVAL_DURATION_SECONDS) {
  const duration = value == null ? DEFAULT_APPROVAL_DURATION_SECONDS : Number(value);
  if (!Number.isInteger(duration)) {
    throw new Error('duration_seconds must be an integer.');
  }
  if (duration < MIN_APPROVAL_DURATION_SECONDS || duration > MAX_APPROVAL_DURATION_SECONDS) {
    throw new Error(
      'duration_seconds must be between ' +
      MIN_APPROVAL_DURATION_SECONDS +
      ' and ' +
      MAX_APPROVAL_DURATION_SECONDS +
      '.',
    );
  }
  return duration;
}

export class ApprovalPolicyStore {
  constructor({
    root = process.cwd(),
    logger = null,
    file = null,
    modeLock = process.env.WC_APPROVAL_MODE_LOCK,
  } = {}) {
    this.file = file || path.resolve(root, 'config', 'approval-policy.json');
    this.logger = logger;
    this.modeLock = normalizeModeLock(modeLock);
    this.signature = null;
    this.policy = applyModeLock(DEFAULT_POLICY, this.modeLock);
    this.initialized = false;
  }

  withLock(policy) {
    return applyModeLock(policy, this.modeLock);
  }

  readSource() {
    const lockSuffix = '|lock:' + (this.modeLock || '-');
    try {
      const text = fs.readFileSync(this.file, 'utf8');
      return {
        signature: 'file:' + hashText(text) + lockSuffix,
        policy: this.withLock(parsePolicyText(text)),
        warning: null,
        source: this.modeLock ? 'file+lock' : 'file',
      };
    } catch (error) {
      if (error?.code === 'ENOENT') {
        return {
          signature: 'missing' + lockSuffix,
          policy: this.withLock(DEFAULT_POLICY),
          warning: null,
          source: this.modeLock ? 'default+lock' : 'default',
        };
      }
      let signature = 'invalid:' + String(error?.message || error) + lockSuffix;
      try {
        const text = fs.readFileSync(this.file, 'utf8');
        signature = 'invalid:' + hashText(text) + lockSuffix;
      } catch {}
      return {
        signature,
        policy: this.withLock(DEFAULT_POLICY),
        warning: String(error?.message || error),
        source: this.modeLock ? 'fallback+lock' : 'fallback',
      };
    }
  }

  refresh() {
    const next = this.readSource();
    const previous = this.policy;
    const changed = this.initialized &&
      (previous.mode !== next.policy.mode || previous.revision !== next.policy.revision);
    const sourceChanged = next.signature !== this.signature;

    if (sourceChanged && next.warning) {
      this.logger?.error?.(
        'Approval policy invalid; using configured fallback policy: ' + next.warning,
      );
    }

    this.signature = next.signature;
    this.policy = next.policy;
    this.initialized = true;
    return {
      policy: clonePolicy(this.policy),
      changed,
      sourceChanged,
      source: next.source,
      warning: next.warning,
    };
  }

  current() {
    return this.refresh().policy;
  }
}

export function defaultApprovalPolicy() {
  return clonePolicy(DEFAULT_POLICY);
}
