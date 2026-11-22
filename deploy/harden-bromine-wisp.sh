#!/usr/bin/env bash
# Hardens the Bromine Wisp server (Ultraviolet-ubg/wisp/node) against two problems seen on the VM:
#
#   1. One client that sends a malformed WebSocket frame (for example one that is not masked) makes the
#      ws library emit an 'error' that nothing handles, and that ends the whole process. Every other
#      client is dropped and systemd restarts it (the VM had restarted it more than a thousand times).
#      The patch logs errors that carry a ws code (WS_ERR_*) and keeps serving; anything else still
#      stops the process, so real bugs are not hidden.
#   2. The server listens on every network interface. Caddy only needs 127.0.0.1, so a new WISP_HOST
#      setting (default 0.0.0.0, so other hosts such as Render behave as before) is set to 127.0.0.1
#      in the systemd unit.
#
# Run as root:  curl -fsSL <this file> | ssh <vm> sudo bash
# Safe to run twice. Backups are written next to the files, and if the service does not come back
# healthy everything is put back as it was. Every command reads from /dev/null so nothing can consume
# this script from stdin.
set -euo pipefail

DIR=${WISP_DIR:-/home/ubuntu/Ultraviolet-ubg/wisp/node}
UNIT=${WISP_UNIT:-/etc/systemd/system/bromine-wisp.service}
SERVICE=${WISP_SERVICE:-bromine-wisp}
SKIP_SERVICE=${SKIP_SERVICE:-}   # tests set this to skip systemd
STAMP=$(date +%Y%m%d%H%M%S)

say() { printf '%s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

[ -f "$DIR/server.js" ] && [ -f "$DIR/config.js" ] || die "server.js and config.js not found in $DIR"
command -v node >/dev/null || die "node is not installed"

# ---- 1. edit server.js and config.js (all edits or none) ----
PATCHER=$(mktemp --suffix=.mjs)
cat > "$PATCHER" <<'JS'
import fs from "node:fs";
const dir = process.argv[2];

const guard = `
// A client that sends a malformed WebSocket frame (for example one that is not masked) makes the ws
// library emit an 'error' that nothing here handles, which would end the whole process and drop every
// other client's connection. Those errors carry a WS_ERR_* code: log them and keep serving. Anything
// else is a real bug, so it still stops the process.
process.on("uncaughtException", (error) => {
  if (typeof error?.code === "string" && error.code.startsWith("WS_ERR_")) {
    console.warn(\`[wisp] dropped a client that sent a bad WebSocket frame (\${error.code})\`);
    return;
  }
  console.error(error);
  process.exit(1);
});
`;

const hostFn = `// WISP_HOST: the address to listen on. 127.0.0.1 when only a local reverse proxy should reach it.
function host(env) {
  const raw = (env.WISP_HOST || "0.0.0.0").trim();
  if (!/^[\\w.:-]+$/.test(raw)) throw new Error(\`WISP_HOST must be an address like 127.0.0.1 or 0.0.0.0 (got "\${raw}").\`);
  return raw;
}

`;

const edits = {
  "server.js": [
    ["const perIp = new Map();\n", "const perIp = new Map();\n" + guard],
    [
      'server.on("upgrade", (req, socket, head) => {\n',
      'server.on("upgrade", (req, socket, head) => {\n  // A reset or timeout on this socket must close it, not escape as an unhandled error.\n  socket.on("error", () => socket.destroy());\n',
    ],
    [
      'server.listen(config.port, "0.0.0.0", () => {\n  console.log(`[wisp] Listening on 0.0.0.0:${config.port}, Wisp path ${config.path}`);',
      "server.listen(config.port, config.host, () => {\n  console.log(`[wisp] Listening on ${config.host}:${config.port}, Wisp path ${config.path}`);",
    ],
  ],
  "config.js": [
    ["export function loadConfig(env = process.env) {\n", hostFn + "export function loadConfig(env = process.env) {\n"],
    ['  return {\n    port: int(env, "PORT", 10000, 1, 65535),\n', '  return {\n    host: host(env),\n    port: int(env, "PORT", 10000, 1, 65535),\n'],
  ],
};

const out = {};
for (const [file, list] of Object.entries(edits)) {
  let text = fs.readFileSync(`${dir}/${file}`, "utf8");
  for (const [from, to] of list) {
    const parts = text.split(from);
    if (parts.length !== 2) {
      console.error(`The expected text was not found exactly once in ${file}:\n${from}`);
      process.exit(3);
    }
    text = parts.join(to);
  }
  out[file] = text;
}
for (const [file, text] of Object.entries(out)) fs.writeFileSync(`${dir}/${file}.new`, text);
JS

if grep -q 'WS_ERR_' "$DIR/server.js" && grep -q 'WISP_HOST' "$DIR/config.js"; then
  say "server.js and config.js already have the fix; leaving them as they are."
  files_changed=""
else
  node "$PATCHER" "$DIR" </dev/null || { rm -f "$DIR"/server.js.new "$DIR"/config.js.new "$PATCHER"; die "the files are not what this script expects, so nothing was changed"; }
  # check the syntax of the edited copies before they replace anything (they are ES modules)
  for f in server.js config.js; do
    cp "$DIR/$f.new" "$DIR/.check-$f.mjs"
    node --check "$DIR/.check-$f.mjs" </dev/null || { rm -f "$DIR"/.check-*.mjs "$DIR"/*.new "$PATCHER"; die "the edited $f does not parse, so nothing was changed"; }
    rm -f "$DIR/.check-$f.mjs"
  done
  for f in server.js config.js; do
    cp -p "$DIR/$f" "$DIR/$f.bak.$STAMP"
    # the edited copy was written by root: give it the owner and mode of the file it replaces
    chown --reference="$DIR/$f.bak.$STAMP" "$DIR/$f.new" </dev/null
    chmod --reference="$DIR/$f.bak.$STAMP" "$DIR/$f.new" </dev/null
    mv "$DIR/$f.new" "$DIR/$f"
  done
  files_changed=1
  say "Edited server.js and config.js (backups: *.bak.$STAMP)."
fi
rm -f "$PATCHER"

[ -n "$SKIP_SERVICE" ] && { say "Done (files only)."; exit 0; }

# ---- 2. listen on 127.0.0.1 only, in the systemd unit ----
[ -f "$UNIT" ] || die "$UNIT not found"
unit_changed=""
if ! grep -q '^Environment=WISP_HOST=' "$UNIT"; then
  cp -p "$UNIT" "$UNIT.bak.$STAMP"
  if grep -q '^Environment=PORT=' "$UNIT"; then
    sed -i '0,/^Environment=PORT=.*/s//&\nEnvironment=WISP_HOST=127.0.0.1/' "$UNIT"
  else
    sed -i '0,/^\[Service\]/s//[Service]\nEnvironment=WISP_HOST=127.0.0.1/' "$UNIT"
  fi
  unit_changed=1
  say "Set WISP_HOST=127.0.0.1 in $UNIT (backup: $UNIT.bak.$STAMP)."
fi

rollback() {
  say "Putting everything back as it was..." >&2
  if [ -n "$files_changed" ]; then
    for f in server.js config.js; do cp -p "$DIR/$f.bak.$STAMP" "$DIR/$f"; done
  fi
  if [ -n "$unit_changed" ]; then cp -p "$UNIT.bak.$STAMP" "$UNIT"; fi
  systemctl daemon-reload </dev/null
  systemctl restart "$SERVICE" </dev/null || true
}

# ---- 3. restart and check ----
if [ -z "$files_changed$unit_changed" ]; then
  say "Nothing to change; the service is already hardened."
else
  systemctl daemon-reload </dev/null
  systemctl restart "$SERVICE" </dev/null
fi

port=$(systemctl show "$SERVICE" -p Environment </dev/null | grep -oE '(^|[= ])PORT=[0-9]+' | head -1 | grep -oE '[0-9]+$' || true)
port=${port:-8080}
ok=""
for _ in $(seq 1 20); do
  if [ "$(curl -s -m 2 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/healthz" </dev/null)" = "200" ]; then ok=1; break; fi
  sleep 1
done
if [ -z "$ok" ]; then
  journalctl -u "$SERVICE" -n 15 --no-pager </dev/null >&2 || true
  [ -n "$files_changed$unit_changed" ] && rollback
  die "the service did not answer on port $port; the previous version was put back"
fi
say "The service answers on 127.0.0.1:$port."

listen=$(ss -H -ltn "sport = :$port" </dev/null 2>/dev/null | awk '{print $4}' | head -1 || true)
say "Listening on: ${listen:-unknown}"

# ---- 4. prove it survives a malformed frame ----
origin=$(systemctl show "$SERVICE" -p Environment </dev/null | grep -o 'WISP_ALLOWED_ORIGINS=[^ ]*' | head -1 | cut -d= -f2 | cut -d, -f1 || true)
pid_before=$(systemctl show "$SERVICE" -p MainPID --value </dev/null)
PROBE=$(mktemp --suffix=.mjs)
cat > "$PROBE" <<'JS'
import net from "node:net";
const [, , port, origin] = process.argv;
const s = net.connect(Number(port), "127.0.0.1");
let got = "";
s.on("data", (d) => (got += d));
s.on("error", () => {});
s.write(`GET /wisp/ HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n${origin ? `Origin: ${origin}\r\n` : ""}\r\n`);
setTimeout(() => {
  console.log(got.split("\r\n")[0] || "no answer");
  if (got.startsWith("HTTP/1.1 101")) s.write(Buffer.from([0x82, 0x05, 0x68, 0x65, 0x6c, 0x6c, 0x6f])); // a frame with no mask
  setTimeout(() => process.exit(0), 800);
}, 600);
JS
probe=$(node "$PROBE" "$port" "$origin" </dev/null || true)
rm -f "$PROBE"
sleep 1
pid_after=$(systemctl show "$SERVICE" -p MainPID --value </dev/null)
if [ "$probe" = "HTTP/1.1 101 Switching Protocols" ]; then
  if [ "$pid_before" = "$pid_after" ] && systemctl is-active --quiet "$SERVICE" </dev/null; then
    say "Sent a deliberately malformed frame: the service kept running (process $pid_after unchanged)."
  else
    [ -n "$files_changed$unit_changed" ] && rollback
    die "the service died after a malformed frame, so the previous version was put back"
  fi
else
  say "Could not run the malformed-frame check (the test connection got: ${probe:-nothing}); the service itself is healthy."
fi

say
say "RESULT service: $(systemctl is-active "$SERVICE" </dev/null)"
say "RESULT restarts so far: $(systemctl show "$SERVICE" -p NRestarts --value </dev/null)"
say "RESULT listening on: ${listen:-unknown}"
