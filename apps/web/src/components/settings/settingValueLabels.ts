import type {
  BranchNamingMode,
  ResponseStreamingMode,
  ServerSettings,
  WorktreeSubmodules,
} from "@cogenly/contracts";

import { PULL_REQUEST_MERGE_METHOD_LABELS } from "~/lib/pullRequestContext";
import { resolveEnvModeLabel, WORKTREE_SUBMODULES_LABELS } from "../BranchToolbar.logic";

export const RESPONSE_STREAMING_MODE_LABELS: Record<ResponseStreamingMode, string> = {
  turn: "Wait for the full response",
  paragraph: "Show finished paragraphs",
};

export const BRANCH_NAMING_MODE_LABELS: Record<BranchNamingMode, string> = {
  static: "Static prefix",
  semantic: "Semantic prefix",
  custom: "Custom instructions",
};

const WRITING_STYLE_LABELS: Record<string, string> = {
  repo_conventions: "Repository conventions",
  conventional_commits: "Conventional Commits",
  custom: "Custom instructions",
};

/** The option labels a settings row's select shows, by key, so other views name values the same way. */
const OPTION_LABELS: Partial<Record<keyof ServerSettings, Readonly<Record<string, string>>>> = {
  responseStreamingMode: RESPONSE_STREAMING_MODE_LABELS,
  branchNamingMode: BRANCH_NAMING_MODE_LABELS,
  worktreeSubmodules: WORKTREE_SUBMODULES_LABELS satisfies Record<WorktreeSubmodules, string>,
  pullRequestMergeMethod: PULL_REQUEST_MERGE_METHOD_LABELS,
};

/** Human labels for a setting's value, as its control names it; falls back to a type summary. */
export function formatSettingValue(key: keyof ServerSettings, value: unknown): string {
  if (value === null || value === undefined) {
    return key === "pullRequestMergeMethod"
      ? "Last used"
      : key === "defaultModelSelection"
        ? "Automatic"
        : key === "sourceControlWriterModelSelection"
          ? "Text generation model"
          : key === "reviewGuideModelSelection"
            ? "Writing model"
            : key === "defaultThreadEnvMode" || key === "worktreeSubmodules"
              ? "Inherit"
              : "Not set";
  }
  if (typeof value === "boolean") return value ? "On" : "Off";
  if (typeof value === "number") {
    return String(value);
  }
  if (typeof value === "string") {
    if (key === "defaultThreadEnvMode" && (value === "local" || value === "worktree")) {
      return resolveEnvModeLabel(value);
    }
    const labels = OPTION_LABELS[key];
    if (labels && Object.hasOwn(labels, value)) return labels[value]!;
    return value === "" ? "Empty" : value;
  }
  if (Array.isArray(value)) return `${value.length} ${value.length === 1 ? "item" : "items"}`;
  if (typeof value === "object") {
    if ("model" in value && typeof value.model === "string") return value.model;
    if ("mode" in value && typeof value.mode === "string") {
      return WRITING_STYLE_LABELS[value.mode] ?? value.mode;
    }
  }
  return "Custom";
}
