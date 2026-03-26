import type { AnalysisProvider } from "./providerTypes.js";
import type { CodexAnalysisResponse, CodexSessionRecapResponse } from "../../domain/analysis/schema.js";
import type {
  AnalysisProviderResult,
  AnalysisRunInput,
  SessionRecapProviderResult,
  SessionRecapRunInput
} from "../../domain/types.js";

function buildMockResponse(input: AnalysisRunInput): CodexAnalysisResponse {
  const unresolvedTopics = Object.values(input.session.topics)
    .filter((topic) => topic.currentState === "pending" || topic.currentState === "partial")
    .sort((left, right) => left.originalOrder - right.originalOrder);
  const leadTopic = unresolvedTopics[0];
  const excerpt = input.chunk.text.slice(0, 180);

  return {
    schemaVersion: "codexAnalysis.v1",
    chunkId: input.chunk.id,
    topicDecisions: leadTopic ? [{
      topicId: leadTopic.id,
      suggestedState: excerpt.split(/\s+/).length > 20 ? "partial" : "pending",
      confidence: 0.83,
      rationale: "The mock provider uses the first unresolved topic as a conservative placeholder.",
      evidence: [{ chunkId: input.chunk.id, excerpt }]
    }] : [],
    suggestions: {
      activeTopics: leadTopic ? [{
        text: `Stay on ${leadTopic.text} and add one concrete example.`,
        confidence: 0.79,
        rationale: "The mock provider keeps the streamer on the strongest unresolved topic.",
        evidence: [{ chunkId: input.chunk.id, excerpt }],
        topicId: leadTopic.id
      }] : [],
      elaborationStarters: [{
        text: "What detail from that story would make the next minute more specific?",
        confidence: 0.74,
        rationale: "The chunk already has momentum; a follow-up prompt helps sustain it.",
        evidence: [{ chunkId: input.chunk.id, excerpt }],
        topicId: leadTopic?.id ?? null
      }],
      adjacentNextTopics: unresolvedTopics[1] ? [{
        text: `Segue to ${unresolvedTopics[1].text} when the current thought winds down.`,
        confidence: 0.7,
        rationale: "The next unresolved topic is a safe next transition.",
        evidence: [{ chunkId: input.chunk.id, excerpt }],
        topicId: unresolvedTopics[1].id
      }] : [],
      recoveryPrompts: [{
        text: "If energy drops, recap one thing you learned from the last topic.",
        confidence: 0.66,
        rationale: "Recovery prompts should help the streamer re-enter the topic plan.",
        evidence: [{ chunkId: input.chunk.id, excerpt }],
        topicId: null
      }]
    },
    offTopicObservations: excerpt ? [{
      label: "General stream banter",
      confidence: 0.52,
      rationale: "The chunk contains conversational filler that may not map directly to a prepared topic.",
      evidence: [{ chunkId: input.chunk.id, excerpt }]
    }] : [],
    revisitableThemes: excerpt ? {
      upserts: [{
        themeId: null,
        label: "General stream banter",
        summary: "The session drifted into broader chatter outside the prepared topic plan.",
        supportingMoments: [excerpt],
        confidence: 0.56,
        rationale: "A lightweight revisitable theme helps the app remember non-topic discussion.",
        evidence: [{ chunkId: input.chunk.id, excerpt }],
        promptEligible: excerpt.split(/\s+/).length > 16
      }],
      merges: []
    } : {
      upserts: [],
      merges: []
    },
    warnings: []
  };
}

function buildMockRecap(input: SessionRecapRunInput): CodexSessionRecapResponse {
  const coveredTopics = Object.values(input.session.topics)
    .filter((topic) => topic.currentState === "covered")
    .map((topic) => topic.text);
  const revisitableThemes = input.session.revisitableThemes
    .filter((theme) => theme.status !== "dismissed")
    .map((theme) => theme.label);

  return {
    schemaVersion: "codexSessionRecap.v1",
    overview: [
      `The session covered ${coveredTopics.length} prepared topic${coveredTopics.length === 1 ? "" : "s"} and kept a few broader conversational threads in play.`
    ],
    preparedTopicsCovered: coveredTopics.slice(0, 8),
    otherThemesDiscussed: revisitableThemes.slice(0, 8),
    poignantMoments: input.session.revisitableThemes
      .flatMap((theme) => theme.supportingMoments.slice(0, 1))
      .slice(0, 5),
    futureFollowUps: revisitableThemes.slice(0, 4).map((theme) => `Revisit ${theme} with a fresh concrete example.`)
  };
}

export class MockAnalysisProvider implements AnalysisProvider {
  readonly name = "mock";

  async analyze(input: AnalysisRunInput): Promise<AnalysisProviderResult> {
    const response = buildMockResponse(input);
    return {
      response,
      rawResponse: JSON.stringify(response, null, 2),
      latencyMs: 10
    };
  }

  async generateSessionRecap(input: SessionRecapRunInput): Promise<SessionRecapProviderResult> {
    const response = buildMockRecap(input);
    return {
      response,
      rawResponse: JSON.stringify(response, null, 2),
      latencyMs: 10
    };
  }
}
