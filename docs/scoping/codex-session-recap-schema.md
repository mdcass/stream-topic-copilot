# Codex Session Recap Schema

This document defines the exact JSON contract returned by the end-of-session recap pass in Stream Topic Copilot.

## Canonical JSON Example

```json
{
  "schemaVersion": "codexSessionRecap.v1",
  "overview": [
    "The session covered the PC build plan while also repeatedly circling back to cooling frustration."
  ],
  "preparedTopicsCovered": [
    "New PC build",
    "Cooling issue"
  ],
  "otherThemesDiscussed": [
    "Cooling frustration",
    "General stream banter"
  ],
  "poignantMoments": [
    "The cooling setup turned into one of those problems that should have been simple and wasn't."
  ],
  "futureFollowUps": [
    "Revisit cooling frustration with a concrete before-and-after example."
  ]
}
```

## Type Definition

```ts
type CodexSessionRecapResponse = {
  schemaVersion: "codexSessionRecap.v1";
  overview: string[];
  preparedTopicsCovered: string[];
  otherThemesDiscussed: string[];
  poignantMoments: string[];
  futureFollowUps: string[];
};
```

## Contract Rules

- The top-level object is strict. Additional fields are not allowed.
- All fields must always be present, even when some arrays are empty.
- `overview` should stay concise and high-level.
- `preparedTopicsCovered` should reflect meaningful prepared-topic coverage, not every minor mention.
- `otherThemesDiscussed` should summarize broader organic themes outside the prepared plan.
- `poignantMoments` should capture memorable beats, not chronological exhaustiveness.
- `futureFollowUps` should suggest plausible future talking points or open loops.
