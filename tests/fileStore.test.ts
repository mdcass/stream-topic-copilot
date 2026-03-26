import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { AppConfig, RuntimeConfig } from "../src/server/domain/types.js";
import { FileStore } from "../src/server/infra/fileStore.js";

const tempDirs: string[] = [];

async function createRuntimeConfig(): Promise<RuntimeConfig> {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "stream-topic-copilot-"));
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
    defaultConfigPath: path.join(rootDir, "data/config.default.json"),
    configPath: path.join(rootDir, "data/config.local.json"),
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

describe("file store migrations", () => {
  it("uses committed defaults until a local config override exists", async () => {
    const runtimeConfig = await createRuntimeConfig();
    const fileStore = new FileStore(runtimeConfig);
    await fileStore.ensureProjectDirs();
    await fs.writeFile(runtimeConfig.defaultConfigPath, JSON.stringify({
      markdownFilePath: "./sample-topics.md",
      captureSources: [],
      sttProvider: "mock",
      analysisProvider: "mock",
      chunkSensitivity: "high",
      visibleSuggestionCounts: {
        activeTopics: 2,
        elaborationStarters: 2,
        adjacentNextTopics: 2,
        recoveryPrompts: 2,
        offTopicObservations: 2
      },
      sessionResumePreference: "latest",
      analysisAutoApplyThreshold: 0.6,
      pollingIntervalMs: 1500,
      transcriptTailSize: 12
    }, null, 2));

    const defaultConfig: AppConfig = {
      markdownFilePath: path.join(runtimeConfig.dataDir, "sample-topics.md"),
      captureSources: [],
      sttProvider: "mock",
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
    };

    const fromDefaults = await fileStore.loadConfig(defaultConfig);
    expect(fromDefaults.markdownFilePath).toBe(path.join(runtimeConfig.dataDir, "sample-topics.md"));
    expect(fromDefaults.chunkSensitivity).toBe("high");
    expect(fromDefaults.sessionResumePreference).toBe("latest");
    expect(await fileStore.exists(runtimeConfig.configPath)).toBe(false);

    await fs.writeFile(runtimeConfig.configPath, JSON.stringify({
      markdownFilePath: "./operator-topics.md",
      captureSources: [{
        id: "desk-mic",
        kind: "microphone",
        name: "Desk Mic"
      }],
      sttProvider: "whisper",
      analysisProvider: "codex",
      chunkSensitivity: "low",
      visibleSuggestionCounts: {
        activeTopics: 4,
        elaborationStarters: 4,
        adjacentNextTopics: 4,
        recoveryPrompts: 4,
        offTopicObservations: 4
      },
      sessionResumePreference: "manual",
      analysisAutoApplyThreshold: 0.9,
      pollingIntervalMs: 2500,
      transcriptTailSize: 40
    }, null, 2));

    const fromLocalOverride = await fileStore.loadConfig(defaultConfig);
    expect(fromLocalOverride.markdownFilePath).toBe(path.join(runtimeConfig.dataDir, "operator-topics.md"));
    expect(fromLocalOverride.captureSources).toEqual([{
      id: "desk-mic",
      kind: "microphone",
      name: "Desk Mic"
    }]);
    expect(fromLocalOverride.sttProvider).toBe("whisper");
    expect(fromLocalOverride.analysisProvider).toBe("codex");
    expect(fromLocalOverride.chunkSensitivity).toBe("low");
  });

  it("migrates legacy microphoneId config into captureSources", async () => {
    const runtimeConfig = await createRuntimeConfig();
    const fileStore = new FileStore(runtimeConfig);
    await fileStore.ensureProjectDirs();
    await fs.writeFile(runtimeConfig.configPath, JSON.stringify({
      markdownFilePath: "/tmp/topics.md",
      microphoneId: "legacy-mic",
      sttProvider: "mock",
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

    const defaultConfig: AppConfig = {
      markdownFilePath: "/tmp/topics.md",
      captureSources: [],
      sttProvider: "mock",
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
    };

    const loaded = await fileStore.loadConfig(defaultConfig);

    expect(loaded.captureSources).toEqual([{
      id: "legacy-mic",
      kind: "microphone",
      name: "legacy-mic"
    }]);
  });

  it("migrates legacy loopback selections into system-mix", async () => {
    const runtimeConfig = await createRuntimeConfig();
    const fileStore = new FileStore(runtimeConfig);
    await fileStore.ensureProjectDirs();
    await fs.writeFile(runtimeConfig.configPath, JSON.stringify({
      markdownFilePath: "/tmp/topics.md",
      captureSources: [{
        id: "BlackHole 2ch",
        kind: "loopback-input",
        name: "BlackHole 2ch"
      }],
      sttProvider: "mock",
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

    const defaultConfig: AppConfig = {
      markdownFilePath: "/tmp/topics.md",
      captureSources: [],
      sttProvider: "mock",
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
    };

    const loaded = await fileStore.loadConfig(defaultConfig);

    expect(loaded.captureSources).toEqual([{
      id: "BlackHole 2ch",
      kind: "system-mix",
      name: "BlackHole 2ch"
    }]);
  });
});
