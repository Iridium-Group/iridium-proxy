#!/usr/bin/env bash
# Run Iridium on your own computer and give it a public https:// link with a free Cloudflare quick
# tunnel (no account needed). From the repo root:
#
#   ./deploy/home/run.sh
#
# Needs: Node 22.18+, git, and cloudflared (https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/).
# Leave it running; closing it takes the site offline. The link changes every time you start it.
set -euo pipefail
cd "$(dirname "$0")/../.."

need() { command -v "$1" >/dev/null || { echo "Missing '$1'. $2" >&2; exit 1; }; }
need node "Install Node 22.18 or newer from https://nodejs.org"
need npm "Comes with Node."
node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=18)?0:1)' \
  || { echo "Node 22.18 or newer is required (you have $(node -v))." >&2; exit 1; }

PORT=${PORT:-8080}
# Monthly bandwidth cap. Set it to whatever your home plan can comfortably give away.
export IRIDIUM_MONTHLY_CAP=${IRIDIUM_MONTHLY_CAP:-50GB}
export IRIDIUM_USAGE_FILE=${IRIDIUM_USAGE_FILE:-"$PWD/.iridium-usage.json"}
export IRIDIUM_SERVER__HOST=127.0.0.1
export IRIDIUM_SECURITY__BLOCK_PRIVATE_ADDRESSES=true
export PORT

[ -d node_modules ] || npm ci
[ -d web/public/scram ] || npm run build:web
npm run build --silent

node bin/iridium-proxy.js &
PROXY_PID=$!
trap 'kill $PROXY_PID 2>/dev/null || true; [ -n "${TUNNEL_PID:-}" ] && kill $TUNNEL_PID 2>/dev/null || true' EXIT INT TERM

for _ in $(seq 1 30); do
  curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 && break
  sleep 0.5
done
curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null || { echo "The proxy did not start." >&2; exit 1; }
echo "Local: http://127.0.0.1:$PORT/"

if command -v cloudflared >/dev/null; then
  echo "Starting the tunnel. Your public link will appear below (https://....trycloudflare.com)."
  cloudflared tunnel --no-autoupdate --url "http://127.0.0.1:$PORT" &
  TUNNEL_PID=$!
else
  echo "cloudflared is not installed, so there is no public link yet (local only)."
  echo "Install it from the link at the top of this script, then run this again."
fi
wait $PROXY_PID
