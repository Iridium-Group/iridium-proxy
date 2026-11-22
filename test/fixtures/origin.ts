/** A controlled origin server for Klyro tests and benchmarks. Everything stays on 127.0.0.1. */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import {
  createServer as createHttp,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { createServer as createHttps } from 'node:https';
import { createServer as createTcp, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { WebSocketServer } from 'ws';

export interface Origin {
  port: number;
  /** Port of the WebSocket echo server (path /ws-echo). */
  wsPort: number;
  server: Server;
  /** TCP connections accepted so far. */
  connections: { count: number };
  /** Requests received per path. */
  hits: Map<string, number>;
  /** Headers of the most recent request per path. */
  lastHeaders: Map<string, IncomingMessage['headers']>;
  /** Resolve this to let /gate continue after the client got the first chunk. */
  gate: { open: () => void };
  close(): Promise<void>;
}

export function selfSignedCert(host = 'origin.test') {
  const dir = mkdtempSync(join(tmpdir(), 'klyro-cert-'));
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      join(dir, 'k.pem'),
      '-out',
      join(dir, 'c.pem'),
      '-subj',
      `/CN=${host}`,
      '-days',
      '2',
      '-addext',
      `subjectAltName=DNS:${host}`,
    ],
    { stdio: 'ignore' },
  );
  return { key: readFileSync(join(dir, 'k.pem')), cert: readFileSync(join(dir, 'c.pem')) };
}

export const PAGE = `<!doctype html><html><head><title>fixture</title><link rel="stylesheet" href="/style.css"><script src="/app.js"></script></head><body><h1 id="hi">hello</h1><a href="/other">other</a><img src="img.png"></body></html>`;

export async function startOrigin(
  options: {
    tls?: { key: Buffer; cert: Buffer };
    /** Every new connection waits this long before the server reads from it, like a handshake across a network. */
    connectDelayMs?: number;
  } = {},
): Promise<Origin> {
  const connections = { count: 0 };
  const hits = new Map<string, number>();
  const lastHeaders = new Map<string, IncomingMessage['headers']>();
  let openGate!: () => void;
  let gatePromise = new Promise<void>((r) => (openGate = r));
  const big = Buffer.alloc(8 * 1024 * 1024, 7);
  const html = Buffer.from(PAGE);
  // Workload fixtures, built once and deterministic.
  const largeHtml = Buffer.from(
    `<!doctype html><html><head><title>large</title></head><body>${Array.from({ length: 12000 }, (_, i) => `<div class="row" id="r${i}"><a href="/item/${i}">item ${i}</a><img src="/assets/${i % 50}.png" alt="a${i}"></div>`).join('')}</body></html>`,
  );
  const cssFile = Buffer.from(
    Array.from(
      { length: 1500 },
      (_, i) =>
        `.c${i}{background:url(/assets/${i % 50}.png);color:#${(i * 2654435).toString(16).slice(0, 6).padStart(6, '0')}}`,
    ).join('\n'),
  );
  const jsFile = Buffer.from(
    `"use strict";${Array.from({ length: 2500 }, (_, i) => `function f${i}(a,b){return a*${i}+b}`).join('')}`,
  );
  const png = Buffer.alloc(2048, 3);
  const pageWith = (tags: string) =>
    Buffer.from(`<!doctype html><html><head><title>w</title>${tags}</head><body>ok</body></html>`);
  const cssPage = pageWith(
    Array.from({ length: 20 }, (_, i) => `<link rel="stylesheet" href="/css/${i}.css">`).join(''),
  );
  const jsPage = pageWith(
    Array.from({ length: 20 }, (_, i) => `<script src="/js/${i}.js"></script>`).join(''),
  );
  const manyPage = Buffer.from(
    `<!doctype html><html><body>${Array.from({ length: 100 }, (_, i) => `<img src="/assets/${i}.png">`).join('')}</body></html>`,
  );

  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const path = url.pathname;
    hits.set(path, (hits.get(path) ?? 0) + 1);
    // ?delay=ms makes the origin answer after a pause, like a site across a real network.
    const delay = Number(url.searchParams.get('delay') ?? 0);
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    lastHeaders.set(path, req.headers);
    const send = (
      status: number,
      headers: Record<string, string | number | string[]>,
      body?: Buffer | string,
    ) => {
      res.writeHead(status, headers);
      res.end(body);
    };
    switch (path) {
      case '/large.html':
        return send(200, { 'content-type': 'text/html; charset=utf-8' }, largeHtml);
      case '/css-heavy.html':
        return send(200, { 'content-type': 'text/html; charset=utf-8' }, cssPage);
      case '/js-heavy.html':
        return send(200, { 'content-type': 'text/html; charset=utf-8' }, jsPage);
      case '/many.html':
        return send(200, { 'content-type': 'text/html; charset=utf-8' }, manyPage);
      case '/image.png':
        return send(200, { 'content-type': 'image/png', 'content-length': big.length }, big);
      case '/stream': {
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        const chunk = Buffer.alloc(64 * 1024, 5);
        for (let i = 0; i < 32; i++)
          if (!res.write(chunk)) await new Promise((r) => res.once('drain', r));
        return void res.end();
      }
      case '/json':
        return send(200, { 'content-type': 'application/json' }, '{"ok":true}');
      case '/app.html':
        return send(
          200,
          { 'content-type': 'text/html; charset=utf-8' },
          `<!doctype html><html><head><title>app</title></head><body><h1 id="hi">app</h1><a id="next" href="/static.html">next</a><pre id="out">pending</pre><script>
(async () => {
  const out = {};
  out.fetchRoot = (await (await fetch('/json')).json()).ok;
  out.fetchRelative = (await (await fetch('json')).json()).ok;
  out.fetchAbsolute = (await (await fetch(location.href.replace(/^.*\\/k\\/[^/]+\\/(https?)\\/([^/]+)\\/.*$/, '$1://$2') + '/json')).json()).ok;
  out.xhr = await new Promise((res) => { const q = new XMLHttpRequest(); q.open('GET', '/json'); q.onload = () => res(JSON.parse(q.responseText).ok); q.onerror = () => res('error'); q.send(); });
  const wsPort = new URLSearchParams(location.search).get('ws');
  out.websocket = await new Promise((res) => {
    const ws = new WebSocket('ws://127.0.0.1:' + wsPort + '/ws-echo');
    ws.onmessage = (e) => { if (!String(e.data).startsWith('cookie:')) { res(e.data); ws.close(); } };
    ws.onopen = () => ws.send('hello-ws');
    ws.onerror = () => res('error');
  });
  document.getElementById('out').textContent = JSON.stringify(out);
})();
</script></body></html>`,
        );
      case '/many-hosts.html':
        return send(
          200,
          { 'content-type': 'text/html; charset=utf-8' },
          `<!doctype html><html><head><title>hosts</title>${Array.from({ length: 30 }, (_, i) => `<link rel="stylesheet" href="http://host${i}.example.test/s.css">`).join('')}</head><body>x</body></html>`,
        );
      case '/tall.html':
        // A page much taller than a window, for scroll position tests.
        return send(
          200,
          { 'content-type': 'text/html; charset=utf-8' },
          '<!doctype html><title>tall</title><h1>tall</h1><div style="height:6000px">content</div><p id="end">end</p>',
        );
      case '/static.html':
        return send(200, { 'content-type': 'text/html; charset=utf-8' }, html);
      case '/style.css':
        return send(200, { 'content-type': 'text/css' }, 'body{background:url(/bg.png)}');
      case '/app.js':
        return send(200, { 'content-type': 'application/javascript' }, 'document.title="js ran";');
      case '/cacheable-asset':
        return send(
          200,
          { 'content-type': 'image/png', 'cache-control': 'max-age=300', etag: '"a1"' },
          png,
        );
      case '/gzip.html':
        return send(
          200,
          { 'content-type': 'text/html', 'content-encoding': 'gzip' },
          gzipSync(html),
        );
      case '/gzip.js': {
        const body = gzipSync('console.log("hi")'.repeat(100));
        return send(
          200,
          {
            'content-type': 'application/javascript',
            'content-encoding': 'gzip',
            'content-length': body.length,
          },
          body,
        );
      }
      case '/big':
        return send(
          200,
          { 'content-type': 'application/octet-stream', 'content-length': big.length },
          big,
        );
      case '/video.mp4':
        return send(200, { 'content-type': 'video/mp4', 'content-length': big.length }, big);
      case '/range': {
        const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? '');
        const data = Buffer.from('0123456789'.repeat(10));
        if (!m) return send(200, { 'content-type': 'text/plain', 'accept-ranges': 'bytes' }, data);
        const start = Number(m[1]);
        const end = m[2] ? Number(m[2]) : data.length - 1;
        return send(
          206,
          { 'content-type': 'text/plain', 'content-range': `bytes ${start}-${end}/${data.length}` },
          data.subarray(start, end + 1),
        );
      }
      case '/gate': {
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        res.write('first');
        await gatePromise;
        res.end('second');
        return;
      }
      case '/redirect':
        return send(302, { location: '/static.html' });
      case '/redirect-abs':
        return send(302, { location: url.searchParams.get('to') ?? '/' });
      case '/redirect-loop':
        return send(302, { location: '/redirect-loop' });
      case '/cookie-set':
        return send(
          200,
          {
            'content-type': 'text/plain',
            'set-cookie': ['sid=abc123; Path=/', 'theme=dark; Path=/'],
          },
          'ok',
        );
      case '/cookie-echo':
        return send(200, { 'content-type': 'text/plain' }, req.headers.cookie ?? '');
      case '/headers':
        return send(200, { 'content-type': 'application/json' }, JSON.stringify(req.headers));
      case '/cacheable':
        return send(
          200,
          { 'content-type': 'text/plain', 'cache-control': 'max-age=60', etag: '"v1"' },
          'cached body',
        );
      case '/revalidate': {
        if (req.headers['if-none-match'] === '"r1"')
          return send(304, { etag: '"r1"', 'cache-control': 'max-age=0' });
        return send(
          200,
          { 'content-type': 'text/plain', 'cache-control': 'max-age=0', etag: '"r1"' },
          'revalidated body',
        );
      }
      case '/no-store':
        return send(
          200,
          { 'content-type': 'text/plain', 'cache-control': 'no-store, max-age=60' },
          'secret',
        );
      case '/cacheable-cookie':
        return send(
          200,
          { 'content-type': 'text/plain', 'cache-control': 'max-age=60', 'set-cookie': 'x=1' },
          'body',
        );
      case '/echo': {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        return send(200, { 'content-type': 'application/octet-stream' }, Buffer.concat(chunks));
      }
      case '/csp':
        return send(
          200,
          {
            'content-type': 'text/html',
            'content-security-policy': "default-src 'none'",
            'x-frame-options': 'DENY',
          },
          html,
        );
      case '/slow':
        return void setTimeout(() => send(200, {}, 'late'), 3000);
      case '/private-redirect':
        return send(302, { location: 'http://localhost:1/secret' });
      default: {
        if (/^\/assets\/\d+\.png$/.test(path))
          return send(
            200,
            { 'content-type': 'image/png', 'cache-control': 'max-age=300', etag: `"p${path}"` },
            png,
          );
        if (/^\/css\/\d+\.css$/.test(path))
          return send(200, { 'content-type': 'text/css', 'cache-control': 'max-age=300' }, cssFile);
        if (/^\/js\/\d+\.js$/.test(path))
          return send(
            200,
            { 'content-type': 'application/javascript', 'cache-control': 'max-age=300' },
            jsFile,
          );
        return send(404, { 'content-type': 'text/plain' }, 'not found');
      }
    }
  };

  const server = options.tls ? createHttps(options.tls, handler) : createHttp(handler);
  // A Node HTTP server takes control of a socket as soon as it is accepted, so pausing it afterwards
  // does nothing. To simulate a slow handshake, accept connections with a plain TCP server that
  // holds each one for a while, then hand it to the HTTP (or HTTPS) server.
  const front = createTcp({ pauseOnConnect: true }, (socket) => {
    connections.count += 1;
    setTimeout(() => {
      server.emit('connection', socket);
      socket.resume();
    }, options.connectDelayMs ?? 0);
  });
  // WebSocket echo lives on its own port. A Node server with an 'upgrade' listener takes over any
  // connection that sends an Upgrade header (libcurl sends h2c), which would break keep-alive for
  // the plain HTTP routes above.
  const wsServer = createHttp();
  const wss = new WebSocketServer({ server: wsServer, path: '/ws-echo' });
  wss.on('connection', (ws, req) => {
    ws.send(`cookie:${req.headers.cookie ?? ''}`);
    ws.on('message', (d, isBinary) => ws.send(d, { binary: isBinary }));
  });
  await new Promise<void>((r) => wsServer.listen(0, '127.0.0.1', r));
  await new Promise<void>((r) => front.listen(0, '127.0.0.1', r));
  return {
    port: (front.address() as AddressInfo).port,
    wsPort: (wsServer.address() as AddressInfo).port,
    server,
    connections,
    hits,
    lastHeaders,
    gate: {
      open: () => {
        openGate();
        gatePromise = new Promise<void>((r) => (openGate = r));
      },
    },
    close: () =>
      new Promise((resolve) => {
        wss.close();
        wsServer.close();
        wsServer.closeAllConnections();
        front.close();
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
