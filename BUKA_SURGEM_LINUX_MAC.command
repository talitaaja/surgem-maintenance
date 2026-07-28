#!/bin/sh
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js belum terpasang. Pasang Node.js versi 18 atau lebih baru, lalu buka file ini kembali."
  exit 1
fi

if curl -fsSI --max-time 2 http://127.0.0.1:31726/admin.html 2>/dev/null | grep -qi '^X-SurGem-Server: SurGem-Admin-v4'; then
  if command -v open >/dev/null 2>&1; then open http://127.0.0.1:31726/admin.html; else xdg-open http://127.0.0.1:31726/admin.html >/dev/null 2>&1 & fi
  exit 0
fi

PORT=31726 SURGEM_AUTO_OPEN=1 node server.js
