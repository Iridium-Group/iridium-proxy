import { Agent as HttpAgent, type ClientRequest } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';
import type { LookupFunction } from 'node:net';
import type { AddressPolicy } from '@iridium-group/transport';
import type { DnsCache } from './dns.ts';

export interface PoolStats {
  created: number;
  reused: number;
  closed: number;
  failed: number;
  /** Sockets currently open to origins. */
  active: number;
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
  readonly stats: PoolStats = { created: 0, reused: 0, closed: 0, failed: 0, active: 0 };
  #dns: DnsCache | undefined;

  constructor(options: PoolOptions) {
    this.#dns = options.dns;
    const policy = options.address;
    const lookup: LookupFunction = (hostname, opts, cb) => {
      policy
        .resolve(hostname)
        .then((a) =>
          opts.all
            ? cb(null, [{ address: a.address, family: a.family }])
            : cb(null, a.address, a.family),
        )
        .catch((e: NodeJS.ErrnoException) => cb(e, ''));
    };
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
  }

  agentFor(protocol: string): HttpAgent {
    return protocol === 'https:' ? this.https : this.http;
  }

  /** Count socket creation, reuse and closure for one outgoing request. */
  track(req: ClientRequest, host: string): void {
    req.once('socket', (socket) => {
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
    this.http.destroy();
    this.https.destroy();
  }
}
