import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

import type { MicrophoneDevice, RuntimeConfig, TranscriptEvent } from "../../domain/types.js";
import type { StartSttOptions, SttProvider, SttProviderHandlers, SttProviderSession } from "./providerTypes.js";

const execFileAsync = promisify(execFile);

interface SystemProfilerAudioResponse {
  SPAudioDataType?: Array<{
    _items?: Array<Record<string, unknown>>;
  }>;
}

export class WhisperCppProvider implements SttProvider {
  readonly name = "whisper";

  constructor(private readonly runtimeConfig: RuntimeConfig) {}

  async listDevices(): Promise<MicrophoneDevice[]> {
    try {
      const { stdout } = await execFileAsync("system_profiler", ["SPAudioDataType", "-json"]);
      const parsed = JSON.parse(stdout) as SystemProfilerAudioResponse;
      const devices = parsed.SPAudioDataType?.flatMap((entry) => entry._items ?? []) ?? [];

      return devices
        .filter((device) => Number(device.coreaudio_device_input ?? 0) > 0)
        .map((device) => ({
          id: String(device._name ?? "unknown"),
          name: String(device._name ?? "Unknown input"),
          manufacturer: typeof device.coreaudio_device_manufacturer === "string" ? device.coreaudio_device_manufacturer : undefined,
          transport: typeof device.coreaudio_device_transport === "string" ? device.coreaudio_device_transport : undefined,
          isDefault: device.coreaudio_default_audio_input_device === "spaudio_yes"
        }));
    } catch (error) {
      return [];
    }
  }

  async start(options: StartSttOptions, handlers: SttProviderHandlers): Promise<SttProviderSession> {
    if (!this.runtimeConfig.sttExecutable) {
      throw new Error("STT_EXECUTABLE is not configured. Install whisper.cpp and set the binary path in .env.");
    }

    const args = ["-m", this.runtimeConfig.whisperModel];
    if (options.microphoneId) {
      args.push("--capture-device", options.microphoneId);
    }

    const child = spawn(this.runtimeConfig.sttExecutable, args, {
      stdio: ["ignore", "pipe", "pipe"]
    });

    let buffer = "";

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const text = line.trim();
        if (!text) {
          continue;
        }

        const event: TranscriptEvent = {
          id: `evt_${Date.now().toString(36)}`,
          timestamp: new Date().toISOString(),
          text
        };

        void handlers.onLevel(Math.min(1, Math.max(0.05, text.length / 160)));
        void handlers.onTranscript(event);
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      const text = chunk.trim();
      if (!text) {
        return;
      }

      void handlers.onError(new Error(text));
    });

    return {
      stop: async () => {
        child.kill("SIGTERM");
      }
    };
  }
}
