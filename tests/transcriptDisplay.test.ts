import { describe, expect, it } from "vitest";

import { rebuildDisplayTranscript } from "../src/server/domain/transcript/display.js";
import type { TranscriptEvent } from "../src/server/domain/types.js";

function event(id: string, timestamp: string, text: string, replaceLast = false): TranscriptEvent {
  return {
    id,
    timestamp,
    text,
    sourceId: "src_1",
    sourceName: "Mock Studio Mic",
    sourceKind: "microphone",
    replaceLast
  };
}

describe("transcript display stabilization", () => {
  it("rewrites within one timestamp group and starts a new line on the next timestamp", () => {
    const display = rebuildDisplayTranscript([
      event("1", "2026-03-16T09:39:42.790Z", "the QuickBooks side. Headlines are we need an", true),
      event("2", "2026-03-16T09:39:42.790Z", "the QuickBooks side. Headlines are we need an accountant who's got a QuickBooks account.", true),
      event("3", "2026-03-16T09:39:48.791Z", "with a client authorized and", true),
      event("4", "2026-03-16T09:39:48.791Z", "with a client authorized and the exact same on the hammock side so that they need a", true)
    ]);

    expect(display.committedLines).toHaveLength(1);
    expect(display.committedLines[0].text).toBe("the QuickBooks side. Headlines are we need an accountant who's got a QuickBooks account.");
    expect(display.activeLine?.text).toBe("with a client authorized and the exact same on the hammock side so that they need a");
  });

  it("removes a visible draft when the same timestamp group is replaced by blank audio", () => {
    const display = rebuildDisplayTranscript([
      event("1", "2026-03-16T10:00:00.000Z", "Thank you.", true),
      event("2", "2026-03-16T10:00:00.000Z", "[BLANK_AUDIO]", true)
    ]);

    expect(display.committedLines).toHaveLength(0);
    expect(display.activeLine).toBeNull();
  });

  it("rebuilds multiple visible rows even when every later event is replaceLast", () => {
    const display = rebuildDisplayTranscript([
      event("1", "2026-03-16T09:39:42.790Z", "to be a legend when it comes to AI he knows a lot about it's been", true),
      event("2", "2026-03-16T09:39:48.791Z", "been working in it for a very, very long time.", true),
      event("3", "2026-03-16T09:39:54.945Z", "combined. And so therefore, their conversations are actually useful and good to listen to and we thought we would have a good time.", true)
    ]);

    expect(display.committedLines.map((line) => line.text)).toEqual([
      "to be a legend when it comes to AI he knows a lot about it's been",
      "been working in it for a very, very long time."
    ]);
    expect(display.activeLine?.text).toBe("combined. And so therefore, their conversations are actually useful and good to listen to and we thought we would have a good time.");
  });

  it("rewrites near-identical timestamp revisions onto the same row", () => {
    const display = rebuildDisplayTranscript([
      event("1", "2026-03-16T10:25:59.360Z", "You don't know what SSH is? Well, maybe the coffee's not--", true),
      event("2", "2026-03-16T10:25:59.361Z", "You don't know what SSH is? Well, maybe the coffee's not for you.", true)
    ]);

    expect(display.committedLines).toHaveLength(0);
    expect(display.activeLine?.text).toBe("You don't know what SSH is? Well, maybe the coffee's not for you.");
  });

  it("keeps the more complete revision when a rougher near-duplicate arrives after it", () => {
    const display = rebuildDisplayTranscript([
      event("1", "2026-03-16T10:29:45.823Z", "From back-end integration to product polish, Fiverr's got the experts to bring your product.", true),
      event("2", "2026-03-16T10:29:45.822Z", "From back end integration to product", true)
    ]);

    expect(display.committedLines).toHaveLength(0);
    expect(display.activeLine?.text).toBe("From back-end integration to product polish, Fiverr's got the experts to bring your product.");
  });

  it("merges revisions that share a strong token overlap even when the prefix shifts", () => {
    const display = rebuildDisplayTranscript([
      event("1", "2026-03-16T10:30:33.939Z", "workflow is ready to roll. Either way, now the whole team finishes--", true),
      event("2", "2026-03-16T10:30:33.940Z", "Either way, now the whole team finishes projects before you can even say trymonday.com for free.", true)
    ]);

    expect(display.committedLines).toHaveLength(0);
    expect(display.activeLine?.text).toBe("Either way, now the whole team finishes projects before you can even say trymonday.com for free.");
  });

  it("does not merge distant replaceLast events into one row", () => {
    const display = rebuildDisplayTranscript([
      event("1", "2026-03-16T09:39:42.790Z", "to be a legend when it comes to AI he knows a lot about it's been", true),
      event("2", "2026-03-16T09:39:48.791Z", "been working in it for a very, very long time.", true)
    ]);

    expect(display.committedLines.map((line) => line.text)).toEqual([
      "to be a legend when it comes to AI he knows a lot about it's been"
    ]);
    expect(display.activeLine?.text).toBe("been working in it for a very, very long time.");
  });
});
