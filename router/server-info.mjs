import fs from 'node:fs';
import { parseEnvFile } from '../rdc-sidecar/config.mjs';
import { iconUrlForResource, MCP_ICON_FILE, MCP_ICON_MIME, readIconPng } from '../rdc-sidecar/icon.mjs';

const packageUrl = new URL('../package.json', import.meta.url);
const packageInfo = JSON.parse(fs.readFileSync(packageUrl, 'utf8'));

function configuredResource() {
  if (process.env.RDC_RESOURCE) return process.env.RDC_RESOURCE;
  try {
    return parseEnvFile(fs.readFileSync(new URL('../config/rdc.env', import.meta.url), 'utf8')).RDC_RESOURCE;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

export function createServerInfo({ resource = null, iconFile = MCP_ICON_FILE } = {}) {
  const iconUrl = iconUrlForResource(resource);
  const iconPng = iconUrl ? readIconPng(iconFile) : null;
  const info = {
    name: String(packageInfo.name),
    title: 'Windows Console MCP',
    version: String(packageInfo.version),
  };
  if (iconPng) {
    info.icons = [{
      src: iconUrl,
      mimeType: MCP_ICON_MIME,
      sizes: [`${iconPng.readUInt32BE(16)}x${iconPng.readUInt32BE(20)}`],
    }];
  }
  return info;
}

export const serverInfo = Object.freeze(createServerInfo({ resource: configuredResource() }));

export const routerClientInfo = Object.freeze({
  name: 'windows-console-router',
  version: serverInfo.version,
});
