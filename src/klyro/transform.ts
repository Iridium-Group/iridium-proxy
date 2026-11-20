import { rewriteCss } from './css.ts';
import { transformHtml } from './html.ts';

export type TransformKind = 'html' | 'css';

/**
 * Decode, rewrite and re-encode one body. A plain function over bytes so it can run inline or in
 * a worker thread with identical results.
 */
export function transformBytes(
  kind: TransformKind,
  bytes: Uint8Array,
  charset: string,
  baseHref: string,
  sid: string,
): Uint8Array {
  let text: string;
  try {
    text = new TextDecoder(charset).decode(bytes);
  } catch {
    text = new TextDecoder('utf-8').decode(bytes);
  }
  const base = new URL(baseHref);
  const out = kind === 'html' ? transformHtml(text, { base, sid }) : rewriteCss(text, base, sid);
  return new TextEncoder().encode(out);
}
