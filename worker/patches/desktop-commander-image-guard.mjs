import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const workerRoot = path.resolve(here, '..');
const dcRoot = process.env.DESKTOP_COMMANDER_ROOT
  ? path.resolve(process.env.DESKTOP_COMMANDER_ROOT)
  : path.join(workerRoot, 'node_modules', '@wonderwhy-er', 'desktop-commander');
const pkgPath = path.join(dcRoot, 'package.json');

if (!fs.existsSync(pkgPath)) throw new Error(`Desktop Commander is not installed at ${dcRoot}.`);
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
if (pkg.version !== '0.3.1') {
  throw new Error(`Refusing to patch unsupported Desktop Commander ${pkg.version}; expected 0.3.1.`);
}

const imageFile = path.join(dcRoot, 'dist', 'utils', 'files', 'image.js');
const factoryFile = path.join(dcRoot, 'dist', 'utils', 'files', 'factory.js');
const stdioFile = path.join(dcRoot, 'dist', 'custom-stdio.js');

const imageSource = `/** WCM_IMAGE_GUARD_V2 */
import fs from "fs/promises";
import sharp from "sharp";

const SVG_MIME_TYPE = 'image/svg+xml';
const MAX_INLINE_IMAGE_BYTES = Number.parseInt(process.env.DESKTOP_COMMANDER_MAX_INLINE_IMAGE_BYTES || '65536', 10);
const MAX_IMAGE_PIXELS = Number.parseInt(process.env.DESKTOP_COMMANDER_MAX_IMAGE_PIXELS || '100000000', 10);
const PREVIEW_WIDTHS = [1600, 1200, 900, 640, 480, 320];
const PREVIEW_QUALITIES = [76, 70, 64, 58, 52, 46];

export function isImageAnswer(mimeType, svgAsImage = false) {
  const type = String(mimeType || '').toLowerCase().split(';')[0].trim();
  return type.startsWith('image/') && (svgAsImage || type !== SVG_MIME_TYPE);
}

export class ImageFileHandler {
  canHandle(filePath, options) {
    return isImageAnswer(this.getMimeType(filePath), options?.svgAsImage);
  }

  async probe(filePath, options) {
    if (!this.canHandle(filePath, options)) {
      return { valid: false, reason: 'file is not an image for this read mode' };
    }
    try {
      const metadata = await sharp(filePath, { animated: false, limitInputPixels: MAX_IMAGE_PIXELS }).metadata();
      const width = Number(metadata.width || 0);
      const height = Number(metadata.height || 0);
      if (!width || !height) return { valid: false, reason: 'image dimensions could not be decoded' };
      if (width * height > MAX_IMAGE_PIXELS) return { valid: false, reason: 'image exceeds pixel safety limit' };
      return { valid: true, mimeType: this.getMimeType(filePath), width, height };
    } catch (error) {
      return { valid: false, reason: 'image decode failed: ' + (error?.message || String(error)) };
    }
  }

  async read(filePath, options) {
    const probe = await this.probe(filePath, options);
    if (!probe.valid) {
      return {
        content: 'File has an image extension but is not a valid decodable image. Use start_process for binary analysis. Reason: ' + probe.reason,
        mimeType: 'text/plain',
        metadata: { isImage: false, isBinary: true, imageValidationFailed: true }
      };
    }
    const stats = await fs.stat(filePath);
    if (stats.size <= MAX_INLINE_IMAGE_BYTES) {
      const buffer = await fs.readFile(filePath, { signal: options?.signal });
      return {
        content: buffer.toString('base64'),
        mimeType: probe.mimeType,
        metadata: { isImage: true, width: probe.width, height: probe.height, originalSize: stats.size }
      };
    }

    let preview = null;
    for (let i = 0; i < PREVIEW_WIDTHS.length; i += 1) {
      preview = await sharp(filePath, { animated: false, limitInputPixels: MAX_IMAGE_PIXELS })
        .resize({ width: PREVIEW_WIDTHS[i], height: PREVIEW_WIDTHS[i], fit: 'inside', withoutEnlargement: true })
        .webp({ quality: PREVIEW_QUALITIES[i] })
        .toBuffer();
      if (preview.length <= MAX_INLINE_IMAGE_BYTES) break;
    }
    if (!preview || preview.length > MAX_INLINE_IMAGE_BYTES) {
      return {
        content: 'Valid image omitted because a safe inline preview could not be produced. Use start_process for local image processing.',
        mimeType: 'text/plain',
        metadata: { isImage: false, imageTooLarge: true, originalSize: stats.size }
      };
    }
    return {
      content: preview.toString('base64'),
      mimeType: 'image/webp',
      metadata: {
        isImage: true,
        preview: true,
        originalMimeType: probe.mimeType,
        originalSize: stats.size,
        previewSize: preview.length,
        width: probe.width,
        height: probe.height
      }
    };
  }

  async write(filePath, content, mode) {
    if (mode === 'append') throw new Error('Image append not supported.');
    const buffer = typeof content === 'string' ? Buffer.from(content, 'base64') : content;
    await fs.writeFile(filePath, buffer);
  }

  async getInfo(filePath) {
    const stats = await fs.stat(filePath);
    return {
      size: stats.size,
      created: stats.birthtime,
      modified: stats.mtime,
      accessed: stats.atime,
      isDirectory: stats.isDirectory(),
      isFile: stats.isFile(),
      permissions: stats.mode.toString(8).slice(-3),
      fileType: 'image',
      metadata: { isImage: true }
    };
  }

  getMimeType(filePath) {
    const lowerPath = filePath.toLowerCase();
    for (const [ext, mimeType] of Object.entries(ImageFileHandler.IMAGE_MIME_TYPES)) {
      if (lowerPath.endsWith(ext)) return mimeType;
    }
    return 'application/octet-stream';
  }
}

ImageFileHandler.IMAGE_MIME_TYPES = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml'
};
`;

fs.writeFileSync(imageFile, imageSource, 'utf8');

let factory = fs.readFileSync(factoryFile, 'utf8');
const oldFactoryBlock = `    // Check Image (extension-based, sync - images are binary but handled specially)\n    if (getImageHandler().canHandle(filePath, options)) {\n        return getImageHandler();\n    }`;
const newFactoryBlock = `    // WCM_IMAGE_GUARD_V2: extension is only a candidate; verify decoder and pixel bounds first.\n    if (getImageHandler().canHandle(filePath, options)) {\n        const probe = await getImageHandler().probe(filePath, options);\n        if (probe.valid) return getImageHandler();\n        return getBinaryHandler();\n    }`;

if (!factory.includes('WCM_IMAGE_GUARD_V2')) {
  if (!factory.includes(oldFactoryBlock)) throw new Error('factory.js layout changed; refusing unsafe patch.');
  factory = factory.replace(oldFactoryBlock, newFactoryBlock);
  fs.writeFileSync(factoryFile, factory, 'utf8');
}

let stdio = fs.readFileSync(stdioFile, 'utf8');
const oldStdioAllowBlock = `                    // This looks like a valid JSON-RPC message, allow it
                    return this.originalStdoutWrite.call(process.stdout, buffer, encoding, callback);`;
const newStdioAllowBlock = `                    // WCM_STDOUT_RESPONSE_GUARD_V2: bound complete JSON-RPC lines before forwarding.
                    const configuredLimit = Number.parseInt(process.env.DESKTOP_COMMANDER_MAX_STDOUT_JSON_BYTES || '524288', 10);
                    const maxBytes = Number.isFinite(configuredLimit) && configuredLimit >= 65536 ? configuredLimit : 524288;
                     const configuredAppResourceLimit = Number.parseInt(process.env.DESKTOP_COMMANDER_MAX_APP_RESOURCE_BYTES || '2097152', 10);
                     const maxAppResourceBytes = Number.isFinite(configuredAppResourceLimit) && configuredAppResourceLimit >= maxBytes
                         ? configuredAppResourceLimit
                         : 2097152;
                    const responseBytes = Buffer.byteLength(buffer, 'utf8');
                    if (responseBytes > maxBytes) {
                        try {
                            const message = JSON.parse(trimmed);
                             const contents = message?.result?.contents;
                             const isMcpAppResource = Array.isArray(contents) && contents.length > 0 &&
                                 contents.every((item) =>
                                     typeof item?.uri === 'string' &&
                                     item.uri.startsWith('ui://') &&
                                     item?.mimeType === 'text/html;profile=mcp-app'
                                 );
                             if (isMcpAppResource && responseBytes <= maxAppResourceBytes) {
                                 return this.originalStdoutWrite.call(process.stdout, buffer, encoding, callback);
                             }
                            if (message && message.id !== undefined && message.id !== null) {
                                const guarded = JSON.stringify({
                                    jsonrpc: message.jsonrpc || '2.0',
                                    id: message.id,
                                    error: {
                                        code: -32099,
                                        message: 'Desktop Commander response blocked by safety limit (' + responseBytes + ' > ' + maxBytes + ' bytes). Use pagination or reduce output.'
                                    }
                                }) + '\\n';
                                return this.originalStdoutWrite.call(process.stdout, guarded, encoding, callback);
                            }
                        } catch {}
                        const suppressed = JSON.stringify({
                            jsonrpc: '2.0',
                            method: 'notifications/message',
                            params: { level: 'warning', logger: 'desktop-commander', data: 'Oversized JSON-RPC stdout suppressed (' + responseBytes + ' bytes).' }
                        }) + '\\n';
                        return this.originalStdoutWrite.call(process.stdout, suppressed, encoding, callback);
                    }
                    return this.originalStdoutWrite.call(process.stdout, buffer, encoding, callback);`;

if (stdio.includes('WCM_STDOUT_RESPONSE_GUARD_V1') && !stdio.includes('WCM_STDOUT_RESPONSE_GUARD_V2')) {
  const v1Start = stdio.indexOf('                    // WCM_STDOUT_RESPONSE_GUARD_V1:');
  const v1EndMarker = '                    return this.originalStdoutWrite.call(process.stdout, buffer, encoding, callback);';
  const v1End = stdio.indexOf(v1EndMarker, v1Start);
  if (v1Start < 0 || v1End < 0) throw new Error('custom-stdio.js V1 guard layout changed; refusing unsafe migration.');
  stdio = stdio.slice(0, v1Start) + newStdioAllowBlock + stdio.slice(v1End + v1EndMarker.length);
  fs.writeFileSync(stdioFile, stdio, 'utf8');
} else if (!stdio.includes('WCM_STDOUT_RESPONSE_GUARD_V2')) {
  if (!stdio.includes(oldStdioAllowBlock)) throw new Error('custom-stdio.js layout changed; refusing unsafe patch.');
  stdio = stdio.replace(oldStdioAllowBlock, newStdioAllowBlock);
  fs.writeFileSync(stdioFile, stdio, 'utf8');
}

console.log('Desktop Commander image and stdout guards applied to version ' + pkg.version + '.');