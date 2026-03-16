import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

import { createApp } from "../src/server/app.js";
import { AppService } from "../src/server/appService.js";
import type { RuntimeConfig } from "../src/server/domain/types.js";
import { MockAnalysisProvider } from "../src/server/providers/analysis/mockProvider.js";
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
    nativeSystemAudioHelper: path.join(rootDir, ".bin/native-system-audio-helper"),
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
    expect(startResponse.body.session.id).toMatch(/^2026|^20/);

    await request(app)
      .post("/api/session/mock-transcript")
      .send({ text: "I finally started the new PC build and the cooling issue is still annoying." })
      .expect(200);

    const stateResponse = await request(app).get("/api/state").expect(200);
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

  it("preserves native selections and reports permission errors when system audio discovery is denied", async () => {
    const runtimeConfig = await createRuntimeConfig();
    runtimeConfig.sttProvider = "whisper";
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

  it("ends a session even if the native capture helper ignores SIGTERM", async () => {
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

  it("starts desktop-audio system-mix capture through native display audio", async () => {
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
    printf '%s\n' '{"displays":[{"id":"100","name":"Studio Display","displayId":"100","isDefault":true},{"id":"200","name":"Sidecar Display","displayId":"200","isDefault":false}],"applications":[]}'
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
          id: "system-mix:default",
          kind: "system-mix",
          name: "Desktop Audio"
        }]
      })
      .expect(200);

    const stateResponse = await request(app).get("/api/state").expect(200);
    expect(stateResponse.body.captureSourceCatalog).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "system-mix:default",
          kind: "system-mix",
          name: "Desktop Audio",
          groupLabel: "Desktop Audio"
        })
      ])
    );
    expect(stateResponse.body.sourceMonitors["system-mix:default"].error).toBeNull();
    expect(stateResponse.body.capturePermissions.systemAudio).toBe("granted");

    const sessionResponse = await request(app).post("/api/session/start").expect(200);
    expect(sessionResponse.body.session.captureSources).toEqual([{
      id: "system-mix:default",
      kind: "system-mix",
      name: "Desktop Audio"
    }]);
    expect(sessionResponse.body.session.sourceMonitors["system-mix:default"].status).toBe("running");
    expect(whisperProvider.startCalls).toBe(0);

    await request(app)
      .post("/api/session/end")
      .send({ status: "finished" })
      .expect(200);
  });

  it("keeps desktop audio running when one display capture errors but others remain active", async () => {
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
    printf '%s\n' '{"displays":[{"id":"100","name":"Primary Display","displayId":"100","isDefault":true},{"id":"200","name":"Secondary Display","displayId":"200","isDefault":false}],"applications":[]}'
    ;;
  capture)
    target=""
    while [ "$#" -gt 0 ]; do
      if [ "$1" = "--target-id" ]; then
        shift
        target="$1"
      fi
      shift || true
    done
    if [ "$target" = "100" ]; then
      printf '%s\n' '{"type":"error","message":"Failed during stream due to application connection being interrupted"}'
      sleep 2
      exit 0
    fi
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
          id: "system-mix:default",
          kind: "system-mix",
          name: "Desktop Audio"
        }]
      })
      .expect(200);

    await request(app).post("/api/session/start").expect(200);
    await delay(150);

    const stateResponse = await request(app).get("/api/state").expect(200);
    expect(stateResponse.body.sourceMonitors["system-mix:default"].status).toBe("running");
    expect(stateResponse.body.sourceMonitors["system-mix:default"].error).toBeNull();
    expect(stateResponse.body.sourceMonitors["system-mix:default"].whisperLastError).toContain("application connection being interrupted");

    await request(app)
      .post("/api/session/end")
      .send({ status: "finished" })
      .expect(200);
  });
});
