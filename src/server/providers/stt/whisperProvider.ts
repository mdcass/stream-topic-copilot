import { execFile, spawn } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import type { CaptureSourceDescriptor, RuntimeConfig, TranscriptEvent } from "../../domain/types.js";
import { classifyInputSource, groupLabelForInputSource } from "../../infra/inputSourceCatalog.js";
import type { StartSttOptions, SttProvider, SttProviderHandlers, SttProviderSession } from "./providerTypes.js";

const execFileAsync = promisify(execFile);

export class WhisperCppProvider implements SttProvider {
  readonly name = "whisper";
  private cachedSources: CaptureSourceDescriptor[] = [];
  private cacheExpiresAt = 0;
  private lastEnumerationError: string | null = null;
  private lastStartError: string | null = null;
  private lastPublishedText = "";
  private lastPublishedAt = 0;

  constructor(private readonly runtimeConfig: RuntimeConfig) {}

  async listSources(): Promise<CaptureSourceDescriptor[]> {
    if (Date.now() < this.cacheExpiresAt && this.cachedSources.length > 0) {
      return this.cachedSources;
    }

    try {
      const { stdout } = await execFileAsync(this.runtimeConfig.sdlAudioDevicesHelper, []);
      const parsed = JSON.parse(stdout) as Array<{ id: string; name: string; isDefault: boolean; }>;
      this.cachedSources = parsed.map((device) => ({
        id: device.id,
        name: device.name,
        kind: classifyInputSource(device.name),
        groupLabel: groupLabelForInputSource(classifyInputSource(device.name)),
        transport: "input-device",
        isDefault: device.isDefault,
        inputDeviceId: device.id
      }));
      this.cacheExpiresAt = Date.now() + 10_000;
      this.lastEnumerationError = null;
      return this.cachedSources;
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
    if (options.source.inputDeviceId) {
      args.push("-c", options.source.inputDeviceId);
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
        this.publishTranscriptSnapshot(segment, options.source, handlers);
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

  private publishTranscriptSnapshot(text: string, source: CaptureSourceDescriptor, handlers: SttProviderHandlers): void {
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
      sourceId: source.id,
      sourceName: source.name,
      sourceKind: source.kind,
      replaceLast
    };

    void handlers.onLevel(Math.min(1, Math.max(0.05, cleaned.length / 160)));
    void handlers.onTranscript(event);
  }

  async transcribeFile(audioPath: string): Promise<string> {
    const whisperCliPath = this.resolveWhisperCliPath();
    if (!whisperCliPath) {
      throw new Error("whisper-cli could not be resolved from STT_EXECUTABLE.");
    }

    const { stdout, stderr } = await execFileAsync(whisperCliPath, [
      "-m",
      this.runtimeConfig.whisperModel,
      "-f",
      audioPath,
      "-nt",
      "-np"
    ], {
      maxBuffer: 10 * 1024 * 1024
    });
    const text = stdout.trim();
    if (!text && stderr.trim()) {
      throw new Error(stderr.trim());
    }
    return text;
  }

  getDebugState(): Record<string, string | null> {
    return {
      whisperExecutable: this.runtimeConfig.sttExecutable || null,
      whisperModel: this.runtimeConfig.whisperModel || null,
      whisperDeviceEnumerationError: this.lastEnumerationError,
      whisperLastError: this.lastStartError
    };
  }

  private resolveWhisperCliPath(): string | null {
    if (!this.runtimeConfig.sttExecutable) {
      return null;
    }

    return path.join(path.dirname(this.runtimeConfig.sttExecutable), "whisper-cli");
  }
}
