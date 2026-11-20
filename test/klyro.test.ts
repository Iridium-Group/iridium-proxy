import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { request as rawRequest } from 'node:http';
import { connect } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { applyDefaults, type IridiumConfigInput } from '@iridium-group/config';
import { WebSocket } from 'ws';
import {
  createLogger,
  createProxyServer,
  type KlyroConfig,
  type ProxyServer,
} from '../src/index.ts';
import { PAGE, selfSignedCert, startOrigin, type Origin } from './fixtures/origin.ts';

/** What a browser sends for a request made by a page on the same site. */
const same = (s: { path: (p: string) => string }) => ({ referer: s.path('/page') });

const lines: string[] = [];
const logger = createLogger('debug', 'json', (l) => lines.push(l));

interface Harness {
  proxy: ProxyServer;
  base: string;
  port: number;
  /** Open a session for `url` and return the proxied path prefix up to the host. */
  session(
    url: string,
  ): Promise<{ sid: string; path: (p: string) => string; ws: (p: string) => string }>;
}

async function start(
  origin: Origin,
  opts: {
    security?: IridiumConfigInput['security'];
    klyro?: Partial<KlyroConfig>;
    lookup?: (h: string) => Promise<{ address: string; family: 4 | 6 }[]>;
    ca?: Buffer;
    tls?: boolean;
  } = {},
): Promise<Harness> {
  const config = applyDefaults({
    server: { host: '127.0.0.1', staticDir: '/nonexistent' },
    security: { blockPrivateAddresses: false, ...opts.security },
  });
  const lookup = opts.lookup ?? (async () => [{ address: '127.0.0.1', family: 4 as const }]);
  const proxy = createProxyServer(config, {
    logger,
    klyro: { ratePerMinute: 0, ...opts.klyro },
    lookup,
    ...(opts.ca ? { ca: opts.ca } : {}),
  });
  const { port } = await proxy.listen(0);
  const base = `http://127.0.0.1:${port}`;
  return {
    proxy,
    base,
    port,
    async session(url) {
      const res = await fetch(`${base}/klyro/go?u=${encodeURIComponent(url)}`, {
        redirect: 'manual',
      });
      assert.equal(res.status, 302, await res.text());
      const loc = res.headers.get('location')!;
      const sid = loc.split('/')[2]!;
      const scheme = new URL(url).protocol.slice(0, -1);
      const host = new URL(url).host;
      return {
        sid,
        path: (p) => `${base}/k/${sid}/${scheme}/${host}${p}`,
        ws: (p) =>
          `ws://127.0.0.1:${port}/k/${sid}/${scheme === 'https' ? 'wss' : 'ws'}/${host}${p}`,
      };
    },
  };
}

describe('klyro: HTTP', () => {
  let origin: Origin;
  let h: Harness;
  before(async () => {
    origin = await startOrigin();
    h = await start(origin);
  });
  after(async () => {
    await h.proxy.close();
    await origin.close();
  });
  const url = () => `http://origin.test:${origin.port}/`;

  it('rewrites HTML on the transform path and keeps scripts intact', async () => {
    const s = await h.session(url());
    const res = await fetch(s.path('/static.html'));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-klyro-path'), 'transform');
    const body = await res.text();
    assert.ok(body.includes(`href="/k/${s.sid}/http/origin.test:${origin.port}/style.css"`), body);
    assert.ok(body.includes(`src="/k/${s.sid}/http/origin.test:${origin.port}/app.js"`));
    assert.ok(body.includes('src="/klyro/shim.js"') || body.includes('/klyro/shim.js'));
    assert.ok(body.includes('<h1 id="hi">hello</h1>'));
  });

  it('rewrites CSS and streams JavaScript untouched on the fast path', async () => {
    const s = await h.session(url());
    const css = await fetch(s.path('/style.css'));
    assert.match(
      await css.text(),
      new RegExp(`url\\(/k/${s.sid}/http/origin.test:${origin.port}/bg.png\\)`),
    );
    const js = await fetch(s.path('/app.js'));
    assert.equal(js.headers.get('x-klyro-path'), 'fast');
    assert.equal(await js.text(), 'document.title="js ran";');
  });

  it('decodes gzip HTML for rewriting, but passes gzip JavaScript through byte for byte', async () => {
    const s = await h.session(url());
    const html = await fetch(s.path('/gzip.html'));
    assert.equal(html.headers.get('content-encoding'), null);
    assert.ok((await html.text()).includes(`/k/${s.sid}/http/origin.test`));
    const raw = await fetch(s.path('/gzip.js'), { headers: { 'accept-encoding': 'gzip' } });
    assert.equal(raw.headers.get('x-klyro-path'), 'fast');
    // fetch() decodes for us, so check the proxy did not recompress or rewrite it.
    assert.equal(await raw.text(), 'console.log("hi")'.repeat(100));
    const bytes = await new Promise<Buffer>((resolve, reject) => {
      const req = connect(h.port, '127.0.0.1', () => {
        req.write(
          `GET /k/${s.sid}/http/origin.test:${origin.port}/gzip.js HTTP/1.1\r\nHost: x\r\nAccept-Encoding: gzip\r\nConnection: close\r\n\r\n`,
        );
      });
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
    const text = bytes.toString('latin1');
    assert.match(text, /content-encoding: gzip/i);
    const body = bytes.subarray(bytes.indexOf('\r\n\r\n') + 4);
    assert.equal(gunzipSync(body).toString(), 'console.log("hi")'.repeat(100));
  });

  it('streams large media without transforming it', async () => {
    const s = await h.session(url());
    const res = await fetch(s.path('/video.mp4'));
    assert.equal(res.headers.get('x-klyro-path'), 'fast');
    let n = 0;
    for await (const chunk of res.body!) n += (chunk as Uint8Array).length;
    assert.equal(n, 8 * 1024 * 1024);
  });

  it('really streams: the first chunk arrives before the origin finishes', async () => {
    const s = await h.session(url());
    const res = await fetch(s.path('/gate'));
    const reader = res.body!.getReader();
    const first = await reader.read(); // would hang if the proxy buffered the whole body
    assert.equal(new TextDecoder().decode(first.value), 'first');
    origin.gate.open();
    const second = await reader.read();
    assert.equal(new TextDecoder().decode(second.value), 'second');
  });

  it('passes range requests through and answers 206', async () => {
    const s = await h.session(url());
    const res = await fetch(s.path('/range'), { headers: { range: 'bytes=10-19' } });
    assert.equal(res.status, 206);
    assert.equal(res.headers.get('content-range'), 'bytes 10-19/100');
    assert.equal(await res.text(), '0123456789');
  });

  it('proxies POST bodies', async () => {
    const s = await h.session(url());
    const res = await fetch(s.path('/echo'), { method: 'POST', body: 'hello body' });
    assert.equal(await res.text(), 'hello body');
  });

  it('rewrites redirects into proxied paths and never leaks the raw Location', async () => {
    const s = await h.session(url());
    const res = await fetch(s.path('/redirect'), { redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.equal(
      res.headers.get('location'),
      `/k/${s.sid}/http/origin.test:${origin.port}/static.html`,
    );
    const abs = await fetch(s.path('/redirect-abs?to=http://elsewhere.test/x'), {
      redirect: 'manual',
    });
    assert.equal(abs.headers.get('location'), `/k/${s.sid}/http/elsewhere.test/x`);
  });

  it('stops redirect loops', async () => {
    const s = await h.session(url());
    let last = 0;
    for (let i = 0; i < 25; i++)
      last = (await fetch(s.path('/redirect-loop'), { redirect: 'manual' })).status;
    assert.equal(last, 508);
  });

  it('keeps cookies in a per-session jar and strips Set-Cookie from the client', async () => {
    const s = await h.session(url());
    const set = await fetch(s.path('/cookie-set'));
    assert.equal(set.headers.get('set-cookie'), null);
    assert.match(
      await (await fetch(s.path('/cookie-echo'), { headers: same(s) })).text(),
      /sid=abc123/,
    );
  });

  it('sends stored cookies only on navigations or same-site requests (a SameSite-like rule)', async () => {
    const s = await h.session(url());
    await fetch(s.path('/cookie-set'));
    const echo = (headers: Record<string, string>) =>
      fetch(s.path('/cookie-echo'), { headers }).then((r) => r.text());
    const foreign = `${h.base}/k/${s.sid}/http/other-site.test/page`;
    assert.equal(
      await echo({ referer: foreign }),
      '',
      'a request from another site gets no cookies',
    );
    assert.equal(await echo({}), '', 'no referer on a subresource request: cannot tell, so none');
    // fetch() will not let a script set Sec-Fetch-* headers (as in a browser), so use a raw request.
    const raw = (headers: Record<string, string>) =>
      new Promise<string>((resolve, reject) => {
        const r = rawRequest(s.path('/cookie-echo'), { headers }, (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => resolve(body));
        });
        r.on('error', reject);
        r.end();
      });
    assert.match(
      await raw({ referer: foreign, 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' }),
      /sid=abc123/,
      'top-level navigation keeps cookies',
    );
    assert.equal(
      await raw({ referer: foreign, 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' }),
      '',
      'a cross-site fetch does not',
    );
    assert.match(
      await raw({}),
      /sid=abc123/,
      'a client with no fetch metadata (curl, scripts) is not a browser page, so it keeps cookies',
    );
    assert.match(await echo(same(s)), /sid=abc123/, 'same site');
    assert.match(
      await echo({ referer: `${h.base}/k/${s.sid}/http/sub.origin.test:${origin.port}/p` }),
      /sid=abc123/,
      'a sibling subdomain is the same site',
    );
  });

  it('isolates sessions: cookies never cross', async () => {
    const a = await h.session(url());
    const b = await h.session(url());
    await fetch(a.path('/cookie-set'));
    assert.match(
      await (await fetch(a.path('/cookie-echo'), { headers: same(a) })).text(),
      /sid=abc123/,
    );
    assert.equal(await (await fetch(b.path('/cookie-echo'), { headers: same(b) })).text(), '');
  });

  it('isolates sessions: a cached response is never served to another session', async () => {
    const a = await h.session(url());
    const b = await h.session(url());
    const before = origin.hits.get('/cacheable') ?? 0;
    await fetch(a.path('/cacheable'));
    const again = await fetch(a.path('/cacheable'));
    assert.equal(
      again.headers.get('x-klyro-path'),
      'cache',
      'the same session does hit its own cache',
    );
    const other = await fetch(b.path('/cacheable'));
    assert.notEqual(other.headers.get('x-klyro-path'), 'cache', 'another session must not');
    assert.equal(
      (origin.hits.get('/cacheable') ?? 0) - before,
      2,
      'each session fetches for itself',
    );
  });

  it('never forwards client credentials, forwarding headers or its own address upstream', async () => {
    const s = await h.session(url());
    await fetch(s.path('/headers'), {
      headers: {
        authorization: 'Bearer SECRET',
        cookie: 'client=1',
        'x-forwarded-for': '9.9.9.9',
        origin: 'http://evil.test',
      },
    });
    const seen = origin.lastHeaders.get('/headers')!;
    assert.equal(seen.authorization, undefined);
    assert.equal(seen.cookie, undefined);
    assert.equal(seen['x-forwarded-for'], undefined);
    assert.equal(seen.host, `origin.test:${origin.port}`);
  });

  it('strips CSP and frame headers from upstream responses', async () => {
    const s = await h.session(url());
    const res = await fetch(s.path('/csp'));
    assert.equal(res.headers.get('content-security-policy'), null);
    assert.equal(res.headers.get('x-frame-options'), null);
  });

  it('shows a clear error for sign-in pages instead of handling credentials', async () => {
    const res = await fetch(
      `${h.base}/klyro/go?u=${encodeURIComponent('https://accounts.google.com/')}`,
      { redirect: 'manual' },
    );
    assert.equal(res.status, 403);
    assert.match(await res.text(), /does not handle passwords/);
  });

  it('answers 404, 410 and bad addresses without crashing', async () => {
    const s = await h.session(url());
    assert.equal((await fetch(s.path('/missing'))).status, 404);
    assert.equal((await fetch(`${h.base}/k/AAAAAAAAAAAAAAAAAAAAAA/http/origin.test/`)).status, 410);
    assert.equal((await fetch(`${h.base}/k/garbage/http/origin.test/`)).status, 400);
  });
});

describe('klyro: cache', () => {
  let origin: Origin;
  let h: Harness;
  before(async () => {
    origin = await startOrigin();
    h = await start(origin);
  });
  after(async () => {
    await h.proxy.close();
    await origin.close();
  });
  const url = () => `http://origin.test:${origin.port}/`;

  it('serves fresh responses from cache and counts hits', async () => {
    const s = await h.session(url());
    const a = await fetch(s.path('/cacheable'));
    assert.equal(await a.text(), 'cached body');
    const b = await fetch(s.path('/cacheable'));
    assert.equal(b.headers.get('x-klyro-path'), 'cache');
    assert.equal(origin.hits.get('/cacheable'), 1);
    assert.ok(h.proxy.klyro.cache.stats.hits >= 1);
  });

  it('revalidates stale entries with a conditional request', async () => {
    const s = await h.session(url());
    await fetch(s.path('/revalidate'));
    const b = await fetch(s.path('/revalidate'));
    assert.equal(b.headers.get('x-klyro-path'), 'cache-revalidated');
    assert.equal(await b.text(), 'revalidated body');
    assert.equal(origin.hits.get('/revalidate'), 2);
  });

  it('does not cache no-store, Set-Cookie or cookie-bearing responses', async () => {
    const s = await h.session(url());
    await fetch(s.path('/no-store'));
    await fetch(s.path('/no-store'));
    assert.equal(origin.hits.get('/no-store'), 2);
    await fetch(s.path('/cacheable-cookie'));
    await fetch(s.path('/cacheable-cookie'));
    assert.equal(origin.hits.get('/cacheable-cookie'), 2);
    await fetch(s.path('/cookie-set'));
    const before = origin.hits.get('/cacheable') ?? 0;
    await fetch(s.path('/cacheable'), { headers: same(s) });
    await fetch(s.path('/cacheable'), { headers: same(s) });
    assert.equal(
      (origin.hits.get('/cacheable') ?? 0) - before,
      2,
      'cookie-bearing requests must not be cached',
    );
  });

  it('does not cache range responses', async () => {
    const s = await h.session(url());
    await fetch(s.path('/range'), { headers: { range: 'bytes=0-4' } });
    await fetch(s.path('/range'), { headers: { range: 'bytes=0-4' } });
    assert.equal(origin.hits.get('/range'), 2);
  });
});

describe('klyro: connections', () => {
  it('reuses origin connections', async () => {
    const origin = await startOrigin();
    const h = await start(origin);
    try {
      const s = await h.session(`http://origin.test:${origin.port}/`);
      for (let i = 0; i < 10; i++) await (await fetch(s.path(`/static.html?i=${i}`))).text();
      const { created, reused } = h.proxy.klyro.pool.stats;
      assert.ok(created >= 1 && created <= 2, `created ${created}`);
      assert.ok(reused >= 8, `reused ${reused}`);
    } finally {
      await h.proxy.close();
      await origin.close();
    }
  });

  it('caches DNS answers', async () => {
    const origin = await startOrigin();
    let lookups = 0;
    const h = await start(origin, {
      lookup: async () => (lookups++, [{ address: '127.0.0.1', family: 4 as const }]),
    });
    try {
      const s = await h.session(`http://origin.test:${origin.port}/`);
      for (let i = 0; i < 5; i++) await (await fetch(s.path(`/static.html?i=${i}`))).text();
      assert.equal(lookups, 1);
      assert.ok(h.proxy.klyro.dns.hits >= 4);
    } finally {
      await h.proxy.close();
      await origin.close();
    }
  });

  it('proxies HTTPS to an origin with a certificate the pool trusts, and refuses an untrusted one', async () => {
    const tls = selfSignedCert();
    const origin = await startOrigin({ tls });
    const trusted = await start(origin, { ca: tls.cert });
    const untrusted = await start(origin);
    try {
      const s = await trusted.session(`https://origin.test:${origin.port}/`);
      const ok = await fetch(s.path('/static.html'));
      assert.equal(ok.status, 200);
      assert.ok((await ok.text()).includes('hello'));
      const u = await untrusted.session(`https://origin.test:${origin.port}/`);
      const bad = await fetch(u.path('/static.html'));
      assert.equal(bad.status, 502);
      assert.match(await bad.text(), /certificate/);
    } finally {
      await trusted.proxy.close();
      await untrusted.proxy.close();
      await origin.close();
    }
  });
});

describe('klyro: limits and lifecycle', () => {
  it('rejects oversized request bodies and cuts off oversized responses', async () => {
    const origin = await startOrigin();
    const h = await start(origin, {
      klyro: { maxRequestBytes: 1000, maxResponseBytes: 1024 * 1024 },
    });
    try {
      const s = await h.session(`http://origin.test:${origin.port}/`);
      const post = await fetch(s.path('/echo'), { method: 'POST', body: 'x'.repeat(5000) });
      assert.equal(post.status, 413);
      let received = 0;
      try {
        const res = await fetch(s.path('/big'));
        for await (const c of res.body!) received += (c as Uint8Array).length;
      } catch {
        // The stream is aborted when the limit is hit.
      }
      assert.ok(received < 8 * 1024 * 1024, `received ${received}`);
    } finally {
      await h.proxy.close();
      await origin.close();
    }
  });

  it('times out slow origins', async () => {
    const origin = await startOrigin();
    const h = await start(origin, { klyro: { requestTimeoutMs: 300 } });
    try {
      const s = await h.session(`http://origin.test:${origin.port}/`);
      assert.equal((await fetch(s.path('/slow'))).status, 504);
    } finally {
      await h.proxy.close();
      await origin.close();
    }
  });

  it('rate limits a client', async () => {
    const origin = await startOrigin();
    const h = await start(origin, { klyro: { ratePerMinute: 5 } });
    try {
      const s = await h.session(`http://origin.test:${origin.port}/`);
      const codes: number[] = [];
      for (let i = 0; i < 10; i++) codes.push((await fetch(s.path('/static.html'))).status);
      assert.ok(codes.includes(429), codes.join(','));
    } finally {
      await h.proxy.close();
      await origin.close();
    }
  });

  it('expires idle sessions and evicts the oldest when full', async () => {
    const origin = await startOrigin();
    const h = await start(origin, { klyro: { sessionTtlMs: 200, maxSessions: 2 } });
    try {
      const a = await h.session(`http://origin.test:${origin.port}/`);
      await h.session(`http://origin.test:${origin.port}/`);
      await h.session(`http://origin.test:${origin.port}/`);
      assert.equal(h.proxy.klyro.sessions.size, 2);
      assert.equal((await fetch(a.path('/static.html'))).status, 410, 'oldest session was evicted');
      const c = await h.session(`http://origin.test:${origin.port}/`);
      await new Promise((r) => setTimeout(r, 300));
      assert.equal((await fetch(c.path('/static.html'))).status, 410, 'idle session expired');
    } finally {
      await h.proxy.close();
      await origin.close();
    }
  });
});

describe('klyro: WebSocket', () => {
  it('relays messages both ways and sends jar cookies', async () => {
    const origin = await startOrigin();
    const h = await start(origin);
    try {
      const s = await h.session(`http://origin.test:${origin.port}/`);
      await fetch(s.path('/cookie-set'));
      const ws = new WebSocket(s.ws('/ws-echo'));
      const got: string[] = [];
      ws.on('message', (d) => got.push(d.toString()));
      await new Promise((r) => ws.once('open', r));
      ws.send('ping');
      ws.send(Buffer.from([1, 2, 3]), { binary: true });
      await new Promise((r) => setTimeout(r, 300));
      ws.close();
      assert.match(got[0]!, /cookie:.*sid=abc123/);
      assert.ok(got.includes('ping'));
    } finally {
      await h.proxy.close();
      await origin.close();
    }
  });

  it('refuses blocked destinations and bad sessions', async () => {
    const origin = await startOrigin();
    const h = await start(origin);
    try {
      const s = await h.session(`http://origin.test:${origin.port}/`);
      const bad = new WebSocket(`ws://127.0.0.1:${h.port}/k/${s.sid}/ws/localhost/x`);
      await assert.rejects(new Promise((_r, rej) => bad.once('error', rej)));
      const gone = new WebSocket(
        `ws://127.0.0.1:${h.port}/k/AAAAAAAAAAAAAAAAAAAAAA/ws/origin.test/x`,
      );
      await assert.rejects(new Promise((_r, rej) => gone.once('error', rej)));
    } finally {
      await h.proxy.close();
      await origin.close();
    }
  });
});

describe('klyro: observability and logging', () => {
  it('exposes /health, /ready and /metrics with the documented names', async () => {
    const origin = await startOrigin();
    const h = await start(origin);
    try {
      const s = await h.session(`http://origin.test:${origin.port}/`);
      await (await fetch(s.path('/static.html'))).text();
      assert.equal((await fetch(`${h.base}/health`)).status, 200);
      assert.equal((await fetch(`${h.base}/ready`)).status, 200);
      const text = await (await fetch(`${h.base}/metrics`)).text();
      for (const name of [
        'klyro_requests_total',
        'klyro_requests_failed_total',
        'klyro_request_duration_seconds',
        'klyro_active_sessions',
        'klyro_active_connections',
        'klyro_cache_hits_total',
        'klyro_cache_misses_total',
        'klyro_bytes_in_total',
        'klyro_bytes_out_total',
        'klyro_transform_duration_seconds',
        'klyro_dns_duration_seconds',
        'klyro_upstream_duration_seconds',
      ]) {
        assert.ok(text.includes(name), `missing ${name}`);
      }
      const res = await fetch(s.path('/static.html'));
      assert.match(res.headers.get('x-klyro-request-id')!, /^[0-9a-f]{12}$/);
    } finally {
      await h.proxy.close();
      await origin.close();
    }
  });

  it('never logs cookies, authorization, tokens or query strings', async () => {
    const origin = await startOrigin();
    const h = await start(origin);
    lines.length = 0;
    try {
      const s = await h.session(`http://origin.test:${origin.port}/?token=TOPSECRET`);
      await fetch(s.path('/headers?access_token=TOPSECRET'), {
        headers: { authorization: 'Bearer TOPSECRET', cookie: 'a=TOPSECRET' },
      });
      await fetch(s.path('/cookie-set'));
      await fetch(s.path('/cookie-echo'));
      const all = lines.join('\n');
      assert.ok(all.includes('request'), 'expected some log lines');
      assert.ok(!all.includes('TOPSECRET'));
      assert.ok(!all.includes('abc123'));
    } finally {
      await h.proxy.close();
      await origin.close();
    }
  });
});

describe('klyro: security', () => {
  let origin: Origin;
  let h: Harness;
  before(async () => {
    origin = await startOrigin();
    // Private addresses blocked (the default), with DNS answers we control.
    const answers: Record<string, { address: string; family: 4 | 6 }[]> = {
      'rebind.test': [
        { address: '93.184.216.34', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ],
      'meta.test': [{ address: '169.254.169.254', family: 4 }],
      'internal.test': [{ address: '10.0.0.5', family: 4 }],
      'v6.test': [{ address: '::1', family: 6 }],
      'mapped.test': [{ address: '::ffff:127.0.0.1', family: 6 }],
    };
    h = await start(origin, {
      security: { blockPrivateAddresses: true },
      lookup: async (host) => answers[host] ?? [{ address: '93.184.216.34', family: 4 }],
    });
  });
  after(async () => {
    await h.proxy.close();
    await origin.close();
  });

  const blockedStatus = async (target: string) => {
    const res = await fetch(`${h.base}/klyro/go?u=${encodeURIComponent(target)}`, {
      redirect: 'manual',
    });
    if (res.status === 302) {
      const follow = await fetch(h.base + res.headers.get('location')!);
      return follow.status;
    }
    return res.status;
  };

  it('blocks localhost, loopback, private, link-local and metadata destinations', async () => {
    for (const target of [
      'http://localhost/',
      'http://foo.localhost/',
      'http://127.0.0.1/',
      'http://127.1/',
      'http://2130706433/', // decimal form of 127.0.0.1
      'http://0x7f000001/',
      'http://[::1]/',
      'http://[::ffff:127.0.0.1]/',
      'http://10.0.0.1/',
      'http://192.168.1.1/',
      'http://172.16.0.1/',
      'http://169.254.169.254/latest/meta-data/',
      'http://metadata.google.internal/',
      'http://printer.local/',
      'http://rebind.test/', // one public and one private answer
      'http://meta.test/',
      'http://internal.test/',
      'http://v6.test/',
      'http://mapped.test/',
    ]) {
      assert.equal(await blockedStatus(target), 403, target);
    }
  });

  it('blocks dangerous schemes, credentials in URLs and blocked ports', async () => {
    for (const target of [
      'file:///etc/passwd',
      'ftp://example.com/',
      'gopher://example.com/',
      'javascript:alert(1)',
    ]) {
      const res = await fetch(`${h.base}/klyro/go?u=${encodeURIComponent(target)}`, {
        redirect: 'manual',
      });
      assert.ok(res.status === 400 || res.status === 403, `${target} -> ${res.status}`);
    }
    const creds = await fetch(
      `${h.base}/klyro/go?u=${encodeURIComponent('http://user:pw@example.com/')}`,
      { redirect: 'manual' },
    );
    assert.equal(creds.status, 400);
    assert.equal(await blockedStatus('http://example.com:25/'), 403);
  });

  it('re-checks DNS when connecting, so a rebinding answer cannot slip in after validation', async () => {
    let calls = 0;
    const origin2 = await startOrigin();
    const rebinding = await start(origin2, {
      security: { blockPrivateAddresses: true },
      klyro: { dnsTtlMs: 0 },
      // Public for the first lookup (the policy check), loopback for every later one.
      lookup: async () => [
        { address: calls++ === 0 ? '93.184.216.34' : '127.0.0.1', family: 4 as const },
      ],
    });
    try {
      const s = await rebinding.session(`http://rebind2.test:${origin2.port}/`);
      const res = await fetch(s.path('/static.html'));
      assert.equal(res.status, 403);
      assert.ok(calls >= 2, `lookups: ${calls}`);
    } finally {
      await rebinding.proxy.close();
      await origin2.close();
    }
  });

  it('revalidates redirect targets: a redirect to a blocked host is refused when followed', async () => {
    const o = await startOrigin();
    const open = await start(o); // private addresses allowed, so the origin is reachable
    try {
      const s = await open.session(`http://origin.test:${o.port}/`);
      const redirect = await fetch(s.path('/private-redirect'), { redirect: 'manual' });
      const location = redirect.headers.get('location')!;
      assert.ok(location.startsWith(`/k/${s.sid}/`), location); // never the raw http://localhost
      assert.equal((await fetch(open.base + location)).status, 403); // named hosts like localhost stay blocked
    } finally {
      await open.proxy.close();
      await o.close();
    }
  });

  it('rejects malformed proxy paths and header-injection attempts', async () => {
    const s = await h.session('http://example.com/');
    for (const p of ['/%0d%0aX-Evil:%201', '/..%2f..%2fetc/passwd', '/%00']) {
      const res = await fetch(`${h.base}/k/${s.sid}/http/example.com${p}`, { redirect: 'manual' });
      assert.ok([400, 403, 404, 502].includes(res.status), `${p} -> ${res.status}`);
      assert.equal(res.headers.get('x-evil'), null);
    }
  });

  it('refuses requests with both Content-Length and Transfer-Encoding (request smuggling)', async () => {
    const s = await h.session('http://example.com/');
    const reply = await new Promise<string>((resolve, reject) => {
      const sock = connect(h.port, '127.0.0.1', () => {
        sock.write(
          `POST /k/${s.sid}/http/example.com/ HTTP/1.1\r\nHost: x\r\nContent-Length: 4\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\nGET /k/${s.sid}/http/example.com/smuggled HTTP/1.1\r\nHost: x\r\n\r\n`,
        );
      });
      let data = '';
      sock.on('data', (c) => (data += c.toString()));
      sock.on('close', () => resolve(data));
      sock.on('error', reject);
      setTimeout(() => sock.destroy(), 1500);
    });
    assert.match(reply, /^HTTP\/1\.1 400/);
    assert.ok(!/smuggled/.test(reply));
  });
});

void PAGE;
