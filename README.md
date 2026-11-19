# @iridium-group/proxy

A Node server for Iridium. It serves static files and a [Wisp v1](https://github.com/MercuryWorkshop/wisp-protocol)
WebSocket endpoint, and applies the security settings from your Iridium config to every stream.

- Configured with [`@iridium-group/config`](https://github.com/Iridium-Group/iridium-config): file,
  `IRIDIUM_*` environment overrides and validation.
- Policy comes from [`@iridium-group/transport`](https://github.com/Iridium-Group/iridium-transport)'s
  `AddressPolicy`: the host is resolved first, refused if any answer is private (when
  `blockPrivateAddresses` is on), and the connection goes to that exact address.
- TCP streams only. UDP streams are refused with close reason `0x41`.

## Run

```sh
npm ci && npm run build
npm start                        # reads $IRIDIUM_CONFIG or ./iridium.config.json
npm start -- path/to/config.json
```

`PORT` is honoured when `IRIDIUM_SERVER__PORT` is not set, so most hosts work without extra setup.

| Path                | What it does                                                        |
| ------------------- | ------------------------------------------------------------------- |
| `/healthz`          | `{"status":"ok"}` for load balancers                                |
| `server.wispPath`   | Wisp WebSocket endpoint (plain HTTP gets 426)                       |
| `server.basePath/*` | Static files from `server.staticDir`, with `index.html` for folders |

## Hosting

The Wisp endpoint is a long-lived WebSocket that opens raw TCP connections, so it needs a
host that runs a persistent Node process (a VM, a container platform, Fly.io, Railway, Render).
It cannot run on Vercel's serverless functions; host the static site there if you like and point
`transport.url` at this server.

```sh
docker build -t iridium-proxy .
docker run -p 8080:8080 -e IRIDIUM_SECURITY__BLOCK_PRIVATE_ADDRESSES=true iridium-proxy
```

Put it behind TLS (a platform router or reverse proxy) so clients can use `wss://`.

## Performance

`npm run bench` pushes 256 MB through the Wisp endpoint to a local echo server and times 5000
small round trips. On a shared cloud VM (loopback, Node client) it measured about 120 MB/s each
way and a median of 0.03 ms added latency. That is well above a home connection, so in practice
the limit is the server's own network link and the distance to it. Data is copied once per
direction, sockets use `TCP_NODELAY`, and a slow client pauses reads from the target instead of
buffering without limit.

## Security notes

- Private and loopback targets are blocked by default. Keep `blockPrivateAddresses` on for any
  server reachable from the internet, otherwise it is a way into your internal network.
- Ports 25, 465 and 587 are blocked by default; set `allowedPorts` for a strict allow-list.
- Each client may hold 256 streams; further `CONNECT`s get close reason `0x49` (throttled).
- There is no authentication or rate limiting per client. Add that in front if you need it.

## Library

```ts
import { loadConfig } from '@iridium-group/config';
import { createProxyServer } from '@iridium-group/proxy';

const proxy = createProxyServer(await loadConfig());
await proxy.listen();
```

## Development

```sh
npm ci
npm run format:check && npm run typecheck && npm run build && npm test
```

## License

MIT
