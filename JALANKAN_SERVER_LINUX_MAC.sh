#!/usr/bin/env sh
cd "$(dirname "$0")" || exit 1
echo "Menjalankan SurGem Maintenance pada http://localhost:3000"
exec node server.js
