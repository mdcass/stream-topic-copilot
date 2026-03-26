import { z } from "zod";

const evidenceSchema = z.object({
  chunkId: z.string().min(1),
  excerpt: z.string().min(1)
});

const topicStateSchema = z.enum(["pending", "partial", "covered", "snoozed", "dismissed"]);

const topicDecisionSchema = z.object({
  topicId: z.string().min(1),
  suggestedState: topicStateSchema,
  confidence: z.number().min(0).max(1),
  rationale: z.string().min(1),
  evidence: z.array(evidenceSchema).min(1)
}).strict();

const suggestionSchema = z.object({
  text: z.string().min(1),
  confidence: z.number().min(0).max(1),
  rationale: z.string().min(1),
  evidence: z.array(evidenceSchema).min(1),
  topicId: z.string().min(1).nullable()
}).strict();

const offTopicObservationSchema = z.object({
  label: z.string().min(1),
  confidence: z.number().min(0).max(1),
  rationale: z.string().min(1),
  evidence: z.array(evidenceSchema).min(1)
}).strict();

const revisitableThemeUpsertSchema = z.object({
  themeId: z.string().min(1).nullable(),
  label: z.string().min(1),
  summary: z.string().min(1),
  supportingMoments: z.array(z.string().min(1)),
  interviewerQuestions: z.array(z.string().min(1)).max(2),
  confidence: z.number().min(0).max(1),
  rationale: z.string().min(1),
  evidence: z.array(evidenceSchema).min(1),
  promptEligible: z.boolean()
}).strict();

const revisitableThemeMergeSchema = z.object({
  fromThemeId: z.string().min(1),
  intoThemeId: z.string().min(1),
  rationale: z.string().min(1)
}).strict();

const revisitableThemeDeltaSchema = z.object({
  upserts: z.array(revisitableThemeUpsertSchema),
  merges: z.array(revisitableThemeMergeSchema)
}).strict();

const warningSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  topicId: z.string().min(1).nullable()
}).strict();

export const codexAnalysisResponseSchema = z.object({
  schemaVersion: z.literal("codexAnalysis.v1"),
  chunkId: z.string().min(1),
  topicDecisions: z.array(topicDecisionSchema),
  suggestions: z.object({
    activeTopics: z.array(suggestionSchema),
    elaborationStarters: z.array(suggestionSchema),
    adjacentNextTopics: z.array(suggestionSchema),
    recoveryPrompts: z.array(suggestionSchema)
  }).strict(),
  offTopicObservations: z.array(offTopicObservationSchema),
  revisitableThemes: revisitableThemeDeltaSchema,
  warnings: z.array(warningSchema)
}).strict();

export const codexSessionRecapResponseSchema = z.object({
  schemaVersion: z.literal("codexSessionRecap.v1"),
  overview: z.array(z.string().min(1)),
  preparedTopicsCovered: z.array(z.string().min(1)),
  otherThemesDiscussed: z.array(z.string().min(1)),
  poignantMoments: z.array(z.string().min(1)),
  futureFollowUps: z.array(z.string().min(1))
}).strict();

export type Evidence = z.infer<typeof evidenceSchema>;
export type TopicDecision = z.infer<typeof topicDecisionSchema>;
export type Suggestion = z.infer<typeof suggestionSchema>;
export type OffTopicObservation = z.infer<typeof offTopicObservationSchema>;
export type RevisitableThemeUpsert = z.infer<typeof revisitableThemeUpsertSchema>;
export type RevisitableThemeMerge = z.infer<typeof revisitableThemeMergeSchema>;
export type RevisitableThemeDelta = z.infer<typeof revisitableThemeDeltaSchema>;
export type AnalysisWarning = z.infer<typeof warningSchema>;
export type CodexAnalysisResponse = z.infer<typeof codexAnalysisResponseSchema>;
export type CodexSessionRecapResponse = z.infer<typeof codexSessionRecapResponseSchema>;
