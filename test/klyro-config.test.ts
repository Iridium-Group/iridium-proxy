import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_KLYRO_CONFIG, klyroConfigFromEnv } from '../src/klyro/config.ts';

describe('klyro config from the environment', () => {
  it('returns exactly the documented defaults when nothing is set', () => {
    assert.deepEqual(klyroConfigFromEnv({}), DEFAULT_KLYRO_CONFIG);
  });
  it('converts seconds to milliseconds and sizes to bytes', () => {
    const c = klyroConfigFromEnv({
      SESSION_TTL: '60',
      DNS_TTL: '5',
      CACHE_SIZE: '10MB',
      MAX_RESPONSE_SIZE: '1GB',
      REQUEST_TIMEOUT: '2500',
      MAX_SESSIONS: '7',
    });
    assert.equal(c.sessionTtlMs, 60_000);
    assert.equal(c.dnsTtlMs, 5_000);
    assert.equal(c.cacheBytes, 10_000_000);
    assert.equal(c.maxResponseBytes, 1_000_000_000);
    assert.equal(c.requestTimeoutMs, 2500);
    assert.equal(c.maxSessions, 7);
  });
  it('has sane defaults for time settings (these were once misread as milliseconds)', () => {
    const d = klyroConfigFromEnv({});
    assert.ok(d.sessionTtlMs >= 60_000);
    assert.ok(d.dnsTtlMs >= 1000);
    assert.ok(d.requestTimeoutMs >= 1000);
  });
  it('rejects bad values with a clear message', () => {
    assert.throws(() => klyroConfigFromEnv({ MAX_SESSIONS: 'lots' }), /MAX_SESSIONS/);
    assert.throws(() => klyroConfigFromEnv({ CACHE_SIZE: 'big' }), /CACHE_SIZE/);
    assert.throws(() => klyroConfigFromEnv({ SESSION_TTL: '-1' }), /SESSION_TTL/);
  });
  it('lets the pool, force-transform and enabled switches be set', () => {
    const c = klyroConfigFromEnv({
      KLYRO_POOL: '0',
      KLYRO_FORCE_TRANSFORM: '1',
      KLYRO_ENABLED: '0',
    });
    assert.equal(c.pool, false);
    assert.equal(c.forceTransform, true);
    assert.equal(c.enabled, false);
  });
});
