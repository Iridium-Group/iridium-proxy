/**
 * First-visit benchmark: does opening connections ahead of need (preconnect and a pre-warmed pool)
 * make a cold page load faster? Every new connection to the fixture origin costs a simulated
 * handshake delay, like a real network. Everything runs on loopback.
 *
 *   npm run build && node bench/coldstart.ts [--delay=50] [--runs=15]
 *
 * direct       a browser-like client: a fresh set of up to 6 connections to the site per page load
 * klyro-off    through Klyro with PRECONNECT=0 (origin connections are opened on demand)
 * klyro-on     through Klyro with preconnect and pre-warming (the default)
 *
 * Between runs Klyro's idle timeouts are short, so every page load starts with no origin
 * connections: a cold first visit. The browser-to-Klyro connection is kept open (as HTTP/2 would).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { Agent } from 'node:http';
import { fileURLToPath } from 'node:url';
import { summarize } from '../src/klyro/loadgen.ts';
import { startOrigin } from '../test/fixtures/origin.ts';

const arg = (name: string, fallback: number) =>
  Number(process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback);
const delay = arg('delay', 50);
const runs = arg('runs', 15);
const root = fileURLToPath(new URL('..', import.meta.url));

async function start(port: number, env: Record<string, string>): Promise<ChildProcess> {
  const proc = spawn(process.execPath, [`${root}bin/klyro.js`], {
    env: {
      ...process.env,
      PORT: String(port),
      IRIDIUM_SERVER__HOST: '127.0.0.1',
      IRIDIUM_SECURITY__BLOCK_PRIVATE_ADDRESSES: 'false',
      IRIDIUM_LOGGING__LEVEL: 'silent',
      RATE_LIMIT: '0',
      IDLE_TIMEOUT: '60',
      WARM_IDLE: '3000',
      ...env,
    },
    stdio: 'ignore',
    cwd: '/tmp',
  });
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return proc;
    } catch {
      // Not up yet.
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  proc.kill();
  throw new Error('proxy did not start');
}

/** GET with a given agent; resolves with status, final body, and follows redirects. */
function get(
  url: string,
  agent: Agent,
): Promise<{ status: number; body: string; location?: string }> {
  return new Promise((resolve, reject) => {
    import('node:http').then(({ get: httpGet }) => {
      httpGet(url, { agent }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString(),
            ...(res.headers.location ? { location: res.headers.location } : {}),
          }),
        );
      }).on('error', reject);
    });
  });
}

/** Load a page like a browser: the HTML, then its assets six at a time. Returns milliseconds. */
async function pageLoad(
  entry: string,
  agent: Agent,
  origin: string,
): Promise<{ total: number; html: number }> {
  const t0 = performance.now();
  let page = await get(entry, agent);
  let base = entry;
  while (page.status >= 300 && page.status < 400 && page.location) {
    base = new URL(page.location, origin).href;
    page = await get(base, agent);
  }
  const html = performance.now() - t0;
  const urls = [
    ...new Set(
      [...page.body.matchAll(/(?:src|href)="([^"#]+)"/g)].map((m) => new URL(m[1]!, base).href),
    ),
  ].filter((u) => !u.includes('/klyro/'));
  let i = 0;
  await Promise.all(
    Array.from({ length: 6 }, async () => {
      for (;;) {
        const u = urls[i++];
        if (!u) return;
        await get(u, agent);
      }
    }),
  );
  return { total: performance.now() - t0, html };
}

const origin = await startOrigin({ connectDelayMs: delay });
const base = 19800 + Math.floor(Math.random() * 100);
const off = await start(base, { PRECONNECT: '0' });
const on = await start(base + 1, {});
const results: Record<string, number[]> = { direct: [], 'klyro-off': [], 'klyro-on': [] };
const htmlPhase: Record<string, number[]> = { direct: [], 'klyro-off': [], 'klyro-on': [] };
const keepToKlyro = new Agent({ keepAlive: true, maxSockets: 6 });

for (const page of ['/many.html', '/css-heavy.html']) {
  for (const k of Object.keys(results)) {
    results[k] = [];
    htmlPhase[k] = [];
  }
  for (let i = 0; i < runs; i++) {
    // direct: a new browser-like connection set each time
    const fresh = new Agent({ keepAlive: true, maxSockets: 6 });
    const d = await pageLoad(
      `http://127.0.0.1:${origin.port}${page}?r=${i}`,
      fresh,
      `http://127.0.0.1:${origin.port}`,
    );
    results.direct!.push(d.total);
    htmlPhase.direct!.push(d.html);
    fresh.destroy();
    for (const [name, port] of [
      ['klyro-off', base],
      ['klyro-on', base + 1],
    ] as const) {
      await new Promise((r) => setTimeout(r, 200)); // let the proxy's idle origin connections close: a cold visit
      const entry = `http://127.0.0.1:${port}/klyro/go?u=${encodeURIComponent(`http://127.0.0.1:${origin.port}${page}?r=${name}${i}`)}`;
      const r = await pageLoad(entry, keepToKlyro, `http://127.0.0.1:${port}`);
      results[name]!.push(r.total);
      htmlPhase[name]!.push(r.html);
    }
  }
  const f = (n: number) => n.toFixed(0).padStart(5);
  console.log(`\n${page}, origin connection cost ${delay} ms, ${runs} cold page loads each`);
  console.log('mode       |   p50 |  mean |   min |   max');
  for (const k of Object.keys(results)) {
    const s = summarize(results[k]!);
    console.log(
      `${k.padEnd(10)} | ${f(s.p50)} | ${f(s.mean)} | ${f(s.min)} | ${f(s.max)}   ms   (html phase p50 ${summarize(htmlPhase[k]!).p50.toFixed(0)} ms, assets phase p50 ${(s.p50 - summarize(htmlPhase[k]!).p50).toFixed(0)} ms)`,
    );
  }
  const d = summarize(results.direct!).p50;
  const o = summarize(results['klyro-off']!).p50;
  const n = summarize(results['klyro-on']!).p50;
  console.log(
    `klyro-on is ${(o / n).toFixed(2)}x faster than klyro-off, and ${(d / n).toFixed(2)}x ${n < d ? 'faster than' : 'vs'} direct (p50)`,
  );
}
// What the server itself counted, to check the warm connections are really being used.
for (const [name, port] of [
  ['klyro-off', base],
  ['klyro-on', base + 1],
] as const) {
  const text = await (await fetch(`http://127.0.0.1:${port}/metrics`)).text();
  const m = (k: string) => Number(new RegExp(`^${k} (\\S+)`, 'm').exec(text)?.[1] ?? 0);
  console.log(
    `${name}: origin connections opened ${m('klyro_connections_created_total')}, reused ${m('klyro_connections_reused_total')}; warm opened ${m('klyro_warm_connections_created_total')}, used ${m('klyro_warm_connections_used_total')}, expired unused ${m('klyro_warm_connections_expired_total')}`,
  );
}
off.kill();
on.kill();
await origin.close();
process.exit(0);
