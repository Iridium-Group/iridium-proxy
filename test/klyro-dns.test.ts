import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DnsCache } from '../src/klyro/dns.ts';

const v4 = (address: string) => ({ address, family: 4 as const });
const v6 = (address: string) => ({ address, family: 6 as const });

describe('DnsCache', () => {
  it('puts IPv4 answers first, so a host with a broken IPv6 route still connects', async () => {
    const dns = new DnsCache({
      ttlMs: 60_000,
      resolve: async () => [v6('2001:db8::1'), v4('93.184.216.34'), v6('2001:db8::2')],
    });
    const answers = await dns.lookup('example.test');
    assert.equal(answers[0]!.family, 4);
    assert.deepEqual(
      answers.map((a) => a.family),
      [4, 6, 6],
    );
  });

  it('still returns IPv6 for an IPv6-only host', async () => {
    const dns = new DnsCache({ ttlMs: 60_000, resolve: async () => [v6('2001:db8::1')] });
    assert.deepEqual(await dns.lookup('v6only.test'), [v6('2001:db8::1')]);
  });

  it('moves a failing address to the back', async () => {
    const dns = new DnsCache({
      ttlMs: 60_000,
      resolve: async () => [v4('10.0.0.1'), v4('10.0.0.2')],
    });
    const first = await dns.lookup('h.test');
    dns.penalize('h.test', first[0]!.address);
    // However the list rotates, the failing address must never come first while it is penalised.
    for (let i = 0; i < 6; i++)
      assert.notEqual((await dns.lookup('h.test'))[0]!.address, first[0]!.address);
  });

  it('forgets a penalty after it expires', async () => {
    let now = 1000;
    const dns = new DnsCache({
      ttlMs: 600_000,
      now: () => now,
      resolve: async () => [v4('10.0.0.1'), v4('10.0.0.2')],
    });
    await dns.lookup('p.test');
    dns.penalize('p.test', '10.0.0.1', 5000);
    assert.equal((await dns.lookup('p.test'))[0]!.address, '10.0.0.2');
    now += 6000;
    const seen = new Set<string>();
    for (let i = 0; i < 4; i++) seen.add((await dns.lookup('p.test'))[0]!.address);
    assert.ok(seen.has('10.0.0.1'), 'the address is usable again after the penalty ends');
  });

  it('shares one lookup between concurrent callers and caches the answer', async () => {
    let calls = 0;
    const dns = new DnsCache({ ttlMs: 60_000, resolve: async () => (calls++, [v4('1.1.1.1')]) });
    await Promise.all([dns.lookup('a.test'), dns.lookup('a.test'), dns.lookup('a.test')]);
    await dns.lookup('a.test');
    assert.equal(calls, 1);
  });
});
