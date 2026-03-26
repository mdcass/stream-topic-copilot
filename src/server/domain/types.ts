import type {
  AnalysisWarning,
  CodexAnalysisResponse,
  CodexSessionRecapResponse,
  OffTopicObservation,
  RevisitableThemeDelta,
  Suggestion,
  TopicDecision
} from "./analysis/schema.js";

export const topicStates = ["pending", "partial", "covered", "snoozed", "dismissed"] as const;
export type TopicState = typeof topicStates[number];

export type TopicKind = "cluster" | "beat";
export type TopicStateOrigin = "user" | "analysis" | "inferred";
export type SessionStatus = "active" | "paused" | "interrupted" | "finished";
export type ChunkSensitivity = "low" | "medium" | "high";
export type LivePromptKind = "active" | "elaboration" | "next" | "recovery" | "off-topic" | "theme";
export type MicrophonePermissionState = "granted" | "denied" | "not-determined" | "unknown" | "unavailable";
export type SystemAudioPermissionState = MicrophonePermissionState;
export type PermissionState = MicrophonePermissionState;
export type CaptureSourceKind = "microphone" | "system-mix" | "loopback-input" | "native-display-audio" | "native-app-audio";
export type CaptureSourceTransport = "input-device" | "screencapturekit" | "mock";
export type CaptureMonitorStatus = "idle" | "running" | "error" | "unsupported";
export type RevisitableThemeStatus = "active" | "dormant" | "dismissed";
export type RevisitableThemeManualState = "pinned" | "dismissed" | null;
export type SessionRecapStatus = "pending" | "ready" | "failed";

export type SuggestionBuckets = CodexAnalysisResponse["suggestions"];

export interface SelectedCaptureSourceConfig {
  id: string;
  kind: CaptureSourceKind;
  name: string;
}

export interface AppConfig {
  markdownFilePath: string;
  captureSources: SelectedCaptureSourceConfig[];
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
  microphoneProbeHelper: string;
  sdlAudioDevicesHelper: string;
  nativeSystemAudioHelper: string;
  enableNativeSystemAudioCapture: boolean;
  analysisSchemaPath: string;
}

export interface CaptureSourceDescriptor {
  id: string;
  name: string;
  kind: CaptureSourceKind;
  groupLabel: string;
  transport: CaptureSourceTransport;
  available?: boolean;
  availabilityReason?: string;
  manufacturer?: string;
  isDefault: boolean;
  inputDeviceId?: string;
  probeId?: string;
  nativeTargetId?: string;
  nativeDisplayId?: string;
  bundleId?: string;
  details?: string;
}

export interface CaptureSourceMonitorState {
  sourceId: string;
  sourceName: string;
  sourceKind: CaptureSourceKind;
  provider: string;
  level: number;
  status: CaptureMonitorStatus;
  lastUpdatedAt: string | null;
  error: string | null;
  whisperExecutable: string | null;
  whisperModel: string | null;
  whisperCaptureId: string | null;
  whisperLastError: string | null;
  deviceDiagnostics: string[];
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
  sourceId: string;
  sourceName: string;
  sourceKind: CaptureSourceKind;
  speakerHint?: string;
  confidence?: number;
  chunkId?: string;
  replaceLast?: boolean;
}

export interface DisplayTranscriptLine {
  key: string;
  timestamp: string;
  text: string;
  sourceId: string;
  sourceName: string;
  sourceKind: CaptureSourceKind;
  muted: boolean;
}

export interface DisplayTranscriptState {
  committedLines: DisplayTranscriptLine[];
  activeLine: DisplayTranscriptLine | null;
  activeGroupTimestamp: string | null;
  activeSourceId: string | null;
  lastSpeechAt: string | null;
  revision: number;
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

export interface LivePromptRecord {
  id: string;
  kind: LivePromptKind;
  text: string;
  confidence: number;
  rationale: string;
  topicId: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  lastChunkId: string;
  dismissedAt: string | null;
}

export interface SessionSummary {
  updatedAt: string | null;
  bullets: string[];
}

export interface RevisitableThemeRecord {
  id: string;
  label: string;
  summary: string;
  supportingMoments: string[];
  confidence: number;
  rationale: string;
  sourceChunkIds: string[];
  firstSeenAt: string;
  lastUpdatedAt: string;
  lastReinforcedAt: string;
  lastReinforcedPass: number;
  modelPromptEligible: boolean;
  promptEligible: boolean;
  status: RevisitableThemeStatus;
  pinnedAt: string | null;
  dismissedAt: string | null;
  manualState: RevisitableThemeManualState;
}

export interface SessionRecap {
  status: SessionRecapStatus;
  generatedAt: string | null;
  markdownPath: string | null;
  jsonPath: string | null;
  overview: string[];
  preparedTopicsCovered: string[];
  otherThemesDiscussed: string[];
  poignantMoments: string[];
  futureFollowUps: string[];
  error: string | null;
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
  captureSources: SelectedCaptureSourceConfig[];
  status: SessionStatus;
  latestTranscriptTail: TranscriptEvent[];
  visibleTranscriptEvents: TranscriptEvent[];
  displayTranscript: DisplayTranscriptState;
  latestAnalysisAt: string | null;
  proposedMarkdownPath: string;
  liveTranscriptPath: string | null;
  recordedAudioPath: string | null;
  recordedAudioPaths: Record<string, string[]>;
  approximateTranscriptSrtPath: string | null;
  finalTranscriptSrtPath: string | null;
  chunkSensitivity: ChunkSensitivity;
  document: ParsedTopicsDocument;
  topics: Record<string, TopicRecord>;
  chunks: TranscriptChunk[];
  pendingTranscriptEvents: TranscriptEvent[];
  analyses: StoredAnalysisResult[];
  suggestions: SuggestionBuckets;
  livePrompts: LivePromptRecord[];
  offTopicObservations: OffTopicObservation[];
  sessionSummary: SessionSummary;
  revisitableThemes: RevisitableThemeRecord[];
  sessionRecap: SessionRecap;
  warnings: AnalysisWarning[];
  pendingDecisions: TopicDecision[];
  actionHistory: TopicStateChange[];
  passCount: number;
  sourceMonitors: Record<string, CaptureSourceMonitorState>;
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
  recapMarkdownPath: string | null;
  recapOverview: string[];
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
    defaultProviders: {
      stt: string;
      analysis: string;
    };
    availableProviders: {
      stt: string[];
      analysis: string[];
    };
  };
  capturePermissions: {
    microphone: MicrophonePermissionState;
    systemAudio: SystemAudioPermissionState;
  };
  captureSourceCatalog: CaptureSourceDescriptor[];
  sourceMonitors: Record<string, CaptureSourceMonitorState>;
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

export interface SessionRecapRunInput {
  session: SessionSnapshot;
  config: AppConfig;
}

export interface SessionRecapProviderResult {
  response: CodexSessionRecapResponse;
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

export function createEmptySessionSummary(): SessionSummary {
  return {
    updatedAt: null,
    bullets: []
  };
}

export function createEmptySessionRecap(): SessionRecap {
  return {
    status: "pending",
    generatedAt: null,
    markdownPath: null,
    jsonPath: null,
    overview: [],
    preparedTopicsCovered: [],
    otherThemesDiscussed: [],
    poignantMoments: [],
    futureFollowUps: [],
    error: null
  };
}

export function createDefaultAppConfig(markdownFilePath: string, runtime: RuntimeConfig): AppConfig {
  return {
    markdownFilePath,
    captureSources: [],
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
