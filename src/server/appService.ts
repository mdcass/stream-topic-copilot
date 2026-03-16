import fs from "node:fs/promises";
import path from "node:path";

import { codexAnalysisResponseSchema } from "./domain/analysis/schema.js";
import { buildApproximateSrt } from "./domain/transcript/subtitles.js";
import {
  createDefaultAppConfig,
  createEmptySuggestions,
  type AppConfig,
  type AppStateResponse,
  type ChunkSensitivity,
  type MicrophoneDevice,
  type MicrophoneMonitorState,
  type RuntimeConfig,
  type SessionSnapshot,
  type TopicRecord,
  type TopicState,
  type TopicStateChange,
  type TranscriptChunk,
  type TranscriptEvent
} from "./domain/types.js";
import type { TopicDecision } from "./domain/analysis/schema.js";
import { parseTopicsMarkdown } from "./domain/topics/markdownParser.js";
import { buildProposedMarkdown } from "./domain/topics/proposedMarkdown.js";
import { FileStore } from "./infra/fileStore.js";
import { getMicrophonePermissionState } from "./infra/microphonePermission.js";
import { MicrophoneProbe } from "./infra/microphoneProbe.js";
import type { AnalysisProvider } from "./providers/analysis/providerTypes.js";
import type { SttProvider, SttProviderSession } from "./providers/stt/providerTypes.js";

const sensitivityDefaults: Record<ChunkSensitivity, { words: number; seconds: number; }> = {
  low: { words: 200, seconds: 120 },
  medium: { words: 120, seconds: 60 },
  high: { words: 50, seconds: 30 }
};

function nowIso(): string {
  return new Date().toISOString();
}

function wordCount(value: string): number {
  return value.trim().split(/\s+/).filter(Boolean).length;
}

function createSessionId(): string {
  const date = new Date().toISOString().slice(0, 10);
  const slug = Math.floor(Math.random() * 0xffff).toString(16).padStart(4, "0");
  return `${date}-${slug}`;
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

export class AppService {
  private readonly fileStore: FileStore;
  private readonly microphoneProbe: MicrophoneProbe;
  private activeSession: SessionSnapshot | null = null;
  private activeSttSession: SttProviderSession | null = null;
  private config!: AppConfig;
  private microphones: MicrophoneDevice[] = [];
  private activeProbeSelectionKey: string | null = null;
  private microphoneMonitor: MicrophoneMonitorState;

  constructor(
    private readonly runtimeConfig: RuntimeConfig,
    private readonly sttProviders: Map<string, SttProvider>,
    private readonly analysisProviders: Map<string, AnalysisProvider>
  ) {
    this.fileStore = new FileStore(runtimeConfig);
    this.microphoneProbe = new MicrophoneProbe(runtimeConfig);
    this.microphoneMonitor = {
      provider: runtimeConfig.sttProvider,
      selectedDeviceId: null,
      selectedDeviceName: null,
      level: 0,
      probeStatus: "idle",
      probeLastUpdatedAt: null,
      probeError: null,
      whisperExecutable: runtimeConfig.sttExecutable || null,
      whisperModel: runtimeConfig.whisperModel || null,
      whisperCaptureId: null,
      whisperLastError: null,
      deviceDiagnostics: []
    };
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
    await this.refreshMicrophonesAndMonitor();
  }

  async getState(): Promise<AppStateResponse> {
    const [microphones, microphonePermission, sessions] = await Promise.all([
      this.refreshMicrophonesAndMonitor(),
      getMicrophonePermissionState(this.runtimeConfig),
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
        availableProviders: {
          stt: Array.from(this.sttProviders.keys()),
          analysis: Array.from(this.analysisProviders.keys())
        }
      },
      microphonePermission,
      microphones,
      microphoneMonitor: this.microphoneMonitor,
      resumableSessions,
      history,
      activeSession: this.activeSession
    };
  }

  getActiveSession(): SessionSnapshot | null {
    return this.activeSession ? cloneSession(this.activeSession) : null;
  }

  async updateConfig(nextConfig: Partial<AppConfig>): Promise<AppConfig> {
    this.config = {
      ...this.config,
      ...nextConfig,
      visibleSuggestionCounts: {
        ...this.config.visibleSuggestionCounts,
        ...(nextConfig.visibleSuggestionCounts ?? {})
      }
    };
    await this.fileStore.saveConfig(this.config);

    await this.refreshMicrophonesAndMonitor();

    if (this.activeSession && (nextConfig.microphoneId !== undefined || nextConfig.sttProvider !== undefined)) {
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
    const sessionId = createSessionId();
    const artifacts = await this.fileStore.createSessionArtifacts(sessionId, sourceMarkdown);
    const topics = Object.fromEntries(Object.values(document.topics).map((topic) => [topic.id, createTopicRecord(topic)]));
    const session: SessionSnapshot = {
      id: sessionId,
      sourceMarkdownPath: this.config.markdownFilePath,
      sourceSnapshotPath: artifacts.sourceSnapshotPath,
      sourceContentHash: this.fileStore.hashContent(sourceMarkdown),
      startedAt: nowIso(),
      endedAt: null,
      sttProvider: this.config.sttProvider,
      analysisProvider: this.config.analysisProvider,
      microphoneSelection: this.config.microphoneId,
      status: "active",
      latestTranscriptTail: [],
      visibleTranscriptEvents: [],
      latestAnalysisAt: null,
      proposedMarkdownPath: artifacts.proposedMarkdownPath,
      liveTranscriptPath: path.join(artifacts.sessionDir, "live-transcript.txt"),
      recordedAudioPath: null,
      approximateTranscriptSrtPath: path.join(artifacts.sessionDir, "transcript.approx.srt"),
      finalTranscriptSrtPath: null,
      chunkSensitivity: this.config.chunkSensitivity,
      document,
      topics,
      chunks: [],
      pendingTranscriptEvents: [],
      analyses: [],
      suggestions: createEmptySuggestions(),
      offTopicObservations: [],
      warnings: [],
      pendingDecisions: [],
      actionHistory: [],
      passCount: 0,
      microphoneLevel: 0,
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
    await this.refreshMicrophonesAndMonitor();
    await this.writeSessionArtifacts();
    await this.startSttForActiveSession();
    return cloneSession(this.activeSession);
  }

  async endSession(status: "finished" | "interrupted" = "finished"): Promise<SessionSnapshot | null> {
    if (!this.activeSession) {
      return null;
    }

    if (this.activeSttSession) {
      await this.activeSttSession.stop().catch(() => undefined);
      this.activeSttSession = null;
    }

    this.activeSession.status = status;
    this.activeSession.endedAt = nowIso();
    await this.finalizePendingChunk(true);
    await this.exportTranscriptArtifacts(this.activeSession);
    await this.writeSessionArtifacts();
    await this.fileStore.writeFile(
      path.join(this.fileStore.sessionDir(this.activeSession.id), "session-summary.json"),
      JSON.stringify({
        id: this.activeSession.id,
        startedAt: this.activeSession.startedAt,
        endedAt: this.activeSession.endedAt,
        countsByState: summarizeCounts(this.activeSession.topics),
        analyses: this.activeSession.analyses.length,
        transcriptChunks: this.activeSession.chunks.length
      }, null, 2)
    );

    const finished = cloneSession(this.activeSession);
    this.activeSession = null;
    await this.refreshMicrophonesAndMonitor();
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

  async injectMockTranscript(text: string): Promise<SessionSnapshot> {
    if (!this.activeSession) {
      throw new Error("No active session.");
    }

    if (!this.activeSttSession?.injectTranscript) {
      throw new Error("The active STT provider does not support transcript injection.");
    }

    await this.activeSttSession.injectTranscript(text);
    return cloneSession(this.activeSession);
  }

  private async refreshMicrophonesAndMonitor(): Promise<MicrophoneDevice[]> {
    const provider = this.sttProviders.get(this.config.sttProvider) ?? this.sttProviders.get(this.runtimeConfig.sttProvider);
    if (!provider) {
      this.microphones = [];
      this.microphoneMonitor.provider = this.config.sttProvider;
      this.microphoneMonitor.probeStatus = "unsupported";
      this.microphoneMonitor.deviceDiagnostics = [`Unknown STT provider: ${this.config.sttProvider}`];
      return [];
    }

    const devices = await provider.listDevices();
    this.microphones = await this.microphoneProbe.annotateDevices(devices);

    const selectedDevice = this.microphones.find((device) => device.id === this.config.microphoneId) ?? null;
    this.microphoneMonitor.provider = this.config.sttProvider;
    this.microphoneMonitor.selectedDeviceId = this.config.microphoneId;
    this.microphoneMonitor.selectedDeviceName = selectedDevice?.name ?? null;
    this.microphoneMonitor.whisperCaptureId = this.config.sttProvider === "whisper" ? this.config.microphoneId : null;
    this.microphoneMonitor.whisperExecutable = this.config.sttProvider === "whisper" ? (this.runtimeConfig.sttExecutable || null) : null;
    this.microphoneMonitor.whisperModel = this.config.sttProvider === "whisper" ? (this.runtimeConfig.whisperModel || null) : null;

    const debugState = provider.getDebugState?.() ?? {};
    this.microphoneMonitor.whisperLastError = debugState.whisperLastError ?? this.microphoneMonitor.whisperLastError;
    const diagnostics: string[] = [];
    if (selectedDevice) {
      diagnostics.push(`Selected device: ${selectedDevice.name} (capture id ${selectedDevice.id})`);
      if (selectedDevice.probeId) {
        diagnostics.push("Native activity probe mapped successfully.");
      } else {
        diagnostics.push("Native activity probe could not map this device by name.");
      }
    } else if (this.config.microphoneId) {
      diagnostics.push(`Configured microphone id ${this.config.microphoneId} is not present in the current device list.`);
    } else {
      diagnostics.push("No microphone selected.");
    }
    if (debugState.whisperDeviceEnumerationError) {
      diagnostics.push(`Whisper device enumeration error: ${debugState.whisperDeviceEnumerationError}`);
    }
    if (debugState.whisperExecutable) {
      diagnostics.push(`Whisper executable: ${debugState.whisperExecutable}`);
    }
    if (debugState.whisperModel) {
      diagnostics.push(`Whisper model: ${debugState.whisperModel}`);
    }
    this.microphoneMonitor.deviceDiagnostics = diagnostics;

    await this.refreshMicrophoneProbe(selectedDevice);
    return this.microphones;
  }

  private async startSttForActiveSession(): Promise<void> {
    if (!this.activeSession) {
      return;
    }

    const provider = this.sttProviders.get(this.activeSession.sttProvider);
    if (!provider) {
      throw new Error(`Unknown STT provider ${this.activeSession.sttProvider}.`);
    }

    this.activeSttSession = await provider.start(
      {
        microphoneId: this.activeSession.microphoneSelection,
        sessionDir: this.fileStore.sessionDir(this.activeSession.id),
        liveTranscriptPath: this.activeSession.liveTranscriptPath ?? undefined
      },
      {
        onTranscript: async (event) => this.handleTranscriptEvent(event),
        onLevel: async (level) => this.handleLevel(level),
        onError: async (error) => this.handleProviderError(error)
      }
    );
    this.microphoneMonitor.whisperCaptureId = this.activeSession.microphoneSelection;
  }

  private async restartStt(): Promise<void> {
    if (!this.activeSession) {
      return;
    }

    if (this.activeSttSession) {
      await this.activeSttSession.stop().catch(() => undefined);
      this.activeSttSession = null;
    }

    this.activeSession.microphoneSelection = this.config.microphoneId;
    this.activeSession.sttProvider = this.config.sttProvider;
    await this.refreshMicrophonesAndMonitor();
    await this.startSttForActiveSession();
    await this.writeSessionArtifacts();
  }

  private async handleLevel(level: number): Promise<void> {
    this.microphoneMonitor.level = level;
    this.microphoneMonitor.probeLastUpdatedAt = nowIso();
    if (this.activeSession) {
      this.activeSession.microphoneLevel = level;
    }
  }

  private async handleProviderError(error: Error): Promise<void> {
    this.microphoneMonitor.whisperLastError = error.message;
    if (!this.activeSession) {
      return;
    }

    this.activeSession.lastError = error.message;
    await this.writeSessionArtifacts();
  }

  private async refreshMicrophoneProbe(selectedDevice: MicrophoneDevice | null): Promise<void> {
    if (this.config.sttProvider !== "whisper") {
      if (this.activeProbeSelectionKey !== null) {
        await this.microphoneProbe.stop();
        this.activeProbeSelectionKey = null;
      }
      this.microphoneMonitor.level = 0;
      this.microphoneMonitor.probeStatus = "idle";
      this.microphoneMonitor.probeError = null;
      return;
    }

    if (!selectedDevice) {
      if (this.activeProbeSelectionKey !== null) {
        await this.microphoneProbe.stop();
        this.activeProbeSelectionKey = null;
      }
      this.microphoneMonitor.level = 0;
      this.microphoneMonitor.probeStatus = "idle";
      this.microphoneMonitor.probeError = "Select a microphone to start the activity probe.";
      return;
    }

    if (!selectedDevice.probeId) {
      if (this.activeProbeSelectionKey !== `${selectedDevice.id}:unmapped`) {
        await this.microphoneProbe.stop();
      }
      this.activeProbeSelectionKey = `${selectedDevice.id}:unmapped`;
      this.microphoneMonitor.level = 0;
      this.microphoneMonitor.probeStatus = "error";
      this.microphoneMonitor.probeError = `No native probe mapping found for ${selectedDevice.name}.`;
      return;
    }

    const nextSelectionKey = `${selectedDevice.id}:${selectedDevice.probeId}`;
    if (this.activeProbeSelectionKey === nextSelectionKey) {
      return;
    }

    this.microphoneMonitor.probeStatus = "running";
    this.microphoneMonitor.probeError = null;
    await this.microphoneProbe.start(selectedDevice, {
      onLevel: (level) => {
        this.microphoneMonitor.level = level;
        this.microphoneMonitor.probeLastUpdatedAt = nowIso();
        if (this.activeSession) {
          this.activeSession.microphoneLevel = level;
        }
      },
      onError: (message) => {
        this.microphoneMonitor.probeStatus = "error";
        this.microphoneMonitor.probeError = message;
      }
    });
    this.activeProbeSelectionKey = nextSelectionKey;
  }

  private async handleTranscriptEvent(event: TranscriptEvent): Promise<void> {
    if (!this.activeSession) {
      return;
    }

    this.activeSession.visibleTranscriptEvents.push({ ...event });

    if (event.replaceLast && this.activeSession.pendingTranscriptEvents.length > 0) {
      const lastPending = this.activeSession.pendingTranscriptEvents[this.activeSession.pendingTranscriptEvents.length - 1];
      if (!lastPending.chunkId) {
        this.activeSession.pendingTranscriptEvents[this.activeSession.pendingTranscriptEvents.length - 1] = event;
      } else {
        this.activeSession.pendingTranscriptEvents.push(event);
      }

      const tailIndex = this.activeSession.latestTranscriptTail.length - 1;
      if (tailIndex >= 0 && !this.activeSession.latestTranscriptTail[tailIndex].chunkId) {
        this.activeSession.latestTranscriptTail[tailIndex] = event;
      } else {
        this.activeSession.latestTranscriptTail.push(event);
      }
    } else {
      this.activeSession.latestTranscriptTail.push(event);
      this.activeSession.pendingTranscriptEvents.push(event);
    }

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
    const text = this.activeSession.pendingTranscriptEvents.map((event) => event.text.trim()).join(" ").trim();
    const words = wordCount(text);
    const durationSeconds = Math.max(0, Math.round((endedAt - startedAt) / 1000));
    const sentenceComplete = /[.!?]["']?$/.test(text);

    if (!force && !(words >= wordThreshold || durationSeconds >= timeThresholdSeconds || (sentenceComplete && words >= 20))) {
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

    await this.fileStore.appendJsonl(this.activeSession.id, "transcript.chunks.jsonl", chunk);

    const provider = this.analysisProviders.get(this.activeSession.analysisProvider);
    if (!provider) {
      this.activeSession.lastError = `Unknown analysis provider ${this.activeSession.analysisProvider}.`;
      await this.writeSessionArtifacts();
      return;
    }

    const requestPayload = {
      chunkId: chunk.id,
      sessionId: this.activeSession.id,
      unresolvedTopics: Object.values(this.activeSession.topics).filter((topic) => topic.currentState === "pending" || topic.currentState === "partial").map((topic) => ({
        id: topic.id,
        text: topic.text,
        state: topic.currentState
      })),
      chunk
    };
    await this.fileStore.appendJsonl(this.activeSession.id, "analysis.requests.jsonl", requestPayload);

    try {
      const result = await provider.analyze({
        chunk,
        session: cloneSession(this.activeSession),
        config: this.config
      });
      const response = codexAnalysisResponseSchema.parse(result.response);
      const rawResponsePath = await this.fileStore.appendJsonl(this.activeSession.id, "analysis.responses.jsonl", {
        recordedAt: nowIso(),
        latencyMs: result.latencyMs,
        response
      });
      const applied: TopicDecision[] = [];
      const proposed: TopicDecision[] = [];

      for (const decision of response.topicDecisions) {
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
      this.activeSession.latestAnalysisAt = nowIso();
      this.activeSession.passCount += 1;
      this.activeSession.analyses.push({
        chunkId: chunk.id,
        latencyMs: result.latencyMs,
        response,
        appliedDecisions: applied,
        proposedDecisions: proposed,
        recordedAt: this.activeSession.latestAnalysisAt,
        rawResponsePath
      });
      this.activeSession.lastError = null;
      await this.writeSessionArtifacts(result.rawResponse);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.activeSession.lastError = `Analysis failed for ${chunk.id}: ${message}`;
      await this.writeSessionArtifacts();
    }
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

      if (topic.directState) {
        topic.currentState = topic.directState;
        topic.stateSetBy = topic.stateSetBy === "user" || topic.stateSetBy === "analysis" ? topic.stateSetBy : "analysis";
        continue;
      }

      const childTopics = topic.children.map((childId) => this.activeSession?.topics[childId]).filter(Boolean) as TopicRecord[];
      const coveredChildren = childTopics.filter((child) => child.currentState === "covered").length;
      const partialChildren = childTopics.filter((child) => child.currentState === "partial" || child.currentState === "covered").length;
      const previousState = topic.currentState;

      if (coveredChildren > 0 && coveredChildren / childTopics.length >= 0.5) {
        topic.currentState = "covered";
      } else if (partialChildren > 0) {
        topic.currentState = "partial";
      } else {
        topic.currentState = "pending";
      }

      topic.stateSetBy = "inferred";
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

  private async writeSessionArtifacts(rawResponse?: string): Promise<void> {
    if (!this.activeSession) {
      return;
    }

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

    const recordedAudioPath = await this.findRecordedAudioPath(session.id);
    session.recordedAudioPath = recordedAudioPath;
    if (!recordedAudioPath) {
      session.finalTranscriptSrtPath = session.approximateTranscriptSrtPath;
      return;
    }

    const whisperCliPath = this.resolveWhisperCliPath();
    if (!whisperCliPath) {
      session.finalTranscriptSrtPath = session.approximateTranscriptSrtPath;
      return;
    }

    try {
      const outputBase = path.join(this.fileStore.sessionDir(session.id), "transcript.final");
      const { spawn } = await import("node:child_process");
      await new Promise<void>((resolve, reject) => {
        const child = spawn(whisperCliPath, [
          "-m",
          this.runtimeConfig.whisperModel,
          "-f",
          recordedAudioPath,
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

      const finalSrtPath = `${outputBase}.srt`;
      if (await this.fileStore.exists(finalSrtPath)) {
        session.finalTranscriptSrtPath = finalSrtPath;
      } else {
        session.finalTranscriptSrtPath = session.approximateTranscriptSrtPath;
      }
    } catch (error) {
      session.lastError = `${session.lastError ? `${session.lastError} · ` : ""}Final subtitle export failed: ${error instanceof Error ? error.message : String(error)}`;
      session.finalTranscriptSrtPath = session.approximateTranscriptSrtPath;
    }
  }

  private async findRecordedAudioPath(sessionId: string): Promise<string | null> {
    const sessionDir = this.fileStore.sessionDir(sessionId);
    const entries = await fs.readdir(sessionDir).catch(() => []);
    const candidates = entries
      .filter((name) => name.toLowerCase().endsWith(".wav"))
      .map((name) => path.join(sessionDir, name));

    if (candidates.length === 0) {
      return null;
    }

    const stats = await Promise.all(candidates.map(async (target) => ({
      target,
      stat: await fs.stat(target)
    })));
    stats.sort((left, right) => right.stat.mtimeMs - left.stat.mtimeMs);
    return stats[0]?.target ?? null;
  }

  private resolveWhisperCliPath(): string | null {
    if (!this.runtimeConfig.sttExecutable) {
      return null;
    }

    const candidate = path.join(path.dirname(this.runtimeConfig.sttExecutable), "whisper-cli");
    return candidate;
  }
}
