#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BIN_DIR="$ROOT_DIR/.bin"
HELPER_SRC="$ROOT_DIR/scripts/request-microphone-permission.swift"
HELPER_BIN="$BIN_DIR/request-microphone-permission"

cd "$ROOT_DIR"

mkdir -p "$BIN_DIR" "$ROOT_DIR/data" "$ROOT_DIR/sessions"

if [ ! -d node_modules ]; then
  npm install
fi

if [ ! -f .env ]; then
  cp .env.example .env
fi

if command -v swiftc >/dev/null 2>&1; then
  swiftc "$HELPER_SRC" -framework AVFoundation -o "$HELPER_BIN"
  "$HELPER_BIN" request || true
else
  echo "swiftc not found; skipping microphone permission helper build."
fi

cat <<'EOF'
Install complete.

Next steps:
1. Install or build whisper.cpp for Apple Silicon and set STT_EXECUTABLE in .env.
2. Confirm WHISPER_MODEL points to an installed model. Recommended starter: small.en.
3. Confirm Codex CLI is installed and logged in if you plan to use ANALYSIS_PROVIDER=codex.
4. Run npm run dev.
EOF
