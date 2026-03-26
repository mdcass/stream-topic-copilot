import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildLatestSessionContext } from "../src/server/tools/latestSessionContext.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function createSessionsDir(): Promise<string> {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "stream-topic-copilot-session-context-"));
  tempDirs.push(rootDir);
  const sessionsDir = path.join(rootDir, "sessions");
  await fs.mkdir(sessionsDir, { recursive: true });
  return sessionsDir;
}

async function createSession(
  sessionsDir: string,
  sessionId: string,
  options: {
    status: "active" | "paused" | "interrupted" | "finished";
    startedAt: string;
    endedAt?: string;
    recap?: boolean;
    summary?: boolean;
    transcript?: boolean;
    analysis?: boolean;
  }
): Promise<string> {
  const sessionDir = path.join(sessionsDir, sessionId);
  await fs.mkdir(sessionDir, { recursive: true });
  await fs.writeFile(path.join(sessionDir, "session.json"), JSON.stringify({
    id: sessionId,
    status: options.status,
    startedAt: options.startedAt,
    endedAt: options.endedAt ?? null,
    sourceMarkdownPath: "/tmp/topics.md",
    sourceSnapshotPath: "/tmp/source-topics.md"
  }, null, 2));

  if (options.summary) {
    await fs.writeFile(path.join(sessionDir, "session-summary.json"), JSON.stringify({
      id: sessionId,
      startedAt: options.startedAt,
      endedAt: options.endedAt ?? null,
      recapOverview: ["summary"]
    }, null, 2));
  }
  if (options.recap) {
    await fs.writeFile(path.join(sessionDir, "session-recap.json"), JSON.stringify({
      status: "ready",
      futureFollowUps: ["follow-up"]
    }, null, 2));
    await fs.writeFile(path.join(sessionDir, "session-recap.md"), "# Recap\n");
  }
  if (options.transcript) {
    await fs.writeFile(path.join(sessionDir, "transcript.chunks.jsonl"), "{\"id\":\"chunk_001\"}\n");
  }
  if (options.analysis) {
    await fs.writeFile(path.join(sessionDir, "analysis.responses.jsonl"), "{\"kind\":\"chunk-analysis\"}\n");
  }

  return sessionDir;
}

describe("latest session context", () => {
  it("picks the newest finished session and prioritizes recap artifacts", async () => {
    const sessionsDir = await createSessionsDir();
    await createSession(sessionsDir, "2026-03-26-1453-cb90", {
      status: "finished",
      startedAt: "2026-03-26T14:53:00.000Z",
      endedAt: "2026-03-26T15:30:00.000Z",
      recap: true,
      summary: true,
      transcript: true,
      analysis: true
    });
    await createSession(sessionsDir, "2026-03-26-1659-a763", {
      status: "finished",
      startedAt: "2026-03-26T16:59:12.334Z",
      endedAt: "2026-03-26T17:52:59.706Z",
      recap: true,
      summary: true,
      transcript: true,
      analysis: true
    });
    await createSession(sessionsDir, "2026-03-26-1800-dead", {
      status: "active",
      startedAt: "2026-03-26T18:00:00.000Z",
      summary: true
    });

    const context = await buildLatestSessionContext(sessionsDir);

    expect(context.session.id).toBe("2026-03-26-1659-a763");
    expect(context.preferredArtifacts.map((artifact) => artifact.kind)).toEqual([
      "session-recap-json",
      "session-summary-json",
      "session-recap-markdown"
    ]);
    expect(context.fallbackArtifacts.map((artifact) => artifact.kind)).toEqual([
      "transcript-chunks-jsonl",
      "analysis-responses-jsonl",
      "session-json"
    ]);
    expect(context.sourceNote).toBe("Source: latest session recap");
  });

  it("falls back to summary and raw artifacts when recap is missing", async () => {
    const sessionsDir = await createSessionsDir();
    await createSession(sessionsDir, "2026-03-26-1900-beef", {
      status: "finished",
      startedAt: "2026-03-26T19:00:00.000Z",
      endedAt: "2026-03-26T19:30:00.000Z",
      summary: true,
      transcript: true,
      analysis: true
    });

    const context = await buildLatestSessionContext(sessionsDir);

    expect(context.preferredArtifacts.map((artifact) => artifact.kind)).toEqual([
      "session-summary-json"
    ]);
    expect(context.fallbackArtifacts.map((artifact) => artifact.kind)).toEqual([
      "transcript-chunks-jsonl",
      "analysis-responses-jsonl",
      "session-json"
    ]);
    expect(context.sourceNote).toBe("Source: session summary");
  });

  it("accepts an explicit session selector", async () => {
    const sessionsDir = await createSessionsDir();
    const selectedSessionDir = await createSession(sessionsDir, "2026-03-26-2000-cafe", {
      status: "finished",
      startedAt: "2026-03-26T20:00:00.000Z",
      endedAt: "2026-03-26T20:20:00.000Z",
      recap: true,
      summary: true
    });
    await createSession(sessionsDir, "2026-03-26-2100-face", {
      status: "finished",
      startedAt: "2026-03-26T21:00:00.000Z",
      endedAt: "2026-03-26T21:20:00.000Z",
      recap: true,
      summary: true
    });

    const context = await buildLatestSessionContext(sessionsDir, selectedSessionDir);

    expect(context.session.id).toBe("2026-03-26-2000-cafe");
  });
});
