/** Small Prometheus-format metrics registry: counters, gauges and fixed-bucket histograms. */

type Labels = Record<string, string>;

const key = (labels: Labels) =>
  Object.keys(labels)
    .sort()
    .map((k) => `${k}="${labels[k]!.replace(/[\\"\n]/g, '_')}"`)
    .join(',');

const DEFAULT_BUCKETS = [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];

class Histogram {
  readonly buckets: readonly number[];
  readonly counts: number[];
  sum = 0;
  count = 0;
  constructor(buckets: readonly number[]) {
    this.buckets = buckets;
    this.counts = new Array(buckets.length).fill(0);
  }
  observe(value: number): void {
    this.sum += value;
    this.count += 1;
    for (let i = 0; i < this.buckets.length; i++) {
      if (value <= this.buckets[i]!) this.counts[i]! += 1;
    }
  }
}

export class Metrics {
  #counters = new Map<string, { help: string; values: Map<string, number> }>();
  #gauges = new Map<string, { help: string; read: () => number }>();
  #derived = new Map<string, { help: string; read: () => number }>();
  #hists = new Map<string, { help: string; values: Map<string, Histogram> }>();

  counter(name: string, help: string): (n?: number, labels?: Labels) => void {
    const entry = { help, values: new Map<string, number>() };
    this.#counters.set(name, entry);
    return (n = 1, labels = {}) => {
      const k = key(labels);
      entry.values.set(k, (entry.values.get(k) ?? 0) + n);
    };
  }

  gauge(name: string, help: string, read: () => number): void {
    this.#gauges.set(name, { help, read });
  }

  /** A counter whose value is read from elsewhere (for example the connection pool's own tally). */
  derived(name: string, help: string, read: () => number): void {
    this.#derived.set(name, { help, read });
  }

  histogram(
    name: string,
    help: string,
    buckets = DEFAULT_BUCKETS,
  ): (seconds: number, labels?: Labels) => void {
    const entry = { help, values: new Map<string, Histogram>() };
    this.#hists.set(name, entry);
    return (seconds, labels = {}) => {
      const k = key(labels);
      let h = entry.values.get(k);
      if (!h) entry.values.set(k, (h = new Histogram(buckets)));
      h.observe(seconds);
    };
  }

  /** Current value of a counter (sum over all labels), for tests and the benchmark. */
  total(name: string): number {
    let sum = 0;
    for (const v of this.#counters.get(name)?.values.values() ?? []) sum += v;
    return sum;
  }

  render(): string {
    const out: string[] = [];
    for (const [name, { help, values }] of this.#counters) {
      out.push(`# HELP ${name} ${help}`, `# TYPE ${name} counter`);
      if (values.size === 0) out.push(`${name} 0`);
      for (const [k, v] of values) out.push(k ? `${name}{${k}} ${v}` : `${name} ${v}`);
    }
    for (const [name, { help, read }] of this.#gauges) {
      out.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`, `${name} ${read()}`);
    }
    for (const [name, { help, read }] of this.#derived) {
      out.push(`# HELP ${name} ${help}`, `# TYPE ${name} counter`, `${name} ${read()}`);
    }
    for (const [name, { help, values }] of this.#hists) {
      out.push(`# HELP ${name} ${help}`, `# TYPE ${name} histogram`);
      for (const [k, h] of values) {
        const lead = k ? `${k},` : '';
        h.buckets.forEach((b, i) => out.push(`${name}_bucket{${lead}le="${b}"} ${h.counts[i]}`));
        out.push(`${name}_bucket{${lead}le="+Inf"} ${h.count}`);
        out.push(k ? `${name}_sum{${k}} ${h.sum}` : `${name}_sum ${h.sum}`);
        out.push(k ? `${name}_count{${k}} ${h.count}` : `${name}_count ${h.count}`);
      }
    }
    return `${out.join('\n')}\n`;
  }
}
