import {
  type AgentEventFilter,
  type AgentEventKind,
  EnvironmentId,
  ScheduledTaskId,
  type ScheduledTask,
  type ScheduledTaskUpsertSchedule,
  type ModelSelection,
  type RuntimeMode,
  type ProviderInteractionMode,
  type ServerSettings,
} from "@cogenly/contracts";
import { parseMaxDeliveryAge } from "@cogenly/client-runtime/scheduled-task-webhook";

import type { ProviderInstanceEntry } from "../../providerInstances";

import type { ResolvedSettingsScope } from "./settingsScope";

/**
 * How a task's last run reads in its row. `ago` is the last run's relative
 * time ("2h ago"), or null when unknown. A success is plain text; anything
 * worth noticing carries a badge tone. Null when the task never ran.
 */
export function scheduledTaskLastRun(
  status: ScheduledTask["lastRunStatus"],
  ago: string | null,
): { readonly text: string; readonly tone: "info" | "warning" | "error" | null } | null {
  const when = ago ? ` ${ago}` : "";
  switch (status) {
    case "never":
      return null;
    case "running":
      return { text: "Running", tone: "info" };
    case "succeeded":
      return { text: `Ran${when}`, tone: null };
    case "failed":
      return { text: `Failed${when}`, tone: "error" };
    case "skipped_busy":
      return { text: `Deferred${when}, the agent is busy`, tone: "warning" };
    case "skipped_backoff":
      return { text: `Skipped${when}, the agent is backing off`, tone: "warning" };
    case "skipped_daily_cap":
      return { text: `Skipped${when}, daily run cap reached`, tone: "warning" };
    case "skipped_not_owner":
      return { text: `Skipped${when}, this machine does not own the agent`, tone: "warning" };
    case "skipped_disabled":
      return { text: `Skipped${when}, the agent is paused`, tone: "warning" };
    case "skipped_ineligible":
      return { text: `Skipped${when}, trigger is no longer eligible`, tone: "warning" };
    case "skipped_already_queued":
      return { text: `Skipped${when}, the last run was still queued`, tone: "warning" };
  }
}

/** Whether the settings scope shows a task or repository on `environmentId`. */
export function matchesScheduledTaskScope(
  scope: ResolvedSettingsScope,
  environmentId: EnvironmentId,
): boolean {
  return scope.kind !== "unavailable" && scope.environmentIds.includes(environmentId);
}

export function validateScheduledTasksSearch(raw: Record<string, unknown>) {
  return {
    ...(typeof raw.environmentId === "string" && raw.environmentId.trim()
      ? { environmentId: EnvironmentId.make(raw.environmentId) }
      : {}),
    ...(typeof raw.taskId === "string" && raw.taskId.trim()
      ? { taskId: ScheduledTaskId.make(raw.taskId) }
      : {}),
    // Opens the new-task editor, for entry points outside settings.
    ...(raw.create === true || raw.create === "true" ? { create: true as const } : {}),
  };
}

export type ScheduleMode = "fixed" | "interval" | "webhook" | "event";
export type WorkspaceMode = "root" | "worktree" | "existing_worktree";

export interface DraftState {
  readonly editingId: string | null;
  readonly title: string;
  readonly prompt: string;
  readonly enabled: boolean;
  readonly scheduleMode: ScheduleMode;
  readonly intervalMinutes: string;
  readonly timeOfDay: string;
  readonly weekdays: ReadonlySet<number>;
  readonly projectId: string;
  readonly threadId: string;
  readonly workspaceMode: WorkspaceMode;
  readonly baseRef: string;
  readonly startFromOrigin: boolean;
  readonly existingWorktreePath: string;
  readonly modelKey: string;
  /** Not editable in the dialog, but preserved so editing an agent-created task keeps its modes. */
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  /**
   * The task's original model selection. The picker only edits
   * `instanceId:model`; keeping the source object preserves provider options
   * (reasoning, temperature, …) when the model itself is left unchanged.
   */
  readonly baseModelSelection: ModelSelection | null;
  readonly signatureEnabled: boolean;
  readonly signatureHeader: string;
  readonly signatureEncoding: "hex" | "base64";
  readonly signaturePrefix: string;
  /** Write-only: empty keeps the secret already stored on the server. */
  readonly signatureSecret: string;
  /** Minutes as typed; empty runs every held request regardless of age. */
  readonly maxDeliveryAgeMinutes: string;
  /** The agent an event trigger wakes; event triggers always belong to one. */
  readonly agentId: string | null;
  readonly event: {
    readonly event: AgentEventKind;
    readonly filter?: typeof AgentEventFilter.Type | undefined;
  };
}

export const DEFAULT_DRAFT_EVENT: DraftState["event"] = { event: "pr.checks_failed" };

/** GitHub's signature settings, the most common sender. */
export const WEBHOOK_SIGNATURE_DEFAULTS = {
  signatureHeader: "x-hub-signature-256",
  signatureEncoding: "hex",
  signaturePrefix: "sha256=",
} as const;

/** Null when the draft's webhook age limit is invalid; the caller reports it and does not save. */
export function scheduleFromDraft(draft: DraftState): ScheduledTaskUpsertSchedule | null {
  if (draft.scheduleMode === "event")
    return {
      type: "event",
      event: draft.event.event,
      ...(draft.event.filter ? { filter: draft.event.filter } : {}),
    };
  if (draft.scheduleMode === "webhook") {
    const maxDeliveryAgeMinutes = parseMaxDeliveryAge(draft.maxDeliveryAgeMinutes);
    if (maxDeliveryAgeMinutes === undefined) return null;
    const secret = draft.signatureSecret.trim();
    return {
      type: "webhook",
      signature: draft.signatureEnabled
        ? {
            header: draft.signatureHeader.trim(),
            encoding: draft.signatureEncoding,
            prefix: draft.signaturePrefix,
            ...(secret ? { secret } : {}),
          }
        : null,
      maxDeliveryAgeMinutes,
    };
  }
  if (draft.scheduleMode === "interval") {
    const everyMs = Math.round(Number(draft.intervalMinutes) * 60_000);
    return { type: "interval", everyMs };
  }
  const selectedEveryDay = draft.weekdays.size === 0 || draft.weekdays.size === 7;
  return {
    type: "fixed_time",
    timeOfDay: draft.timeOfDay || "09:00",
    ...(selectedEveryDay ? {} : { weekdays: [...draft.weekdays].toSorted() }),
  };
}

export function taskToDraft(task: ScheduledTask): DraftState {
  const schedule = task.schedule;
  const weekdays =
    schedule.type === "fixed_time" && schedule.weekdays && schedule.weekdays.length > 0
      ? new Set(schedule.weekdays)
      : new Set([0, 1, 2, 3, 4, 5, 6]);
  return {
    editingId: task.id,
    title: task.title,
    prompt: task.prompt,
    enabled: task.enabled,
    scheduleMode:
      schedule.type === "interval"
        ? "interval"
        : schedule.type === "webhook"
          ? "webhook"
          : schedule.type === "event"
            ? "event"
            : "fixed",
    intervalMinutes:
      schedule.type === "interval" ? String(Math.max(1, schedule.everyMs / 60_000)) : "15",
    timeOfDay: schedule.type === "fixed_time" ? schedule.timeOfDay : "09:00",
    weekdays,
    projectId: task.projectId,
    threadId: task.threadId ?? "",
    workspaceMode: task.workspaceStrategy.type,
    baseRef: task.workspaceStrategy.type === "worktree" ? task.workspaceStrategy.baseRef : "main",
    startFromOrigin:
      task.workspaceStrategy.type === "worktree"
        ? (task.workspaceStrategy.startFromOrigin ?? false)
        : true,
    existingWorktreePath:
      task.workspaceStrategy.type === "existing_worktree"
        ? task.workspaceStrategy.worktreePath
        : "",
    modelKey: `${task.modelSelection.instanceId}:${task.modelSelection.model}`,
    runtimeMode: task.runtimeMode,
    interactionMode: task.interactionMode,
    baseModelSelection: task.modelSelection,
    ...(schedule.type === "webhook" && schedule.signature !== null
      ? {
          signatureEnabled: true,
          signatureHeader: schedule.signature.header,
          signatureEncoding: schedule.signature.encoding,
          signaturePrefix: schedule.signature.prefix,
        }
      : { signatureEnabled: false, ...WEBHOOK_SIGNATURE_DEFAULTS }),
    signatureSecret: "",
    maxDeliveryAgeMinutes:
      schedule.type === "webhook" && schedule.maxDeliveryAgeMinutes != null
        ? String(schedule.maxDeliveryAgeMinutes)
        : "",
    agentId: task.agentId ?? null,
    event:
      schedule.type === "event"
        ? { event: schedule.event, ...(schedule.filter ? { filter: schedule.filter } : {}) }
        : DEFAULT_DRAFT_EVENT,
  };
}

/** Use configured defaults before the catalog's advertised default model. */
export function scheduledTaskDefaultModel(
  settings: ServerSettings,
  entries: readonly ProviderInstanceEntry[],
): ModelSelection | null {
  const available = entries.filter(
    (entry) =>
      entry.enabled &&
      entry.installed &&
      entry.isAvailable &&
      entry.snapshot.auth.status !== "unauthenticated",
  );
  const selection = settings.defaultModelSelection;
  if (
    selection &&
    available.some(
      (entry) =>
        entry.instanceId === selection.instanceId &&
        entry.models.find((model) => model.slug === selection.model)?.isLegacy !== true,
    )
  )
    return selection;
  const models = available.flatMap((entry) =>
    entry.models
      .filter((model) => !model.isLegacy)
      .map((model) => ({ instanceId: entry.instanceId, model })),
  );
  const fallback = models.find(({ model }) => model.isDefault) ?? models[0];
  return fallback ? { instanceId: fallback.instanceId, model: fallback.model.slug } : null;
}
