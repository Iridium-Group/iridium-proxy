import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { IridiumConfig } from '@iridium-group/config';
import type { LookupFunction } from '@iridium-group/transport';
import { WebSocketServer } from 'ws';
import { createKlyro, type Klyro } from './klyro/klyro.ts';
import { klyroConfigFromEnv, type KlyroConfig } from './klyro/config.ts';
import { createLogger, type Logger } from './logger.ts';
import { serveStatic } from './static.ts';
import { UsageMeter } from './usage.ts';
import { handleWispClient } from './wisp.ts';

export interface ProxyServer {
  server: Server;
  /** The native HTTP proxy (sessions, cache, pool, metrics). */
  klyro: Klyro;
  /** Start listening on the configured host and port (or `port` to override, 0 for any). */
  listen(port?: number): Promise<AddressInfo>;
  close(): Promise<void>;
}

export interface ProxyOptions {
  logger?: Logger;
  /** Bandwidth meter. Defaults to a counter with no cap. */
  usage?: UsageMeter;
  /** Replace DNS resolution, for tests. */
  lookup?: LookupFunction;
  /** Klyro limits. Defaults come from the environment (MAX_SESSIONS, CACHE_SIZE, ...). */
  klyro?: Partial<KlyroConfig>;
  /** Extra trusted CA certificates for origin TLS (tests and private origins). */
  ca?: string | Buffer;
}

function normalizePath(path: string): string {
  return path.endsWith('/') ? path : `${path}/`;
}

/** Build the server described by a resolved config. Nothing listens until `listen()`. */
export function createProxyServer(config: IridiumConfig, options: ProxyOptions = {}): ProxyServer {
  const logger = options.logger ?? createLogger(config.logging.level, config.logging.format);
  const klyro = createKlyro({
    logger,
    config: { ...klyroConfigFromEnv(), ...options.klyro },
    security: {
      blockPrivateAddresses: config.security.blockPrivateAddresses,
      blockedPorts: config.security.blockedPorts,
      ...(config.security.allowedPorts ? { allowedPorts: config.security.allowedPorts } : {}),
    },
    ...(options.lookup ? { resolve: options.lookup } : {}),
    ...(options.ca ? { ca: options.ca } : {}),
  });
  // Wisp shares Klyro's address policy, so both get the same validation and cached DNS.
  const policy = klyro.address;
  const usage = options.usage ?? new UsageMeter();
  const wispPath = normalizePath(config.server.wispPath);
  const basePath = config.server.basePath;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

  const server = createServer(async (req, res) => {
    if (await klyro.handle(req, res)) return;
    // Needed for SharedArrayBuffer, which the browser client's transport layer uses.
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    const pathname = (req.url ?? '/').split('?')[0];
    if (pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(`${JSON.stringify({ status: 'ok', usage: usage.snapshot() })}\n`);
      return;
    }
    if (normalizePath(pathname ?? '') === wispPath) {
      res.writeHead(426, { 'content-type': 'text/plain', upgrade: 'websocket' });
      res.end('WebSocket upgrade required\n');
      return;
    }
    if (await serveStatic(req, res, config.server.staticDir, basePath)) return;
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found\n');
  });

  server.on('upgrade', (req, socket, head) => {
    if (klyro.upgrade(req, socket, head)) return;
    const pathname = (req.url ?? '/').split('?')[0] ?? '';
    if (normalizePath(pathname) !== wispPath) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      logger.debug('wisp client connected', { remote: req.socket.remoteAddress });
      handleWispClient(ws, {
        policy,
        logger,
        connectTimeoutMs: config.transport.connectTimeoutMs,
        usage,
      });
    });
  });

  return {
    server,
    klyro,
    listen: (port) =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port ?? config.server.port, config.server.host, () => {
          server.off('error', reject);
          const address = server.address() as AddressInfo;
          logger.info('listening', { host: address.address, port: address.port, wisp: wispPath });
          resolve(address);
        });
      }),
    close: () =>
      new Promise((resolve) => {
        usage.save();
        void klyro.close();
        for (const client of wss.clients) client.close(1001);
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
