import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

import { createApp } from "../src/server/app.js";
import { AppService } from "../src/server/appService.js";
import type { AnalysisProviderResult, AnalysisRunInput, RuntimeConfig } from "../src/server/domain/types.js";
import { MockAnalysisProvider } from "../src/server/providers/analysis/mockProvider.js";
import type { AnalysisProvider } from "../src/server/providers/analysis/providerTypes.js";
import { MockSttProvider } from "../src/server/providers/stt/mockProvider.js";
import type { SttProvider, SttProviderHandlers, SttProviderSession } from "../src/server/providers/stt/providerTypes.js";

const tempDirs: string[] = [];

async function createRuntimeConfig(): Promise<RuntimeConfig> {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "stream-topic-copilot-"));
  tempDirs.push(rootDir);
  const dataDir = path.join(rootDir, "data");
  const sessionsDir = path.join(rootDir, "sessions");
  const publicDir = path.resolve("src/ui");
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
    defaultConfigPath: path.join(dataDir, "config.default.json"),
    configPath: path.join(dataDir, "config.local.json"),
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
    sdlAudioDevicesHelper: path.join(rootDir, ".bin/sdl-audio-devices"),
    nativeSystemAudioHelper: path.join(rootDir, ".bin/native-system-audio-helper"),
    enableNativeSystemAudioCapture: false,
    analysisSchemaPath: path.resolve("docs/scoping/codex-analysis-response-schema.json")
  };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

class FakeWhisperProvider implements SttProvider {
  readonly name = "whisper";
  startCalls = 0;
  constructor(private readonly sources: Array<{ id: string; name: string; kind: "microphone" | "system-mix"; }> = []) {}

  async listSources() {
    return this.sources.map((source) => ({
      ...source,
      groupLabel: source.kind === "system-mix" ? "Desktop Audio" : "Microphones",
      transport: "input-device" as const,
      isDefault: false,
      inputDeviceId: source.id
    }));
  }

  async start(_options: Parameters<SttProvider["start"]>[0], _handlers: SttProviderHandlers): Promise<SttProviderSession> {
    this.startCalls += 1;
    return {
      stop: async () => undefined
    };
  }

  async transcribeFile(_audioPath: string): Promise<string> {
    return "";
  }
}

class StreamingWhisperProvider implements SttProvider {
  readonly name = "whisper";
  private handlers: SttProviderHandlers | null = null;

  async listSources() {
    return [{
      id: "stream-mic",
      name: "Stream Mic",
      kind: "microphone" as const,
      groupLabel: "Microphones",
      transport: "input-device" as const,
      isDefault: true,
      inputDeviceId: "stream-mic"
    }];
  }

  async start(_options: Parameters<SttProvider["start"]>[0], handlers: SttProviderHandlers): Promise<SttProviderSession> {
    this.handlers = handlers;
    return {
      stop: async () => undefined
    };
  }

  async emit(event: Parameters<SttProviderHandlers["onTranscript"]>[0]): Promise<void> {
    if (!this.handlers) {
      throw new Error("StreamingWhisperProvider has not been started.");
    }

    await this.handlers.onTranscript(event);
  }

  async transcribeFile(_audioPath: string): Promise<string> {
    return "";
  }
}

class ScriptedAnalysisProvider implements AnalysisProvider {
  readonly name = "scripted";

  constructor(private readonly handler: (input: AnalysisRunInput) => Promise<AnalysisProviderResult>) {}

  async analyze(input: AnalysisRunInput): Promise<AnalysisProviderResult> {
    return this.handler(input);
  }
}

async function writeFakeNativeHelper(runtimeConfig: RuntimeConfig, script: string): Promise<void> {
  await fs.mkdir(path.dirname(runtimeConfig.nativeSystemAudioHelper), { recursive: true });
  await fs.writeFile(runtimeConfig.nativeSystemAudioHelper, script, { mode: 0o755 });
  await fs.chmod(runtimeConfig.nativeSystemAudioHelper, 0o755);
}

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

    await request(app)
      .post("/api/config")
      .send({
        captureSources: [{
          id: "mock-mic-default",
          kind: "microphone",
          name: "Mock Studio Mic"
        }]
      })
      .expect(200);

    const startResponse = await request(app).post("/api/session/start").expect(200);
    expect(startResponse.body.session.id).toMatch(/^20\d{2}-\d{2}-\d{2}-\d{4}-[0-9a-f]{4}$/);

    await request(app)
      .post("/api/session/mock-transcript")
      .send({ text: "I finally started the new PC build and the cooling issue is still annoying." })
      .expect(200);

    const stateResponse = await request(app).get("/api/state").expect(200);
    expect(stateResponse.body.runtime.defaultProviders.analysis).toBe("mock");
    expect(stateResponse.body.activeSession.latestTranscriptTail).toHaveLength(1);
    expect(stateResponse.body.activeSession.visibleTranscriptEvents).toHaveLength(1);
    expect(stateResponse.body.activeSession.latestTranscriptTail[0].sourceName).toBe("Mock Studio Mic");
    expect(stateResponse.body.activeSession.displayTranscript.committedLines).toHaveLength(0);
    expect(stateResponse.body.activeSession.displayTranscript.activeLine?.text).toContain("cooling issue");
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

  it("waits for more content before auto-analyzing medium sentence-complete chunks", async () => {
    const runtimeConfig = await createRuntimeConfig();
    runtimeConfig.chunkWordThreshold = null;
    runtimeConfig.chunkTimeThresholdSeconds = null;
    const service = new AppService(
      runtimeConfig,
      new Map([["mock", new MockSttProvider()]]),
      new Map([["mock", new MockAnalysisProvider()]])
    );
    await service.initialize();
    const app = createApp(service, runtimeConfig.publicDir, runtimeConfig.sessionsDir, process.cwd());

    await request(app)
      .post("/api/config")
      .send({
        captureSources: [{
          id: "mock-mic-default",
          kind: "microphone",
          name: "Mock Studio Mic"
        }],
        chunkSensitivity: "medium"
      })
      .expect(200);

    await request(app).post("/api/session/start").expect(200);

    await request(app)
      .post("/api/session/mock-transcript")
      .send({
        text: "This is a fairly complete sentence about the new PC build and the cooling issue, but medium mode should not analyze it on its own yet."
      })
      .expect(200);

    let stateResponse = await request(app).get("/api/state").expect(200);
    expect(stateResponse.body.activeSession.chunks).toHaveLength(0);
    expect(stateResponse.body.activeSession.analyses).toHaveLength(0);

    await request(app)
      .post("/api/session/mock-transcript")
      .send({
        text: "This second complete sentence adds more detail about cable routing mistakes and should finally push medium mode over the semantic chunk threshold."
      })
      .expect(200);

    stateResponse = await request(app).get("/api/state").expect(200);
    expect(stateResponse.body.activeSession.chunks.length).toBeGreaterThanOrEqual(1);
    expect(stateResponse.body.activeSession.analyses.length).toBeGreaterThanOrEqual(1);
  });

  it("does not let blank placeholders reset an already applied topic state", async () => {
    const runtimeConfig = await createRuntimeConfig();
    runtimeConfig.chunkWordThreshold = 1;
    runtimeConfig.chunkTimeThresholdSeconds = 1;
    const service = new AppService(
      runtimeConfig,
      new Map([["mock", new MockSttProvider()]]),
      new Map([["scripted", new ScriptedAnalysisProvider(async (input) => ({
        response: {
          schemaVersion: "codexAnalysis.v1",
          chunkId: input.chunk.id,
          topicDecisions: [{
            topicId: "tp_001",
            suggestedState: input.chunk.text.includes("[BLANK_AUDIO]") ? "pending" : "partial",
            confidence: 0.95,
            rationale: "Scripted provider for regression coverage.",
            evidence: [{ chunkId: input.chunk.id, excerpt: input.chunk.text }]
          }],
          suggestions: {
            activeTopics: [],
            elaborationStarters: [],
            adjacentNextTopics: [],
            recoveryPrompts: []
          },
          offTopicObservations: [],
          revisitableThemes: {
            upserts: [],
            merges: []
          },
          warnings: []
        },
        rawResponse: input.chunk.text,
        latencyMs: 1
      }))]])
    );
    await service.initialize();
    const app = createApp(service, runtimeConfig.publicDir, runtimeConfig.sessionsDir, process.cwd());

    await request(app)
      .post("/api/config")
      .send({
        captureSources: [{
          id: "mock-mic-default",
          kind: "microphone",
          name: "Mock Studio Mic"
        }],
        analysisProvider: "scripted"
      })
      .expect(200);

    await request(app).post("/api/session/start").expect(200);

    await request(app)
      .post("/api/session/mock-transcript")
      .send({ text: "I finally started the new PC build and the cooling issue is still annoying." })
      .expect(200);

    let stateResponse = await request(app).get("/api/state").expect(200);
    expect(stateResponse.body.activeSession.topics.tp_001.currentState).toBe("partial");

    await request(app)
      .post("/api/session/mock-transcript")
      .send({ text: "[BLANK_AUDIO]" })
      .expect(200);

    const endResponse = await request(app).post("/api/session/end").send({ status: "finished" }).expect(200);
    expect(endResponse.body.session.topics.tp_001.currentState).toBe("partial");
  });

  it("keeps live prompts until they are dismissed", async () => {
    const runtimeConfig = await createRuntimeConfig();
    runtimeConfig.chunkWordThreshold = 1;
    runtimeConfig.chunkTimeThresholdSeconds = 1;
    let analyzeCount = 0;
    const service = new AppService(
      runtimeConfig,
      new Map([["mock", new MockSttProvider()]]),
      new Map([["scripted", new ScriptedAnalysisProvider(async (input) => {
        analyzeCount += 1;
        return {
          response: {
            schemaVersion: "codexAnalysis.v1",
            chunkId: input.chunk.id,
            topicDecisions: [],
            suggestions: analyzeCount === 1 ? {
              activeTopics: [{
                text: "Stay on the PC build and make the cooling tradeoff explicit.",
                confidence: 0.92,
                rationale: "The first chunk is clearly about the PC build.",
                evidence: [{ chunkId: input.chunk.id, excerpt: input.chunk.text }],
                topicId: "tp_001"
              }],
              elaborationStarters: [{
                text: "Name the one detail that made the cooling issue annoying.",
                confidence: 0.88,
                rationale: "This helps the streamer add a concrete example.",
                evidence: [{ chunkId: input.chunk.id, excerpt: input.chunk.text }],
                topicId: "tp_001"
              }],
              adjacentNextTopics: [],
              recoveryPrompts: []
            } : {
              activeTopics: [],
              elaborationStarters: [],
              adjacentNextTopics: [],
              recoveryPrompts: []
            },
            offTopicObservations: [],
            revisitableThemes: {
              upserts: [],
              merges: []
            },
            warnings: []
          },
          rawResponse: input.chunk.text,
          latencyMs: 1
        };
      })]])
    );
    await service.initialize();
    const app = createApp(service, runtimeConfig.publicDir, runtimeConfig.sessionsDir, process.cwd());

    await request(app)
      .post("/api/config")
      .send({
        captureSources: [{
          id: "mock-mic-default",
          kind: "microphone",
          name: "Mock Studio Mic"
        }],
        analysisProvider: "scripted"
      })
      .expect(200);

    await request(app).post("/api/session/start").expect(200);

    let stateResponse = await request(app)
      .post("/api/session/mock-transcript")
      .send({ text: "I finally started the new PC build and the cooling issue is still annoying." })
      .expect(200);

    expect(stateResponse.body.session.livePrompts).toHaveLength(2);

    stateResponse = await request(app)
      .post("/api/session/mock-transcript")
      .send({ text: "Now I am rambling without a new prompt suggestion." })
      .expect(200);

    expect(stateResponse.body.session.livePrompts.filter((prompt: { dismissedAt: string | null; }) => !prompt.dismissedAt)).toHaveLength(2);

    const promptId = stateResponse.body.session.livePrompts[0].id;
    const dismissResponse = await request(app)
      .post("/api/session/live-prompt/dismiss")
      .send({ promptId })
      .expect(200);

    expect(dismissResponse.body.session.livePrompts.find((prompt: { id: string; }) => prompt.id === promptId).dismissedAt).toBeTruthy();
  });

  it("stores interviewer-style elaboration questions on revisitable themes", async () => {
    const runtimeConfig = await createRuntimeConfig();
    runtimeConfig.chunkWordThreshold = 1;
    runtimeConfig.chunkTimeThresholdSeconds = 1;
    const service = new AppService(
      runtimeConfig,
      new Map([["mock", new MockSttProvider()]]),
      new Map([["scripted", new ScriptedAnalysisProvider(async (input) => ({
        response: {
          schemaVersion: "codexAnalysis.v1",
          chunkId: input.chunk.id,
          topicDecisions: [],
          suggestions: {
            activeTopics: [],
            elaborationStarters: [],
            adjacentNextTopics: [],
            recoveryPrompts: []
          },
          offTopicObservations: [],
          revisitableThemes: {
            upserts: [{
              themeId: null,
              label: "Cooling frustration",
              summary: "The streamer kept circling back to the cooling tradeoff outside the prepared plan.",
              supportingMoments: ["The cooling setup kept sounding more annoying than expected."],
              interviewerQuestions: [
                "What part of that cooling issue kept sticking in your head after the moment passed?",
                "If you had to explain why that tradeoff mattered, where would you start?"
              ],
              confidence: 0.88,
              rationale: "This is a durable off-topic theme worth resurfacing later.",
              evidence: [{ chunkId: input.chunk.id, excerpt: input.chunk.text }],
              promptEligible: true
            }],
            merges: []
          },
          warnings: []
        },
        rawResponse: input.chunk.text,
        latencyMs: 1
      }))]])
    );
    await service.initialize();
    const app = createApp(service, runtimeConfig.publicDir, runtimeConfig.sessionsDir, process.cwd());

    await request(app)
      .post("/api/config")
      .send({
        captureSources: [{
          id: "mock-mic-default",
          kind: "microphone",
          name: "Mock Studio Mic"
        }],
        analysisProvider: "scripted"
      })
      .expect(200);

    await request(app).post("/api/session/start").expect(200);

    const response = await request(app)
      .post("/api/session/mock-transcript")
      .send({ text: "The cooling setup should have been simple, but it kept annoying me in ways I didn't expect." })
      .expect(200);

    expect(response.body.session.revisitableThemes).toHaveLength(1);
    expect(response.body.session.revisitableThemes[0].interviewerQuestions).toHaveLength(2);
    expect(response.body.session.revisitableThemes[0].interviewerQuestions[0]).toContain("cooling issue");
  });

  it("promotes an analysis-marked partial parent to covered when child beats complete it", async () => {
    const runtimeConfig = await createRuntimeConfig();
    runtimeConfig.chunkWordThreshold = 1;
    runtimeConfig.chunkTimeThresholdSeconds = 1;
    const customMarkdownPath = path.join(runtimeConfig.dataDir, "promotion-topics.md");
    await fs.writeFile(
      customMarkdownPath,
      `# Stream Topics

## Priority
- [ ] Reliable AI for coding work <!-- id: tp_parent -->
  - Reliable means hands-off results <!-- id: tp_child_1 -->
  - Teams start in review-heavy mode <!-- id: tp_child_2 -->
`
    );

    let analyzeCount = 0;
    const service = new AppService(
      runtimeConfig,
      new Map([["mock", new MockSttProvider()]]),
      new Map([["scripted", new ScriptedAnalysisProvider(async (input) => {
        analyzeCount += 1;
        const topicDecisions = analyzeCount === 1
          ? [{
            topicId: "tp_parent",
            suggestedState: "partial" as const,
            confidence: 0.95,
            rationale: "The cluster has been introduced but not finished.",
            evidence: [{ chunkId: input.chunk.id, excerpt: input.chunk.text }]
          }]
          : [{
            topicId: "tp_child_1",
            suggestedState: "covered" as const,
            confidence: 0.95,
            rationale: "The child beat is now fully covered.",
            evidence: [{ chunkId: input.chunk.id, excerpt: input.chunk.text }]
          }];

        return {
          response: {
            schemaVersion: "codexAnalysis.v1",
            chunkId: input.chunk.id,
            topicDecisions,
            suggestions: {
              activeTopics: [],
              elaborationStarters: [],
              adjacentNextTopics: [],
              recoveryPrompts: []
            },
            offTopicObservations: [],
            revisitableThemes: {
              upserts: [],
              merges: []
            },
            warnings: []
          },
          rawResponse: input.chunk.text,
          latencyMs: 1
        };
      })]])
    );
    await service.initialize();
    const app = createApp(service, runtimeConfig.publicDir, runtimeConfig.sessionsDir, process.cwd());

    await request(app)
      .post("/api/config")
      .send({
        markdownFilePath: customMarkdownPath,
        captureSources: [{
          id: "mock-mic-default",
          kind: "microphone",
          name: "Mock Studio Mic"
        }],
        analysisProvider: "scripted"
      })
      .expect(200);

    await request(app).post("/api/session/start").expect(200);

    await request(app)
      .post("/api/session/mock-transcript")
      .send({ text: "Let me define what I mean by reliable AI." })
      .expect(200);

    const stateResponse = await request(app)
      .post("/api/session/mock-transcript")
      .send({ text: "Reliable means hands-off results that work without review." })
      .expect(200);

    expect(stateResponse.body.session.topics.tp_parent.currentState).toBe("covered");
    expect(stateResponse.body.session.topics.tp_parent.stateSetBy).toBe("inferred");
  });

  it("ignores late analysis failures after the session has been cleared", async () => {
    const runtimeConfig = await createRuntimeConfig();
    const service = new AppService(
      runtimeConfig,
      new Map([["mock", new MockSttProvider()]]),
      new Map([["scripted", new ScriptedAnalysisProvider(async () => {
        await delay(25);
        throw new Error("late failure");
      })]])
    );
    await service.initialize();

    await service.updateConfig({
      captureSources: [{
        id: "mock-mic-default",
        kind: "microphone",
        name: "Mock Studio Mic"
      }],
      analysisProvider: "scripted"
    });
    await service.startSession();

    const runAnalysis = (service as unknown as { runAnalysis: (chunk: AnalysisRunInput["chunk"]) => Promise<void>; }).runAnalysis.bind(service);
    const promise = runAnalysis({
      id: "chunk_late_failure",
      startedAt: "2026-03-14T09:00:00.000Z",
      endedAt: "2026-03-14T09:00:05.000Z",
      text: "A delayed analysis failure should not crash after session teardown.",
      wordCount: 10,
      eventIds: []
    });

    (service as unknown as { activeSession: null; }).activeSession = null;

    await expect(promise).resolves.toBeUndefined();
  });

  it("returns a clear error when UI assets are missing", async () => {
    const runtimeConfig = await createRuntimeConfig();
    const service = new AppService(
      runtimeConfig,
      new Map([["mock", new MockSttProvider()]]),
      new Map([["mock", new MockAnalysisProvider()]])
    );
    await service.initialize();

    const missingPublicDir = path.join(runtimeConfig.rootDir, "dist/ui");
    const app = createApp(service, missingPublicDir, runtimeConfig.sessionsDir, runtimeConfig.rootDir);

    const response = await request(app).get("/").expect(503);
    expect(response.text).toContain("UI assets not found");
    expect(response.text).toContain("http://127.0.0.1:5173");
    expect(response.text).toContain("npm run build");
  });

  it("redirects root requests to the Vite dev server during npm run dev", async () => {
    const runtimeConfig = await createRuntimeConfig();
    const service = new AppService(
      runtimeConfig,
      new Map([["mock", new MockSttProvider()]]),
      new Map([["mock", new MockAnalysisProvider()]])
    );
    await service.initialize();

    const publicDir = path.join(runtimeConfig.rootDir, "dist/ui");
    await fs.mkdir(publicDir, { recursive: true });
    await fs.writeFile(path.join(publicDir, "index.html"), "<!doctype html><title>stale</title>");

    const previousLifecycleEvent = process.env.npm_lifecycle_event;
    process.env.npm_lifecycle_event = "dev:server";

    try {
      const app = createApp(service, publicDir, runtimeConfig.sessionsDir, runtimeConfig.rootDir);
      const response = await request(app)
        .get("/")
        .set("Accept", "text/html")
        .redirects(0)
        .expect(302);

      expect(response.headers.location).toBe("http://127.0.0.1:5173/");
    } finally {
      if (previousLifecycleEvent === undefined) {
        delete process.env.npm_lifecycle_event;
      } else {
        process.env.npm_lifecycle_event = previousLifecycleEvent;
      }
    }
  });

  it("preserves native selections and reports permission errors when system audio discovery is denied", async () => {
    const runtimeConfig = await createRuntimeConfig();
    runtimeConfig.sttProvider = "whisper";
    runtimeConfig.enableNativeSystemAudioCapture = true;
    const whisperProvider = new FakeWhisperProvider();

    await writeFakeNativeHelper(
      runtimeConfig,
      `#!/bin/sh
set -eu
case "$1" in
  status)
    echo denied
    ;;
  list)
    echo "Error Domain=com.apple.ScreenCaptureKit.SCStreamErrorDomain Code=-3801 \\"The user declined TCCs for application, window, display capture\\"" >&2
    exit 1
    ;;
  *)
    echo "unsupported" >&2
    exit 1
    ;;
esac
`
    );

    const service = new AppService(
      runtimeConfig,
      new Map([["whisper", whisperProvider]]),
      new Map([["mock", new MockAnalysisProvider()]])
    );
    await service.initialize();
    const app = createApp(service, runtimeConfig.publicDir, runtimeConfig.sessionsDir, process.cwd());

    await request(app)
      .post("/api/config")
      .send({
        sttProvider: "whisper",
        captureSources: [{
          id: "app-bundle:com.apple.QuickTimePlayerX",
          kind: "native-app-audio",
          name: "QuickTime Player"
        }]
      })
      .expect(200);

    const stateResponse = await request(app).get("/api/state").expect(200);
    expect(stateResponse.body.capturePermissions.systemAudio).toBe("denied");
    expect(stateResponse.body.sourceMonitors["app-bundle:com.apple.QuickTimePlayerX"].error).toContain("permission is denied");

    const sessionResponse = await request(app).post("/api/session/start").expect(200);
    expect(sessionResponse.body.session.sourceMonitors["app-bundle:com.apple.QuickTimePlayerX"].error).toContain("permission is denied");
    expect(whisperProvider.startCalls).toBe(0);
  });

  it("accumulates replaceLast transcript revisions into one analysis chunk", async () => {
    const runtimeConfig = await createRuntimeConfig();
    runtimeConfig.sttProvider = "whisper";
    runtimeConfig.chunkWordThreshold = 20;
    const whisperProvider = new StreamingWhisperProvider();

    const service = new AppService(
      runtimeConfig,
      new Map([["whisper", whisperProvider]]),
      new Map([["mock", new MockAnalysisProvider()]])
    );
    await service.initialize();
    const app = createApp(service, runtimeConfig.publicDir, runtimeConfig.sessionsDir, process.cwd());

    await request(app)
      .post("/api/config")
      .send({
        sttProvider: "whisper",
        captureSources: [{
          id: "stream-mic",
          kind: "microphone",
          name: "Stream Mic"
        }]
      })
      .expect(200);

    const startResponse = await request(app).post("/api/session/start").expect(200);
    const sessionId = startResponse.body.session.id;

    await whisperProvider.emit({
      id: "evt_1",
      timestamp: "2026-03-16T10:00:00.000Z",
      text: "Welcome along everyone, my name is Mike.",
      sourceId: "stream-mic",
      sourceName: "Stream Mic",
      sourceKind: "microphone",
      replaceLast: true
    });
    await whisperProvider.emit({
      id: "evt_2",
      timestamp: "2026-03-16T10:00:06.000Z",
      text: "And this is Red Dead Redemption 2.",
      sourceId: "stream-mic",
      sourceName: "Stream Mic",
      sourceKind: "microphone",
      replaceLast: true
    });
    await whisperProvider.emit({
      id: "evt_3",
      timestamp: "2026-03-16T10:00:12.000Z",
      text: "And this is Red Dead Redemption 2. And we are about to get a haircut.",
      sourceId: "stream-mic",
      sourceName: "Stream Mic",
      sourceKind: "microphone",
      replaceLast: true
    });
    await whisperProvider.emit({
      id: "evt_4",
      timestamp: "2026-03-16T10:00:18.000Z",
      text: "The first thing that I want to attempt is Sharpshooter 9, which I failed at miserably a couple of episodes ago.",
      sourceId: "stream-mic",
      sourceName: "Stream Mic",
      sourceKind: "microphone",
      replaceLast: true
    });

    const sessionDir = path.join(runtimeConfig.sessionsDir, sessionId);
    const chunkLog = await fs.readFile(path.join(sessionDir, "transcript.chunks.jsonl"), "utf8");
    const requestLog = await fs.readFile(path.join(sessionDir, "analysis.requests.jsonl"), "utf8");

    expect(chunkLog).toContain("Welcome along everyone, my name is Mike.");
    expect(chunkLog).toContain("And we are about to get a haircut.");
    expect(chunkLog).toContain("Sharpshooter 9");
    expect(requestLog).toContain("Welcome along everyone, my name is Mike.");
    expect(requestLog).toContain("Sharpshooter 9");

    await request(app)
      .post("/api/session/end")
      .send({ status: "finished" })
      .expect(200);
  });

  it("ends a session even if the native capture helper ignores SIGTERM", async () => {
    const runtimeConfig = await createRuntimeConfig();
    runtimeConfig.sttProvider = "whisper";
    runtimeConfig.enableNativeSystemAudioCapture = true;
    const whisperProvider = new FakeWhisperProvider();

    await writeFakeNativeHelper(
      runtimeConfig,
      `#!/bin/sh
set -eu
case "$1" in
  status)
    echo granted
    ;;
  request)
    echo granted
    ;;
  list)
    printf '%s\n' '{"displays":[],"applications":[{"id":"123","name":"QuickTime Player","bundleId":"com.apple.QuickTimePlayerX"}]}'
    ;;
  capture)
    trap '' TERM
    while true; do
      sleep 5
    done
    ;;
  *)
    echo "unsupported" >&2
    exit 1
    ;;
esac
`
    );

    const service = new AppService(
      runtimeConfig,
      new Map([["whisper", whisperProvider]]),
      new Map([["mock", new MockAnalysisProvider()]])
    );
    await service.initialize();
    const app = createApp(service, runtimeConfig.publicDir, runtimeConfig.sessionsDir, process.cwd());

    await request(app)
      .post("/api/config")
      .send({
        sttProvider: "whisper",
        captureSources: [{
          id: "app-bundle:com.apple.QuickTimePlayerX",
          kind: "native-app-audio",
          name: "QuickTime Player"
        }]
      })
      .expect(200);

    await request(app).post("/api/session/start").expect(200);

    const endResponse = await request(app)
      .post("/api/session/end")
      .send({ status: "finished" })
      .timeout({ response: 4000, deadline: 5000 });

    expect(endResponse.status).toBe(200);
    expect(endResponse.body.session.status).toBe("finished");
  });

  it("starts desktop-audio system-mix capture through the whisper input-device path", async () => {
    const runtimeConfig = await createRuntimeConfig();
    runtimeConfig.sttProvider = "whisper";
    const whisperProvider = new FakeWhisperProvider([{
      id: "BlackHole 2ch",
      kind: "system-mix",
      name: "BlackHole 2ch"
    }]);

    await writeFakeNativeHelper(
      runtimeConfig,
      `#!/bin/sh
set -eu
case "$1" in
  status)
    echo denied
    ;;
  capture)
    trap 'exit 0' TERM
    while true; do
      sleep 5
    done
    ;;
  *)
    echo "unsupported" >&2
    exit 1
    ;;
esac
`
    );

    const service = new AppService(
      runtimeConfig,
      new Map([["whisper", whisperProvider]]),
      new Map([["mock", new MockAnalysisProvider()]])
    );
    await service.initialize();
    const app = createApp(service, runtimeConfig.publicDir, runtimeConfig.sessionsDir, process.cwd());

    await request(app)
      .post("/api/config")
      .send({
        sttProvider: "whisper",
        captureSources: [{
          id: "BlackHole 2ch",
          kind: "system-mix",
          name: "BlackHole 2ch"
        }]
      })
      .expect(200);

    const stateResponse = await request(app).get("/api/state").expect(200);
    expect(stateResponse.body.captureSourceCatalog).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "BlackHole 2ch",
          kind: "system-mix",
          name: "BlackHole 2ch",
          groupLabel: "Desktop Audio"
        })
      ])
    );
    expect(stateResponse.body.sourceMonitors["BlackHole 2ch"].error).toBeNull();
    expect(stateResponse.body.capturePermissions.systemAudio).toBe("denied");

    const sessionResponse = await request(app).post("/api/session/start").expect(200);
    expect(sessionResponse.body.session.captureSources).toEqual([{
      id: "BlackHole 2ch",
      kind: "system-mix",
      name: "BlackHole 2ch"
    }]);
    expect(sessionResponse.body.session.sourceMonitors["BlackHole 2ch"].status).toBe("running");
    expect(whisperProvider.startCalls).toBe(1);

    await request(app)
      .post("/api/session/end")
      .send({ status: "finished" })
      .expect(200);
  });

  it("marks native app audio as unavailable when signed native capture is disabled", async () => {
    const runtimeConfig = await createRuntimeConfig();
    runtimeConfig.sttProvider = "whisper";
    const whisperProvider = new FakeWhisperProvider();

    await writeFakeNativeHelper(
      runtimeConfig,
      `#!/bin/sh
set -eu
case "$1" in
  status)
    echo granted
    ;;
  request)
    echo granted
    ;;
  list)
    printf '%s\n' '{"displays":[{"id":"100","name":"Primary Display","displayId":"100","isDefault":true}],"applications":[{"id":"456","name":"Discord","bundleId":"com.discord.Discord"}]}'
    ;;
  *)
    echo "unsupported" >&2
    exit 1
    ;;
esac
`
    );

    const service = new AppService(
      runtimeConfig,
      new Map([["whisper", whisperProvider]]),
      new Map([["mock", new MockAnalysisProvider()]])
    );
    await service.initialize();
    const app = createApp(service, runtimeConfig.publicDir, runtimeConfig.sessionsDir, process.cwd());

    await request(app)
      .post("/api/config")
      .send({
        sttProvider: "whisper",
        captureSources: [{
          id: "app-bundle:com.discord.Discord",
          kind: "native-app-audio",
          name: "Discord"
        }]
      })
      .expect(200);

    const stateResponse = await request(app).get("/api/state").expect(200);
    const source = stateResponse.body.captureSourceCatalog.find((entry: { id: string; }) => entry.id === "app-bundle:com.discord.Discord");
    expect(source.available).toBe(false);
    expect(source.availabilityReason).toContain("signed helper identity");
    expect(stateResponse.body.sourceMonitors["app-bundle:com.discord.Discord"].status).toBe("unsupported");
    expect(stateResponse.body.sourceMonitors["app-bundle:com.discord.Discord"].error).toContain("signed helper identity");

    const sessionResponse = await request(app).post("/api/session/start").expect(200);
    expect(sessionResponse.body.session.sourceMonitors["app-bundle:com.discord.Discord"].status).toBe("unsupported");
    expect(whisperProvider.startCalls).toBe(0);
  });

  it("surfaces a silent-segment diagnostic instead of silently dropping native audio", async () => {
    const runtimeConfig = await createRuntimeConfig();
    runtimeConfig.sttProvider = "whisper";
    runtimeConfig.enableNativeSystemAudioCapture = true;
    const whisperProvider = new FakeWhisperProvider();
    const silentSegmentPath = path.join(runtimeConfig.rootDir, "silent.wav");
    await fs.writeFile(
      silentSegmentPath,
      Buffer.from([
        0x52, 0x49, 0x46, 0x46, 0x28, 0x00, 0x00, 0x00,
        0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20,
        0x10, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00,
        0x80, 0x3e, 0x00, 0x00, 0x00, 0x7d, 0x00, 0x00,
        0x02, 0x00, 0x10, 0x00, 0x64, 0x61, 0x74, 0x61,
        0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00
      ])
    );

    await writeFakeNativeHelper(
      runtimeConfig,
      `#!/bin/sh
set -eu
case "$1" in
  status)
    echo granted
    ;;
  request)
    echo granted
    ;;
  list)
    printf '%s\n' '{"displays":[{"id":"100","name":"Studio Display","displayId":"100","isDefault":true}],"applications":[]}'
    ;;
  capture)
    printf '%s\n' '{"type":"segment","path":"${silentSegmentPath}","startedAt":"2026-03-16T10:00:00.000Z","endedAt":"2026-03-16T10:00:05.000Z"}'
    sleep 1
    ;;
  *)
    echo "unsupported" >&2
    exit 1
    ;;
esac
`
    );

    const service = new AppService(
      runtimeConfig,
      new Map([["whisper", whisperProvider]]),
      new Map([["mock", new MockAnalysisProvider()]])
    );
    await service.initialize();
    const app = createApp(service, runtimeConfig.publicDir, runtimeConfig.sessionsDir, process.cwd());

    await request(app)
      .post("/api/config")
      .send({
        sttProvider: "whisper",
        captureSources: [{
          id: "display:100",
          kind: "native-display-audio",
          name: "Studio Display"
        }]
      })
      .expect(200);

    await request(app).post("/api/session/start").expect(200);
    await delay(150);

    const stateResponse = await request(app).get("/api/state").expect(200);
    expect(stateResponse.body.sourceMonitors["display:100"].whisperLastError).toContain("Silent audio segment captured");

    await request(app)
      .post("/api/session/end")
      .send({ status: "finished" })
      .expect(200);
  });
});
