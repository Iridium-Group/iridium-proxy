/** Decide, from response headers alone, whether a body needs any transformation. */
export type Route = 'bypass' | 'html' | 'css';

export interface RouteInput {
  method: string;
  status: number;
  headers: Record<string, string | string[] | undefined>;
  maxTransformBytes: number;
}

const first = (v: string | string[] | undefined): string =>
  Array.isArray(v) ? (v[0] ?? '') : (v ?? '');

/** Content encodings that Klyro can decode when it has to rewrite a body. */
export const DECODABLE = new Set(['', 'identity', 'gzip', 'x-gzip', 'deflate', 'br']);

export function chooseRoute(input: RouteInput): Route {
  const { method, status, headers } = input;
  if (method === 'HEAD' || status === 204 || status === 304 || status === 206) return 'bypass';
  if (status >= 100 && status < 200) return 'bypass';
  const type = first(headers['content-type']).split(';')[0]!.trim().toLowerCase();
  let route: Route = 'bypass';
  if (type === 'text/html' || type === 'application/xhtml+xml') route = 'html';
  else if (type === 'text/css') route = 'css';
  if (route === 'bypass') return 'bypass';
  const length = Number(first(headers['content-length']));
  if (Number.isFinite(length) && length > input.maxTransformBytes) return 'bypass';
  if (!DECODABLE.has(first(headers['content-encoding']).trim().toLowerCase())) return 'bypass';
  return route;
}
