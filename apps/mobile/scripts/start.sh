#!/usr/bin/env bash
# Launch the mobile host. Honors ORISON_MOBILE_* env vars (data dir, port).
set -e
cd "$(dirname "$0")/.."
exec node dist/host/server.js
