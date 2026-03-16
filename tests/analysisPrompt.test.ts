import { describe, expect, it } from "vitest";

import { buildAnalysisPrompt } from "../src/server/domain/analysis/promptBuilder.js";
import { createEmptyDisplayTranscript } from "../src/server/domain/transcript/display.js";
import { parseTopicsMarkdown } from "../src/server/domain/topics/markdownParser.js";
import type { AppConfig, SessionSnapshot, TopicRecord, TranscriptChunk } from "../src/server/domain/types.js";

function createSession(): SessionSnapshot {
  const document = parseTopicsMarkdown(`# Stream Topics

## Priority
- [ ] New PC build <!-- id: tp_001 -->
`);
  const topics: Record<string, TopicRecord> = Object.fromEntries(
    Object.values(document.topics).map((topic) => [topic.id, {
      ...topic,
      currentState: "pending",
      directState: null,
      stateSetBy: "inferred",
      confidenceAtLastChange: null,
      evidenceRefs: [],
      lastUpdatedAt: null
    }])
  );

  return {
    id: "session_1",
    sourceMarkdownPath: "/tmp/topics.md",
    sourceSnapshotPath: "/tmp/source-topics.md",
    sourceContentHash: "hash",
    startedAt: "2026-03-14T09:00:00.000Z",
    endedAt: null,
    sttProvider: "mock",
    analysisProvider: "mock",
    captureSources: [
      { id: "src_mic", kind: "microphone", name: "Streamer Mic" },
      { id: "src_app", kind: "native-app-audio", name: "Discord" }
    ],
    status: "active",
    latestTranscriptTail: [],
    visibleTranscriptEvents: [],
    displayTranscript: createEmptyDisplayTranscript(),
    latestAnalysisAt: null,
    proposedMarkdownPath: "/tmp/proposed-final.md",
    liveTranscriptPath: "/tmp/live-transcript.txt",
    recordedAudioPath: null,
    recordedAudioPaths: {},
    approximateTranscriptSrtPath: "/tmp/transcript.approx.srt",
    finalTranscriptSrtPath: null,
    chunkSensitivity: "medium",
    document,
    topics,
    chunks: [],
    pendingTranscriptEvents: [],
    analyses: [],
    suggestions: {
      activeTopics: [],
      elaborationStarters: [],
      adjacentNextTopics: [],
      recoveryPrompts: []
    },
    offTopicObservations: [],
    warnings: [],
    pendingDecisions: [],
    actionHistory: [],
    passCount: 0,
    sourceMonitors: {},
    lastError: null,
    resumeWarning: null
  };
}

describe("analysis prompt builder", () => {
  it("includes selected sources and source-tagged chunk text", () => {
    const session = createSession();
    const chunk: TranscriptChunk = {
      id: "chunk_001",
      startedAt: "2026-03-14T09:00:02.000Z",
      endedAt: "2026-03-14T09:00:10.000Z",
      text: "[Streamer Mic] I finally started the new PC build.\n[Discord] party chat reacted to the cooling issue.",
      wordCount: 18,
      eventIds: ["evt_1", "evt_2"]
    };
    const config: AppConfig = {
      markdownFilePath: "/tmp/topics.md",
      captureSources: session.captureSources,
      sttProvider: "mock",
      analysisProvider: "mock",
      chunkSensitivity: "medium",
      visibleSuggestionCounts: {
        activeTopics: 3,
        elaborationStarters: 3,
        adjacentNextTopics: 3,
        recoveryPrompts: 3,
        offTopicObservations: 3
      },
      sessionResumePreference: "manual",
      analysisAutoApplyThreshold: 0.8,
      pollingIntervalMs: 2000,
      transcriptTailSize: 30
    };

    const prompt = buildAnalysisPrompt(session, chunk, config);

    expect(prompt).toContain("\"selectedSources\"");
    expect(prompt).toContain("Streamer Mic");
    expect(prompt).toContain("Discord");
    expect(prompt).toContain("[Streamer Mic] I finally started the new PC build.");
  });
});
