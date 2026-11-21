import { randomBytes } from 'node:crypto';
import {
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type ServerResponse,
} from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Duplex } from 'node:stream';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import { AddressPolicy } from '@iridium-group/transport';
import { getDomain } from 'tldts';
import { WebSocket, WebSocketServer } from 'ws';
import { MemoryCache, type CachedResponse } from './cache.ts';
import { DEFAULT_KLYRO_CONFIG, type KlyroConfig } from './config.ts';
import { chooseRoute } from './detect.ts';
import { DnsCache } from './dns.ts';
import { Transformer } from './transformer.ts';
import { Metrics } from './metrics.ts';
import { OriginPool } from './pool.ts';
import { Policy, PolicyError } from './policy.ts';
import { decodeProxyPath, encodeProxyPath, proxify } from './proxyurl.ts';
import { RateLimiter } from './ratelimit.ts';
import { SessionStore, type Session } from './session.ts';
import { SHIM_SOURCE } from './shim.ts';
import type { Logger } from '../logger.ts';
import type { UsageMeter } from '../usage.ts';

export interface KlyroOptions {
  config?: Partial<KlyroConfig>;
  logger: Logger;
  /** Address policy settings, normally from the Iridium config's `security` section. */
  security: {
    blockPrivateAddresses: boolean;
    blockedPorts: readonly number[];
    allowedPorts?: readonly number[];
  };
  /** Counts bytes sent to clients. Once its monthly cap is reached, requests are refused. */
  usage?: UsageMeter;
  /** Extra trusted CA certificates for origin TLS (tests and private origins). */
  ca?: string | Buffer;
  /** Replace DNS, for tests. */
  resolve?: ConstructorParameters<typeof DnsCache>[0]['resolve'];
}

const HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);
const DROP_REQUEST = new Set([
  ...HOP,
  'host',
  'cookie',
  'authorization',
  'origin',
  'referer',
  'content-length',
  'accept-encoding',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-forwarded-port',
  'x-real-ip',
  'forwarded',
  'via',
  'cf-connecting-ip',
  'true-client-ip',
  'range',
]);
const DROP_RESPONSE = new Set([
  ...HOP,
  'set-cookie',
  'content-security-policy',
  'content-security-policy-report-only',
  'x-frame-options',
  'strict-transport-security',
  'alt-svc',
  'report-to',
  'nel',
  'public-key-pins',
  'cross-origin-embedder-policy',
  'cross-origin-opener-policy',
  'link',
  'content-location',
  'refresh',
  'clear-site-data',
  'x-klyro-path',
  'x-klyro-request-id',
]);
const SAFE_ENCODINGS = new Set(['gzip', 'deflate', 'br', 'identity']);
const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const METHODS = new Set(['GET', 'HEAD', 'OPTIONS', ...BODY_METHODS]);

/**
 * The registrable domain of a host ("a.b.example.co.uk" -> "example.co.uk"), or the host itself
 * for IP addresses and names with no public suffix.
 */
export function siteOf(host: string): string {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  // getDomain returns null for IP addresses and single-label names such as "localhost".
  return getDomain(h, { allowPrivateDomains: true }) ?? h;
}

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** Keep only the encodings Klyro can decode when it has to rewrite a body. */
function filterEncodings(value: string | undefined): string {
  if (!value) return 'identity';
  const kept = value
    .split(',')
    .map((v) => v.trim().split(';')[0]!.toLowerCase())
    .filter((v) => SAFE_ENCODINGS.has(v));
  return kept.length ? [...new Set(kept)].join(', ') : 'identity';
}

class HttpFailure extends Error {
  readonly status: number;
  readonly reason: string;
  /** The underlying network error code (ECONNREFUSED, ENETUNREACH, ...), for retries and logs. */
  errno: string | undefined;
  constructor(status: number, reason: string, message: string) {
    super(message);
    this.status = status;
    this.reason = reason;
  }
}

export interface Klyro {
  /** Handle a request if it belongs to Klyro. Returns false if it is not a Klyro path. */
  handle(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
  /** Handle a WebSocket upgrade if it belongs to Klyro. Returns false if not. */
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean;
  metrics: Metrics;
  sessions: SessionStore;
  cache: MemoryCache;
  pool: OriginPool;
  dns: DnsCache;
  transformer: Transformer;
  policy: Policy;
  config: KlyroConfig;
  /** Stop accepting work and release sockets and timers. */
  close(): Promise<void>;
  /** The AddressPolicy (with cached DNS) so other components can share it. */
  address: AddressPolicy;
}

export function createKlyro(options: KlyroOptions): Klyro {
  const config: KlyroConfig = { ...DEFAULT_KLYRO_CONFIG, ...options.config };
  const { logger, usage } = options;
  const metrics = new Metrics();

  const observeDns = metrics.histogram(
    'klyro_dns_duration_seconds',
    'DNS lookup time for uncached names',
  );
  const dns = new DnsCache({
    ttlMs: config.dnsTtlMs,
    onLookup: observeDns,
    ...(options.resolve ? { resolve: options.resolve } : {}),
  });
  const address = new AddressPolicy({
    blockPrivateAddresses: options.security.blockPrivateAddresses,
    blockedPorts: options.security.blockedPorts,
    ...(options.security.allowedPorts ? { allowedPorts: options.security.allowedPorts } : {}),
    lookup: dns.lookup,
  });
  const policy = new Policy({ address });
  const pool = new OriginPool({
    address,
    dns,
    maxConnections: config.maxConnections,
    idleTimeoutMs: config.idleTimeoutMs,
    keepAlive: config.pool,
    ...(config.pool && config.preconnect && config.warmMax > 0
      ? {
          warm: {
            maxTotal: config.warmMax,
            maxPerOrigin: Math.max(config.prewarmConnections, 2),
            idleMs: config.warmIdleMs,
          },
        }
      : {}),
    ...(options.ca ? { ca: options.ca } : {}),
  });
  const sessions = new SessionStore({ max: config.maxSessions, ttlMs: config.sessionTtlMs });
  sessions.start();
  const cache = new MemoryCache({
    maxBytes: config.cacheBytes,
    maxItemBytes: config.cacheItemBytes,
  });
  const limiter = new RateLimiter(config.ratePerMinute);
  const transformer = new Transformer({
    workers: config.transformWorkers,
    offloadBytes: config.transformOffloadBytes,
  });

  const countRequest = metrics.counter(
    'klyro_requests_total',
    'Proxied requests by path and status class',
  );
  const countFailed = metrics.counter(
    'klyro_requests_failed_total',
    'Proxied requests that failed, by reason',
  );
  const observeRequest = metrics.histogram(
    'klyro_request_duration_seconds',
    'Total time to serve a proxied request',
  );
  const observeUpstream = metrics.histogram(
    'klyro_upstream_duration_seconds',
    'Time until the origin sent response headers',
  );
  const observeTransform = metrics.histogram(
    'klyro_transform_duration_seconds',
    'Time spent rewriting HTML or CSS',
  );
  const countBytesIn = metrics.counter('klyro_bytes_in_total', 'Bytes received from origins');
  const countBytesOut = metrics.counter('klyro_bytes_out_total', 'Bytes sent to clients');
  const countWs = metrics.counter(
    'klyro_websocket_sessions_total',
    'WebSocket connections proxied',
  );
  metrics.gauge('klyro_active_sessions', 'Live sessions', () => sessions.size);
  metrics.gauge('klyro_active_connections', 'Open origin sockets', () => pool.stats.active);
  metrics.derived('klyro_cache_hits_total', 'Responses served from cache', () => cache.stats.hits);
  metrics.derived(
    'klyro_cache_misses_total',
    'Cacheable lookups that missed',
    () => cache.stats.misses,
  );
  metrics.derived(
    'klyro_cache_revalidated_total',
    'Stale entries confirmed by a 304',
    () => cache.stats.revalidated,
  );
  metrics.gauge('klyro_cache_bytes', 'Bytes held in the cache', () => cache.stats.bytes);
  metrics.derived(
    'klyro_connections_created_total',
    'Origin connections opened',
    () => pool.stats.created,
  );
  metrics.derived(
    'klyro_connections_reused_total',
    'Requests that reused an origin connection',
    () => pool.stats.reused,
  );
  metrics.derived(
    'klyro_connections_closed_total',
    'Origin connections closed',
    () => pool.stats.closed,
  );
  metrics.derived(
    'klyro_connection_failures_total',
    'Origin requests that failed before a response',
    () => pool.stats.failed,
  );
  metrics.derived(
    'klyro_warm_connections_created_total',
    'Connections opened ahead of need',
    () => pool.stats.warmCreated,
  );
  metrics.derived(
    'klyro_warm_connections_used_total',
    'Warm connections a request used',
    () => pool.stats.warmUsed,
  );
  metrics.derived(
    'klyro_warm_connections_expired_total',
    'Warm connections closed unused',
    () => pool.stats.warmExpired,
  );
  metrics.derived('klyro_dns_cache_hits_total', 'DNS answers served from cache', () => dns.hits);
  metrics.derived(
    'klyro_dns_cache_misses_total',
    'DNS lookups that went to the resolver',
    () => dns.misses,
  );
  metrics.derived('klyro_process_cpu_seconds_total', 'CPU time used by this process', () => {
    const u = process.cpuUsage();
    return (u.user + u.system) / 1e6;
  });
  metrics.gauge('klyro_process_resident_memory_bytes', 'Resident set size', () =>
    process.memoryUsage.rss(),
  );

  /**
   * Open connections to an origin before a request needs them. Only for addresses that pass the
   * same host-name rules as a real request; the pool checks the port and DNS as well.
   */
  const warmUp = (target: URL, count: number): void => {
    if (!config.pool || !config.preconnect || count < 1) return;
    try {
      policy.checkUrl(target);
    } catch {
      return;
    }
    void pool.preconnect(target, count);
  };

  let closing = false;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });

  const newId = () => randomBytes(6).toString('hex');
  const shimBody = Buffer.from(SHIM_SOURCE);

  function errorPage(
    req: IncomingMessage,
    res: ServerResponse,
    status: number,
    title: string,
    message: string,
    id: string,
  ): void {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    const wantsJson =
      /json/.test(req.headers.accept ?? '') && !/html/.test(req.headers.accept ?? '');
    const body = wantsJson
      ? JSON.stringify({ error: title, message, requestId: id })
      : `<!doctype html><meta charset="utf-8"><title>${title}</title><style>body{font:16px system-ui;max-width:34rem;margin:15vh auto;padding:0 1rem;background:#0b0d12;color:#d7dae0}h1{font-size:1.2rem}code{color:#8b93ff}a{color:#8b93ff}</style><h1>${title}</h1><p>${message.replace(/[<>&]/g, '')}</p><p><a href="/" target="_top">Back to Klyro</a> · <code>${id}</code></p>`;
    res.writeHead(status, {
      'content-type': wantsJson ? 'application/json' : 'text/html; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store',
      'x-klyro-request-id': id,
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  }

  /** Client address for rate limiting. Behind Caddy the real address is in X-Forwarded-For. */
  const clientKey = (req: IncomingMessage) => {
    const local = req.socket.remoteAddress ?? 'unknown';
    const isLocal = local === '127.0.0.1' || local === '::1' || local === '::ffff:127.0.0.1';
    const fwd = first(req.headers['x-forwarded-for']);
    return isLocal && fwd ? fwd.split(',')[0]!.trim() : local;
  };

  /** Request headers to send upstream. Built from an allow-by-exclusion list; cookies come from the jar. */
  async function upstreamHeaders(
    req: IncomingMessage,
    session: Session,
    target: URL,
  ): Promise<OutgoingHttpHeaders> {
    const out: OutgoingHttpHeaders = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (
        value === undefined ||
        DROP_REQUEST.has(name) ||
        name.startsWith('sec-fetch-') ||
        name.startsWith('x-klyro-')
      )
        continue;
      out[name] = value;
    }
    out['accept-encoding'] = filterEncodings(first(req.headers['accept-encoding']));
    out['host'] = target.host;
    const range = first(req.headers['range']);
    if (range && /^bytes=[\d,\s-]+$/.test(range)) out['range'] = range;
    // Referer/Origin: report the upstream page, never the proxy's own address.
    let refererUrl: URL | null = null;
    const ref = first(req.headers['referer']);
    if (ref) {
      try {
        const d = decodeProxyPath(new URL(ref).pathname + new URL(ref).search);
        if (d && d.sid === session.id) refererUrl = d.target;
      } catch {
        // Ignore an unparsable referer.
      }
    }
    // Every proxied site shares the proxy's browser origin, so a page from one site could ask
    // for another. Send stored cookies only on top-level navigations or when the request comes
    // from a page on the same site (a SameSite=Lax-like rule). No referer on a subresource
    // request means we cannot tell, so cookies are withheld.
    const topLevel =
      first(req.headers['sec-fetch-mode']) === 'navigate' &&
      first(req.headers['sec-fetch-dest']) === 'document';
    const sameSite = refererUrl !== null && siteOf(refererUrl.hostname) === siteOf(target.hostname);
    const hasFetchMetadata = req.headers['sec-fetch-mode'] !== undefined;
    if (topLevel || sameSite || !hasFetchMetadata) {
      const cookie = await session.jar.getCookieString(target.href);
      if (cookie) out['cookie'] = cookie;
    }
    if (refererUrl) out['referer'] = refererUrl.href;
    if (first(req.headers['origin']) || BODY_METHODS.has(req.method ?? 'GET')) {
      out['origin'] = (refererUrl ?? target).origin;
    }
    return out;
  }

  function sendUpstreamOnce(
    target: URL,
    method: string,
    headers: OutgoingHttpHeaders,
    body: IncomingMessage | null,
  ): Promise<IncomingMessage> {
    return new Promise((resolve, reject) => {
      const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
      const req = send({
        protocol: target.protocol,
        hostname: target.hostname.replace(/^\[|\]$/g, ''),
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        path: target.pathname + target.search,
        method,
        headers,
        agent: pool.agentFor(target.protocol),
        insecureHTTPParser: false,
      });
      pool.track(req, target.hostname);
      const timer = setTimeout(
        () => req.destroy(new HttpFailure(504, 'timeout', 'The site took too long to respond')),
        config.requestTimeoutMs,
      );
      req.once('response', (res) => {
        clearTimeout(timer);
        resolve(res);
      });
      req.once('error', (error) => {
        clearTimeout(timer);
        pool.stats.failed += 1;
        if (error instanceof HttpFailure) return reject(error);
        const failure = mapNetworkError(error);
        failure.errno = (error as NodeJS.ErrnoException).code;
        reject(failure);
      });
      if (!body) return void req.end();
      let seen = 0;
      const limit = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          seen += chunk.length;
          if (seen > config.maxRequestBytes)
            return cb(new HttpFailure(413, 'request_too_large', 'The request body is too large'));
          cb(null, chunk);
        },
      });
      pipeline(body, limit, req).catch((e) =>
        req.destroy(e instanceof Error ? e : new Error(String(e))),
      );
    });
  }

  const RETRYABLE = new Set(['ENETUNREACH', 'EHOSTUNREACH', 'ECONNREFUSED', 'ETIMEDOUT']);

  /**
   * Send a request, and if the connection could not be made, try once more. The pool pushes a
   * failing address to the back of the DNS list, so the second attempt uses a different one.
   * Only for requests with no body: a body that was already read cannot be sent again.
   */
  async function sendUpstream(
    target: URL,
    method: string,
    headers: OutgoingHttpHeaders,
    body: IncomingMessage | null,
  ): Promise<IncomingMessage> {
    try {
      return await sendUpstreamOnce(target, method, headers, body);
    } catch (error) {
      const code = error instanceof HttpFailure ? (error.errno ?? '') : '';
      if (body === null && RETRYABLE.has(code))
        return sendUpstreamOnce(target, method, headers, null);
      throw error;
    }
  }

  function mapNetworkError(error: Error): HttpFailure {
    if (error instanceof PolicyError)
      return new HttpFailure(error.status, error.code.toLowerCase(), error.message);
    const code = (error as NodeJS.ErrnoException).code ?? '';
    if (code === 'BLOCKED_ADDRESS' || code === 'BLOCKED_PORT')
      return new HttpFailure(403, code.toLowerCase(), 'That address is not allowed');
    if (code === 'ECONNREFUSED')
      return new HttpFailure(502, 'connection_refused', 'The site refused the connection');
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN')
      return new HttpFailure(502, 'dns', 'The site could not be found');
    if (code === 'ETIMEDOUT' || code === 'ECONNRESET')
      return new HttpFailure(504, 'upstream_reset', 'The connection to the site failed');
    if (
      code.startsWith('ERR_TLS') ||
      code.startsWith('CERT') ||
      /certificate|self.signed|SSL/i.test(error.message)
    ) {
      return new HttpFailure(502, 'tls', 'The site has a certificate problem');
    }
    // PolicyError raised inside the agent's lookup surfaces as a plain error with a transport code.
    if (/not allowed|blocked|is not allowed/i.test(error.message))
      return new HttpFailure(403, 'blocked_address', 'That address is not allowed');
    return new HttpFailure(502, 'upstream_error', 'The site could not be reached');
  }

  /** Response headers for the client: upstream's, minus anything that must not pass through. */
  function clientHeaders(
    h: IncomingHttpHeaders,
    target: URL,
    sid: string,
  ): Record<string, string | string[]> {
    const out: Record<string, string | string[]> = {};
    for (const [name, value] of Object.entries(h)) {
      if (value === undefined || DROP_RESPONSE.has(name)) continue;
      if (name === 'location') {
        const loc = proxify(first(value) ?? '', target, sid);
        if (loc !== null) out[name] = loc;
        continue;
      }
      out[name] = value;
    }
    return out;
  }

  async function storeCookies(
    session: Session,
    target: URL,
    setCookie: string[] | undefined,
  ): Promise<void> {
    for (const c of setCookie ?? [])
      await session.jar.setCookie(c, target.href, { ignoreError: true });
  }

  function decoderFor(encoding: string | undefined) {
    switch ((encoding ?? '').trim().toLowerCase()) {
      case 'gzip':
      case 'x-gzip':
        return createGunzip();
      case 'deflate':
        return createInflate();
      case 'br':
        return createBrotliDecompress();
      default:
        return null;
    }
  }

  async function readBody(
    source: IncomingMessage,
    encoding: string | undefined,
    limit: number,
  ): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let total = 0;
    const sink = new Transform({
      transform(chunk: Buffer, _e, cb) {
        total += chunk.length;
        if (total > limit)
          return cb(
            new HttpFailure(502, 'too_large_to_transform', 'This page is too large to rewrite'),
          );
        chunks.push(chunk);
        cb();
      },
    });
    const decoder = decoderFor(encoding);
    if (decoder) await pipeline(source, decoder, sink);
    else await pipeline(source, sink);
    return Buffer.concat(chunks);
  }

  function charsetOf(contentType: string | undefined): string {
    const m = /charset\s*=\s*["']?([\w.:-]+)/i.exec(contentType ?? '');
    return m ? m[1]!.toLowerCase() : 'utf-8';
  }

  async function proxyRequest(
    req: IncomingMessage,
    res: ServerResponse,
    id: string,
    started: number,
  ): Promise<{ route: string; status: number }> {
    const method = req.method ?? 'GET';
    if (usage?.exceeded)
      throw new HttpFailure(
        503,
        'bandwidth_cap',
        'This server has reached its monthly bandwidth limit',
      );
    if (!METHODS.has(method)) throw new HttpFailure(405, 'method', `${method} is not supported`);
    const decoded = decodeProxyPath(req.url ?? '');
    if (!decoded || decoded.websocket)
      throw new HttpFailure(400, 'bad_url', 'That is not a valid Klyro address');
    const session = sessions.get(decoded.sid);
    if (!session)
      throw new HttpFailure(
        410,
        'session_expired',
        'This session has expired. Start again from the home page.',
      );
    const { target } = decoded;
    session.requests += 1;

    const declared = Number(first(req.headers['content-length']));
    if (Number.isFinite(declared) && declared > config.maxRequestBytes)
      throw new HttpFailure(413, 'request_too_large', 'The request body is too large');
    if (req.headers['transfer-encoding'] && req.headers['content-length'])
      throw new HttpFailure(400, 'smuggling', 'Conflicting length headers');

    // Policy runs before anything touches the network. The pool re-checks at connect time.
    await policy.check(target);

    const acceptEncoding = filterEncodings(first(req.headers['accept-encoding']));
    const headers = await upstreamHeaders(req, session, target);
    const hadCookies = typeof headers['cookie'] === 'string';
    const hadAuth = req.headers['authorization'] !== undefined;
    const cacheKey = MemoryCache.key(session.id, method, target.href, acceptEncoding);
    const rangeRequested = headers['range'] !== undefined;

    // Cache lookup: the cheapest path for repeat GETs.
    let stale: CachedResponse | undefined;
    if (method === 'GET' && cache.enabled && !rangeRequested) {
      const entry = cache.peek(cacheKey);
      if (entry && cache.isFresh(entry)) {
        cache.recordHit();
        res.writeHead(entry.status, {
          ...entry.headers,
          'x-klyro-path': 'cache',
          'x-klyro-request-id': id,
          'content-length': entry.body.length,
        });
        res.end(entry.body);
        countBytesOut(entry.body.length);
        usage?.add(entry.body.length);
        return { route: 'cache', status: entry.status };
      }
      if (entry && (entry.etag || entry.lastModified)) {
        stale = entry;
        if (entry.etag) headers['if-none-match'] = entry.etag;
        if (entry.lastModified) headers['if-modified-since'] = entry.lastModified;
      } else {
        cache.recordMiss();
      }
    }

    const body = BODY_METHODS.has(method) ? req : null;
    if (body && Number.isFinite(declared)) headers['content-length'] = String(declared);
    const t0 = performance.now();
    const ures = await sendUpstream(target, method, headers, body);
    observeUpstream((performance.now() - t0) / 1000);
    const status = ures.statusCode ?? 502;

    await storeCookies(session, target, ures.headers['set-cookie']);

    // Redirect loop protection: too many redirects in a short window ends the session's chain.
    if (status >= 300 && status < 400) {
      const now = Date.now();
      if (now - session.redirects.since > 10_000) session.redirects = { count: 0, since: now };
      session.redirects.count += 1;
      if (session.redirects.count > 20) {
        ures.destroy();
        throw new HttpFailure(508, 'redirect_loop', 'Too many redirects');
      }
    }

    // Revalidated: the origin confirmed our cached copy.
    if (status === 304 && stale) {
      ures.resume();
      cache.refresh(stale, ures.headers);
      cache.recordHit();
      res.writeHead(stale.status, {
        ...stale.headers,
        'x-klyro-path': 'cache-revalidated',
        'x-klyro-request-id': id,
        'content-length': stale.body.length,
      });
      res.end(stale.body);
      countBytesOut(stale.body.length);
      usage?.add(stale.body.length);
      return { route: 'cache', status: stale.status };
    }
    if (stale) cache.recordMiss();

    const base = clientHeaders(ures.headers, target, session.id);
    const route =
      config.forceTransform && status === 200 && !rangeRequested
        ? forced(ures)
        : chooseRoute({
            method,
            status,
            headers: ures.headers,
            maxTransformBytes: config.maxTransformBytes,
          });
    const cacheInfo = cache.cacheability({
      method,
      status,
      requestHadCookies: hadCookies,
      requestHadAuthorization: hadAuth,
      headers: ures.headers,
    });

    // ---- Transformation path: HTML and CSS only ----
    if (route === 'html' || route === 'css') {
      const raw = await readBody(
        ures,
        first(ures.headers['content-encoding']),
        config.maxTransformBytes,
      );
      countBytesIn(raw.length);
      const t1 = performance.now();
      const label = charsetOf(first(ures.headers['content-type']));
      const out = Buffer.from(await transformer.run(route, raw, label, target.href, session.id));
      observeTransform((performance.now() - t1) / 1000);
      if (route === 'html' && status === 200 && method === 'GET') {
        // The browser is about to fetch this page's assets. Open connections for them now.
        warmUp(target, config.prewarmConnections);
        const head = Buffer.from(out.buffer, out.byteOffset, Math.min(out.length, 131072)).toString(
          'utf8',
        );
        const seen = new Set<string>([target.host]);
        const refs = new RegExp(`/k/${session.id}/(https?)/([^/"'\\s?#)<>]+)`, 'g');
        for (const m of head.matchAll(refs)) {
          if (seen.size > config.preconnectMaxHosts) break;
          const key = m[2]!;
          if (seen.has(key)) continue;
          seen.add(key);
          try {
            warmUp(new URL(`${m[1]}://${key}/`), 1);
          } catch {
            // Not a usable host name.
          }
        }
      }
      delete base['content-encoding'];
      delete base['etag'];
      delete base['last-modified'];
      delete base['expires'];
      delete base['age'];
      base['content-type'] =
        route === 'html' ? 'text/html; charset=utf-8' : 'text/css; charset=utf-8';
      base['content-length'] = String(out.length);
      if (route === 'html') base['cache-control'] = 'private, no-cache';
      base['x-klyro-path'] = 'transform';
      base['x-klyro-request-id'] = id;
      res.writeHead(status, base);
      res.end(method === 'HEAD' ? undefined : out);
      countBytesOut(out.length);
      usage?.add(out.length);
      session.bytesIn += raw.length;
      session.bytesOut += out.length;
      if (cacheInfo && status === 200) {
        cache.store(cacheKey, {
          status,
          headers: stripForCache(base),
          body: out,
          storedAt: Date.now(),
          ...cacheInfo,
        });
      }
      return { route: 'transform', status };
    }

    // ---- Fast path: stream straight through, no parsing, no full buffering ----
    base['x-klyro-path'] = 'fast';
    base['x-klyro-request-id'] = id;
    res.writeHead(status, base);
    if (method === 'HEAD' || status === 204 || status === 304) {
      ures.resume();
      res.end();
      return { route: 'fast', status };
    }
    let total = 0;
    const tee: Buffer[] | null =
      cacheInfo && Number(first(ures.headers['content-length']) ?? 0) <= cache.maxItemBytes
        ? []
        : null;
    let teeBytes = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _e, cb) {
        total += chunk.length;
        if (total > config.maxResponseBytes)
          return cb(new HttpFailure(502, 'response_too_large', 'The response is too large'));
        // Count toward the monthly cap; at the cap the stream is cut off here.
        if (usage?.add(chunk.length))
          return cb(
            new HttpFailure(503, 'bandwidth_cap', 'The monthly bandwidth limit was reached'),
          );
        if (tee) {
          teeBytes += chunk.length;
          if (teeBytes <= cache.maxItemBytes) tee.push(chunk);
        }
        cb(null, chunk);
      },
    });
    res.on('close', () => ures.destroy());
    try {
      await pipeline(ures, meter, res);
    } finally {
      countBytesIn(total);
      countBytesOut(total);
      session.bytesIn += total;
      session.bytesOut += total;
    }
    if (tee && cacheInfo && teeBytes <= cache.maxItemBytes && ures.complete) {
      cache.store(cacheKey, {
        status,
        headers: stripForCache(base),
        body: Buffer.concat(tee),
        storedAt: Date.now(),
        ...cacheInfo,
      });
    }
    return { route: 'fast', status };
  }

  /** KLYRO_FORCE_TRANSFORM benchmark mode: treat any HTML/CSS-looking or other body as text to rewrite. */
  function forced(ures: IncomingMessage): 'html' | 'css' | 'bypass' {
    const type = (first(ures.headers['content-type']) ?? '').toLowerCase();
    if (type.startsWith('text/css')) return 'css';
    return type.startsWith('text/html') ? 'html' : 'bypass';
  }

  const stripForCache = (h: Record<string, string | string[]>) => {
    const { 'x-klyro-path': _p, 'x-klyro-request-id': _r, 'content-length': _l, ...rest } = h;
    return rest;
  };

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = req.url ?? '/';
    const path = url.split('?')[0]!;

    if (path === '/health' || path === '/ready') {
      const ok = path === '/health' || !closing;
      res.writeHead(ok ? 200 : 503, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
      });
      res.end(JSON.stringify({ status: ok ? 'ok' : 'shutting_down', sessions: sessions.size }));
      return true;
    }
    if (path === '/metrics') {
      const body = metrics.render();
      res.writeHead(200, {
        'content-type': 'text/plain; version=0.0.4',
        'cache-control': 'no-store',
      });
      res.end(body);
      return true;
    }
    if (!config.enabled) return false;
    if (path === '/klyro/shim.js') {
      res.writeHead(200, {
        'content-type': 'text/javascript; charset=utf-8',
        'cache-control': 'public, max-age=3600',
        'content-length': shimBody.length,
      });
      res.end(shimBody);
      return true;
    }
    if (path === '/klyro/go') {
      const id = newId();
      if (!limiter.allow(clientKey(req))) {
        errorPage(
          req,
          res,
          429,
          'Slow down',
          'Too many requests. Wait a moment and try again.',
          id,
        );
        return true;
      }
      try {
        if (usage?.exceeded)
          throw new HttpFailure(
            503,
            'bandwidth_cap',
            'This server has reached its monthly bandwidth limit',
          );
        const raw = new URL(url, 'http://x').searchParams.get('u')?.trim() ?? '';
        if (!raw) throw new HttpFailure(400, 'bad_url', 'Enter a web address');
        let target: URL;
        try {
          target = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
        } catch {
          throw new HttpFailure(400, 'bad_url', 'That is not a valid web address');
        }
        policy.checkUrl(target);
        // Start the connections now, while the browser follows the redirect and asks for the page:
        // their handshakes then overlap the page fetch instead of following it.
        warmUp(target, config.prewarmConnections);
        const session = sessions.create();
        res.writeHead(302, {
          location: encodeProxyPath(session.id, target),
          'cache-control': 'no-store',
        });
        res.end();
      } catch (error) {
        const e =
          error instanceof PolicyError
            ? new HttpFailure(error.status, error.code.toLowerCase(), error.message)
            : error;
        const f =
          e instanceof HttpFailure ? e : new HttpFailure(500, 'internal', 'Something went wrong');
        errorPage(req, res, f.status, 'Cannot open that address', f.message, id);
      }
      return true;
    }
    if (!path.startsWith('/k/')) return false;

    const id = newId();
    const started = performance.now();
    if (closing) {
      errorPage(req, res, 503, 'Shutting down', 'Klyro is restarting. Try again in a moment.', id);
      return true;
    }
    if (!limiter.allow(clientKey(req))) {
      countFailed(1, { reason: 'rate_limited' });
      errorPage(req, res, 429, 'Slow down', 'Too many requests. Wait a moment and try again.', id);
      return true;
    }
    let route = 'error';
    let status = 500;
    let failure: HttpFailure | null = null;
    try {
      ({ route, status } = await proxyRequest(req, res, id, started));
    } catch (error) {
      const f =
        error instanceof PolicyError
          ? new HttpFailure(error.status, error.code.toLowerCase(), error.message)
          : error instanceof HttpFailure
            ? error
            : mapNetworkError(error instanceof Error ? error : new Error(String(error)));
      status = f.status;
      failure = f;
      countFailed(1, { reason: f.reason });
      if (!res.destroyed)
        errorPage(
          req,
          res,
          f.status,
          f.status === 403 ? 'Blocked' : 'Could not load that page',
          f.message,
          id,
        );
    } finally {
      const seconds = (performance.now() - started) / 1000;
      observeRequest(seconds, { route });
      countRequest(1, { route, class: `${Math.floor(status / 100)}xx` });
      // Method and host only. Paths, queries, cookies and headers can contain secrets.
      const decoded = decodeProxyPath(req.url ?? '');
      logger.info('request', {
        id,
        method: req.method ?? '',
        host: decoded?.target.host ?? '-',
        status,
        route,
        ms: Math.round(seconds * 1000),
        // Why a request failed: a fixed reason and the network error code. Never URLs or headers.
        ...(failure
          ? { reason: failure.reason, ...(failure.errno ? { errno: failure.errno } : {}) }
          : {}),
      });
    }
    return true;
  }

  function upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    if (!config.enabled || !(req.url ?? '').startsWith('/k/')) return false;
    const id = newId();
    const refuse = (status: number, text: string) => {
      socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
    };
    if (closing) return (refuse(503, 'Service Unavailable'), true);
    if (!limiter.allow(clientKey(req))) return (refuse(429, 'Too Many Requests'), true);
    const decoded = decodeProxyPath(req.url ?? '');
    if (!decoded || !decoded.websocket) return (refuse(400, 'Bad Request'), true);
    const session = sessions.get(decoded.sid);
    if (!session) return (refuse(410, 'Gone'), true);
    const { target } = decoded;
    void (async () => {
      try {
        await policy.check(target);
        const wsUrl = new URL(target.href);
        wsUrl.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:';
        const cookie = await session.jar.getCookieString(target.href);
        const wanted = first(req.headers['sec-websocket-protocol']);
        const upstream = new WebSocket(
          wsUrl,
          wanted ? wanted.split(',').map((p) => p.trim()) : [],
          {
            agent: pool.agentFor(target.protocol),
            headers: {
              ...(cookie ? { cookie } : {}),
              origin: target.origin,
              'user-agent': first(req.headers['user-agent']) ?? 'Klyro',
            },
            handshakeTimeout: config.requestTimeoutMs,
            maxPayload: 8 * 1024 * 1024,
          },
        );
        upstream.once(
          'upgrade',
          (r) => void storeCookies(session, target, r.headers['set-cookie']),
        );
        upstream.once('error', (e) => {
          countFailed(1, { reason: 'websocket' });
          logger.info('websocket refused', {
            id,
            host: target.host,
            reason: e.message.slice(0, 80),
          });
          if (!socket.destroyed && !socket.writableEnded) refuse(502, 'Bad Gateway');
        });
        upstream.once('open', () => {
          wss.handleUpgrade(req, socket, head, (client) => {
            countWs(1);
            const HIGH = 1024 * 1024;
            const relay = (from: WebSocket, to: WebSocket) => {
              from.on('message', (data, isBinary) => {
                if (to.readyState !== WebSocket.OPEN) return;
                to.send(data, { binary: isBinary });
                if (to.bufferedAmount > HIGH) {
                  from.pause();
                  const t = setInterval(() => {
                    if (to.bufferedAmount < HIGH / 4 || to.readyState !== WebSocket.OPEN) {
                      clearInterval(t);
                      from.resume();
                    }
                  }, 10);
                }
              });
              from.on('close', (code, reason) => {
                const ok = code >= 1000 && code <= 4999 && ![1004, 1005, 1006, 1015].includes(code);
                if (to.readyState === WebSocket.OPEN || to.readyState === WebSocket.CONNECTING)
                  to.close(ok ? code : 1000, reason);
              });
              from.on('error', () => to.terminate());
            };
            relay(client, upstream);
            relay(upstream, client);
          });
        });
      } catch (error) {
        const f = error instanceof PolicyError ? error : null;
        logger.info('websocket refused', { id, reason: f?.code ?? 'error' });
        refuse(f?.status ?? 502, f ? 'Forbidden' : 'Bad Gateway');
      }
    })();
    return true;
  }

  return {
    handle,
    upgrade,
    metrics,
    sessions,
    cache,
    pool,
    dns,
    transformer,
    policy,
    config,
    address,
    async close() {
      closing = true;
      sessions.stop();
      await transformer.close();
      for (const c of wss.clients) c.close(1001);
      pool.destroy();
    },
  };
}
