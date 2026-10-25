import { readFile, writeFile } from 'node:fs/promises';

// Desktop Commander 0.3.1 builds its MCP JSON schemas with zod-to-json-schema,
// which expects Zod 3 objects. Zod 4.6.7 includes a compatible "zod/v3" API.
// Keep schema generation on v3 while using the patched v4 package.
const packageRoot = process.argv.includes('--worker')
  ? new URL('../worker/node_modules/', import.meta.url)
  : new URL('../node_modules/', import.meta.url);
const commander = JSON.parse(await readFile(new URL('@wonderwhy-er/desktop-commander/package.json', packageRoot), 'utf8'));
const zod = JSON.parse(await readFile(new URL('zod/package.json', packageRoot), 'utf8'));
if (commander.version !== '0.3.1' || zod.version !== '4.6.7') {
  throw new Error('Review Desktop Commander / Zod compatibility before changing the pinned versions');
}
const file = new URL('@wonderwhy-er/desktop-commander/dist/tools/schemas.js', packageRoot);
const source = await readFile(file, 'utf8');
const oldImport = 'import { z } from "zod";';
const newImport = 'import { z } from "zod/v3";';
if (source.startsWith(newImport)) {
  console.log('Desktop Commander Zod 3 compatibility already applied.');
} else if (source.startsWith(oldImport)) {
  await writeFile(file, newImport + source.slice(oldImport.length));
  console.log('Desktop Commander Zod 3 compatibility applied using patched Zod 4.');
} else {
  throw new Error('Unexpected Desktop Commander schema module; patch not applied');
}

const serverFile = new URL('@wonderwhy-er/desktop-commander/dist/server.js', packageRoot);
const serverSource = await readFile(serverFile, 'utf8');
const marker = 'WCM_ARGUMENT_COMPLEXITY_GUARD_V1';
const anchor = 'server.setRequestHandler(CallToolRequestSchema, async (request) => {\n    const args = request.params.arguments;';
const preflight = `// WCM_ARGUMENT_COMPLEXITY_GUARD_V1: reject oversized nested tool arguments before Zod validates them.
function wcmArgumentsWithinBudget(value, budget = { nodes: 0 }, depth = 0) {
    if (++budget.nodes > 8192 || depth > 24) return false;
    if (typeof value === 'string') return value.length <= 1000000;
    if (Array.isArray(value)) {
        if (value.length > 2048) return false;
        for (const item of value) if (!wcmArgumentsWithinBudget(item, budget, depth + 1)) return false;
        return true;
    }
    if (value && typeof value === 'object') {
        const keys = Object.keys(value);
        if (keys.length > 1024) return false;
        for (const key of keys) if (!wcmArgumentsWithinBudget(value[key], budget, depth + 1)) return false;
    }
    return true;
}
server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = request.params.arguments;
    if (!wcmArgumentsWithinBudget(args)) {
        return { isError: true, content: [{ type: 'text', text: 'Arguments exceed safety limit' }] };
    }`;
if (serverSource.includes(marker)) {
  console.log('Desktop Commander argument budget already applied.');
} else if (serverSource.split(anchor).length === 2) {
  await writeFile(serverFile, serverSource.replace(anchor, preflight));
  console.log('Desktop Commander argument complexity budget applied.');
} else {
  throw new Error('Unexpected Desktop Commander request handler; budget patch not applied');
}
