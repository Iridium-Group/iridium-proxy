# Compatibility

**Status values:** `SUPPORTED` means tested here and works. `PARTIAL` means tested and some parts
work. `UNSUPPORTED` means it does not work, or is refused on purpose. `UNTESTED` means not tested, so
no claim is made.

The environment these tests ran in has **no outbound internet access**, so **no real website has been
tested.** Everything marked SUPPORTED is supported on the controlled fixtures in
`test/fixtures/origin.ts`, in Node and in headless Chromium. Real sites are much harder than fixtures.

| Site / category                                                               | HTML | CSS | JS  | Media | WebSocket | Login        | Status                        | Notes                                                                                                                     |
| ----------------------------------------------------------------------------- | ---- | --- | --- | ----- | --------- | ------------ | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Static pages (fixture)                                                        | yes  | yes | yes | n/a   | n/a       | n/a          | SUPPORTED                     | URLs rewritten, scripts untouched                                                                                         |
| Page with 100 assets (fixture)                                                | yes  | yes | yes | yes   | n/a       | n/a          | SUPPORTED                     | Cached, connections reused                                                                                                |
| Page JavaScript with runtime `fetch`/XHR/`WebSocket` URLs (fixture, Chromium) | yes  | n/a | yes | n/a   | yes       | n/a          | SUPPORTED                     | Root-relative, relative and absolute URLs all tested                                                                      |
| Large media, range requests, chunked streaming (fixture)                      | n/a  | n/a | n/a | yes   | n/a       | n/a          | SUPPORTED                     | Never buffered; 206 passes through                                                                                        |
| gzip HTML (fixture)                                                           | yes  | n/a | n/a | n/a   | n/a       | n/a          | SUPPORTED                     | Decoded, rewritten, sent uncompressed. gzip is tested. deflate and brotli use Node's zlib but have not been tested here   |
| HTTPS origin (fixture, test CA)                                               | yes  | n/a | n/a | n/a   | n/a       | n/a          | SUPPORTED                     | Certificates are verified; untrusted ones give 502                                                                        |
| Cookie-based sessions within one site (fixture)                               | yes  | n/a | n/a | n/a   | n/a       | cookies only | SUPPORTED                     | Per-session jar; sent on same-site requests and top-level navigations                                                     |
| Sign-in with Google, Microsoft, Apple, AWS                                    | n/a  | n/a | n/a | n/a   | n/a       | refused      | UNSUPPORTED                   | Refused on purpose with a clear message. Klyro does not handle credentials                                                |
| Sites that build URLs from `location` in JavaScript                           | yes  | yes | no  | n/a   | n/a       | n/a          | PARTIAL (expected)            | `location` shows the proxied path, not the real one. Not tested on a real site                                            |
| Single-page apps, web apps with heavy JavaScript                              | ?    | ?   | ?   | ?     | ?         | ?            | UNTESTED                      | Native mode does not rewrite JavaScript. Try compatibility mode (`KLYRO_UI=compat`)                                       |
| Video and audio sites, MediaSource                                            | ?    | ?   | ?   | ?     | ?         | ?            | UNTESTED                      | Plain media files and ranges work on fixtures; adaptive streaming sites not tested                                        |
| CAPTCHAs                                                                      | ?    | ?   | ?   | ?     | ?         | n/a          | UNTESTED                      | Depends on JavaScript behaviour and on the server's IP. Scramjet's authors say datacenter IPs are unreliable for CAPTCHAs |
| Discord, social networks, chat apps                                           | ?    | ?   | ?   | ?     | ?         | login        | UNTESTED / likely UNSUPPORTED | They need sign-in, which Klyro refuses to handle                                                                          |
| Service workers registered by proxied pages                                   | ?    | n/a | ?   | n/a   | n/a       | n/a          | UNTESTED                      | The proxied page's worker would register under the proxy's origin                                                         |
| Pages over 8 MB of HTML, or with an unknown content encoding                  | yes  | n/a | n/a | n/a   | n/a       | n/a          | PARTIAL                       | Passed through without URL rewriting                                                                                      |

## If a site does not work

1. Check the error page: it gives a request id and a reason (blocked address, timeout, certificate).
2. Try compatibility mode: `KLYRO_UI=compat` serves the Scramjet client, which rewrites JavaScript.
3. See [TROUBLESHOOTING.md](TROUBLESHOOTING.md).
