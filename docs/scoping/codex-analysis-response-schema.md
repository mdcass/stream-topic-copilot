# Codex Analysis Response Schema

This document defines the exact V1 JSON contract returned by Codex for structured chunk analysis in Stream Topic Copilot.

It is the canonical schema companion to the PRD. Product requirements remain in the PRD; exact response-shape rules live here.

## Canonical JSON Example

```json
{
  "schemaVersion": "codexAnalysis.v1",
  "chunkId": "chunk_2026_03_14_001",
  "topicDecisions": [
    {
      "topicId": "tp_001",
      "suggestedState": "partial",
      "confidence": 0.82,
      "rationale": "The speaker discussed the PC build at a high level but did not fully cover the specific subtopics.",
      "evidence": [
        {
          "chunkId": "chunk_2026_03_14_001",
          "excerpt": "I finally started the new PC build, but I'm still figuring out the cooling setup."
        }
      ]
    }
  ],
  "suggestions": {
    "activeTopics": [
      {
        "text": "Stay on the PC build and explain what tradeoffs still feel unresolved.",
        "confidence": 0.88,
        "rationale": "The current chunk shows clear momentum around this topic.",
        "evidence": [
          {
            "chunkId": "chunk_2026_03_14_001",
            "excerpt": "I'm still figuring out the cooling setup."
          }
        ],
        "topicId": "tp_001"
      }
    ],
    "elaborationStarters": [
      {
        "text": "What part of the cooling issue turned out to be more annoying than expected?",
        "confidence": 0.84,
        "rationale": "A specific follow-up question helps deepen the current thread.",
        "evidence": [
          {
            "chunkId": "chunk_2026_03_14_001",
            "excerpt": "I'm still figuring out the cooling setup."
          }
        ],
        "topicId": "tp_001_a"
      }
    ],
    "adjacentNextTopics": [],
    "recoveryPrompts": []
  },
  "offTopicObservations": [
    {
      "label": "PC troubleshooting frustration",
      "confidence": 0.67,
      "rationale": "The speaker expressed a recurring emotional theme that is not itself a prepared topic.",
      "evidence": [
        {
          "chunkId": "chunk_2026_03_14_001",
          "excerpt": "It turned into one of those problems that should have been simple and wasn't."
        }
      ]
    }
  ],
  "revisitableThemes": {
    "upserts": [
      {
        "themeId": null,
        "label": "Cooling frustration",
        "summary": "The streamer kept circling back to cooling tradeoffs outside the prepared plan.",
        "supportingMoments": [
          "The cooling issue sounded more annoying than expected."
        ],
        "confidence": 0.76,
        "rationale": "This is a durable off-topic theme worth resurfacing later in the session.",
        "evidence": [
          {
            "chunkId": "chunk_2026_03_14_001",
            "excerpt": "The cooling setup turned into one of those problems that should have been simple and wasn't."
          }
        ],
        "promptEligible": true
      }
    ],
    "merges": []
  },
  "warnings": []
}
```

## Type Definition

```ts
type CodexAnalysisResponse = {
  schemaVersion: "codexAnalysis.v1";
  chunkId: string;
  topicDecisions: TopicDecision[];
  suggestions: {
    activeTopics: Suggestion[];
    elaborationStarters: Suggestion[];
    adjacentNextTopics: Suggestion[];
    recoveryPrompts: Suggestion[];
  };
  offTopicObservations: OffTopicObservation[];
  revisitableThemes: RevisitableThemeDelta;
  warnings: Warning[];
};

type TopicDecision = {
  topicId: string;
  suggestedState: "pending" | "partial" | "covered" | "snoozed" | "dismissed";
  confidence: number;
  rationale: string;
  evidence: Evidence[];
};

type Suggestion = {
  text: string;
  confidence: number;
  rationale: string;
  evidence: Evidence[];
  topicId: string | null;
};

type OffTopicObservation = {
  label: string;
  confidence: number;
  rationale: string;
  evidence: Evidence[];
};

type RevisitableThemeDelta = {
  upserts: RevisitableThemeUpsert[];
  merges: RevisitableThemeMerge[];
};

type RevisitableThemeUpsert = {
  themeId: string | null;
  label: string;
  summary: string;
  supportingMoments: string[];
  confidence: number;
  rationale: string;
  evidence: Evidence[];
  promptEligible: boolean;
};

type RevisitableThemeMerge = {
  fromThemeId: string;
  intoThemeId: string;
  rationale: string;
};

type Evidence = {
  chunkId: string;
  excerpt: string;
};

type Warning = {
  code: string;
  message: string;
  topicId: string | null;
};
```

## Contract Rules

- Field names use `camelCase` throughout.
- The top-level envelope is minimal and must contain exactly:
  - `schemaVersion`
  - `chunkId`
  - `topicDecisions`
  - `suggestions`
  - `offTopicObservations`
  - `revisitableThemes`
  - `warnings`
- Additional top-level fields are not allowed.
- Additional fields are not allowed on nested V1 objects either; the schema uses strict objects throughout so Codex Structured Outputs can accept it.
- All top-level fields must always be present, even when empty.
- Empty collections must be emitted as empty arrays or objects, not omitted.
- `topicDecisions` is signal-only, not exhaustive. Topics omitted from a response are implicitly unchanged for that analysis pass.
- `topicId` may point to either a cluster topic or a beat topic.
- Codex may recommend any supported topic state:
  - `pending`
  - `partial`
  - `covered`
  - `snoozed`
  - `dismissed`
- `suggestions` is grouped by UI-facing category:
  - `activeTopics`
  - `elaborationStarters`
  - `adjacentNextTopics`
  - `recoveryPrompts`
- All suggestion categories use the same normalized `Suggestion` item shape.
- `Suggestion.topicId` is always present in the payload. Use `null` when the suggestion is not tied to a prepared topic.
- `offTopicObservations` is a separate top-level section and does not share the `suggestions` container.
- `revisitableThemes` contains model-managed deltas for durable, session-local off-topic themes.
- `revisitableThemes.upserts[].themeId` should reference an existing session theme when updating and use `null` when proposing a new theme.
- `revisitableThemes.merges` lets the model collapse duplicate themes into an existing session theme id.
- Evidence is chunk-level only in V1. It must reference a `chunkId` and include a short `excerpt`.
- Transport metadata such as timestamps, prompt version, model name, and raw CLI details belong in logs, not in this response payload.
- `Warning.topicId` is always present in the payload. Use `null` when the warning is not topic-specific.

## Validation Notes

- `schemaVersion` must equal `codexAnalysis.v1`.
- `confidence` values must be numeric and bounded to `0..1`.
- Every `TopicDecision`, `Suggestion`, `OffTopicObservation`, and `RevisitableThemeUpsert` must include at least one `Evidence` item.
- `warnings` must be structured objects, not plain strings.
- Consumers should fail validation on unknown top-level fields.
- Consumers should fail validation on unknown nested fields, because the V1 schema is strict at every object boundary.
