import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.map': 'application/json; charset=utf-8',
};

/**
 * Serve files from `root` under `basePath`. Returns false when the request is not for this
 * handler so the caller can send its own 404. Paths that escape `root` are refused.
 */
export async function serveStatic(
  req: IncomingMessage,
  res: ServerResponse,
  root: string,
  basePath: string,
): Promise<boolean> {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
  } catch {
    return false;
  }
  const prefix = basePath.endsWith('/') ? basePath : `${basePath}/`;
  if (pathname !== basePath && !pathname.startsWith(prefix)) return false;
  if (pathname.includes('\0')) return false;

  const relative = pathname.slice(basePath.length).replace(/^\/+/, '');
  const base = resolve(root);
  let file = resolve(join(base, normalize(relative)));
  if (file !== base && !file.startsWith(base + sep)) return false;

  try {
    let info = await stat(file);
    if (info.isDirectory()) {
      file = join(file, 'index.html');
      info = await stat(file);
    }
    if (!info.isFile()) return false;
    res.writeHead(200, {
      'content-type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'content-length': info.size,
      'x-content-type-options': 'nosniff',
    });
    if (req.method === 'HEAD') {
      res.end();
      return true;
    }
    createReadStream(file)
      .on('error', () => res.destroy())
      .pipe(res);
    return true;
  } catch {
    return false;
  }
}
