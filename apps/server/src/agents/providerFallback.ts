import type {
  Agent,
  AgentFallbackReason,
  ModelSelection,
  OrchestrationV2ProviderFailure,
} from "@cogenly/contracts";
import * as DateTime from "effect/DateTime";

/**
 * Provider fallback chains for persistent agents.
 *
 * Failure classification reuses the adapters' normalized
 * `OrchestrationV2ProviderFailure` (see provider-core `makeProviderFailure`):
 * - Claude: `blocking_limit` / API 429 / a rejected `rate_limit_event` become
 *   class `usage_limit` (with `resetAt` when the SDK names one); API 401
 *   arrives as class `provider_error` with code `api_error_401`.
 * - Codex: `usageLimitExceeded` / `rateLimitExceeded` become `usage_limit`
 *   (reset from the `account/rateLimits/updated` snapshot); auth failures
 *   arrive as `provider_error` with an http/auth code or sign-in message.
 * - Muse: a quota error becomes `usage_limit` with `resetAt`; other
 *   failures are generic `provider_error`/`transport_error`, so sign-in
 *   problems are only detectable from their message text.
 * Anything else (provider_error, transport_error, ...) is not a fallback
 * reason: those runs keep the normal exponential backoff.
 */

/** Without a known reset, retry the primary entry an hour after it failed. */
export const FALLBACK_COOLDOWN_MS = 60 * 60 * 1000;

const AUTH_MESSAGE =
  /not (?:signed|logged) in|sign[ -]?in (?:required|failed)|please (?:sign|log) in|unauthenticated|unauthorized|authentication (?:failed|error|required)|login (?:required|expired|failed)|\b401\b/i;

/** Classify a normalized provider failure, or null when it should just back off. */
export const classifyProviderFailure = (
  failure: Pick<OrchestrationV2ProviderFailure, "class" | "code" | "message"> | null | undefined,
): AgentFallbackReason | null => {
  if (failure == null) return null;
  if (failure.class === "usage_limit") return "usage_limit";
  const code = failure.code ?? "";
  if (
    code === "api_error_401" ||
    code === "401" ||
    /auth|unauthorized|unauthenticated/i.test(code) ||
    AUTH_MESSAGE.test(failure.message)
  )
    return "auth";
  return null;
};

/** The full ordered chain: the agent's primary selection, then its fallbacks. */
export const fallbackChainOf = (
  agent: Pick<Agent, "modelSelection" | "fallbackChain">,
): ReadonlyArray<ModelSelection> => [agent.modelSelection, ...(agent.fallbackChain ?? [])];

export interface FallbackDecision {
  readonly index: number;
  readonly selection: ModelSelection;
  /** Why this entry is being used; null on the primary entry. */
  readonly reason: AgentFallbackReason | null;
  /** True when a stored fallback expired and the primary entry is retried. */
  readonly restored: boolean;
}

/**
 * Which chain entry the next background run uses. Pure: the caller persists
 * `restored` (clearing the stored fallback state) when it is true.
 */
export const decideFallback = (
  agent: Pick<
    Agent,
    "modelSelection" | "fallbackChain" | "fallbackIndex" | "fallbackReason" | "fallbackUntil"
  >,
  nowMs: number,
): FallbackDecision => {
  const chain = fallbackChainOf(agent);
  const primary = chain[0]!;
  const storedIndex = agent.fallbackIndex ?? 0;
  if (chain.length < 2 || storedIndex <= 0)
    return { index: 0, selection: primary, reason: null, restored: false };
  const untilMs = agent.fallbackUntil == null ? null : Date.parse(agent.fallbackUntil);
  if (untilMs !== null && Number.isFinite(untilMs) && nowMs >= untilMs)
    return { index: 0, selection: primary, reason: null, restored: true };
  const index = Math.min(storedIndex, chain.length - 1);
  return { index, selection: chain[index]!, reason: agent.fallbackReason ?? null, restored: false };
};

export interface FallbackAdvance {
  readonly index: number;
  readonly reason: AgentFallbackReason;
  /** When the primary entry is retried: the reported reset, else the cooldown. */
  readonly until: string;
  readonly resetAt: string | null;
}

/**
 * State to store after a run failed for a fallback reason on chain entry
 * `failedIndex`: advance to the next entry (staying on the last when the
 * chain is exhausted) until the reset/cooldown, then return to the primary.
 * Returns null for other failures or agents without a chain.
 */
export const advanceFallback = (input: {
  readonly chainLength: number;
  readonly failedIndex: number;
  readonly reason: AgentFallbackReason | null;
  readonly resetAt: string | null | undefined;
  readonly nowMs: number;
  /** Return-to-primary time already stored; only a primary failure moves it. */
  readonly existingUntil?: string | null;
}): FallbackAdvance | null => {
  if (input.reason === null || input.chainLength < 2) return null;
  const resetMs = input.resetAt == null ? Number.NaN : Date.parse(input.resetAt);
  const hasReset = Number.isFinite(resetMs);
  // Only the primary entry's failure sets when the primary is retried. A
  // fallback entry failing must not push that time out with its own reset
  // or a fresh cooldown, or an exhausted chain could stay on a fallback
  // for as long as it keeps failing.
  if (input.failedIndex > 0) {
    const existingMs = input.existingUntil == null ? Number.NaN : Date.parse(input.existingUntil);
    const untilMs = Number.isFinite(existingMs)
      ? existingMs
      : hasReset
        ? resetMs
        : input.nowMs + FALLBACK_COOLDOWN_MS;
    return {
      index: Math.min(input.failedIndex + 1, input.chainLength - 1),
      reason: input.reason,
      until: DateTime.formatIso(DateTime.makeUnsafe(untilMs)),
      resetAt: null,
    };
  }
  const untilMs = hasReset ? resetMs : input.nowMs + FALLBACK_COOLDOWN_MS;
  return {
    index: Math.min(input.failedIndex + 1, input.chainLength - 1),
    reason: input.reason,
    until: DateTime.formatIso(DateTime.makeUnsafe(untilMs)),
    resetAt: hasReset ? DateTime.formatIso(DateTime.makeUnsafe(resetMs)) : null,
  };
};

/** Index of a used selection in the chain, by instance + model; 0 when absent. */
export const chainIndexOf = (
  chain: ReadonlyArray<ModelSelection>,
  selection: ModelSelection | undefined,
): number => {
  if (selection === undefined) return 0;
  const index = chain.findIndex(
    (entry) => entry.instanceId === selection.instanceId && entry.model === selection.model,
  );
  return index < 0 ? 0 : index;
};
