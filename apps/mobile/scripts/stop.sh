#!/usr/bin/env bash
# Stop any running mobile host (pattern kept inside this file so the calling
# shell command line never matches itself).
pkill -f "host/server.js" 2>/dev/null || true
exit 0
