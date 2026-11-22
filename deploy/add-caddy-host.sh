#!/usr/bin/env bash
# Adds one more host name to an existing Caddy site block, so the same service answers on both names.
# The default is this VM's Bromine Wisp site: it keeps answering on its sslip.io name and also answers
# on bromine.<ip>.nip.io (nip.io resolves any prefix in front of the address).
#
# Run as root:  curl -fsSL <this file> | ssh <vm> sudo bash
# Safe to run twice. The Caddy file is backed up and put back if the new configuration does not validate.
# Every command reads from /dev/null so nothing can consume this script from stdin.
set -euo pipefail

FILE=${CADDY_FILE:-/etc/caddy/bromine.caddy}
MAIN=${CADDY_MAIN:-/etc/caddy/Caddyfile}
EXISTING=${EXISTING_HOST:-152-67-109-165.sslip.io}
NEW=${NEW_HOST:-bromine.152-67-109-165.nip.io}
ORIGIN=${CHECK_ORIGIN:-https://scramjet-ubg.vercel.app}
CHECK_PATH=${CHECK_PATH:-/wisp/}
SKIP_RELOAD=${SKIP_RELOAD:-}   # tests set this to skip systemctl and the live check
STAMP=$(date +%Y%m%d%H%M%S)

say() { printf '%s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

# only plain host names, so nothing odd can end up inside the Caddy file
host_ok() { [[ "$1" =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ ]]; }
host_ok "$EXISTING" && host_ok "$NEW" || die "host names may only contain letters, digits, dots and hyphens"
[ -f "$FILE" ] || die "$FILE not found"

# the site line that serves $EXISTING (alone or with other names), as the first token of a block opener
line=$(grep -nE "^[[:space:]]*([^#{[:space:]]+,[[:space:]]*)*${EXISTING//./\\.}([[:space:]]*,[[:space:]]*[^#{[:space:]]+)*[[:space:]]*\{[[:space:]]*$" "$FILE" </dev/null | head -1 || true)
[ -n "$line" ] || die "no site block for $EXISTING in $FILE, so nothing was changed"
lineno=${line%%:*}
text=${line#*:}

if printf '%s' "$text" | grep -qF "$NEW"; then
  say "$NEW is already part of that site block; nothing to change."
else
  cp -p "$FILE" "$FILE.bak.$STAMP"
  new_text=$(printf '%s' "$text" | sed -E "s/[[:space:]]*\{[[:space:]]*$/, ${NEW} {/")
  awk -v n="$lineno" -v t="$new_text" 'NR==n {print t; next} {print}' "$FILE" > "$FILE.new"
  chown --reference="$FILE" "$FILE.new" </dev/null
  chmod --reference="$FILE" "$FILE.new" </dev/null
  mv "$FILE.new" "$FILE"
  say "Changed: $text"
  say "     to: $new_text   (backup: $FILE.bak.$STAMP)"

  if command -v caddy >/dev/null && ! caddy validate --config "$MAIN" --adapter caddyfile </dev/null >/dev/null 2>&1; then
    caddy validate --config "$MAIN" --adapter caddyfile </dev/null 2>&1 | tail -4 >&2 || true
    cp -p "$FILE.bak.$STAMP" "$FILE"
    die "Caddy did not accept the new configuration; the original file was put back"
  fi
fi

[ -n "$SKIP_RELOAD" ] && { say "Done (file only)."; exit 0; }

# Reload, not restart: a restart would drop every open WebSocket on the sites Caddy serves.
systemctl reload caddy </dev/null || systemctl restart caddy </dev/null
sleep 2
systemctl is-active --quiet caddy </dev/null || die "Caddy is not running after the reload (backup: $FILE.bak.$STAMP)"

# The first certificate for a new name takes a few seconds. Keep checking for up to a minute.
say "Waiting for the certificate for $NEW (up to 60 seconds)..."
code=""
for _ in $(seq 1 20); do
  code=$(curl --http1.1 -s -m 5 -o /dev/null -w '%{http_code}' \
    -H "Origin: $ORIGIN" -H 'Upgrade: websocket' -H 'Connection: Upgrade' \
    -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
    "https://$NEW$CHECK_PATH" </dev/null 2>/dev/null || true)
  [ "$code" = "101" ] && break
  sleep 3
done
old=$(curl --http1.1 -s -m 5 -o /dev/null -w '%{http_code}' \
  -H "Origin: $ORIGIN" -H 'Upgrade: websocket' -H 'Connection: Upgrade' \
  -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
  "https://$EXISTING$CHECK_PATH" </dev/null 2>/dev/null || true)

say
say "RESULT $EXISTING (want 101): ${old:-none}"
say "RESULT $NEW (want 101): ${code:-none}"
if [ "$code" != "101" ]; then
  say
  say "The new name did not answer yet. The old name is unaffected. Recent Caddy messages about it:"
  journalctl -u caddy --no-pager -n 400 </dev/null 2>/dev/null | grep -F "$NEW" | tail -5 | cut -c1-260 || true
fi
