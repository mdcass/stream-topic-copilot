import type { SessionSnapshot, TranscriptChunk } from "../types.js";

function pad(value: number, length = 2): string {
  return String(value).padStart(length, "0");
}

function formatSrtTimestamp(totalMilliseconds: number): string {
  const safe = Math.max(0, totalMilliseconds);
  const hours = Math.floor(safe / 3_600_000);
  const minutes = Math.floor((safe % 3_600_000) / 60_000);
  const seconds = Math.floor((safe % 60_000) / 1000);
  const milliseconds = safe % 1000;

  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)},${pad(milliseconds, 3)}`;
}

function relativeMs(session: SessionSnapshot, isoTime: string): number {
  return Math.max(0, Date.parse(isoTime) - Date.parse(session.startedAt));
}

function chunkText(chunk: TranscriptChunk): string {
  return chunk.text
    .replace(/\s+/g, " ")
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, "")
    .trim();
}

export function buildApproximateSrt(session: SessionSnapshot): string {
  const lines: string[] = [];
  let index = 1;

  for (const chunk of session.chunks) {
    const text = chunkText(chunk);
    if (!text) {
      continue;
    }

    const start = formatSrtTimestamp(relativeMs(session, chunk.startedAt));
    const end = formatSrtTimestamp(relativeMs(session, chunk.endedAt));

    lines.push(String(index));
    lines.push(`${start} --> ${end}`);
    lines.push(text);
    lines.push("");
    index += 1;
  }

  return lines.join("\n").trimEnd() + "\n";
}

export function buildUiSubtitleRows(session: SessionSnapshot): Array<{ index: number; range: string; text: string; }> {
  return session.chunks
    .map((chunk, index) => {
      const text = chunkText(chunk);
      return {
        index: index + 1,
        range: `${formatSrtTimestamp(relativeMs(session, chunk.startedAt))} --> ${formatSrtTimestamp(relativeMs(session, chunk.endedAt))}`,
        text
      };
    })
    .filter((row) => row.text.length > 0);
}
