import { parseSize } from '../usage.ts';

/** Klyro runtime limits. Every field can be set with the environment variable shown. */
export interface KlyroConfig {
  /** KLYRO_ENABLED: set to 0 to turn the native HTTP proxy off (Wisp only). */
  enabled: boolean;
  /** MAX_SESSIONS: most live sessions. Oldest idle sessions are evicted first. */
  maxSessions: number;
  /** SESSION_TTL: idle time before a session expires, in seconds. */
  sessionTtlMs: number;
  /** MAX_CONNECTIONS: most simultaneous upstream sockets. */
  maxConnections: number;
  /** MAX_REQUEST_SIZE: largest request body accepted, in bytes. */
  maxRequestBytes: number;
  /** MAX_RESPONSE_SIZE: largest response body relayed, in bytes (streams are cut off here). */
  maxResponseBytes: number;
  /** MAX_TRANSFORM_SIZE: largest HTML/CSS body that is rewritten; larger ones pass through. */
  maxTransformBytes: number;
  /** CACHE_SIZE: memory cache budget, in bytes. 0 turns the cache off. */
  cacheBytes: number;
  /** CACHE_ITEM_SIZE: largest single cached response, in bytes. */
  cacheItemBytes: number;
  /** REQUEST_TIMEOUT: time to connect and receive response headers, in milliseconds. */
  requestTimeoutMs: number;
  /** IDLE_TIMEOUT: how long an unused upstream socket is kept, in milliseconds. */
  idleTimeoutMs: number;
  /** DNS_TTL: how long resolved addresses are cached, in seconds. */
  dnsTtlMs: number;
  /** RATE_LIMIT: requests per minute per client address. 0 turns it off. */
  ratePerMinute: number;
  /** KLYRO_POOL=0 disables upstream connection reuse (for benchmarking only). */
  pool: boolean;
  /** KLYRO_FORCE_TRANSFORM=1 sends everything through the slow path (for benchmarking only). */
  forceTransform: boolean;
}

export const DEFAULT_KLYRO_CONFIG: KlyroConfig = {
  enabled: true,
  maxSessions: 500,
  sessionTtlMs: 30 * 60_000,
  maxConnections: 128,
  maxRequestBytes: 10 * 1024 * 1024,
  maxResponseBytes: 2 * 1024 ** 3,
  maxTransformBytes: 8 * 1024 * 1024,
  cacheBytes: 64 * 1024 * 1024,
  cacheItemBytes: 1024 * 1024,
  requestTimeoutMs: 30_000,
  idleTimeoutMs: 15_000,
  dnsTtlMs: 60_000,
  ratePerMinute: 3000,
  pool: true,
  forceTransform: false,
};

export type EnvSource = Record<string, string | undefined>;

/** A non-negative number from the environment, multiplied by `scale` (for example seconds to ms). `fallback` is already in the final unit. */
function num(env: EnvSource, key: string, fallback: number, scale = 1): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0)
    throw new Error(`${key} must be a non-negative number, got "${raw}"`);
  return Math.floor(n * scale);
}

function size(env: EnvSource, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const n = parseSize(raw);
  if (n === null) throw new Error(`${key} must be a size like 64MB, got "${raw}"`);
  return n;
}

/** Read the Klyro settings from environment variables, throwing a clear error for bad values. */
export function klyroConfigFromEnv(env: EnvSource = process.env): KlyroConfig {
  const d = DEFAULT_KLYRO_CONFIG;
  return {
    enabled: env.KLYRO_ENABLED !== '0',
    maxSessions: num(env, 'MAX_SESSIONS', d.maxSessions),
    sessionTtlMs: num(env, 'SESSION_TTL', d.sessionTtlMs, 1000),
    maxConnections: Math.max(1, num(env, 'MAX_CONNECTIONS', d.maxConnections)),
    maxRequestBytes: size(env, 'MAX_REQUEST_SIZE', d.maxRequestBytes),
    maxResponseBytes: size(env, 'MAX_RESPONSE_SIZE', d.maxResponseBytes),
    maxTransformBytes: size(env, 'MAX_TRANSFORM_SIZE', d.maxTransformBytes),
    cacheBytes: size(env, 'CACHE_SIZE', d.cacheBytes),
    cacheItemBytes: size(env, 'CACHE_ITEM_SIZE', d.cacheItemBytes),
    requestTimeoutMs: num(env, 'REQUEST_TIMEOUT', d.requestTimeoutMs),
    idleTimeoutMs: num(env, 'IDLE_TIMEOUT', d.idleTimeoutMs),
    dnsTtlMs: num(env, 'DNS_TTL', d.dnsTtlMs, 1000),
    ratePerMinute: num(env, 'RATE_LIMIT', d.ratePerMinute),
    pool: env.KLYRO_POOL !== '0',
    forceTransform: env.KLYRO_FORCE_TRANSFORM === '1',
  };
}
