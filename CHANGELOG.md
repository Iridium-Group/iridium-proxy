# Changelog

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
