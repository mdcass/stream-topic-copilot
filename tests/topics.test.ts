import { describe, expect, it } from "vitest";

import { parseTopicsMarkdown } from "../src/server/domain/topics/markdownParser.js";
import { buildProposedMarkdown } from "../src/server/domain/topics/proposedMarkdown.js";
import type { SessionSnapshot, TopicRecord } from "../src/server/domain/types.js";

function createSessionFromMarkdown(markdown: string): SessionSnapshot {
  const document = parseTopicsMarkdown(markdown);
  const topics: Record<string, TopicRecord> = Object.fromEntries(
    Object.values(document.topics).map((topic) => [
      topic.id,
      {
        ...topic,
        currentState: topic.checkbox ? "covered" : "pending",
        directState: null,
        stateSetBy: "inferred",
        confidenceAtLastChange: null,
        evidenceRefs: [],
        lastUpdatedAt: null
      }
    ])
  );

  return {
    id: "2026-03-14-abcd",
    sourceMarkdownPath: "/tmp/topics.md",
    sourceSnapshotPath: "/tmp/source-topics.md",
    sourceContentHash: "hash",
    startedAt: "2026-03-14T09:00:00.000Z",
    endedAt: null,
    sttProvider: "mock",
    analysisProvider: "mock",
    microphoneSelection: null,
    status: "active",
    latestTranscriptTail: [],
    visibleTranscriptEvents: [],
    latestAnalysisAt: null,
    proposedMarkdownPath: "/tmp/proposed-final.md",
    liveTranscriptPath: "/tmp/live-transcript.txt",
    recordedAudioPath: null,
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
    microphoneLevel: 0,
    lastError: null,
    resumeWarning: null
  };
}

describe("topic markdown parsing", () => {
  it("parses section headings, parent topics, and child beats", () => {
    const document = parseTopicsMarkdown(`# Stream Topics

## Priority
- [ ] New PC build <!-- id: tp_001 -->
  - Cooling issue <!-- id: tp_001_a -->
  - Cable routing regret
`);

    expect(document.sections).toHaveLength(1);
    expect(document.topics.tp_001.text).toBe("New PC build");
    expect(document.topics.tp_001.children).toHaveLength(2);
    expect(document.topics.tp_001_a.parentId).toBe("tp_001");
    expect(document.topicIds[2]).toMatch(/^tp_/);
  });
});

describe("proposed markdown generation", () => {
  it("moves covered and dismissed topics into appended sections", () => {
    const session = createSessionFromMarkdown(`# Stream Topics

## Priority
- [ ] New PC build <!-- id: tp_001 -->
  - Cooling issue <!-- id: tp_001_a -->

## Fallback
- [ ] Weird developer habits <!-- id: tp_002 -->
`);

    session.topics.tp_001.currentState = "covered";
    session.topics.tp_001.directState = "covered";
    session.topics.tp_002.currentState = "dismissed";
    session.topics.tp_002.directState = "dismissed";

    const output = buildProposedMarkdown(session);

    expect(output).toContain("## Done");
    expect(output).toContain("- [x] New PC build <!-- id: tp_001; covered: 2026-03-14-abcd -->");
    expect(output).toContain("## Dismissed");
    expect(output).toContain("- [ ] Weird developer habits <!-- id: tp_002; dismissed -->");
    expect(output).not.toContain("## Priority\n- [ ] New PC build");
  });
});
