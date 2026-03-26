import crypto from "node:crypto";
import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { codexAnalysisResponseSchema, type RevisitableThemeDelta } from "./domain/analysis/schema.js";
import { buildAnalysisPrompt } from "./domain/analysis/promptBuilder.js";
import { applyTranscriptDisplayEvent, createEmptyDisplayTranscript } from "./domain/transcript/display.js";
import { buildApproximateSrt } from "./domain/transcript/subtitles.js";
import {
  createDefaultAppConfig,
  createEmptySuggestions,
  createEmptySessionRecap,
  createEmptySessionSummary,
  type AppConfig,
  type AppStateResponse,
  type CaptureSourceDescriptor,
  type CaptureSourceMonitorState,
  type ChunkSensitivity,
  type SessionRecap,
  type RuntimeConfig,
  type RevisitableThemeRecord,
  type SelectedCaptureSourceConfig,
  type SessionSnapshot,
  type LivePromptKind,
  type LivePromptRecord,
  type TopicRecord,
  type TopicState,
  type TopicStateChange,
  type TranscriptChunk,
  type TranscriptEvent
} from "./domain/types.js";
import type { CodexAnalysisResponse, OffTopicObservation, Suggestion, TopicDecision } from "./domain/analysis/schema.js";
import { parseTopicsMarkdown } from "./domain/topics/markdownParser.js";
import { buildProposedMarkdown } from "./domain/topics/proposedMarkdown.js";
import { FileStore } from "./infra/fileStore.js";
import { analyzeWaveSignal } from "./infra/audioSignal.js";
import { findRecommendedSystemMixSource } from "./infra/inputSourceCatalog.js";
import { getMicrophonePermissionState, requestMicrophonePermission } from "./infra/microphonePermission.js";
import { MicrophoneProbe } from "./infra/microphoneProbe.js";
import { NativeSystemAudioHelper, type NativeCaptureSession } from "./infra/nativeSystemAudioHelper.js";
import { getSystemAudioPermissionState, requestSystemAudioPermission } from "./infra/systemAudioPermission.js";
import type { AnalysisProvider } from "./providers/analysis/providerTypes.js";
import type { SttProvider, SttProviderSession } from "./providers/stt/providerTypes.js";

const sensitivityDefaults: Record<ChunkSensitivity, { words: number; seconds: number; }> = {
  low: { words: 200, seconds: 120 },
  medium: { words: 120, seconds: 60 },
  high: { words: 50, seconds: 30 }
};

const sentenceCompletionWordThresholds: Record<ChunkSensitivity, number> = {
  low: 120,
  medium: 45,
  high: 20
};

const execFileAsync = promisify(execFile);
const NATIVE_SYSTEM_AUDIO_UNAVAILABLE_REASON = "Native display/app audio is disabled until a signed helper identity is available.";
const MAX_SESSION_SUMMARY_BULLETS = 6;
const MAX_REVISITABLE_THEMES = 8;
const MAX_THEME_MOMENTS = 3;
const THEME_DORMANT_AFTER_PASSES = 6;
const THEME_DORMANT_AFTER_MS = 45 * 60 * 1000;

function nowIso(): string {
  return new Date().toISOString();
}

function wordCount(value: string): number {
  return value.trim().split(/\s+/).filter(Boolean).length;
}

function normalizeTranscriptForSignal(value: string): string {
  return value
    .replace(/^\[[^\]]+\]\s*/gm, "")
    .replace(/\[BLANK_AUDIO\]/gi, " ")
    .replace(/\[Start speaking\]/gi, " ")
    .replace(/\(I'm not sure what he said\)/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function meaningfulWordCount(value: string): number {
  return normalizeTranscriptForSignal(value).split(/\s+/).filter(Boolean).length;
}

function isLowSignalTranscript(value: string): boolean {
  return meaningfulWordCount(value) < 5;
}

function createSessionId(startedAt: string): string {
  const date = startedAt.slice(0, 10);
  const time = startedAt.slice(11, 16).replace(":", "");
  const slug = Math.floor(Math.random() * 0xffff).toString(16).padStart(4, "0");
  return `${date}-${time}-${slug}`;
}

function createThemeId(session: SessionSnapshot): string {
  let index = session.revisitableThemes.length + 1;
  let candidate = `mem_${String(index).padStart(3, "0")}`;
  while (session.revisitableThemes.some((theme) => theme.id === candidate)) {
    index += 1;
    candidate = `mem_${String(index).padStart(3, "0")}`;
  }
  return candidate;
}

function createChunkId(session: SessionSnapshot): string {
  return `chunk_${session.startedAt.slice(0, 10).replace(/-/g, "_")}_${String(session.chunks.length + 1).padStart(3, "0")}`;
}

function createTopicRecord(topic: SessionSnapshot["document"]["topics"][string]): TopicRecord {
  const defaultState: TopicState = topic.checkbox ? "covered" : "pending";
  return {
    ...topic,
    currentState: defaultState,
    directState: topic.checkbox ? "covered" : null,
    stateSetBy: topic.checkbox ? "user" : "inferred",
    confidenceAtLastChange: topic.checkbox ? 1 : null,
    evidenceRefs: [],
    lastUpdatedAt: null
  };
}

function summarizeCounts(topics: Record<string, TopicRecord>): Record<TopicState, number> {
  const counts: Record<TopicState, number> = {
    pending: 0,
    partial: 0,
    covered: 0,
    snoozed: 0,
    dismissed: 0
  };

  for (const topic of Object.values(topics)) {
    counts[topic.currentState] += 1;
  }

  return counts;
}

function cloneSession(session: SessionSnapshot): SessionSnapshot {
  return JSON.parse(JSON.stringify(session)) as SessionSnapshot;
}

function cloneMonitor(monitor: CaptureSourceMonitorState): CaptureSourceMonitorState {
  return JSON.parse(JSON.stringify(monitor)) as CaptureSourceMonitorState;
}

function normalizeCaptureSources(value: unknown): SelectedCaptureSourceConfig[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
    .map((entry): SelectedCaptureSourceConfig => {
      let kind: SelectedCaptureSourceConfig["kind"] = "microphone";
      if (entry.kind === "loopback-input") {
        kind = "system-mix";
      }
      if (
        entry.kind === "microphone" ||
        entry.kind === "system-mix" ||
        entry.kind === "native-display-audio" ||
        entry.kind === "native-app-audio"
      ) {
        kind = entry.kind;
      }

      return {
        id: typeof entry.id === "string" ? entry.id : "",
        kind,
        name: typeof entry.name === "string" ? entry.name : "Unknown source"
      };
    })
    .filter((entry) => entry.id.length > 0);
}

function selectedSourceFromDescriptor(source: CaptureSourceDescriptor): SelectedCaptureSourceConfig {
  return {
    id: source.id,
    kind: source.kind,
    name: source.name
  };
}

function createSourceMonitor(provider: string, source: SelectedCaptureSourceConfig | CaptureSourceDescriptor): CaptureSourceMonitorState {
  return {
    sourceId: source.id,
    sourceName: source.name,
    sourceKind: source.kind,
    provider,
    level: 0,
    status: "idle",
    lastUpdatedAt: null,
    error: null,
    whisperExecutable: null,
    whisperModel: null,
    whisperCaptureId: null,
    whisperLastError: null,
    deviceDiagnostics: []
  };
}

function createChunkText(events: TranscriptEvent[]): string {
  const segments: Array<Pick<TranscriptEvent, "sourceId" | "sourceName"> & { text: string; }> = [];

  for (const event of events) {
    const text = normalizeChunkEventText(event.text);
    if (!text) {
      continue;
    }

    const existingIndex = event.replaceLast
      ? findPendingSegmentIndex(segments, event.sourceId)
      : -1;
    if (existingIndex >= 0) {
      segments[existingIndex] = {
        ...segments[existingIndex],
        text: mergeTranscriptText(segments[existingIndex].text, text)
      };
      continue;
    }

    segments.push({
      sourceId: event.sourceId,
      sourceName: event.sourceName,
      text
    });
  }

  return segments
    .map((event) => `[${event.sourceName}] ${event.text}`)
    .join("\n")
    .trim();
}

function findPendingSegmentIndex(
  segments: Array<Pick<TranscriptEvent, "sourceId" | "sourceName"> & { text: string; }>,
  sourceId: string
): number {
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    if (segments[index].sourceId === sourceId) {
      return index;
    }
  }

  return -1;
}

function normalizeChunkEventText(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "";
  }

  if ((/^\[[^\]]+\]$/).test(normalized) || (/^\([^)]+\)$/).test(normalized)) {
    return "";
  }

  return normalized;
}

function findOverlapLength(previous: string, next: string): number {
  const previousLower = previous.toLowerCase();
  const nextLower = next.toLowerCase();
  const limit = Math.min(previousLower.length, nextLower.length);

  for (let length = limit; length >= 1; length -= 1) {
    if (previousLower.slice(-length) === nextLower.slice(0, length)) {
      return length;
    }
  }

  return 0;
}

function mergeTranscriptText(previous: string, next: string): string {
  if (!previous) {
    return next;
  }
  if (!next) {
    return previous;
  }

  if (previous === next || previous.endsWith(next)) {
    return previous;
  }
  if (next.startsWith(previous) || next.includes(previous)) {
    return next;
  }

  const overlap = findOverlapLength(previous, next);
  const minimumUsefulOverlap = Math.max(8, Math.floor(Math.min(previous.length, next.length) * 0.5));
  if (overlap >= minimumUsefulOverlap) {
    return `${previous}${next.slice(overlap)}`.trim();
  }

  return `${previous} ${next}`.replace(/\s+/g, " ").trim();
}

function shouldPreserveTopicStateOnLowSignal(currentState: TopicState, nextState: TopicState): boolean {
  return currentState !== "pending" && currentState !== nextState;
}

function sourceArtifactsDir(sessionDir: string, sourceId: string): string {
  return path.join(sessionDir, "sources", sourceId.replace(/[^a-zA-Z0-9._-]+/g, "_"));
}

function isNativeCaptureSourceKind(kind: SelectedCaptureSourceConfig["kind"] | CaptureSourceDescriptor["kind"]): boolean {
  return kind === "native-display-audio" || kind === "native-app-audio";
}

function createLivePromptId(kind: LivePromptKind, text: string, topicId: string | null): string {
  const normalizedText = text.trim().toLowerCase().replace(/\s+/g, " ");
  return `lp_${crypto.createHash("sha1").update(`${kind}:${topicId ?? ""}:${normalizedText}`).digest("hex").slice(0, 12)}`;
}

function uniqueStrings(values: string[], limit: number): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values.map((entry) => entry.trim()).filter(Boolean)) {
    const key = value.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(value);
    if (result.length >= limit) {
      break;
    }
  }
  return result;
}

function formatTopicList(topics: TopicRecord[], limit: number): string {
  return topics.slice(0, limit).map((topic) => topic.text).join(", ");
}

function compareThemes(left: RevisitableThemeRecord, right: RevisitableThemeRecord): number {
  const leftPinned = left.pinnedAt ? 1 : 0;
  const rightPinned = right.pinnedAt ? 1 : 0;
  if (leftPinned !== rightPinned) {
    return rightPinned - leftPinned;
  }

  const leftPrompt = left.promptEligible ? 1 : 0;
  const rightPrompt = right.promptEligible ? 1 : 0;
  if (leftPrompt !== rightPrompt) {
    return rightPrompt - leftPrompt;
  }

  const confidenceDelta = right.confidence - left.confidence;
  if (confidenceDelta !== 0) {
    return confidenceDelta;
  }

  return right.lastUpdatedAt.localeCompare(left.lastUpdatedAt);
}

function deriveSessionSummary(session: SessionSnapshot, recordedAt: string): SessionSnapshot["sessionSummary"] {
  const bullets: string[] = [];
  const topics = Object.values(session.topics);
  const coveredTopics = topics
    .filter((topic) => topic.currentState === "covered" && !topic.parentId)
    .sort((left, right) => (right.lastUpdatedAt ?? "").localeCompare(left.lastUpdatedAt ?? ""));
  const partialTopics = topics
    .filter((topic) => topic.currentState === "partial" && !topic.parentId)
    .sort((left, right) => (right.lastUpdatedAt ?? "").localeCompare(left.lastUpdatedAt ?? ""));
  const activeThemes = session.revisitableThemes
    .filter((theme) => theme.status !== "dismissed")
    .slice()
    .sort(compareThemes);

  const counts = summarizeCounts(session.topics);
  bullets.push(`Prepared topics: ${counts.covered} covered, ${counts.partial} partial, ${counts.pending} pending.`);

  if (coveredTopics.length) {
    bullets.push(`Recently covered: ${formatTopicList(coveredTopics, 3)}.`);
  }
  if (partialTopics.length) {
    bullets.push(`Still in play: ${formatTopicList(partialTopics, 3)}.`);
  }

  activeThemes.slice(0, 3).forEach((theme) => {
    bullets.push(`Revisitable: ${theme.label}. ${theme.summary}`);
  });

  return {
    updatedAt: recordedAt,
    bullets: uniqueStrings(bullets, MAX_SESSION_SUMMARY_BULLETS)
  };
}

function buildSessionRecapMarkdown(session: SessionSnapshot, recap: SessionRecap): string {
  const section = (title: string, items: string[]) => [
    `## ${title}`,
    ...(items.length ? items.map((item) => `- ${item}`) : ["- None"]),
    ""
  ];

  return [
    "# Session Recap",
    "",
    `- Session: ${session.id}`,
    `- Started: ${session.startedAt}`,
    `- Ended: ${session.endedAt ?? "In progress"}`,
    "",
    ...section("Overview", recap.overview),
    ...section("Prepared Topics Covered", recap.preparedTopicsCovered),
    ...section("Other Themes Discussed", recap.otherThemesDiscussed),
    ...section("Poignant Moments", recap.poignantMoments),
    ...section("Open Loops / Future Follow-ups", recap.futureFollowUps)
  ].join("\n");
}

function inferredTopicStateFromChildren(childTopics: TopicRecord[]): TopicState {
  const coveredChildren = childTopics.filter((child) => child.currentState === "covered").length;
  const partialChildren = childTopics.filter((child) => child.currentState === "partial" || child.currentState === "covered").length;

  if (coveredChildren > 0 && coveredChildren / childTopics.length >= 0.5) {
    return "covered";
  }
  if (partialChildren > 0) {
    return "partial";
  }
  return "pending";
}

function strongerTopicState(left: TopicState, right: TopicState): TopicState {
  const rank: Record<"pending" | "partial" | "covered", number> = {
    pending: 0,
    partial: 1,
    covered: 2
  };
  return rank[left as keyof typeof rank] >= rank[right as keyof typeof rank] ? left : right;
}

function groupLabelForSourceKind(kind: SelectedCaptureSourceConfig["kind"]): string {
  switch (kind) {
    case "microphone":
      return "Microphones";
    case "system-mix":
      return "Desktop Audio";
    case "loopback-input":
      return "Loopback / Routed Inputs";
    case "native-display-audio":
      return "Advanced: Displays";
    case "native-app-audio":
      return "Advanced: Apps";
    default:
      return "Unavailable";
  }
}

function collapseCatalogSources(sources: CaptureSourceDescriptor[]): CaptureSourceDescriptor[] {
  const inputSources = sources.filter((source) => source.transport === "input-device");
  const nonInputSources = sources.filter((source) => source.transport !== "input-device");

  return [
    ...inputSources.filter((source) => source.kind === "microphone"),
    ...inputSources.filter((source) => source.kind === "system-mix"),
    ...nonInputSources
  ];
}

function fallbackDescriptorFromSelection(source: SelectedCaptureSourceConfig): CaptureSourceDescriptor {
  const nativeTargetId = source.kind === "native-display-audio" && source.id.startsWith("display:")
    ? source.id.slice("display:".length)
    : source.kind === "native-app-audio" && source.id.startsWith("app-bundle:")
      ? source.id
      : source.kind === "native-app-audio" && source.id.startsWith("app:")
        ? source.id.slice("app:".length)
        : undefined;
  const bundleId = source.kind === "native-app-audio" && source.id.startsWith("app-bundle:")
    ? source.id.slice("app-bundle:".length)
    : undefined;

  return {
    id: source.id,
    name: source.name,
    kind: source.kind,
    groupLabel: groupLabelForSourceKind(source.kind),
    transport: isNativeCaptureSourceKind(source.kind) ? "screencapturekit" : "mock",
    isDefault: false,
    nativeTargetId,
    bundleId,
    details: source.kind === "system-mix"
      ? "Will retry Desktop Audio when a routed system-mix input device is available."
      : isNativeCaptureSourceKind(source.kind)
      ? "Will retry this native source when system audio permission and enumeration are available."
      : undefined
  };
}

function describeSystemAudioPermissionIssue(permission: string): string {
  switch (permission) {
    case "denied":
      return "System audio capture permission is denied for the native helper.";
    case "not-determined":
      return "System audio capture permission has not been granted yet.";
    case "unavailable":
      return "Native system audio capture is unavailable on this machine.";
    default:
      return "System audio capture is not ready.";
  }
}

function describeUnavailableSource(source: CaptureSourceDescriptor, nativeCatalogError: string | null): string {
  if (source.kind === "system-mix") {
    return "Desktop Audio is unavailable because no routed system-mix input device was found. Install BlackHole and route system audio to it.";
  }

  if (isNativeCaptureSourceKind(source.kind) && nativeCatalogError) {
    return nativeCatalogError;
  }

  return "Selected source is not available.";
}

function sourceNeedsMicrophonePermission(source: SelectedCaptureSourceConfig): boolean {
  return source.kind === "microphone" || source.kind === "loopback-input" || source.kind === "system-mix";
}

function sourceNeedsSystemAudioPermission(source: SelectedCaptureSourceConfig, options: { nativeCaptureEnabled: boolean; }): boolean {
  return options.nativeCaptureEnabled && isNativeCaptureSourceKind(source.kind);
}

export class AppService {
  private readonly fileStore: FileStore;
  private readonly nativeSystemAudioHelper: NativeSystemAudioHelper;
  private activeSession: SessionSnapshot | null = null;
  private activeSourceSessions = new Map<string, SttProviderSession>();
  private activeNativeCaptureSessions = new Map<string, NativeCaptureSession>();
  private activeNativeTranscriptions = new Map<string, Promise<void>>();
  private activeProbes = new Map<string, MicrophoneProbe>();
  private config!: AppConfig;
  private captureSourceCatalog: CaptureSourceDescriptor[] = [];
  private sourceMonitors: Record<string, CaptureSourceMonitorState> = {};

  constructor(
    private readonly runtimeConfig: RuntimeConfig,
    private readonly sttProviders: Map<string, SttProvider>,
    private readonly analysisProviders: Map<string, AnalysisProvider>
  ) {
    this.fileStore = new FileStore(runtimeConfig);
    this.nativeSystemAudioHelper = new NativeSystemAudioHelper(runtimeConfig);
  }

  async initialize(): Promise<void> {
    await this.fileStore.ensureProjectDirs();
    const defaultConfig = createDefaultAppConfig(
      path.join(this.runtimeConfig.dataDir, "sample-topics.md"),
      this.runtimeConfig
    );

    const sampleTopicsPath = defaultConfig.markdownFilePath;
    if (!(await this.fileStore.exists(sampleTopicsPath))) {
      const bundledSample = await this.fileStore.readFile(path.join(this.runtimeConfig.rootDir, "data/sample-topics.md"));
      await this.fileStore.writeFile(sampleTopicsPath, bundledSample);
    }

    this.config = await this.fileStore.loadConfig(defaultConfig);
    this.config.captureSources = normalizeCaptureSources(this.config.captureSources);
    await this.refreshCaptureSourcesAndMonitors();
  }

  async getState(): Promise<AppStateResponse> {
    const [catalog, microphonePermission, systemAudioPermission, sessions] = await Promise.all([
      this.refreshCaptureSourcesAndMonitors(),
      getMicrophonePermissionState(this.runtimeConfig),
      getSystemAudioPermissionState(this.runtimeConfig),
      this.fileStore.listSessions()
    ]);
    const history = sessions.map((session) => this.fileStore.summarizeHistory(session));
    const resumableSessions = sessions
      .filter((session) => session.status === "active" || session.status === "paused" || session.status === "interrupted")
      .map((session) => this.fileStore.summarizeHistory(session));

    return {
      config: this.config,
      runtime: {
        pollingIntervalMs: this.runtimeConfig.pollingIntervalMs,
        activeSessionId: this.activeSession?.id ?? null,
        defaultProviders: {
          stt: this.runtimeConfig.sttProvider,
          analysis: this.runtimeConfig.analysisProvider
        },
        availableProviders: {
          stt: Array.from(this.sttProviders.keys()),
          analysis: Array.from(this.analysisProviders.keys())
        }
      },
      capturePermissions: {
        microphone: microphonePermission,
        systemAudio: systemAudioPermission
      },
      captureSourceCatalog: catalog,
      sourceMonitors: this.sourceMonitors,
      resumableSessions,
      history,
      activeSession: this.activeSession
    };
  }

  async requestRelevantPermissions(): Promise<AppStateResponse> {
    const needsMicrophone = this.config.captureSources.some((source) => sourceNeedsMicrophonePermission(source));
    const needsSystemAudio = this.config.captureSources.some((source) => sourceNeedsSystemAudioPermission(source, {
      nativeCaptureEnabled: this.runtimeConfig.enableNativeSystemAudioCapture
    }));

    if (needsMicrophone) {
      await requestMicrophonePermission(this.runtimeConfig);
    }
    if (needsSystemAudio) {
      await requestSystemAudioPermission(this.runtimeConfig);
    }

    await this.refreshCaptureSourcesAndMonitors();

    if (this.activeSession) {
      this.activeSession.sourceMonitors = Object.fromEntries(
        Object.entries(this.sourceMonitors).map(([sourceId, monitor]) => [sourceId, cloneMonitor(monitor)])
      );
      await this.writeSessionArtifacts();
    }

    return this.getState();
  }

  async openRelevantPrivacySettings(): Promise<AppStateResponse> {
    const needsMicrophone = this.config.captureSources.some((source) => sourceNeedsMicrophonePermission(source));
    const needsSystemAudio = this.config.captureSources.some((source) => sourceNeedsSystemAudioPermission(source, {
      nativeCaptureEnabled: this.runtimeConfig.enableNativeSystemAudioCapture
    }));

    if (needsSystemAudio) {
      await openPrivacyPane("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture");
    }
    if (needsMicrophone) {
      await openPrivacyPane("x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone");
    }

    return this.getState();
  }

  getActiveSession(): SessionSnapshot | null {
    return this.activeSession ? cloneSession(this.activeSession) : null;
  }

  async updateConfig(nextConfig: Partial<AppConfig>): Promise<AppConfig> {
    this.config = {
      ...this.config,
      ...nextConfig,
      captureSources: normalizeCaptureSources(nextConfig.captureSources ?? this.config.captureSources),
      visibleSuggestionCounts: {
        ...this.config.visibleSuggestionCounts,
        ...(nextConfig.visibleSuggestionCounts ?? {})
      }
    };
    await this.fileStore.saveConfig(this.config);

    await this.refreshCaptureSourcesAndMonitors();

    if (this.activeSession && (nextConfig.captureSources !== undefined || nextConfig.sttProvider !== undefined)) {
      await this.restartStt();
    }

    return this.config;
  }

  async startSession(): Promise<SessionSnapshot> {
    if (this.activeSession) {
      throw new Error("A session is already active.");
    }

    const sourceMarkdown = await this.fileStore.readFile(this.config.markdownFilePath);
    const document = parseTopicsMarkdown(sourceMarkdown);
    const startedAt = nowIso();
    const sessionId = createSessionId(startedAt);
    const artifacts = await this.fileStore.createSessionArtifacts(sessionId, sourceMarkdown);
    const topics = Object.fromEntries(Object.values(document.topics).map((topic) => [topic.id, createTopicRecord(topic)]));
    const selectedSources = this.resolveSelectedCaptureSources();
    const session: SessionSnapshot = {
      id: sessionId,
      sourceMarkdownPath: this.config.markdownFilePath,
      sourceSnapshotPath: artifacts.sourceSnapshotPath,
      sourceContentHash: this.fileStore.hashContent(sourceMarkdown),
      startedAt,
      endedAt: null,
      sttProvider: this.config.sttProvider,
      analysisProvider: this.config.analysisProvider,
      captureSources: selectedSources.map(selectedSourceFromDescriptor),
      status: "active",
      latestTranscriptTail: [],
      visibleTranscriptEvents: [],
      displayTranscript: createEmptyDisplayTranscript(),
      latestAnalysisAt: null,
      proposedMarkdownPath: artifacts.proposedMarkdownPath,
      liveTranscriptPath: path.join(artifacts.sessionDir, "live-transcript.txt"),
      recordedAudioPath: null,
      recordedAudioPaths: {},
      approximateTranscriptSrtPath: path.join(artifacts.sessionDir, "transcript.approx.srt"),
      finalTranscriptSrtPath: null,
      chunkSensitivity: this.config.chunkSensitivity,
      document,
      topics,
      chunks: [],
      pendingTranscriptEvents: [],
      analyses: [],
      suggestions: createEmptySuggestions(),
      livePrompts: [],
      offTopicObservations: [],
      sessionSummary: createEmptySessionSummary(),
      revisitableThemes: [],
      sessionRecap: createEmptySessionRecap(),
      warnings: [],
      pendingDecisions: [],
      actionHistory: [],
      passCount: 0,
      sourceMonitors: Object.fromEntries(
        selectedSources.map((source) => [source.id, cloneMonitor(this.sourceMonitors[source.id] ?? createSourceMonitor(this.config.sttProvider, source))])
      ),
      lastError: null,
      resumeWarning: null
    };

    this.activeSession = session;
    this.refreshInferredParentStates();
    await this.writeSessionArtifacts();
    await this.startSttForActiveSession();
    return cloneSession(this.activeSession);
  }

  async resumeSession(sessionId: string): Promise<SessionSnapshot> {
    if (this.activeSession) {
      throw new Error("A session is already active.");
    }

    const loaded = await this.fileStore.loadSession(sessionId);
    if (!loaded) {
      throw new Error(`Session ${sessionId} was not found.`);
    }

    if (loaded.status === "finished") {
      throw new Error("Finished sessions cannot be resumed.");
    }

    loaded.visibleTranscriptEvents ??= [];
    loaded.displayTranscript ??= createEmptyDisplayTranscript();
    loaded.captureSources = normalizeCaptureSources(loaded.captureSources);
    loaded.recordedAudioPaths ??= {};
    loaded.livePrompts ??= [];
    loaded.sessionSummary ??= createEmptySessionSummary();
    loaded.revisitableThemes ??= [];
    loaded.sessionRecap ??= createEmptySessionRecap();
    loaded.sourceMonitors ??= Object.fromEntries(
      loaded.captureSources.map((source) => [source.id, createSourceMonitor(loaded.sttProvider, source)])
    );

    const currentSourceExists = await this.fileStore.exists(loaded.sourceMarkdownPath);
    if (currentSourceExists) {
      const currentSource = await this.fileStore.readFile(loaded.sourceMarkdownPath);
      const currentHash = this.fileStore.hashContent(currentSource);
      if (currentHash !== loaded.sourceContentHash) {
        loaded.resumeWarning = "The source markdown file changed after the session started. The resumed session continues from its stored snapshot.";
      }
    }

    loaded.status = "active";
    this.activeSession = loaded;
    await this.refreshCaptureSourcesAndMonitors();
    await this.writeSessionArtifacts();
    await this.startSttForActiveSession();
    return cloneSession(this.activeSession);
  }

  async endSession(status: "finished" | "interrupted" = "finished"): Promise<SessionSnapshot | null> {
    if (!this.activeSession) {
      return null;
    }

    await this.stopAllCaptureSessions();

    this.activeSession.status = status;
    this.activeSession.endedAt = nowIso();
    await this.finalizePendingChunk(true);
    await this.exportTranscriptArtifacts(this.activeSession);
    await this.generateSessionRecapForActiveSession();
    await this.writeSessionArtifacts();
    await this.fileStore.writeFile(
      path.join(this.fileStore.sessionDir(this.activeSession.id), "session-summary.json"),
      JSON.stringify({
        id: this.activeSession.id,
        startedAt: this.activeSession.startedAt,
        endedAt: this.activeSession.endedAt,
        countsByState: summarizeCounts(this.activeSession.topics),
        analyses: this.activeSession.analyses.length,
        transcriptChunks: this.activeSession.chunks.length,
        recapMarkdownPath: this.activeSession.sessionRecap.markdownPath,
        recapOverview: this.activeSession.sessionRecap.overview
      }, null, 2)
    );

    const finished = cloneSession(this.activeSession);
    this.activeSession = null;
    await this.refreshCaptureSourcesAndMonitors();
    return finished;
  }

  async analyzeNow(): Promise<SessionSnapshot> {
    if (!this.activeSession) {
      throw new Error("No active session.");
    }

    const chunk = this.buildChunk(true);
    if (!chunk) {
      throw new Error("No transcript is waiting for analysis.");
    }

    await this.runAnalysis(chunk);
    return cloneSession(this.activeSession);
  }

  async setTopicState(topicId: string, nextState: TopicState): Promise<SessionSnapshot> {
    if (!this.activeSession) {
      throw new Error("No active session.");
    }

    const topic = this.activeSession.topics[topicId];
    if (!topic) {
      throw new Error(`Unknown topic ${topicId}.`);
    }

    this.applyDirectState(topicId, nextState, "user", 1, "Manual user action");
    await this.writeSessionArtifacts();
    return cloneSession(this.activeSession);
  }

  async dismissLivePrompt(promptId: string): Promise<SessionSnapshot> {
    if (!this.activeSession) {
      throw new Error("No active session.");
    }

    const prompt = this.activeSession.livePrompts.find((candidate) => candidate.id === promptId);
    if (!prompt) {
      throw new Error(`Unknown live prompt ${promptId}.`);
    }

    prompt.dismissedAt = nowIso();
    await this.writeSessionArtifacts();
    return cloneSession(this.activeSession);
  }

  async dismissRevisitableTheme(themeId: string): Promise<SessionSnapshot> {
    if (!this.activeSession) {
      throw new Error("No active session.");
    }

    const theme = this.activeSession.revisitableThemes.find((candidate) => candidate.id === themeId);
    if (!theme) {
      throw new Error(`Unknown revisitable theme ${themeId}.`);
    }

    theme.manualState = "dismissed";
    theme.dismissedAt = nowIso();
    theme.pinnedAt = null;
    this.refreshRevisitableThemeStatuses(theme.dismissedAt, this.activeSession.passCount);
    await this.writeSessionArtifacts();
    return cloneSession(this.activeSession);
  }

  async pinRevisitableTheme(themeId: string): Promise<SessionSnapshot> {
    if (!this.activeSession) {
      throw new Error("No active session.");
    }

    const theme = this.activeSession.revisitableThemes.find((candidate) => candidate.id === themeId);
    if (!theme) {
      throw new Error(`Unknown revisitable theme ${themeId}.`);
    }

    theme.manualState = "pinned";
    theme.pinnedAt = nowIso();
    theme.dismissedAt = null;
    this.refreshRevisitableThemeStatuses(theme.pinnedAt, this.activeSession.passCount);
    await this.writeSessionArtifacts();
    return cloneSession(this.activeSession);
  }

  async unpinRevisitableTheme(themeId: string): Promise<SessionSnapshot> {
    if (!this.activeSession) {
      throw new Error("No active session.");
    }

    const theme = this.activeSession.revisitableThemes.find((candidate) => candidate.id === themeId);
    if (!theme) {
      throw new Error(`Unknown revisitable theme ${themeId}.`);
    }

    theme.manualState = null;
    theme.pinnedAt = null;
    this.refreshRevisitableThemeStatuses(nowIso(), this.activeSession.passCount);
    await this.writeSessionArtifacts();
    return cloneSession(this.activeSession);
  }

  async undoLastAction(): Promise<SessionSnapshot> {
    if (!this.activeSession) {
      throw new Error("No active session.");
    }

    const lastChange = this.activeSession.actionHistory.pop();
    if (!lastChange) {
      throw new Error("There is no action to undo.");
    }

    const topic = this.activeSession.topics[lastChange.topicId];
    if (!topic) {
      throw new Error("The topic for the last action no longer exists.");
    }

    topic.directState = lastChange.previousState;
    topic.currentState = lastChange.previousState;
    topic.stateSetBy = "user";
    topic.confidenceAtLastChange = 1;
    topic.lastUpdatedAt = nowIso();
    await this.fileStore.appendStateChange(this.activeSession.id, {
      topicId: topic.id,
      previousState: lastChange.nextState,
      nextState: lastChange.previousState,
      origin: "user",
      confidence: 1,
      rationale: "Undo last action",
      occurredAt: topic.lastUpdatedAt
    });
    this.refreshInferredParentStates();
    await this.writeSessionArtifacts();
    return cloneSession(this.activeSession);
  }

  async injectMockTranscript(text: string, sourceId?: string): Promise<SessionSnapshot> {
    if (!this.activeSession) {
      throw new Error("No active session.");
    }

    const session = sourceId
      ? this.activeSourceSessions.get(sourceId)
      : this.activeSourceSessions.get(this.activeSession.captureSources[0]?.id ?? "");
    if (!session?.injectTranscript) {
      throw new Error("The active STT provider does not support transcript injection.");
    }

    await session.injectTranscript(text);
    return cloneSession(this.activeSession);
  }

  private async refreshCaptureSourcesAndMonitors(): Promise<CaptureSourceDescriptor[]> {
    const provider = this.sttProviders.get(this.config.sttProvider) ?? this.sttProviders.get(this.runtimeConfig.sttProvider);
    if (!provider) {
      this.captureSourceCatalog = [];
      this.sourceMonitors = {};
      return [];
    }

    const baseSources = await provider.listSources();
    const annotatedInputSources = await this.annotateInputSources(baseSources);
    const nativeCatalog = this.config.sttProvider === "whisper"
      ? await this.nativeSystemAudioHelper.listSourceCatalog()
      : { sources: [], permissionState: "unavailable" as const, error: null };
    const nativeSources = nativeCatalog.sources.map((source) => ({
      ...source,
      available: this.runtimeConfig.enableNativeSystemAudioCapture,
      availabilityReason: this.runtimeConfig.enableNativeSystemAudioCapture ? undefined : NATIVE_SYSTEM_AUDIO_UNAVAILABLE_REASON
    }));
    this.captureSourceCatalog = dedupeSources(collapseCatalogSources([...annotatedInputSources, ...nativeSources]));
    this.config.captureSources = this.config.captureSources.map((source) => {
      const hydrated = this.findCatalogSource(source.id, source);
      return hydrated ? selectedSourceFromDescriptor(hydrated) : source;
    });

    const selected = this.config.captureSources.length > 0
      ? this.config.captureSources
      : [];
    const nextMonitors: Record<string, CaptureSourceMonitorState> = {};

    for (const selectedSource of selected) {
      const resolvedSource = this.findCatalogSource(selectedSource.id, selectedSource);
      const source = resolvedSource ?? fallbackDescriptorFromSelection(selectedSource);
      const existing = this.sourceMonitors[source.id] ?? createSourceMonitor(this.config.sttProvider, source);
      nextMonitors[source.id] = {
        ...existing,
        sourceId: source.id,
        sourceName: source.name,
        sourceKind: source.kind,
        provider: this.config.sttProvider,
        whisperExecutable: this.config.sttProvider === "whisper" ? (this.runtimeConfig.sttExecutable || null) : null,
        whisperModel: this.config.sttProvider === "whisper" ? (this.runtimeConfig.whisperModel || null) : null,
        whisperCaptureId: source.transport === "input-device" ? (source.inputDeviceId ?? null) : null,
        deviceDiagnostics: buildDiagnostics(source, this.config.sttProvider)
      };
      if (source.available === false) {
        nextMonitors[source.id].status = "unsupported";
        nextMonitors[source.id].error = source.availabilityReason ?? "Selected source is unavailable.";
      }
      if (!resolvedSource) {
        nextMonitors[source.id].status = "error";
        nextMonitors[source.id].error = isNativeCaptureSourceKind(source.kind) && nativeCatalog.permissionState !== "granted"
          ? describeSystemAudioPermissionIssue(nativeCatalog.permissionState ?? "unknown")
          : describeUnavailableSource(source, nativeCatalog.error);
      }
    }

    this.sourceMonitors = nextMonitors;
    await this.refreshInputProbes();

    if (this.activeSession) {
      this.activeSession.sourceMonitors = Object.fromEntries(
        Object.entries(this.sourceMonitors).map(([sourceId, monitor]) => [sourceId, cloneMonitor(monitor)])
      );
    }

    return this.captureSourceCatalog;
  }

  private async annotateInputSources(sources: CaptureSourceDescriptor[]): Promise<CaptureSourceDescriptor[]> {
    const inputSources = sources.filter((source) => source.transport === "input-device");
    const annotated = await new MicrophoneProbe(this.runtimeConfig).annotateDevices(inputSources);
    const annotatedById = new Map(annotated.map((source) => [source.id, source]));
    return sources.map((source) => annotatedById.get(source.id) ?? source);
  }

  private resolveSelectedCaptureSources(): CaptureSourceDescriptor[] {
    return this.config.captureSources
      .map((source) => this.findCatalogSource(source.id, source) ?? fallbackDescriptorFromSelection(source));
  }

  private findCatalogSource(sourceId: string, fallbackSource?: SelectedCaptureSourceConfig): CaptureSourceDescriptor | null {
    const direct = this.captureSourceCatalog.find((source) => source.id === sourceId);
    if (direct) {
      return direct;
    }

    if (!fallbackSource) {
      return null;
    }

    if (fallbackSource.kind === "native-app-audio" && sourceId.startsWith("app:")) {
      return this.captureSourceCatalog.find((source) =>
        source.kind === "native-app-audio" &&
        source.name === fallbackSource.name
      ) ?? null;
    }

    if (fallbackSource.kind === "system-mix" || fallbackSource.kind === "loopback-input") {
      return findRecommendedSystemMixSource(this.captureSourceCatalog) ?? null;
    }

    return null;
  }

  private async refreshInputProbes(): Promise<void> {
    const desiredSources = this.config.sttProvider === "whisper"
      ? this.resolveSelectedCaptureSources().filter((source) => source.transport === "input-device")
      : [];
    const desiredIds = new Set(desiredSources.map((source) => source.id));

    for (const [sourceId, probe] of this.activeProbes.entries()) {
      if (desiredIds.has(sourceId)) {
        continue;
      }
      await probe.stop().catch(() => undefined);
      this.activeProbes.delete(sourceId);
    }

    for (const source of desiredSources) {
      const monitor = this.sourceMonitors[source.id] ?? createSourceMonitor(this.config.sttProvider, source);
      this.sourceMonitors[source.id] = monitor;
      if (!source.probeId) {
        monitor.error = null;
        continue;
      }
      if (this.activeProbes.has(source.id)) {
        continue;
      }

      const probe = new MicrophoneProbe(this.runtimeConfig);
      this.activeProbes.set(source.id, probe);
      monitor.status = "running";
      monitor.error = null;
      await probe.start(source, {
        onLevel: (level) => {
          this.updateSourceLevel(source.id, level);
        },
        onError: (message) => {
          this.updateSourceError(source.id, message);
        }
      });
    }
  }

  private async startSttForActiveSession(): Promise<void> {
    if (!this.activeSession) {
      return;
    }

    const provider = this.sttProviders.get(this.activeSession.sttProvider);
    if (!provider) {
      throw new Error(`Unknown STT provider ${this.activeSession.sttProvider}.`);
    }

    const systemAudioPermission = this.activeSession.sttProvider === "whisper"
      ? await this.nativeSystemAudioHelper.getPermissionState()
      : "unavailable";

    for (const selectedSource of this.activeSession.captureSources) {
      const resolvedSource = this.findCatalogSource(selectedSource.id, selectedSource);
      const source = resolvedSource ?? fallbackDescriptorFromSelection(selectedSource);
      const monitor = this.ensureSessionSourceMonitor(source);
      const sessionDir = sourceArtifactsDir(this.fileStore.sessionDir(this.activeSession.id), source.id);
      await fs.mkdir(sessionDir, { recursive: true });

      if (!resolvedSource) {
        monitor.status = "error";
        monitor.error = isNativeCaptureSourceKind(source.kind) && systemAudioPermission !== "granted"
          ? describeSystemAudioPermissionIssue(systemAudioPermission)
          : describeUnavailableSource(source, null);
        monitor.lastUpdatedAt = nowIso();
        this.syncMonitorToSession(source.id);
        continue;
      }

      if (source.available === false) {
        monitor.status = "unsupported";
        monitor.error = source.availabilityReason ?? "Selected source is unavailable.";
        monitor.lastUpdatedAt = nowIso();
        this.syncMonitorToSession(source.id);
        continue;
      }

      if (source.transport === "screencapturekit" && this.activeSession.sttProvider === "whisper") {
        if (systemAudioPermission !== "granted") {
          monitor.status = "error";
          monitor.error = describeSystemAudioPermissionIssue(systemAudioPermission);
          monitor.lastUpdatedAt = nowIso();
          this.syncMonitorToSession(source.id);
          continue;
        }
        if (!provider.transcribeFile) {
          monitor.status = "unsupported";
          monitor.error = "The configured STT provider cannot transcribe native audio segments.";
          this.syncMonitorToSession(source.id);
          continue;
        }

        const nativeBackingSources = source.kind === "system-mix"
          ? this.captureSourceCatalog.filter((candidate) => candidate.kind === "native-display-audio")
          : [source];
        if (nativeBackingSources.length === 0) {
          monitor.status = "error";
          monitor.error = "Desktop Audio could not find any available displays to capture.";
          monitor.lastUpdatedAt = nowIso();
          this.syncMonitorToSession(source.id);
          continue;
        }

        const childFailures = new Map<string, string>();
        const handleNativeLevel = (nativeSourceId: string, level: number) => {
          childFailures.delete(nativeSourceId);
          this.updateSourceLevel(source.id, level);
        };
        const handleNativeSegment = (nativeSourceId: string, payload: { path: string; startedAt: string; endedAt: string; }) => {
          childFailures.delete(nativeSourceId);
          void this.queueNativeSegmentTranscription(source, payload.path, payload.endedAt, provider);
        };
        const handleNativeError = (nativeSourceId: string, message: string) => {
          childFailures.set(nativeSourceId, message);
          if (childFailures.size >= nativeBackingSources.length) {
            this.updateSourceError(source.id, message);
            return;
          }

          const activeMonitor = this.sourceMonitors[source.id];
          if (activeMonitor) {
            activeMonitor.whisperLastError = message;
            activeMonitor.lastUpdatedAt = nowIso();
            this.syncMonitorToSession(source.id);
          }
        };

        const captureSessions = await Promise.all(nativeBackingSources.map(async (nativeSource) => {
          const nativeOutputDir = source.kind === "system-mix"
            ? path.join(sessionDir, nativeSource.nativeTargetId ?? nativeSource.id.replace(/[^a-zA-Z0-9._-]+/g, "_"))
            : sessionDir;
          await fs.mkdir(nativeOutputDir, { recursive: true });
          return this.nativeSystemAudioHelper.startCapture(nativeSource, nativeOutputDir, {
            onLevel: (level) => handleNativeLevel(nativeSource.id, level),
            onSegment: (payload) => handleNativeSegment(nativeSource.id, payload),
            onError: (message) => handleNativeError(nativeSource.id, message)
          });
        }));
        const captureSession: NativeCaptureSession = {
          stop: async () => {
            await Promise.all(captureSessions.map((session) => session.stop().catch(() => undefined)));
          }
        };
        this.activeNativeCaptureSessions.set(source.id, captureSession);
        monitor.status = "running";
        monitor.lastUpdatedAt = nowIso();
        monitor.error = null;
        this.syncMonitorToSession(source.id);
        continue;
      }

      const sttSession = await provider.start(
        {
          source,
          sessionDir,
          liveTranscriptPath: path.join(sessionDir, "live-transcript.txt")
        },
        {
          onTranscript: async (event) => this.handleTranscriptEvent(event),
          onLevel: async (level) => this.updateSourceLevel(source.id, level),
          onError: async (error) => this.updateSourceError(source.id, error.message)
        }
      );
      this.activeSourceSessions.set(source.id, sttSession);
      monitor.status = "running";
      monitor.lastUpdatedAt = nowIso();
      monitor.error = null;
      this.syncMonitorToSession(source.id);
    }
  }

  private async stopAllCaptureSessions(): Promise<void> {
    await Promise.all([
      ...Array.from(this.activeSourceSessions.values()).map((session) => session.stop().catch(() => undefined)),
      ...Array.from(this.activeNativeCaptureSessions.values()).map((session) => session.stop().catch(() => undefined))
    ]);
    this.activeSourceSessions.clear();
    this.activeNativeCaptureSessions.clear();
    await Promise.all(Array.from(this.activeNativeTranscriptions.values()).map((promise) => promise.catch(() => undefined)));
    this.activeNativeTranscriptions.clear();
  }

  private async restartStt(): Promise<void> {
    if (!this.activeSession) {
      return;
    }

    await this.stopAllCaptureSessions();
    this.activeSession.captureSources = this.resolveSelectedCaptureSources().map(selectedSourceFromDescriptor);
    this.activeSession.sttProvider = this.config.sttProvider;
    await this.refreshCaptureSourcesAndMonitors();
    await this.startSttForActiveSession();
    await this.writeSessionArtifacts();
  }

  private ensureSessionSourceMonitor(source: CaptureSourceDescriptor): CaptureSourceMonitorState {
    const existing = this.sourceMonitors[source.id] ?? createSourceMonitor(this.config.sttProvider, source);
    this.sourceMonitors[source.id] = existing;
    if (this.activeSession) {
      this.activeSession.sourceMonitors[source.id] = cloneMonitor(existing);
      return existing;
    }
    return existing;
  }

  private syncMonitorToSession(sourceId: string): void {
    if (!this.activeSession) {
      return;
    }

    const monitor = this.sourceMonitors[sourceId];
    if (!monitor) {
      return;
    }

    this.activeSession.sourceMonitors[sourceId] = cloneMonitor(monitor);
  }

  private updateSourceLevel(sourceId: string, level: number): void {
    const monitor = this.sourceMonitors[sourceId];
    if (!monitor) {
      return;
    }

    monitor.level = level;
    monitor.lastUpdatedAt = nowIso();
    monitor.status = "running";
    monitor.error = null;
    this.syncMonitorToSession(sourceId);
  }

  private updateSourceError(sourceId: string, message: string): void {
    const monitor = this.sourceMonitors[sourceId];
    if (monitor) {
      monitor.status = "error";
      monitor.error = message;
      monitor.whisperLastError = message;
      this.syncMonitorToSession(sourceId);
    }

    if (this.activeSession) {
      const sourceName = this.activeSession.captureSources.find((source) => source.id === sourceId)?.name ?? sourceId;
      this.activeSession.lastError = `[${sourceName}] ${message}`;
      void this.writeSessionArtifacts();
    }
  }

  private updateSourceDiagnostic(sourceId: string, message: string): void {
    const monitor = this.sourceMonitors[sourceId];
    if (!monitor) {
      return;
    }

    monitor.whisperLastError = message;
    monitor.lastUpdatedAt = nowIso();
    this.syncMonitorToSession(sourceId);
  }

  private async queueNativeSegmentTranscription(
    source: CaptureSourceDescriptor,
    audioPath: string,
    endedAt: string,
    provider: SttProvider
  ): Promise<void> {
    if (!provider.transcribeFile) {
      return;
    }

    const previous = this.activeNativeTranscriptions.get(source.id) ?? Promise.resolve();
    const transcribeFile = provider.transcribeFile;
    const next = previous.then(async () => {
      if (!this.activeSession) {
        return;
      }

      const sourcePaths = this.activeSession.recordedAudioPaths[source.id] ?? [];
      sourcePaths.push(audioPath);
      this.activeSession.recordedAudioPaths[source.id] = sourcePaths;
      this.activeSession.recordedAudioPath = audioPath;

      const signal = await analyzeWaveSignal(audioPath);
      const text = (await transcribeFile(audioPath)).replace(/\s+/g, " ").trim();
      if (!text) {
        const diagnostic = signal?.silent
          ? "Silent audio segment captured. Check the routed audio source or system-audio permissions."
          : signal
            ? "Audio segment contained signal, but no speech was detected."
            : "Audio segment produced no transcript.";
        this.updateSourceDiagnostic(source.id, diagnostic);
        await this.writeSessionArtifacts();
        return;
      }

      await this.handleTranscriptEvent({
        id: `evt_${Date.now().toString(36)}`,
        timestamp: endedAt,
        text,
        sourceId: source.id,
        sourceName: source.name,
        sourceKind: source.kind
      });
    }).catch((error) => {
      this.updateSourceError(source.id, error instanceof Error ? error.message : String(error));
    });

    this.activeNativeTranscriptions.set(source.id, next);
    await next;
  }

  private async handleTranscriptEvent(event: TranscriptEvent): Promise<void> {
    if (!this.activeSession) {
      return;
    }

    this.activeSession.visibleTranscriptEvents.push({ ...event });
    applyTranscriptDisplayEvent(this.activeSession.displayTranscript, event);

    const lastPending = this.activeSession.pendingTranscriptEvents[this.activeSession.pendingTranscriptEvents.length - 1];
    if (event.replaceLast && lastPending && lastPending.sourceId === event.sourceId && !lastPending.chunkId) {
      let tailIndex = -1;
      for (let index = this.activeSession.latestTranscriptTail.length - 1; index >= 0; index -= 1) {
        const entry = this.activeSession.latestTranscriptTail[index];
        if (entry.sourceId === event.sourceId && !entry.chunkId) {
          tailIndex = index;
          break;
        }
      }
      if (tailIndex >= 0) {
        this.activeSession.latestTranscriptTail[tailIndex] = event;
      } else {
        this.activeSession.latestTranscriptTail.push(event);
      }
    } else {
      this.activeSession.latestTranscriptTail.push(event);
    }

    this.activeSession.pendingTranscriptEvents.push(event);

    this.activeSession.latestTranscriptTail = this.activeSession.latestTranscriptTail.slice(-this.config.transcriptTailSize);
    await this.fileStore.appendJsonl(this.activeSession.id, "transcript.events.jsonl", event);

    const chunk = this.buildChunk(false);
    if (chunk) {
      await this.runAnalysis(chunk);
      return;
    }

    await this.writeSessionArtifacts();
  }

  private buildChunk(force: boolean): TranscriptChunk | null {
    if (!this.activeSession || this.activeSession.pendingTranscriptEvents.length === 0) {
      return null;
    }

    const thresholds = sensitivityDefaults[this.config.chunkSensitivity];
    const wordThreshold = this.runtimeConfig.chunkWordThreshold ?? thresholds.words;
    const timeThresholdSeconds = this.runtimeConfig.chunkTimeThresholdSeconds ?? thresholds.seconds;
    const startedAt = Date.parse(this.activeSession.pendingTranscriptEvents[0].timestamp);
    const endedAt = Date.parse(this.activeSession.pendingTranscriptEvents[this.activeSession.pendingTranscriptEvents.length - 1].timestamp);
    const text = createChunkText(this.activeSession.pendingTranscriptEvents);
    if (!text) {
      if (force) {
        this.activeSession.pendingTranscriptEvents.splice(0);
      }
      return null;
    }
    const words = wordCount(text);
    const meaningfulWords = meaningfulWordCount(text);
    const durationSeconds = Math.max(0, Math.round((endedAt - startedAt) / 1000));
    const sentenceComplete = /[.!?]["']?$/.test(text);
    const sentenceThreshold = sentenceCompletionWordThresholds[this.config.chunkSensitivity];

    if (force && meaningfulWords < 5) {
      this.activeSession.pendingTranscriptEvents.splice(0);
      return null;
    }

    if (!force && !(meaningfulWords >= wordThreshold || durationSeconds >= timeThresholdSeconds || (sentenceComplete && meaningfulWords >= sentenceThreshold))) {
      return null;
    }

    const events = this.activeSession.pendingTranscriptEvents.splice(0);
    const chunkId = createChunkId(this.activeSession);
    for (const event of events) {
      event.chunkId = chunkId;
    }

    const chunk: TranscriptChunk = {
      id: chunkId,
      startedAt: events[0].timestamp,
      endedAt: events[events.length - 1].timestamp,
      text,
      wordCount: words,
      eventIds: events.map((event) => event.id)
    };

    this.activeSession.chunks.push(chunk);
    return chunk;
  }

  private async finalizePendingChunk(analyze: boolean): Promise<void> {
    const chunk = this.buildChunk(true);
    if (!chunk || !this.activeSession) {
      return;
    }

    if (analyze) {
      await this.runAnalysis(chunk);
      return;
    }

    await this.fileStore.appendJsonl(this.activeSession.id, "transcript.chunks.jsonl", chunk);
  }

  private async runAnalysis(chunk: TranscriptChunk): Promise<void> {
    if (!this.activeSession) {
      return;
    }

    const session = this.activeSession;
    const sessionId = session.id;

    await this.fileStore.appendJsonl(sessionId, "transcript.chunks.jsonl", chunk);

    const provider = this.analysisProviders.get(session.analysisProvider);
    if (!provider) {
      this.activeSession.lastError = `Unknown analysis provider ${session.analysisProvider}.`;
      await this.writeSessionArtifacts();
      return;
    }

    const requestPayload = {
      chunkId: chunk.id,
      sessionId,
      unresolvedTopics: Object.values(session.topics)
        .filter((topic) => topic.currentState === "pending" || topic.currentState === "partial")
        .map((topic) => ({
          id: topic.id,
          text: topic.text,
          state: topic.currentState
        })),
      chunk,
      promptPreview: buildAnalysisPrompt(session, chunk, this.config)
    };
    await this.fileStore.appendJsonl(sessionId, "analysis.requests.jsonl", requestPayload);

    try {
      const result = await provider.analyze({
        chunk,
        session: cloneSession(session),
        config: this.config
      });
      const response = codexAnalysisResponseSchema.parse(result.response);
      const rawResponsePath = await this.fileStore.appendJsonl(sessionId, "analysis.responses.jsonl", {
        recordedAt: nowIso(),
        latencyMs: result.latencyMs,
        response
      });

      if (!this.activeSession || this.activeSession.id !== sessionId) {
        return;
      }

      const lowSignalChunk = isLowSignalTranscript(chunk.text);
      const applied: TopicDecision[] = [];
      const proposed: TopicDecision[] = [];
      const recordedAt = nowIso();
      const nextPassCount = this.activeSession.passCount + 1;

      for (const decision of response.topicDecisions) {
        const currentTopic = this.activeSession.topics[decision.topicId];
        if (lowSignalChunk && currentTopic && shouldPreserveTopicStateOnLowSignal(currentTopic.currentState, decision.suggestedState)) {
          continue;
        }

        if (decision.confidence >= this.config.analysisAutoApplyThreshold) {
          this.applyDirectState(decision.topicId, decision.suggestedState, "analysis", decision.confidence, decision.rationale, decision.evidence.map((item) => item.excerpt));
          applied.push(decision);
        } else {
          proposed.push(decision);
        }
      }

      this.activeSession.pendingDecisions = proposed;
      this.activeSession.suggestions = response.suggestions;
      this.activeSession.offTopicObservations = response.offTopicObservations;
      this.activeSession.warnings = response.warnings;
      this.activeSession.latestAnalysisAt = recordedAt;
      try {
        this.applyRevisitableThemeDelta(response.revisitableThemes, recordedAt, nextPassCount);
      } catch (error) {
        this.activeSession.warnings = [
          ...this.activeSession.warnings,
          {
            code: "revisitable-theme-apply-failed",
            message: error instanceof Error ? error.message : String(error),
            topicId: null
          }
        ];
      }
      this.mergeLivePrompts(response, recordedAt);
      this.activeSession.passCount = nextPassCount;
      this.refreshRevisitableThemeStatuses(recordedAt, this.activeSession.passCount);
      this.activeSession.analyses.push({
        chunkId: chunk.id,
        latencyMs: result.latencyMs,
        response,
        appliedDecisions: applied,
        proposedDecisions: proposed,
        recordedAt,
        rawResponsePath
      });
      this.activeSession.lastError = null;
      await this.writeSessionArtifacts(result.rawResponse);
    } catch (error) {
      if (!this.activeSession || this.activeSession.id !== sessionId) {
        return;
      }

      const message = error instanceof Error ? error.message : String(error);
      this.activeSession.lastError = `Analysis failed for ${chunk.id}: ${message}`;
      await this.writeSessionArtifacts();
    }
  }

  private upsertLivePrompt(
    kind: LivePromptKind,
    prompt: Suggestion | OffTopicObservation,
    chunkId: string,
    recordedAt: string
  ): void {
    if (!this.activeSession) {
      return;
    }

    const text = "text" in prompt ? prompt.text : prompt.label;
    const topicId = "topicId" in prompt ? prompt.topicId : null;
    const promptId = createLivePromptId(kind, text, topicId);
    const existing = this.activeSession.livePrompts.find((item) => item.id === promptId);

    if (existing?.dismissedAt) {
      return;
    }

    if (existing) {
      existing.text = text;
      existing.confidence = prompt.confidence;
      existing.rationale = prompt.rationale;
      existing.topicId = topicId;
      existing.lastSeenAt = recordedAt;
      existing.lastChunkId = chunkId;
      return;
    }

    this.activeSession.livePrompts.push({
      id: promptId,
      kind,
      text,
      confidence: prompt.confidence,
      rationale: prompt.rationale,
      topicId,
      firstSeenAt: recordedAt,
      lastSeenAt: recordedAt,
      lastChunkId: chunkId,
      dismissedAt: null
    });
  }

  private mergeLivePrompts(response: CodexAnalysisResponse, recordedAt: string): void {
    response.suggestions.activeTopics.forEach((prompt) => this.upsertLivePrompt("active", prompt, response.chunkId, recordedAt));
    response.suggestions.elaborationStarters.forEach((prompt) => this.upsertLivePrompt("elaboration", prompt, response.chunkId, recordedAt));
    response.suggestions.adjacentNextTopics.forEach((prompt) => this.upsertLivePrompt("next", prompt, response.chunkId, recordedAt));
    response.suggestions.recoveryPrompts.forEach((prompt) => this.upsertLivePrompt("recovery", prompt, response.chunkId, recordedAt));
    response.offTopicObservations.forEach((prompt) => this.upsertLivePrompt("off-topic", prompt, response.chunkId, recordedAt));

    if (!this.activeSession) {
      return;
    }

    this.activeSession.livePrompts.sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt));
  }

  private applyDirectState(
    topicId: string,
    nextState: TopicState,
    origin: "user" | "analysis",
    confidence: number,
    rationale?: string,
    evidenceRefs: string[] = []
  ): void {
    if (!this.activeSession) {
      return;
    }

    const topic = this.activeSession.topics[topicId];
    if (!topic) {
      throw new Error(`Unknown topic ${topicId}.`);
    }

    const previousState = topic.currentState;
    topic.directState = nextState;
    topic.currentState = nextState;
    topic.stateSetBy = origin;
    topic.confidenceAtLastChange = confidence;
    topic.evidenceRefs = evidenceRefs;
    topic.lastUpdatedAt = nowIso();

    this.activeSession.actionHistory.push({
      topicId,
      previousState,
      nextState,
      origin,
      confidence,
      rationale,
      occurredAt: topic.lastUpdatedAt
    });

    void this.fileStore.appendStateChange(this.activeSession.id, {
      topicId,
      previousState,
      nextState,
      origin,
      confidence,
      rationale,
      occurredAt: topic.lastUpdatedAt
    });
    this.refreshInferredParentStates();
  }

  private refreshInferredParentStates(): void {
    if (!this.activeSession) {
      return;
    }

    const topics = Object.values(this.activeSession.topics).sort((left, right) => right.originalOrder - left.originalOrder);

    for (const topic of topics) {
      if (topic.children.length === 0) {
        if (topic.directState === null) {
          topic.currentState = "pending";
          topic.stateSetBy = "inferred";
        }
        continue;
      }

      const childTopics = topic.children.map((childId) => this.activeSession?.topics[childId]).filter(Boolean) as TopicRecord[];
      const previousState = topic.currentState;
      const inferredState = inferredTopicStateFromChildren(childTopics);

      if (topic.directState === "covered" || topic.directState === "dismissed" || topic.directState === "snoozed") {
        topic.currentState = topic.directState;
        topic.stateSetBy = topic.stateSetBy === "user" || topic.stateSetBy === "analysis" ? topic.stateSetBy : "analysis";
        continue;
      }

      if (topic.directState === "partial" || topic.directState === "pending") {
        const effectiveState = strongerTopicState(topic.directState, inferredState);
        topic.currentState = effectiveState;
        topic.stateSetBy = effectiveState === topic.directState
          ? (topic.stateSetBy === "user" || topic.stateSetBy === "analysis" ? topic.stateSetBy : "analysis")
          : "inferred";
      } else {
        topic.currentState = inferredState;
        topic.stateSetBy = "inferred";
      }

      if (previousState !== topic.currentState) {
        topic.lastUpdatedAt = nowIso();
        void this.fileStore.appendStateChange(this.activeSession.id, {
          topicId: topic.id,
          previousState,
          nextState: topic.currentState,
          origin: "inferred",
          confidence: null,
          rationale: "Parent topic state inferred from child beats",
          occurredAt: topic.lastUpdatedAt
        });
      }
    }
  }

  private applyRevisitableThemeDelta(delta: RevisitableThemeDelta, recordedAt: string, passCount: number): void {
    if (!this.activeSession) {
      return;
    }

    for (const upsert of delta.upserts) {
      const existing = upsert.themeId
        ? this.activeSession.revisitableThemes.find((theme) => theme.id === upsert.themeId)
        : null;

      if (existing?.manualState === "dismissed") {
        continue;
      }

      const theme = existing ?? {
        id: createThemeId(this.activeSession),
        label: upsert.label,
        summary: upsert.summary,
        supportingMoments: [],
        interviewerQuestions: [],
        confidence: upsert.confidence,
        rationale: upsert.rationale,
        sourceChunkIds: [],
        firstSeenAt: recordedAt,
        lastUpdatedAt: recordedAt,
        lastReinforcedAt: recordedAt,
        lastReinforcedPass: passCount,
        modelPromptEligible: false,
        promptEligible: false,
        status: "active" as const,
        pinnedAt: null,
        dismissedAt: null,
        manualState: null
      };

      theme.label = upsert.label;
      theme.summary = upsert.summary;
      theme.supportingMoments = uniqueStrings(
        [
          ...upsert.supportingMoments,
          ...upsert.evidence.map((item) => item.excerpt)
        ],
        MAX_THEME_MOMENTS
      );
      theme.interviewerQuestions = uniqueStrings(upsert.interviewerQuestions, 2);
      theme.confidence = upsert.confidence;
      theme.rationale = upsert.rationale;
      theme.sourceChunkIds = uniqueStrings(
        [...theme.sourceChunkIds, ...upsert.evidence.map((item) => item.chunkId)],
        MAX_REVISITABLE_THEMES * 4
      );
      theme.lastUpdatedAt = recordedAt;
      theme.lastReinforcedAt = recordedAt;
      theme.lastReinforcedPass = passCount;
      theme.modelPromptEligible = upsert.promptEligible;
      theme.dismissedAt = theme.manualState === "dismissed" ? theme.dismissedAt ?? recordedAt : null;

      if (!existing) {
        this.activeSession.revisitableThemes.push(theme);
      }
    }

    for (const merge of delta.merges) {
      const sourceIndex = this.activeSession.revisitableThemes.findIndex((theme) => theme.id === merge.fromThemeId);
      const target = this.activeSession.revisitableThemes.find((theme) => theme.id === merge.intoThemeId);
      if (sourceIndex < 0 || !target || merge.fromThemeId === merge.intoThemeId) {
        continue;
      }

      const [source] = this.activeSession.revisitableThemes.splice(sourceIndex, 1);
      if (!source) {
        continue;
      }

      target.supportingMoments = uniqueStrings(
        [...target.supportingMoments, ...source.supportingMoments],
        MAX_THEME_MOMENTS
      );
      target.sourceChunkIds = uniqueStrings(
        [...target.sourceChunkIds, ...source.sourceChunkIds],
        MAX_REVISITABLE_THEMES * 4
      );
      target.confidence = Math.max(target.confidence, source.confidence);
      target.rationale = merge.rationale || target.rationale;
      target.lastUpdatedAt = recordedAt;
      target.lastReinforcedAt = recordedAt;
      target.lastReinforcedPass = Math.max(target.lastReinforcedPass, source.lastReinforcedPass, passCount);
      target.modelPromptEligible = target.modelPromptEligible || source.modelPromptEligible;
      if (!target.pinnedAt && source.pinnedAt) {
        target.pinnedAt = source.pinnedAt;
        target.manualState = "pinned";
      }
    }

    this.refreshRevisitableThemeStatuses(recordedAt, passCount);
    this.enforceRevisitableThemeLimit();
  }

  private refreshRevisitableThemeStatuses(recordedAt: string, passCount: number): void {
    if (!this.activeSession) {
      return;
    }

    for (const theme of this.activeSession.revisitableThemes) {
      if (theme.manualState === "dismissed" || theme.dismissedAt) {
        theme.status = "dismissed";
        theme.promptEligible = false;
        theme.dismissedAt ??= recordedAt;
        continue;
      }

      if (theme.pinnedAt) {
        theme.status = "active";
        theme.promptEligible = true;
        continue;
      }

      const dormantByPass = passCount - theme.lastReinforcedPass >= THEME_DORMANT_AFTER_PASSES;
      const dormantByTime = Date.parse(recordedAt) - Date.parse(theme.lastReinforcedAt) >= THEME_DORMANT_AFTER_MS;
      theme.status = dormantByPass || dormantByTime ? "dormant" : "active";
      theme.promptEligible = theme.status === "active" && theme.modelPromptEligible;
    }

    this.activeSession.revisitableThemes.sort(compareThemes);
  }

  private enforceRevisitableThemeLimit(): void {
    if (!this.activeSession) {
      return;
    }

    const pinned = this.activeSession.revisitableThemes.filter((theme) => theme.pinnedAt);
    const dismissed = this.activeSession.revisitableThemes.filter((theme) => theme.status === "dismissed");
    const remainder = this.activeSession.revisitableThemes
      .filter((theme) => !theme.pinnedAt && theme.status !== "dismissed")
      .slice(0, Math.max(0, MAX_REVISITABLE_THEMES - pinned.length));

    this.activeSession.revisitableThemes = [
      ...pinned,
      ...remainder,
      ...dismissed
    ].sort(compareThemes);
  }

  private async generateSessionRecapForActiveSession(): Promise<void> {
    if (!this.activeSession) {
      return;
    }

    const provider = this.analysisProviders.get(this.activeSession.analysisProvider);
    const sessionDir = this.fileStore.sessionDir(this.activeSession.id);
    const recapJsonPath = path.join(sessionDir, "session-recap.json");
    const recapMarkdownPath = path.join(sessionDir, "session-recap.md");

    try {
      const recap = provider?.generateSessionRecap
        ? await provider.generateSessionRecap({
          session: cloneSession(this.activeSession),
          config: this.config
        })
        : {
          response: this.buildFallbackSessionRecap(),
          rawResponse: JSON.stringify(this.buildFallbackSessionRecap(), null, 2),
          latencyMs: 0
        };
      const generatedAt = nowIso();

      this.activeSession.sessionRecap = {
        status: "ready",
        generatedAt,
        jsonPath: recapJsonPath,
        markdownPath: recapMarkdownPath,
        overview: recap.response.overview,
        preparedTopicsCovered: recap.response.preparedTopicsCovered,
        otherThemesDiscussed: recap.response.otherThemesDiscussed,
        poignantMoments: recap.response.poignantMoments,
        futureFollowUps: recap.response.futureFollowUps,
        error: null
      };

      await this.fileStore.writeFile(recapJsonPath, JSON.stringify(this.activeSession.sessionRecap, null, 2));
      await this.fileStore.writeFile(recapMarkdownPath, buildSessionRecapMarkdown(this.activeSession, this.activeSession.sessionRecap));
      await this.fileStore.appendJsonl(this.activeSession.id, "analysis.responses.jsonl", {
        recordedAt: generatedAt,
        latencyMs: recap.latencyMs,
        response: recap.response,
        kind: "session-recap"
      });
    } catch (error) {
      this.activeSession.sessionRecap = {
        ...createEmptySessionRecap(),
        status: "failed",
        generatedAt: nowIso(),
        jsonPath: recapJsonPath,
        markdownPath: recapMarkdownPath,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  private buildFallbackSessionRecap(): SessionRecap["overview"] extends string[] ? {
    schemaVersion: "codexSessionRecap.v1";
    overview: string[];
    preparedTopicsCovered: string[];
    otherThemesDiscussed: string[];
    poignantMoments: string[];
    futureFollowUps: string[];
  } : never {
    if (!this.activeSession) {
      throw new Error("No active session.");
    }

    const covered = Object.values(this.activeSession.topics)
      .filter((topic) => topic.currentState === "covered" && !topic.parentId)
      .map((topic) => topic.text)
      .slice(0, 8);
    const themes = this.activeSession.revisitableThemes
      .filter((theme) => theme.status !== "dismissed")
      .map((theme) => theme.label)
      .slice(0, 8);

    return {
      schemaVersion: "codexSessionRecap.v1",
      overview: this.activeSession.sessionSummary.bullets.slice(0, 3),
      preparedTopicsCovered: covered,
      otherThemesDiscussed: themes,
      poignantMoments: this.activeSession.revisitableThemes.flatMap((theme) => theme.supportingMoments.slice(0, 1)).slice(0, 5),
      futureFollowUps: themes.slice(0, 4).map((theme) => `Revisit ${theme} with one concrete follow-up question.`)
    };
  }

  private async writeSessionArtifacts(rawResponse?: string): Promise<void> {
    if (!this.activeSession) {
      return;
    }

    this.refreshRevisitableThemeStatuses(nowIso(), this.activeSession.passCount);
    this.activeSession.sessionSummary = deriveSessionSummary(this.activeSession, nowIso());

    const proposedMarkdown = buildProposedMarkdown(this.activeSession);
    await this.fileStore.writeProposedMarkdown(this.activeSession, proposedMarkdown);

    if (rawResponse) {
      await this.fileStore.appendJsonl(this.activeSession.id, "analysis.raw.jsonl", {
        recordedAt: nowIso(),
        rawResponse
      });
    }

    await this.fileStore.saveSession(this.activeSession);
  }

  private async exportTranscriptArtifacts(session: SessionSnapshot): Promise<void> {
    const approximateSrt = buildApproximateSrt(session);
    await this.fileStore.writeFile(session.approximateTranscriptSrtPath ?? path.join(this.fileStore.sessionDir(session.id), "transcript.approx.srt"), approximateSrt);

    if (session.sttProvider !== "whisper") {
      session.finalTranscriptSrtPath = session.approximateTranscriptSrtPath;
      return;
    }

    session.finalTranscriptSrtPath = session.approximateTranscriptSrtPath;
    const provider = this.sttProviders.get(session.sttProvider);
    if (!provider?.transcribeFile) {
      return;
    }

    const sourcesWithAudio = Object.entries(session.recordedAudioPaths).filter(([, paths]) => paths.length > 0);
    for (const [sourceId, paths] of sourcesWithAudio) {
      const latestPath = paths[paths.length - 1];
      if (!latestPath) {
        continue;
      }

      session.recordedAudioPath = latestPath;
      const outputBase = path.join(sourceArtifactsDir(this.fileStore.sessionDir(session.id), sourceId), "transcript.final");
      const whisperCliPath = path.join(path.dirname(this.runtimeConfig.sttExecutable), "whisper-cli");
      try {
        const { spawn } = await import("node:child_process");
        await new Promise<void>((resolve, reject) => {
          const child = spawn(whisperCliPath, [
            "-m",
            this.runtimeConfig.whisperModel,
            "-f",
            latestPath,
            "-osrt",
            "-ojf",
            "-sow",
            "-of",
            outputBase,
            "-np"
          ], {
            stdio: ["ignore", "pipe", "pipe"]
          });

          let stderr = "";
          child.stderr.setEncoding("utf8");
          child.stderr.on("data", (chunk: string) => {
            stderr += chunk;
          });

          child.on("error", reject);
          child.on("exit", (code) => {
            if (code === 0) {
              resolve();
              return;
            }

            reject(new Error(stderr.trim() || `whisper-cli exited with code ${code}`));
          });
        });
      } catch (error) {
        session.lastError = `${session.lastError ? `${session.lastError} · ` : ""}Final subtitle export failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
  }
}

function dedupeSources(sources: CaptureSourceDescriptor[]): CaptureSourceDescriptor[] {
  const map = new Map<string, CaptureSourceDescriptor>();
  for (const source of sources) {
    map.set(source.id, source);
  }
  return Array.from(map.values()).sort((left, right) => {
    if (left.groupLabel === right.groupLabel) {
      return left.name.localeCompare(right.name);
    }
    return left.groupLabel.localeCompare(right.groupLabel);
  });
}

function buildDiagnostics(source: CaptureSourceDescriptor, provider: string): string[] {
  const diagnostics = [
    `Selected source: ${source.name}`,
    `Kind: ${source.kind}`,
    `Transport: ${source.transport}`
  ];

  if (source.kind === "system-mix") {
    diagnostics.push("Desktop Audio expects a routed loopback input such as BlackHole.");
  }
  if (provider === "whisper" && source.inputDeviceId) {
    diagnostics.push(`Whisper capture id: ${source.inputDeviceId}`);
  }
  if (source.bundleId) {
    diagnostics.push(`Bundle id: ${source.bundleId}`);
  }
  if (source.available === false && source.availabilityReason) {
    diagnostics.push(`Unavailable: ${source.availabilityReason}`);
  }
  if (source.details) {
    diagnostics.push(source.details);
  }

  return diagnostics;
}

async function openPrivacyPane(target: string): Promise<void> {
  try {
    await execFileAsync("open", [target]);
  } catch {
    // Best-effort only. State refresh after this still tells the UI whether permission changed.
  }
}
