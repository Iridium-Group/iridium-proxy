export interface CachedResponse {
  status: number;
  /** Headers as they should be sent to the client. */
  headers: Record<string, string | string[]>;
  body: Buffer;
  storedAt: number;
  freshUntil: number;
  etag?: string;
  lastModified?: string;
}

export interface CacheStats {
  hits: number;
  misses: number;
  revalidated: number;
  stores: number;
  evictions: number;
  bytes: number;
  entries: number;
}

export interface CacheOptions {
  maxBytes: number;
  maxItemBytes: number;
  now?: () => number;
}

type Headers = Record<string, string | string[] | undefined>;

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** Parse Cache-Control into a directive map. */
export function parseCacheControl(value: string | undefined): Map<string, string | true> {
  const out = new Map<string, string | true>();
  for (const part of (value ?? '').split(',')) {
    const [name, ...rest] = part.trim().split('=');
    if (name)
      out.set(name.toLowerCase(), rest.length ? rest.join('=').replace(/^"|"$/g, '') : true);
  }
  return out;
}

/**
 * Memory cache with LRU eviction and a byte budget. One cache is shared, but keys always start
 * with a session id, so one session never sees another's responses.
 */
export class MemoryCache {
  readonly stats: CacheStats = {
    hits: 0,
    misses: 0,
    revalidated: 0,
    stores: 0,
    evictions: 0,
    bytes: 0,
    entries: 0,
  };
  #map = new Map<string, CachedResponse>();
  #opts: CacheOptions;
  #now: () => number;

  constructor(options: CacheOptions) {
    this.#opts = options;
    this.#now = options.now ?? Date.now;
  }

  get enabled(): boolean {
    return this.#opts.maxBytes > 0;
  }

  get maxItemBytes(): number {
    return this.#opts.maxItemBytes;
  }

  static key(sessionId: string, method: string, url: string, acceptEncoding: string): string {
    return `${sessionId}\u0000${method}\u0000${acceptEncoding}\u0000${url}`;
  }

  /** The entry, whether fresh or stale. The caller decides what to do with a stale one. */
  peek(key: string): CachedResponse | undefined {
    const entry = this.#map.get(key);
    if (!entry) return undefined;
    this.#map.delete(key);
    this.#map.set(key, entry);
    return entry;
  }

  isFresh(entry: CachedResponse): boolean {
    return entry.freshUntil > this.#now();
  }

  recordHit(): void {
    this.stats.hits += 1;
  }
  recordMiss(): void {
    this.stats.misses += 1;
  }

  /** A 304 confirmed the entry: extend its freshness. */
  refresh(entry: CachedResponse, headers: Headers): void {
    this.stats.revalidated += 1;
    entry.freshUntil = this.freshUntil(headers, entry.lastModified) ?? this.#now();
    entry.storedAt = this.#now();
  }

  /**
   * Whether a response may be stored, and until when it is fresh. Conservative by design:
   * anything personalised, set-cookie-bearing, ranged or unvalidatable is not cached.
   */
  cacheability(input: {
    method: string;
    status: number;
    requestHadCookies: boolean;
    requestHadAuthorization: boolean;
    headers: Headers;
  }): { freshUntil: number; etag?: string; lastModified?: string } | null {
    if (!this.enabled || input.method !== 'GET' || input.status !== 200) return null;
    const h = input.headers;
    if (h['set-cookie'] !== undefined || h['content-range'] !== undefined) return null;
    const cc = parseCacheControl(one(h['cache-control']));
    if (cc.has('no-store') || cc.has('private')) return null;
    if (input.requestHadAuthorization && !cc.has('public')) return null;
    if (input.requestHadCookies && !cc.has('public')) return null;
    const vary = (one(h['vary']) ?? '').toLowerCase();
    if (vary && vary.split(',').some((v) => v.trim() !== 'accept-encoding')) return null;
    const etag = one(h['etag']);
    const lastModified = one(h['last-modified']);
    const freshUntil = this.freshUntil(h, lastModified);
    if (freshUntil === null && !etag && !lastModified) return null;
    const result: { freshUntil: number; etag?: string; lastModified?: string } = {
      freshUntil: freshUntil ?? this.#now(),
    };
    if (etag) result.etag = etag;
    if (lastModified) result.lastModified = lastModified;
    return result;
  }

  freshUntil(headers: Headers, lastModified: string | undefined): number | null {
    const now = this.#now();
    const cc = parseCacheControl(one(headers['cache-control']));
    if (cc.has('no-cache')) return now; // storable, but must be revalidated every time
    const maxAge = cc.get('s-maxage') ?? cc.get('max-age');
    if (typeof maxAge === 'string' && /^\d+$/.test(maxAge)) {
      const age = Number(one(headers['age']) ?? 0);
      return now + Math.max(0, Number(maxAge) - (Number.isFinite(age) ? age : 0)) * 1000;
    }
    const expires = Date.parse(one(headers['expires']) ?? '');
    if (Number.isFinite(expires)) {
      const date = Date.parse(one(headers['date']) ?? '') || now;
      return now + Math.max(0, expires - date);
    }
    if (lastModified) {
      const lm = Date.parse(lastModified);
      const date = Date.parse(one(headers['date']) ?? '') || now;
      if (Number.isFinite(lm) && date > lm) return now + Math.min((date - lm) * 0.1, 3_600_000);
    }
    return null;
  }

  store(key: string, entry: CachedResponse): boolean {
    if (!this.enabled || entry.body.length > this.#opts.maxItemBytes) return false;
    const old = this.#map.get(key);
    if (old) this.stats.bytes -= old.body.length;
    this.#map.delete(key);
    this.#map.set(key, entry);
    this.stats.bytes += entry.body.length;
    this.stats.stores += 1;
    while (this.stats.bytes > this.#opts.maxBytes) {
      const oldest = this.#map.keys().next().value;
      if (oldest === undefined) break;
      this.stats.bytes -= this.#map.get(oldest)!.body.length;
      this.#map.delete(oldest);
      this.stats.evictions += 1;
    }
    this.stats.entries = this.#map.size;
    return true;
  }

  /** Remove everything belonging to one session. */
  dropSession(sessionId: string): void {
    const prefix = `${sessionId}\u0000`;
    for (const [k, v] of this.#map) {
      if (k.startsWith(prefix)) {
        this.stats.bytes -= v.body.length;
        this.#map.delete(k);
      }
    }
    this.stats.entries = this.#map.size;
  }
}
