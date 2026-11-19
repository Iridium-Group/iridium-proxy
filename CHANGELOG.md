# Changelog

## 0.1.0

- Static file server with path-traversal protection and `/healthz`.
- Wisp v1 endpoint that enforces `AddressPolicy` after DNS resolution, queues data sent before a
  stream is open, limits streams per client, and times out slow connects.
- `iridium-proxy` CLI, `PORT` support, Dockerfile.
