# Troubleshooting

Every error page shows a short request id. The same id is in the `X-Klyro-Request-Id` response
header and in the server log line for that request (method, host, status, route and time only).

| Symptom                                    | Likely cause                                                                                                    | What to do                                                                                                                                                                       |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "This session has expired" (410)           | The session was idle longer than `SESSION_TTL`, or was evicted because `MAX_SESSIONS` was reached               | Start again from the home page                                                                                                                                                   |
| "Blocked" (403)                            | The address is private, loopback, link-local, metadata, a blocked port, or a sign-in page                       | Intended. Use a public address. To reach a private address on purpose, set `IRIDIUM_SECURITY__BLOCK_PRIVATE_ADDRESSES=false` on a server that is **not** exposed to the internet |
| "The site has a certificate problem" (502) | The origin's certificate is invalid, expired or self-signed                                                     | Klyro never turns certificate checks off                                                                                                                                         |
| "The site could not be found" (502)        | DNS failed. A wrong address or a resolver problem                                                               | Check the name; check `/metrics` `klyro_dns_*`                                                                                                                                   |
| "The site took too long" (504)             | No response headers within `REQUEST_TIMEOUT`                                                                    | Raise `REQUEST_TIMEOUT` for slow sites                                                                                                                                           |
| "This page is too large to rewrite" (502)  | HTML/CSS over `MAX_TRANSFORM_SIZE` without a Content-Length                                                     | Raise `MAX_TRANSFORM_SIZE`                                                                                                                                                       |
| "Slow down" (429)                          | `RATE_LIMIT` per client reached                                                                                 | Wait, or raise `RATE_LIMIT`                                                                                                                                                      |
| "Too many redirects" (508)                 | A redirect loop                                                                                                 | The site is redirecting to itself                                                                                                                                                |
| Page loads but looks broken                | Images, scripts or fonts built from JavaScript with `location`, or loaded through a path Klyro does not rewrite | Try `KLYRO_UI=compat`. See [COMPATIBILITY.md](COMPATIBILITY.md)                                                                                                                  |
| Everything works but streams are cut       | `MAX_RESPONSE_SIZE` reached, or the bandwidth cap (`IRIDIUM_MONTHLY_CAP`)                                       | Raise the limit; check `/healthz` usage                                                                                                                                          |
| `npm start` says a variable must be a size | Bad value such as `CACHE_SIZE=big`                                                                              | Use a number with a unit, e.g. `64MB`                                                                                                                                            |
| High memory use                            | Large pages rewritten on worker threads, big cache                                                              | Lower `CACHE_SIZE`, `TRANSFORM_WORKERS` and `MAX_SESSIONS`                                                                                                                       |
| Works locally, not behind Caddy            | Caddy not forwarding WebSockets or buffering                                                                    | Use the Caddyfile in [DEPLOYMENT.md](DEPLOYMENT.md)                                                                                                                              |

## Useful checks

```sh
curl -s localhost:8080/health          # liveness
curl -s localhost:8080/ready           # 503 while shutting down
curl -s localhost:8080/metrics | grep klyro_requests_failed   # why requests fail
journalctl -u iridium-proxy -f                # logs on a VM
```

## Getting help

Open an issue with the request id, the status, and the route (`fast`, `transform`, `cache`).
Never paste cookies, tokens or full URLs with query strings.
