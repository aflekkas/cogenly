/**
 * Continuing a usage-limited thread on another provider instance: which
 * instances still have headroom, which one to suggest, and the single action
 * that switches the thread, hands its context over, and re-runs the stopped
 * request. The ranking is pure so the web card, MCP tools, and agents choosing
 * delegation targets all read the same answer.
 */
import {
  CommandId,
  isProviderAvailable,
  MessageId,
  type ModelSelection,
  type OrchestrationV2Actor,
  type OrchestrationV2CreationSource,
  type OrchestrationV2ThreadShell,
  type ProviderInstanceId,
  type ProviderUsageHeadroom,
  type ServerProvider,
  type ServerProviderUsageLimits,
  type ThreadId,
  type UsageLimitHandoffAcceptInput,
  type UsageLimitHandoffAcceptResult,
  type UsageLimitHandoffCandidate,
  UsageLimitHandoffError,
  type UsageLimitHandoffRecommendation,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import { limitAutoResumeUpdate, limitRecoveryStatus } from "./UsageLimitStop.ts";

/** A usage reading older than this is reported, but flagged as possibly out of date. */
export const USAGE_STALE_AFTER_MS = 30 * 60_000;

/** What a reading says about headroom right now. A window whose reset passed counts as fresh. */
export function providerUsageHeadroom(
  limits: ServerProviderUsageLimits | undefined,
  nowMs: number,
): ProviderUsageHeadroom {
  const checkedMs = limits === undefined ? Number.NaN : Date.parse(limits.checkedAt);
  const base = {
    checkedAt: limits?.checkedAt ?? null,
    stale: Number.isFinite(checkedMs) && nowMs - checkedMs > USAGE_STALE_AFTER_MS,
  };
  if (limits === undefined || limits.unavailable !== undefined || limits.windows.length === 0) {
    return { state: "unknown", remainingPercent: null, ...base, windows: [] };
  }
  const windows = limits.windows.map((window) => {
    const resetMs = window.resetsAt === undefined ? Number.NaN : Date.parse(window.resetsAt);
    const resetPassed = Number.isFinite(resetMs) && resetMs <= nowMs;
    return {
      label: window.label,
      kind: window.kind,
      usedPercent: resetPassed ? 0 : Math.round(Math.max(0, Math.min(100, window.usedPercent))),
      ...(resetPassed || window.resetsAt === undefined ? {} : { resetsAt: window.resetsAt }),
    };
  });
  const remainingPercent = Math.min(...windows.map((window) => 100 - window.usedPercent));
  return {
    state: remainingPercent <= 0 ? "exhausted" : "available",
    remainingPercent,
    ...base,
    windows,
  };
}

/** True when two instances draw on one subscription, so one's limit is the other's. */
export function sharesAccount(left: ServerProvider, right: ServerProvider): boolean {
  if (left.driver !== right.driver) return false;
  const leftEmail = left.auth.email?.trim().toLowerCase();
  const rightEmail = right.auth.email?.trim().toLowerCase();
  if (leftEmail && rightEmail) {
    return (
      leftEmail === rightEmail &&
      (left.auth.workspaceId === undefined ||
        right.auth.workspaceId === undefined ||
        left.auth.workspaceId === right.auth.workspaceId)
    );
  }
  const leftCredential = left.usageLimits?.credentialFingerprint;
  return (
    leftCredential !== undefined && leftCredential === right.usageLimits?.credentialFingerprint
  );
}

function canRunTurns(provider: ServerProvider): boolean {
  return (
    provider.enabled &&
    provider.installed &&
    isProviderAvailable(provider) &&
    provider.status !== "error" &&
    provider.status !== "disabled" &&
    provider.auth.status !== "unauthenticated" &&
    provider.models.length > 0
  );
}

function pickModel(
  provider: ServerProvider,
  from: ModelSelection,
  hidden: ReadonlyArray<string>,
): { readonly model: ServerProvider["models"][number]; readonly same: boolean } | null {
  const same = provider.models.find(
    (model) => model.slug === from.model || model.aliases?.includes(from.model) === true,
  );
  if (same !== undefined) return { model: same, same: true };
  const visible = provider.models.filter((model) => model.isCustom || !hidden.includes(model.slug));
  const fallback =
    visible.find((model) => model.isDefault === true) ??
    visible.find((model) => model.isLegacy !== true) ??
    visible[0];
  return fallback === undefined ? null : { model: fallback, same: false };
}

const USAGE_TIER: Record<ProviderUsageHeadroom["state"], number> = {
  available: 0,
  unknown: 1,
  exhausted: 2,
};

/**
 * Instances that can continue a turn stopped on `from`'s limit, best first:
 * the same driver before another (another Claude account keeps the same
 * model and tools), known headroom before unknown, the same model before a
 * fallback, then the most remaining. Exhausted instances and
 * ones on the stopped account are left out, since switching to them fails the
 * same way.
 */
export function rankUsageLimitHandoffCandidates(input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly from: ModelSelection;
  readonly nowMs: number;
  readonly hiddenModels?: Readonly<Record<string, ReadonlyArray<string>>>;
}): ReadonlyArray<UsageLimitHandoffCandidate> {
  const source = input.providers.find((provider) => provider.instanceId === input.from.instanceId);
  return input.providers
    .flatMap((provider, order) => {
      if (provider.instanceId === input.from.instanceId || !canRunTurns(provider)) return [];
      if (source !== undefined && sharesAccount(source, provider)) return [];
      const usage = providerUsageHeadroom(provider.usageLimits, input.nowMs);
      if (usage.state === "exhausted") return [];
      const picked = pickModel(
        provider,
        input.from,
        input.hiddenModels?.[provider.instanceId] ?? [],
      );
      if (picked === null) return [];
      const sameDriver = source === undefined || source.driver === provider.driver;
      // Options are driver-specific; carry them only to the same model on the same driver.
      const carryOptions = sameDriver && picked.same && input.from.options !== undefined;
      const candidate: UsageLimitHandoffCandidate = {
        instanceId: provider.instanceId,
        driver: provider.driver,
        displayName: provider.displayName ?? null,
        modelSelection: {
          instanceId: provider.instanceId,
          model: picked.model.slug,
          ...(carryOptions ? { options: input.from.options } : {}),
        },
        modelLabel: picked.model.name,
        sameDriver,
        sameModel: picked.same,
        usage,
      };
      return [{ candidate, order }];
    })
    .toSorted(
      (left, right) =>
        Number(right.candidate.sameDriver) - Number(left.candidate.sameDriver) ||
        USAGE_TIER[left.candidate.usage.state] - USAGE_TIER[right.candidate.usage.state] ||
        Number(right.candidate.sameModel) - Number(left.candidate.sameModel) ||
        (right.candidate.usage.remainingPercent ?? -1) -
          (left.candidate.usage.remainingPercent ?? -1) ||
        left.order - right.order,
    )
    .map(({ candidate }) => candidate);
}

type HandoffShell = Pick<
  OrchestrationV2ThreadShell,
  | "id"
  | "status"
  | "lastErrorClass"
  | "latestRunId"
  | "modelSelection"
  | "archivedAt"
  | "deletedAt"
  | "usageLimitResetAt"
  | "latestRunCompletedAt"
  | "updatedAt"
  | "limitRecovery"
>;

/** The stopped run a handoff would continue, or null when the thread is not stopped on a limit. */
export function usageLimitStoppedRun(shell: HandoffShell) {
  return shell.status === "failed" &&
    shell.lastErrorClass === "usage_limit" &&
    shell.latestRunId !== null &&
    shell.archivedAt === null &&
    shell.deletedAt === null
    ? shell.latestRunId
    : null;
}

/** One instance's headroom, as agents see it when choosing where to run work. */
export interface ProviderUsageEntry {
  readonly providerInstanceId: ProviderInstanceId;
  readonly driverKind: ServerProvider["driver"];
  readonly displayName: string | null;
  readonly usage: ProviderUsageHeadroom;
}

export class UsageLimitHandoffService extends Context.Service<
  UsageLimitHandoffService,
  {
    /** Headroom for every enabled instance. */
    readonly usage: () => Effect.Effect<ReadonlyArray<ProviderUsageEntry>>;
    /** Candidates for the thread's current usage-limit stop; null when it is not stopped on one. */
    readonly recommend: (
      threadId: ThreadId,
    ) => Effect.Effect<UsageLimitHandoffRecommendation | null, UsageLimitHandoffError>;
    /**
     * Switch the thread to a candidate and re-run the stopped request there.
     * Cancels a scheduled resume at reset first so the turn cannot run twice.
     * Idempotent per stop and instance, so a double click starts one turn.
     */
    readonly accept: (
      input: UsageLimitHandoffAcceptInput & {
        readonly createdBy: OrchestrationV2Actor;
        readonly creationSource: OrchestrationV2CreationSource;
      },
    ) => Effect.Effect<UsageLimitHandoffAcceptResult, UsageLimitHandoffError>;
  }
>()("t3/orchestration-v2/UsageLimitHandoff/UsageLimitHandoffService") {}

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const serverSettings = yield* ServerSettings.ServerSettingsService;

  const nowMs = DateTime.now.pipe(Effect.map(DateTime.toEpochMillis));
  const readSettings = serverSettings.getSettings.pipe(Effect.option);

  const usage: UsageLimitHandoffService["Service"]["usage"] = () =>
    Effect.gen(function* () {
      const providers = yield* providerRegistry.getProviders;
      const now = yield* nowMs;
      return providers
        .filter((provider) => provider.enabled)
        .map((provider) => ({
          providerInstanceId: provider.instanceId,
          driverKind: provider.driver,
          displayName: provider.displayName ?? null,
          usage: providerUsageHeadroom(provider.usageLimits, now),
        }));
    });

  const readShell = (threadId: ThreadId) =>
    threads.getThreadShell(threadId).pipe(
      Effect.mapError(
        (cause) => new UsageLimitHandoffError({ threadId, reason: "not-limited", cause }),
      ),
      Effect.flatMap((shell) =>
        shell === null
          ? Effect.fail(new UsageLimitHandoffError({ threadId, reason: "not-limited" }))
          : Effect.succeed(shell),
      ),
    );

  const recommendFor = (shell: HandoffShell) =>
    Effect.gen(function* () {
      const runId = usageLimitStoppedRun(shell);
      if (runId === null) return null;
      const settings = yield* readSettings;
      const hiddenModels = Object.fromEntries(
        Object.entries(
          settings._tag === "Some" ? (settings.value.providerModelPreferences ?? {}) : {},
        ).map(([instanceId, preferences]) => [instanceId, preferences.hiddenModels]),
      );
      return {
        threadId: shell.id,
        runId,
        from: shell.modelSelection,
        candidates: rankUsageLimitHandoffCandidates({
          providers: yield* providerRegistry.getProviders,
          from: shell.modelSelection,
          nowMs: yield* nowMs,
          hiddenModels,
        }),
      } satisfies UsageLimitHandoffRecommendation;
    });

  const recommend: UsageLimitHandoffService["Service"]["recommend"] = (threadId) =>
    readShell(threadId).pipe(Effect.flatMap(recommendFor));

  const accept: UsageLimitHandoffService["Service"]["accept"] = (input) =>
    Effect.gen(function* () {
      const { threadId } = input;
      const shell = yield* readShell(threadId);
      const recommendation = yield* recommendFor(shell);
      if (recommendation === null) {
        return yield* new UsageLimitHandoffError({ threadId, reason: "not-limited" });
      }
      if (recommendation.runId !== input.runId) {
        return yield* new UsageLimitHandoffError({ threadId, reason: "stale-stop" });
      }
      const candidate = recommendation.candidates.find(
        (entry) => input.instanceId === undefined || entry.instanceId === input.instanceId,
      );
      if (candidate === undefined) {
        return yield* new UsageLimitHandoffError({ threadId, reason: "no-candidate" });
      }
      const modelSelection: ModelSelection =
        input.model === undefined || input.model === candidate.modelSelection.model
          ? candidate.modelSelection
          : { instanceId: candidate.instanceId, model: input.model };
      const identity = `${threadId}:${input.runId}`;

      // A resume scheduled for the reset would otherwise continue the old
      // instance after the handoff; record the cancellation so it shows.
      const settings = yield* readSettings;
      const autoResumeByDefault =
        settings._tag === "Some" ? settings.value.autoResumeLimitedThreads : false;
      const scheduled =
        limitRecoveryStatus(shell, autoResumeByDefault, yield* nowMs)?.autoResume === true;
      const cancelResume = scheduled ? limitAutoResumeUpdate(shell, false) : null;
      const dispatchFailed = (error: { readonly _tag: string; readonly cause?: unknown }) =>
        new UsageLimitHandoffError({
          threadId,
          reason: "dispatch-failed",
          ...((error._tag === "OrchestratorDispatchError" ||
            error._tag === "OrchestratorCommandRejectedError") &&
          typeof error.cause === "string" &&
          error.cause.length > 0
            ? { detail: error.cause.slice(0, 500) }
            : {}),
          cause: error,
        });
      if (cancelResume !== null) {
        yield* threads
          .dispatch({
            type: "thread.metadata.update",
            commandId: CommandId.make(`limit-handoff-cancel:${identity}`),
            threadId,
            limitRecovery: cancelResume,
          })
          .pipe(Effect.mapError(dispatchFailed));
      }

      const handoffIdentity = `${identity}:${candidate.instanceId}`;
      const result = yield* threads
        .dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`limit-handoff:${handoffIdentity}`),
          messageId: MessageId.make(`limit-handoff:${handoffIdentity}`),
          threadId,
          manualContinuationOfRunId: input.runId,
          modelSelection,
          text: "Continue where you left off.",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: input.createdBy,
          creationSource: input.creationSource,
        })
        .pipe(
          Effect.tapError(() =>
            cancelResume === null
              ? Effect.void
              : // Put the scheduled resume back while the thread is still stopped on this run.
                readShell(threadId).pipe(
                  Effect.flatMap((current) => {
                    const restore =
                      usageLimitStoppedRun(current) === input.runId
                        ? limitAutoResumeUpdate(current, true)
                        : null;
                    return restore === null
                      ? Effect.void
                      : threads.dispatch({
                          type: "thread.metadata.update",
                          commandId: CommandId.make(`limit-handoff-restore:${handoffIdentity}`),
                          threadId,
                          limitRecovery: restore,
                        });
                  }),
                  Effect.ignore,
                ),
          ),
          Effect.mapError(dispatchFailed),
        );
      return { sequence: result.sequence, modelSelection };
    });

  return UsageLimitHandoffService.of({ usage, recommend, accept });
});

export const layer = Layer.effect(UsageLimitHandoffService, make);
