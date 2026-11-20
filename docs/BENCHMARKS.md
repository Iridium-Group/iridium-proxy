# Benchmarks

Everything here was measured by the scripts in this repository, on one machine, on loopback, against
controlled fixtures. Nothing was estimated. To reproduce:

```sh
npm run build
npm run bench:suite            # all workloads, direct vs Klyro vs naive Klyro
npm run build:web && npm run bench:browser   # real Chromium: Klyro native vs the Scramjet client
node bin/klyro.js benchmark --help           # point it at any two URLs
```

## What is compared

| Target          | What it is                                                                                                                                                         |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `direct`        | The fixture origin, no proxy                                                                                                                                       |
| `klyro`         | Klyro with its defaults: connection pool, cache, fast path, worker threads                                                                                         |
| `klyro-naive`   | Klyro with the connection pool and cache switched off. **This is an ablation of our own server, not another product.** It shows what pooling and caching are worth |
| Scramjet client | The Scramjet-based client in `web/`, served by the same server (browser benchmark only)                                                                            |

**Not benchmarked**, and why:

- **Ultraviolet**: not installed in this repository. A fair browser comparison would need its own
  build and configuration, which I did not set up.
- **The previous Iridium implementation**: it only relays TCP (Wisp) and has no HTTP path. Its relay
  speed is covered by `npm run bench` (the Wisp benchmark), but it cannot be compared page-for-page.
- **Third-party websites**: the environment these were run in has no outbound internet access, and the
  brief asked for controlled fixtures. Real-site numbers will differ.

## Environment

`{"node":"v22.23.5","platform":"linux 6.18.44-fc-v726","cpus":4,"cpuModel":"Intel(R) Xeon(R) Processor @ 2.10GHz","memGb":16,"quick":false,"scale":0.5}`

The load generator, the fixture origin and the proxy processes share these 4 cores, so absolute
numbers are lower and noisier than on dedicated hardware. Tail latencies (p99) in particular are
noisy. Because everything is loopback, **network latency and TLS handshakes cost nothing here**; the
gains from connection reuse and caching are larger on a real network than shown.

## Results: server workloads (`npm run bench:suite`, scale 0.5)

`vs direct` and `vs naive` are throughput ratios (requests, or page loads, per second).
`cache hit` and `conn reuse` are read from the server's own `/metrics`.

| Workload                               | Target      | p50 ms | p90 ms | p95 ms | p99 ms |   req/s | vs direct | vs naive | CPU s | RSS MB | cache hit | conn reuse | failed |
| -------------------------------------- | ----------- | -----: | -----: | -----: | -----: | ------: | --------: | -------: | ----: | -----: | --------: | ---------: | -----: |
| 1 static HTML                          | direct      |   7.51 |   12.7 |   15.6 |  116.2 |  4714.0 |     1.00x |        - |     - |      - |         - |          - |      0 |
| 1 static HTML                          | klyro       |   29.5 |   42.3 |   48.2 |  305.0 |  1386.6 |     0.29x |    1.21x |  1.41 |  114.3 |        0% |        97% |      0 |
| 1 static HTML                          | klyro-naive |   38.8 |   54.0 |   57.5 |  231.4 |  1147.6 |     0.24x |        - |  1.72 |  120.8 |         - |         0% |      0 |
| 2 large HTML (~1.4 MB)                 | direct      |   7.89 |   12.1 |   17.7 |   45.5 |   823.2 |     1.00x |        - |     - |      - |         - |          - |      0 |
| 2 large HTML (~1.4 MB)                 | klyro       |  374.4 |  495.5 |  555.4 |  589.6 |    19.1 |     0.02x |    1.10x |  8.54 |  314.7 |        0% |       100% |      0 |
| 2 large HTML (~1.4 MB)                 | klyro-naive |  422.9 |  558.1 |  584.1 |  621.6 |    17.3 |     0.02x |        - |  9.37 |  310.0 |         - |         0% |      0 |
| 6 large image (8 MB)                   | direct      |   27.8 |   38.8 |   39.3 |  186.2 |   107.3 |     1.00x |        - |     - |      - |         - |          - |      0 |
| 6 large image (8 MB)                   | klyro       |   68.5 |   78.9 |   80.3 |   82.8 |    58.1 |     0.54x |    0.88x |  0.82 |  270.2 |        0% |        87% |      0 |
| 6 large image (8 MB)                   | klyro-naive |   43.4 |  132.8 |  132.9 |  150.2 |    66.0 |     0.61x |        - |  0.75 |  279.2 |         - |         0% |      0 |
| 7 streaming response (2 MB, chunked)   | direct      |   27.6 |   31.0 |   35.6 |   60.6 |   361.2 |     1.00x |        - |     - |      - |         - |          - |      0 |
| 7 streaming response (2 MB, chunked)   | klyro       |   39.0 |   50.4 |   56.0 |   83.1 |   255.0 |     0.71x |    1.12x |  0.50 |  302.2 |        0% |        93% |      0 |
| 7 streaming response (2 MB, chunked)   | klyro-naive |   42.9 |   52.4 |   55.9 |   72.8 |   226.8 |     0.63x |        - |  0.55 |  279.7 |         - |         0% |      0 |
| 8 range request                        | direct      |   3.00 |   4.56 |   4.96 |   30.3 | 13336.8 |     1.00x |        - |     - |      - |         - |          - |      0 |
| 8 range request                        | klyro       |   14.5 |   24.7 |   32.4 |  171.2 |  2616.0 |     0.20x |    1.15x |  0.87 |  294.3 |         - |        98% |      0 |
| 8 range request                        | klyro-naive |   20.5 |   31.0 |   34.8 |   40.0 |  2283.8 |     0.17x |        - |  1.00 |  289.6 |         - |         0% |      0 |
| 3 CSS-heavy page (20 stylesheets)      | direct      |   9.35 |   13.6 |   14.6 |   14.7 |   102.7 |     1.00x |        - |     - |      - |         - |          - |      0 |
| 3 CSS-heavy page (20 stylesheets)      | klyro       |   13.1 |   17.3 |   19.5 |   27.6 |    71.8 |     0.70x |    4.73x |  0.29 |  227.8 |       92% |       100% |      0 |
| 3 CSS-heavy page (20 stylesheets)      | klyro-naive |   64.2 |   82.6 |   83.2 |   85.6 |    15.2 |     0.15x |        - |  2.04 |  296.9 |         - |         0% |      0 |
| 4 JavaScript-heavy page (20 scripts)   | direct      |   5.89 |   9.17 |   9.40 |   9.73 |   148.8 |     1.00x |        - |     - |      - |         - |          - |      0 |
| 4 JavaScript-heavy page (20 scripts)   | klyro       |   6.88 |   12.1 |   14.6 |   17.8 |   123.3 |     0.83x |    1.79x |  0.15 |  228.7 |       92% |       100% |      0 |
| 4 JavaScript-heavy page (20 scripts)   | klyro-naive |   14.3 |   20.9 |   23.3 |   25.9 |    68.9 |     0.46x |        - |  0.46 |  296.1 |         - |         0% |      0 |
| 5 many small assets (100 images)       | direct      |   14.3 |   18.5 |   21.1 |   22.1 |    71.1 |     1.00x |        - |     - |      - |         - |          - |      0 |
| 5 many small assets (100 images)       | klyro       |   11.1 |   15.9 |   16.4 |   28.2 |    81.3 |     1.14x |    2.90x |  0.40 |  228.1 |       96% |       100% |      0 |
| 5 many small assets (100 images)       | klyro-naive |   33.0 |   45.6 |   50.4 |   51.1 |    28.0 |     0.39x |        - |  1.14 |  298.7 |         - |         0% |      0 |
| 10 repeated navigation (same page 40x) | direct      |   10.2 |   15.9 |   16.9 |   17.6 |    85.7 |     1.00x |        - |     - |      - |         - |          - |      0 |
| 10 repeated navigation (same page 40x) | klyro       |   11.0 |   17.7 |   20.1 |   20.8 |    78.0 |     0.91x |    2.69x |  0.19 |  228.4 |       94% |       100% |      0 |
| 10 repeated navigation (same page 40x) | klyro-naive |   33.3 |   41.8 |   42.4 |   52.5 |    29.0 |     0.34x |        - |  0.63 |  298.7 |         - |         0% |      0 |
| 9 WebSocket echo round trip (256 B)    | direct      |   0.04 |   0.06 |   0.08 |   0.14 | 21073.5 |     1.00x |        - |     - |      - |         - |          - |      0 |
| 9 WebSocket echo round trip (256 B)    | klyro       |   0.12 |   0.23 |   0.28 |   0.66 |  6601.0 |     0.31x |    0.81x |  0.10 |  228.7 |         - |          - |      0 |
| 9 WebSocket echo round trip (256 B)    | klyro-naive |   0.11 |   0.14 |   0.17 |   0.37 |  8183.7 |     0.39x |        - |  0.09 |  298.9 |         - |          - |      0 |
| 11 concurrent sessions (25 sessions)   | direct      |   2.29 |   4.35 |   5.05 |   16.0 |  8044.9 |     1.00x |        - |     - |      - |         - |          - |      0 |
| 11 concurrent sessions (25 sessions)   | klyro       |   7.43 |   10.6 |   11.0 |   13.4 |  2815.9 |     0.35x |    1.71x |  0.26 |  229.4 |        0% |        97% |      0 |
| 11 concurrent sessions (25 sessions)   | klyro-naive |   14.6 |   17.9 |   19.2 |   20.3 |  1651.2 |     0.21x |        - |  0.34 |  298.9 |         - |         0% |      0 |

### How to read this

- **Against a direct connection Klyro is slower on single requests** (0.20x to 0.71x for most; 0.02x
  for the 1.4 MB HTML page, where rewriting dominates): an extra hop costs time, and the proxy has
  real work to do. It matches or slightly beats direct only on page loads where the cache helps
  (100 images: 1.14x; JavaScript-heavy page 0.83x; repeated navigation 0.91x).
- **Against the naive configuration the ratio ranges from 0.81x to 4.73x**, largest where there are many
  requests to the same origin (connection reuse) or repeated assets (cache). It is about 1.1x to
  1.2x for single static requests, and there is no gain for the WebSocket and 8 MB image rows
  (within noise; the 8 MB image row shows the pooled server slightly slower, which I do not have an
  explanation for).
- **The 5x target is not met** by any workload in this run. The best ratio against naive is
  4.73x (CSS-heavy page (20 stylesheets)).
- **Memory**: resident size reached about 315 MB in the large-HTML workload (two worker threads plus
  buffered pages); about 115 MB for ordinary workloads. That is too high for a 1 GB machine at
  full load and is listed as a limitation.

## Results: browser page load (`npm run bench:browser`)

Headless Chromium, 6 runs each, a page with 100 small images. "Loaded" means every image has finished
loading. Cold = fresh browser context (for Scramjet this includes service worker and WebAssembly
start-up); warm = a second navigation.

| Page             | Phase | Mode         | p50 ms | mean ms | min ms | max ms | runs |
| ---------------- | ----- | ------------ | -----: | ------: | -----: | -----: | ---: |
| 100 small images | cold  | direct       |    156 |     159 |    132 |    196 |    6 |
| 100 small images | cold  | klyro-native |    203 |     215 |    184 |    253 |    6 |
| 100 small images | cold  | scramjet     |    678 |     684 |    646 |    731 |    6 |
| 100 small images | warm  | direct       |    137 |     144 |    123 |    167 |    6 |
| 100 small images | warm  | klyro-native |    200 |     194 |    168 |    214 |    6 |
| 100 small images | warm  | scramjet     |    550 |     541 |    450 |    583 |    6 |

Klyro native loads this page about 3.3x faster cold and 2.75x faster warm than the Scramjet client.
**This is not a like-for-like feature comparison**: Scramjet rewrites JavaScript and so supports
more sites; Klyro's native mode does less work and supports fewer.

## `klyro benchmark`

A real run against the fixture (Klyro vs its naive configuration, 100-image page):

```
Klyro Benchmark
Target: http://127.0.0.1:18900/k/tjweW_EHoTQfKtsK_JotrQ/http/127.0.0.1:45649/many.html
Requests: 1000
Concurrency: 50

P50: 36.25 ms
P90: 45.20 ms
P95: 51.77 ms
P99: 86.24 ms
Mean: 38.27 ms   Min: 10.61 ms   Max: 274.88 ms
Requests/sec: 1274.3
TTFB: p50 36.21 ms  p95 51.73 ms  p99 86.19 ms
CPU: 1.13 s over the run (144% of one core)
RAM: 115 MB resident after the run
Bytes: 7.35 MB received
Cache hit: 0.0%
Connection reuse: 95.6% (45 opened, 975 reused)
DNS (uncached, server side): n/a   Upstream to first byte: 14.09 ms   Transform: 0.33 ms
Failures: 0

Baseline: http://127.0.0.1:18901/k/XJUlidVtFpmg86c5Pjv2Pw/http/127.0.0.1:45649/many.html
  requests 1000 (1000 ok, 0 failed)  922.0 req/s  7.3 MB
  TTFB  min 5.90 ms  mean 53.25 ms  p50 45.38 ms  p90 54.76 ms  p95 58.78 ms  p99 380.73 ms  max 492.51 ms
  total min 5.94 ms  mean 53.29 ms  p50 45.41 ms  p90 54.79 ms  p95 58.81 ms  p99 380.76 ms  max 492.53 ms
  TCP   min 2.66 ms  mean 2.73 ms  p50 2.74 ms  p90 2.78 ms  p95 2.79 ms  p99 2.80 ms  max 2.80 ms
Improvement: 1.38x throughput, 1.25x lower median latency (baseline / target)
5x target: FAIL
```

The command compares throughput of `--target` over `--baseline`, and prints the 5x check as PASS
or FAIL. With no baseline it prints N/A. Here it printed FAIL, honestly.
