# Stream Topic Copilot — Product Requirements Document

## 1. Overview

Stream Topic Copilot is a small local utility for macOS that helps a solo streamer rotate through prepared talking points, avoid dead air, and keep a reliable record of what was discussed during a stream.

The product reads an opinionated markdown topics file, listens to the selected microphone using a local speech-to-text provider, analyzes semantically complete transcript chunks with a pluggable analysis provider (V1: codex-cli), and presents a narrow browser-based control surface next to OBS.

The app should not mutate the source markdown live during a session. Instead, it should maintain separate session state and produce a proposed final markdown update at the end of the stream.

## 2. Product Goal

Improve topic rotation during gaming and co-working / pomodoro streams.

## 3. Primary User

A single streamer running the tool locally on an M1 Mac, comfortable with developer tooling, who wants:

- prepared prompts surfaced during a live stream,
- transcript-backed semantic tracking of what was actually discussed,
- follow-on prompts for elaboration and topic transitions,
- session recovery after interruptions,
- auditable logs of model requests and responses.

## 4. Core Product Promise

Given a markdown file of prepared talking points, the app should:

- surface the most relevant active topics during a stream,
- show a tail of the live transcript,
- suggest elaboration starters,
- suggest adjacent next topics,
- suggest recovery prompts for low-energy moments,
- track covered / partial / snoozed / dismissed topic state conservatively,
- produce a proposed end-of-session markdown update without corrupting the original file.

## 5. Non-Goals for V1

- no desktop-native wrapper,
- no Laravel implementation,
- no real-time perfect understanding of every spoken stream moment,
- no automatic live write-back to the source markdown,
- no advanced hotkeys,
- no deep theming,
- no requirement for zero scrolling,
- no dependence on cloud STT.

## 6. Key Design Principles

### 6.1 Conservative semantic completion
The app should be reluctant to mark a topic as covered unless the transcript gives good evidence.

### 6.2 Session state separate from source planning file
The original markdown is editorial truth. Runtime state belongs in session artifacts.

### 6.3 Off-topic tolerance
Not everything said on stream will map to the prepared topic file. The app must distinguish:

- prepared topics clearly covered,
- prepared topics partially touched,
- off-topic but interesting observations,
- stream chatter that should not affect planned topic completion.

### 6.4 Resume-friendly operation
The app must recover from pauses, technical problems, or restarts without losing the session's semantic state.

### 6.5 Auditable AI behavior
Analysis provider requests and structured responses must be logged for later inspection.

## 7. Technical Direction

### 7.1 Runtime
Node.js first, using TypeScript.

### 7.2 Frontend
A thin browser UI served locally. The browser receives live state updates via HTTP polling (GET every ~2 seconds by default; interval configurable via `.env`).

### 7.3 Backend shape
A lightweight local Node app should:

- serve the UI,
- enumerate microphones,
- persist configuration,
- manage sessions,
- spawn STT provider processes,
- spawn analysis provider processes,
- write logs and generated artifacts,
- expose live state to the browser via a polling endpoint.

### 7.4 STT

V1 implementation: **whisper.cpp** compiled for Apple Silicon, running in streaming mode (continuous audio pipe, partial results emitted in real time).

STT must be implemented behind a pluggable provider interface so future providers such as Parakeet can be added without redesigning the app.

The Whisper model size and binary path are configurable via `.env`. The recommended starting default is `small.en`; document this recommendation but do not hardcode it.

macOS microphone permission must be granted before the app can capture audio. The Node process cannot trigger the system permission dialog directly. `install.sh` must include a step that invokes a small native helper binary to request microphone permission at install time. The app must also detect a missing permission at startup and surface a clear, actionable error with instructions.

### 7.5 Analysis provider

Analysis must be implemented behind a pluggable provider interface, mirroring the STT provider pattern. The V1 provider is **codex-cli** (OpenAI's open-source CLI tool).

Requirements for any supported analysis provider:

- the provider must support native structured output (i.e. it must have a dedicated flag or mode that returns valid JSON rather than free text),
- the Node app communicates with the provider by spawning it as a subprocess and passing the prompt via CLI flags,
- the provider must return a response conforming to the response schema defined in the companion spec.

**Implementation prerequisite:** Before the analysis provider can be implemented, a research spike is required to confirm the exact codex-cli flag for structured output and validate the invocation contract. This spike should be treated as a blocker for the `src/server/providers/analysis/` layer.

Analysis calls have no hard timeout. Latency per call must be logged for later review.

## 8. Target Platform

- macOS on Apple Silicon (initial target: M1 Mac)
- local execution only for the app itself
- analysis provider may use cloud models

## 9. User Flow

### 9.1 App start
User starts the utility from the command line.

### 9.2 Outside-session landing page
If no session is active, the first page shown is the Config tab / setup page.

### 9.3 Configuration
User can:

- select the markdown topics file,
- select microphone device from a dropdown,
- view a microphone level meter,
- refresh microphone device list,
- save configuration,
- test or validate microphone capture,
- choose STT provider,
- set chunk-analysis sensitivity (Low / Medium / High),
- resume an existing unfinished session.

### 9.4 Session start
When the user starts a session, the app should:

- assign stable IDs to all topics and store them in the session snapshot (IDs are never written back to the source file),
- snapshot the source markdown into session state,
- start microphone transcription,
- begin collecting transcript events,
- show the live browser UI,
- allow manual analysis at any time.

### 9.5 Live operation
During a session, the app should:

- maintain a rolling transcript tail,
- identify semantically complete transcript chunks,
- automatically trigger chunk analysis when heuristics are met,
- allow "Analyze now" manually,
- update live suggestion cards from structured analysis (browser polls for state updates),
- allow topic state actions with one click,
- support config access during the session in case the microphone changes.

### 9.6 Session interruption / resume
If the app or stream is paused, the user should be able to resume the unfinished session and recover:

- topic state,
- transcript tail,
- suggestion state where practical,
- pending proposed markdown output,
- logs.

A session is eligible for resume if its status is `active`, `paused`, or `interrupted` (not `finished`).

### 9.7 Session end
A session ends when:

- the user clicks the **End Session** button in the Controls card (preferred, clean path), OR
- the Node process exits (Ctrl+C / SIGTERM); the app must register a graceful shutdown handler that finalizes the session and writes artifacts before exiting.

At end of session, the app should generate:

- proposed final markdown file,
- structured session summary,
- transcript artifacts,
- analysis provider request/response logs,
- topic state history.

## 10. Functional Requirements

### 10.1 Markdown input and parsing
The app shall accept an opinionated markdown structure.

The parser shall support:

- section headings,
- checkboxes,
- parent bullets,
- sub-bullets,
- stable metadata IDs (managed by the tool in session state).

Parent bullets should be treated as topic clusters.
Sub-bullets should be treated as more independent angles / beats.

**Section name semantics:** Section names (e.g. Priority, Fallback, Carry-over) are organizational labels for the user's planning only. The app does not derive priority ordering or behavior from section names. Topics are ordered by their position in the file.

**Stable ID assignment:** Stable IDs (e.g. `<!-- id: tp_001 -->`) are assigned at session start and stored only in the session snapshot. The source file is never mutated for ID purposes. When a topic has no ID comment in the source, the app derives a stable ID from the topic's parse-time position and a hash of its text.

#### Example supported structure

```md
# Stream Topics

## Priority
- [ ] New PC build <!-- id: tp_001 -->
  - Cooling issue <!-- id: tp_001_a -->
  - Cable routing regret <!-- id: tp_001_b -->

## Fallback
- [ ] Weird developer habits <!-- id: tp_002 -->

## Carry-over
- [ ] OBS scene cleanup <!-- id: tp_003 -->
```

### 10.2 Topic states
Each topic shall support the following states:

- pending
- partial
- covered
- snoozed
- dismissed

Definitions:

- pending: still available for this stream
- partial: touched on, but not clearly exhausted
- covered: semantically discussed enough to count
- snoozed: intentionally not for this stream, should remain for future use
- dismissed: irrelevant / bad suggestion for current context

**Parent topic state inference:**

- A parent topic becomes `partial` automatically when any of its child beats reaches `partial` or `covered`.
- A parent topic becomes `covered` automatically when 50% or more of its child beats are `covered`.
- A parent topic's state can also be set directly by the analysis provider or by the user; direct assignment overrides the auto-inferred state.

### 10.3 Microphone selection and resilience
The app shall provide a microphone dropdown in the UI.

The app shall not require manual device ID entry.

The app shall:

- list human-readable microphone devices,
- persist the chosen microphone where possible,
- provide a fallback if the selected device disappears,
- allow microphone switching during a session,
- show a live level meter,
- make audio-routing issues visible and understandable.

### 10.4 STT provider abstraction
The app shall define an internal STT provider contract.

Provider responsibilities:

- enumerate devices if applicable,
- start transcription,
- stop transcription,
- emit transcript events,
- expose chunk metadata,
- report errors cleanly.

V1 provider:

- whisper.cpp (Apple Silicon, streaming mode)

Future provider examples:

- Parakeet

### 10.5 Transcript handling
The app shall store:

- raw transcript text or events,
- structured transcript chunks.

The UI shall display a rolling transcript tail during the session.

### 10.6 Chunk detection
The app shall use a hybrid chunking strategy.

V1 chunk trigger inputs:

- sentence / paragraph completion heuristic,
- sufficient new spoken content threshold,
- optional silence-after-speech support,
- manual "Analyze now" override.

Time alone shall not be the only analysis trigger.

**Default thresholds (Medium sensitivity):**

- ~120 words of new speech, OR ~60 seconds of new speech (whichever is reached first).

**Sensitivity levels:**

| Level  | Word threshold | Time threshold |
|--------|---------------|----------------|
| Low    | ~200 words    | ~120 seconds   |
| Medium | ~120 words    | ~60 seconds    |
| High   | ~50 words     | ~30 seconds    |

The sensitivity level is selected in the UI (Low / Medium / High). Raw threshold values are available for override via `.env`.

### 10.7 Analysis provider
When a chunk is ready, the app shall invoke the configured analysis provider subprocess.

The request shall include at minimum:

- relevant unresolved topics (IDs, text, current state),
- latest transcript chunk,
- compact session context (see below),
- explicit instructions to separate planned-topic evidence from off-topic speech.

**Compact session context** is a short structured block containing:

- session elapsed time,
- topic counts by state (pending / partial / covered / snoozed / dismissed),
- number of analysis passes completed so far.

The response shall be strict structured output. The exact V1 response schema is defined in [docs/scoping/codex-analysis-response-schema.md](docs/scoping/codex-analysis-response-schema.md).

**Response validation** is the responsibility of the analysis domain layer. On validation failure, the chunk is logged as unanalyzed and the error is surfaced clearly in the UI. The session continues uninterrupted.

**Note:** Section 13.4 describes the internal stored representation after parsing the provider response. The companion schema defines the wire format returned by the provider.

### 10.8 Suggestion categories
The live UI shall support the following categories:

- Active topics
- Elaboration starters
- Adjacent next topics
- Recovery prompts
- Off-topic observations

Definitions:

- Active topics: strongest current topics from the markdown plan
- Elaboration starters: prompts to expand what was just discussed
- Adjacent next topics: prompts to segue into another topic
- Recovery prompts: generated by the analysis provider per session, based on the topic file and stream context; not drawn from a static list
- Off-topic observations: detected themes that should not automatically modify the markdown state; display-only in V1 (no promotion action)

### 10.9 Topic state controls
The live UI shall allow one-click actions for at least:

- mark covered
- snooze
- dismiss
- undo last action

The user may also manually set `partial`.

**Auto-apply behavior:**

- Analysis-suggested state changes are applied automatically when the analysis confidence score meets or exceeds the configured threshold (default: 0.8; configurable via `.env`).
- Below the threshold, the suggested state change is shown as a proposal; the user must click to accept.
- When analysis suggests a change for a topic that already has a user-set state, the analysis wins if confidence meets the threshold.
- The undo action reverts the most recent state change regardless of whether it was user-initiated or analysis-driven.

### 10.10 Proposed markdown output
The source markdown shall not be mutated live.

V1 output format: a proposed final markdown file written beside session artifacts.

**Transformation rules per state:**

- **covered:** checkbox set to `[x]`, metadata comment updated to `<!-- covered: <session_id> -->`, topic moved into a `## Done` section appended to the proposed file.
- **dismissed:** metadata comment updated to `<!-- dismissed -->`, topic moved into a `## Dismissed` section appended to the proposed file.
- **snoozed:** checkbox remains `[ ]`, metadata comment updated to `<!-- snoozed -->`, topic stays in its original section.
- **partial:** no structural change; topic remains in its original section unchanged.
- **pending:** no change.

The original section structure (headings, order, non-topic content) is preserved for remaining topics. The `## Done` and `## Dismissed` sections are always appended at the end of the proposed file.

### 10.11 Session resume
The app shall support resuming an unfinished session after interruption.

A session is resumable if its status is `active`, `paused`, or `interrupted`. Sessions with status `finished` are not resumable.

Resume should restore all practical session state, including:

- topic states,
- transcript tail,
- transcript artifacts,
- logs,
- pending proposed output,
- recent suggestions where practical.

If the source markdown file has changed since the session was created, the app should warn the user before resuming; the session continues to operate from its snapshot.

### 10.12 Logging and observability
The app shall log:

- analysis provider requests,
- analysis provider structured responses,
- transcript chunks,
- session metadata,
- topic state changes (including whether the change was user-initiated or analysis-driven).

Replay mode is desirable and should be considered in the architecture, even if not fully surfaced in V1.

### 10.13 Graceful degradation
If the analysis provider is unavailable or errors, the app shall:

- keep STT running,
- keep the UI usable,
- surface the failure clearly,
- allow continued transcript capture,
- permit later analysis once the dependency recovers.

The session must not become unusable solely because analysis fails.

## 11. UI Requirements

### 11.1 General layout
The main live UI should be a narrow vertical browser column approximately suited to a Bootstrap `col-3` style width.

Use compact cards and minimal padding.

A perfect no-scroll experience is not required for V1.

### 11.2 Tabs / views
V1 should include at least:

- Config
- Live
- History

### 11.3 Default routing
When outside a session, default to Config.

### 11.4 Live view layout order
Recommended order:

1. Controls card (Analyze Now button, session elapsed timer, microphone status indicator, End Session button)
2. Active topics card
3. Elaboration starters card
4. Adjacent next topics card
5. Recovery prompts card
6. Off-topic observations card
7. Transcript tail card
8. Undo / recent action area

### 11.5 Config view requirements
Config should include:

- markdown file path picker / input,
- microphone dropdown,
- refresh devices button,
- level meter,
- STT provider selection,
- chunk sensitivity selector (Low / Medium / High),
- session resume options (list of resumable sessions).

### 11.6 History view
History should display all four of:

- **Session index:** list of past sessions with date, duration, and topic coverage summary (counts by state).
- **Per-session timeline:** drilldown showing topic state changes and when they occurred.
- **Artifact links:** links to session outputs (proposed markdown, transcript files, logs).
- **Analysis audit:** recent analysis provider results showing suggestions and confidence scores.

It does not need to be feature-rich in V1 beyond the above.

## 12. Analysis Behavior Requirements

### 12.1 Avoiding semantic drift
The model should not be asked an open-ended question such as "what did the user talk about?"

Instead, the analysis prompt should constrain the task to:

- which prepared topics were clearly covered,
- which prepared topics were partially covered,
- which prepared topics were not covered,
- what evidence supports the above,
- what off-topic themes emerged,
- what live suggestions would now be useful.

### 12.2 Evidence and confidence
Structured analysis should include:

- topic IDs,
- suggested state,
- confidence (0.0–1.0),
- supporting transcript evidence or reference,
- rationale,
- suggestion categories.

Auto-apply threshold default is 0.8. This value is configurable via `.env`.

### 12.3 Analysis provider contract
Any supported analysis provider must:

- accept a structured prompt delivered via CLI flags,
- natively support a structured output mode that returns valid JSON without free-text wrapping,
- return a response conforming to the companion schema.

The structured output flag or mode is a hard requirement for provider eligibility. No provider should be integrated that requires free-text JSON extraction from unstructured output.

## 13. Data Model

### 13.1 Topic entity
Suggested topic fields:

- id (derived from source comment or generated from position + text hash at session start)
- parentId
- section
- text
- type (`cluster` or `beat`)
- originalOrder
- currentState
- stateSetBy (`user` or `analysis` or `inferred`)
- confidenceAtLastChange
- evidenceRefs
- lastUpdatedAt

### 13.2 Session entity
Suggested session fields:

- id (format: `<YYYY-MM-DD>-<4-char-hex-slug>`, e.g. `2025-03-14-a3f9`; used as the session directory name)
- sourceMarkdownPath
- sourceSnapshotPath
- startedAt
- endedAt
- sttProvider
- analysisProvider
- microphoneSelection
- status (`active` | `paused` | `interrupted` | `finished`)
- latestTranscriptTail
- latestAnalysisAt
- proposedMarkdownPath

### 13.3 Transcript event
Suggested transcript event fields:

- timestamp
- text
- speakerHint (optional / likely single speaker)
- confidence if available
- chunkId if assigned

### 13.4 Analysis result (internal stored model)
This represents the parsed and stored form of an analysis provider response. See the companion schema for the wire format.

Suggested stored fields:

- chunkId
- topicDecisions[] (each: topicId, suggestedState, confidence, evidence, rationale)
- elaborationStarters[]
- adjacentTopics[]
- recoveryPrompts[]
- offTopicObservations[]
- warnings[]
- rawResponsePath (path to the logged raw response)

## 14. Suggested File / Folder Structure

```text
project/
  src/
    server/
      index.ts
      routes/
      services/
      providers/
        stt/
          whisperProvider.ts
          providerTypes.ts
        analysis/
          codexProvider.ts
          providerTypes.ts
      domain/
        topics/
        sessions/
        analysis/
      infra/
        logging/
        persistence/
    ui/
      templates/
      public/
  sessions/
    <session-id>/
      session.json
      transcript.events.jsonl
      transcript.chunks.jsonl
      analysis.requests.jsonl
      analysis.responses.jsonl
      topic-state.json
      proposed-final.md
  data/
    sample-topics.md
  scripts/
    install.sh
    dev.sh
    run.sh
```

## 15. Configuration

### 15.1 UI-editable settings
- markdown file path
- microphone device
- STT provider
- chunk sensitivity (Low / Medium / High)
- visible suggestion counts (per category; default: 3)
- session resume preference
- analysis auto-apply confidence threshold (displayed as a 0–100 slider; default: 80)

### 15.2 Advanced `.env` settings
- `ANALYSIS_PROVIDER_COMMAND` — the analysis provider CLI binary and base flags
- `ANALYSIS_STRUCTURED_OUTPUT_FLAG` — the flag enabling native structured output (requires research spike to confirm for codex-cli)
- `ANALYSIS_CONFIDENCE_THRESHOLD` — auto-apply threshold (0.0–1.0; default 0.8)
- `STT_EXECUTABLE` — path to the whisper.cpp binary
- `WHISPER_MODEL` — path or model name (recommended: `small.en`)
- `POLLING_INTERVAL_MS` — browser polling interval in ms (default: 2000)
- `LOGGING_FLAGS` — granularity of logging output
- `TRANSCRIPT_TAIL_SIZE` — number of transcript events to retain in the rolling tail
- `CHUNK_WORD_THRESHOLD` / `CHUNK_TIME_THRESHOLD_SECONDS` — raw overrides for chunk detection

## 16. MVP Scope

### 16.1 Must-have
- TypeScript Node app
- local browser UI with HTTP polling for live state
- Config page as initial view outside session
- microphone dropdown with level meter
- macOS microphone permission helper in `install.sh`
- persisted config with fallback handling
- session create / resume
- whisper.cpp streaming provider
- pluggable STT provider interface
- pluggable analysis provider interface
- codex-cli analysis provider (pending structured output research spike)
- transcript tail in UI
- automatic plus manual chunk analysis
- structured analysis with auto-apply above confidence threshold
- active topics
- elaboration starters
- adjacent next topics
- recovery prompts (analysis-generated)
- off-topic observations (display-only)
- topic states: pending / partial / covered / snoozed / dismissed
- parent topic auto-inference (partial on any child covered; covered at 50%+ children)
- one-click controls and undo
- proposed final markdown output (with Done / Dismissed sections)
- session end button + graceful shutdown handler
- logging
- graceful degradation when analysis provider fails

### 16.2 Nice-to-have
- replay mode
- stronger history UI
- richer confidence indicators
- smarter parent-topic partial visualization
- additional STT providers

### 16.3 Out of scope for V1
- desktop app packaging
- advanced always-on-top window control
- collaborative / multi-user support
- cloud sync
- live in-place editing of source markdown
- promoting off-topic observations to future topics

## 17. Success Criteria

Primary success criterion:

- the user feels topic rotation is noticeably better during real streams.

Secondary success criteria:

- fewer dead-air moments,
- easier post-stream cleanup,
- reliable resume after interruptions,
- trustworthy suggested markdown output,
- logs good enough to debug prompt / response quality.

## 18. Open Questions / Future Considerations

- whether off-topic observations should become promotable to candidate future topics (V2),
- whether replay mode should become a first-class debug feature,
- whether different stream modes (gaming vs. co-working / pomodoro) should tune prompt style and chunk sensitivity defaults,
- whether Parakeet materially improves latency or quality on the target M1 setup.

## 19. Implementation Notes

- Prefer strict TypeScript types for all structured analysis contracts.
- Prefer file-based persistence over a database for V1.
- Prefer conservative completion logic over clever but opaque automation.
- Prefer understandable microphone UX over optimized engineering purity.
- Keep the original markdown safe.
- The analysis provider structured output flag is an implementation prerequisite; do not stub the codex-cli provider without confirming the exact invocation contract.
- The STT and analysis provider interfaces should be designed in parallel; both follow the same pluggable subprocess pattern.
- Session ID format (`<YYYY-MM-DD>-<4-char-hex-slug>`) should be human-readable in the filesystem without needing a session index to decode.

## 20. Companion Specs

- [Codex Analysis Response Schema](docs/scoping/codex-analysis-response-schema.md) defines the exact V1 structured JSON wire format returned by the analysis provider.
