# Repo Map

## Purpose

Stream Topic Copilot is a local-only stream companion for managing a markdown topic plan during a session. It captures transcript events, analyzes chunks, and writes session artifacts for review and follow-up.

## Main Runtime Surfaces

- `src/server/index.ts`: process entrypoint and provider wiring
- `src/server/appService.ts`: session lifecycle, config updates, transcript chunking, analysis application, and artifact writes
- `src/server/app.ts`: HTTP API and static asset serving
- `src/ui/main.js`: single-page UI for config, live session control, and history

## Config Model

- `data/config.default.json`: committed defaults that describe the safe local/mock baseline
- `data/config.local.json`: ignored operator-local runtime state written by the app
- `.env`: local environment overrides for providers, helpers, and paths
- `.env.example`: documented baseline environment values

`FileStore.loadConfig()` applies config layers in this order:

1. code defaults
2. committed default config
3. local operator config

Relative `markdownFilePath` entries in config files resolve relative to the config file that declared them.

## Artifact Model

Per-session outputs live under `sessions/<session-id>/`.

High-signal artifacts:

- `session-recap.json`: best default source for “what happened?” and “what next?”
- `session-summary.json`: short structured summary for the session
- `session-recap.md`: markdown version of the recap
- `transcript.chunks.jsonl`: transcript chunk history for evidence and drill-down
- `analysis.responses.jsonl`: model output history
- `session.json`: complete session snapshot

Treat these as local artifacts, not committed source-of-truth project docs.

## Verification

- Normal code changes: `npm run verify`
- Integration-shape changes: also run `npm run build`
- Real audio, permissions, install, and live-provider validation remain operator-owned

## Repo-Contained Skill

- Skill path: `skills/latest-session/SKILL.md`
- Helper command: `npm run session:latest -- --json`

The helper resolves the newest finished session by default and returns recap-first artifact metadata. It accepts `--session <id-or-path>` when a task needs a specific session.
