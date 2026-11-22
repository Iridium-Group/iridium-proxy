# Deployment

Target: an Ubuntu 24.04 VM (Oracle Cloud Always Free, either the AMD64 `E2.1.Micro` or the Arm
`A1.Flex` shape), with Caddy in front for HTTPS:

```
Internet -> HTTPS -> Caddy (80/443) -> Klyro (127.0.0.1:8080) -> origin
```

The Klyro port is bound to `127.0.0.1` and is never exposed. Only 22, 80 and 443 should be open.

**Status of this guide:** `deploy/setup-vm.sh` has been syntax-checked and its pieces were tested
(the server, the environment it sets, the bandwidth cap), but it **has not been run on a real Oracle
VM, and nothing here has been tested on ARM64.** Klyro's dependencies are pure JavaScript with no
native add-ons, so ARM64 should work, but that is expected, not verified.

## 1. Create the VM

1. Oracle Cloud console: Compute, Instances, Create. Image **Ubuntu 24.04**, a shape marked
   _Always Free_, a public IPv4 address, and your SSH public key.
2. In the instance's VCN security list add **ingress** rules for TCP **80** and **443** from
   `0.0.0.0/0` (22 is already there). Oracle blocks everything else.
3. Capacity errors ("out of host capacity") are common for the Arm shape. Try the AMD shape or retry
   later.

## 2. Install

SSH in and run (use your own cap; check your provider's current free outbound allowance first):

```sh
curl -fsSL https://raw.githubusercontent.com/Iridium-Group/iridium-proxy/main/deploy/setup-vm.sh | sudo CAP=5TB bash
```

It installs Node 24 and Caddy, creates an unprivileged `iridium` user, builds Klyro, installs a
hardened systemd service (`iridium-proxy`, restarts on failure), writes the Caddyfile and opens
80/443 in the VM's own firewall if it blocks them. With no `DOMAIN` it uses `<ip-with-dashes>.nip.io`
for the certificate. Prefer a real domain:

```sh
curl -fsSL https://raw.githubusercontent.com/Iridium-Group/iridium-proxy/main/deploy/setup-vm.sh | sudo DOMAIN=klyro.example.com CAP=5TB bash
```

(Point an A record at the VM's IP first. Caddy needs port 80 reachable to get the certificate.)

On small machines the script adds a 2 GB swap file so the build does not run out of memory, and sets
conservative limits (`MAX_SESSIONS=200`, `CACHE_SIZE=32MB`, `MAX_CONNECTIONS=64`; override by setting
those variables when you run it).

### If something else already uses port 8080

The installer stops with a message naming the process instead of fighting it. Either stop that
process, or install Klyro on another port and leave the other service alone:

```sh
curl -fsSL https://raw.githubusercontent.com/Iridium-Group/iridium-proxy/main/deploy/setup-vm.sh | sudo PORT=8090 CAP=5TB bash
```

`PORT` is the port Klyro listens on locally (always on 127.0.0.1); Caddy forwards to it. The
installer never replaces a Caddy config of yours: it writes its own site to `/etc/caddy/klyro.caddy`
and adds one `import` line to your Caddyfile (keeping a dated backup, `Caddyfile.bak.*`). It validates the
result first, restores your file if validation fails, and reloads Caddy instead of restarting it, so
WebSocket connections on your other sites stay up.

## 3. Check

```sh
curl -s https://YOUR-HOST/health
curl -s https://YOUR-HOST/ready
systemctl status iridium-proxy
journalctl -u iridium-proxy -f
```

Open `https://YOUR-HOST/`, enter an address, and press GO.

## Updating

Run the install command again. It fetches the latest code, rebuilds and restarts the service.

## Other ways to run it

- **Your own machine**: `./deploy/home/run.sh` (builds, starts, and opens a Cloudflare quick tunnel).
- **Docker**: `docker build -t klyro .` then `docker run -p 8080:8080 klyro`. The Dockerfile has not
  been built in the environment this was written in (no Docker daemon), so treat it as untested.
- **First-boot automation**: paste `deploy/cloud-init.yaml` into a VM's user data.

## Hardening checklist

- Keep `IRIDIUM_SECURITY__BLOCK_PRIVATE_ADDRESSES=true` (the default).
- Keep `RATE_LIMIT` and `IRIDIUM_MONTHLY_CAP` set on a public server.
- The proxy has no login. Anyone who can reach it can use it. Add access control in Caddy
  (basic auth or an IP allow-list) if the server should be private.
- Read your provider's acceptable-use policy: running a proxy may not be allowed on every host.

## Hardening a separate Wisp server (Bromine)

If a standalone `wisp-js` server runs next to Klyro (the `bromine-wisp` service on port 8080), two
things are worth fixing. `deploy/harden-bromine-wisp.sh` does both, and it can be run twice safely:

- **One bad client can stop the whole server.** A WebSocket message without a mask (browsers never send
  one) makes the `ws` library raise an error that nothing handles, which ends the process and drops
  every other client. The script logs errors that carry a `WS_ERR_*` code and keeps serving; any other
  error still stops the process. A deliberately malformed frame reproduced the crash on the original
  code, and the patched server survived the same frame.
- **It listened on every interface.** A new `WISP_HOST` setting (default `0.0.0.0`, so other hosts
  behave as before) is set to `127.0.0.1` in the systemd unit, since only Caddy needs to reach it.

```bash
curl -fsSL https://raw.githubusercontent.com/Iridium-Group/iridium-proxy/main/deploy/harden-bromine-wisp.sh | ssh -i KEY ubuntu@HOST sudo bash
```

It backs up the files it edits (`*.bak.<time>`), refuses to touch files that do not look as expected,
restarts the service, sends the malformed frame as a check, and puts everything back if the service
does not come back healthy. If the server directory is a git checkout, the edit shows up as a local
change; commit it or expect `git pull` to need a merge.
