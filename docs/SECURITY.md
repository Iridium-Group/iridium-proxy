# Security

Klyro is an outbound proxy. The main risk is that someone uses it to reach things they should not
(your internal network, cloud metadata), so destination validation is the core of the design.

## What is enforced

| Threat                                          | Defence                                                                                                                                                                                                                                                                      | Tested in                                            |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| SSRF to loopback, private, link-local, metadata | Every resolved address must be public (`AddressPolicy`). Names such as `localhost`, `*.local`, `*.internal`, `metadata.google.internal` are refused outright. IP literals in decimal/hex/short forms and IPv4-mapped IPv6 are normalised by the URL parser and then checked. | `klyro: security`                                    |
| DNS rebinding                                   | The policy checks **all** answers (one public + one private is refused), and the connection pool resolves again through the same policy when a socket is opened, so a changed answer after validation is refused.                                                            | `re-checks DNS when connecting`                      |
| Redirect abuse                                  | Redirects are never followed by the server. `Location` is rewritten to a proxied path, so the browser's next request is validated like any other. Chains over 20 in 10 s end with 508.                                                                                       | `rewrites redirects`, `revalidates redirect targets` |
| Protocol confusion                              | Only `http` and `https` (and `ws`/`wss` for WebSockets). `file:`, `ftp:`, `gopher:`, `javascript:` and others are refused. URLs with embedded credentials are refused.                                                                                                       | `blocks dangerous schemes`                           |
| Header injection                                | Request headers are copied through an exclusion list and validated by Node's HTTP stack; CR/LF and control characters in proxied paths are rejected.                                                                                                                         | `rejects malformed proxy paths`                      |
| Request smuggling                               | Requests with both `Content-Length` and `Transfer-Encoding` are refused; hop-by-hop headers are never forwarded; lengths are recomputed.                                                                                                                                     | `refuses ... request smuggling`                      |
| Resource exhaustion                             | Limits on sessions, upstream sockets, request body, response body, rewritten page size, request time, per-client request rate, and a monthly bandwidth cap.                                                                                                                  | `klyro: limits and lifecycle`                        |
| Cookie leakage                                  | One cookie jar per session; `Set-Cookie` never reaches the browser; stored cookies are sent only on top-level navigations or same-site requests.                                                                                                                             | `isolates sessions`, `SameSite-like rule`            |
| Cache leakage                                   | Cache keys start with the session id; responses to cookie- or credential-bearing requests, `Set-Cookie` responses, `private` and `no-store` are not cached.                                                                                                                  | `isolates sessions: a cached response ...`           |
| Secrets in logs                                 | Logs contain method, host, status, route and timing only: never paths, queries, headers, cookies or tokens.                                                                                                                                                                  | `never logs cookies ...`                             |

## Credentials

Klyro does not handle passwords or sign-in flows. `Authorization` headers from the browser are not
forwarded, and sign-in pages of large identity providers (`accounts.google.com`,
`login.microsoftonline.com`, ...) are refused with an explanation. Do not sign in to anything through
Klyro. See the next section for why.

## The shared-origin limitation (read this)

Path-style proxying puts **every proxied site in the proxy's one browser origin**. Browser storage
(localStorage, IndexedDB, service workers) is therefore shared between proxied sites, and a proxied
page can read its own session id from its URL. Mitigations in place: cookies are never exposed to
pages and are sent only on same-site requests or top-level navigations, so a hostile page cannot
make the proxy attach another site's cookies to a request. **This does not protect browser storage.**
Treat proxied sites as able to see each other's local data, and use Klyro for browsing, not accounts.
Compatibility mode (Scramjet) emulates separate origins in JavaScript and handles this differently.

Per-site origins via wildcard subdomains (`<id>.klyro.example`) would remove this limit. They need a
wildcard DNS name and certificate and are not implemented.

## Other limits

- No authentication to use the proxy itself. Anyone who can reach it can use it, within the rate
  limits. Put it behind your own access control if that matters.
- Rate limiting is per client address, taken from `X-Forwarded-For` only when the connection comes
  from the local machine (the Caddy setup in [DEPLOYMENT.md](DEPLOYMENT.md)).
- `Sec-Fetch-*` based cookie rules assume a modern browser. Clients that send no fetch metadata
  (curl, scripts) are treated as not being a browser page.
- TLS to origins is verified normally; there is no option to disable verification.

## Reporting a problem

Open a private security advisory on the GitHub repository.
