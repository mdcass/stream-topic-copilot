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
    chunkSensitivity: config.chunkSensitivity
  };

  return [
    "You are analyzing a transcript chunk for a local stream topic copilot.",
    "Return strict JSON only that conforms to the supplied output schema.",
    "Be conservative: only mark a prepared topic as covered when the transcript provides good evidence.",
    "Separate prepared-topic evidence from off-topic speech.",
    "",
    "Compact session context:",
    JSON.stringify(context, null, 2),
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
    "- Every decision and suggestion needs evidence from this chunk."
  ].join("\n");
}
