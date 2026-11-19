import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { applyDefaults } from '@iridium-group/config';
import {
  CloseReason,
  PacketType,
  decodePacket,
  encodeConnect,
  encodeData,
  type WispPacket,
} from '@iridium-group/transport';
import { WebSocket } from 'ws';
import { createLogger, createProxyServer, parseSize, UsageMeter } from '../src/index.ts';

describe('parseSize', () => {
  it('reads sizes with units', () => {
    assert.equal(parseSize('900MB'), 900_000_000);
    assert.equal(parseSize('1.5 gb'), 1_500_000_000);
    assert.equal(parseSize('2048'), 2048);
    assert.equal(parseSize('lots'), null);
    assert.equal(parseSize('-5MB'), null);
  });
});

describe('UsageMeter', () => {
  it('counts, caps and reports', () => {
    const m = new UsageMeter({ capBytes: 100 });
    assert.equal(m.add(60), false);
    assert.equal(m.add(40), true);
    assert.equal(m.snapshot().exceeded, true);
  });
  it('never caps without a limit', () => {
    const m = new UsageMeter();
    m.add(1e12);
    assert.equal(m.exceeded, false);
  });
  it('resets when the month changes', () => {
    let now = new Date('2026-01-31T23:59:00Z');
    const m = new UsageMeter({ capBytes: 100, now: () => now });
    m.add(150);
    assert.equal(m.exceeded, true);
    now = new Date('2026-02-01T00:00:01Z');
    assert.equal(m.exceeded, false);
    assert.equal(m.snapshot().month, '2026-02');
    assert.equal(m.snapshot().bytes, 0);
  });
  it('survives a restart in the same month but not across months', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'usage-'));
    const file = join(dir, 'usage.json');
    const now = () => new Date('2026-03-10T00:00:00Z');
    const a = new UsageMeter({ capBytes: 1000, file, now });
    a.add(400);
    a.save();
    assert.equal(new UsageMeter({ capBytes: 1000, file, now }).snapshot().bytes, 400);
    const later = () => new Date('2026-04-01T00:00:00Z');
    assert.equal(new UsageMeter({ file, now: later }).snapshot().bytes, 0);
    assert.equal(JSON.parse(await readFile(file, 'utf8')).bytes, 400);
  });
  it('ignores a corrupt file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'usage-'));
    const file = join(dir, 'usage.json');
    await import('node:fs/promises').then((fs) => fs.writeFile(file, '{nope'));
    assert.equal(new UsageMeter({ file }).snapshot().bytes, 0);
  });
});

describe('cap enforced by the proxy', () => {
  it('cuts off a stream at the cap and refuses new ones', async () => {
    const echo = createServer((s) => s.pipe(s));
    await new Promise<void>((r) => echo.listen(0, '127.0.0.1', r));
    const echoPort = (echo.address() as { port: number }).port;
    const usage = new UsageMeter({ capBytes: 1000 });
    const proxy = createProxyServer(
      applyDefaults({
        server: { host: '127.0.0.1' },
        security: { blockPrivateAddresses: false },
      }),
      { logger: createLogger('silent', 'json'), usage },
    );
    const { port } = await proxy.listen(0);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/wisp/`);
    const packets: WispPacket[] = [];
    const waiters: (() => void)[] = [];
    ws.on('message', (d: Buffer) => {
      packets.push(decodePacket(new Uint8Array(d)));
      waiters.splice(0).forEach((w) => w());
    });
    const next = async (match: (p: WispPacket) => boolean) => {
      for (;;) {
        const i = packets.findIndex(match);
        if (i >= 0) return packets.splice(i, 1)[0] as WispPacket;
        await new Promise<void>((r) => waiters.push(r));
      }
    };
    try {
      await new Promise((r) => ws.once('open', r));
      ws.send(encodeConnect(1, '127.0.0.1', echoPort));
      for (let i = 0; i < 20; i++) ws.send(encodeData(1, new Uint8Array(200)));
      const close = await next((p) => p.type === PacketType.CLOSE && p.streamId === 1);
      assert.equal((close as { reason: number }).reason, CloseReason.THROTTLED);
      assert.equal(usage.exceeded, true);

      ws.send(encodeConnect(2, '127.0.0.1', echoPort));
      const refused = await next((p) => p.type === PacketType.CLOSE && p.streamId === 2);
      assert.equal((refused as { reason: number }).reason, CloseReason.THROTTLED);

      const health = (await (await fetch(`http://127.0.0.1:${port}/healthz`)).json()) as {
        usage: { exceeded: boolean; cap: number };
      };
      assert.equal(health.usage.exceeded, true);
      assert.equal(health.usage.cap, 1000);
    } finally {
      ws.close();
      await proxy.close();
      echo.close();
    }
  });
});
