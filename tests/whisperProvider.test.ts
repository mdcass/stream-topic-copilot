import { describe, expect, it } from "vitest";

import {
  isBenignWhisperStderr,
  shouldReplaceWhisperSnapshot
} from "../src/server/providers/stt/whisperProvider.js";

describe("whisper provider snapshot heuristics", () => {
  it("treats nearby extensions of the same utterance as replacements", () => {
    expect(shouldReplaceWhisperSnapshot(
      "Well, no.",
      "Well, no, so it's fine. That's what they imagined.",
      1500
    )).toBe(true);
  });

  it("does not replace a later line that starts a different utterance", () => {
    expect(shouldReplaceWhisperSnapshot(
      "Unfortunately, heat is just very, I guess, as the kids say, problematic.",
      "in space like you don't have anywhere you should cancel it like it's very hard to get rid of heat in space",
      1500
    )).toBe(false);
  });

  it("ignores benign whisper progress stderr", () => {
    expect(isBenignWhisperStderr("main: processing 48000 samples (step = 3.0 sec / len = 10.0 sec / keep = 0.2 sec)")).toBe(true);
    expect(isBenignWhisperStderr("init: obtained spec for input device (SDL Id = 2):")).toBe(true);
    expect(isBenignWhisperStderr("whisper_init_state: kv self size  =   18.87 MB")).toBe(true);
    expect(isBenignWhisperStderr("ggml_metal_init: use fusion = true")).toBe(true);
    expect(isBenignWhisperStderr("whisper_backend_init: using BLAS backend")).toBe(true);
    expect(isBenignWhisperStderr("error: failed to open audio device")).toBe(false);
  });
});
