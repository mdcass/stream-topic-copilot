import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import type {
  AppConfig,
  HistoryEntry,
  RuntimeConfig,
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
      return { ...defaultConfig, ...JSON.parse(content) } as AppConfig;
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
      return JSON.parse(content) as SessionSnapshot;
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
