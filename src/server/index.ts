import { createServer } from "node:http";

import { createApp } from "./app.js";
import { AppService } from "./appService.js";
import { loadRuntimeConfig } from "./infra/runtimeConfig.js";
import { CodexCliAnalysisProvider } from "./providers/analysis/codexProvider.js";
import type { AnalysisProvider } from "./providers/analysis/providerTypes.js";
import { MockAnalysisProvider } from "./providers/analysis/mockProvider.js";
import { MockSttProvider } from "./providers/stt/mockProvider.js";
import type { SttProvider } from "./providers/stt/providerTypes.js";
import { WhisperCppProvider } from "./providers/stt/whisperProvider.js";

async function main(): Promise<void> {
  const runtimeConfig = loadRuntimeConfig();
  const sttProviders = new Map<string, SttProvider>([
    ["mock", new MockSttProvider()],
    ["whisper", new WhisperCppProvider(runtimeConfig)]
  ]);
  const analysisProviders = new Map<string, AnalysisProvider>([
    ["mock", new MockAnalysisProvider()],
    ["codex", new CodexCliAnalysisProvider(runtimeConfig)]
  ]);

  const service = new AppService(runtimeConfig, sttProviders, analysisProviders);
  await service.initialize();

  const app = createApp(service, runtimeConfig.publicDir, runtimeConfig.sessionsDir, runtimeConfig.rootDir);
  const server = createServer(app);

  const shutdown = async (status: "finished" | "interrupted") => {
    await service.endSession(status);
    server.close(() => process.exit(0));
  };

  process.on("SIGINT", () => {
    void shutdown("interrupted");
  });
  process.on("SIGTERM", () => {
    void shutdown("interrupted");
  });

  server.listen(runtimeConfig.port, runtimeConfig.host, () => {
    console.log(`Stream Topic Copilot listening on http://${runtimeConfig.host}:${runtimeConfig.port}`);
  });
}

void main();
