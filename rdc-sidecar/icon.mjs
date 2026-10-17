import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const MCP_ICON_PATH = '/rdc/icon.png';
export const MCP_ICON_FILE = fileURLToPath(new URL('../assets/wcm-icon.png', import.meta.url));
export const MCP_ICON_MIME = 'image/png';
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_ICON_BYTES = 1024 * 1024;

export function iconUrlForResource(resource) {
  try {
    const url = new URL(resource);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/rdc/mcp'
    ) {
      return null;
    }
    return url.origin + MCP_ICON_PATH;
  } catch {
    return null;
  }
}

export function readIconPng(iconFile = MCP_ICON_FILE) {
  let bytes;
  try {
    bytes = fs.readFileSync(iconFile);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  if (
    bytes.length < 24 ||
    bytes.length > MAX_ICON_BYTES ||
    !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE) ||
    bytes.toString('ascii', 12, 16) !== 'IHDR' ||
    bytes.readUInt32BE(16) < 1 ||
    bytes.readUInt32BE(20) < 1 ||
    bytes.readUInt32BE(16) > 4096 ||
    bytes.readUInt32BE(20) > 4096
  ) {
    return null;
  }
  return bytes;
}
