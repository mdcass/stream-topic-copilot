import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";

import type { CaptureSourceDescriptor, RuntimeConfig } from "../domain/types.js";

const execFileAsync = promisify(execFile);

interface ProbeHelperDevice {
  name: string;
  uniqueId: string;
}

export interface ProbeHandlers {
  onLevel: (level: number) => void;
  onError: (message: string) => void;
}

export class MicrophoneProbe {
  private child: ChildProcess | null = null;
  private cachedDevices: ProbeHelperDevice[] = [];
  private cacheExpiresAt = 0;
  private lastError: string | null = null;

  constructor(private readonly runtimeConfig: RuntimeConfig) {}

  async listDevices(): Promise<ProbeHelperDevice[]> {
    if (Date.now() < this.cacheExpiresAt && this.cachedDevices.length > 0) {
      return this.cachedDevices;
    }

    try {
      const { stdout } = await execFileAsync(this.runtimeConfig.microphoneProbeHelper, ["list"]);
      const parsed = JSON.parse(stdout) as ProbeHelperDevice[];
      this.cachedDevices = parsed;
      this.cacheExpiresAt = Date.now() + 10_000;
      this.lastError = null;
      return parsed;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      return [];
    }
  }

  async annotateDevices(devices: CaptureSourceDescriptor[]): Promise<CaptureSourceDescriptor[]> {
    const probeDevices = await this.listDevices();
    const probeIdByName = new Map(probeDevices.map((device) => [device.name, device.uniqueId]));
    return devices.map((device) => ({
      ...device,
      probeId: device.transport === "input-device" ? probeIdByName.get(device.name) : undefined
    }));
  }

  async start(device: CaptureSourceDescriptor | null, handlers: ProbeHandlers): Promise<void> {
    await this.stop();

    if (!device?.probeId) {
      if (device) {
        handlers.onError(`No native probe mapping found for ${device.name}.`);
      }
      return;
    }

    try {
      this.child = spawn(this.runtimeConfig.microphoneProbeHelper, ["probe", device.probeId], {
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch (error) {
      handlers.onError(error instanceof Error ? error.message : String(error));
      this.child = null;
      return;
    }

    let stdoutBuffer = "";

    this.child.stdout?.setEncoding("utf8");
    this.child.stdout?.on("data", (chunk: string) => {
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }

        try {
          const payload = JSON.parse(trimmed) as { type: string; level?: number; message?: string; };
          if (payload.type === "level" && typeof payload.level === "number") {
            handlers.onLevel(payload.level);
          }
        } catch (error) {
          handlers.onError(`Probe emitted invalid JSON: ${trimmed}`);
        }
      }
    });

    this.child.stderr?.setEncoding("utf8");
    this.child.stderr?.on("data", (chunk: string) => {
      const text = chunk.trim();
      if (text) {
        handlers.onError(text);
      }
    });

    this.child.on("exit", (code) => {
      if (code && code !== 0) {
        handlers.onError(`Mic probe exited with code ${code}.`);
      }
      this.child = null;
    });
  }

  async stop(): Promise<void> {
    if (!this.child) {
      return;
    }

    this.child.kill("SIGTERM");
    this.child = null;
  }

  getLastError(): string | null {
    return this.lastError;
  }
}
