const base = process.env.CC_MCP_URL || 'http://127.0.0.1:18009/mcp';
let sessionId = null;
let requestId = 0;

function parseMcpBody(text) {
  const data = String(text).split(/\r?\n/u).filter((line) => line.startsWith('data:'));
  return JSON.parse(data.length ? data[data.length - 1].slice(5).trim() : text);
}

async function post(method, params = {}) {
  const headers = {
    accept: 'application/json, text/event-stream',
    'content-type': 'application/json',
  };
  if (sessionId) headers['mcp-session-id'] = sessionId;
  const body = { jsonrpc: '2.0', method, params };
  if (!method.startsWith('notifications/')) body.id = ++requestId;
  const response = await fetch(base, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  if (method === 'initialize') sessionId = response.headers.get('mcp-session-id');
  if (method.startsWith('notifications/')) {
    if (response.status !== 202) throw new Error(`${method} returned HTTP ${response.status}`);
    return null;
  }
  if (!response.ok) throw new Error(`${method} returned HTTP ${response.status}: ${text}`);
  return parseMcpBody(text);
}

function resultText(result) {
  return (result?.content || [])
    .filter((item) => item?.type === 'text')
    .map((item) => item.text)
    .join('\n');
}

try {
  const initialized = await post('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'computer-connector-doctor', version: '1.0.0' },
  });
  await post('notifications/initialized', {});
  const probe = await post('tools/call', {
    name: 'probe_devices',
    arguments: { timeout_ms: 5000 },
  });
  const payload = JSON.parse(resultText(probe.result));
  console.log(`Computer Connector: ${initialized?.result?.serverInfo?.title || 'unknown'}`);
  for (const device of payload.devices || []) {
    const readiness = device.executionStatus || (device.online ? 'unknown' : 'offline');
    const latency = Number.isFinite(device.executionProbeLatencyMs)
      ? ` ${device.executionProbeLatencyMs}ms`
      : '';
    const error = device.executionError ? ` error=${device.executionError}` : '';
    console.log(`${device.deviceId}: transport=${device.online ? 'online' : 'offline'} execution=${readiness}${latency}${error}`);
  }
  const failed = (payload.devices || []).filter((device) => device.executionReady !== true);
  if (failed.length) {
    console.error(`Doctor: DEGRADED (${failed.map((device) => device.deviceId).join(', ')})`);
    process.exitCode = 2;
  } else {
    console.log('Doctor: PASS');
  }
} catch (error) {
  console.error('Doctor: FAIL');
  console.error(error?.message || error);
  process.exitCode = 1;
} finally {
  if (sessionId) {
    await fetch(base, {
      method: 'DELETE',
      headers: { 'mcp-session-id': sessionId },
      signal: AbortSignal.timeout(2000),
    }).catch(() => {});
  }
}
