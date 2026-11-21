#!/usr/bin/env bash
# One-step VM update plus health checks. Run as root with PORT and CAP set:
#   curl -fsSL <this file> | ssh <vm> sudo PORT=8090 CAP=5TB bash
# Every command reads from /dev/null so nothing can consume this script from stdin.
BASE=https://raw.githubusercontent.com/Iridium-Group/iridium-proxy/main/deploy
curl -fsSL -o /tmp/klyro-setup.sh "$BASE/setup-vm.sh" </dev/null || { echo "download failed"; exit 1; }
bash /tmp/klyro-setup.sh </dev/null
echo
echo "RESULT service: $(systemctl is-active iridium-proxy </dev/null)"
code() { curl -s -m 8 -o /dev/null -w '%{http_code}' "$@" </dev/null; }
echo "RESULT bromine route (want 101): $(code --http1.1 -H 'Upgrade: websocket' -H 'Connection: Upgrade' -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' https://152-67-109-165.sslip.io/wisp/)"
echo "RESULT klyro page (want 200): $(code https://152-67-109-165.nip.io/)"
