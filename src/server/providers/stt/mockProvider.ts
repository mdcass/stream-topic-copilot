import type { MicrophoneDevice, TranscriptEvent } from "../../domain/types.js";
import type { StartSttOptions, SttProvider, SttProviderHandlers, SttProviderSession } from "./providerTypes.js";

export class MockSttProvider implements SttProvider {
  readonly name = "mock";

  private readonly devices: MicrophoneDevice[] = [
    { id: "mock-default", name: "Mock Studio Mic", manufacturer: "Stream Topic Copilot", isDefault: true },
    { id: "mock-backup", name: "Mock Backup Mic", manufacturer: "Stream Topic Copilot", isDefault: false }
  ];

  async listDevices(): Promise<MicrophoneDevice[]> {
    return this.devices;
  }

  async start(_options: StartSttOptions, handlers: SttProviderHandlers): Promise<SttProviderSession> {
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
          text
        };

        await handlers.onLevel(Math.min(1, Math.max(0.05, text.length / 120)));
        await handlers.onTranscript(event);
      }
    };
  }
}
