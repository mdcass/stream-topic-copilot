import type {
  AnalysisProviderResult,
  AnalysisRunInput,
  SessionRecapProviderResult,
  SessionRecapRunInput
} from "../../domain/types.js";

export interface AnalysisProvider {
  readonly name: string;
  analyze(input: AnalysisRunInput): Promise<AnalysisProviderResult>;
  generateSessionRecap?(input: SessionRecapRunInput): Promise<SessionRecapProviderResult>;
}
