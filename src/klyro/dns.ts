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
  #opts: DnsCacheOptions;
  #now: () => number;

  constructor(options: DnsCacheOptions) {
    this.#opts = options;
    this.#now = options.now ?? Date.now;
    this.lookup = (host) => this.#get(host);
  }

  async #get(host: string): Promise<ResolvedAddress[]> {
    const key = host.toLowerCase();
    const hit = this.#cache.get(key);
    if (hit && hit.expires > this.#now()) {
      this.hits += 1;
      hit.addresses.push(hit.addresses.shift()!); // rotate
      return [...hit.addresses];
    }
    this.misses += 1;
    let pending = this.#inflight.get(key);
    if (!pending) {
      const started = performance.now();
      pending = (this.#opts.resolve ?? system)(key)
        .then((addresses) => {
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
    return [...(await pending)];
  }

  /** Move a failing address to the back so the next connection tries another one. */
  penalize(host: string, address: string): void {
    const entry = this.#cache.get(host.toLowerCase());
    if (!entry) return;
    const i = entry.addresses.findIndex((a) => a.address === address);
    if (i >= 0 && entry.addresses.length > 1)
      entry.addresses.push(entry.addresses.splice(i, 1)[0]!);
  }

  clear(): void {
    this.#cache.clear();
  }
}
