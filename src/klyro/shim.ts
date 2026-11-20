/**
 * Browser runtime injected into proxied HTML. It does one thing: send network calls that
 * JavaScript builds at runtime (fetch, XHR, WebSocket, EventSource, sendBeacon) through the
 * proxy. It does not touch the DOM, does not rewrite script text, and leaves already-proxied
 * URLs alone.
 */
export const SHIM_SOURCE = `(() => {
  'use strict';
  const me = document.currentScript;
  if (!me || window.__klyro) return;
  const sid = me.dataset.sid;
  const pageUrl = me.dataset.base;
  const here = location.origin;
  const prefix = '/k/' + sid + '/';
  window.__klyro = { sid, pageUrl };

  // Resolve against the real upstream page URL, then express the result as a proxied path.
  function toProxy(input, ws) {
    try {
      const raw = String(input instanceof URL ? input.href : input);
      if (/^(data|blob|javascript|about):/i.test(raw)) return raw;
      let u = new URL(raw, location.href);
      if (u.origin === here && u.pathname.startsWith(prefix)) return raw.startsWith('ws') ? u.href : u.pathname + u.search + u.hash;
      if (u.origin === here && u.pathname.startsWith('/klyro/')) return raw;
      if (u.origin === here) u = new URL(raw, pageUrl); // root-relative: belongs to the upstream site
      const scheme = u.protocol.slice(0, -1);
      if (!/^(https?|wss?)$/.test(scheme)) return raw;
      const out = prefix + scheme + '/' + u.host + u.pathname + u.search + u.hash;
      return ws ? (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + out : out;
    } catch { return String(input); }
  }

  const f = window.fetch;
  if (f) window.fetch = function (input, init) {
    if (input instanceof Request) return f.call(this, new Request(toProxy(input.url), input), init);
    return f.call(this, toProxy(input), init);
  };

  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    return open.call(this, method, toProxy(url), ...rest);
  };

  const WS = window.WebSocket;
  if (WS) {
    const P = function (url, protocols) { return protocols === undefined ? new WS(toProxy(url, true)) : new WS(toProxy(url, true), protocols); };
    P.prototype = WS.prototype;
    for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) P[k] = WS[k];
    window.WebSocket = P;
  }

  const ES = window.EventSource;
  if (ES) {
    const P = function (url, init) { return new ES(toProxy(url), init); };
    P.prototype = ES.prototype;
    for (const k of ['CONNECTING', 'OPEN', 'CLOSED']) P[k] = ES[k];
    window.EventSource = P;
  }

  if (navigator.sendBeacon) {
    const sb = navigator.sendBeacon;
    navigator.sendBeacon = function (url, data) { return sb.call(this, toProxy(url), data); };
  }
})();
`;
