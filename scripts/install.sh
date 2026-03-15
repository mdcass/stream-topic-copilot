#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BIN_DIR="$ROOT_DIR/.bin"
MODELS_DIR="$ROOT_DIR/.models/whisper.cpp"
HELPER_SRC="$ROOT_DIR/scripts/request-microphone-permission.swift"
HELPER_BIN="$BIN_DIR/request-microphone-permission"
PROBE_SRC="$ROOT_DIR/scripts/mic-level-probe.swift"
PROBE_BIN="$BIN_DIR/mic-level-probe"
SDL_HELPER_SRC="$ROOT_DIR/scripts/sdl-audio-devices.c"
SDL_HELPER_BIN="$BIN_DIR/sdl-audio-devices"
ENV_FILE="$ROOT_DIR/.env"
MODEL_NAME="${1:-${WHISPER_MODEL_NAME:-small.en}}"
MODEL_FILE="ggml-${MODEL_NAME}.bin"
MODEL_URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${MODEL_FILE}"
MODEL_PATH="$MODELS_DIR/$MODEL_FILE"

cd "$ROOT_DIR"

progress() {
  local step="$1"
  local message="$2"
  printf '[%s] %s\n' "$step" "$message"
}

set_env() {
  local key="$1"
  local value="$2"

  if grep -q "^${key}=" "$ENV_FILE"; then
    awk -v key="$key" -v value="$value" '
      BEGIN { replaced = 0 }
      index($0, key "=") == 1 {
        print key "=" value
        replaced = 1
        next
      }
      { print }
      END {
        if (!replaced) {
          print key "=" value
        }
      }
    ' "$ENV_FILE" > "$ENV_FILE.tmp"
    mv "$ENV_FILE.tmp" "$ENV_FILE"
    return
  fi

  printf "%s=%s\n" "$key" "$value" >> "$ENV_FILE"
}

progress "1/8" "Preparing project directories"
mkdir -p "$BIN_DIR" "$ROOT_DIR/data" "$ROOT_DIR/sessions" "$MODELS_DIR"

if [ ! -d node_modules ]; then
  progress "2/8" "Installing npm dependencies"
  npm install
else
  progress "2/8" "npm dependencies already installed"
fi

if [ ! -f .env ]; then
  progress "3/8" "Creating .env from .env.example"
  cp .env.example .env
else
  progress "3/8" ".env already exists"
fi

if ! command -v brew >/dev/null 2>&1; then
  echo "Homebrew is required for installer-managed whisper setup."
  echo "Install Homebrew first, then rerun: https://brew.sh/"
  exit 1
fi

progress "4/8" "Installing or locating whisper-cpp via Homebrew"
if ! brew list whisper-cpp >/dev/null 2>&1; then
  brew install whisper-cpp
else
  echo "whisper-cpp already installed"
fi

WHISPER_PREFIX="$(brew --prefix whisper-cpp 2>/dev/null || true)"
WHISPER_EXECUTABLE=""
if [ -n "$WHISPER_PREFIX" ]; then
  for candidate in \
    "$WHISPER_PREFIX/bin/whisper-stream" \
    "$WHISPER_PREFIX/bin/whisper-stream.cpp" \
    "$WHISPER_PREFIX/bin/stream" \
    "$WHISPER_PREFIX/bin/whisper-cli"
  do
    if [ -x "$candidate" ]; then
      WHISPER_EXECUTABLE="$candidate"
      break
    fi
  done
fi

if [ -z "$WHISPER_EXECUTABLE" ]; then
  echo "Unable to locate a usable whisper executable under the Homebrew whisper-cpp prefix."
  exit 1
fi

progress "5/8" "Downloading Whisper model ${MODEL_NAME}"
if [ -f "$MODEL_PATH" ]; then
  echo "Model already exists at $MODEL_PATH"
else
  curl -fL "$MODEL_URL" -o "$MODEL_PATH"
fi

progress "6/8" "Updating .env for Whisper provider"
set_env "STT_PROVIDER" "whisper"
set_env "STT_EXECUTABLE" "$WHISPER_EXECUTABLE"
set_env "WHISPER_MODEL" "$MODEL_PATH"
set_env "MIC_PROBE_HELPER" "$PROBE_BIN"

progress "7/8" "Building local microphone helper binaries"
if command -v sdl2-config >/dev/null 2>&1; then
  cc "$SDL_HELPER_SRC" -o "$SDL_HELPER_BIN" $(sdl2-config --cflags --libs)
else
  echo "sdl2-config not found; unable to build the SDL audio device helper."
  exit 1
fi

if command -v swiftc >/dev/null 2>&1; then
  swiftc -parse-as-library "$PROBE_SRC" -framework AVFoundation -framework CoreMedia -framework AudioToolbox -o "$PROBE_BIN"
  swiftc -parse-as-library "$HELPER_SRC" -framework AVFoundation -o "$HELPER_BIN"
else
  echo "swiftc not found; skipping microphone helper build."
fi

progress "8/8" "Requesting microphone permission"
if [ -x "$HELPER_BIN" ]; then
  "$HELPER_BIN" request || true
fi

cat <<EOF
Install complete.

Next steps:
1. Whisper provider is enabled in .env.
2. Installed model: ${MODEL_NAME}
3. Confirm Codex CLI is installed and logged in if you plan to use ANALYSIS_PROVIDER=codex.
4. Run npm run dev.

Tip:
- Use a different model with: bash scripts/install.sh medium.en
EOF
