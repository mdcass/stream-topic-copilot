# Stream Topic Copilot — Product Requirements Document

## 1. Overview

Stream Topic Copilot is a small local utility for macOS that helps a solo streamer rotate through prepared talking points, avoid dead air, and keep a reliable record of what was discussed during a stream.

The product reads an opinionated markdown topics file, listens to the selected microphone using a local speech-to-text provider, analyzes semantically complete transcript chunks with Codex CLI, and presents a narrow browser-based control surface next to OBS.

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
The app must recover from pauses, technical problems, or restarts without losing the session’s semantic state.

### 6.5 Auditable AI behavior
Codex requests and structured responses must be logged for later inspection.

## 7. Technical Direction

### 7.1 Runtime
Node.js first, using TypeScript.

### 7.2 Frontend
A thin browser UI served locally.

### 7.3 Backend shape
A lightweight local Node app should:

- serve the UI,
- enumerate microphones,
- persist configuration,
- manage sessions,
- spawn STT provider processes,
- spawn Codex CLI,
- write logs and generated artifacts,
- expose live state to the browser.

### 7.4 STT
V1 default provider: Whisper.

STT must be implemented behind a pluggable provider interface so future providers such as Parakeet can be added without redesigning the app.

## 8. Target Platform

- macOS on Apple Silicon (initial target: M1 Mac)
- local execution only for the app itself
- Codex CLI may use cloud models

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
- set chunk-analysis behavior,
- resume an existing unfinished session.

### 9.4 Session start
When the user starts a session, the app should:

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
- allow “Analyze now” manually,
- update live suggestion cards from structured analysis,
- allow topic state actions with one click,
- support config access during the session in case the microphone changes.

### 9.6 Session interruption / resume
If the app or stream is paused, the user should be able to resume the unfinished session and recover:

- topic state,
- transcript tail,
- suggestion state where practical,
- pending proposed markdown output,
- logs.

### 9.7 Session end
At end of session, the app should generate:

- proposed final markdown file,
- structured session summary,
- transcript artifacts,
- Codex request/response logs,
- topic state history.

## 10. Functional Requirements

### 10.1 Markdown input and parsing
The app shall accept an opinionated markdown structure.

The parser shall support:

- section headings,
- checkboxes,
- parent bullets,
- sub-bullets,
- stable metadata IDs added by the tool.

Parent bullets should be treated as topic clusters.
Sub-bullets should be treated as more independent angles / beats.

The tool may add metadata comments or IDs to the source file format for stability.

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

- Whisper

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
- manual “Analyze now” override.

Time alone shall not be the only analysis trigger.

### 10.7 Codex analysis
When a chunk is ready, the app shall send structured context to Codex CLI.

The request should include at minimum:

- relevant unresolved topics,
- current topic states,
- latest transcript chunk,
- compact session context,
- explicit instructions to separate planned-topic evidence from off-topic speech.

The response shall be strict structured output.
The exact V1 response schema is defined in [docs/scoping/codex-analysis-response-schema.md](docs/scoping/codex-analysis-response-schema.md).

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
- Recovery prompts: generic but useful prompts for low-energy moments
- Off-topic observations: detected themes that should not automatically modify the markdown state

### 10.9 Topic state controls
The live UI shall allow one-click actions for at least:

- mark covered
- snooze
- dismiss
- undo last action

Note: partial may be inferred primarily by analysis in V1, but the data model must support it.

### 10.10 Proposed markdown output
The source markdown shall not be mutated live.

V1 output format shall be:

- a proposed final markdown file written beside session artifacts

This output should reflect the session’s proposed topic changes while preserving original structure as much as possible.

### 10.11 Session resume
The app shall support resuming an unfinished session after interruption.

Resume should restore all practical session state, including:

- topic states,
- transcript tail,
- transcript artifacts,
- logs,
- pending proposed output,
- recent suggestions where practical.

### 10.12 Logging and observability
The app shall log:

- Codex requests,
- Codex structured responses,
- transcript chunks,
- session metadata,
- topic state changes.

Replay mode is desirable and should be considered in the architecture, even if not fully surfaced in V1.

### 10.13 Graceful degradation
If Codex is unavailable or errors, the app shall:

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

1. Controls card
2. Active topics card
3. Elaboration starters card
4. Adjacent next topics card
5. Recovery prompts card
6. Transcript tail card
7. Undo / recent action area

### 11.5 Config view requirements
Config should include:

- markdown file path picker / input,
- microphone dropdown,
- refresh devices,
- level meter,
- STT provider selection,
- chunk-analysis settings,
- session resume options.

### 11.6 History view
History should provide a simple view into prior session actions and outputs.

It does not need to be feature-rich in V1.

## 12. Analysis Behavior Requirements

### 12.1 Avoiding semantic drift
The model should not be asked an open-ended question such as “what did the user talk about?”

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
- confidence,
- supporting transcript evidence or reference,
- rationale,
- suggestion categories.

## 13. Data Model

### 13.1 Topic entity
Suggested topic fields:

- id
- parentId
- section
- text
- type (`cluster` or `beat`)
- originalOrder
- currentState
- evidenceRefs
- lastUpdatedAt

### 13.2 Session entity
Suggested session fields:

- id
- sourceMarkdownPath
- sourceSnapshotPath
- startedAt
- endedAt
- sttProvider
- microphoneSelection
- status
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

### 13.4 Analysis result
Suggested analysis fields:

- chunkId
- coveredTopics[]
- partialTopics[]
- elaborationStarters[]
- adjacentTopics[]
- recoveryPrompts[]
- offTopicObservations[]
- warnings[]

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
      domain/
        topics/
        sessions/
        analysis/
      infra/
        codex/
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
      codex.requests.jsonl
      codex.responses.jsonl
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
- chunk sensitivity / thresholds
- visible suggestion counts
- session resume preference

### 15.2 Advanced `.env` settings
- Codex CLI command
- STT executable / model path
- logging flags
- polling / event intervals
- transcript tail size
- analysis thresholds

## 16. MVP Scope

### 16.1 Must-have
- TypeScript Node app
- local browser UI
- Config page as initial view outside session
- microphone dropdown with level meter
- persisted config with fallback handling
- session create / resume
- Whisper provider
- pluggable STT provider interface
- transcript tail in UI
- automatic plus manual chunk analysis
- Codex structured analysis
- active topics
- elaboration starters
- adjacent next topics
- recovery prompts
- off-topic observations
- topic states: pending / partial / covered / snoozed / dismissed
- one-click controls and undo
- proposed final markdown output
- logging
- graceful degradation when Codex fails

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

- how aggressive parent-topic completion should be when only one child beat was discussed,
- whether off-topic observations should become candidate future topics,
- whether replay mode should become a first-class debug feature,
- whether different stream modes should tune prompt style and chunking,
- whether Parakeet materially improves latency or quality on the target M1 setup.

## 19. Implementation Notes

- Prefer strict TypeScript types for all structured analysis contracts.
- Prefer file-based persistence over a database for V1.
- Prefer conservative completion logic over clever but opaque automation.
- Prefer understandable microphone UX over optimized engineering purity.
- Keep the original markdown safe.

## 20. Companion Specs

- [Codex Analysis Response Schema](docs/scoping/codex-analysis-response-schema.md) defines the exact V1 structured JSON contract returned by Codex.
