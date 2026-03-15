import type { MicrophoneDevice, TranscriptEvent } from "../../domain/types.js";

export interface SttProviderHandlers {
  onTranscript: (event: TranscriptEvent) => Promise<void>;
  onLevel: (level: number) => Promise<void>;
  onError: (error: Error) => Promise<void>;
}

export interface SttProviderSession {
  stop: () => Promise<void>;
  injectTranscript?: (text: string) => Promise<void>;
}

export interface StartSttOptions {
  microphoneId: string | null;
  sessionDir?: string;
  liveTranscriptPath?: string;
}

export interface SttProvider {
  readonly name: string;
  listDevices(): Promise<MicrophoneDevice[]>;
  start(options: StartSttOptions, handlers: SttProviderHandlers): Promise<SttProviderSession>;
  getDebugState?(): Record<string, string | null>;
}
