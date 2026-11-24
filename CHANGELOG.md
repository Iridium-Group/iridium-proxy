# Changelog

## Unreleased

- **Scramjet client upgraded from 1.1.0 to 2.1.0** (`web/`, compatibility mode and the Vercel client). Scramjet 2
  no longer uses bare-mux: the page now uses `scramjet-controller` and a `proxy-transports` transport
  (`libcurl-transport` 2.0.6) to reach Wisp. Cookies a site sets are kept, also across a reload of the page
  (new test). The packages are AGPL-3.0-only, which the credits now say correctly. The browser benchmark was
  rerun: the new client loads the 100-image page in 485 ms cold and 516 ms warm (was 678 and 550).
  `WISP_URL`, `/wisp/` and the allowed-origins rules are unchanged, so existing Wisp servers need no change.
- The generated folders in `web/public/` are now `scramjet/`, `controller/` and `libcurl/`.
- New interface: a proper logo (`ui/logo.svg` plus PNG icons), the Inter typeface, real toolbar icons, favorites as
  tiles. The Recent list is gone (and any history it saved is deleted from the browser).
- Tabs are saved and restored after a reload or restart (addresses and titles only, never sessions), the
  visible tab loads first, and Ctrl/Cmd+Shift+T reopens a closed tab.

- Preconnect and pre-warmed connection pool (`PRECONNECT`, `PREWARM_CONNECTIONS`, `WARM_*`), with caps,
  idle expiry and the same destination checks as a request.
- Browser shell with tabs, address bar and navigation; IPv4-first DNS with failover and one retry;
  failure reasons in the log; bandwidth cap for native mode; safer VM updates.

## 0.2.0: Klyro

- **Native HTTP proxy** (`src/klyro/`): path-style proxied URLs, fast path versus transform path
  chosen from response headers, validating keep-alive connection pool, DNS cache, per-session cookie
  jar and cache, adaptive routing, WebSocket proxy, rate limits and size limits.
- HTML and CSS rewriting that only touches URL attributes, with a 1 KB runtime for runtime-built
  URLs; large pages are rewritten on worker threads.
- `klyro` command with `klyro benchmark`; load generator; benchmark suite and browser benchmark.
- `/health`, `/ready`, `/metrics`; request ids; logs never contain paths, queries, cookies or tokens.
- The monthly bandwidth cap now also covers native-mode traffic.
- New interface (`ui/`). The Scramjet client remains as compatibility mode (`KLYRO_UI=compat`).
- Fixed: a Wisp flow-control deadlock for data sent before a stream opened.
- Documentation set, `THIRD_PARTY.md` and licence notices.

## 0.1.0

- Static file server with path-traversal protection and `/healthz`.
- Wisp v1 endpoint that enforces `AddressPolicy` after DNS resolution, queues data sent before a
  stream is open, limits streams per client, and times out slow connects.
- `iridium-proxy` CLI, `PORT` support, Dockerfile.
