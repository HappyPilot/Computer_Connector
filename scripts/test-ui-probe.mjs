import assert from 'node:assert/strict';
import {
  UI_PROBE_HTML,
  UI_PROBE_URI,
  readUiProbeResource,
  uiProbeResource,
  uiProbeResult,
  uiProbeTools,
} from '../router/ui-probe.mjs';

const tools = uiProbeTools();
assert.deepEqual(tools.map((tool) => tool.name), ['ui_probe', 'ui_probe_ping']);
assert.equal(tools[0]._meta.ui.resourceUri, UI_PROBE_URI);
assert.equal(tools[0]._meta['openai/outputTemplate'], UI_PROBE_URI);
assert.deepEqual(tools[1]._meta.ui.visibility, ['app']);
assert.equal(tools[1].annotations.readOnlyHint, true);
for (const tool of tools) {
  assert.deepEqual(tool.inputSchema.required || [], []);
  assert.equal(tool.outputSchema.required.includes('server_time'), true);
}

assert.equal(uiProbeResource().uri, UI_PROBE_URI);
const read = readUiProbeResource({
  method: 'resources/read',
  params: { uri: UI_PROBE_URI },
});
assert.equal(read.result.contents[0].text, UI_PROBE_HTML);
assert.equal(read.result.contents[0].mimeType, 'text/html;profile=mcp-app');
assert.equal(readUiProbeResource({ method: 'resources/read', params: { uri: 'ui://other' } }), null);
assert.match(UI_PROBE_HTML, /HTML rendered/);
assert.match(UI_PROBE_HTML, /Local JS: click OK/);
assert.match(UI_PROBE_HTML, /name: "ui_probe_ping"/);
assert.match(UI_PROBE_HTML, /"ui\/initialize"/);
assert.match(UI_PROBE_HTML, /"ui\/notifications\/initialized"/);
assert.match(UI_PROBE_HTML, /MCP bridge: ERROR/);
assert.equal(uiProbeResult('pong').status, 'pong');
assert.match(uiProbeResult('pong').server_time, /^\d{4}-\d\d-\d\dT/);

console.log('WCM independent mobile UI probe: PASS');
