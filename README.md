# Stream Topic Copilot

Local TypeScript utility for running a narrow browser-side stream control surface next to OBS. It reads a markdown topic plan, captures transcript events from a pluggable STT provider, analyzes semantically complete chunks through a pluggable analysis provider, and writes session artifacts plus a proposed final markdown update.

The project is runnable without external services by using the default mock providers. The test suite also uses mocked providers, so `npm test` does not require Whisper or Codex.

## Project Setup

### Prerequisites

- macOS on Apple Silicon
- Homebrew
- Node.js 22+
- npm 10+
- `swiftc` if you want the microphone permission helper compiled during install
- Codex CLI if you want live analysis with `ANALYSIS_PROVIDER=codex`

### First-time setup

```bash
git clone <repo>
cd stream-topic-copilot
bash scripts/install.sh
```

`install.sh` does eleven things:

1. installs npm dependencies
2. creates `.env` from `.env.example` if needed
3. installs `whisper-cpp` with Homebrew when it is available
4. installs `blackhole-2ch` with Homebrew
5. downloads a Whisper model locally and updates `.env` to use the Whisper provider
6. compiles an SDL-based audio-device helper so the app can use Whisper-compatible capture IDs
7. compiles a native mic activity probe helper for the Config view diagnostics
8. compiles `scripts/request-microphone-permission.swift` into `.bin/request-microphone-permission`
9. compiles the future-facing native system-audio helper
10. invokes the permission helper once so macOS can grant microphone access
11. runs the audio doctor, auto-selects the recommended routed desktop-audio source, and prints routing guidance if signal is missing

The installer prints numbered progress steps while it runs.

To choose a model at install time:

```bash
bash scripts/install.sh medium.en
```

If no model is provided, the installer defaults to `small.en`.

### Whisper.cpp setup

Whisper is not bundled in this repository, but `install.sh` now installs the Homebrew `whisper-cpp` formula, downloads the selected model, and updates `.env` to:

```bash
STT_PROVIDER=whisper
STT_EXECUTABLE=/opt/homebrew/bin/...
WHISPER_MODEL=/absolute/path/to/repo/.models/whisper.cpp/ggml-small.en.bin
```

Notes:

- `small.en` is the recommended starting model.
- Models are downloaded into `.models/whisper.cpp/` inside the repo and ignored by git.
- `install.sh` sets `STT_EXECUTABLE` automatically from the Homebrew `whisper-cpp` install.
- The app now enumerates Whisper devices through an SDL helper so the selected capture ID matches what `whisper-stream` expects.
- Desktop Audio now means a routed input device such as BlackHole, not ScreenCaptureKit display capture.
- `install.sh` tries to detect BlackHole, writes the recommended `system-mix` source into config, and suggests Audio MIDI Setup steps if signal is still missing.
- The Config view includes a separate native microphone activity probe and device diagnostics.
- The current `WhisperCppProvider` expects a streaming-compatible binary such as `whisper-stream` that emits transcript lines to stdout.
- Native display/app audio remains future-facing and is disabled by default until a signed helper identity exists.
- If microphone permission was denied previously, rerun `./.bin/request-microphone-permission request` after fixing macOS privacy settings.

### Manual Whisper.cpp build fallback

If you prefer not to use the Homebrew package, you can still build `whisper.cpp` manually. In that path, `cmake` is required:

```bash
brew install cmake
git clone https://github.com/ggml-org/whisper.cpp.git
cd whisper.cpp
cmake -B build
cmake --build build -j
```

Then point `STT_EXECUTABLE` and `WHISPER_MODEL` at your built binary and downloaded model file.

### Codex CLI setup

If you want real analysis instead of the mock provider:

```bash
codex login
```

Then set:

```bash
ANALYSIS_PROVIDER=codex
ANALYSIS_PROVIDER_COMMAND=codex exec --skip-git-repo-check --color never
ANALYSIS_STRUCTURED_OUTPUT_FLAG=--output-schema
```

The provider uses `codex exec` with the machine-readable schema at [docs/scoping/codex-analysis-response-schema.json](/Users/mike/Projects/stream-topic-copilot/docs/scoping/codex-analysis-response-schema.json).

## Developer Config

### Common commands

```bash
npm run dev
npm run doctor:audio
npm run build
npm run start
npm run typecheck
npm test
```

`npm run dev` now starts both the API server on `http://127.0.0.1:4312` and the Vite UI dev server on `http://127.0.0.1:5173`.

### Runtime configuration

Copy `.env.example` to `.env` if `install.sh` has not already done it.

Important variables:

- `PORT`, `HOST`: HTTP bind address for the local server
- `DATA_DIR`: config and sample markdown location
- `SESSIONS_DIR`: per-session artifacts
- `CONFIG_PATH`: persisted UI config JSON
- `STT_PROVIDER`: `mock` or `whisper`
- `ANALYSIS_PROVIDER`: `mock` or `codex`
- `ANALYSIS_PROVIDER_COMMAND`: base Codex CLI command
- `ANALYSIS_STRUCTURED_OUTPUT_FLAG`: currently `--output-schema`
- `ANALYSIS_CONFIDENCE_THRESHOLD`: auto-apply threshold for provider suggestions
- `STT_EXECUTABLE`: Whisper binary path
- `WHISPER_MODEL`: Whisper model path or model name
- `POLLING_INTERVAL_MS`: browser polling interval
- `TRANSCRIPT_TAIL_SIZE`: rolling transcript tail size
- `CHUNK_WORD_THRESHOLD`, `CHUNK_TIME_THRESHOLD_SECONDS`: raw chunk detection overrides
- `CHUNK_SENSITIVITY`: `low`, `medium`, or `high`
- `MIC_PERMISSION_HELPER`: compiled Swift helper path
- `MIC_PROBE_HELPER`, `SDL_AUDIO_DEVICES_HELPER`: compiled local audio helper paths
- `NATIVE_SYSTEM_AUDIO_HELPER`: native ScreenCaptureKit helper path
- `ENABLE_NATIVE_SYSTEM_AUDIO_CAPTURE`: leave `false` until a signed helper identity exists

### Default developer mode

The safe local default is:

```bash
STT_PROVIDER=mock
ANALYSIS_PROVIDER=mock
```

That gives you:

- no external service dependency
- deterministic tests
- a usable local UI for session flow and artifact verification

### Files and artifacts

- App entrypoint: [src/server/index.ts](/Users/mike/Projects/stream-topic-copilot/src/server/index.ts)
- Session orchestration: [src/server/appService.ts](/Users/mike/Projects/stream-topic-copilot/src/server/appService.ts)
- Topic parser: [src/server/domain/topics/markdownParser.ts](/Users/mike/Projects/stream-topic-copilot/src/server/domain/topics/markdownParser.ts)
- Proposed markdown generator: [src/server/domain/topics/proposedMarkdown.ts](/Users/mike/Projects/stream-topic-copilot/src/server/domain/topics/proposedMarkdown.ts)
- Mock STT provider: [src/server/providers/stt/mockProvider.ts](/Users/mike/Projects/stream-topic-copilot/src/server/providers/stt/mockProvider.ts)
- Whisper provider: [src/server/providers/stt/whisperProvider.ts](/Users/mike/Projects/stream-topic-copilot/src/server/providers/stt/whisperProvider.ts)
- Mock analysis provider: [src/server/providers/analysis/mockProvider.ts](/Users/mike/Projects/stream-topic-copilot/src/server/providers/analysis/mockProvider.ts)
- Codex analysis provider: [src/server/providers/analysis/codexProvider.ts](/Users/mike/Projects/stream-topic-copilot/src/server/providers/analysis/codexProvider.ts)

Per-session outputs are written to:

```text
sessions/<session-id>/
  session.json
  session-summary.json
  source-topics.md
  proposed-final.md
  live-transcript.txt
  transcript.approx.srt
  transcript.final.srt
  transcript.events.jsonl
  transcript.chunks.jsonl
  analysis.requests.jsonl
  analysis.responses.jsonl
  analysis.raw.jsonl
  topic-state-history.jsonl
```

Notes:

- `transcript.approx.srt` is generated from the app’s internal chunk timing and is always available after session end.
- `transcript.final.srt` is generated from the saved Whisper WAV via `whisper-cli` when the final post-pass succeeds.

## Runbook

### Starting a stream session

1. Start the app with `npm run dev`.
2. Open `http://127.0.0.1:5173`.
3. In `Config`, confirm the markdown file, provider choices, microphone, and chunk sensitivity.
4. Click `Start session`.
5. If you are using the mock STT provider, paste transcript text into the `Mock Transcript Input` card to simulate live speech.

### During a live session

- `Analyze now` forces chunk analysis for the pending transcript buffer.
- Topic buttons let you set `partial`, `covered`, `snoozed`, or `dismissed`.
- `Undo` reverts the most recent direct state change.
- The UI polls `/api/state` and refreshes transcript tail, suggestions, warnings, and topic state.
- The transcript card now renders finalized chunks in an SRT-like format for easier reading during the session.

### Ending a session

- Click `End session` for a clean finish.
- On `SIGINT` or `SIGTERM`, the app marks the session as `interrupted`, flushes artifacts, and exits.

### Resuming a session

From the `Config` tab, use the resume list. A session is resumable when its status is `active`, `paused`, or `interrupted`.

If the source markdown changed since the session started, the UI shows a warning and continues from the stored snapshot.

### Debugging failures

- If the UI shows a microphone permission issue, run `./.bin/request-microphone-permission status`.
- To validate Desktop Audio routing, run `npm run doctor:audio` while system audio is playing.
- If Whisper fails to start, verify `STT_EXECUTABLE` and `WHISPER_MODEL`.
- If Codex analysis fails, verify `codex exec --help` works locally and that you are logged in.
- For postmortem review, inspect the JSONL files under the relevant session directory.

### Test and verification workflow

```bash
npm run typecheck
npm test
npm run build
npm run doctor:audio
```

The current suite covers markdown parsing, proposed markdown generation, the audio doctor workflow, and end-to-end session/API flows for mock, routed desktop audio, and native-audio diagnostics.
