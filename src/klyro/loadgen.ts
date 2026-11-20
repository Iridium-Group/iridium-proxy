import { Agent, request, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { performance } from 'node:perf_hooks';

export interface LoadOptions {
  url: string;
  requests: number;
  concurrency: number;
  warmup?: number;
  headers?: Record<string, string>;
  method?: string;
  /** Replace the URL per request (for example to defeat caching or hit many assets). */
  urlFor?: (i: number) => string;
}

export interface Summary {
  min: number;
  mean: number;
  p50: number;
  p90: number;
  p95: number;
  p99: number;
  max: number;
}

export interface LoadResult {
  requests: number;
  ok: number;
  failed: number;
  durationSeconds: number;
  requestsPerSecond: number;
  /** Milliseconds to the first response byte. */
  ttfb: Summary;
  /** Milliseconds for the whole response. */
  total: Summary;
  /** Milliseconds to open new client connections. */
  connect: Summary;
  bytes: number;
  newConnections: number;
  statusCounts: Record<string, number>;
}

/** Nearest-rank percentile of an ascending-sorted array. */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))]!;
}

export function summarize(values: readonly number[]): Summary {
  const s = [...values].sort((a, b) => a - b);
  const sum = s.reduce((a, b) => a + b, 0);
  return {
    min: s[0] ?? NaN,
    mean: s.length ? sum / s.length : NaN,
    p50: percentile(s, 50),
    p90: percentile(s, 90),
    p95: percentile(s, 95),
    p99: percentile(s, 99),
    max: s[s.length - 1] ?? NaN,
  };
}

interface One {
  ok: boolean;
  status: number;
  ttfb: number;
  total: number;
  bytes: number;
}

/**
 * Closed-loop load generator: `concurrency` workers each send the next request as soon as the
 * previous one finishes, over keep-alive connections. Measures only what it observes.
 */
export async function runLoad(options: LoadOptions): Promise<LoadResult> {
  const { concurrency } = options;
  const agent = new Agent({
    keepAlive: true,
    maxSockets: concurrency,
    maxFreeSockets: concurrency,
  });
  const connectTimes: number[] = [];
  const send = (urlText: string): Promise<One> =>
    new Promise((resolve) => {
      const url = new URL(urlText);
      const start = performance.now();
      let ttfb = NaN;
      let bytes = 0;
      const doRequest = url.protocol === 'https:' ? httpsRequest : request;
      const req = doRequest(
        url,
        { agent, method: options.method ?? 'GET', headers: options.headers },
        (res: IncomingMessage) => {
          ttfb = performance.now() - start;
          res.on('data', (c: Buffer) => (bytes += c.length));
          res.on('end', () =>
            resolve({
              ok: (res.statusCode ?? 0) < 400,
              status: res.statusCode ?? 0,
              ttfb,
              total: performance.now() - start,
              bytes,
            }),
          );
          res.on('error', () =>
            resolve({ ok: false, status: 0, ttfb, total: performance.now() - start, bytes }),
          );
        },
      );
      req.once('socket', (socket) => {
        if (!req.reusedSocket) {
          const t0 = performance.now();
          if (socket.connecting)
            socket.once('connect', () => connectTimes.push(performance.now() - t0));
        }
      });
      req.on('error', () =>
        resolve({ ok: false, status: 0, ttfb, total: performance.now() - start, bytes }),
      );
      req.end();
    });

  const pick = (i: number) => options.urlFor?.(i) ?? options.url;
  for (let i = 0; i < (options.warmup ?? 0); i++) await send(pick(-1 - i));
  connectTimes.length = 0;

  const results: One[] = [];
  let next = 0;
  const begin = performance.now();
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      for (;;) {
        const i = next++;
        if (i >= options.requests) return;
        results.push(await send(pick(i)));
      }
    }),
  );
  const seconds = (performance.now() - begin) / 1000;
  agent.destroy();

  const ok = results.filter((r) => r.ok);
  const statusCounts: Record<string, number> = {};
  for (const r of results)
    statusCounts[String(r.status)] = (statusCounts[String(r.status)] ?? 0) + 1;
  return {
    requests: results.length,
    ok: ok.length,
    failed: results.length - ok.length,
    durationSeconds: seconds,
    requestsPerSecond: results.length / seconds,
    ttfb: summarize(ok.map((r) => r.ttfb)),
    total: summarize(ok.map((r) => r.total)),
    connect: summarize(connectTimes),
    bytes: results.reduce((a, r) => a + r.bytes, 0),
    newConnections: connectTimes.length,
    statusCounts,
  };
}

/** Parse the Prometheus text format into name -> sum over labels. */
export function parseMetrics(text: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const m = /^([a-zA-Z_:][\w:]*)(?:\{[^}]*\})?\s+(-?[\d.eE+]+|NaN|\+Inf)$/.exec(line);
    if (m) out[m[1]!] = (out[m[1]!] ?? 0) + Number(m[2]);
  }
  return out;
}

export async function scrapeMetrics(origin: string): Promise<Record<string, number> | null> {
  try {
    const res = await fetch(new URL('/metrics', origin), { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return null;
    const parsed = parseMetrics(await res.text());
    return 'klyro_process_cpu_seconds_total' in parsed ? parsed : null;
  } catch {
    return null;
  }
}
