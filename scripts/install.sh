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
NATIVE_AUDIO_HELPER_SRC="$ROOT_DIR/scripts/native-system-audio-helper.swift"
NATIVE_AUDIO_HELPER_BIN="$BIN_DIR/native-system-audio-helper"
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

progress "1/11" "Preparing project directories"
mkdir -p "$BIN_DIR" "$ROOT_DIR/data" "$ROOT_DIR/sessions" "$MODELS_DIR"

if [ ! -d node_modules ]; then
  progress "2/11" "Installing npm dependencies"
  npm install
else
  progress "2/11" "npm dependencies already installed"
fi

if [ ! -f .env ]; then
  progress "3/11" "Creating .env from .env.example"
  cp .env.example .env
else
  progress "3/11" ".env already exists"
fi

if ! command -v brew >/dev/null 2>&1; then
  echo "Homebrew is required for installer-managed whisper setup."
  echo "Install Homebrew first, then rerun: https://brew.sh/"
  exit 1
fi

progress "4/11" "Installing or locating whisper-cpp via Homebrew"
if ! brew list whisper-cpp >/dev/null 2>&1; then
  brew install whisper-cpp
else
  echo "whisper-cpp already installed"
fi

progress "5/11" "Installing or locating BlackHole 2ch via Homebrew"
if ! brew list blackhole-2ch >/dev/null 2>&1; then
  brew install blackhole-2ch
else
  echo "blackhole-2ch already installed"
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

progress "6/11" "Downloading Whisper model ${MODEL_NAME}"
if [ -f "$MODEL_PATH" ]; then
  echo "Model already exists at $MODEL_PATH"
else
  curl -fL "$MODEL_URL" -o "$MODEL_PATH"
fi

progress "7/11" "Updating .env for Whisper provider"
set_env "PUBLIC_DIR" "./dist/ui"
set_env "STT_PROVIDER" "whisper"
set_env "STT_EXECUTABLE" "$WHISPER_EXECUTABLE"
set_env "WHISPER_MODEL" "$MODEL_PATH"
set_env "MIC_PROBE_HELPER" "$PROBE_BIN"
set_env "SDL_AUDIO_DEVICES_HELPER" "$SDL_HELPER_BIN"
set_env "NATIVE_SYSTEM_AUDIO_HELPER" "$NATIVE_AUDIO_HELPER_BIN"
set_env "ENABLE_NATIVE_SYSTEM_AUDIO_CAPTURE" "false"

progress "8/11" "Building local audio helper binaries"
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

progress "9/11" "Building native system-audio helper"
if command -v swiftc >/dev/null 2>&1; then
  swiftc -parse-as-library "$NATIVE_AUDIO_HELPER_SRC" -framework ScreenCaptureKit -framework AVFoundation -framework CoreMedia -framework CoreGraphics -o "$NATIVE_AUDIO_HELPER_BIN"
else
  echo "swiftc not found; skipping native system-audio helper build."
fi

progress "10/11" "Requesting microphone permission"
if [ -x "$HELPER_BIN" ]; then
  "$HELPER_BIN" request || true
fi

progress "11/11" "Detecting Desktop Audio and applying recommended source"
DOCTOR_JSON="$(mktemp)"
./node_modules/.bin/tsx src/server/tools/audioDoctor.ts --json --apply-config --probe-seconds 2 > "$DOCTOR_JSON" || true
node --input-type=module - "$DOCTOR_JSON" <<'EOF'
import fs from "node:fs";

const resultPath = process.argv[2];
const result = JSON.parse(fs.readFileSync(resultPath, "utf8"));

if (result.recommendedSource) {
  console.log(`Recommended Desktop Audio source: ${result.recommendedSource.name}`);
} else {
  console.log("Recommended Desktop Audio source: not detected");
}

if (result.appliedConfig) {
  console.log("Updated config.json to select the recommended Desktop Audio source.");
}

const failures = result.checks.filter((check) => check.status === "fail");
const warnings = result.checks.filter((check) => check.status === "warn");
for (const check of [...failures, ...warnings]) {
  console.log(`${check.status.toUpperCase()}: ${check.message}`);
}

if (!result.recommendedSource || result.signal?.status !== "signal-present") {
  console.log("");
  console.log("Desktop audio routing checklist:");
  console.log("1. Open Audio MIDI Setup and create a Multi-Output Device.");
  console.log("2. Add your speakers/headphones and BlackHole 2ch to that Multi-Output Device.");
  console.log("3. Set the Multi-Output Device as the macOS output device.");
  console.log("4. Rerun `npm run doctor:audio` while playing audio to confirm signal is present.");
}
EOF
rm -f "$DOCTOR_JSON"

cat <<EOF
Install complete.

Next steps:
1. Whisper provider is enabled in .env.
2. Installed model: ${MODEL_NAME}
3. Confirm Codex CLI is installed and logged in if you plan to use ANALYSIS_PROVIDER=codex.
4. Run npm run doctor:audio if you want to re-check Desktop Audio routing.
5. Run npm run dev.

Tip:
- Use a different model with: bash scripts/install.sh medium.en
EOF
