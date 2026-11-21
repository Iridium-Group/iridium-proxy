# Architecture

Klyro serves two kinds of client from one process.

```
                 Browser
        +----------+-----------+
        |                      |
  Klyro native            Compatibility mode
  /k/<session>/...        Scramjet + Wisp  (web/, AGPL-3.0)
        |                      |
        v                      v
  +-----------------------------------------+
  |  Policy: scheme, host, port, DNS, limits |   one AddressPolicy,
  +-----------------------------------------+   shared by both
        |                      |
   Klyro request path     Wisp stream relay
        |                      |
        +-----> Origin <-------+
```

## Klyro native mode

The browser asks for `/k/<session>/<scheme>/<host>/<path>?<query>`. Keeping the upstream path
intact means **relative URLs in HTML, CSS and JavaScript already resolve correctly**; only absolute
and root-relative URLs need rewriting.

Every request takes the cheapest correct path:

```
request
  -> rate limit, session lookup
  -> policy (scheme, host name, port, DNS: all answers public)      403 if refused
  -> cache lookup (fresh hit: answer now; stale + validator: conditional request)
  -> origin connection pool (keep-alive, address pinned to what policy validated)
  -> look at the response HEADERS only:
        HTML or CSS, known encoding, not too large   -> TRANSFORM path
        anything else (images, video, JS, JSON, ranges, 304, HEAD) -> FAST path
```

**Preconnect.** The pool also opens connections before they are needed: when you press Go (so the
handshakes overlap the page fetch), when an HTML page is served (for its own origin), and for the other
hosts it references. They are parked with a short idle timeout and hard caps, and a request that arrives
while one is still connecting claims it. Every one passes the same destination checks as a request.

**Fast path** (the default): the origin's bytes are streamed to the client as they arrive. Nothing is
parsed, rewritten or fully buffered, so an 8 MB image or a long download never sits in RAM. Content
encoding (gzip, br) passes through untouched.

**Transform path**: only HTML and CSS. The body is decoded, rewritten and sent with a corrected
length. Documents of 256 KB or more are rewritten on worker threads, so one big page does not block
every other request. Rewriting is narrow:

- HTML: only attributes that hold URLs (`href`, `src`, `srcset`, `action`, `poster`, ...), inline
  `style`, `<style>` blocks and `<meta http-equiv=refresh>` change. `<base href>` is honoured and
  removed. Text, comments, SVG and **script bodies are copied byte for byte**. `integrity` is kept on
  scripts and removed only on stylesheets, whose bytes change when their own URLs are rewritten.
- CSS: `url(...)` and `@import` only.
- JavaScript is never rewritten. A 1 KB runtime (`/klyro/shim.js`) is injected into HTML and sends
  `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource` and `sendBeacon` calls through the proxy.

## The browser shell (`ui/`)

A small, dependency-free front end: a home page (title, short description, one search box, recent and
favorites) and, once you open something, a browser frame with tabs, back, forward, reload, home and an
address bar. Each tab is an `<iframe>` pointing at `/klyro/go?u=...`, which opens a session and redirects
to the proxied address. Because the frame is same-origin with the shell, the shell reads each page's
real URL and title and keeps the address bar and tab labels in step, including for pages that change
URL without reloading (it checks once a second). Shortcuts: Ctrl/Cmd+L, T and W. It never runs
inside its own frame (an error page's "Back to Klyro" link targets the top window).

Tabs are saved in the browser's local storage (addresses, titles, order and the active tab) and restored on
the next visit; only the visible tab loads at first. Session identifiers are deliberately never saved, so a
restored tab starts a fresh session. Favorites are stored the same way. There is no "recent" history.

## Components (src/klyro/)

| File                                      | Job                                                                            |
| ----------------------------------------- | ------------------------------------------------------------------------------ |
| `klyro.ts`                                | Request pipeline, adaptive routing, WebSocket proxy, metrics wiring            |
| `proxyurl.ts`                             | Encode/decode `/k/...` paths; `proxify()` for URLs found in pages              |
| `policy.ts`                               | Scheme, host-name and port rules; AddressPolicy for DNS validation             |
| `dns.ts`                                  | DNS cache (TTL, rotation, penalise failing addresses, share in-flight lookups) |
| `pool.ts`                                 | Keep-alive agents whose DNS lookup is the validating policy                    |
| `session.ts`                              | Isolated sessions: cookie jar, idle expiry, LRU eviction                       |
| `cache.ts`                                | LRU memory cache, ETag / Last-Modified / Cache-Control                         |
| `detect.ts`                               | Chooses fast or transform from response headers                                |
| `html.ts`, `css.ts`, `shim.ts`            | The rewriters and the browser runtime                                          |
| `transformer.ts`                          | Worker-thread offload for large bodies                                         |
| `ratelimit.ts`, `metrics.ts`, `config.ts` | Per-client limiter, Prometheus metrics, settings                               |
| `loadgen.ts`, `benchmark.ts`              | The `klyro benchmark` command                                                  |

## Compatibility mode (Wisp + Scramjet)

Unchanged from before Klyro: `/wisp/` is a Wisp v1 relay (`src/wisp.ts`) and `web/` is a Scramjet
front end. The server only relays TCP; rewriting happens in the browser. It supports more sites than
native mode (Scramjet rewrites JavaScript) and costs more per page. Select it with `KLYRO_UI=compat`.
The two modes share one address policy and DNS cache.

## Why a transport abstraction was not added

The request asked for a `Transport` abstraction. The repository already has one
(`@iridium-group/transport`: direct, Wisp and memory transports), used by the Wisp path. Klyro
native mode talks HTTP to origins through Node's keep-alive agents, because `fetch`-level HTTP is
exactly what a rewriting proxy needs, and wrapping it in `connect/send/receive/close` would add a
layer with no behaviour behind it. If a second HTTP transport appears (for example HTTP/2 to
origins), the place to add the seam is `sendUpstream()` in `klyro.ts`.

## Multiplexing (Wisp) versus one request per connection

The spec asked to benchmark multiplexing and to avoid it where it is slower. Native mode does not
multiplex: it keeps a pool of keep-alive connections per origin, which is what a server-side HTTP
proxy needs. Wisp multiplexing exists to save browsers the cost of many origin connections, which only
matters when the browser connects through the proxy itself. The browser comparison in
[BENCHMARKS.md](BENCHMARKS.md) is where the two designs are measured against each other.

## Known design limits

- All proxied sites share **one browser origin** (the proxy's). See [SECURITY.md](SECURITY.md).
- JavaScript that builds URLs from `location` sees the proxied path, not the real one.
- Single-threaded request handling: CPU-heavy work (HTML rewriting) is offloaded, but the
  proxy still runs on one event loop for everything else.
