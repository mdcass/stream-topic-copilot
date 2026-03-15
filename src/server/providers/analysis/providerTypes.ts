import type { AnalysisProviderResult, AnalysisRunInput } from "../../domain/types.js";

export interface AnalysisProvider {
  readonly name: string;
  analyze(input: AnalysisRunInput): Promise<AnalysisProviderResult>;
}
