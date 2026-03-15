# Stream Topic Copilot

Local TypeScript utility for running a narrow browser-side stream control surface next to OBS. It reads a markdown topic plan, captures transcript events from a pluggable STT provider, analyzes semantically complete chunks through a pluggable analysis provider, and writes session artifacts plus a proposed final markdown update.

The project is runnable without external services by using the default mock providers. The test suite also uses mocked providers, so `npm test` does not require Whisper or Codex.

## Project Setup

### Prerequisites

- macOS on Apple Silicon
- Node.js 22+
- npm 10+
- `swiftc` if you want the microphone permission helper compiled during install
- Codex CLI if you want live analysis with `ANALYSIS_PROVIDER=codex`
- `whisper.cpp` if you want live STT with `STT_PROVIDER=whisper`

### First-time setup

```bash
git clone <repo>
cd stream-topic-copilot
bash scripts/install.sh
```

`install.sh` does four things:

1. installs npm dependencies
2. creates `.env` from `.env.example` if needed
3. compiles `scripts/request-microphone-permission.swift` into `.bin/request-microphone-permission`
4. invokes the helper once so macOS can grant microphone access

### Whisper.cpp setup

Whisper is not bundled in this repository. You need to install or build it separately, then wire the binary and model path in `.env`.

Suggested steps:

```bash
git clone https://github.com/ggerganov/whisper.cpp.git
cd whisper.cpp
sh ./models/download-ggml-model.sh small.en
# build the project
cmake -B build
cmake --build build -j --config Release
```

Then set the corresponding values in `.env`:

```bash
STT_PROVIDER=whisper
STT_EXECUTABLE=/absolute/path/to/whisper.cpp/build/bin/whisper-stream
WHISPER_MODEL=/absolute/path/to/whisper.cpp/models/ggml-small.en.bin
```

Notes:

- `small.en` is the recommended starting model.
- The current `WhisperCppProvider` expects a streaming-compatible binary that emits transcript lines to stdout.
- If microphone permission was denied previously, rerun `./.bin/request-microphone-permission request` after fixing macOS privacy settings.

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
npm run build
npm run start
npm run typecheck
npm test
```

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
  transcript.events.jsonl
  transcript.chunks.jsonl
  analysis.requests.jsonl
  analysis.responses.jsonl
  analysis.raw.jsonl
  topic-state-history.jsonl
```

## Runbook

### Starting a stream session

1. Start the app with `npm run dev`.
2. Open the printed local URL.
3. In `Config`, confirm the markdown file, provider choices, microphone, and chunk sensitivity.
4. Click `Start session`.
5. If you are using the mock STT provider, paste transcript text into the `Mock Transcript Input` card to simulate live speech.

### During a live session

- `Analyze now` forces chunk analysis for the pending transcript buffer.
- Topic buttons let you set `partial`, `covered`, `snoozed`, or `dismissed`.
- `Undo` reverts the most recent direct state change.
- The UI polls `/api/state` and refreshes transcript tail, suggestions, warnings, and topic state.

### Ending a session

- Click `End session` for a clean finish.
- On `SIGINT` or `SIGTERM`, the app marks the session as `interrupted`, flushes artifacts, and exits.

### Resuming a session

From the `Config` tab, use the resume list. A session is resumable when its status is `active`, `paused`, or `interrupted`.

If the source markdown changed since the session started, the UI shows a warning and continues from the stored snapshot.

### Debugging failures

- If the UI shows a microphone permission issue, run `./.bin/request-microphone-permission status`.
- If Whisper fails to start, verify `STT_EXECUTABLE` and `WHISPER_MODEL`.
- If Codex analysis fails, verify `codex exec --help` works locally and that you are logged in.
- For postmortem review, inspect the JSONL files under the relevant session directory.

### Test and verification workflow

```bash
npm run typecheck
npm test
npm run build
```

The current suite covers markdown parsing, proposed markdown generation, and an end-to-end mock-backed session/API flow.
