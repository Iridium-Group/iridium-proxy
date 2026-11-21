# Klyro

Klyro is Iridium Group's next-generation high-performance web-access and proxy platform.

It grew out of `iridium-proxy` and keeps everything that was there (a Wisp v1 relay, a Scramjet-based
browser client, the address policy, the bandwidth cap), and adds a **native HTTP proxy** designed
around one idea: _every transformation must have a reason._

```
request -> policy -> cache -> connection pool -> origin
                                   |
                  response headers decide the path:
                    HTML / CSS  -> rewrite (worker threads for big pages)
                    everything else -> stream straight through (fast path)
```

## Status and honest numbers

Klyro has a **5x performance target**. That is a target, not a result. Measured so far
([full numbers](docs/BENCHMARKS.md)):

- Against Klyro with its own connection pool and cache switched off: **0.81x to 4.73x**, depending on
  the workload (best on asset-heavy page loads). The 5x target was **not met** on any workload.
- Against a direct connection: slower on single requests, roughly level on cached page loads. A proxy
  cannot beat no proxy.
- In headless Chromium on a page with 100 images: about **3.3x faster cold and 2.75x faster warm
  than the Scramjet client** in this repo. Scramjet supports more sites because it rewrites JavaScript.

No real third-party website has been tested (no internet access in the build environment), so
compatibility with Discord, CAPTCHAs, and big web apps is **unknown**; see
[docs/COMPATIBILITY.md](docs/COMPATIBILITY.md). Klyro refuses sign-in pages on purpose.

## Run it

Node 22.18 or newer.

```sh
npm ci && npm run build
npx klyro                    # http://localhost:8080
npx klyro benchmark --help
```

No configuration is needed. Settings are environment variables
([docs/CONFIGURATION.md](docs/CONFIGURATION.md)); the secure defaults block private networks.

Endpoints: `/` (the browser shell), `/health`, `/ready`, `/metrics` (Prometheus), `/wisp/` (compatibility
mode), `/k/<session>/...` (proxied pages).

## Deploy

Oracle Cloud (Ubuntu 24.04, ARM64 or AMD64) behind Caddy: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).
Also a home-machine script and a Dockerfile.

## What is in the box

| Path                   | What                                                                                                       |
| ---------------------- | ---------------------------------------------------------------------------------------------------------- |
| `src/klyro/`           | The native proxy: pool, DNS cache, policy, sessions, cache, rewriters, metrics, benchmark                  |
| `src/wisp.ts`          | Wisp v1 relay with flow control and a bandwidth cap                                                        |
| `ui/`                  | The interface (MIT)                                                                                        |
| `web/`                 | Scramjet-based compatibility client (**AGPL-3.0**; see [NOTICE](NOTICE))                                   |
| `bench/`, `web/bench/` | Benchmark suite and browser benchmark                                                                      |
| `docs/`                | Architecture, performance, security, deployment, configuration, compatibility, troubleshooting, benchmarks |

## Documentation

[Architecture](docs/ARCHITECTURE.md) ·
[Performance](docs/PERFORMANCE.md) ·
[Benchmarks](docs/BENCHMARKS.md) ·
[Security](docs/SECURITY.md) ·
[Deployment](docs/DEPLOYMENT.md) ·
[Configuration](docs/CONFIGURATION.md) ·
[Compatibility](docs/COMPATIBILITY.md) ·
[Troubleshooting](docs/TROUBLESHOOTING.md) ·
[Third-party software](THIRD_PARTY.md)

## Development

```sh
npm ci
npm run format:check && npm run typecheck && npm run build && npm test
npm run build:web && npm --prefix web test      # real Chromium
npm run bench:suite                              # benchmarks
```

## Security in one paragraph

Destinations are validated before any outbound connection (scheme, host name, port, and every DNS
answer must be public), and again when a socket is opened, so DNS rebinding cannot slip through.
Redirects are never followed by the server. Limits cover sessions, sockets, body sizes, request rate
and monthly bandwidth. Credentials are not handled. One known weakness: every proxied site shares one
browser origin, so do not sign in to anything through Klyro. Details: [docs/SECURITY.md](docs/SECURITY.md).

## Licence

MIT, except `web/`, which is AGPL-3.0-only. See [NOTICE](NOTICE) and [THIRD_PARTY.md](THIRD_PARTY.md).
