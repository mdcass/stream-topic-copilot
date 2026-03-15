#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

if [ ! -d node_modules ]; then
  echo "Dependencies are not installed. Run npm install first."
  exit 1
fi

if [ ! -d dist ]; then
  npm run build
fi

npm run start
