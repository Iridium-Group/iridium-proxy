#!/usr/bin/env bash
# Install Iridium proxy on a fresh Ubuntu VM (x86 or ARM), e.g. an Oracle Cloud Always Free instance.
#
#   curl -fsSL https://raw.githubusercontent.com/Iridium-Group/iridium-proxy/main/deploy/setup-vm.sh | sudo bash
#
# Optional settings, passed as environment variables:
#   DOMAIN=proxy.example.com   Host name for HTTPS. Default: <public-ip>.nip.io (works with no domain).
#   CAP=5TB                    Monthly bandwidth cap. Check your provider's free allowance first.
#   PORT=8080                  Port Klyro listens on (on 127.0.0.1). Change it if something else uses 8080.
#   MAX_SESSIONS, CACHE_SIZE, MAX_CONNECTIONS   Klyro limits (defaults suit a 1 GB machine).
#   BRANCH=main                Git branch to install.
set -euo pipefail

[ "$(id -u)" -eq 0 ] || { echo "Run as root (use sudo)." >&2; exit 1; }

REPO=https://github.com/Iridium-Group/iridium-proxy
BRANCH=${BRANCH:-main}
CAP=${CAP:-5TB}
PORT=${PORT:-8080}
case "$PORT" in
  ''|*[!0-9]*) echo "PORT must be a number, got '$PORT'." >&2; exit 1 ;;
esac
if [ "$PORT" -lt 1024 ] || [ "$PORT" -gt 65535 ]; then echo "PORT must be between 1024 and 65535." >&2; exit 1; fi
APP=/opt/iridium-proxy
DATA=/var/lib/iridium-proxy

# Small machines (1 GB RAM, like Oracle's free x86 shape) can run out of memory during the build,
# so add a swap file if there is little RAM and no swap yet.
mem_kb=$(awk '/MemTotal/ {print $2}' /proc/meminfo)
if [ "$mem_kb" -lt 2000000 ] && [ -z "$(swapon --show --noheadings)" ]; then
  fallocate -l 2G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=2048
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl git ca-certificates debian-keyring debian-archive-keyring apt-transport-https gpg

# Node 24
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  apt-get install -y nodejs
fi

# Caddy (automatic HTTPS)
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy
fi

# App user and code
id iridium >/dev/null 2>&1 || useradd --system --home "$APP" --shell /usr/sbin/nologin iridium
mkdir -p "$DATA"
chown iridium:iridium "$DATA"
if [ -d "$APP/.git" ]; then
  # The folder belongs to the service user, so root must be told it is a safe repository
  # (otherwise git stops with "detected dubious ownership" on every update).
  git -c safe.directory="$APP" -C "$APP" fetch --depth 1 origin "$BRANCH"
  git -c safe.directory="$APP" -C "$APP" reset --hard FETCH_HEAD
else
  rm -rf "$APP"
  git clone --depth 1 --branch "$BRANCH" "$REPO" "$APP"
fi
cd "$APP"
npm ci
npm run build:web
chown -R iridium:iridium "$APP"

# Service
cat > /etc/systemd/system/iridium-proxy.service <<UNIT
[Unit]
Description=Iridium proxy
After=network-online.target
Wants=network-online.target

[Service]
User=iridium
WorkingDirectory=$APP
ExecStart=/usr/bin/node $APP/bin/iridium-proxy.js
Environment=PORT=$PORT
Environment=IRIDIUM_SERVER__HOST=127.0.0.1
Environment=IRIDIUM_SECURITY__BLOCK_PRIVATE_ADDRESSES=true
Environment=IRIDIUM_LOGGING__LEVEL=info
Environment=IRIDIUM_MONTHLY_CAP=$CAP
Environment=MAX_SESSIONS=${MAX_SESSIONS:-200}
Environment=CACHE_SIZE=${CACHE_SIZE:-32MB}
Environment=MAX_CONNECTIONS=${MAX_CONNECTIONS:-64}
Environment=IRIDIUM_USAGE_FILE=$DATA/usage.json
Restart=always
LimitNOFILE=65536
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=$DATA

[Install]
WantedBy=multi-user.target
UNIT

# HTTPS front door
if [ -z "${DOMAIN:-}" ]; then
  IP=$(curl -fsS https://api.ipify.org)
  DOMAIN="${IP//./-}.nip.io"
fi
# Caddy: add our site as its own file and import it. Never replace a Caddyfile that is not ours,
# because other sites (and certificates) may depend on it.
CADDY_DIR=${CADDY_DIR:-/etc/caddy}
install_caddy_site() {
  local main="$CADDY_DIR/Caddyfile" site="$CADDY_DIR/klyro.caddy" backup=""
  mkdir -p "$CADDY_DIR"
  cat > "$site" <<CADDY
$DOMAIN {
	encode zstd gzip
	reverse_proxy 127.0.0.1:$PORT {
		# Do not buffer responses: media and downloads must stream straight through.
		flush_interval -1
	}
}
CADDY
  # Back up the existing file, but only if this run is going to change it.
  if [ -s "$main" ] && ! grep -q 'klyro.caddy' "$main"; then
    backup="$main.bak.$(date +%Y%m%d%H%M%S)"
    cp "$main" "$backup"
  fi
  if [ ! -s "$main" ]; then
    printf '# Klyro (added by setup-vm.sh)\nimport %s\n' "$site" > "$main"
  elif grep -q 'klyro.caddy' "$main"; then
    :  # already imported: nothing to change
  elif grep -q 'root \* /usr/share/caddy' "$main" || { grep -q 'flush_interval -1' "$main" && ! grep -q '^import ' "$main"; }; then
    # The package's sample config, or the single-site file an earlier version of this script wrote.
    printf '# Klyro (added by setup-vm.sh)\nimport %s\n' "$site" > "$main"
  else
    # Someone's own config: keep all of it and add one line.
    printf '\n# Klyro (added by setup-vm.sh)\nimport %s\n' "$site" >> "$main"
  fi
  if command -v caddy >/dev/null && ! caddy validate --config "$main" --adapter caddyfile >/dev/null 2>&1; then
    echo "The Caddy configuration did not validate after adding Klyro's site." >&2
    caddy validate --config "$main" --adapter caddyfile 2>&1 | tail -5 >&2 || true
    if [ -n "$backup" ]; then cp "$backup" "$main"; echo "Your original Caddyfile has been restored." >&2; fi
    return 1
  fi
}
install_caddy_site

# Ubuntu images on some clouds ship firewall rules that block 80/443; allow them.
if command -v iptables >/dev/null && iptables -S INPUT 2>/dev/null | grep -q -- '-j REJECT'; then
  iptables -I INPUT 1 -p tcp --dport 80 -j ACCEPT
  iptables -I INPUT 1 -p tcp --dport 443 -j ACCEPT
  command -v netfilter-persistent >/dev/null && netfilter-persistent save || true
fi

systemctl daemon-reload
# Stop our own service first, then make sure nothing else is holding the port. An old copy of the
# proxy (or anything else) on the port makes the new service crash-loop while the old one keeps answering.
systemctl stop iridium-proxy 2>/dev/null || true
if command -v ss >/dev/null; then
  holder=$(ss -H -tlnp "sport = :$PORT" 2>/dev/null || true)
  if [ -n "$holder" ]; then
    echo "Port $PORT is already in use by something that is not this service:" >&2
    echo "$holder" >&2
    echo "Either stop that process, or run this again with another port, for example: sudo PORT=8090 bash setup-vm.sh" >&2
    exit 1
  fi
fi
systemctl enable iridium-proxy
# restart, not just start: on an update the old process must stop first or the port is still taken
systemctl restart iridium-proxy
# Reload, not restart: a restart would drop every open WebSocket on other sites served by Caddy.
systemctl reload caddy 2>/dev/null || systemctl restart caddy

# Do not say "Done" until the service really answers.
echo "Waiting for the service to answer..."
ready=""
for _ in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:$PORT/ready >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
if [ -z "$ready" ]; then
  echo "The service did not become ready within 30 seconds. Recent log:" >&2
  journalctl -u iridium-proxy -n 25 --no-pager >&2
  exit 1
fi
echo "Service is ready: $(curl -s http://127.0.0.1:$PORT/health)"

echo
echo "Done. Open https://$DOMAIN/ (the first HTTPS certificate can take a minute)."
echo "Health: https://$DOMAIN/healthz   Logs: journalctl -u iridium-proxy -f"
echo "Remember to open ports 80 and 443 in the cloud provider's own firewall / security list too."
