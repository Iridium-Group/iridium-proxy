# Configuration

Klyro reads the Iridium config file and environment variables.

## Iridium config file

`iridium.config.json` (or `$IRIDIUM_CONFIG`, or a path argument). Documented in full at
[iridium-config](https://github.com/Iridium-Group/iridium-config/blob/main/docs/CONFIGURATION.md).
The sections Klyro uses:

| Setting                          | Env override                                | Default           | Meaning                                                          |
| -------------------------------- | ------------------------------------------- | ----------------- | ---------------------------------------------------------------- |
| `server.host`                    | `IRIDIUM_SERVER__HOST`                      | `0.0.0.0`         | Interface to listen on (`127.0.0.1` behind Caddy)                |
| `server.port`                    | `IRIDIUM_SERVER__PORT`                      | `8080`            | Port. `PORT` is used if this is not set                          |
| `server.wispPath`                | `IRIDIUM_SERVER__WISP_PATH`                 | `/wisp/`          | Wisp endpoint (compatibility mode)                               |
| `server.staticDir`               | `IRIDIUM_SERVER__STATIC_DIR`                | `public`          | Your own front end; if it does not exist, Klyro's page is served |
| `security.blockPrivateAddresses` | `IRIDIUM_SECURITY__BLOCK_PRIVATE_ADDRESSES` | `true`            | **Keep on** for anything reachable from the internet             |
| `security.blockedPorts`          | `IRIDIUM_SECURITY__BLOCKED_PORTS`           | `[25, 465, 587]`  | Never connect to these                                           |
| `security.allowedPorts`          | `IRIDIUM_SECURITY__ALLOWED_PORTS`           | unset             | If set, only these                                               |
| `logging.level` / `.format`      | `IRIDIUM_LOGGING__LEVEL` / `__FORMAT`       | `info` / `pretty` | `json` for log shippers                                          |

## Klyro limits (environment only)

| Variable                | Default             | Meaning                                                     |
| ----------------------- | ------------------- | ----------------------------------------------------------- |
| `KLYRO_ENABLED`         | `1`                 | `0` turns native mode off (Wisp only)                       |
| `KLYRO_UI`              | `klyro`             | `compat` serves the Scramjet client instead                 |
| `MAX_SESSIONS`          | `500`               | Live sessions; the least recently used is evicted when full |
| `SESSION_TTL`           | `1800`              | Idle seconds before a session expires                       |
| `MAX_CONNECTIONS`       | `128`               | Simultaneous upstream sockets                               |
| `MAX_REQUEST_SIZE`      | `10MB`              | Largest request body (413 above)                            |
| `MAX_RESPONSE_SIZE`     | `2GB`               | A response stream is cut off past this                      |
| `MAX_TRANSFORM_SIZE`    | `8MB`               | HTML/CSS larger than this passes through unrewritten        |
| `CACHE_SIZE`            | `64MB`              | Memory cache budget; `0` turns the cache off                |
| `CACHE_ITEM_SIZE`       | `1MB`               | Largest single cached response                              |
| `REQUEST_TIMEOUT`       | `30000`             | Milliseconds to connect and get response headers            |
| `IDLE_TIMEOUT`          | `15000`             | Milliseconds an unused upstream socket is kept              |
| `DNS_TTL`               | `60`                | Seconds DNS answers are cached                              |
| `RATE_LIMIT`            | `3000`              | Requests per minute per client; `0` turns it off            |
| `TRANSFORM_WORKERS`     | `min(2, cores - 1)` | Worker threads for large pages; `0` = inline                |
| `TRANSFORM_OFFLOAD_MIN` | `256KB`             | Pages at least this big go to a worker                      |
| `IRIDIUM_MONTHLY_CAP`   | none                | Monthly bandwidth cap for the Wisp relay, e.g. `900MB`      |
| `IRIDIUM_USAGE_FILE`    | none                | File that keeps the cap's count across restarts             |

Sizes accept `KB`, `MB`, `GB`, `TB` (decimal). Times are as shown; `SESSION_TTL` and `DNS_TTL` are in
seconds, the others in milliseconds. A bad value stops start-up with a message naming the variable.

Benchmark-only switches: `KLYRO_POOL=0` (no connection reuse), `KLYRO_FORCE_TRANSFORM=1`.

## Small VMs

On a 1 GB / 1 core machine (Oracle's free x86 shape, Google e2-micro) use roughly:
`MAX_SESSIONS=200 CACHE_SIZE=32MB MAX_CONNECTIONS=64`. With one core `TRANSFORM_WORKERS` is already 0.
