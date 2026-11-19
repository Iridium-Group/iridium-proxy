/**
 * Benchmark the proxy against a local TCP sink/echo. Prints throughput and round-trip latency.
 *
 *   npm run build && node bench/bench.ts
 */
import { createServer } from 'node:net';
import { performance } from 'node:perf_hooks';
import { resolveConfig } from '@iridium-group/config';
import { PacketType, decodePacket, encodeConnect, encodeData } from '@iridium-group/transport';
import { WebSocket } from 'ws';
import { createProxyServer } from '../src/index.ts';

const MB = 1024 * 1024;
const TOTAL = Number(process.env.BENCH_MB ?? 256) * MB;
const CHUNK = 16 * 1024;
const PINGS = Number(process.env.BENCH_PINGS ?? 5000);

const echo = createServer((s) => {
  s.setNoDelay(true);
  s.pipe(s);
});
await new Promise<void>((r) => echo.listen(0, '127.0.0.1', r));
const echoPort = (echo.address() as { port: number }).port;

const proxy = createProxyServer(
  resolveConfig(
    {
      server: { host: '127.0.0.1' },
      security: { blockPrivateAddresses: false },
      logging: { level: 'silent' },
    },
    { env: false },
  ),
);
const { port } = await proxy.listen(0);

async function open(streamId: number) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/wisp/`, { perMessageDeflate: false });
  let received = 0;
  let onData: (() => void) | undefined;
  let credit = 0;
  let creditWaiter: (() => void) | undefined;
  ws.on('message', (d: Buffer) => {
    const p = decodePacket(new Uint8Array(d.buffer, d.byteOffset, d.byteLength));
    if ('unknown' in p) return;
    if (p.type === PacketType.CONTINUE && p.streamId === streamId) {
      credit = p.bufferRemaining;
      creditWaiter?.();
    } else if (p.type === PacketType.CONTINUE && p.streamId === 0) {
      credit = p.bufferRemaining;
    } else if (p.type === PacketType.DATA) {
      received += p.payload.byteLength;
      onData?.();
    }
  });
  await new Promise((r) => ws.once('open', r));
  ws.send(encodeConnect(streamId, '127.0.0.1', echoPort));
  return {
    ws,
    get received() {
      return received;
    },
    waitFor: (n: number) =>
      new Promise<void>((resolve) => {
        onData = () => received >= n && resolve();
        onData();
      }),
    async send(buf: Uint8Array) {
      while (credit <= 0) await new Promise<void>((r) => (creditWaiter = r));
      credit -= 1;
      ws.send(encodeData(streamId, buf));
    },
  };
}

// Throughput: push TOTAL bytes through the echo and wait for all of it to come back.
{
  const c = await open(1);
  const payload = new Uint8Array(CHUNK).fill(7);
  const start = performance.now();
  const done = c.waitFor(TOTAL);
  for (let sent = 0; sent < TOTAL; sent += CHUNK) await c.send(payload);
  await done;
  const secs = (performance.now() - start) / 1000;
  console.log(
    `throughput: ${(TOTAL / MB / secs).toFixed(0)} MB/s each way (${TOTAL / MB} MB in ${secs.toFixed(2)}s)`,
  );
  c.ws.close();
}

// Latency: one 64-byte message at a time.
{
  const c = await open(1);
  const msg = new Uint8Array(64);
  const times: number[] = [];
  for (let i = 0; i < PINGS; i++) {
    const before = c.received;
    const t = performance.now();
    await c.send(msg);
    await c.waitFor(before + 64);
    times.push(performance.now() - t);
  }
  times.sort((a, b) => a - b);
  const q = (p: number) => times[Math.floor(times.length * p)]!.toFixed(3);
  console.log(`latency over ${PINGS} round trips: p50 ${q(0.5)} ms, p99 ${q(0.99)} ms`);
  c.ws.close();
}

await proxy.close();
echo.close();
