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

describe("file store migrations", () => {
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
