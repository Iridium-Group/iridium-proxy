import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { chooseRoute } from '../src/klyro/detect.ts';
import { siteOf } from '../src/klyro/klyro.ts';
import { rewriteCss } from '../src/klyro/css.ts';
import { transformHtml } from '../src/klyro/html.ts';
import { decodeProxyPath, encodeProxyPath, proxify } from '../src/klyro/proxyurl.ts';

const SID = 'AAAAAAAAAAAAAAAAAAAAAA';
const base = new URL('https://example.com/dir/page.html?x=1');
const run = (html: string, shim = false) => transformHtml(html, { base, sid: SID, shim });

describe('proxy URLs', () => {
  it('round-trips', () => {
    const u = new URL('https://example.com:8443/a%20b/c?d=e&f=g');
    const p = encodeProxyPath(SID, u);
    assert.equal(p, `/k/${SID}/https/example.com:8443/a%20b/c?d=e&f=g`);
    const d = decodeProxyPath(p)!;
    assert.equal(d.target.href, u.href);
    assert.equal(d.websocket, false);
  });
  it('maps ws schemes and root paths', () => {
    const d = decodeProxyPath(`/k/${SID}/wss/example.com`)!;
    assert.equal(d.target.href, 'https://example.com/');
    assert.equal(d.websocket, true);
  });
  it('rejects malformed, credentialed and dangerous input', () => {
    for (const bad of [
      '/k/short/https/example.com/',
      `/k/${SID}/ftp/example.com/`,
      `/k/${SID}/https/user:pw@example.com/`,
      `/k/${SID}/https/exa mple.com/`,
      `/k/${SID}/https//path`,
      `/k/${SID}/https/example.com/\r\nX: y`,
      `/k/${SID}/https/example.com\\@evil.com/`,
      '/other',
    ]) {
      assert.equal(decodeProxyPath(bad), null, bad);
    }
  });
  it('proxifies absolute, root-relative and relative URLs, and skips the rest', () => {
    assert.equal(proxify('https://cdn.test/a.js', base, SID), `/k/${SID}/https/cdn.test/a.js`);
    assert.equal(proxify('/root.css', base, SID), `/k/${SID}/https/example.com/root.css`);
    assert.equal(proxify('img/a.png', base, SID), `/k/${SID}/https/example.com/dir/img/a.png`);
    assert.equal(proxify('//cdn.test/x', base, SID), `/k/${SID}/https/cdn.test/x`);
    for (const skip of [
      '#top',
      'data:text/plain,hi',
      'javascript:void(0)',
      'mailto:a@b.c',
      '',
      `/k/${SID}/https/a.b/`,
    ]) {
      assert.equal(proxify(skip, base, SID), null, skip);
    }
    assert.equal(proxify('/p#frag', base, SID), `/k/${SID}/https/example.com/p#frag`);
  });
});

describe('content detection', () => {
  const base = { method: 'GET', status: 200, maxTransformBytes: 1000 };
  it('sends media and binaries down the fast path', () => {
    for (const type of [
      'image/png',
      'video/mp4',
      'audio/mpeg',
      'application/octet-stream',
      'application/javascript',
      'application/json',
    ]) {
      assert.equal(chooseRoute({ ...base, headers: { 'content-type': type } }), 'bypass', type);
    }
  });
  it('transforms HTML and CSS only', () => {
    assert.equal(
      chooseRoute({ ...base, headers: { 'content-type': 'text/html; charset=utf-8' } }),
      'html',
    );
    assert.equal(chooseRoute({ ...base, headers: { 'content-type': 'text/css' } }), 'css');
  });
  it('bypasses ranges, HEAD, 304, huge and unknown-encoding bodies', () => {
    const h = { 'content-type': 'text/html' };
    assert.equal(chooseRoute({ ...base, status: 206, headers: h }), 'bypass');
    assert.equal(chooseRoute({ ...base, method: 'HEAD', headers: h }), 'bypass');
    assert.equal(chooseRoute({ ...base, status: 304, headers: h }), 'bypass');
    assert.equal(chooseRoute({ ...base, headers: { ...h, 'content-length': '5000' } }), 'bypass');
    assert.equal(chooseRoute({ ...base, headers: { ...h, 'content-encoding': 'zstd' } }), 'bypass');
    assert.equal(chooseRoute({ ...base, headers: { ...h, 'content-encoding': 'gzip' } }), 'html');
  });
});

describe('css', () => {
  it('rewrites url() and @import only', () => {
    const out = rewriteCss(
      `@import "/a.css"; body{background:url('/bg.png');cursor:url(data:image/png;base64,AAA)} .x{background:url(rel.png)}`,
      new URL('https://example.com/css/site.css'),
      SID,
    );
    assert.match(out, new RegExp(`@import "/k/${SID}/https/example.com/a.css"`));
    assert.match(out, new RegExp(`url\\('/k/${SID}/https/example.com/bg.png'\\)`));
    assert.match(out, /url\(data:image\/png;base64,AAA\)/);
    assert.match(out, new RegExp(`url\\(/k/${SID}/https/example.com/css/rel.png\\)`));
  });
});

describe('html transformer', () => {
  it('rewrites URL attributes and leaves everything else byte for byte', () => {
    const src = `<!doctype html><html><head><title>T &amp; T</title></head><body><a href="/x?a=1&amp;b=2">l</a><img src='pic.png'><p>keep &lt;this&gt;</p></body></html>`;
    const out = run(src);
    assert.ok(out.includes(`href="/k/${SID}/https/example.com/x?a=1&amp;b=2"`), out);
    assert.ok(out.includes(`src="/k/${SID}/https/example.com/dir/pic.png"`), out);
    assert.ok(out.includes('<title>T &amp; T</title>'));
    assert.ok(out.includes('<p>keep &lt;this&gt;</p>'));
  });
  it('does not touch script bodies, data URLs or fragments', () => {
    const src = `<script>var u = "/api"; if (a<b) {}</script><a href="#x">a</a><img src="data:image/gif;base64,R0lG"><a href="javascript:void(0)">j</a>`;
    assert.equal(run(src), src);
  });
  it('keeps integrity on scripts and drops it only on stylesheets', () => {
    const out = run(
      `<script src="/a.js" integrity="sha384-abc"></script><link rel="stylesheet" href="/a.css" integrity="sha384-def">`,
    );
    assert.ok(out.includes('integrity="sha384-abc"'));
    assert.ok(!out.includes('sha384-def'));
  });
  it('rewrites srcset, inline style, <style> and meta refresh', () => {
    const out = run(
      `<img srcset="a.png 1x, /b.png 2x"><div style="background:url(/c.png)"></div><style>.q{background:url(/d.png)}</style><meta http-equiv="refresh" content="0; url=/next">`,
    );
    assert.ok(
      out.includes(
        `/k/${SID}/https/example.com/dir/a.png 1x, /k/${SID}/https/example.com/b.png 2x`,
      ),
    );
    assert.ok(out.includes(`url(/k/${SID}/https/example.com/c.png)`));
    assert.ok(out.includes(`url(/k/${SID}/https/example.com/d.png)`));
    assert.ok(out.includes(`content="0; url=/k/${SID}/https/example.com/next"`));
  });
  it('honours <base href> and removes the tag', () => {
    const out = run(`<head><base href="https://other.test/root/"></head><img src="a.png">`);
    assert.ok(!out.includes('<base'));
    assert.ok(out.includes(`/k/${SID}/https/other.test/root/a.png`));
  });
  it('injects the runtime once, at the start of <head>, and keeps SVG intact', () => {
    const out = run(
      `<html><head><meta charset="utf-8"></head><body><svg><use href="#i"/></svg></body></html>`,
      true,
    );
    const idx = out.indexOf('/klyro/shim.js');
    assert.ok(idx > out.indexOf('<head>') && idx < out.indexOf('<meta charset'));
    assert.equal(out.split('/klyro/shim.js').length - 1, 1);
    assert.ok(out.includes('<svg><use href="#i"/></svg>'));
  });
  it('injects into a fragment that has no <head>', () => {
    assert.ok(run('<p>x</p>', true).startsWith('<script src="/klyro/shim.js"'));
  });
});

describe('siteOf', () => {
  it('finds the registrable domain', () => {
    assert.equal(siteOf('www.example.com'), 'example.com');
    assert.equal(siteOf('a.b.example.co.uk'), 'example.co.uk');
    assert.equal(siteOf('example.com'), 'example.com');
    assert.equal(siteOf('127.0.0.1'), '127.0.0.1');
    assert.equal(siteOf('[::1]'), '::1');
    assert.equal(siteOf('localhost'), 'localhost');
    assert.notEqual(
      siteOf('evil.github.io'),
      siteOf('good.github.io'),
      'public suffixes separate tenants',
    );
  });
});
