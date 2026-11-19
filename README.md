# @iridium-group/proxy

A Node server for Iridium. It serves static files and a [Wisp v1](https://github.com/MercuryWorkshop/wisp-protocol)
WebSocket endpoint, and applies the security settings from your Iridium config to every stream.

- Configured with [`@iridium-group/config`](https://github.com/Iridium-Group/iridium-config): file,
  `IRIDIUM_*` environment overrides and validation.
- Policy comes from [`@iridium-group/transport`](https://github.com/Iridium-Group/iridium-transport)'s
  `AddressPolicy`: the host is resolved first, refused if any answer is private (when
  `blockPrivateAddresses` is on), and the connection goes to that exact address.
- TCP streams only. UDP streams are refused with close reason `0x41`.

## Browser client

`web/` is a ready-made web proxy front end built on [Scramjet](https://github.com/MercuryWorkshop/scramjet),
bare-mux and the libcurl transport, talking to this server's Wisp endpoint. Build it once and
`npx iridium-proxy` serves it automatically when you have no `public/` folder of your own:

```sh
npm run build:web
npm start          # open http://localhost:8080
```

`npm --prefix web test` loads a page through the whole stack in headless Chromium. It is tested
against a local site only. Sites such as Discord or CAPTCHA pages depend on Scramjet's own site
support and on the IP the server runs from (Scramjet's authors say CAPTCHAs and YouTube are
unreliable from datacenter IPs); none of that is verified here.

`web/` is AGPL-3.0 because of the libraries it loads; the rest of this repo is MIT. See `NOTICE`.

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

## Bandwidth cap

To avoid surprise bills on a host that charges for outbound data, set a monthly cap:

```sh
IRIDIUM_MONTHLY_CAP=900MB IRIDIUM_USAGE_FILE=/var/lib/iridium-proxy/usage.json npm start
```

The proxy counts bytes in both directions per UTC month and saves the count to the usage file,
so a restart does not reset it. At the cap it closes open streams and refuses new ones (Wisp
close reason `0x49`) until the month rolls over. `/healthz` shows the current usage and cap.

The cap counts only what this server relays. It does not include other traffic on the same
machine, or charges for things like a static IP address, so check your provider's pricing as well.

## Deploying on a VM

`deploy/setup-vm.sh` installs everything on a fresh Ubuntu VM (for example an Oracle Cloud Always
Free instance): Node, Caddy for automatic HTTPS, the proxy and browser client, and a systemd
service that restarts on its own. Without a domain it uses `<your-ip>.nip.io`.

```sh
curl -fsSL https://raw.githubusercontent.com/Iridium-Group/iridium-proxy/main/deploy/setup-vm.sh | sudo CAP=5TB bash
```

Also open ports 80 and 443 in the provider's own firewall (on Oracle: the VCN security list).

Most clouds also let you paste `deploy/cloud-init.yaml` into the VM's "Custom data" / "User data" box, which runs the same install on first boot, with nothing to type over SSH.

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
