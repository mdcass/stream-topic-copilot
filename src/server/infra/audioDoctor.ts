import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { createDefaultAppConfig, type AppConfig, type CaptureSourceDescriptor, type RuntimeConfig } from "../domain/types.js";
import { FileStore } from "./fileStore.js";
import { findRecommendedSystemMixSource } from "./inputSourceCatalog.js";
import { MicrophoneProbe } from "./microphoneProbe.js";
import { WhisperCppProvider } from "../providers/stt/whisperProvider.js";

export interface AudioDoctorCheck {
  id: string;
  status: "pass" | "warn" | "fail";
  message: string;
  details?: string[];
}

export interface AudioDoctorSignalResult {
  status: "signal-present" | "no-signal" | "unavailable";
  maxLevel: number;
  sampleCount: number;
  observedSeconds: number;
  errors: string[];
}

export interface AudioDoctorResult {
  ok: boolean;
  appliedConfig: boolean;
  recommendedSource: Pick<CaptureSourceDescriptor, "id" | "name" | "probeId"> | null;
  selectedSystemMixSourceId: string | null;
  checks: AudioDoctorCheck[];
  signal: AudioDoctorSignalResult | null;
}

interface RunAudioDoctorOptions {
  applyConfig?: boolean;
  probeSeconds?: number;
  skipLiveProbe?: boolean;
}

const LIVE_SIGNAL_THRESHOLD = 0.05;

export async function runAudioDoctor(
  runtimeConfig: RuntimeConfig,
  options: RunAudioDoctorOptions = {}
): Promise<AudioDoctorResult> {
  const checks: AudioDoctorCheck[] = [];
  const fileStore = new FileStore(runtimeConfig);
  await fileStore.ensureProjectDirs();

  const config = await fileStore.loadConfig(
    createDefaultAppConfig(path.join(runtimeConfig.dataDir, "sample-topics.md"), runtimeConfig)
  );

  const helperPaths = [
    ["sdl-audio-devices", runtimeConfig.sdlAudioDevicesHelper],
    ["mic-level-probe", runtimeConfig.microphoneProbeHelper],
    ["native-system-audio-helper", runtimeConfig.nativeSystemAudioHelper]
  ] as const;

  await Promise.all(helperPaths.map(async ([id, helperPath]) => {
    const present = await pathExists(helperPath);
    checks.push({
      id: `helper:${id}`,
      status: present ? "pass" : "fail",
      message: present ? `${id} is present.` : `${id} is missing at ${helperPath}.`
    });
  }));

  const whisperProvider = new WhisperCppProvider(runtimeConfig);
  const sources = await new MicrophoneProbe(runtimeConfig).annotateDevices(await whisperProvider.listSources());
  const debugState = whisperProvider.getDebugState?.() ?? {};
  const recommendedSource = findRecommendedSystemMixSource(sources);

  checks.push({
    id: "blackhole-enumeration",
    status: recommendedSource ? "pass" : "fail",
    message: recommendedSource
      ? `Detected routed desktop-audio input: ${recommendedSource.name}.`
      : "No routed desktop-audio input device was detected. Install BlackHole and ensure it appears as an input device.",
    details: recommendedSource
      ? recommendedSource.probeId ? ["Native probe mapping available."] : ["No native probe mapping found for the detected input device."]
      : debugState.whisperDeviceEnumerationError ? [debugState.whisperDeviceEnumerationError] : undefined
  });

  let appliedConfig = false;
  let effectiveConfig: AppConfig = config;
  if (options.applyConfig && recommendedSource) {
    const nextConfig = withRecommendedSystemMix(config, recommendedSource);
    if (JSON.stringify(nextConfig.captureSources) !== JSON.stringify(config.captureSources)) {
      await fileStore.saveConfig(nextConfig);
      appliedConfig = true;
      effectiveConfig = nextConfig;
    }
  }

  const selectedSystemMix = effectiveConfig.captureSources.find((source) => source.kind === "system-mix") ?? null;
  checks.push({
    id: "config-system-mix",
    status: recommendedSource && selectedSystemMix?.id === recommendedSource.id
      ? "pass"
      : recommendedSource
        ? "fail"
        : "warn",
    message: recommendedSource && selectedSystemMix?.id === recommendedSource.id
      ? `Config selects the recommended desktop-audio source (${recommendedSource.name}).`
      : recommendedSource
        ? "Config does not currently select the recommended desktop-audio source."
        : "Config cannot be validated until a routed desktop-audio source is detected.",
    details: selectedSystemMix ? [`Current system-mix selection: ${selectedSystemMix.name} (${selectedSystemMix.id})`] : ["No system-mix source selected in config."]
  });

  let signal: AudioDoctorSignalResult | null = null;
  if (!options.skipLiveProbe && recommendedSource) {
    signal = await runLiveProbe(runtimeConfig, recommendedSource, options.probeSeconds ?? 3);
    checks.push({
      id: "live-probe",
      status: signal.status === "signal-present" ? "pass" : "fail",
      message: signal.status === "signal-present"
        ? `Live probe observed signal on ${recommendedSource.name}.`
        : signal.status === "no-signal"
          ? `Live probe saw no signal on ${recommendedSource.name}. Route system audio to the device before going live.`
          : `Live probe could not validate ${recommendedSource.name}.`,
      details: [
        `Observed seconds: ${signal.observedSeconds}`,
        `Samples: ${signal.sampleCount}`,
        `Max level: ${signal.maxLevel.toFixed(3)}`,
        ...signal.errors
      ]
    });
  }

  return {
    ok: checks.every((check) => check.status !== "fail"),
    appliedConfig,
    recommendedSource: recommendedSource ? {
      id: recommendedSource.id,
      name: recommendedSource.name,
      probeId: recommendedSource.probeId
    } : null,
    selectedSystemMixSourceId: selectedSystemMix?.id ?? null,
    checks,
    signal
  };
}

export function withRecommendedSystemMix(config: AppConfig, source: Pick<CaptureSourceDescriptor, "id" | "name">): AppConfig {
  const nonSystemMixSources = config.captureSources.filter((entry) => entry.kind !== "system-mix");
  return {
    ...config,
    captureSources: [
      ...nonSystemMixSources,
      {
        id: source.id,
        kind: "system-mix",
        name: source.name
      }
    ]
  };
}

async function runLiveProbe(
  runtimeConfig: RuntimeConfig,
  source: CaptureSourceDescriptor,
  probeSeconds: number
): Promise<AudioDoctorSignalResult> {
  const errors: string[] = [];
  let maxLevel = 0;
  let sampleCount = 0;
  const probe = new MicrophoneProbe(runtimeConfig);

  if (!source.probeId) {
    return {
      status: "unavailable",
      maxLevel,
      sampleCount,
      observedSeconds: probeSeconds,
      errors: ["No native probe mapping is available for the selected desktop-audio source."]
    };
  }

  await probe.start(source, {
    onLevel: (level) => {
      sampleCount += 1;
      maxLevel = Math.max(maxLevel, level);
    },
    onError: (message) => {
      errors.push(message);
    }
  });

  await delay(probeSeconds * 1000);
  await probe.stop();

  const status = sampleCount > 0 && maxLevel >= LIVE_SIGNAL_THRESHOLD
    ? "signal-present"
    : sampleCount > 0
      ? "no-signal"
      : "unavailable";

  return {
    status,
    maxLevel,
    sampleCount,
    observedSeconds: probeSeconds,
    errors
  };
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}
