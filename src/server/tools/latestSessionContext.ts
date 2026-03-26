import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export interface SessionArtifactDescriptor {
  kind:
    | "session-recap-json"
    | "session-summary-json"
    | "session-recap-markdown"
    | "transcript-chunks-jsonl"
    | "analysis-responses-jsonl"
    | "session-json";
  label: string;
  path: string;
}

export interface LatestSessionContext {
  session: {
    id: string;
    status: string;
    startedAt: string | null;
    endedAt: string | null;
    sessionDir: string;
    sourceMarkdownPath: string | null;
    sourceSnapshotPath: string | null;
  };
  sourceNote: string;
  preferredArtifacts: SessionArtifactDescriptor[];
  fallbackArtifacts: SessionArtifactDescriptor[];
}

interface StoredSessionSnapshot {
  id?: string;
  status?: string;
  startedAt?: string;
  endedAt?: string;
  sourceMarkdownPath?: string;
  sourceSnapshotPath?: string;
}

const artifactCatalog = [
  { kind: "session-recap-json", label: "latest session recap", fileName: "session-recap.json" },
  { kind: "session-summary-json", label: "session summary", fileName: "session-summary.json" },
  { kind: "session-recap-markdown", label: "latest session recap markdown", fileName: "session-recap.md" },
  { kind: "transcript-chunks-jsonl", label: "transcript chunks", fileName: "transcript.chunks.jsonl" },
  { kind: "analysis-responses-jsonl", label: "analysis responses", fileName: "analysis.responses.jsonl" },
  { kind: "session-json", label: "session snapshot", fileName: "session.json" }
] as const satisfies ReadonlyArray<{
  kind: SessionArtifactDescriptor["kind"];
  label: string;
  fileName: string;
}>;

export async function buildLatestSessionContext(
  sessionsDir: string,
  sessionSelector?: string
): Promise<LatestSessionContext> {
  const sessionDir = sessionSelector
    ? await resolveSessionDirectory(sessionsDir, sessionSelector)
    : await findLatestFinishedSessionDirectory(sessionsDir);
  const sessionPath = path.join(sessionDir, "session.json");
  const session = await readJson<StoredSessionSnapshot>(sessionPath);
  const artifacts = await describeArtifacts(sessionDir);
  const preferredArtifacts = artifacts.filter((artifact) =>
    artifact.kind === "session-recap-json" ||
    artifact.kind === "session-summary-json" ||
    artifact.kind === "session-recap-markdown"
  );
  const fallbackArtifacts = artifacts.filter((artifact) =>
    artifact.kind === "transcript-chunks-jsonl" ||
    artifact.kind === "analysis-responses-jsonl" ||
    artifact.kind === "session-json"
  );

  return {
    session: {
      id: session.id ?? path.basename(sessionDir),
      status: session.status ?? "unknown",
      startedAt: session.startedAt ?? null,
      endedAt: session.endedAt ?? null,
      sessionDir,
      sourceMarkdownPath: session.sourceMarkdownPath ?? null,
      sourceSnapshotPath: session.sourceSnapshotPath ?? null
    },
    sourceNote: buildSourceNote(preferredArtifacts, fallbackArtifacts),
    preferredArtifacts,
    fallbackArtifacts
  };
}

async function resolveSessionDirectory(sessionsDir: string, selector: string): Promise<string> {
  const trimmed = selector.trim();
  if (trimmed.length === 0) {
    throw new Error("Session selector must not be empty.");
  }

  const candidatePaths = [
    path.isAbsolute(trimmed) ? trimmed : path.join(sessionsDir, trimmed),
    path.resolve(trimmed)
  ];

  for (const candidatePath of candidatePaths) {
    const stats = await fs.stat(candidatePath).catch(() => null);
    if (!stats) {
      continue;
    }

    if (stats.isDirectory()) {
      await assertSessionDirectory(candidatePath);
      return candidatePath;
    }

    if (stats.isFile() && path.basename(candidatePath) === "session.json") {
      const sessionDir = path.dirname(candidatePath);
      await assertSessionDirectory(sessionDir);
      return sessionDir;
    }
  }

  throw new Error(`Unable to resolve session selector: ${selector}`);
}

async function findLatestFinishedSessionDirectory(sessionsDir: string): Promise<string> {
  const entries = await fs.readdir(sessionsDir, { withFileTypes: true }).catch(() => []);
  const candidates: Array<{ sessionDir: string; endedAt: string; startedAt: string; }> = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const sessionDir = path.join(sessionsDir, entry.name);
    const sessionPath = path.join(sessionDir, "session.json");
    const session = await readJson<StoredSessionSnapshot>(sessionPath).catch(() => null);
    if (!session || session.status !== "finished") {
      continue;
    }

    candidates.push({
      sessionDir,
      endedAt: session.endedAt ?? "",
      startedAt: session.startedAt ?? ""
    });
  }

  candidates.sort((left, right) => {
    if (left.endedAt !== right.endedAt) {
      return right.endedAt.localeCompare(left.endedAt);
    }
    return right.startedAt.localeCompare(left.startedAt);
  });

  const latest = candidates[0];
  if (!latest) {
    throw new Error(`No finished session found in ${sessionsDir}`);
  }

  return latest.sessionDir;
}

async function assertSessionDirectory(sessionDir: string): Promise<void> {
  const sessionPath = path.join(sessionDir, "session.json");
  await fs.access(sessionPath);
}

async function describeArtifacts(sessionDir: string): Promise<SessionArtifactDescriptor[]> {
  const artifacts = await Promise.all(artifactCatalog.map(async (artifact): Promise<SessionArtifactDescriptor | null> => {
    const target = path.join(sessionDir, artifact.fileName);
    const exists = await fs.access(target).then(() => true).catch(() => false);
    if (!exists) {
      return null;
    }

    return {
      kind: artifact.kind,
      label: artifact.label,
      path: target
    } satisfies SessionArtifactDescriptor;
  }));

  return artifacts.filter((artifact): artifact is SessionArtifactDescriptor => artifact !== null);
}

function buildSourceNote(
  preferredArtifacts: SessionArtifactDescriptor[],
  fallbackArtifacts: SessionArtifactDescriptor[]
): string {
  const primary = preferredArtifacts[0] ?? fallbackArtifacts[0];
  if (!primary) {
    return "Source: no session artifacts found";
  }

  return `Source: ${primary.label}`;
}

async function readJson<T>(target: string): Promise<T> {
  const content = await fs.readFile(target, "utf8");
  return JSON.parse(content) as T;
}

function renderHuman(context: LatestSessionContext): string {
  const lines = [
    `Session: ${context.session.id}`,
    `Status: ${context.session.status}`,
    `Started: ${context.session.startedAt ?? "unknown"}`,
    `Ended: ${context.session.endedAt ?? "unknown"}`,
    context.sourceNote,
    "",
    "Preferred artifacts:"
  ];

  for (const artifact of context.preferredArtifacts) {
    lines.push(`- ${artifact.label}: ${artifact.path}`);
  }

  if (context.fallbackArtifacts.length > 0) {
    lines.push("");
    lines.push("Fallback artifacts:");
    for (const artifact of context.fallbackArtifacts) {
      lines.push(`- ${artifact.label}: ${artifact.path}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

function parseArgs(args: string[]): { json: boolean; sessionSelector?: string; } {
  let json = false;
  let sessionSelector: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--session" && args[index + 1]) {
      sessionSelector = args[index + 1];
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return { json, sessionSelector };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const { loadRuntimeConfig } = await import("../infra/runtimeConfig.js");
  const runtimeConfig = loadRuntimeConfig();
  const context = await buildLatestSessionContext(runtimeConfig.sessionsDir, options.sessionSelector);

  if (options.json) {
    process.stdout.write(`${JSON.stringify(context, null, 2)}\n`);
    return;
  }

  process.stdout.write(renderHuman(context));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
