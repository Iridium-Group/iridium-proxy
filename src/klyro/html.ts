import { escapeAttribute, decodeHTMLAttribute } from 'entities';
import { Parser } from 'htmlparser2';
import { rewriteCss } from './css.ts';
import { proxify } from './proxyurl.ts';

export interface HtmlOptions {
  /** URL of the page being rewritten, as the upstream sees it. */
  base: URL;
  sid: string;
  /** Inject the small runtime that proxies fetch/XHR/WebSocket/EventSource. Default true. */
  shim?: boolean;
}

/** Attributes whose value is a single URL. */
const URL_ATTRS = new Set([
  'href',
  'src',
  'action',
  'formaction',
  'poster',
  'background',
  'cite',
  'longdesc',
  'data',
  'manifest',
  'ping',
]);
const SRCSET_ATTRS = new Set(['srcset', 'imagesrcset']);

interface Edit {
  start: number;
  end: number;
  text: string;
}

function rewriteSrcset(value: string, base: URL, sid: string): string {
  return value
    .split(',')
    .map((part) => {
      const trimmed = part.trim();
      if (trimmed === '') return trimmed;
      const [url, ...descriptor] = trimmed.split(/\s+/);
      const p = proxify(url!, base, sid);
      return [p ?? url, ...descriptor].join(' ');
    })
    .join(', ');
}

/** A tag's attributes found in its source text, so values can be replaced in place. */
const ATTR = /([^\s"'<>/=]+)(\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;

function shimTag(base: URL, sid: string): string {
  return `<script src="/klyro/shim.js" data-sid="${sid}" data-base="${escapeAttribute(base.href)}"></script>`;
}

/**
 * Rewrite URLs in an HTML document. Only attribute values that hold URLs are changed (plus
 * inline style attributes, <style> blocks and meta refresh); script bodies, text and everything
 * else are copied byte for byte. `integrity` is kept on scripts. It is removed on stylesheets
 * only, because their bytes change when their own URLs are rewritten.
 */
export function transformHtml(html: string, options: HtmlOptions): string {
  const { sid } = options;
  let base = options.base;
  const edits: Edit[] = [];
  let injectAt = -1;
  let inStyle = false;
  let styleStart = 0;

  const parser = new Parser(
    {
      onopentag(name, attribs) {
        const start = parser.startIndex;
        const end = parser.endIndex + 1;
        const source = html.slice(start, end);

        if (name === 'head') injectAt = end;
        else if (name === 'html' && injectAt < 0) injectAt = end; // used only if there is no <head>
        if (name === 'style') {
          inStyle = true;
          styleStart = end;
        }
        if (name === 'base' && attribs.href !== undefined) {
          try {
            base = new URL(attribs.href, base);
          } catch {
            // Keep the previous base if the href is unusable.
          }
          edits.push({ start, end, text: '' }); // the proxied path already carries the origin
          return;
        }

        const isStylesheet =
          name === 'link' && (attribs.rel ?? '').toLowerCase().split(/\s+/).includes('stylesheet');
        const refresh =
          name === 'meta' && (attribs['http-equiv'] ?? '').toLowerCase() === 'refresh';
        let changed = false;
        const next = source.replace(
          ATTR,
          (m, attrName: string, eq: string, dq?: string, sq?: string, bare?: string) => {
            const lower = attrName.toLowerCase();
            const raw = dq ?? sq ?? bare ?? '';
            const value = decodeHTMLAttribute(raw);
            let out: string | null = null;
            if (URL_ATTRS.has(lower) || (lower === 'content' && refresh)) {
              if (lower === 'content') {
                const match = /^(\s*[\d.]*\s*;\s*url\s*=\s*)(['"]?)(.*?)\2\s*$/i.exec(value);
                const p = match ? proxify(match[3]!, base, sid) : null;
                out = p !== null && match ? `${match[1]}${match[2]}${p}${match[2]}` : null;
              } else {
                out = proxify(value, base, sid);
              }
            } else if (SRCSET_ATTRS.has(lower)) {
              const rewritten = rewriteSrcset(value, base, sid);
              out = rewritten === value ? null : rewritten;
            } else if (lower === 'style') {
              const rewritten = rewriteCss(value, base, sid);
              out = rewritten === value ? null : rewritten;
            } else if (lower === 'integrity' && isStylesheet) {
              changed = true;
              return '';
            } else if (lower === 'crossorigin' && isStylesheet) {
              return m; // harmless without integrity; leave as authored
            }
            if (out === null) return m;
            changed = true;
            return `${attrName}${eq}"${escapeAttribute(out)}"`;
          },
        );
        if (changed) edits.push({ start, end, text: next });
      },
      onclosetag(name) {
        if (name === 'style' && inStyle) {
          inStyle = false;
          const end = parser.startIndex;
          const css = html.slice(styleStart, end);
          const rewritten = rewriteCss(css, base, sid);
          if (rewritten !== css) edits.push({ start: styleStart, end, text: rewritten });
        }
      },
    },
    { decodeEntities: false, lowerCaseAttributeNames: true },
  );
  parser.write(html);
  parser.end();

  const insert = options.shim === false ? '' : shimTag(base, sid);
  if (insert !== '' && injectAt >= 0) edits.push({ start: injectAt, end: injectAt, text: insert });
  // Insertions (zero width) sort before an edit that starts at the same index.
  edits.sort((a, b) => a.start - b.start || a.end - a.start - (b.end - b.start));

  let out = '';
  let cursor = 0;
  for (const e of edits) {
    if (e.start < cursor) continue; // overlapping edits cannot happen, but never corrupt output
    out += html.slice(cursor, e.start) + e.text;
    cursor = e.end;
  }
  out += html.slice(cursor);
  return insert !== '' && injectAt < 0 ? insert + out : out;
}
