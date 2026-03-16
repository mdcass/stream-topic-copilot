import { loadRuntimeConfig } from "../infra/runtimeConfig.js";
import { runAudioDoctor } from "../infra/audioDoctor.js";

interface CliOptions {
  json: boolean;
  applyConfig: boolean;
  skipLiveProbe: boolean;
  probeSeconds: number;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const runtimeConfig = loadRuntimeConfig();
  const result = await runAudioDoctor(runtimeConfig, {
    applyConfig: options.applyConfig,
    skipLiveProbe: options.skipLiveProbe,
    probeSeconds: options.probeSeconds
  });

  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    renderHuman(result);
  }

  process.exitCode = result.ok ? 0 : 1;
}

function parseArgs(args: string[]): CliOptions {
  let json = false;
  let applyConfig = false;
  let skipLiveProbe = false;
  let probeSeconds = 3;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--apply-config") {
      applyConfig = true;
      continue;
    }
    if (arg === "--skip-live-probe") {
      skipLiveProbe = true;
      continue;
    }
    if (arg === "--probe-seconds" && args[index + 1]) {
      probeSeconds = Math.max(1, Number(args[index + 1]) || 3);
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return { json, applyConfig, skipLiveProbe, probeSeconds };
}

function renderHuman(result: Awaited<ReturnType<typeof runAudioDoctor>>): void {
  console.log(`Audio doctor ${result.ok ? "passed" : "failed"}.`);
  for (const check of result.checks) {
    console.log(`[${check.status}] ${check.id} ${check.message}`);
    for (const detail of check.details ?? []) {
      console.log(`  - ${detail}`);
    }
  }

  if (result.appliedConfig) {
    console.log("Updated config to use the recommended desktop-audio source.");
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
