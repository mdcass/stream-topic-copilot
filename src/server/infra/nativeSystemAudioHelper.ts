import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";

import type { CaptureSourceDescriptor, CaptureSourceKind, PermissionState, RuntimeConfig } from "../domain/types.js";

const execFileAsync = promisify(execFile);

interface NativeListPayload {
  displays: Array<{
    id: string;
    name: string;
    displayId?: string;
    isDefault?: boolean;
  }>;
  applications: Array<{
    id: string;
    name: string;
    bundleId?: string;
  }>;
}

interface CaptureHandlers {
  onLevel: (level: number) => void;
  onSegment: (payload: { path: string; startedAt: string; endedAt: string; }) => void;
  onError: (message: string) => void;
}

export interface NativeSourceCatalogResult {
  sources: CaptureSourceDescriptor[];
  permissionState: PermissionState | null;
  error: string | null;
}

export interface NativeCaptureSession {
  stop: () => Promise<void>;
}

export class NativeSystemAudioHelper {
  constructor(private readonly runtimeConfig: RuntimeConfig) {}

  async listSourceCatalog(): Promise<NativeSourceCatalogResult> {
    if (!this.runtimeConfig.nativeSystemAudioHelper) {
      return {
        sources: [],
        permissionState: "unavailable",
        error: "Native system audio helper is not configured."
      };
    }

    try {
      const { stdout } = await execFileAsync(this.runtimeConfig.nativeSystemAudioHelper, ["list"], {
        maxBuffer: 10 * 1024 * 1024
      });
      const payload = JSON.parse(stdout) as NativeListPayload;
      return {
        sources: [
          ...payload.displays.map((display) => ({
            id: `display:${display.id}`,
            name: display.name,
            kind: "native-display-audio" as CaptureSourceKind,
            groupLabel: "Advanced: Displays",
            transport: "screencapturekit" as const,
            isDefault: Boolean(display.isDefault),
            nativeTargetId: display.id,
            nativeDisplayId: display.displayId
          })),
          ...payload.applications.map((application) => ({
            id: application.bundleId ? `app-bundle:${application.bundleId}` : `app:${application.id}`,
            name: application.name,
            kind: "native-app-audio" as CaptureSourceKind,
            groupLabel: "Advanced: Apps",
            transport: "screencapturekit" as const,
            isDefault: false,
            nativeTargetId: application.id,
            bundleId: application.bundleId
          }))
        ],
        permissionState: "granted",
        error: null
      };
    } catch (error) {
      const message = extractHelperErrorMessage(error);
      return {
        sources: [],
        permissionState: inferPermissionStateFromError(message),
        error: message
      };
    }
  }

  async listSources(): Promise<CaptureSourceDescriptor[]> {
    const result = await this.listSourceCatalog();
    return result.sources;
  }

  async getPermissionState(): Promise<PermissionState> {
    if (!this.runtimeConfig.nativeSystemAudioHelper) {
      return "unavailable";
    }

    try {
      const { stdout } = await execFileAsync(this.runtimeConfig.nativeSystemAudioHelper, ["status"]);
      const normalized = stdout.trim();
      if (
        normalized === "granted" ||
        normalized === "denied" ||
        normalized === "not-determined" ||
        normalized === "unknown"
      ) {
        return normalized;
      }
      return "unknown";
    } catch (error) {
      return inferPermissionStateFromError(extractHelperErrorMessage(error)) ?? "unavailable";
    }
  }

  async requestPermission(): Promise<PermissionState> {
    if (!this.runtimeConfig.nativeSystemAudioHelper) {
      return "unavailable";
    }

    try {
      const { stdout } = await execFileAsync(this.runtimeConfig.nativeSystemAudioHelper, ["request"]);
      const normalized = stdout.trim();
      if (
        normalized === "granted" ||
        normalized === "denied" ||
        normalized === "not-determined" ||
        normalized === "unknown"
      ) {
        return normalized;
      }
      return "unknown";
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "stdout" in error &&
        typeof error.stdout === "string"
      ) {
        const normalized = error.stdout.trim();
        if (
          normalized === "granted" ||
          normalized === "denied" ||
          normalized === "not-determined" ||
          normalized === "unknown"
        ) {
          return normalized;
        }
      }
      return inferPermissionStateFromError(extractHelperErrorMessage(error)) ?? "unavailable";
    }
  }

  startCapture(source: CaptureSourceDescriptor, outputDir: string, handlers: CaptureHandlers): NativeCaptureSession {
    const args = [
      "capture",
      "--kind",
      source.kind,
      "--target-id",
      source.nativeTargetId ?? source.id,
      "--source-id",
      source.id,
      "--output-dir",
      outputDir
    ];
    if (source.bundleId) {
      args.push("--bundle-id", source.bundleId);
    }

    const child = spawn(this.runtimeConfig.nativeSystemAudioHelper, args, {
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stopping = false;

    let stdoutBuffer = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }

        try {
          const payload = JSON.parse(trimmed) as {
            type: string;
            level?: number;
            message?: string;
            path?: string;
            startedAt?: string;
            endedAt?: string;
          };
          if (payload.type === "level" && typeof payload.level === "number") {
            handlers.onLevel(payload.level);
            continue;
          }
          if (
            payload.type === "segment" &&
            payload.path &&
            payload.startedAt &&
            payload.endedAt
          ) {
            handlers.onSegment({
              path: payload.path,
              startedAt: payload.startedAt,
              endedAt: payload.endedAt
            });
            continue;
          }
          if (payload.type === "error" && payload.message && !stopping) {
            handlers.onError(payload.message);
          }
        } catch {
          if (!stopping) {
            handlers.onError(`Native helper emitted invalid JSON: ${trimmed}`);
          }
        }
      }
    });

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      const text = chunk.trim();
      if (text && !stopping) {
        handlers.onError(text);
      }
    });

    child.on("error", (error) => {
      if (!stopping) {
        handlers.onError(error.message);
      }
    });

    child.on("exit", (code) => {
      if (!stopping && code && code !== 0) {
        handlers.onError(`Native helper exited with code ${code}.`);
      }
    });

    return {
      stop: async () => {
        stopping = true;
        await stopChild(child);
      }
    };
  }
}

function extractHelperErrorMessage(error: unknown): string {
  if (typeof error === "string") {
    return error;
  }

  if (error && typeof error === "object") {
    const stderr = "stderr" in error && typeof error.stderr === "string" ? error.stderr.trim() : "";
    const stdout = "stdout" in error && typeof error.stdout === "string" ? error.stdout.trim() : "";
    const message = "message" in error && typeof error.message === "string" ? error.message.trim() : "";
    return stderr || stdout || message || "Unknown native system audio helper error.";
  }

  return "Unknown native system audio helper error.";
}

function inferPermissionStateFromError(message: string): PermissionState | null {
  const normalized = message.toLowerCase();
  if (
    normalized.includes("declined tcc") ||
    normalized.includes("user declined") ||
    normalized.includes("not authorized") ||
    normalized.includes("permission")
  ) {
    return "denied";
  }

  return null;
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  await new Promise<void>((resolve) => {
    let finished = false;
    const complete = () => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timer);
      child.removeListener("exit", complete);
      child.removeListener("close", complete);
      resolve();
    };

    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill("SIGKILL");
        } catch {
          complete();
        }
      }
    }, 1000);

    child.once("exit", complete);
    child.once("close", complete);

    try {
      child.kill("SIGTERM");
    } catch {
      complete();
    }
  });
}
