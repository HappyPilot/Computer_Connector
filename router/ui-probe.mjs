// Independent, read-only MCP App diagnostic for ChatGPT mobile hosts.
export const UI_PROBE_URI = 'ui://wcm/mobile-probe-v1.html';
const MIME_TYPE = 'text/html;profile=mcp-app';

export const UI_PROBE_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    :root { color-scheme: light dark; }
    body { margin: 0; padding: 5px; font: 14px system-ui, sans-serif; }
    main { border: 1px solid #8887; border-radius: 12px; padding: 14px; }
    h3 { margin: 0 0 8px; font-size: 15px; }
    p { margin: 6px 0; overflow-wrap: anywhere; }
    button { margin: 8px 8px 0 0; padding: 9px 12px; border-radius: 8px; }
    #bridge, #local { white-space: pre-wrap; }
  </style>
</head>
<body>
  <main>
    <h3>WCM mobile UI probe</h3>
    <p id="render">1. HTML rendered</p>
    <p id="local">2. Local JS: ready</p>
    <p id="bridge">3. MCP bridge: initializing</p>
    <button id="localButton" type="button">Test local click</button>
    <button id="pingButton" type="button" disabled>Test MCP ping</button>
  </main>
  <script>
    (() => {
      const pending = new Map();
      let nextId = 1;
      const local = document.getElementById("local");
      const bridge = document.getElementById("bridge");
      const pingButton = document.getElementById("pingButton");
      const resize = () => { try { window.openai?.notifyIntrinsicHeight?.(); } catch {} };
      function request(method, params, timeoutMs = 15000) {
        const id = nextId++;
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error(method + " timed out"));
          }, timeoutMs);
          pending.set(id, { resolve, reject, timer });
          window.parent.postMessage({ jsonrpc: "2.0", id, method, params }, "*");
        });
      }
      window.addEventListener("message", (event) => {
        if (event.source !== window.parent) return;
        const message = event.data;
        if (!message || message.jsonrpc !== "2.0" ||
            !Object.prototype.hasOwnProperty.call(message, "id")) return;
        const waiter = pending.get(message.id);
        if (!waiter) return;
        pending.delete(message.id);
        clearTimeout(waiter.timer);
        if (message.error) waiter.reject(new Error(message.error.message || "MCP error"));
        else waiter.resolve(message.result);
      });
      document.getElementById("localButton").addEventListener("click", () => {
        local.textContent = "2. Local JS: click OK";
        resize();
      });
      pingButton.addEventListener("click", async () => {
        pingButton.disabled = true;
        bridge.textContent = "3. MCP bridge: calling...";
        resize();
        try {
          const result = await request("tools/call", {
            name: "ui_probe_ping",
            arguments: {}
          }, 20000);
          const output = result?.structuredContent || {};
          if (result?.isError || output.status !== "pong") {
            throw new Error(result?.content?.[0]?.text || "Unexpected MCP response");
          }
          bridge.textContent = "3. MCP bridge: PONG (" + output.server_time + ")";
        } catch (error) {
          bridge.textContent = "3. MCP bridge: ERROR (" +
            String(error?.message || error) + ")";
        }
        pingButton.disabled = false;
        resize();
      });
      (async () => {
        try {
          await request("ui/initialize", {
            protocolVersion: "2026-01-26",
            appInfo: { name: "wcm-ui-probe", title: "WCM UI probe", version: "1.0.0" },
            appCapabilities: {}
          }, 6000);
          window.parent.postMessage({
            jsonrpc: "2.0",
            method: "ui/notifications/initialized"
          }, "*");
          bridge.textContent = "3. MCP bridge: initialized, ready to ping";
          pingButton.disabled = false;
        } catch (error) {
          bridge.textContent = "3. MCP bridge: INIT ERROR (" +
            String(error?.message || error) + ")";
        }
        resize();
      })();
    })();
  </script>
</body>
</html>`;

const PROBE_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string' },
    server_time: { type: 'string' },
  },
  required: ['status', 'server_time'],
  additionalProperties: false,
};

export function uiProbeTools() {
  return [
    {
      name: 'ui_probe',
      description: 'Display a minimal, harmless WCM diagnostic card to test HTML rendering, local clicks, and a ChatGPT MCP App bridge ping. No device access or WCM approval is used.',
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      execution: { taskSupport: 'forbidden' },
      _meta: {
        ui: { resourceUri: UI_PROBE_URI, visibility: ['model', 'app'] },
        'ui/resourceUri': UI_PROBE_URI,
        'openai/outputTemplate': UI_PROBE_URI,
        'openai/widgetAccessible': true,
      },
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      outputSchema: PROBE_OUTPUT_SCHEMA,
    },
    {
      name: 'ui_probe_ping',
      description: 'App-only, side-effect-free MCP round-trip test for the WCM UI probe.',
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      execution: { taskSupport: 'forbidden' },
      _meta: { ui: { visibility: ['app'] }, 'openai/widgetAccessible': true },
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      outputSchema: PROBE_OUTPUT_SCHEMA,
    },
  ];
}

export function uiProbeResult(status) {
  return { status, server_time: new Date().toISOString() };
}

export function uiProbeResource() {
  return {
    uri: UI_PROBE_URI,
    name: 'wcm-ui-probe',
    title: 'WCM mobile UI probe',
    description: 'Independent read-only HTML and MCP App bridge test.',
    mimeType: MIME_TYPE,
  };
}

export function readUiProbeResource(payload) {
  if (payload?.method !== 'resources/read' || payload?.params?.uri !== UI_PROBE_URI) {
    return null;
  }
  return {
    result: {
      contents: [{
        uri: UI_PROBE_URI,
        mimeType: MIME_TYPE,
        text: UI_PROBE_HTML,
        _meta: { ui: { prefersBorder: true } },
      }],
    },
  };
}
