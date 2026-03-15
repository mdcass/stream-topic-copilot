import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { MicrophonePermissionState, RuntimeConfig } from "../domain/types.js";

const execFileAsync = promisify(execFile);

export async function getMicrophonePermissionState(runtimeConfig: RuntimeConfig): Promise<MicrophonePermissionState> {
  if (!runtimeConfig.microphonePermissionHelper) {
    return "unavailable";
  }

  try {
    const { stdout } = await execFileAsync(runtimeConfig.microphonePermissionHelper, ["status"]);
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
    return "unavailable";
  }
}
