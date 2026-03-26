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
  warnings: z.array(warningSchema)
}).strict();

export type Evidence = z.infer<typeof evidenceSchema>;
export type TopicDecision = z.infer<typeof topicDecisionSchema>;
export type Suggestion = z.infer<typeof suggestionSchema>;
export type OffTopicObservation = z.infer<typeof offTopicObservationSchema>;
export type AnalysisWarning = z.infer<typeof warningSchema>;
export type CodexAnalysisResponse = z.infer<typeof codexAnalysisResponseSchema>;
