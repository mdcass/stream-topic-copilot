import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { RuntimeConfig } from "../src/server/domain/types.js";
import { runAudioDoctor } from "../src/server/infra/audioDoctor.js";

const tempDirs: string[] = [];

async function createRuntimeConfig(): Promise<RuntimeConfig> {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "stream-topic-copilot-audio-doctor-"));
  tempDirs.push(rootDir);
  const dataDir = path.join(rootDir, "data");
  const sessionsDir = path.join(rootDir, "sessions");
  await fs.mkdir(dataDir, { recursive: true });
  await fs.mkdir(sessionsDir, { recursive: true });

  return {
    rootDir,
    host: "127.0.0.1",
    port: 4312,
    dataDir,
    sessionsDir,
    publicDir: path.resolve("src/ui"),
    configPath: path.join(dataDir, "config.json"),
    analysisProvider: "mock",
    sttProvider: "whisper",
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

async function writeExecutable(target: string, contents: string): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, contents, { mode: 0o755 });
  await fs.chmod(target, 0o755);
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("audio doctor", () => {
  it("reports missing helpers and missing routed desktop audio", async () => {
    const runtimeConfig = await createRuntimeConfig();

    const result = await runAudioDoctor(runtimeConfig, {
      skipLiveProbe: true
    });

    expect(result.ok).toBe(false);
    expect(result.checks.find((check) => check.id === "helper:sdl-audio-devices")?.status).toBe("fail");
    expect(result.checks.find((check) => check.id === "blackhole-enumeration")?.status).toBe("fail");
  });

  it("applies the recommended desktop-audio source and flags missing live signal", async () => {
    const runtimeConfig = await createRuntimeConfig();
    await fs.writeFile(runtimeConfig.configPath, JSON.stringify({
      markdownFilePath: "/tmp/topics.md",
      captureSources: [{
        id: "Built-in Microphone",
        kind: "microphone",
        name: "Built-in Microphone"
      }],
      sttProvider: "whisper",
      analysisProvider: "mock",
      chunkSensitivity: "medium",
      visibleSuggestionCounts: {
        activeTopics: 3,
        elaborationStarters: 3,
        adjacentNextTopics: 3,
        recoveryPrompts: 3,
        offTopicObservations: 3
      },
      sessionResumePreference: "manual",
      analysisAutoApplyThreshold: 0.8,
      pollingIntervalMs: 2000,
      transcriptTailSize: 30
    }, null, 2));

    await writeExecutable(runtimeConfig.sdlAudioDevicesHelper, `#!/bin/sh
printf '%s' '[{"id":"BlackHole 2ch","name":"BlackHole 2ch","isDefault":true}]'
`);
    await writeExecutable(runtimeConfig.microphoneProbeHelper, `#!/bin/sh
set -eu
case "$1" in
  list)
    printf '%s\n' '[{"name":"BlackHole 2ch","uniqueId":"probe-blackhole"}]'
    ;;
  probe)
    printf '%s\n' '{"type":"level","level":0.01}'
    ;;
  *)
    exit 1
    ;;
esac
`);
    await writeExecutable(runtimeConfig.nativeSystemAudioHelper, "#!/bin/sh\nexit 0\n");

    const result = await runAudioDoctor(runtimeConfig, {
      applyConfig: true,
      probeSeconds: 1
    });

    expect(result.appliedConfig).toBe(true);
    expect(result.selectedSystemMixSourceId).toBe("BlackHole 2ch");
    expect(result.signal?.status).toBe("no-signal");
    expect(result.checks.find((check) => check.id === "config-system-mix")?.status).toBe("pass");
    expect(result.ok).toBe(false);
  });

  it("passes when the routed desktop-audio source has signal", async () => {
    const runtimeConfig = await createRuntimeConfig();
    await fs.writeFile(runtimeConfig.configPath, JSON.stringify({
      markdownFilePath: "/tmp/topics.md",
      captureSources: [{
        id: "BlackHole 2ch",
        kind: "system-mix",
        name: "BlackHole 2ch"
      }],
      sttProvider: "whisper",
      analysisProvider: "mock",
      chunkSensitivity: "medium",
      visibleSuggestionCounts: {
        activeTopics: 3,
        elaborationStarters: 3,
        adjacentNextTopics: 3,
        recoveryPrompts: 3,
        offTopicObservations: 3
      },
      sessionResumePreference: "manual",
      analysisAutoApplyThreshold: 0.8,
      pollingIntervalMs: 2000,
      transcriptTailSize: 30
    }, null, 2));

    await writeExecutable(runtimeConfig.sdlAudioDevicesHelper, `#!/bin/sh
printf '%s' '[{"id":"BlackHole 2ch","name":"BlackHole 2ch","isDefault":true}]'
`);
    await writeExecutable(runtimeConfig.microphoneProbeHelper, `#!/bin/sh
set -eu
case "$1" in
  list)
    printf '%s\n' '[{"name":"BlackHole 2ch","uniqueId":"probe-blackhole"}]'
    ;;
  probe)
    printf '%s\n' '{"type":"level","level":0.24}'
    ;;
  *)
    exit 1
    ;;
esac
`);
    await writeExecutable(runtimeConfig.nativeSystemAudioHelper, "#!/bin/sh\nexit 0\n");

    const result = await runAudioDoctor(runtimeConfig, {
      probeSeconds: 1
    });

    expect(result.ok).toBe(true);
    expect(result.signal?.status).toBe("signal-present");
    expect(result.checks.find((check) => check.id === "live-probe")?.status).toBe("pass");
  });
});
