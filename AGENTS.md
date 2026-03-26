# Agent Contract

## Project Mode

- This repository is local only. It is not production software.
- The app is operated on two personal laptops by the same person who maintains the code.
- Optimize for safe code editing, documentation maintenance, and mock-path verification first.
- Treat real audio capture, macOS permissions, Homebrew installs, Whisper setup, and Codex live-provider operation as operator-owned workflows.

## Canonical Docs

- Read `README.md` first for operator-facing setup and common workflows.
- Read `docs/repo-map.md` for architecture, artifacts, and path conventions.
- Keep docs at `HEAD` accurate. Documentation is part of the deliverable, not follow-up work.

## Safe Command Surface

These commands are pre-approved when relevant to the task:

- read/search commands such as `rg`, `find`, `sed`, `cat`, and `git status`
- `npm run typecheck`
- `npm run test`
- `npm run verify`
- `npm run build`
- `npm run session:latest -- --json`

## Ask Permission First

Ask before running commands that change operator-local state or start operator-mode workflows, including:

- `bash scripts/install.sh`
- package installs or updates
- helper compilation or native toolchain changes
- `.env` edits
- writes to `data/config.local.json` or other operator-local config
- permission prompts or privacy-settings actions
- real-provider workflows using Whisper or Codex
- starting the actual app for live use, real sessions, or anything that interacts with the operator setup beyond contained validation

Contained local dev processes are acceptable when they are necessary for validation, but keep them scoped and do not cross into real operator workflows without permission.

## Config And State

- Committed defaults live in `data/config.default.json`.
- Operator-local runtime config lives in `data/config.local.json` and is gitignored.
- Do not treat values from the local config, local `.env`, or saved session artifacts as canonical project defaults.
- Prefer the mock provider path unless the task explicitly targets real-provider behavior.

## Documentation Rule

Update documentation in the same task whenever you change:

- commands or verification expectations
- config shape or path conventions
- workflow or setup behavior
- architecture assumptions future agents will rely on
- session artifact or helper-script contracts

Pure internal refactors that do not change repo-facing behavior can skip docs.

## Verification Ladder

- Default for code changes: `npm run verify`
- Also run `npm run build` when the change affects UI/server integration, packaging, or runtime delivery shape.
- Do not require real audio or install validation unless the task explicitly targets those workflows.

## Latest Session Skill

- Repo-contained skill: `skills/latest-session/SKILL.md`
- Stable helper: `npm run session:latest -- --json`
- Default usage is recap-first. Only inspect transcript chunks or analysis responses when the user asks for evidence or the recap is insufficient.
- Answer concisely and include a terse source note when relevant.
