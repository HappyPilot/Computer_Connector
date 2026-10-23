import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createConfig } from '../rdc-sidecar/config.mjs';
import { iconUrlForResource, readIconPng } from '../rdc-sidecar/icon.mjs';
import { createRdcServer, listenRdcServer, closeRdcServer } from '../rdc-sidecar/server.mjs';
import { createServerInfo } from '../router/server-info.mjs';

const uploadIconFile = new URL('../assets/wcm-plugin-icon.png', import.meta.url);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wcm-icon-test-'));
const iconFile = path.join(tmp, 'icon.png');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lL0AAAAASUVORK5CYII=', 'base64');
const resource = 'https://wcm.example.com/rdc/mcp';

async function test() {
  const uploadedIcon = fs.readFileSync(uploadIconFile);
  assert.ok(uploadedIcon.length < 10000, 'ChatGPT manual-upload icon must be under 10 KB');
  assert.ok(uploadedIcon.length > 1000, 'Manual-upload icon must not be a blank placeholder');
  assert.ok(readIconPng(uploadIconFile), 'Manual-upload icon must be a valid PNG');
  assert.equal(uploadedIcon.readUInt32BE(16), 128);
  assert.equal(uploadedIcon.readUInt32BE(20), 128);
  assert.ok(uploadedIcon.includes(Buffer.from('tRNS')), 'Manual-upload PNG must preserve transparency');
  assert.equal(iconUrlForResource(resource), 'https://wcm.example.com/rdc/icon.png');
  for (const invalid of ['', null, 'http://wcm.example.com/rdc/mcp', 'https://user:pass@wcm.example.com/rdc/mcp', 'https://wcm.example.com/wrong', 'https://wcm.example.com/rdc/mcp?key=secret']) {
    assert.equal(iconUrlForResource(invalid), null);
  }
  assert.equal(readIconPng(iconFile), null);
  assert.equal(createServerInfo({ resource, iconFile }).icons, undefined);
  fs.writeFileSync(iconFile, Buffer.from('not a png'));
  assert.equal(readIconPng(iconFile), null);
  fs.writeFileSync(iconFile, png);
  assert.deepEqual(readIconPng(iconFile), png);
  const info = createServerInfo({ resource, iconFile });
  assert.equal(info.name, 'computer-connector');
  assert.equal(info.title, 'Computer Connector');
  assert.equal(createServerInfo({ resource: 'http://wcm.example.com/rdc/mcp', iconFile }).icons, undefined);
  assert.deepEqual(info.icons, [{
    src: 'https://wcm.example.com/rdc/icon.png',
    mimeType: 'image/png',
    sizes: ['1x1'],
  }]);

  const config = createConfig({
    rootDir: tmp,
    readEnvFile: false,
    envValues: { RDC_ISSUER: 'https://wcm.example.com/rdc', RDC_RESOURCE: resource },
    allowEphemeral: true,
    approvalSecret: 'test-secret-must-be-at-least-16-bytes',
  });
  const runtime = createRdcServer({ config, iconFile, logger: {} });
  await listenRdcServer(runtime, 0);
  const base = `http://127.0.0.1:${runtime.server.address().port}`;
  try {
    const get = await fetch(base + '/rdc/icon.png');
    assert.equal(get.status, 200);
    assert.equal(get.headers.get('content-type'), 'image/png');
    assert.equal(get.headers.get('access-control-allow-origin'), '*');
    assert.equal(get.headers.get('cache-control'), 'public, max-age=300');
    assert.deepEqual(Buffer.from(await get.arrayBuffer()), png);
    const head = await fetch(base + '/rdc/icon.png', { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('content-length'), String(png.length));
    assert.equal((await head.arrayBuffer()).byteLength, 0);
    const protectedMcp = await fetch(base + '/rdc/mcp');
    assert.equal(protectedMcp.status, 401);
    fs.unlinkSync(iconFile);
    const missing = await fetch(base + '/rdc/icon.png');
    assert.equal(missing.status, 404);
    assert.equal(missing.headers.get('cache-control'), 'no-store');
  } finally {
    await closeRdcServer(runtime);
  }
}

try {
  await test();
  console.log('WCM MCP icon tests passed.');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
