import type { RuntimeConfig, SystemAudioPermissionState } from "../domain/types.js";
import { NativeSystemAudioHelper } from "./nativeSystemAudioHelper.js";

export async function getSystemAudioPermissionState(runtimeConfig: RuntimeConfig): Promise<SystemAudioPermissionState> {
  const helper = new NativeSystemAudioHelper(runtimeConfig);
  return helper.getPermissionState();
}

export async function requestSystemAudioPermission(runtimeConfig: RuntimeConfig): Promise<SystemAudioPermissionState> {
  const helper = new NativeSystemAudioHelper(runtimeConfig);
  return helper.requestPermission();
}
