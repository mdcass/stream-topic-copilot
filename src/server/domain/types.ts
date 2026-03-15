import type {
  AnalysisWarning,
  CodexAnalysisResponse,
  OffTopicObservation,
  Suggestion,
  TopicDecision
} from "./analysis/schema.js";

export const topicStates = ["pending", "partial", "covered", "snoozed", "dismissed"] as const;
export type TopicState = typeof topicStates[number];

export type TopicKind = "cluster" | "beat";
export type TopicStateOrigin = "user" | "analysis" | "inferred";
export type SessionStatus = "active" | "paused" | "interrupted" | "finished";
export type ChunkSensitivity = "low" | "medium" | "high";
export type MicrophonePermissionState = "granted" | "denied" | "not-determined" | "unknown" | "unavailable";

export type SuggestionBuckets = CodexAnalysisResponse["suggestions"];

export interface AppConfig {
  markdownFilePath: string;
  microphoneId: string | null;
  sttProvider: string;
  analysisProvider: string;
  chunkSensitivity: ChunkSensitivity;
  visibleSuggestionCounts: {
    activeTopics: number;
    elaborationStarters: number;
    adjacentNextTopics: number;
    recoveryPrompts: number;
    offTopicObservations: number;
  };
  sessionResumePreference: "latest" | "manual";
  analysisAutoApplyThreshold: number;
  pollingIntervalMs: number;
  transcriptTailSize: number;
}

export interface RuntimeConfig {
  rootDir: string;
  host: string;
  port: number;
  dataDir: string;
  sessionsDir: string;
  publicDir: string;
  configPath: string;
  analysisProvider: string;
  sttProvider: string;
  analysisProviderCommand: string;
  analysisStructuredOutputFlag: string;
  analysisConfidenceThreshold: number;
  sttExecutable: string;
  whisperModel: string;
  pollingIntervalMs: number;
  loggingFlags: string[];
  transcriptTailSize: number;
  chunkWordThreshold: number | null;
  chunkTimeThresholdSeconds: number | null;
  defaultChunkSensitivity: ChunkSensitivity;
  visibleSuggestionCount: number;
  microphonePermissionHelper: string;
  analysisSchemaPath: string;
}

export interface MicrophoneDevice {
  id: string;
  name: string;
  manufacturer?: string;
  transport?: string;
  isDefault: boolean;
}

export interface ParsedTopic {
  id: string;
  parentId: string | null;
  section: string;
  text: string;
  kind: TopicKind;
  checkbox: boolean;
  metadataComment?: string;
  children: string[];
  originalOrder: number;
}

export interface SectionBlockRaw {
  kind: "raw";
  line: string;
}

export interface SectionBlockTopic {
  kind: "topic";
  topicId: string;
}

export type SectionBlock = SectionBlockRaw | SectionBlockTopic;

export interface ParsedSection {
  heading: string;
  blocks: SectionBlock[];
}

export interface ParsedTopicsDocument {
  leadingLines: string[];
  sections: ParsedSection[];
  topics: Record<string, ParsedTopic>;
  topicIds: string[];
}

export interface TopicRecord extends ParsedTopic {
  currentState: TopicState;
  directState: TopicState | null;
  stateSetBy: TopicStateOrigin;
  confidenceAtLastChange: number | null;
  evidenceRefs: string[];
  lastUpdatedAt: string | null;
}

export interface TranscriptEvent {
  id: string;
  timestamp: string;
  text: string;
  speakerHint?: string;
  confidence?: number;
  chunkId?: string;
}

export interface TranscriptChunk {
  id: string;
  startedAt: string;
  endedAt: string;
  text: string;
  wordCount: number;
  eventIds: string[];
}

export interface TopicStateChange {
  topicId: string;
  previousState: TopicState;
  nextState: TopicState;
  origin: TopicStateOrigin;
  confidence: number | null;
  rationale?: string;
  occurredAt: string;
}

export interface StoredAnalysisResult {
  chunkId: string;
  latencyMs: number;
  response: CodexAnalysisResponse;
  appliedDecisions: TopicDecision[];
  proposedDecisions: TopicDecision[];
  recordedAt: string;
  rawResponsePath: string;
}

export interface SessionSnapshot {
  id: string;
  sourceMarkdownPath: string;
  sourceSnapshotPath: string;
  sourceContentHash: string;
  startedAt: string;
  endedAt: string | null;
  sttProvider: string;
  analysisProvider: string;
  microphoneSelection: string | null;
  status: SessionStatus;
  latestTranscriptTail: TranscriptEvent[];
  latestAnalysisAt: string | null;
  proposedMarkdownPath: string;
  chunkSensitivity: ChunkSensitivity;
  document: ParsedTopicsDocument;
  topics: Record<string, TopicRecord>;
  chunks: TranscriptChunk[];
  pendingTranscriptEvents: TranscriptEvent[];
  analyses: StoredAnalysisResult[];
  suggestions: SuggestionBuckets;
  offTopicObservations: OffTopicObservation[];
  warnings: AnalysisWarning[];
  pendingDecisions: TopicDecision[];
  actionHistory: TopicStateChange[];
  passCount: number;
  microphoneLevel: number;
  lastError: string | null;
  resumeWarning: string | null;
}

export interface HistoryEntry {
  id: string;
  startedAt: string;
  endedAt: string | null;
  durationSeconds: number;
  status: SessionStatus;
  countsByState: Record<TopicState, number>;
  proposedMarkdownPath: string;
}

export interface AnalysisRunInput {
  chunk: TranscriptChunk;
  session: SessionSnapshot;
  config: AppConfig;
}

export interface AppStateResponse {
  config: AppConfig;
  runtime: {
    pollingIntervalMs: number;
    activeSessionId: string | null;
    availableProviders: {
      stt: string[];
      analysis: string[];
    };
  };
  microphonePermission: MicrophonePermissionState;
  microphones: MicrophoneDevice[];
  resumableSessions: HistoryEntry[];
  history: HistoryEntry[];
  activeSession: SessionSnapshot | null;
}

export interface TopicDecisionApplication {
  applied: TopicDecision[];
  proposed: TopicDecision[];
}

export interface AnalysisProviderResult {
  response: CodexAnalysisResponse;
  rawResponse: string;
  latencyMs: number;
}

export interface StateCountSummary {
  pending: number;
  partial: number;
  covered: number;
  snoozed: number;
  dismissed: number;
}

export function createEmptySuggestions(): SuggestionBuckets {
  return {
    activeTopics: [],
    elaborationStarters: [],
    adjacentNextTopics: [],
    recoveryPrompts: []
  };
}

export function createDefaultAppConfig(markdownFilePath: string, runtime: RuntimeConfig): AppConfig {
  return {
    markdownFilePath,
    microphoneId: null,
    sttProvider: runtime.sttProvider,
    analysisProvider: runtime.analysisProvider,
    chunkSensitivity: runtime.defaultChunkSensitivity,
    visibleSuggestionCounts: {
      activeTopics: runtime.visibleSuggestionCount,
      elaborationStarters: runtime.visibleSuggestionCount,
      adjacentNextTopics: runtime.visibleSuggestionCount,
      recoveryPrompts: runtime.visibleSuggestionCount,
      offTopicObservations: runtime.visibleSuggestionCount
    },
    sessionResumePreference: "manual",
    analysisAutoApplyThreshold: runtime.analysisConfidenceThreshold,
    pollingIntervalMs: runtime.pollingIntervalMs,
    transcriptTailSize: runtime.transcriptTailSize
  };
}
