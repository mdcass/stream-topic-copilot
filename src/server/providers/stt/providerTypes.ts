import type { CaptureSourceDescriptor, TranscriptEvent } from "../../domain/types.js";

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
  source: CaptureSourceDescriptor;
  sessionDir?: string;
  liveTranscriptPath?: string;
}

export interface SttProvider {
  readonly name: string;
  listSources(): Promise<CaptureSourceDescriptor[]>;
  start(options: StartSttOptions, handlers: SttProviderHandlers): Promise<SttProviderSession>;
  transcribeFile?(audioPath: string): Promise<string>;
  getDebugState?(): Record<string, string | null>;
}
