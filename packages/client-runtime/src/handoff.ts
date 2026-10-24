import type {
  ModelSelection,
  OrchestrationV2Run,
  OrchestrationV2ThreadProjection,
  OrchestrationV2TurnItem,
  ProviderInstanceId,
  ServerProvider,
} from "@cogenly/contracts";

/**
 * The subset of a projection run that handoff rows read. Kept minimal so the
 * timeline can hold a content-stable snapshot: run status/timestamps churn on
 * every stream event, but these fields only change when a run is added.
 */
export type HandoffTimelineRun = Pick<
  OrchestrationV2Run,
  "id" | "ordinal" | "providerInstanceId" | "modelSelection"
>;

export type HandoffEndpoints = ReturnType<typeof resolveHandoffEndpoints>;

/** The projection fields the pending-handoff preview reads. */
export interface PendingHandoffProjection {
  readonly thread: Pick<OrchestrationV2ThreadProjection["thread"], "activeProviderThreadId">;
  readonly runs: ReadonlyArray<
    Pick<OrchestrationV2Run, "providerThreadId" | "status" | "startedAt" | "modelSelection">
  >;
  readonly visibleTurnItems: ReadonlyArray<unknown>;
}

/**
 * Preview the next send's handoff without adding anything to durable history.
 * `selection` must be the selection the composer will actually send, so the
 * preview and the composer never name different providers.
 */
export function resolvePendingHandoff(
  projection: PendingHandoffProjection | null | undefined,
  selection: Pick<ModelSelection, "instanceId" | "model"> | null | undefined,
  providers: ReadonlyArray<
    Pick<
      ServerProvider,
      "instanceId" | "driver" | "continuation" | "requiresNewThreadForModelChange"
    >
  >,
): HandoffEndpoints | null {
  // A thread with an empty timeline has nothing to hand off. Any loaded row
  // counts: paging can leave a window of only tool rows.
  if (!projection?.visibleTurnItems.length) return null;
  const from = conversationModelSelection(projection);
  if (from === undefined || selection == null) return null;
  const source = providers.find((provider) => provider.instanceId === from.instanceId);
  const target = providers.find((provider) => provider.instanceId === selection.instanceId);
  const needsHandoff =
    from.instanceId === selection.instanceId
      ? from.model !== selection.model && target?.requiresNewThreadForModelChange === true
      : // Accounts sharing a continuation group resume the same native thread.
        source?.continuation?.groupKey === undefined ||
        source.driver !== target?.driver ||
        source.continuation.groupKey !== target.continuation?.groupKey;
  return needsHandoff
    ? { from: [from], to: { instanceId: selection.instanceId, model: selection.model } }
    : null;
}

/**
 * The selection the conversation currently sits with, as the server decides
 * the next handoff. A send moves the thread to its provider thread at
 * dispatch, before the provider turn starts and stamps `startedAt`, so a run
 * stopped or failed before it started still counts. Queued runs and runs
 * cancelled before they started never moved it.
 */
function conversationModelSelection(
  projection: Pick<PendingHandoffProjection, "thread" | "runs">,
): ModelSelection | undefined {
  const activeProviderThreadId = projection.thread.activeProviderThreadId;
  const dispatched =
    activeProviderThreadId === null
      ? undefined
      : projection.runs.findLast(
          (run) =>
            run.providerThreadId === activeProviderThreadId &&
            run.status !== "queued" &&
            run.status !== "rolled_back" &&
            !(run.status === "cancelled" && run.startedAt === null),
        );
  return (
    dispatched ??
    projection.runs.findLast((run) => run.startedAt !== null && run.status !== "rolled_back")
  )?.modelSelection;
}

export function resolveHandoffEndpoints(
  item: Pick<
    Extract<OrchestrationV2TurnItem, { type: "handoff" }>,
    "runId" | "fromModelSelections" | "fromProviderInstanceIds" | "toModel" | "toProviderInstanceId"
  >,
  runs: ReadonlyArray<HandoffTimelineRun>,
) {
  // Items persisted before models were stamped only carry instance ids;
  // recover the models from the thread's runs (the handoff's own run is
  // the target, the newest earlier run per source instance is the origin).
  // Clients fall back to the provider display name when neither source has a model.
  const handoffRun = item.runId === null ? undefined : runs.find((run) => run.id === item.runId);
  const toModel =
    item.toModel ??
    (handoffRun !== undefined && handoffRun.providerInstanceId === item.toProviderInstanceId
      ? handoffRun.modelSelection.model
      : undefined);
  const fromEndpoints: ReadonlyArray<{
    readonly instanceId: ProviderInstanceId;
    readonly model?: string | undefined;
  }> =
    item.fromModelSelections !== undefined && item.fromModelSelections.length > 0
      ? item.fromModelSelections
      : item.fromProviderInstanceIds.map((instanceId) => ({
          instanceId,
          model: latestRunModelBefore(runs, instanceId, handoffRun?.ordinal),
        }));
  return { from: fromEndpoints, to: { instanceId: item.toProviderInstanceId, model: toModel } };
}

/**
 * Model of the newest run for `instanceId` that started before the handoff's
 * own run. Legacy handoff items don't record their source models, but the
 * covered runs are still in the projection.
 */
function latestRunModelBefore(
  runs: ReadonlyArray<HandoffTimelineRun>,
  instanceId: ProviderInstanceId,
  beforeOrdinal: number | undefined,
): string | undefined {
  let latest: HandoffTimelineRun | undefined;
  for (const run of runs) {
    if (run.providerInstanceId !== instanceId) continue;
    if (beforeOrdinal !== undefined && run.ordinal >= beforeOrdinal) continue;
    if (latest === undefined || run.ordinal > latest.ordinal) latest = run;
  }
  return latest?.modelSelection.model;
}
