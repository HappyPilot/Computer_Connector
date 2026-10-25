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
