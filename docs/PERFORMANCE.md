# Performance

## The 5x target

**Klyro 5x Target.** Klyro targets up to roughly 5x improvement over relevant baseline
configurations on selected workloads. This is a target, not a result.

**Status after the first measured run: not met.** See [BENCHMARKS.md](BENCHMARKS.md) for every number.

| Comparison                                                      | Measured                                    |
| --------------------------------------------------------------- | ------------------------------------------- |
| Klyro vs a direct connection, single requests                   | 0.02x to 0.71x (an extra hop is never free) |
| Klyro vs a direct connection, page loads with assets            | 0.70x to 1.14x (the cache closes the gap)   |
| Klyro vs Klyro with pooling and caching off                     | 0.81x to 4.73x (best: CSS-heavy page)       |
| Klyro native vs the Scramjet client in Chromium, 100-image page | about 3.3x faster cold, 2.75x warm          |

The honest claim today is: **up to 4.7x over its own unoptimised configuration on asset-heavy page
loads, and about 3x faster than the Scramjet client on one browser workload.** It is not faster than
not using a proxy, and cannot be: a proxy adds a hop.

## What was optimised, and what the measurements showed

Each item was profiled or measured before and after. Items that did not help are listed too.

| Change                                                                                       | Measured effect                                                                                                                                                                                                                                |
| -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Connection pool (keep-alive, address pinned)                                                 | 87-100% of origin requests reuse a connection on asset-heavy workloads; 1.2x on single static requests, up to 4.7x on page loads (with cache)                                                                                                  |
| Memory cache with ETag/Last-Modified revalidation                                            | 92-96% hit rate on page loads; the main source of the 2.7-4.7x page-load gains                                                                                                                                                                 |
| Fast path for non-HTML/CSS (stream, no parsing)                                              | Streams 8 MB bodies without buffering (tested: first chunk reaches the client while the origin is still sending)                                                                                                                               |
| **Skip tags that have no URL attributes** in the HTML rewriter                               | On a typical page, 69 ms to 39 ms per 800 KB document (1.8x). **No effect** on a document where 2 of 3 tags carry URLs. My first guess at the cause was wrong for that document; I measured before keeping the change                          |
| **Rewrite large pages on worker threads**                                                    | 1.4 MB page: 10.8 to 21.5 requests/s (2.0x), median 731 to 354 ms. While a large page was being rewritten, the p99 of unrelated small requests fell from 865-1243 ms to 11-22 ms (repeated over two trials). This was the most valuable change |
| Replace the response stream pipeline with a hand-written write loop                          | **No measurable gain** (75-91 req/s against 88 before, within noise). Reverted; the simpler code stayed                                                                                                                                        |
| Wisp relay: count queued data toward flow control, fewer copies, `TCP_NODELAY`, backpressure | Fixed a deadlock; about 120 MB/s each way in the Wisp benchmark (`npm run bench`)                                                                                                                                                              |

## Bugs the benchmarks found

Benchmarks are only useful if they are believed, so these are listed plainly:

- Default session and DNS lifetimes were read in the wrong unit (seconds as milliseconds), so a real
  server expired idle sessions after 1.8 s. Unit tests missed it because they passed settings
  directly; a benchmark that ran the real binary exposed it. A test now checks the defaults.
- A test fixture answered `Upgrade: h2c` (which libcurl sends) with HTTP 400 and, later, hijacked
  keep-alive connections. Both were fixture bugs, not proxy bugs, and are fixed.
- A "warm" browser measurement was initially invalid: it compared against the previous page's
  already-loaded images. The check now waits for the new document.

## Where time goes

- **Transform path**: tokenising the HTML is now the main cost (htmlparser2 at roughly 13-20 MB/s per
  core on this machine). Large documents are CPU-bound; that is why they are offloaded.
- **Fast path**: Node's HTTP client and server move roughly 600-700 MB/s through the proxy on this
  machine, far above any real network link, so it is not the bottleneck.
- **Not measured**: allocation counts and GC pressure (the profile showed GC at ~13% of the rewriter),
  TLS time (loopback fixtures are plain HTTP except in the HTTPS correctness test), and DNS latency
  against a real resolver (the fixtures use IP literals or a stub).

## Ideas that were not done

- Streaming HTML rewrite (rewrite as chunks arrive, instead of buffering the page). It would cut
  time-to-first-byte and memory on very large pages, at the cost of complexity around split tags.
- A faster HTML tokenizer than htmlparser2 (for example a streaming Rust/WASM one).
- HTTP/2 to origins.
- Recompressing rewritten HTML (currently sent uncompressed; Caddy can compress it).
