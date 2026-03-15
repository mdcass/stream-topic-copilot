import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

import { createApp } from "../src/server/app.js";
import { AppService } from "../src/server/appService.js";
import type { RuntimeConfig } from "../src/server/domain/types.js";
import { MockAnalysisProvider } from "../src/server/providers/analysis/mockProvider.js";
import { MockSttProvider } from "../src/server/providers/stt/mockProvider.js";

const tempDirs: string[] = [];

async function createRuntimeConfig(): Promise<RuntimeConfig> {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "stream-topic-copilot-"));
  tempDirs.push(rootDir);
  const dataDir = path.join(rootDir, "data");
  const sessionsDir = path.join(rootDir, "sessions");
  const publicDir = path.resolve("src/ui/public");
  await fs.mkdir(dataDir, { recursive: true });
  await fs.mkdir(sessionsDir, { recursive: true });
  await fs.writeFile(
    path.join(dataDir, "sample-topics.md"),
    `# Stream Topics

## Priority
- [ ] New PC build <!-- id: tp_001 -->
  - Cooling issue <!-- id: tp_001_a -->

## Fallback
- [ ] Weird developer habits <!-- id: tp_002 -->
`
  );

  return {
    rootDir,
    host: "127.0.0.1",
    port: 4312,
    dataDir,
    sessionsDir,
    publicDir,
    configPath: path.join(dataDir, "config.json"),
    analysisProvider: "mock",
    sttProvider: "mock",
    analysisProviderCommand: "codex exec --skip-git-repo-check --color never",
    analysisStructuredOutputFlag: "--output-schema",
    analysisConfidenceThreshold: 0.8,
    sttExecutable: "",
    whisperModel: "small.en",
    pollingIntervalMs: 2000,
    loggingFlags: ["analysis", "transcript", "state"],
    transcriptTailSize: 30,
    chunkWordThreshold: 5,
    chunkTimeThresholdSeconds: 1,
    defaultChunkSensitivity: "medium",
    visibleSuggestionCount: 3,
    microphonePermissionHelper: path.join(rootDir, ".bin/request-microphone-permission"),
    microphoneProbeHelper: path.join(rootDir, ".bin/mic-level-probe"),
    analysisSchemaPath: path.resolve("docs/scoping/codex-analysis-response-schema.json")
  };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("app session flow", () => {
  it("starts a session, analyzes mock transcript, and writes artifacts", async () => {
    const runtimeConfig = await createRuntimeConfig();
    const service = new AppService(
      runtimeConfig,
      new Map([["mock", new MockSttProvider()]]),
      new Map([["mock", new MockAnalysisProvider()]])
    );
    await service.initialize();
    const app = createApp(service, runtimeConfig.publicDir, runtimeConfig.sessionsDir, process.cwd());

    const startResponse = await request(app).post("/api/session/start").expect(200);
    expect(startResponse.body.session.id).toMatch(/^2026|^20/);

    await request(app)
      .post("/api/session/mock-transcript")
      .send({ text: "I finally started the new PC build and the cooling issue is still annoying." })
      .expect(200);

    const stateResponse = await request(app).get("/api/state").expect(200);
    expect(stateResponse.body.activeSession.latestTranscriptTail).toHaveLength(1);
    expect(stateResponse.body.activeSession.analyses.length).toBeGreaterThanOrEqual(1);

    const sessionId = stateResponse.body.activeSession.id;
    const sessionDir = path.join(runtimeConfig.sessionsDir, sessionId);
    const proposedMarkdown = await fs.readFile(path.join(sessionDir, "proposed-final.md"), "utf8");
    expect(proposedMarkdown).toContain("## Done");
    expect(await fs.readFile(path.join(sessionDir, "analysis.requests.jsonl"), "utf8")).toContain("chunkId");

    await request(app).post("/api/session/end").send({ status: "finished" }).expect(200);

    const finalState = await request(app).get("/api/state").expect(200);
    expect(finalState.body.activeSession).toBeNull();
    expect(await fs.readFile(path.join(sessionDir, "transcript.approx.srt"), "utf8")).toContain("00:00:00,");
  });
});
