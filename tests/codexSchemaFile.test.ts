import fs from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

describe("codex output schema file", () => {
  it("uses strict objects so Codex Structured Outputs accepts the schema", async () => {
    const schemaPath = path.resolve("docs/scoping/codex-analysis-response-schema.json");
    const schema = JSON.parse(await fs.readFile(schemaPath, "utf8"));

    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.schemaVersion.type).toBe("string");
    expect(schema.properties.suggestions.additionalProperties).toBe(false);
    expect(schema.$defs.evidence.additionalProperties).toBe(false);
    expect(schema.$defs.topicDecision.additionalProperties).toBe(false);
    expect(schema.$defs.suggestion.additionalProperties).toBe(false);
    expect(schema.$defs.offTopicObservation.additionalProperties).toBe(false);
    expect(schema.$defs.revisitableThemeUpsert.additionalProperties).toBe(false);
    expect(schema.$defs.revisitableThemeMerge.additionalProperties).toBe(false);
    expect(schema.$defs.revisitableThemeDelta.additionalProperties).toBe(false);
    expect(schema.$defs.warning.additionalProperties).toBe(false);
    expect(schema.$defs.suggestion.required).toContain("topicId");
    expect(schema.$defs.warning.required).toContain("topicId");
    expect(schema.$defs.suggestion.properties.topicId.type).toEqual(["string", "null"]);
    expect(schema.$defs.revisitableThemeUpsert.properties.themeId.type).toEqual(["string", "null"]);
    expect(schema.$defs.warning.properties.topicId.type).toEqual(["string", "null"]);
  });

  it("keeps the session recap schema strict as well", async () => {
    const schemaPath = path.resolve("docs/scoping/codex-session-recap-schema.json");
    const schema = JSON.parse(await fs.readFile(schemaPath, "utf8"));

    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.schemaVersion.const).toBe("codexSessionRecap.v1");
    expect(schema.required).toContain("overview");
    expect(schema.required).toContain("futureFollowUps");
  });
});
