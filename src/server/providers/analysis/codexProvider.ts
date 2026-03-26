import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildAnalysisPrompt, buildSessionRecapPrompt } from "../../domain/analysis/promptBuilder.js";
import { codexAnalysisResponseSchema, codexSessionRecapResponseSchema } from "../../domain/analysis/schema.js";
import type {
  AnalysisProviderResult,
  AnalysisRunInput,
  RuntimeConfig,
  SessionRecapProviderResult,
  SessionRecapRunInput
} from "../../domain/types.js";
import type { AnalysisProvider } from "./providerTypes.js";

function splitCommand(command: string): string[] {
  return command.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((part) => part.replace(/^"|"$/g, "")) ?? [];
}

export class CodexCliAnalysisProvider implements AnalysisProvider {
  readonly name = "codex";

  constructor(private readonly runtimeConfig: RuntimeConfig) {}

  async analyze(input: AnalysisRunInput): Promise<AnalysisProviderResult> {
    const commandParts = splitCommand(this.runtimeConfig.analysisProviderCommand);
    if (commandParts.length === 0) {
      throw new Error("ANALYSIS_PROVIDER_COMMAND is empty.");
    }

    const [command, ...baseArgs] = commandParts;
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "stream-topic-copilot-"));
    const outputPath = path.join(tempDir, "codex-response.json");
    const args = [
      ...baseArgs,
      this.runtimeConfig.analysisStructuredOutputFlag,
      this.runtimeConfig.analysisSchemaPath,
      "--output-last-message",
      outputPath,
      "-"
    ];
    const prompt = buildAnalysisPrompt(input.session, input.chunk, input.config);

    const startedAt = Date.now();

    await new Promise<void>((resolve, reject) => {
      const child = spawn(command, args, {
        stdio: ["pipe", "pipe", "pipe"]
      });

      let stderr = "";

      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });

      child.on("error", reject);
      child.on("exit", (code) => {
        if (code === 0) {
          resolve();
          return;
        }

        reject(new Error(stderr.trim() || `Codex exited with code ${code}`));
      });

      child.stdin.write(prompt);
      child.stdin.end();
    });

    const rawResponse = await fs.readFile(outputPath, "utf8");
    const parsed = codexAnalysisResponseSchema.parse(JSON.parse(rawResponse));

    return {
      response: parsed,
      rawResponse,
      latencyMs: Date.now() - startedAt
    };
  }

  async generateSessionRecap(input: SessionRecapRunInput): Promise<SessionRecapProviderResult> {
    const commandParts = splitCommand(this.runtimeConfig.analysisProviderCommand);
    if (commandParts.length === 0) {
      throw new Error("ANALYSIS_PROVIDER_COMMAND is empty.");
    }

    const [command, ...baseArgs] = commandParts;
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "stream-topic-copilot-"));
    const outputPath = path.join(tempDir, "codex-session-recap.json");
    const args = [
      ...baseArgs,
      this.runtimeConfig.analysisStructuredOutputFlag,
      path.resolve(this.runtimeConfig.rootDir, "docs/scoping/codex-session-recap-schema.json"),
      "--output-last-message",
      outputPath,
      "-"
    ];
    const prompt = buildSessionRecapPrompt(input.session, input.config);
    const startedAt = Date.now();

    await new Promise<void>((resolve, reject) => {
      const child = spawn(command, args, {
        stdio: ["pipe", "pipe", "pipe"]
      });

      let stderr = "";

      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });

      child.on("error", reject);
      child.on("exit", (code) => {
        if (code === 0) {
          resolve();
          return;
        }

        reject(new Error(stderr.trim() || `Codex exited with code ${code}`));
      });

      child.stdin.write(prompt);
      child.stdin.end();
    });

    const rawResponse = await fs.readFile(outputPath, "utf8");
    const parsed = codexSessionRecapResponseSchema.parse(JSON.parse(rawResponse));

    return {
      response: parsed,
      rawResponse,
      latencyMs: Date.now() - startedAt
    };
  }
}
