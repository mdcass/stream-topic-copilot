---
name: latest-session
description: Answer questions about the most recent finished Stream Topic Copilot session, or a specific session when provided, using the repo helper and recap-first artifact selection.
---

# Latest Session

Use this skill when the user asks what happened in the latest session, what they said they would do next, which topics were covered, or when they want follow-up questions answered from session artifacts.

## Workflow

1. Run `npm run session:latest -- --json` to resolve the newest finished session.
2. If the user names a session id or path, run `npm run session:latest -- --json --session <value>`.
3. Read preferred artifacts first.
4. Fall back to transcript chunks or analysis responses only if the recap/summary is missing or too vague for the question.

## Preferred Sources

- `session-recap.json`
- `session-summary.json`
- `session-recap.md`

## Fallback Sources

- `transcript.chunks.jsonl`
- `analysis.responses.jsonl`
- `session.json`

## Answer Style

- Be concise and answer in the shape requested by the user.
- For “what next?” style questions, prefer `futureFollowUps` from the recap.
- For “what did I cover?” questions, prefer recap overview and prepared-topics fields.
- Add a terse source note when relevant, such as `Source: latest session recap`.
- Do not dump transcript excerpts unless the user asks for exact wording or evidence.
