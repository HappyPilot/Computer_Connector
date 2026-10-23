import assert from 'node:assert/strict';

const moduleUnderTest = await import('../router/session-affinity.mjs').catch(() => null);
assert.ok(
  moduleUnderTest?.SessionAffinityRegistry,
  'router/session-affinity.mjs must export SessionAffinityRegistry',
);

const { SessionAffinityRegistry } = moduleUnderTest;
const registry = new SessionAffinityRegistry({ now: () => 1_800_000_000_000 });
const processResult = {
  content: [{ type: 'text', text: 'Process started with PID 4242 (shell: /bin/sh)\nInitial output:\nready' }],
};
const searchResult = {
  content: [{ type: 'text', text: 'Started content search session: search_7_1800000000000\nPattern: "needle"' }],
};

registry.record({
  deviceId: 'device-a',
  toolName: 'start_process',
  args: { command: 'safe-test' },
  result: processResult,
  hostSession: 'conversation-1',
});
registry.record({
  deviceId: 'device-a',
  toolName: 'start_search',
  args: { pattern: 'needle' },
  result: searchResult,
  hostSession: 'conversation-1',
});

assert.equal(registry.check({
  deviceId: 'device-a',
  toolName: 'interact_with_process',
  args: { pid: 4242, input: 'continue' },
  hostSession: 'conversation-1',
}), null);
assert.match(registry.check({
  deviceId: 'device-b',
  toolName: 'read_process_output',
  args: { pid: 4242 },
  hostSession: 'conversation-1',
}), /device-a/u);
assert.match(registry.check({
  deviceId: 'device-b',
  toolName: 'get_more_search_results',
  args: { sessionId: 'search_7_1800000000000' },
  hostSession: 'conversation-1',
}), /device-a/u);

registry.record({
  deviceId: 'device-b',
  toolName: 'start_process',
  args: { command: 'other-test' },
  result: processResult,
  hostSession: 'conversation-2',
});
assert.equal(registry.check({
  deviceId: 'device-b',
  toolName: 'interact_with_process',
  args: { pid: 4242, input: 'continue' },
  hostSession: 'conversation-2',
}), null);
assert.match(registry.check({
  deviceId: 'device-a',
  toolName: 'interact_with_process',
  args: { pid: 4242, input: 'continue' },
  hostSession: 'conversation-2',
}), /device-b/u);

// Exercise every follow-up, both resource kinds, and both collision scopes.
for (const [start, result, followUps, args] of [
  ['start_process', processResult, ['read_process_output', 'interact_with_process', 'force_terminate', 'kill_process'], { pid: 4242 }],
  ['start_search', searchResult, ['get_more_search_results', 'stop_search'], { sessionId: 'search_7_1800000000000' }],
]) {
  const scoped = new SessionAffinityRegistry();
  for (const [deviceId, hostSession] of [['device-a', 'one'], ['device-b', 'two']]) {
    assert.equal(scoped.record({ deviceId, toolName: start, result, hostSession }), true);
  }
  for (const toolName of followUps) {
    for (const [deviceId, hostSession, wrongDevice] of [
      ['device-a', 'one', 'device-b'], ['device-b', 'two', 'device-a'],
    ]) {
      assert.equal(scoped.check({ deviceId, toolName, args, hostSession }), null);
      assert.match(scoped.check({ deviceId: wrongDevice, toolName, args, hostSession }), /must match/u);
      // With no scoped record, the explicit known owner resolves the global collision.
      assert.equal(scoped.check({ deviceId, toolName, args }), null);
      assert.equal(scoped.check({ deviceId, toolName, args, hostSession: 'new' }), null);
    }
    assert.match(scoped.check({ deviceId: 'device-c', toolName, args }), /must match/u);
    assert.match(scoped.check({ toolName, args, hostSession: 'one' }), /deviceId is required/u);
  }
  for (const deviceId of ['device-a', 'device-b']) {
    scoped.record({ deviceId, toolName: start, result, hostSession: 'shared' });
  }
  for (const toolName of followUps) {
    for (const deviceId of ['device-a', 'device-b']) {
      assert.equal(scoped.check({ deviceId, toolName, args, hostSession: 'shared' }), null);
    }
    assert.match(scoped.check({ deviceId: 'device-c', toolName, args, hostSession: 'shared' }), /must match/u);
    // A broader collision must never override a narrower session owner.
    assert.match(scoped.check({ deviceId: 'device-b', toolName, args, hostSession: 'one' }), /device-a/u);
  }
}

const trailingSearch = new SessionAffinityRegistry();
trailingSearch.record({
  deviceId: 'device-a',
  toolName: 'start_search',
  result: { content: [{ type: 'text', text: 'Started content search session: search-edge-' }] },
  hostSession: 'edge',
});
assert.match(trailingSearch.check({
  deviceId: 'device-b', toolName: 'stop_search', args: { sessionId: 'search-edge-' }, hostSession: 'edge',
}), /device-a/u);

let now = 100;
const expiring = new SessionAffinityRegistry({ now: () => now, ttlMs: 10, maxRecords: 2 });
assert.equal(expiring.record({ deviceId: 'device-a', toolName: 'start_process', result: { ...processResult, isError: true } }), false);
assert.equal(expiring.record({ deviceId: 'device-a', toolName: 'start_search', result: { error: 'failed', ...searchResult } }), false);
expiring.record({ deviceId: 'device-a', toolName: 'start_process', result: processResult });
assert.match(expiring.check({ deviceId: 'device-b', toolName: 'kill_process', args: { pid: '4242' } }), /device-a/u);
now += 10;
assert.equal(expiring.check({ deviceId: 'device-b', toolName: 'kill_process', args: { pid: 4242 } }), null);
// Unknown identifiers are allowed only with an explicit target; ownership is observational.
assert.equal(expiring.check({ deviceId: 'device-a', toolName: 'stop_search', args: { sessionId: 'unknown' } }), null);

console.log('Computer Connector session affinity tests: PASS');
