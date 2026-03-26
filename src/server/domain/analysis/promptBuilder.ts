import type { AppConfig, SessionSnapshot, TranscriptChunk } from "../types.js";

function compactTopic(topic: SessionSnapshot["topics"][string]): Record<string, string | null> {
  return {
    id: topic.id,
    parentId: topic.parentId,
    section: topic.section,
    text: topic.text,
    currentState: topic.currentState
  };
}

function compactTheme(theme: SessionSnapshot["revisitableThemes"][number]): Record<string, unknown> {
  return {
    id: theme.id,
    label: theme.label,
    summary: theme.summary,
    supportingMoments: theme.supportingMoments,
    interviewerQuestions: theme.interviewerQuestions,
    confidence: theme.confidence,
    status: theme.status,
    promptEligible: theme.promptEligible,
    pinned: Boolean(theme.pinnedAt),
    lastUpdatedAt: theme.lastUpdatedAt
  };
}

export function buildAnalysisPrompt(session: SessionSnapshot, chunk: TranscriptChunk, config: AppConfig): string {
  const unresolvedTopics = Object.values(session.topics)
    .filter((topic) => topic.currentState === "pending" || topic.currentState === "partial")
    .sort((left, right) => left.originalOrder - right.originalOrder)
    .map(compactTopic);

  const counts = {
    pending: 0,
    partial: 0,
    covered: 0,
    snoozed: 0,
    dismissed: 0
  };

  for (const topic of Object.values(session.topics)) {
    counts[topic.currentState] += 1;
  }

  const context = {
    sessionId: session.id,
    elapsedSeconds: Math.max(0, Math.round((Date.now() - Date.parse(session.startedAt)) / 1000)),
    countsByState: counts,
    analysisPassesCompleted: session.passCount,
    chunkSensitivity: config.chunkSensitivity,
    selectedSources: session.captureSources.map((source) => ({
      id: source.id,
      kind: source.kind,
      name: source.name
    }))
  };
  const recentChunks = session.chunks
    .filter((entry) => entry.id !== chunk.id)
    .slice(-3)
    .map((entry) => ({
      chunkId: entry.id,
      startedAt: entry.startedAt,
      endedAt: entry.endedAt,
      text: entry.text
    }));
  const promptContextThemes = session.revisitableThemes
    .filter((theme) => theme.promptEligible || theme.pinnedAt)
    .slice(0, 5)
    .map(compactTheme);

  return [
    "You are analyzing a transcript chunk for a local stream topic copilot.",
    "Return strict JSON only that conforms to the supplied output schema.",
    "Be conservative: only mark a prepared topic as covered when the transcript provides good evidence.",
    "Separate prepared-topic evidence from off-topic speech.",
    "",
    "Compact session context:",
    JSON.stringify(context, null, 2),
    "",
    "Rolling session summary:",
    JSON.stringify(session.sessionSummary, null, 2),
    "",
    "Revisitable themes eligible for revival:",
    JSON.stringify(promptContextThemes, null, 2),
    "",
    "Recent transcript context (background only; cite evidence from the current chunk):",
    JSON.stringify(recentChunks, null, 2),
    "",
    "Relevant unresolved topics:",
    JSON.stringify(unresolvedTopics, null, 2),
    "",
    "Transcript chunk:",
    JSON.stringify({
      chunkId: chunk.id,
      startedAt: chunk.startedAt,
      endedAt: chunk.endedAt,
      text: chunk.text
    }, null, 2),
    "",
    "Required behavior:",
    "- topicDecisions should include only changed topics.",
    "- suggestions must populate all categories, even when empty.",
    "- offTopicObservations are display-only and must not imply state changes.",
    "- revisitableThemes should upsert or merge durable off-topic themes worth resurfacing later in this session.",
    "- revisitableThemes.themeId should reference an existing theme when updating; use null to propose a new theme.",
    "- revisitableThemes.supportingMoments should stay concise and selective, not become a transcript dump.",
    "- revisitableThemes.interviewerQuestions should contain 0 to 2 concrete open-ended questions a streamer could answer to elaborate on that theme.",
    "- interviewerQuestions should feel like a good interviewer prompt, not a label rewrite or generic filler.",
    "- Every decision and suggestion needs evidence from this chunk.",
    "- Transcript lines may include source tags like [Mock Studio Mic] or [Discord]; use them to distinguish streamer vs system audio evidence."
  ].join("\n");
}

export function buildSessionRecapPrompt(session: SessionSnapshot, _config: AppConfig): string {
  const coveredTopics = Object.values(session.topics)
    .filter((topic) => topic.currentState === "covered")
    .sort((left, right) => left.originalOrder - right.originalOrder)
    .map((topic) => ({
      id: topic.id,
      text: topic.text,
      parentId: topic.parentId
    }));

  const revisitableThemes = session.revisitableThemes
    .filter((theme) => theme.status !== "dismissed")
    .map(compactTheme);

  const transcriptChunks = session.chunks.slice(-60).map((chunk) => ({
    chunkId: chunk.id,
    startedAt: chunk.startedAt,
    endedAt: chunk.endedAt,
    text: chunk.text
  }));

  return [
    "You are generating a concise end-of-session recap for a local stream topic copilot.",
    "Return strict JSON only that conforms to the supplied output schema.",
    "Synthesize the stream into useful human-facing recap bullets, not a transcript.",
    "",
    "Session metadata:",
    JSON.stringify({
      sessionId: session.id,
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      analysisPassesCompleted: session.passCount
    }, null, 2),
    "",
    "Working session summary:",
    JSON.stringify(session.sessionSummary, null, 2),
    "",
    "Covered prepared topics:",
    JSON.stringify(coveredTopics, null, 2),
    "",
    "Revisitable themes:",
    JSON.stringify(revisitableThemes, null, 2),
    "",
    "Transcript chunk sample:",
    JSON.stringify(transcriptChunks, null, 2),
    "",
    "Required behavior:",
    "- overview should stay high-level and concise.",
    "- preparedTopicsCovered should describe the prepared topics that were meaningfully covered.",
    "- otherThemesDiscussed should summarize organic themes outside the prepared plan.",
    "- poignantMoments should capture memorable beats, not exhaustive chronology.",
    "- futureFollowUps should suggest strong future discussion hooks."
  ].join("\n");
}
