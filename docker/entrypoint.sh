#!/bin/sh
set -e
# Xine ships its own client; no proprietary client download is needed.
if [ "$1" = "bun" ] && [ "$2" = "src/server.ts" ]; then
 bun scripts/xine-configure.ts
fi
exec "$@"
