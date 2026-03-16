import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ChunkSensitivity, RuntimeConfig } from "../domain/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = resolveProjectRoot();

function resolveProjectRoot(): string {
  const cwd = process.cwd();
  if (fs.existsSync(path.join(cwd, "package.json"))) {
    return cwd;
  }

  return path.resolve(__dirname, "../../..");
}

dotenv.config({ path: path.join(projectRoot, ".env") });

function resolveFromRoot(value: string | undefined, fallback: string): string {
  const target = value && value.trim().length > 0 ? value : fallback;
  return path.resolve(projectRoot, target);
}

function parseNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseOptionalNumber(value: string | undefined): number | null {
  if (!value || value.trim().length === 0) {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseSensitivity(value: string | undefined): ChunkSensitivity {
  if (value === "low" || value === "medium" || value === "high") {
    return value;
  }

  return "medium";
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  return fallback;
}

export function loadRuntimeConfig(): RuntimeConfig {
  return {
    rootDir: projectRoot,
    host: process.env.HOST ?? "127.0.0.1",
    port: parseNumber(process.env.PORT, 4312),
    dataDir: resolveFromRoot(process.env.DATA_DIR, "./data"),
    sessionsDir: resolveFromRoot(process.env.SESSIONS_DIR, "./sessions"),
    publicDir: resolveFromRoot(process.env.PUBLIC_DIR, "./dist/ui"),
    configPath: resolveFromRoot(process.env.CONFIG_PATH, "./data/config.json"),
    analysisProvider: process.env.ANALYSIS_PROVIDER ?? "mock",
    sttProvider: process.env.STT_PROVIDER ?? "mock",
    analysisProviderCommand: process.env.ANALYSIS_PROVIDER_COMMAND ?? "codex exec --skip-git-repo-check --color never",
    analysisStructuredOutputFlag: process.env.ANALYSIS_STRUCTURED_OUTPUT_FLAG ?? "--output-schema",
    analysisConfidenceThreshold: parseNumber(process.env.ANALYSIS_CONFIDENCE_THRESHOLD, 0.8),
    sttExecutable: process.env.STT_EXECUTABLE ?? "",
    whisperModel: process.env.WHISPER_MODEL ?? "small.en",
    pollingIntervalMs: parseNumber(process.env.POLLING_INTERVAL_MS, 2000),
    loggingFlags: (process.env.LOGGING_FLAGS ?? "analysis,transcript,state").split(",").map((value) => value.trim()).filter(Boolean),
    transcriptTailSize: parseNumber(process.env.TRANSCRIPT_TAIL_SIZE, 30),
    chunkWordThreshold: parseOptionalNumber(process.env.CHUNK_WORD_THRESHOLD),
    chunkTimeThresholdSeconds: parseOptionalNumber(process.env.CHUNK_TIME_THRESHOLD_SECONDS),
    defaultChunkSensitivity: parseSensitivity(process.env.CHUNK_SENSITIVITY),
    visibleSuggestionCount: parseNumber(process.env.VISIBLE_SUGGESTION_COUNT, 3),
    microphonePermissionHelper: resolveFromRoot(process.env.MIC_PERMISSION_HELPER, "./.bin/request-microphone-permission"),
    microphoneProbeHelper: resolveFromRoot(process.env.MIC_PROBE_HELPER, "./.bin/mic-level-probe"),
    sdlAudioDevicesHelper: resolveFromRoot(process.env.SDL_AUDIO_DEVICES_HELPER, "./.bin/sdl-audio-devices"),
    nativeSystemAudioHelper: resolveFromRoot(process.env.NATIVE_SYSTEM_AUDIO_HELPER, "./.bin/native-system-audio-helper"),
    enableNativeSystemAudioCapture: parseBoolean(process.env.ENABLE_NATIVE_SYSTEM_AUDIO_CAPTURE, false),
    analysisSchemaPath: resolveFromRoot(undefined, "./docs/scoping/codex-analysis-response-schema.json")
  };
}
