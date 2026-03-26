import { describe, expect, it } from "vitest";

import { buildAnalysisPrompt } from "../src/server/domain/analysis/promptBuilder.js";
import { createEmptyDisplayTranscript } from "../src/server/domain/transcript/display.js";
import { parseTopicsMarkdown } from "../src/server/domain/topics/markdownParser.js";
import {
  createEmptySessionRecap,
  createEmptySessionSummary,
  type AppConfig,
  type SessionSnapshot,
  type TopicRecord,
  type TranscriptChunk
} from "../src/server/domain/types.js";

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
    livePrompts: [],
    offTopicObservations: [],
    sessionSummary: createEmptySessionSummary(),
    revisitableThemes: [],
    sessionRecap: createEmptySessionRecap(),
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

  it("includes recent chunk context separately from the current chunk", () => {
    const session = createSession();
    session.chunks.push({
      id: "chunk_000",
      startedAt: "2026-03-14T09:00:00.000Z",
      endedAt: "2026-03-14T09:00:01.000Z",
      text: "[Streamer Mic] Quick recap of the last stream.",
      wordCount: 8,
      eventIds: ["evt_0"]
    });
    const chunk: TranscriptChunk = {
      id: "chunk_001",
      startedAt: "2026-03-14T09:00:02.000Z",
      endedAt: "2026-03-14T09:00:10.000Z",
      text: "[Streamer Mic] I finally started the new PC build.",
      wordCount: 10,
      eventIds: ["evt_1"]
    };
    session.chunks.push(chunk);
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

    expect(prompt).toContain("Recent transcript context");
    expect(prompt).toContain("Quick recap of the last stream.");
    expect(prompt).toContain("\"chunkId\": \"chunk_000\"");
  });

  it("includes rolling summary and revisitable theme context", () => {
    const session = createSession();
    session.sessionSummary = {
      updatedAt: "2026-03-14T09:00:10.000Z",
      bullets: ["Prepared topics: 0 covered, 1 partial, 0 pending."]
    };
    session.revisitableThemes.push({
      id: "mem_001",
      label: "Build frustration",
      summary: "The streamer kept circling back to cooling frustration outside the formal plan.",
      supportingMoments: ["Cooling regret kept interrupting the story."],
      interviewerQuestions: ["What made that cooling frustration stick with you after the moment passed?"],
      confidence: 0.84,
      rationale: "This theme may be worth revisiting later.",
      sourceChunkIds: ["chunk_000"],
      firstSeenAt: "2026-03-14T09:00:05.000Z",
      lastUpdatedAt: "2026-03-14T09:00:10.000Z",
      lastReinforcedAt: "2026-03-14T09:00:10.000Z",
      lastReinforcedPass: 1,
      modelPromptEligible: true,
      promptEligible: true,
      status: "active",
      pinnedAt: null,
      dismissedAt: null,
      manualState: null
    });

    const chunk: TranscriptChunk = {
      id: "chunk_001",
      startedAt: "2026-03-14T09:00:11.000Z",
      endedAt: "2026-03-14T09:00:16.000Z",
      text: "[Streamer Mic] I should probably come back to that cooling frustration later.",
      wordCount: 12,
      eventIds: ["evt_1"]
    };

    const prompt = buildAnalysisPrompt(session, chunk, {
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
    });

    expect(prompt).toContain("Rolling session summary");
    expect(prompt).toContain("Build frustration");
    expect(prompt).toContain("Revisitable themes eligible for revival");
    expect(prompt).toContain("interviewerQuestions");
  });
});
