import { randomBytes } from 'node:crypto';
import { CookieJar } from 'tough-cookie';
import { SESSION_ID } from './proxyurl.ts';

export interface Session {
  id: string;
  /** Cookies set by upstream sites. Never shared with another session. */
  jar: CookieJar;
  createdAt: number;
  lastUsed: number;
  requests: number;
  bytesIn: number;
  bytesOut: number;
  /** Recent redirect responses, for loop protection. */
  redirects: { count: number; since: number };
}

export interface SessionStoreOptions {
  max: number;
  ttlMs: number;
  now?: () => number;
}

/** Isolated sessions with idle expiry. When full, the least recently used one is evicted. */
export class SessionStore {
  #sessions = new Map<string, Session>();
  #opts: SessionStoreOptions;
  #now: () => number;
  #timer: NodeJS.Timeout | undefined;

  constructor(options: SessionStoreOptions) {
    this.#opts = options;
    this.#now = options.now ?? Date.now;
  }

  get size(): number {
    return this.#sessions.size;
  }

  /** Start the periodic sweep of expired sessions. */
  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(
      () => this.sweep(),
      Math.min(60_000, Math.max(1000, this.#opts.ttlMs / 4)),
    );
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  create(): Session {
    this.sweep();
    while (this.#sessions.size >= this.#opts.max) {
      // Map keeps insertion order and get() re-inserts, so the first key is least recently used.
      const oldest = this.#sessions.keys().next().value;
      if (oldest === undefined) break;
      this.#sessions.delete(oldest);
    }
    const now = this.#now();
    const session: Session = {
      id: randomBytes(16).toString('base64url'),
      jar: new CookieJar(),
      createdAt: now,
      lastUsed: now,
      requests: 0,
      bytesIn: 0,
      bytesOut: 0,
      redirects: { count: 0, since: now },
    };
    this.#sessions.set(session.id, session);
    return session;
  }

  get(id: string): Session | undefined {
    if (!SESSION_ID.test(id)) return undefined;
    const s = this.#sessions.get(id);
    if (!s) return undefined;
    const now = this.#now();
    if (now - s.lastUsed > this.#opts.ttlMs) {
      this.#sessions.delete(id);
      return undefined;
    }
    s.lastUsed = now;
    this.#sessions.delete(id);
    this.#sessions.set(id, s);
    return s;
  }

  sweep(): number {
    const now = this.#now();
    let removed = 0;
    for (const [id, s] of this.#sessions) {
      if (now - s.lastUsed > this.#opts.ttlMs) {
        this.#sessions.delete(id);
        removed += 1;
      }
    }
    return removed;
  }
}
