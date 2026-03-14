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
  topicId?: string;
};

type OffTopicObservation = {
  label: string;
  confidence: number;
  rationale: string;
  evidence: Evidence[];
};

type Evidence = {
  chunkId: string;
  excerpt: string;
};

type Warning = {
  code: string;
  message: string;
  topicId?: string;
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
  - `warnings`
- Additional top-level fields are not allowed.
- Unknown nested fields may be tolerated and ignored by consumers for forward compatibility.
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
- `offTopicObservations` is a separate top-level section and does not share the `suggestions` container.
- Evidence is chunk-level only in V1. It must reference a `chunkId` and include a short `excerpt`.
- Transport metadata such as timestamps, prompt version, model name, and raw CLI details belong in logs, not in this response payload.

## Validation Notes

- `schemaVersion` must equal `codexAnalysis.v1`.
- `confidence` values must be numeric and bounded to `0..1`.
- Every `TopicDecision`, `Suggestion`, and `OffTopicObservation` must include at least one `Evidence` item.
- `warnings` must be structured objects, not plain strings.
- Consumers should fail validation on unknown top-level fields.
- Consumers should not require unknown nested fields to validate.
