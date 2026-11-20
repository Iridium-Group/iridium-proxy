/**
 * Start the fixture origin plus a default and a "naive" (no pool, no cache) Klyro, print their
 * URLs, and wait. Used to try `klyro benchmark` by hand:
 *
 *   node bench/serve-demo.ts
 *   klyro benchmark --target=<klyro url> --baseline=<naive url>
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startOrigin } from '../test/fixtures/origin.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const origin = await startOrigin();
const start = async (port: number, extra: Record<string, string>) => {
  const proc = spawn(process.execPath, [`${root}bin/klyro.js`], {
    env: {
      ...process.env,
      PORT: String(port),
      IRIDIUM_SERVER__HOST: '127.0.0.1',
      IRIDIUM_SECURITY__BLOCK_PRIVATE_ADDRESSES: 'false',
      IRIDIUM_LOGGING__LEVEL: 'silent',
      RATE_LIMIT: '0',
      ...extra,
    },
    stdio: 'ignore',
    cwd: '/tmp',
  });
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break;
    } catch {
      // Not up yet.
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  const go = await fetch(
    `http://127.0.0.1:${port}/klyro/go?u=${encodeURIComponent(`http://127.0.0.1:${origin.port}/`)}`,
    { redirect: 'manual' },
  );
  const sid = go.headers.get('location')!.split('/')[2];
  return { proc, base: `http://127.0.0.1:${port}/k/${sid}/http/127.0.0.1:${origin.port}` };
};
const a = await start(Number(process.env.KLYRO_PORT ?? 18900), {});
const b = await start(Number(process.env.NAIVE_PORT ?? 18901), {
  KLYRO_POOL: '0',
  CACHE_SIZE: '0',
});
console.log(`direct   http://127.0.0.1:${origin.port}`);
console.log(`klyro    ${a.base}`);
console.log(`naive    ${b.base}`);
process.on('SIGTERM', () => {
  a.proc.kill();
  b.proc.kill();
  process.exit(0);
});
setInterval(() => {}, 1 << 30);
