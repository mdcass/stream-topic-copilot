import type { CaptureSourceDescriptor } from "../domain/types.js";

export function classifyInputSource(name: string): "microphone" | "system-mix" {
  const normalized = name.toLowerCase();
  return /(blackhole|loopback|zoomaudio|obs|vb[- ]?audio|soundflower)/.test(normalized)
    ? "system-mix"
    : "microphone";
}

export function groupLabelForInputSource(kind: ReturnType<typeof classifyInputSource>): string {
  return kind === "system-mix" ? "Desktop Audio" : "Microphones";
}

export function findRecommendedSystemMixSource(
  sources: CaptureSourceDescriptor[]
): CaptureSourceDescriptor | null {
  const candidates = sources.filter((source) => source.kind === "system-mix");
  if (candidates.length === 0) {
    return null;
  }

  return candidates
    .slice()
    .sort((left, right) => scoreSystemMixSource(right) - scoreSystemMixSource(left))[0] ?? null;
}

function scoreSystemMixSource(source: CaptureSourceDescriptor): number {
  const normalized = source.name.toLowerCase();
  let score = 0;

  if (normalized.includes("blackhole")) {
    score += 100;
  }
  if (source.isDefault) {
    score += 10;
  }
  if (source.available !== false) {
    score += 1;
  }

  return score;
}
