import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('worker upgraded Zod keeps Desktop Commander MCP schemas valid on a real stdio transport', { timeout: 30000 }, async () => {
  const tempHome = await mkdtemp(join(tmpdir(), 'cc-zod-v3-compat-'));
  const root = fileURLToPath(new URL('../', import.meta.url));
  const schemaText = await readFile(new URL('../node_modules/@wonderwhy-er/desktop-commander/dist/tools/schemas.js', import.meta.url), 'utf8');
  assert.ok(schemaText.startsWith('import { z } from "zod/v3";'));
  const client = new Client({ name: 'cc-zod-compat-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['node_modules/@wonderwhy-er/desktop-commander/dist/index.js'],
    cwd: root,
    env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
    stderr: 'pipe',
  });
  try {
    await client.connect(transport);
    const tools = (await client.listTools()).tools;
    for (const name of ['get_config', 'list_directory']) {
      const tool = tools.find(entry => entry.name === name);
      assert.equal(tool?.inputSchema?.type, 'object', name);
    }
    const config = await client.callTool({ name: 'get_config', arguments: {} });
    assert.notEqual(config.isError, true);
    const listing = await client.callTool({ name: 'list_directory', arguments: { path: tempHome } });
    assert.notEqual(listing.isError, true);
  } finally {
    await client.close().catch(() => {});
    await rm(tempHome, { recursive: true, force: true });
  }
});
