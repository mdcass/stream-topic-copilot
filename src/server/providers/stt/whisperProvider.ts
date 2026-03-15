import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

import type { MicrophoneDevice, RuntimeConfig, TranscriptEvent } from "../../domain/types.js";
import type { StartSttOptions, SttProvider, SttProviderHandlers, SttProviderSession } from "./providerTypes.js";

const execFileAsync = promisify(execFile);

export class WhisperCppProvider implements SttProvider {
  readonly name = "whisper";
  private cachedDevices: MicrophoneDevice[] = [];
  private cacheExpiresAt = 0;
  private lastEnumerationError: string | null = null;
  private lastStartError: string | null = null;
  private lastPublishedText = "";
  private lastPublishedAt = 0;

  constructor(private readonly runtimeConfig: RuntimeConfig) {}

  async listDevices(): Promise<MicrophoneDevice[]> {
    if (Date.now() < this.cacheExpiresAt && this.cachedDevices.length > 0) {
      return this.cachedDevices;
    }

    try {
      const helperPath = `${this.runtimeConfig.rootDir}/.bin/sdl-audio-devices`;
      const { stdout } = await execFileAsync(helperPath, []);
      const parsed = JSON.parse(stdout) as Array<{ id: string; name: string; isDefault: boolean; }>;
      this.cachedDevices = parsed.map((device) => ({
        id: device.id,
        name: device.name,
        isDefault: device.isDefault
      }));
      this.cacheExpiresAt = Date.now() + 10_000;
      this.lastEnumerationError = null;
      return this.cachedDevices;
    } catch (error) {
      this.lastEnumerationError = error instanceof Error ? error.message : String(error);
      return [];
    }
  }

  async start(options: StartSttOptions, handlers: SttProviderHandlers): Promise<SttProviderSession> {
    if (!this.runtimeConfig.sttExecutable) {
      throw new Error("STT_EXECUTABLE is not configured. Install whisper.cpp and set the binary path in .env.");
    }

    const args = ["-m", this.runtimeConfig.whisperModel, "-sa"];
    if (options.microphoneId) {
      args.push("-c", options.microphoneId);
    }
    if (options.liveTranscriptPath) {
      args.push("-f", options.liveTranscriptPath);
    }

    const child = spawn(this.runtimeConfig.sttExecutable, args, {
      cwd: options.sessionDir ?? this.runtimeConfig.rootDir,
      stdio: ["ignore", "pipe", "pipe"]
    });
    this.lastStartError = null;
    this.lastPublishedText = "";
    this.lastPublishedAt = 0;

    let buffer = "";

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += this.normalizeStdoutChunk(chunk);
      const segments = buffer.split(/\r|\n/);
      buffer = segments.pop() ?? "";

      for (const segment of segments) {
        this.publishTranscriptSnapshot(segment, handlers);
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      const text = chunk.trim();
      if (!text) {
        return;
      }

      this.lastStartError = text;
      void handlers.onError(new Error(text));
    });

    return {
      stop: async () => {
        child.kill("SIGTERM");
      }
    };
  }

  private normalizeStdoutChunk(chunk: string): string {
    return chunk
      .replace(/\u001b\[[0-9;]*[A-Za-z]/g, "")
      .replace(/\r+/g, "\r")
      .replace(/[ \t]+\r/g, "\r");
  }

  private publishTranscriptSnapshot(text: string, handlers: SttProviderHandlers): void {
    const cleaned = text.replace(/\s+/g, " ").trim();
    if (!cleaned) {
      return;
    }

    const now = Date.now();
    const replaceLast = this.lastPublishedText.length > 0 && (now - this.lastPublishedAt) < 8_000;
    if (cleaned === this.lastPublishedText) {
      return;
    }

    this.lastPublishedText = cleaned;
    this.lastPublishedAt = now;

    const event: TranscriptEvent = {
      id: `evt_${now.toString(36)}`,
      timestamp: new Date().toISOString(),
      text: cleaned,
      replaceLast
    };

    void handlers.onLevel(Math.min(1, Math.max(0.05, cleaned.length / 160)));
    void handlers.onTranscript(event);
  }

  getDebugState(): Record<string, string | null> {
    return {
      whisperExecutable: this.runtimeConfig.sttExecutable || null,
      whisperModel: this.runtimeConfig.whisperModel || null,
      whisperDeviceEnumerationError: this.lastEnumerationError,
      whisperLastError: this.lastStartError
    };
  }
}
