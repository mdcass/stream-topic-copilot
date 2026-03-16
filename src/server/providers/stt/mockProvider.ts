import type { CaptureSourceDescriptor, TranscriptEvent } from "../../domain/types.js";
import type { StartSttOptions, SttProvider, SttProviderHandlers, SttProviderSession } from "./providerTypes.js";

export class MockSttProvider implements SttProvider {
  readonly name = "mock";

  private readonly sources: CaptureSourceDescriptor[] = [
    {
      id: "mock-mic-default",
      name: "Mock Studio Mic",
      kind: "microphone",
      groupLabel: "Microphones",
      transport: "mock",
      manufacturer: "Stream Topic Copilot",
      isDefault: true,
      inputDeviceId: "mock-mic-default"
    },
    {
      id: "mock-system-mix",
      name: "Mock Desktop Audio",
      kind: "system-mix",
      groupLabel: "Desktop Audio",
      transport: "mock",
      manufacturer: "Stream Topic Copilot",
      isDefault: false,
      inputDeviceId: "mock-system-mix"
    },
    {
      id: "mock-display-main",
      name: "Mock Main Display",
      kind: "native-display-audio",
      groupLabel: "Advanced: Displays",
      transport: "mock",
      isDefault: false,
      nativeTargetId: "display-main"
    },
    {
      id: "mock-app-discord",
      name: "Mock Discord",
      kind: "native-app-audio",
      groupLabel: "Advanced: Apps",
      transport: "mock",
      isDefault: false,
      nativeTargetId: "app-discord",
      bundleId: "com.discord.Discord"
    }
  ];

  async listSources(): Promise<CaptureSourceDescriptor[]> {
    return this.sources;
  }

  async start(options: StartSttOptions, handlers: SttProviderHandlers): Promise<SttProviderSession> {
    let closed = false;

    return {
      stop: async () => {
        closed = true;
      },
      injectTranscript: async (text: string) => {
        if (closed) {
          return;
        }

        const event: TranscriptEvent = {
          id: `evt_${Date.now().toString(36)}`,
          timestamp: new Date().toISOString(),
          text,
          sourceId: options.source.id,
          sourceName: options.source.name,
          sourceKind: options.source.kind
        };

        await handlers.onLevel(Math.min(1, Math.max(0.05, text.length / 120)));
        await handlers.onTranscript(event);
      }
    };
  }

  async transcribeFile(_audioPath: string): Promise<string> {
    return "";
  }
}
