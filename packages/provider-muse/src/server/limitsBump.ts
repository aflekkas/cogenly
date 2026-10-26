import type {
  ModelCapabilities,
  ServerProviderModel,
  ServerProviderUsageLimits,
} from "@cogenly/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import type { MuseSettings } from "../settings.ts";
import {
  createMuseSdkHost,
  createMuseSdkHostEffect,
  museApprovalMode,
  type MuseSdkHost,
} from "./sdk.ts";
import { parseMuseUsageLimits } from "./usageLimits.ts";

/**
 * One minimal model call that teaches a throwaway host the account's
 * subscription windows. A fresh host answers `usage/read` with `{}` until it
 * sees provider headers, and nothing on disk records those observations, so
 * when no live turn has reported limits lately the probe spends one tiny turn
 * on the cheapest model instead of showing a stale banner. Live turns stay
 * the primary source: their `usage/changed` observations land in the cache
 * and suppress the bump while fresh.
 */

/** The whole bump turn: short enough to ride a status probe, long enough for a cold model. */
export const MUSE_BUMP_TIMEOUT_MS = 75_000;
/** Failed bumps retry at most this often, so a failing account never spins the probe. */
export const MUSE_BUMP_ATTEMPT_COOLDOWN_MS = 60_000;
/** The bump prompt: minimal in, minimal out. */
export const MUSE_BUMP_PROMPT = "Reply with exactly: OK";

/** The last observation the probe found, reduced to the numbers the trigger needs. */
export interface MuseLimitsObservation {
  readonly observedAtMs: number | undefined;
  readonly resetsAtMs: ReadonlyArray<number>;
}

export function extractBumpObservation(
  limits: ServerProviderUsageLimits | undefined,
): MuseLimitsObservation {
  if (limits === undefined) return { observedAtMs: undefined, resetsAtMs: [] };
  const observedAtMs = Date.parse(limits.checkedAt);
  const resetsAtMs = limits.windows.flatMap((window) => {
    if (window.resetsAt === undefined) return [];
    const resetMs = Date.parse(window.resetsAt);
    return Number.isFinite(resetMs) ? [resetMs] : [];
  });
  return {
    observedAtMs: Number.isFinite(observedAtMs) ? observedAtMs : undefined,
    resetsAtMs,
  };
}

/** The settings' minute strings as milliseconds, defaulting to 30 minutes on garbage. */
export function museBumpMinIntervalMs(setting: string): number {
  const minutes = Number.parseInt(setting, 10);
  if (!Number.isFinite(minutes) || minutes <= 0) return 30 * 60_000;
  return minutes * 60_000;
}

/**
 * Whether the probe should spend a bump turn. Missing, stale, or
 * reset-passed observations all qualify; a recent successful bump counts as
 * fresh even when its observation stamp is old, because the host only mints a
 * new observation when the numbers move.
 */
export function shouldBumpMuseLimits(input: {
  readonly nowMs: number;
  readonly autoRefresh: boolean;
  readonly minIntervalMs: number;
  readonly attemptCooldownMs: number;
  readonly observation: MuseLimitsObservation;
  readonly lastAttemptMs: number | undefined;
  readonly lastSuccessMs: number | undefined;
}): boolean {
  if (!input.autoRefresh) return false;
  const { nowMs, observation } = input;
  if (input.lastSuccessMs !== undefined && nowMs - input.lastSuccessMs < input.minIntervalMs) {
    return false;
  }
  const fresh =
    observation.observedAtMs !== undefined &&
    nowMs - observation.observedAtMs < input.minIntervalMs &&
    observation.resetsAtMs.every((resetsAtMs) => resetsAtMs > nowMs);
  if (fresh) return false;
  if (input.lastAttemptMs !== undefined && nowMs - input.lastAttemptMs < input.attemptCooldownMs) {
    return false;
  }
  return true;
}

/** A window whose reset passed reads as reset (100% left) rather than stale numbers. */
export function expireResetLimitsWindows(
  limits: ServerProviderUsageLimits,
  nowMs: number,
): ServerProviderUsageLimits {
  if (!limits.windows.some((window) => window.resetsAt !== undefined)) return limits;
  return {
    ...limits,
    windows: limits.windows.map((window) => {
      if (window.resetsAt === undefined) return window;
      const resetMs = Date.parse(window.resetsAt);
      if (!Number.isFinite(resetMs) || resetMs > nowMs) return window;
      return { ...window, usedPercent: 0 };
    }),
  };
}

const MUSE_MODEL_VERSION_PATTERN = /^(.*?)-(\d+(?:\.\d+)*)$/;
/**
 * Known-cheap families first. Meta publishes no cost metadata (`cost` is
 * null on every catalog row), so the order is a name heuristic: spark is the
 * small tier, everything else keeps catalog order behind it.
 */
const CHEAP_MUSE_MODEL_FAMILY_RANK: Readonly<Record<string, number>> = { spark: 0 };

function museModelCheapness(modelId: string): {
  readonly familyRank: number;
  readonly version: ReadonlyArray<number>;
} {
  const withoutPrefix = modelId.startsWith("muse-") ? modelId.slice("muse-".length) : modelId;
  const versionMatch = MUSE_MODEL_VERSION_PATTERN.exec(withoutPrefix);
  const family = versionMatch?.[1] ?? withoutPrefix;
  const version = versionMatch?.[2]?.split(".").map(Number) ?? [];
  return { familyRank: CHEAP_MUSE_MODEL_FAMILY_RANK[family] ?? 1, version };
}

function compareMuseModelCheapness(left: string, right: string): number {
  const leftRank = museModelCheapness(left);
  const rightRank = museModelCheapness(right);
  if (leftRank.familyRank !== rightRank.familyRank) {
    return leftRank.familyRank - rightRank.familyRank;
  }
  const parts = Math.max(leftRank.version.length, rightRank.version.length);
  for (let index = 0; index < parts; index++) {
    const delta = (leftRank.version[index] ?? 0) - (rightRank.version[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

/**
 * The model a bump turn runs on: the configured slug when the live catalog
 * carries it, else the cheapest catalog model. Empty catalog means no live
 * read succeeded, so the bump omits the model and lets the host default.
 */
export function selectBumpModelId(
  models: ReadonlyArray<Pick<ServerProviderModel, "slug">>,
  preferred: string,
): string | undefined {
  if (preferred.length > 0 && models.some((model) => model.slug === preferred)) {
    return preferred;
  }
  return models.map((model) => model.slug).sort(compareMuseModelCheapness)[0];
}

/**
 * The bump's reasoning tier: `minimal` when the model advertises it, else
 * unset (the model's default). `none` is in the schema vocabulary but wedges
 * real turns on models that do not list it, so it is never selected.
 */
export function selectBumpReasoningEffort(
  model: { readonly capabilities: ModelCapabilities | null } | undefined,
): "minimal" | undefined {
  const descriptor = model?.capabilities?.optionDescriptors?.find(
    (candidate): candidate is Extract<typeof candidate, { type: "select" }> =>
      candidate.id === "reasoningEffort" && candidate.type === "select",
  );
  return descriptor?.options.some((option) => option.id === "minimal") ? "minimal" : undefined;
}

/**
 * Per-instance bump throttle: at most one bump in flight, attempts
 * cooldown-gated, successes counted as fresh. Created in driver scope, so a
 * settings save rebuilds it and the cache stays the cross-restart memory.
 */
export interface MuseLimitsBumpController {
  readonly semaphore: Semaphore.Semaphore;
  readonly lastAttemptMs: Ref.Ref<number | undefined>;
  readonly lastSuccessMs: Ref.Ref<number | undefined>;
}

export const makeMuseLimitsBumpController = Effect.fn("makeMuseLimitsBumpController")(function* () {
  return {
    semaphore: yield* Semaphore.make(1),
    lastAttemptMs: yield* Ref.make<number | undefined>(undefined),
    lastSuccessMs: yield* Ref.make<number | undefined>(undefined),
  } satisfies MuseLimitsBumpController;
});

const decodeBumpSession = Schema.decodeUnknownEffect(
  Schema.Struct({ session: Schema.Struct({ sessionId: Schema.String }) }),
);
const decodeBumpTurn = Schema.decodeUnknownEffect(Schema.Struct({ turnId: Schema.String }));
const decodeBumpUsageResponse = Schema.decodeUnknownEffect(
  Schema.Struct({ usage: Schema.optional(Schema.Unknown) }),
);

/**
 * One tiny turn on a throwaway host (read-only, no MCP, like the probe):
 * start a session on the bump model, ask for "OK", wait for the turn to
 * settle, then read the observation the response headers taught the host.
 * The session never becomes a Cogenly thread; the host closes on the way
 * out. Any failure (spawn, turn, timeout, empty read) answers undefined
 * so the probe falls back to cache or banner.
 */
export const runMuseLimitsBump = Effect.fn("runMuseLimitsBump")(function* (
  settings: Pick<MuseSettings, "binaryPath" | "limitsBumpModel">,
  environment: NodeJS.ProcessEnv,
  cwd: string | undefined,
  models: ReadonlyArray<ServerProviderModel>,
  createHost: typeof createMuseSdkHost = createMuseSdkHost,
  timeoutMs: number = MUSE_BUMP_TIMEOUT_MS,
): Effect.fn.Return<ServerProviderUsageLimits | undefined> {
  const modelId = selectBumpModelId(models, settings.limitsBumpModel);
  const reasoningEffort = selectBumpReasoningEffort(
    modelId === undefined ? undefined : models.find((model) => model.slug === modelId),
  );
  return yield* Effect.gen(function* () {
    const completed = yield* Deferred.make<string>();
    let latestUsage: unknown;
    const host: MuseSdkHost = yield* Effect.acquireRelease(
      createMuseSdkHostEffect(
        {
          binaryPath: settings.binaryPath,
          environment,
          ...(cwd ? { cwd } : {}),
          readOnly: true,
          // The bump never attaches an MCP server.
          sessionMcp: false,
        },
        createHost,
      ),
      (host) => Effect.promise(() => host.close()),
      { interruptible: true },
    );
    host.connection.onNotification((notification) => {
      if (notification.method === "usage/changed") {
        latestUsage = notification.params;
      } else if (notification.method === "turn/completed") {
        // The bump host runs exactly one turn, so any completion is ours.
        const params =
          typeof notification.params === "object" && notification.params !== null
            ? (notification.params as { terminal?: unknown })
            : {};
        Deferred.doneUnsafe(
          completed,
          Effect.succeed(typeof params.terminal === "string" ? params.terminal : "unknown"),
        );
      }
    });
    const session = yield* Effect.tryPromise(() =>
      host.connection.request("session/start", {
        commandId: host.connection.mintCommandId(),
        ...(cwd ? { workspaceRoot: cwd } : {}),
        ...(modelId ? { modelId } : {}),
        providerId: "meta",
        approvalMode: museApprovalMode("full-access"),
        // No permissionProfile: this read-only host is ephemeral and refuses
        // any profile selection; it fixes its own permission surface.
      }),
    ).pipe(Effect.flatMap(decodeBumpSession));
    yield* Effect.tryPromise(() =>
      host.connection.request("turn/start", {
        commandId: host.connection.mintCommandId(),
        sessionId: session.session.sessionId,
        input: [{ type: "text", text: MUSE_BUMP_PROMPT }],
        displayText: "Limits refresh",
        ...(reasoningEffort ? { reasoningEffort } : {}),
      }),
    ).pipe(Effect.flatMap(decodeBumpTurn));
    yield* Deferred.await(completed);
    const response = yield* Effect.tryPromise(() => host.connection.request("usage/read", {})).pipe(
      Effect.flatMap(decodeBumpUsageResponse),
    );
    return parseMuseUsageLimits(response.usage) ?? parseMuseUsageLimits(latestUsage);
  }).pipe(
    Effect.scoped,
    Effect.timeoutOption(timeoutMs),
    Effect.map((result) => (result._tag === "Some" ? result.value : undefined)),
    Effect.orElseSucceed(() => undefined),
  );
});
