#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# Codespaces terminates HTTPS at its forwarded port. Tell Xitter the browser's
# actual origin so session cookies are Secure and generated links are correct.
if [[ -n "${CODESPACE_NAME:-}" && -n "${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:-}" ]]; then
  export PUBLIC_ORIGIN="https://${CODESPACE_NAME}-3000.${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN}"
fi
if ! curl --fail --silent http://127.0.0.1:3000/healthz >/dev/null; then
  nohup bun src/server.ts >/tmp/xine-codespaces.log 2>&1 &
fi
for ((attempt=0; attempt<30; attempt++)); do
  if curl --fail --silent http://127.0.0.1:3000/healthz >/dev/null; then
    echo 'Xine is ready. Open forwarded port 3000 and choose Create an account.'
    exit 0
  fi
  sleep 1
done
echo 'Xine did not become ready. See /tmp/xine-codespaces.log.' >&2
exit 1
