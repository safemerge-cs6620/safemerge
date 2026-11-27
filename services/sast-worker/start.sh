#!/bin/sh
set -e
cd /app/scanner
PORT=3000 node --require /app/disable-file-routes.cjs server.js &
cd /app
exec node src/server.js
