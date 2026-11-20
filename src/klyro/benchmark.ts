import { parseArgs } from 'node:util';
import { runLoad, scrapeMetrics, type LoadResult, type Summary } from './loadgen.ts';

const ms = (n: number) => (Number.isFinite(n) ? `${n.toFixed(2)} ms` : 'n/a');

export const BENCHMARK_USAGE = `Usage: klyro benchmark --target=<url> [options]

  --target=URL        What to measure (a Klyro /k/... address, or any URL).
  --baseline=URL      Another URL serving the same content, to compare against.
  --requests=N        Requests to send (default 1000).
  --concurrency=N     Simultaneous requests (default 50).
  --warmup=N          Requests sent first and discarded (default 20).
  --target-factor=X   The improvement to test for (default 5).
  --json              Print machine-readable JSON.

The comparison is throughput (requests per second) of --target divided by --baseline. With
no --baseline there is nothing to compare to, and the 5x check is reported as N/A.`;

function describe(label: string, r: LoadResult): string[] {
  const row = (name: string, s: Summary) =>
    `  ${name.padEnd(5)} min ${ms(s.min)}  mean ${ms(s.mean)}  p50 ${ms(s.p50)}  p90 ${ms(s.p90)}  p95 ${ms(s.p95)}  p99 ${ms(s.p99)}  max ${ms(s.max)}`;
  return [
    `${label}`,
    `  requests ${r.requests} (${r.ok} ok, ${r.failed} failed)  ${r.requestsPerSecond.toFixed(1)} req/s  ${(r.bytes / 1e6).toFixed(1)} MB`,
    row('TTFB', r.ttfb),
    row('total', r.total),
    row('TCP', r.connect),
  ];
}

/** Run `klyro benchmark`. Returns the process exit code. */
export async function benchmarkCommand(
  argv: readonly string[],
  write: (s: string) => void,
): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: {
        target: { type: 'string' },
        baseline: { type: 'string' },
        requests: { type: 'string', default: '1000' },
        concurrency: { type: 'string', default: '50' },
        warmup: { type: 'string', default: '20' },
        'target-factor': { type: 'string', default: '5' },
        json: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    }));
  } catch (e) {
    write(`${(e as Error).message}\n\n${BENCHMARK_USAGE}\n`);
    return 2;
  }
  if (values.help || !values.target) {
    write(`${BENCHMARK_USAGE}\n`);
    return values.help ? 0 : 2;
  }
  const requests = Number(values.requests);
  const concurrency = Number(values.concurrency);
  const warmup = Number(values.warmup);
  const factor = Number(values['target-factor']);
  if (
    ![requests, concurrency, warmup, factor].every((n) => Number.isFinite(n) && n >= 0) ||
    requests < 1 ||
    concurrency < 1
  ) {
    write(`requests and concurrency must be positive numbers\n`);
    return 2;
  }
  for (const u of [values.target, values.baseline]) {
    if (u) {
      try {
        new URL(u);
      } catch {
        write(`Not a valid URL: ${u}\n`);
        return 2;
      }
    }
  }

  const measure = async (url: string) => {
    const origin = new URL(url).origin;
    const before = await scrapeMetrics(origin);
    const result = await runLoad({ url, requests, concurrency, warmup });
    const after = await scrapeMetrics(origin);
    return { result, before, after };
  };

  const target = await measure(values.target);
  const baseline = values.baseline ? await measure(values.baseline) : null;

  // Server-side figures exist only when the target exposes Klyro's /metrics.
  const delta = (k: string) =>
    target.after && target.before ? (target.after[k] ?? 0) - (target.before[k] ?? 0) : null;
  const cpu = delta('klyro_process_cpu_seconds_total');
  const hits = delta('klyro_cache_hits_total');
  const misses = delta('klyro_cache_misses_total');
  const created = delta('klyro_connections_created_total');
  const reused = delta('klyro_connections_reused_total');
  const rss = target.after?.['klyro_process_resident_memory_bytes'] ?? null;
  const dnsCount = delta('klyro_dns_duration_seconds_count');
  const dnsSum = delta('klyro_dns_duration_seconds_sum');
  const upCount = delta('klyro_upstream_duration_seconds_count');
  const upSum = delta('klyro_upstream_duration_seconds_sum');
  const trCount = delta('klyro_transform_duration_seconds_count');
  const trSum = delta('klyro_transform_duration_seconds_sum');

  const improvement = baseline
    ? target.result.requestsPerSecond / baseline.result.requestsPerSecond
    : null;
  const latencyRatio = baseline ? baseline.result.total.p50 / target.result.total.p50 : null;
  const pass = improvement === null ? null : improvement >= factor;

  if (values.json) {
    write(
      `${JSON.stringify({ target: values.target, baseline: values.baseline ?? null, requests, concurrency, targetResult: target.result, baselineResult: baseline?.result ?? null, server: { cpuSeconds: cpu, rssBytes: rss, cacheHits: hits, cacheMisses: misses, connectionsCreated: created, connectionsReused: reused }, improvement, latencyRatio, targetFactor: factor, pass }, null, 2)}\n`,
    );
    return pass === false ? 1 : 0;
  }

  const r = target.result;
  const rate = (a: number | null, b: number | null) =>
    a !== null && b !== null && a + b > 0 ? `${((a / (a + b)) * 100).toFixed(1)}%` : 'n/a';
  const avg = (sum: number | null, n: number | null) =>
    sum !== null && n ? ms((sum / n) * 1000) : 'n/a';
  const lines = [
    'Klyro Benchmark',
    `Target: ${values.target}`,
    `Requests: ${requests}`,
    `Concurrency: ${concurrency}`,
    '',
    `P50: ${ms(r.total.p50)}`,
    `P90: ${ms(r.total.p90)}`,
    `P95: ${ms(r.total.p95)}`,
    `P99: ${ms(r.total.p99)}`,
    `Mean: ${ms(r.total.mean)}   Min: ${ms(r.total.min)}   Max: ${ms(r.total.max)}`,
    `Requests/sec: ${r.requestsPerSecond.toFixed(1)}`,
    `TTFB: p50 ${ms(r.ttfb.p50)}  p95 ${ms(r.ttfb.p95)}  p99 ${ms(r.ttfb.p99)}`,
    `CPU: ${cpu === null ? 'n/a (target has no /metrics)' : `${cpu.toFixed(2)} s over the run (${((cpu / r.durationSeconds) * 100).toFixed(0)}% of one core)`}`,
    `RAM: ${rss === null ? 'n/a' : `${(rss / 1048576).toFixed(0)} MB resident after the run`}`,
    `Bytes: ${(r.bytes / 1e6).toFixed(2)} MB received`,
    `Cache hit: ${rate(hits, misses)}`,
    `Connection reuse: ${rate(reused, created)}${created !== null ? ` (${created} opened, ${reused} reused)` : ''}`,
    `DNS (uncached, server side): ${avg(dnsSum, dnsCount)}   Upstream to first byte: ${avg(upSum, upCount)}   Transform: ${avg(trSum, trCount)}`,
    `Failures: ${r.failed}${r.failed ? `  (statuses ${JSON.stringify(r.statusCounts)})` : ''}`,
    '',
  ];
  if (baseline && improvement !== null && latencyRatio !== null) {
    lines.push(...describe(`Baseline: ${values.baseline}`, baseline.result));
    lines.push(
      `Improvement: ${improvement.toFixed(2)}x throughput, ${latencyRatio.toFixed(2)}x lower median latency (baseline / target)`,
      `${factor}x target: ${pass ? 'PASS' : 'FAIL'}`,
    );
  } else {
    lines.push(
      'Baseline: none given',
      'Improvement: n/a',
      `${factor}x target: N/A (needs --baseline)`,
    );
  }
  write(`${lines.join('\n')}\n`);
  return pass === false ? 1 : 0;
}
