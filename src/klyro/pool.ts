import { Agent as HttpAgent, type ClientRequest } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';
import { connect as netConnect, isIP, type LookupFunction, type Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import type { AddressPolicy } from '@iridium-group/transport';
import type { DnsCache } from './dns.ts';

export interface PoolStats {
  created: number;
  reused: number;
  closed: number;
  failed: number;
  /** Sockets currently open to origins. */
  active: number;
  /** Connections opened ahead of need (preconnect). */
  warmCreated: number;
  /** Warm connections that a real request used. */
  warmUsed: number;
  /** Warm connections closed unused after their idle time. */
  warmExpired: number;
}

export interface WarmOptions {
  /** Most warm connections held at once, across all origins. */
  maxTotal: number;
  /** Most warm connections held for one origin. */
  maxPerOrigin: number;
  /** A warm connection nobody uses is closed after this many milliseconds. */
  idleMs: number;
}

export interface PoolOptions {
  address: AddressPolicy;
  dns?: DnsCache;
  maxConnections: number;
  idleTimeoutMs: number;
  /** false: no keep-alive, a fresh connection per request (benchmark baseline only). */
  keepAlive: boolean;
  /** Extra trusted CA certificates (tests and private origins). */
  ca?: string | Buffer;
  /** Enables preconnect: connections opened before a request needs them. */
  warm?: WarmOptions;
}

/**
 * Origin connection pool: keep-alive agents whose DNS lookup is the validating AddressPolicy.
 *
 * Because the agent resolves names itself, every new socket connects to an address that has just
 * been checked, so a DNS-rebinding answer cannot sneak past an earlier check. Reused sockets were
 * validated when they were opened.
 */
export class OriginPool {
  readonly http: HttpAgent;
  readonly https: HttpsAgent;
  readonly stats: PoolStats = {
    created: 0,
    reused: 0,
    closed: 0,
    failed: 0,
    active: 0,
    warmCreated: 0,
    warmUsed: 0,
    warmExpired: 0,
  };
  /** Connections opened ahead of need, by origin key (scheme, host, port), newest last. */
  #warm = new Map<string, { socket: Socket; timer: NodeJS.Timeout }[]>();
  #warmTotal = 0;
  /** Warm sockets that have been handed to a request but not yet counted by track(). */
  #taken = new WeakSet<Socket>();
  #warmOpts: WarmOptions | undefined;
  #address: AddressPolicy;
  #lookup: LookupFunction;
  #ca: string | Buffer | undefined;
  #dns: DnsCache | undefined;
  /** The address the lookup last handed out for each host, so a failed connect can penalise it. */
  #chosen = new Map<string, string>();

  constructor(options: PoolOptions) {
    this.#dns = options.dns;
    this.#warmOpts = options.warm;
    this.#ca = options.ca;
    const policy = options.address;
    this.#address = policy;
    const lookup: LookupFunction = (hostname, opts, cb) => {
      policy
        .resolve(hostname)
        .then((a) => {
          this.#chosen.set(hostname.toLowerCase(), a.address);
          return a;
        })
        .then((a) =>
          opts.all
            ? cb(null, [{ address: a.address, family: a.family }])
            : cb(null, a.address, a.family),
        )
        .catch((e: NodeJS.ErrnoException) => cb(e, ''));
    };
    this.#lookup = lookup;
    const common = {
      keepAlive: options.keepAlive,
      maxSockets: options.maxConnections,
      maxFreeSockets: Math.max(2, Math.floor(options.maxConnections / 2)),
      timeout: options.idleTimeoutMs,
      scheduling: 'lifo' as const,
      lookup,
      autoSelectFamily: false,
    };
    this.http = new HttpAgent(common);
    this.https = new HttpsAgent({ ...common, ...(options.ca ? { ca: options.ca } : {}) });

    if (this.#warmOpts) {
      // When an agent needs a new connection, hand it a warm one for the same origin if we have it.
      for (const [agent, scheme] of [
        [this.http, 'http:'],
        [this.https, 'https:'],
      ] as const) {
        const holder = agent as unknown as {
          createConnection: (...args: unknown[]) => Socket | undefined;
        };
        const original = holder.createConnection.bind(agent);
        holder.createConnection = (...args: unknown[]) => {
          const opts = (typeof args[0] === 'object' && args[0] !== null ? args[0] : {}) as {
            host?: string;
            hostname?: string;
            port?: number | string;
          };
          const warm = this.#take(scheme, opts.host ?? opts.hostname ?? '', Number(opts.port));
          return warm ?? original(...args);
        };
      }
    }
  }

  static #key(scheme: string, host: string, port: number): string {
    return `${scheme}//${host.replace(/^\[|\]$/g, '').toLowerCase()}:${port}`;
  }

  /** Take a live warm connection for this origin, newest first, or undefined. */
  #take(scheme: string, host: string, port: number): Socket | undefined {
    const list = this.#warm.get(OriginPool.#key(scheme, host, port));
    while (list && list.length > 0) {
      const entry = list.pop()!;
      this.#warmTotal -= 1;
      clearTimeout(entry.timer);
      entry.socket.removeAllListeners('error');
      entry.socket.removeAllListeners('close');
      // A connection still being set up is fine: the request waits only for the rest of it.
      if (
        !entry.socket.destroyed &&
        (entry.socket.readyState === 'open' || entry.socket.readyState === 'opening')
      ) {
        entry.socket.ref();
        this.#taken.add(entry.socket);
        return entry.socket;
      }
    }
    return undefined;
  }

  /**
   * Open connections to an origin before a request needs them (like a browser's preconnect), so
   * the first requests skip the TCP and TLS handshakes. The caller must already have checked the
   * host name; this checks the port and resolves DNS through the same validating policy as any
   * request, so a private address is never connected to. Never throws; hard caps apply.
   */
  async preconnect(target: URL, count = 1): Promise<void> {
    const warm = this.#warmOpts;
    if (!warm || count < 1) return;
    const https = target.protocol === 'https:';
    if (!https && target.protocol !== 'http:') return;
    const host = target.hostname.replace(/^\[|\]$/g, '');
    const port = Number(target.port) || (https ? 443 : 80);
    // The same full check as a real request: port, then every resolved address must be public.
    // This matters for IP addresses typed directly (http://127.0.0.1/): Node does not call the
    // lookup function for those, so without this check they would be connected to unchecked.
    try {
      await this.#address.check({ host, port });
    } catch {
      return;
    }
    const key = OriginPool.#key(target.protocol, host, port);
    const room = Math.min(
      count,
      warm.maxPerOrigin - (this.#warm.get(key)?.length ?? 0),
      warm.maxTotal - this.#warmTotal,
    );
    for (let i = 0; i < room; i++) this.#openWarm(key, https, host, port);
  }

  /** Start a connection and park it at once, so a request can claim it before it has finished. */
  #openWarm(key: string, https: boolean, host: string, port: number): void {
    const warm = this.#warmOpts!;
    const common = { host, port, lookup: this.#lookup, autoSelectFamily: false } as const;
    const socket: Socket = https
      ? tlsConnect({
          ...common,
          ...(isIP(host) ? {} : { servername: host }),
          ALPNProtocols: ['http/1.1'],
          ...(this.#ca ? { ca: this.#ca } : {}),
        })
      : netConnect(common);
    this.stats.created += 1;
    this.stats.active += 1;
    this.stats.warmCreated += 1;
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 5000);
    socket.on('error', () => socket.destroy()); // refused, unreachable, blocked, bad certificate
    const timer = setTimeout(() => {
      this.stats.warmExpired += 1;
      socket.destroy(); // nobody used it: do not hold the origin's resources
    }, warm.idleMs);
    timer.unref();
    const list = this.#warm.get(key) ?? [];
    list.push({ socket, timer });
    this.#warm.set(key, list);
    this.#warmTotal += 1;
    socket.unref();
    socket.once('close', () => {
      this.stats.closed += 1;
      this.stats.active -= 1;
      clearTimeout(timer);
      const l = this.#warm.get(key);
      const i = l?.findIndex((e) => e.socket === socket) ?? -1;
      if (l && i >= 0) {
        l.splice(i, 1);
        this.#warmTotal -= 1;
      }
    });
  }

  agentFor(protocol: string): HttpAgent {
    return protocol === 'https:' ? this.https : this.http;
  }

  /** Count socket creation, reuse and closure for one outgoing request. */
  track(req: ClientRequest, host: string): void {
    // A connect that fails (no route, refused, timed out) pushes that address to the back of the
    // DNS answer list, so the next attempt tries another one.
    req.once('error', (error: NodeJS.ErrnoException) => {
      if (['ENETUNREACH', 'EHOSTUNREACH', 'ECONNREFUSED', 'ETIMEDOUT'].includes(error.code ?? '')) {
        const address = this.#chosen.get(host.toLowerCase());
        if (address) this.#dns?.penalize(host, address);
      }
    });
    req.once('socket', (socket) => {
      if (this.#taken.delete(socket)) {
        // Opened ahead of need: already counted when it was created.
        this.stats.warmUsed += 1;
        return;
      }
      if (req.reusedSocket) {
        this.stats.reused += 1;
        return;
      }
      this.stats.created += 1;
      this.stats.active += 1;
      const address = socket.remoteAddress;
      socket.once('close', (hadError) => {
        this.stats.closed += 1;
        this.stats.active -= 1;
        if (hadError && address) this.#dns?.penalize(host, address);
      });
    });
  }

  destroy(): void {
    for (const list of this.#warm.values()) {
      for (const entry of list) {
        clearTimeout(entry.timer);
        entry.socket.destroy();
      }
    }
    this.#warm.clear();
    this.#warmTotal = 0;
    this.http.destroy();
    this.https.destroy();
  }
}
