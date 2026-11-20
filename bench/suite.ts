/**
 * Klyro benchmark suite. Starts a controlled fixture origin on 127.0.0.1 and real proxy
 * processes, then runs every workload against each target and writes bench/results/latest.json.
 *
 *   npm run build && npm run bench:suite            full run
 *   npm run build && node bench/suite.ts --quick    short smoke run (used in CI)
 *
 * Targets:
 *   direct       the fixture origin, no proxy
 *   klyro        Klyro with its defaults (connection pool, cache, fast path)
 *   klyro-naive  Klyro with the connection pool and cache switched off (an ablation, to show what
 *                those two features are worth; it is not another product)
 *
 * Everything runs on loopback, so network latency and TLS cost are zero here. Gains from
 * connection reuse and caching are therefore smaller than they would be across a real network.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus, platform, release, totalmem } from 'node:os';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import {
  runLoad,
  scrapeMetrics,
  summarize,
  type LoadResult,
  type Summary,
} from '../src/klyro/loadgen.ts';
import { startOrigin } from '../test/fixtures/origin.ts';

const quick = process.argv.includes('--quick');
const scale = quick ? 0.04 : Number(process.env.BENCH_SCALE ?? 1);
const n = (x: number) => Math.max(5, Math.round(x * scale));

interface Target {
  name: 'direct' | 'klyro' | 'klyro-naive';
  base: string;
  /** Open a session and return a function turning an origin path into this target's URL. */
  open(): Promise<(path: string) => string>;
  wsUrl(path: string): Promise<string>;
  proc?: ChildProcess;
  origin?: string;
}

const root = fileURLToPath(new URL('..', import.meta.url));

async function startProxy(port: number, extra: Record<string, string>): Promise<ChildProcess> {
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
      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return proc;
    } catch {
      // Not up yet.
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  proc.kill();
  throw new Error(`proxy on ${port} did not start (did you run npm run build?)`);
}

async function session(port: number, originPort: number) {
  const res = await fetch(
    `http://127.0.0.1:${port}/klyro/go?u=${encodeURIComponent(`http://127.0.0.1:${originPort}/`)}`,
    { redirect: 'manual' },
  );
  const sid = res.headers.get('location')!.split('/')[2]!;
  return sid;
}

interface Row {
  workload: string;
  target: string;
  p50: number;
  p90: number;
  p95: number;
  p99: number;
  mean: number;
  min: number;
  max: number;
  rps: number;
  ok: number;
  failed: number;
  bytes: number;
  cpuSeconds: number | null;
  rssMb: number | null;
  cacheHitRate: number | null;
  connReuseRate: number | null;
  transformMs: number | null;
  dnsMs: number | null;
  tcpMs: number | null;
}

const rows: Row[] = [];

function addRow(
  workload: string,
  t: Target,
  total: Summary,
  rps: number,
  extra: { ok: number; failed: number; bytes: number; tcp?: number },
  before: Record<string, number> | null,
  after: Record<string, number> | null,
) {
  const d = (k: string) => (before && after ? (after[k] ?? 0) - (before[k] ?? 0) : null);
  const hits = d('klyro_cache_hits_total');
  const misses = d('klyro_cache_misses_total');
  const created = d('klyro_connections_created_total');
  const reused = d('klyro_connections_reused_total');
  const trN = d('klyro_transform_duration_seconds_count');
  const trS = d('klyro_transform_duration_seconds_sum');
  const dnsN = d('klyro_dns_duration_seconds_count');
  const dnsS = d('klyro_dns_duration_seconds_sum');
  rows.push({
    workload,
    target: t.name,
    p50: total.p50,
    p90: total.p90,
    p95: total.p95,
    p99: total.p99,
    mean: total.mean,
    min: total.min,
    max: total.max,
    rps,
    ...extra,
    cpuSeconds: d('klyro_process_cpu_seconds_total'),
    rssMb: after ? (after['klyro_process_resident_memory_bytes'] ?? 0) / 1048576 : null,
    cacheHitRate:
      hits !== null && misses !== null && hits + misses > 0 ? hits / (hits + misses) : null,
    connReuseRate:
      created !== null && reused !== null && created + reused > 0
        ? reused / (created + reused)
        : null,
    transformMs: trN ? ((trS ?? 0) / trN) * 1000 : null,
    dnsMs: dnsN ? ((dnsS ?? 0) / dnsN) * 1000 : null,
    tcpMs: extra.tcp ?? null,
  });
}

/** Fetch a page and everything it references, 6 at a time like a browser. Returns ms for the whole load. */
async function pageLoad(pageUrl: string): Promise<{ ms: number; bytes: number; ok: boolean }> {
  const start = performance.now();
  let bytes = 0;
  const res = await fetch(pageUrl);
  const html = await res.text();
  bytes += html.length;
  const urls = [...html.matchAll(/(?:src|href)="([^"#]+)"/g)]
    .map((m) => new URL(m[1]!, pageUrl).href)
    .filter((u) => !/\/other$|\/item\//.test(u));
  const unique = [...new Set(urls)];
  let i = 0;
  let ok = res.ok;
  await Promise.all(
    Array.from({ length: 6 }, async () => {
      for (;;) {
        const u = unique[i++];
        if (!u) return;
        const r = await fetch(u);
        ok &&= r.ok;
        bytes += (await r.arrayBuffer()).byteLength;
      }
    }),
  );
  return { ms: performance.now() - start, bytes, ok };
}

async function main() {
  const origin = await startOrigin();
  const proxyPort = 18700 + Math.floor(Math.random() * 200);
  const kProc = await startProxy(proxyPort, {});
  const nProc = await startProxy(proxyPort + 1, { KLYRO_POOL: '0', CACHE_SIZE: '0' });
  const targets: Target[] = [
    {
      name: 'direct',
      base: `http://127.0.0.1:${origin.port}`,
      open: async () => (p) => `http://127.0.0.1:${origin.port}${p}`,
      wsUrl: async (p) => `ws://127.0.0.1:${origin.wsPort}${p}`,
    },
    ...(
      [
        ['klyro', proxyPort, kProc],
        ['klyro-naive', proxyPort + 1, nProc],
      ] as const
    ).map(([name, port, proc]): Target => ({
      name,
      base: `http://127.0.0.1:${port}`,
      origin: `http://127.0.0.1:${port}`,
      proc,
      open: async () => {
        const sid = await session(port, origin.port);
        return (p) => `http://127.0.0.1:${port}/k/${sid}/http/127.0.0.1:${origin.port}${p}`;
      },
      wsUrl: async (p) => {
        const sid = await session(port, origin.port);
        return `ws://127.0.0.1:${port}/k/${sid}/ws/127.0.0.1:${origin.wsPort}${p}`;
      },
    })),
  ];

  const log = (s: string) => process.stderr.write(`${s}\n`);
  const around = async (t: Target, fn: () => Promise<void>) => {
    const before = t.origin ? await scrapeMetrics(t.origin) : null;
    await fn();
    const after = t.origin ? await scrapeMetrics(t.origin) : null;
    return { before, after };
  };

  // --- single-URL workloads ---
  const single: {
    name: string;
    path: string;
    requests: number;
    concurrency: number;
    headers?: Record<string, string>;
    unique?: boolean;
  }[] = [
    { name: '1 static HTML', path: '/static.html', requests: n(3000), concurrency: 50 },
    { name: '2 large HTML (~1.4 MB)', path: '/large.html', requests: n(120), concurrency: 8 },
    { name: '6 large image (8 MB)', path: '/image.png', requests: n(40), concurrency: 4 },
    {
      name: '7 streaming response (2 MB, chunked)',
      path: '/stream',
      requests: n(150),
      concurrency: 10,
    },
    {
      name: '8 range request',
      path: '/range',
      requests: n(3000),
      concurrency: 50,
      headers: { range: 'bytes=10-59' },
    },
  ];
  for (const w of single) {
    for (const t of targets) {
      log(`${w.name} · ${t.name}`);
      const url = await t.open();
      let res!: LoadResult;
      const m = await around(t, async () => {
        res = await runLoad({
          url: url(w.path),
          requests: w.requests,
          concurrency: w.concurrency,
          warmup: n(20),
          ...(w.headers ? { headers: w.headers } : {}),
        });
      });
      addRow(
        w.name,
        t,
        res.total,
        res.requestsPerSecond,
        { ok: res.ok, failed: res.failed, bytes: res.bytes, tcp: res.connect.mean },
        m.before,
        m.after,
      );
    }
  }

  // --- page-load workloads (HTML plus its subresources) ---
  const pages: { name: string; path: string; loads: number; repeat?: boolean }[] = [
    { name: '3 CSS-heavy page (20 stylesheets)', path: '/css-heavy.html', loads: n(60) },
    { name: '4 JavaScript-heavy page (20 scripts)', path: '/js-heavy.html', loads: n(60) },
    { name: '5 many small assets (100 images)', path: '/many.html', loads: n(60) },
    {
      name: '10 repeated navigation (same page 40x)',
      path: '/many.html',
      loads: n(40),
      repeat: true,
    },
  ];
  for (const w of pages) {
    for (const t of targets) {
      log(`${w.name} · ${t.name}`);
      const url = await t.open();
      const times: number[] = [];
      let bytes = 0;
      let failed = 0;
      const m = await around(t, async () => {
        const begin = performance.now();
        await pageLoad(url(w.path)); // warm-up load
        const start = performance.now();
        for (let i = 0; i < w.loads; i++) {
          const r = await pageLoad(url(w.path));
          times.push(r.ms);
          bytes += r.bytes;
          if (!r.ok) failed += 1;
        }
        void begin;
        rowSeconds = (performance.now() - start) / 1000;
      });
      addRow(
        w.name,
        t,
        summarize(times),
        times.length / rowSeconds,
        { ok: times.length - failed, failed, bytes },
        m.before,
        m.after,
      );
    }
  }

  // --- WebSocket echo round trips ---
  for (const t of targets) {
    log(`9 WebSocket echo · ${t.name}`);
    const wsUrl = await t.wsUrl('/ws-echo');
    const ws = new WebSocket(wsUrl);
    // Queue every message from the start, so the server's greeting cannot be missed.
    const inbox: Buffer[] = [];
    let wake: (() => void) | undefined;
    ws.on('message', (d: Buffer) => {
      inbox.push(d);
      wake?.();
    });
    const nextMessage = async () => {
      while (inbox.length === 0) await new Promise<void>((r) => (wake = r));
      return inbox.shift()!;
    };
    await new Promise((r, j) => (ws.once('open', r), ws.once('error', j)));
    await nextMessage(); // greeting
    const times: number[] = [];
    const m = await around(t, async () => {
      const msg = Buffer.alloc(256, 1);
      const start = performance.now();
      for (let i = 0; i < n(2000); i++) {
        const t0 = performance.now();
        ws.send(msg);
        await nextMessage();
        times.push(performance.now() - t0);
      }
      rowSeconds = (performance.now() - start) / 1000;
    });
    ws.close();
    addRow(
      '9 WebSocket echo round trip (256 B)',
      t,
      summarize(times),
      times.length / rowSeconds,
      { ok: times.length, failed: 0, bytes: times.length * 512 },
      m.before,
      m.after,
    );
  }

  // --- concurrent sessions: 50 clients, each with its own session ---
  for (const t of targets) {
    log(`11 concurrent sessions · ${t.name}`);
    const clients = n(50);
    const perClient = n(40);
    const times: number[] = [];
    let failed = 0;
    let bytes = 0;
    const m = await around(t, async () => {
      const start = performance.now();
      await Promise.all(
        Array.from({ length: clients }, async () => {
          const url = await t.open();
          for (let i = 0; i < perClient; i++) {
            const t0 = performance.now();
            const r = await fetch(url(`/static.html?i=${i}`));
            bytes += (await r.arrayBuffer()).byteLength;
            if (!r.ok) failed += 1;
            times.push(performance.now() - t0);
          }
        }),
      );
      rowSeconds = (performance.now() - start) / 1000;
    });
    addRow(
      `11 concurrent sessions (${clients} sessions)`,
      t,
      summarize(times),
      times.length / rowSeconds,
      { ok: times.length - failed, failed, bytes },
      m.before,
      m.after,
    );
  }

  for (const p of [kProc, nProc]) p.kill();
  await origin.close();

  report();
}
let rowSeconds = 1;

function report() {
  const f = (x: number) => (Number.isFinite(x) ? x.toFixed(x < 10 ? 2 : 1) : 'n/a');
  const byWorkload = [...new Set(rows.map((r) => r.workload))];
  const out: string[] = [];
  out.push(
    `| Workload | Target | p50 ms | p90 ms | p95 ms | p99 ms | req/s | vs direct | vs naive | CPU s | RSS MB | cache hit | conn reuse | failed |`,
  );
  out.push(`|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|`);
  for (const w of byWorkload) {
    const direct = rows.find((r) => r.workload === w && r.target === 'direct')!;
    const naive = rows.find((r) => r.workload === w && r.target === 'klyro-naive')!;
    for (const r of rows.filter((x) => x.workload === w)) {
      out.push(
        `| ${r.workload} | ${r.target} | ${f(r.p50)} | ${f(r.p90)} | ${f(r.p95)} | ${f(r.p99)} | ${f(r.rps)} | ${f(r.rps / direct.rps)}x | ${r.target === 'klyro' ? `${f(r.rps / naive.rps)}x` : '-'} | ${r.cpuSeconds === null ? '-' : f(r.cpuSeconds)} | ${r.rssMb === null ? '-' : f(r.rssMb)} | ${r.cacheHitRate === null ? '-' : `${(r.cacheHitRate * 100).toFixed(0)}%`} | ${r.connReuseRate === null ? '-' : `${(r.connReuseRate * 100).toFixed(0)}%`} | ${r.failed} |`,
      );
    }
  }
  const info = {
    node: process.version,
    platform: `${platform()} ${release()}`,
    cpus: cpus().length,
    cpuModel: cpus()[0]?.model,
    memGb: Math.round(totalmem() / 2 ** 30),
    quick,
    scale,
  };
  mkdirSync(`${root}bench/results`, { recursive: true });
  writeFileSync(
    `${root}bench/results/${quick ? 'quick' : 'latest'}.json`,
    JSON.stringify({ info, date: new Date().toISOString(), rows }, null, 2),
  );
  process.stdout.write(`${out.join('\n')}\n\nEnvironment: ${JSON.stringify(info)}\n`);
  const bad = rows.filter((r) => r.failed > 0);
  if (bad.length) {
    process.stderr.write(
      `FAILED requests in: ${bad.map((r) => `${r.workload}/${r.target}`).join(', ')}\n`,
    );
    process.exitCode = 1;
  }
}

await main();
