#!/usr/bin/env bash
# Install Iridium proxy on a fresh Ubuntu VM (x86 or ARM), e.g. an Oracle Cloud Always Free instance.
#
#   curl -fsSL https://raw.githubusercontent.com/Iridium-Group/iridium-proxy/main/deploy/setup-vm.sh | sudo bash
#
# Optional settings, passed as environment variables:
#   DOMAIN=proxy.example.com   Host name for HTTPS. Default: <public-ip>.nip.io (works with no domain).
#   CAP=5TB                    Monthly bandwidth cap. Check your provider's free allowance first.
#   MAX_SESSIONS, CACHE_SIZE, MAX_CONNECTIONS   Klyro limits (defaults suit a 1 GB machine).
#   BRANCH=main                Git branch to install.
set -euo pipefail

[ "$(id -u)" -eq 0 ] || { echo "Run as root (use sudo)." >&2; exit 1; }

REPO=https://github.com/Iridium-Group/iridium-proxy
BRANCH=${BRANCH:-main}
CAP=${CAP:-5TB}
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
Environment=PORT=8080
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
cat > /etc/caddy/Caddyfile <<CADDY
$DOMAIN {
	encode zstd gzip
	reverse_proxy 127.0.0.1:8080 {
		# Do not buffer responses: media and downloads must stream straight through.
		flush_interval -1
	}
}
CADDY

# Ubuntu images on some clouds ship firewall rules that block 80/443; allow them.
if command -v iptables >/dev/null && iptables -S INPUT 2>/dev/null | grep -q -- '-j REJECT'; then
  iptables -I INPUT 1 -p tcp --dport 80 -j ACCEPT
  iptables -I INPUT 1 -p tcp --dport 443 -j ACCEPT
  command -v netfilter-persistent >/dev/null && netfilter-persistent save || true
fi

systemctl daemon-reload
systemctl enable iridium-proxy
# restart, not just start: on an update the old process must stop first or the port is still taken
systemctl restart iridium-proxy
systemctl restart caddy

echo
echo "Done. Open https://$DOMAIN/ (the first HTTPS certificate can take a minute)."
echo "Health: https://$DOMAIN/healthz   Logs: journalctl -u iridium-proxy -f"
echo "Remember to open ports 80 and 443 in the cloud provider's own firewall / security list too."
