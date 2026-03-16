import type { DisplayTranscriptLine, DisplayTranscriptState, TranscriptEvent } from "../types.js";

const ALWAYS_SUPPRESSED_MARKERS = new Set([
  "[blank_audio]",
  "[typing]",
  "(typing)",
  "[start speaking]"
]);

const MUTED_MARKER_GAP_MS = 10_000;
const REWRITE_WINDOW_MS = 1_500;

function normalizeMarker(text: string): string {
  return text.trim().toLowerCase();
}

function isMarker(text: string): boolean {
  const trimmed = text.trim();
  return (/^\[[^\]]+\]$/).test(trimmed) || (/^\([^)]+\)$/).test(trimmed);
}

function isSpeechText(text: string): boolean {
  return !isMarker(text);
}

function normalizeTranscriptText(text: string): string {
  return text
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function tokenizeTranscriptText(text: string): string[] {
  return normalizeTranscriptText(text).split(/\s+/).filter(Boolean);
}

function commonPrefixLength(left: string, right: string): number {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left[index] === right[index]) {
    index += 1;
  }
  return index;
}

function longestCommonTokenRun(left: string[], right: string[]): number {
  if (!left.length || !right.length) {
    return 0;
  }

  const widths = new Array(right.length + 1).fill(0);
  let best = 0;

  for (let i = 1; i <= left.length; i += 1) {
    for (let j = right.length; j >= 1; j -= 1) {
      if (left[i - 1] === right[j - 1]) {
        widths[j] = widths[j - 1] + 1;
        best = Math.max(best, widths[j]);
      } else {
        widths[j] = 0;
      }
    }
  }

  return best;
}

function transcriptCompletenessScore(text: string): number {
  const trimmed = text.trim();
  const words = tokenizeTranscriptText(trimmed).length;
  let score = words;

  if (/[.!?]["']?$/.test(trimmed)) {
    score += 6;
  }
  if (!/[—-]{1,2}$/.test(trimmed) && !/\.\.\.$/.test(trimmed)) {
    score += 3;
  }

  return score;
}

function isLikelyRevision(previousText: string, nextText: string): boolean {
  const previous = normalizeTranscriptText(previousText);
  const next = normalizeTranscriptText(nextText);
  if (!previous || !next) {
    return false;
  }

  if (previous === next || previous.startsWith(next) || next.startsWith(previous)) {
    return true;
  }

  const prefix = commonPrefixLength(previous, next);
  const shortest = Math.min(previous.length, next.length);
  if (prefix >= 24 || prefix / shortest >= 0.7) {
    return true;
  }

  const previousTokens = tokenizeTranscriptText(previousText);
  const nextTokens = tokenizeTranscriptText(nextText);
  const overlap = longestCommonTokenRun(previousTokens, nextTokens);
  return overlap >= 5 || overlap / Math.min(previousTokens.length, nextTokens.length) >= 0.7;
}

function shouldRewriteActiveLine(state: DisplayTranscriptState, event: TranscriptEvent): boolean {
  if (!state.activeLine || !event.replaceLast) {
    return false;
  }

  const activeTimestamp = Date.parse(state.activeLine.timestamp);
  const eventTimestamp = Date.parse(event.timestamp);
  if (Number.isNaN(activeTimestamp) || Number.isNaN(eventTimestamp)) {
    return false;
  }

  const diffMs = Math.abs(eventTimestamp - activeTimestamp);
  return diffMs <= REWRITE_WINDOW_MS && isLikelyRevision(state.activeLine.text, event.text);
}

function shouldShowMutedMarker(text: string, lastSpeechAt: string | null, timestamp: string): boolean {
  if (!isMarker(text) || isAlwaysSuppressedTranscriptEvent(text) || !lastSpeechAt) {
    return false;
  }

  return (Date.parse(timestamp) - Date.parse(lastSpeechAt)) >= MUTED_MARKER_GAP_MS;
}

function choosePreferredLine(current: DisplayTranscriptLine, event: TranscriptEvent, muted: boolean): DisplayTranscriptLine {
  const nextScore = transcriptCompletenessScore(event.text);
  const currentScore = transcriptCompletenessScore(current.text);

  if (nextScore > currentScore) {
    return {
      ...current,
      text: event.text,
      timestamp: current.timestamp <= event.timestamp ? current.timestamp : event.timestamp,
      muted
    };
  }

  return {
    ...current,
    timestamp: current.timestamp <= event.timestamp ? current.timestamp : event.timestamp,
    muted: current.muted && muted
  };
}

function createLine(event: TranscriptEvent, muted: boolean): DisplayTranscriptLine {
  return {
    key: `line_${event.id}`,
    timestamp: event.timestamp,
    text: event.text,
    sourceId: event.sourceId,
    sourceName: event.sourceName,
    sourceKind: event.sourceKind,
    muted
  };
}

export function createEmptyDisplayTranscript(): DisplayTranscriptState {
  return {
    committedLines: [],
    activeLine: null,
    activeGroupTimestamp: null,
    activeSourceId: null,
    lastSpeechAt: null,
    revision: 0
  };
}

export function isAlwaysSuppressedTranscriptEvent(text: string): boolean {
  return ALWAYS_SUPPRESSED_MARKERS.has(normalizeMarker(text));
}

export function applyTranscriptDisplayEvent(state: DisplayTranscriptState, event: TranscriptEvent): void {
  const groupTimestamp = event.timestamp;
  const text = event.text.trim();
  const sameGroup = (
    state.activeGroupTimestamp === groupTimestamp &&
    state.activeSourceId === event.sourceId
  ) || shouldRewriteActiveLine(state, event);
  let changed = false;

  if (sameGroup) {
    if (isAlwaysSuppressedTranscriptEvent(text)) {
      if (state.activeLine) {
        state.activeLine = null;
        changed = true;
      }
      if (changed) {
        state.revision += 1;
      }
      return;
    }

    if (!state.activeLine) {
      const muted = !isSpeechText(text) && shouldShowMutedMarker(text, state.lastSpeechAt, event.timestamp);
      if (isSpeechText(text) || muted) {
        state.activeLine = createLine(event, muted);
        state.activeSourceId = event.sourceId;
        if (!muted) {
          state.lastSpeechAt = event.timestamp;
        }
        changed = true;
      }
      if (changed) {
        state.revision += 1;
      }
      return;
    }

    const muted = !isSpeechText(text) && shouldShowMutedMarker(text, state.lastSpeechAt, event.timestamp);
    if (!isSpeechText(text) && !muted) {
      state.activeLine = null;
      state.activeSourceId = null;
      state.revision += 1;
      return;
    }

    const nextLine = choosePreferredLine(state.activeLine, event, muted);
    if (state.activeLine.text !== nextLine.text || state.activeLine.muted !== nextLine.muted || state.activeLine.timestamp !== nextLine.timestamp) {
      state.activeLine = nextLine;
      state.activeGroupTimestamp = state.activeGroupTimestamp && state.activeGroupTimestamp <= groupTimestamp
        ? state.activeGroupTimestamp
        : groupTimestamp;
      state.activeSourceId = event.sourceId;
      if (!muted) {
        state.lastSpeechAt = event.timestamp;
      }
      state.revision += 1;
    }
    return;
  }

  if (state.activeLine) {
    state.committedLines.push(state.activeLine);
    state.activeLine = null;
    state.activeSourceId = null;
    changed = true;
  }

  state.activeGroupTimestamp = groupTimestamp;
  state.activeSourceId = event.sourceId;

  if (isAlwaysSuppressedTranscriptEvent(text)) {
    if (changed) {
      state.revision += 1;
    }
    return;
  }

  const muted = !isSpeechText(text) && shouldShowMutedMarker(text, state.lastSpeechAt, event.timestamp);
  if (!isSpeechText(text) && !muted) {
    if (changed) {
      state.revision += 1;
    }
    return;
  }

  state.activeLine = createLine(event, muted);
  state.activeGroupTimestamp = groupTimestamp;
  if (!muted) {
    state.lastSpeechAt = event.timestamp;
  }
  state.revision += 1;
}

export function rebuildDisplayTranscript(events: TranscriptEvent[]): DisplayTranscriptState {
  const state = createEmptyDisplayTranscript();
  for (const event of events) {
    applyTranscriptDisplayEvent(state, event);
  }
  return state;
}
