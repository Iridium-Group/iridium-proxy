import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { applyDefaults, type IridiumConfigInput } from '@iridium-group/config';
import {
  CloseReason,
  PacketType,
  decodePacket,
  encodeConnect,
  encodeData,
  type WispPacket,
} from '@iridium-group/transport';
import { WebSocket } from 'ws';
import { createLogger, createProxyServer, type ProxyServer } from '../src/index.ts';

const logger = createLogger('silent', 'json');

async function startEcho(): Promise<{ port: number; server: Server }> {
  const server = createServer((s) => s.pipe(s));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { port: (server.address() as { port: number }).port, server };
}

async function start(input: IridiumConfigInput) {
  const dir = await mkdtemp(join(tmpdir(), 'proxy-'));
  await mkdir(join(dir, 'sub'));
  await writeFile(join(dir, 'index.html'), '<h1>hi</h1>');
  await writeFile(join(dir, 'sub', 'a.txt'), 'a');
  await writeFile(join(dir, '..secret'), 'no');
  const config = applyDefaults({
    ...input,
    server: { host: '127.0.0.1', staticDir: dir, ...input.server },
  });
  const proxy = createProxyServer(config, { logger });
  const { port } = await proxy.listen(0);
  return { proxy, port, dir };
}

function client(port: number, path = '/wisp/') {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
  const packets: WispPacket[] = [];
  const waiters: (() => void)[] = [];
  ws.on('message', (d: Buffer) => {
    packets.push(decodePacket(new Uint8Array(d)));
    waiters.splice(0).forEach((w) => w());
  });
  const next = async (match: (p: WispPacket) => boolean): Promise<WispPacket> => {
    for (;;) {
      const i = packets.findIndex(match);
      if (i >= 0) return packets.splice(i, 1)[0] as WispPacket;
      await new Promise<void>((r) => waiters.push(r));
    }
  };
  const opened = new Promise<void>((r, j) => {
    ws.once('open', r);
    ws.once('error', j);
  });
  return { ws, next, opened };
}

describe('http', () => {
  let ctx: Awaited<ReturnType<typeof start>>;
  before(async () => (ctx = await start({})));
  after(() => ctx.proxy.close());

  it('answers /healthz', async () => {
    const res = await fetch(`http://127.0.0.1:${ctx.port}/healthz`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { status: string; usage: { cap: number | null } };
    assert.equal(body.status, 'ok');
    assert.equal(body.usage.cap, null);
  });
  it('serves static files and index.html', async () => {
    const res = await fetch(`http://127.0.0.1:${ctx.port}/`);
    assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(await res.text(), '<h1>hi</h1>');
    assert.equal((await fetch(`http://127.0.0.1:${ctx.port}/sub/a.txt`)).status, 200);
  });
  it('returns 404 for missing files and refuses traversal', async () => {
    assert.equal((await fetch(`http://127.0.0.1:${ctx.port}/nope`)).status, 404);
    for (const p of ['/%2e%2e/etc/passwd', '/sub/%2e%2e/%2e%2e/etc/passwd', '/%00']) {
      const res = await fetch(`http://127.0.0.1:${ctx.port}${p}`);
      assert.equal(res.status, 404, p);
    }
  });
  it('tells plain HTTP clients the Wisp path needs an upgrade', async () => {
    assert.equal((await fetch(`http://127.0.0.1:${ctx.port}/wisp/`)).status, 426);
  });
  it('rejects upgrades on other paths', async () => {
    const c = client(ctx.port, '/other');
    await assert.rejects(c.opened);
  });
});

describe('wisp', () => {
  let echo: Awaited<ReturnType<typeof startEcho>>;
  before(async () => (echo = await startEcho()));
  after(() => echo.server.close());

  it('sends the initial CONTINUE and relays data to an allowed target', async () => {
    const { proxy, port } = await start({ security: { blockPrivateAddresses: false } });
    const c = client(port);
    try {
      await c.opened;
      const first = await c.next((p) => p.type === PacketType.CONTINUE);
      assert.equal((first as { streamId: number }).streamId, 0);
      c.ws.send(encodeConnect(1, '127.0.0.1', echo.port));
      c.ws.send(encodeData(1, new TextEncoder().encode('ping')));
      const data = await c.next((p) => p.type === PacketType.DATA);
      assert.equal(new TextDecoder().decode((data as { payload: Uint8Array }).payload), 'ping');
    } finally {
      c.ws.close();
      await proxy.close();
    }
  });

  it('grants more credit for data sent while the host was still resolving', async () => {
    const { proxy, port } = await start({ security: { blockPrivateAddresses: false } });
    const c = client(port);
    try {
      await c.opened;
      const initial = (await c.next((p) => p.type === PacketType.CONTINUE)) as {
        bufferRemaining: number;
      };
      c.ws.send(encodeConnect(7, '127.0.0.1', echo.port));
      // Spend the whole credit straight away, before the connection exists.
      for (let i = 0; i < initial.bufferRemaining; i++) {
        c.ws.send(encodeData(7, new Uint8Array([i & 255])));
      }
      const more = (await c.next((p) => p.type === PacketType.CONTINUE)) as { streamId: number };
      assert.equal(more.streamId, 7);
    } finally {
      c.ws.close();
      await proxy.close();
    }
  });

  it('blocks private addresses by default', async () => {
    const { proxy, port } = await start({});
    const c = client(port);
    try {
      await c.opened;
      c.ws.send(encodeConnect(2, '127.0.0.1', echo.port));
      const close = await c.next((p) => p.type === PacketType.CLOSE);
      assert.equal((close as { reason: number }).reason, CloseReason.BLOCKED);
    } finally {
      c.ws.close();
      await proxy.close();
    }
  });

  it('blocks configured ports and hosts that resolve to private addresses', async () => {
    const { proxy, port } = await start({});
    const c = client(port);
    try {
      await c.opened;
      c.ws.send(encodeConnect(3, 'example.com', 25));
      const a = await c.next((p) => p.type === PacketType.CLOSE);
      assert.equal((a as { reason: number }).reason, CloseReason.BLOCKED);
    } finally {
      c.ws.close();
      await proxy.close();
    }
  });

  it('rejects a duplicate stream id', async () => {
    const { proxy, port } = await start({ security: { blockPrivateAddresses: false } });
    const c = client(port);
    try {
      await c.opened;
      c.ws.send(encodeConnect(5, '127.0.0.1', echo.port));
      c.ws.send(encodeConnect(5, '127.0.0.1', echo.port)); // duplicate id
      const close = await c.next((p) => p.type === PacketType.CLOSE);
      assert.equal((close as { reason: number }).reason, CloseReason.INVALID_INFO);
    } finally {
      c.ws.close();
      await proxy.close();
    }
  });

  it('closes the socket on malformed packets', async () => {
    const { proxy, port } = await start({});
    const c = client(port);
    try {
      await c.opened;
      const closed = new Promise<number>((r) => c.ws.once('close', r));
      c.ws.send(new Uint8Array([1, 2]));
      assert.equal(await closed, 1002);
    } finally {
      await proxy.close();
    }
  });
});

describe('logger', () => {
  it('filters by level and formats json', () => {
    const lines: string[] = [];
    const log = createLogger('warn', 'json', (l) => lines.push(l));
    log.info('hidden');
    log.warn('shown', { a: 1 });
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0] as string).a, 1);
  });
});
