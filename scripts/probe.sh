#!/bin/sh
# Restarts the server, signs in through the login form in headless Edge, loads a
# page and reports what the client did.
# usage: sh scripts/probe.sh [path] [out dir]
# PROBE_USER / PROBE_PASS pick the account (a local test account by default).
cd "$(dirname "$0")/.." || exit 1
PAGE="${1:-/home}"
OUT="${2:-.probe}"
PORT="${PORT:-3000}"
ORIGIN="http://localhost:$PORT"
mkdir -p "$OUT"

EDGE="/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
[ -f "$EDGE" ] || EDGE="/c/Program Files/Microsoft/Edge/Application/msedge.exe"

edge() {
	"$EDGE" --headless=new --disable-gpu --no-first-run \
		--user-data-dir="$(cygpath -w "$(pwd)/$OUT/profile")" \
		--window-size=1280,1600 --enable-logging=stderr --v=0 "$@"
}

# stop whatever holds the port
for pid in $(netstat -ano | grep "LISTENING" | grep ":$PORT " | awk '{print $NF}' | sort -u); do
	taskkill //F //PID "$pid" >/dev/null 2>&1
done
bun src/server.ts > server.log 2>&1 &
for i in 1 2 3 4 5 6 7 8 9 10; do
	curl -s -o /dev/null "$ORIGIN/login" && break
	ping -n 2 127.0.0.1 >/dev/null
done

# sign in: a local page that submits the real login form
rm -rf "$OUT/profile"
cat > "$OUT/login.html" <<EOF
<form method="post" action="$ORIGIN/login">
<input name="username" value="${PROBE_USER:-pozo}"><input name="password" value="${PROBE_PASS:-testpass123}">
</form><script>document.forms[0].submit()</script>
EOF
edge --virtual-time-budget=8000 --dump-dom "file:///$(cygpath -m "$(pwd)/$OUT/login.html")" > /dev/null 2>&1

: > server.log.offset
OFFSET=$(wc -l < server.log)
edge --virtual-time-budget="${BUDGET:-25000}" \
	--screenshot="$(cygpath -w "$(pwd)/$OUT/shot.png")" \
	--dump-dom "$ORIGIN$PAGE" > "$OUT/dom.html" 2> "$OUT/edge.err"
rm -f server.log.offset

echo "--- server log"
tail -n +$((OFFSET + 1)) server.log | sort | uniq -c | sort -rn | head -40
echo "--- dom"
printf 'title: '; grep -oE '<title>[^<]*' "$OUT/dom.html" | head -1
printf 'posts rendered: '; grep -o 'data-testid="tweet"' "$OUT/dom.html" | wc -l
grep -oE 'Something went wrong[^<]{0,40}' "$OUT/dom.html" | sort | uniq -c
echo "--- console"
grep -E 'CONSOLE' "$OUT/edge.err" | grep -vE 'Tracking Prevention|chrome-extension|Manifest fetch|No available adapters' \
	| sed -E 's/^\[[^]]*\] //' | cut -c1-230 | sort | uniq -c | sort -rn | head -25
