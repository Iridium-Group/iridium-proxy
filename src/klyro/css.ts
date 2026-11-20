import { proxify } from './proxyurl.ts';

/**
 * Rewrite url(...) and @import references in CSS. CSS tokens are simple enough that a narrow,
 * deterministic pattern is safe; nothing else in the stylesheet is touched.
 */
export function rewriteCss(css: string, base: URL, sid: string): string {
  const swap = (u: string) => proxify(u, base, sid) ?? u;
  return css
    .replace(/url\(\s*(["']?)([^"')]*?)\1\s*\)/gi, (m, q: string, u: string) => {
      const p = proxify(u, base, sid);
      return p === null ? m : `url(${q}${p}${q})`;
    })
    .replace(
      /@import\s+(["'])([^"']*)\1/gi,
      (_m, q: string, u: string) => `@import ${q}${swap(u)}${q}`,
    );
}
