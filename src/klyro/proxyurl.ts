/**
 * Proxied URLs look like  /k/<session>/<scheme>/<host[:port]>/<path>?<query>
 *
 * Keeping the upstream path intact means relative URLs in HTML, CSS and JavaScript resolve to
 * the right proxied address with no rewriting at all. Only absolute and root-relative URLs need
 * to be changed.
 */

export const SESSION_ID = /^[A-Za-z0-9_-]{22}$/;
const PROXY_PREFIX = '/k/';

export function encodeProxyPath(sid: string, target: URL): string {
  return `${PROXY_PREFIX}${sid}/${target.protocol.slice(0, -1)}/${target.host}${target.pathname}${target.search}`;
}

export interface DecodedProxyUrl {
  sid: string;
  /** The upstream URL. `ws`/`wss` in the path are mapped to `http`/`https`. */
  target: URL;
  /** True if the path asked for a WebSocket scheme. */
  websocket: boolean;
}

const SCHEMES: Record<string, { protocol: string; websocket: boolean }> = {
  http: { protocol: 'http:', websocket: false },
  https: { protocol: 'https:', websocket: false },
  ws: { protocol: 'http:', websocket: true },
  wss: { protocol: 'https:', websocket: true },
};

/** Parse a request URL. Returns null for anything that is not a well-formed proxied URL. */
export function decodeProxyPath(requestUrl: string): DecodedProxyUrl | null {
  if (!requestUrl.startsWith(PROXY_PREFIX)) return null;
  if (/[\u0000-\u001f\u007f\\]/.test(requestUrl)) return null;
  const rest = requestUrl.slice(PROXY_PREFIX.length);
  const first = rest.indexOf('/');
  if (first < 0) return null;
  const sid = rest.slice(0, first);
  if (!SESSION_ID.test(sid)) return null;
  const afterSid = rest.slice(first + 1);
  const second = afterSid.indexOf('/');
  if (second < 0) return null;
  const scheme = SCHEMES[afterSid.slice(0, second)];
  if (!scheme) return null;
  const afterScheme = afterSid.slice(second + 1);
  const hostEnd = afterScheme.search(/[/?#]/);
  const authority = hostEnd < 0 ? afterScheme : afterScheme.slice(0, hostEnd);
  const tail = hostEnd < 0 ? '/' : afterScheme.slice(hostEnd);
  if (authority.length === 0 || /[@\s]/.test(authority)) return null;
  let target: URL;
  try {
    target = new URL(`${scheme.protocol}//${authority}${tail.startsWith('/') ? tail : `/${tail}`}`);
  } catch {
    return null;
  }
  if (target.username || target.password || target.host === '') return null;
  target.hash = '';
  return { sid, target, websocket: scheme.websocket };
}

const PASS_THROUGH = /^(?:data|blob|javascript|mailto|tel|about|sms):/i;

/**
 * Turn a URL found in a page into its proxied form, or return null to leave it alone
 * (fragments, data:, javascript:, already-proxied URLs, non-http schemes).
 */
export function proxify(value: string, base: URL, sid: string): string | null {
  const v = value.trim();
  if (v === '' || v.startsWith('#') || PASS_THROUGH.test(v)) return null;
  if (v.startsWith(`${PROXY_PREFIX}${sid}/`)) return null;
  let resolved: URL;
  try {
    resolved = new URL(v, base);
  } catch {
    return null;
  }
  if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return null;
  const proxied = encodeProxyPath(sid, resolved);
  return resolved.hash ? proxied + resolved.hash : proxied;
}
