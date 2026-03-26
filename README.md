# Stream Topic Copilot

Local TypeScript app for running a narrow stream-topic control surface next to OBS. It reads a markdown topic plan, captures transcript events, analyzes chunks through pluggable providers, and writes session artifacts plus a proposed final markdown update.

This repository is local only. It is maintained for two personal laptops and is not intended for production deployment.

## Read This First

- `README.md`: operator setup and day-to-day commands
- `AGENTS.md`: canonical agent working contract
- `docs/repo-map.md`: architecture, config layers, and artifact conventions

## Quick Start

### Prerequisites

- macOS on Apple Silicon
- Homebrew
- Node.js 22+
- npm 10+
- `swiftc` if you want the microphone permission helper compiled during install
- Codex CLI if you want live analysis with `ANALYSIS_PROVIDER=codex`

### First-Time Setup

```bash
git clone <repo>
cd stream-topic-copilot
bash scripts/install.sh
```

The installer:

- installs dependencies when needed
- creates `.env` from `.env.example`
- installs Whisper and BlackHole through Homebrew
- downloads the selected Whisper model
- builds local helper binaries
- requests microphone permission once
- runs the audio doctor and applies the recommended desktop-audio source to local config

Choose a different Whisper model at install time with:

```bash
bash scripts/install.sh medium.en
```

## Safe Local Defaults

The safe baseline for development and agent work is:

```bash
STT_PROVIDER=mock
ANALYSIS_PROVIDER=mock
```

That path avoids external dependencies and keeps tests deterministic.

## Common Commands

```bash
npm run dev
npm run doctor:audio
npm run session:latest -- --json
npm run verify
npm run build
npm run start
```

`npm run verify` runs `typecheck` and `test`. Run `npm run build` as well when changing UI/server integration or delivery shape.

## Config Model

- Committed defaults: `data/config.default.json`
- Operator-local runtime config: `data/config.local.json` (gitignored)
- Default topic plan: `data/sample-topics.md`
- Environment overrides: `.env`

Important variables in `.env`:

- `PORT`, `HOST`
- `DATA_DIR`, `SESSIONS_DIR`, `PUBLIC_DIR`
- `CONFIG_DEFAULT_PATH`, `CONFIG_PATH`
- `STT_PROVIDER`, `ANALYSIS_PROVIDER`
- `ANALYSIS_PROVIDER_COMMAND`, `ANALYSIS_STRUCTURED_OUTPUT_FLAG`
- `ANALYSIS_CONFIDENCE_THRESHOLD`
- `STT_EXECUTABLE`, `WHISPER_MODEL`
- `POLLING_INTERVAL_MS`, `TRANSCRIPT_TAIL_SIZE`
- `CHUNK_WORD_THRESHOLD`, `CHUNK_TIME_THRESHOLD_SECONDS`, `CHUNK_SENSITIVITY`
- `MIC_PERMISSION_HELPER`, `MIC_PROBE_HELPER`, `SDL_AUDIO_DEVICES_HELPER`
- `NATIVE_SYSTEM_AUDIO_HELPER`, `ENABLE_NATIVE_SYSTEM_AUDIO_CAPTURE`

## Real Provider Notes

If you want Codex analysis instead of the mock provider:

```bash
codex login
```

Then set:

```bash
ANALYSIS_PROVIDER=codex
ANALYSIS_PROVIDER_COMMAND=codex exec --skip-git-repo-check --color never
ANALYSIS_STRUCTURED_OUTPUT_FLAG=--output-schema
```

If you want to re-check desktop audio routing:

```bash
npm run doctor:audio
```

Real audio, permissions, and live provider workflows are operator-owned. Agents should not assume they can operate those paths without permission.

## Session Artifacts

Per-session outputs are written to `sessions/<session-id>/`.

Most useful files:

- `session-recap.json`
- `session-summary.json`
- `session-recap.md`
- `transcript.chunks.jsonl`
- `analysis.responses.jsonl`
- `session.json`

## Repo Skill: Latest Session

This repo includes a local skill for answering questions about the latest session:

- Skill: `skills/latest-session/SKILL.md`
- Helper: `npm run session:latest -- --json`

If you are guiding an agent, point it at the skill file and the helper command. The default behavior is recap-first, with transcript/artifact fallback only when the recap is insufficient.

Copy-paste starter:

```text
Use the repo skill at skills/latest-session/SKILL.md and answer this about the latest session:
```

## Troubleshooting

- If the UI shows a microphone permission issue, run `./.bin/request-microphone-permission status`.
- If Whisper fails to start, verify `STT_EXECUTABLE` and `WHISPER_MODEL`.
- If Codex analysis fails, verify `codex exec --help` works locally and that you are logged in.
- For postmortem review, inspect the relevant files under `sessions/<session-id>/`.
