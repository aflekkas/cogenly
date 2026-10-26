import type { BranchNamingMode, ResponseStreamingMode } from "@cogenly/contracts";

export const RESPONSE_STREAMING_MODE_LABELS: Record<ResponseStreamingMode, string> = {
  turn: "Wait for the full response",
  paragraph: "Show finished paragraphs",
};

export const BRANCH_NAMING_MODE_LABELS: Record<BranchNamingMode, string> = {
  static: "Static prefix",
  semantic: "Semantic prefix",
  custom: "Custom instructions",
};
