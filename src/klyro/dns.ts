import { lookup as dnsLookup } from 'node:dns/promises';
import type { LookupFunction, ResolvedAddress } from '@iridium-group/transport';

interface Entry {
  addresses: ResolvedAddress[];
  expires: number;
}

export interface DnsCacheOptions {
  ttlMs: number;
  /** Replace the resolver, for tests. */
  resolve?: (host: string) => Promise<ResolvedAddress[]>;
  now?: () => number;
  /** Called with the seconds a real (uncached) lookup took. */
  onLookup?: (seconds: number) => void;
}

const system = async (host: string): Promise<ResolvedAddress[]> => {
  const answers = await dnsLookup(host, { all: true, verbatim: true });
  return answers.map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 }));
};

/**
 * A caching DNS resolver in the shape AddressPolicy expects. Answers are cached for `ttlMs`,
 * concurrent lookups of one name share a single query, and each call rotates the answer list so
 * connections spread across addresses. An address that failed to connect is moved to the back.
 *
 * Security checks are not done here: AddressPolicy validates every answer this returns.
 */
export class DnsCache {
  readonly lookup: LookupFunction;
  hits = 0;
  misses = 0;
  #cache = new Map<string, Entry>();
  #inflight = new Map<string, Promise<ResolvedAddress[]>>();
  /** Addresses that recently failed to connect, per host, with the time the penalty ends. */
  #bad = new Map<string, Map<string, number>>();
  #opts: DnsCacheOptions;
  #now: () => number;

  constructor(options: DnsCacheOptions) {
    this.#opts = options;
    this.#now = options.now ?? Date.now;
    this.lookup = (host) => this.#get(host);
  }

  /** Healthy addresses first, recently failed ones last. Order within each group is kept. */
  #order(key: string, list: readonly ResolvedAddress[]): ResolvedAddress[] {
    const bad = this.#bad.get(key);
    if (!bad || bad.size === 0) return [...list];
    const now = this.#now();
    for (const [address, until] of bad) if (until <= now) bad.delete(address);
    return [...list.filter((a) => !bad.has(a.address)), ...list.filter((a) => bad.has(a.address))];
  }

  async #get(host: string): Promise<ResolvedAddress[]> {
    const key = host.toLowerCase();
    const hit = this.#cache.get(key);
    if (hit && hit.expires > this.#now()) {
      this.hits += 1;
      hit.addresses.push(hit.addresses.shift()!); // rotate
      return this.#order(key, hit.addresses);
    }
    this.misses += 1;
    let pending = this.#inflight.get(key);
    if (!pending) {
      const started = performance.now();
      pending = (this.#opts.resolve ?? system)(key)
        .then((resolved) => {
          // IPv4 first (stable): many VMs have no working IPv6, and the policy connects to the
          // first answer. An IPv6-only host still works, since it has no IPv4 answers to prefer.
          const addresses = [...resolved].sort((a, b) => a.family - b.family);
          if (addresses.length > 0 && this.#opts.ttlMs > 0) {
            this.#cache.set(key, {
              addresses: [...addresses],
              expires: this.#now() + this.#opts.ttlMs,
            });
            if (this.#cache.size > 5000) this.#cache.delete(this.#cache.keys().next().value!);
          }
          return addresses;
        })
        .finally(() => {
          this.#inflight.delete(key);
          this.#opts.onLookup?.((performance.now() - started) / 1000);
        });
      this.#inflight.set(key, pending);
    }
    return this.#order(key, await pending);
  }

  /** Move a failing address to the back for a while, so the next connection tries another one. */
  penalize(host: string, address: string, forMs = 30_000): void {
    const key = host.toLowerCase();
    const bad = this.#bad.get(key) ?? new Map<string, number>();
    bad.set(address, this.#now() + forMs);
    this.#bad.set(key, bad);
  }

  clear(): void {
    this.#cache.clear();
  }
}
