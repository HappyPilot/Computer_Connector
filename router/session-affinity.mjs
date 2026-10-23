const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_RECORDS = 4096;

const FOLLOW_UPS = new Map([
  ['read_process_output', { kind: 'process', readId: (args) => args?.pid }],
  ['interact_with_process', { kind: 'process', readId: (args) => args?.pid }],
  ['force_terminate', { kind: 'process', readId: (args) => args?.pid }],
  ['kill_process', { kind: 'process', readId: (args) => args?.pid }],
  ['get_more_search_results', { kind: 'search', readId: (args) => args?.sessionId }],
  ['stop_search', { kind: 'search', readId: (args) => args?.sessionId }],
]);

function resultText(result) {
  return (Array.isArray(result?.content) ? result.content : [])
    .filter((item) => item?.type === 'text' && typeof item.text === 'string')
    .map((item) => item.text)
    .join('\n');
}

function resourceIdForResult(toolName, result) {
  if (result?.isError || result?.error) return null;
  const text = resultText(result);
  if (toolName === 'start_process') {
    const match = text.match(/\bPID\s+(-?\d+)\b/iu);
    return match ? { kind: 'process', id: match[1] } : null;
  }
  if (toolName === 'start_search') {
    const match = text.match(/\bsession:\s*([A-Za-z0-9._-]{1,256})(?=\s|$)/iu);
    return match ? { kind: 'search', id: match[1] } : null;
  }
  return null;
}

function resourceIdForCall(toolName, args) {
  const followUp = FOLLOW_UPS.get(toolName);
  if (!followUp) return null;
  const value = followUp.readId(args);
  if (followUp.kind === 'process') {
    const pid = Number(value);
    return Number.isSafeInteger(pid) ? { kind: followUp.kind, id: String(pid) } : null;
  }
  const sessionId = String(value || '').trim();
  return sessionId && sessionId.length <= 256
    ? { kind: followUp.kind, id: sessionId }
    : null;
}

function normalizedSession(value) {
  const session = String(value || '').trim();
  return session && session.length <= 512 ? session : null;
}

export class SessionAffinityRegistry {
  constructor({ now = Date.now, ttlMs = DEFAULT_TTL_MS, maxRecords = DEFAULT_MAX_RECORDS } = {}) {
    if (typeof now !== 'function') throw new TypeError('now must be a function.');
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new TypeError('ttlMs must be a positive integer.');
    if (!Number.isSafeInteger(maxRecords) || maxRecords < 2) throw new TypeError('maxRecords must be an integer of at least 2.');
    this.now = now;
    this.ttlMs = ttlMs;
    this.maxRecords = maxRecords;
    this.records = new Map();
  }

  #globalKey(kind, id) {
    return `${kind}\0${id}`;
  }

  #sessionKey(kind, id, session) {
    return `${kind}\0${id}\0${session}`;
  }

  #prune() {
    const now = this.now();
    for (const [key, value] of this.records) {
      if (value.expiresAt <= now) this.records.delete(key);
    }
    while (this.records.size > this.maxRecords) {
      this.records.delete(this.records.keys().next().value);
    }
  }

  #addOwner(key, deviceId) {
    const existing = this.records.get(key);
    const owners = existing?.owners || new Set();
    owners.add(deviceId);
    this.records.delete(key);
    this.records.set(key, { owners, expiresAt: this.now() + this.ttlMs });
    this.#prune();
  }

  record({ deviceId, toolName, args, result, hostSession = null } = {}) {
    const id = resourceIdForResult(toolName, result);
    const owner = String(deviceId || '').trim();
    if (!id || !owner) return false;
    this.#prune();
    this.#addOwner(this.#globalKey(id.kind, id.id), owner);
    const session = normalizedSession(hostSession);
    if (session) this.#addOwner(this.#sessionKey(id.kind, id.id, session), owner);
    return true;
  }

  check({ deviceId, toolName, args, hostSession = null } = {}) {
    const id = resourceIdForCall(toolName, args);
    const target = String(deviceId || '').trim();
    if (!target) return 'deviceId is required.';
    if (!id) return null;
    this.#prune();

    const session = normalizedSession(hostSession);
    const scoped = session
      ? this.records.get(this.#sessionKey(id.kind, id.id, session))
      : null;
    const record = scoped || this.records.get(this.#globalKey(id.kind, id.id));
    if (!record) return null;
    // The session narrows ownership; within that scope the explicit device
    // disambiguates identifiers independently allocated by different workers.
    if (!record.owners.has(target)) {
      return `${id.kind} identifier ${id.id} belongs to device ${[...record.owners].join(', ')}; deviceId must match that device.`;
    }
    return null;
  }
}
