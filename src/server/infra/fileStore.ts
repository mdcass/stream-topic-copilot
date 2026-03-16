import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { rebuildDisplayTranscript } from "../domain/transcript/display.js";
import type {
  AppConfig,
  HistoryEntry,
  RuntimeConfig,
  SelectedCaptureSourceConfig,
  SessionSnapshot,
  TopicState,
  TopicStateChange
} from "../domain/types.js";

async function ensureDir(target: string): Promise<void> {
  await fs.mkdir(target, { recursive: true });
}

export class FileStore {
  constructor(private readonly runtimeConfig: RuntimeConfig) {}

  async ensureProjectDirs(): Promise<void> {
    await Promise.all([
      ensureDir(this.runtimeConfig.dataDir),
      ensureDir(this.runtimeConfig.sessionsDir)
    ]);
  }

  async loadConfig(defaultConfig: AppConfig): Promise<AppConfig> {
    await this.ensureProjectDirs();

    try {
      const content = await fs.readFile(this.runtimeConfig.configPath, "utf8");
      return normalizeLoadedConfig(defaultConfig, JSON.parse(content));
    } catch (error) {
      await this.saveConfig(defaultConfig);
      return defaultConfig;
    }
  }

  async saveConfig(config: AppConfig): Promise<void> {
    await this.ensureProjectDirs();
    await fs.writeFile(this.runtimeConfig.configPath, JSON.stringify(config, null, 2));
  }

  sessionDir(sessionId: string): string {
    return path.join(this.runtimeConfig.sessionsDir, sessionId);
  }

  sourceDir(sessionId: string, sourceId: string): string {
    return path.join(this.sessionDir(sessionId), "sources", sourceId.replace(/[^a-zA-Z0-9._-]+/g, "_"));
  }

  async createSessionArtifacts(sessionId: string, sourceMarkdown: string): Promise<{ sessionDir: string; sourceSnapshotPath: string; proposedMarkdownPath: string; }> {
    const sessionDir = this.sessionDir(sessionId);
    await ensureDir(sessionDir);
    const sourceSnapshotPath = path.join(sessionDir, "source-topics.md");
    const proposedMarkdownPath = path.join(sessionDir, "proposed-final.md");

    await fs.writeFile(sourceSnapshotPath, sourceMarkdown);
    await fs.writeFile(proposedMarkdownPath, sourceMarkdown);

    return { sessionDir, sourceSnapshotPath, proposedMarkdownPath };
  }

  async saveSession(session: SessionSnapshot): Promise<void> {
    const sessionDir = this.sessionDir(session.id);
    await ensureDir(sessionDir);
    await fs.writeFile(path.join(sessionDir, "session.json"), JSON.stringify(session, null, 2));
  }

  async writeProposedMarkdown(session: SessionSnapshot, content: string): Promise<void> {
    await fs.writeFile(session.proposedMarkdownPath, content);
  }

  async appendJsonl(sessionId: string, fileName: string, payload: unknown): Promise<string> {
    const sessionDir = this.sessionDir(sessionId);
    await ensureDir(sessionDir);
    const target = path.join(sessionDir, fileName);
    await fs.appendFile(target, `${JSON.stringify(payload)}\n`);
    return target;
  }

  async loadSession(sessionId: string): Promise<SessionSnapshot | null> {
    try {
      const sessionPath = path.join(this.sessionDir(sessionId), "session.json");
      const content = await fs.readFile(sessionPath, "utf8");
      const session = normalizeLoadedSession(JSON.parse(content)) as SessionSnapshot;
      session.visibleTranscriptEvents ??= [];
      session.displayTranscript = rebuildDisplayTranscript(
        session.visibleTranscriptEvents.length ? session.visibleTranscriptEvents : session.latestTranscriptTail
      );
      return session;
    } catch (error) {
      return null;
    }
  }

  async listSessions(): Promise<SessionSnapshot[]> {
    await this.ensureProjectDirs();
    const entries = await fs.readdir(this.runtimeConfig.sessionsDir, { withFileTypes: true }).catch(() => []);
    const sessions: SessionSnapshot[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const loaded = await this.loadSession(entry.name);
      if (loaded) {
        sessions.push(loaded);
      }
    }

    sessions.sort((left, right) => right.startedAt.localeCompare(left.startedAt));
    return sessions;
  }

  async readFile(target: string): Promise<string> {
    return fs.readFile(target, "utf8");
  }

  async writeFile(target: string, content: string): Promise<void> {
    await ensureDir(path.dirname(target));
    await fs.writeFile(target, content);
  }

  async exists(target: string): Promise<boolean> {
    try {
      await fs.access(target);
      return true;
    } catch (error) {
      return false;
    }
  }

  hashContent(content: string): string {
    return crypto.createHash("sha1").update(content).digest("hex");
  }

  summarizeHistory(session: SessionSnapshot): HistoryEntry {
    const counts = {
      pending: 0,
      partial: 0,
      covered: 0,
      snoozed: 0,
      dismissed: 0
    } satisfies Record<TopicState, number>;

    for (const topic of Object.values(session.topics)) {
      counts[topic.currentState] += 1;
    }

    const endTimestamp = session.endedAt ?? new Date().toISOString();
    const durationSeconds = Math.max(
      0,
      Math.round((Date.parse(endTimestamp) - Date.parse(session.startedAt)) / 1000)
    );

    return {
      id: session.id,
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      durationSeconds,
      status: session.status,
      countsByState: counts,
      proposedMarkdownPath: session.proposedMarkdownPath
    };
  }

  async appendStateChange(sessionId: string, change: TopicStateChange): Promise<void> {
    await this.appendJsonl(sessionId, "topic-state-history.jsonl", change);
  }
}

function normalizeCaptureSources(value: unknown, fallbackMicrophoneId?: string | null): SelectedCaptureSourceConfig[] {
  if (Array.isArray(value)) {
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

  if (typeof fallbackMicrophoneId === "string" && fallbackMicrophoneId.length > 0) {
    return [{
      id: fallbackMicrophoneId,
      kind: "microphone",
      name: fallbackMicrophoneId
    }];
  }

  return [];
}

function normalizeLoadedConfig(defaultConfig: AppConfig, raw: Record<string, unknown>): AppConfig {
  return {
    ...defaultConfig,
    ...raw,
    captureSources: normalizeCaptureSources(raw.captureSources, typeof raw.microphoneId === "string" ? raw.microphoneId : null)
  } as AppConfig;
}

function normalizeLoadedSession(raw: Record<string, unknown>): SessionSnapshot {
  const session = raw as unknown as SessionSnapshot & {
    microphoneSelection?: string | null;
    microphoneLevel?: number;
  };

  session.captureSources = normalizeCaptureSources(session.captureSources, session.microphoneSelection ?? null);
  session.recordedAudioPaths ??= {};
  session.sourceMonitors ??= Object.fromEntries(
    session.captureSources.map((source) => [source.id, {
      sourceId: source.id,
      sourceName: source.name,
      sourceKind: source.kind,
      provider: session.sttProvider,
      level: 0,
      status: "idle",
      lastUpdatedAt: null,
      error: null,
      whisperExecutable: null,
      whisperModel: null,
      whisperCaptureId: null,
      whisperLastError: null,
      deviceDiagnostics: []
    }])
  );

  for (const event of session.visibleTranscriptEvents ?? session.latestTranscriptTail ?? []) {
    event.sourceId ??= session.captureSources[0]?.id ?? "legacy-source";
    event.sourceName ??= session.captureSources[0]?.name ?? "Legacy Source";
    event.sourceKind ??= session.captureSources[0]?.kind ?? "microphone";
  }
  for (const event of session.latestTranscriptTail ?? []) {
    event.sourceId ??= session.captureSources[0]?.id ?? "legacy-source";
    event.sourceName ??= session.captureSources[0]?.name ?? "Legacy Source";
    event.sourceKind ??= session.captureSources[0]?.kind ?? "microphone";
  }
  for (const event of session.pendingTranscriptEvents ?? []) {
    event.sourceId ??= session.captureSources[0]?.id ?? "legacy-source";
    event.sourceName ??= session.captureSources[0]?.name ?? "Legacy Source";
    event.sourceKind ??= session.captureSources[0]?.kind ?? "microphone";
  }

  return session as SessionSnapshot;
}
