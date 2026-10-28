import { matchesSettingsListQuery } from "./settingsList.logic";
import {
  SettingsList,
  SettingsListItem,
  SettingsListMeta,
  SettingsListToolbar,
  SettingsListSearch,
  SettingsListFilter,
  SettingsListEmpty,
} from "./SettingsList";
import { useEnvironmentMachineList } from "~/machines/useMachines";
import { useOpenMachineHealthAlerts } from "~/machines/machineHealthAlertsStore";
import { scheduledTaskAttentionTone } from "./settingsAttention.logic";
import { SettingsAttentionTitle } from "./SettingsAttentionTitle";
import { mergeRunOnOptions } from "~/machines/launchMachine.logic";
import { EnvironmentOptionContent } from "../BranchToolbarEnvironmentSelector";
import { OverlayPresence } from "~/components/ui/overlay-presence";
import { CopyButton } from "../ui/copy-button";
import { useAtomValue } from "@effect/atom-react";
import { connectionStatusTitle } from "@cogenly/client-runtime/connection";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import {
  Clock3Icon,
  InboxIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react";
import { searchableSetting } from "./settingsSearch";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  EnvironmentId,
  ModelSelection,
  OrchestrationV2ThreadLaunchWorkspaceStrategy,
  ProjectId,
  ScheduledTask,
  ScheduledTaskId,
  ScheduledTaskSchedule,
  ScheduledTaskUpsertInput,
  ScheduledTaskWebhookDeliveryOutcome,
  ScheduledTaskWebhookDeliverySummary,
  ThreadId,
} from "@cogenly/contracts";
import { DEFAULT_WEBHOOK_PROMPT } from "@cogenly/client-runtime/scheduled-task-webhook";
import {
  AgentId,
  MAX_WEBHOOK_DELIVERY_AGE_MINUTES,
  MIN_SCHEDULED_TASK_INTERVAL_MS,
  ProviderInstanceId,
  resolveEnvironmentMachineKind,
} from "@cogenly/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@cogenly/client-runtime/state/runtime";

import { formatRelativeTime } from "../../timestampFormat";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { usePrimaryCloudLinkState } from "../../cloud/primaryCloudLinkState";
import { requestConfirmDialog } from "../../confirmDialog";
import { webhookAddress } from "@cogenly/client-runtime/webhook-address";
import { Link } from "@tanstack/react-router";
import {
  useEnvironment,
  useEnvironmentHttpBaseUrl,
  type EnvironmentPresentation,
} from "../../state/environments";
import { useProjects } from "../../state/entities";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "../../state/query";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { WorktreeBaseBranchPicker } from "../WorktreeBaseBranchPicker";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { ConnectionStatusDot, connectionPhaseDotClassName } from "../ConnectionStatusDot";
import { AuthOrchestrationOperateScope } from "@cogenly/contracts";
import { readEnvironmentScope } from "~/state/session";
import { useSettingsScope } from "./SettingsScopeContext";
import { useAgents } from "../../agents/agentsClient";
import {
  EVENT_FILTER_OUT_OF_SCOPE_MESSAGE,
  EVENT_RUN_NOW_UNSUPPORTED_MESSAGE,
  describeSchedule,
  eventFilterChoices,
  scheduledTaskErrorCode,
  triggerErrorMessage,
} from "../../agents/agentWorkspace.logic";
import { EventTriggerFields } from "../../agents/EventTriggerFields";
import { useEnvironmentProjectLabels } from "../../projectLabels/useProjectLabels";
import { EnvironmentRow, environmentTransportLabel } from "./EnvironmentRow";
import { settingsScopeEnvironmentLabel, settingsScopeEnvironmentLabels } from "./settingsScopeAxis";
import {
  DEFAULT_DRAFT_EVENT,
  WEBHOOK_SIGNATURE_DEFAULTS,
  matchesScheduledTaskScope,
  scheduleFromDraft,
  scheduledTaskDefaultModel,
  scheduledTaskLastRun,
  taskToDraft,
  type DraftState,
  type ScheduleMode,
  type WorkspaceMode,
} from "./scheduledTasksSettings.logic";
import { Label } from "../ui/label";
import { Menu, MenuTrigger, MenuPopup, MenuItem, MenuSeparator } from "../ui/menu";
import { ToggleGroup, Toggle } from "../ui/toggle-group";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  SettingsRow,
  SettingsSection,
  SettingsSectionAction,
  SettingsNote,
  useRelativeTimeTick,
} from "./settingsLayout";
import { SettingsStatusBadge, type SettingsStatusTone } from "./SettingsStatus";

/** JS day-of-week (0 = Sunday) rendered Monday-first, matching how people read a week. */
const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;
const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const WEEKDAY_SHORT = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"] as const;

const WORKSPACE_MODE_LABELS: Record<WorkspaceMode, string> = {
  worktree: "Create a new worktree",
  root: "Use the repository checkout",
  existing_worktree: "Use a specific checkout",
};

const EMPTY_DRAFT: DraftState = {
  editingId: null,
  title: "",
  prompt: "",
  enabled: true,
  scheduleMode: "fixed",
  intervalMinutes: "15",
  timeOfDay: "09:00",
  weekdays: new Set([1, 2, 3, 4, 5]),
  projectId: "",
  threadId: "",
  workspaceMode: "worktree",
  baseRef: "main",
  startFromOrigin: true,
  existingWorktreePath: "",
  modelKey: "",
  runtimeMode: "full-access",
  interactionMode: "default",
  baseModelSelection: null,
  signatureEnabled: false,
  ...WEBHOOK_SIGNATURE_DEFAULTS,
  signatureSecret: "",
  maxDeliveryAgeMinutes: "",
  agentId: null,
  event: DEFAULT_DRAFT_EVENT,
};

/** Labelled field: a caption sitting above its control. */
function Field({
  label,
  hint,
  htmlFor,
  children,
}: {
  label: string;
  hint?: string;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="flex items-baseline justify-between" htmlFor={htmlFor}>
        <span>{label}</span>
        {hint ? (
          <span className="font-normal text-2xs text-muted-foreground/80">{hint}</span>
        ) : null}
      </Label>
      {children}
    </div>
  );
}

function splitModelKey(value: string): ModelSelection | null {
  const index = value.indexOf(":");
  if (index <= 0 || index === value.length - 1) return null;
  return {
    instanceId: ProviderInstanceId.make(value.slice(0, index)),
    model: value.slice(index + 1),
  };
}

export function scheduleLabel(
  schedule: ScheduledTaskSchedule,
  names?: Parameters<typeof describeSchedule>[1],
): string {
  if (schedule.type === "webhook") return "On webhook";
  if (schedule.type === "event") return describeSchedule(schedule, names);
  if (schedule.type === "interval") {
    const minutes = schedule.everyMs / 60_000;
    return Number.isInteger(minutes)
      ? `Every ${minutes} min`
      : `Every ${Math.round(schedule.everyMs / 1000)} sec`;
  }
  const weekdays = schedule.weekdays ?? [];
  const days =
    weekdays.length === 0
      ? "Daily"
      : weekdays.length === 5 && weekdays.every((day) => day >= 1 && day <= 5)
        ? "Weekdays"
        : weekdays.map((day) => WEEKDAY_LABELS[day]).join(", ");
  return `${days} at ${schedule.timeOfDay}`;
}

/**
 * Human label for a run timestamp. `formatRelativeTime` only handles the
 * past, and `nextRunAt` is a future instant, so render "in 5m" style labels
 * for upcoming runs instead of a misleading "just now".
 */
export function relativeLabel(value: string | null): string {
  if (!value) return "Not scheduled";
  const diffMs = new Date(value).getTime() - Date.now();
  if (diffMs <= 0) {
    const relative = formatRelativeTime(value);
    if (!relative) return "Not scheduled";
    return relative.suffix ? `${relative.value} ${relative.suffix}` : relative.value;
  }
  const minutes = Math.ceil(diffMs / 60_000);
  if (minutes < 2) return "in under a minute";
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `in ${hours}h`;
  return `in ${Math.round(hours / 24)}d`;
}

const DELIVERY_OUTCOME_LABELS: Record<ScheduledTaskWebhookDeliveryOutcome, string> = {
  accepted: "Ran",
  dispatch_failed: "Run failed",
  rejected_signature: "Bad signature",
  disabled: "Task paused",
  rate_limited: "Rate limited",
  expired: "Too old",
};

function deliveryOutcomeTone(outcome: ScheduledTaskWebhookDeliveryOutcome): SettingsStatusTone {
  if (outcome === "accepted") return "success";
  if (outcome === "disabled" || outcome === "rate_limited" || outcome === "expired") {
    return "warning";
  }
  return "error";
}

export function ScheduledTasksSettings(target: {
  readonly environmentId?: EnvironmentId;
  readonly taskId?: ScheduledTaskId | undefined;
  readonly create?: true | undefined;
}) {
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const allProjects = useProjects();
  const matchesTask = (task: ScheduledTask) =>
    (statusFilter === "all" || task.enabled === (statusFilter === "enabled")) &&
    matchesSettingsListQuery(query, [
      task.title,
      task.prompt,
      allProjects.find((project) => project.id === task.projectId)?.title,
    ]);
  const filtered = query !== "" || statusFilter !== "all";
  const { scope, environments, connectedEnvironments, environment } = useSettingsScope();
  const [editor, setEditor] = useState<{
    environmentId: EnvironmentId;
    task: ScheduledTask | null;
  } | null>(null);
  const openForEdit = useCallback((environmentId: EnvironmentId, task: ScheduledTask) => {
    setEditor({ environmentId, task });
  }, []);
  const defaultEnvironment = environment ?? connectedEnvironments[0];
  const noTasksYet = useNoScheduledTasksYet(environments, scope);
  const canCreate = useAtomValue(
    serverEnvironment.upsertScheduledTask.permissionAtom(defaultEnvironment?.environmentId ?? null),
  );
  const createEnvironmentId =
    connectedEnvironments.find((entry) => entry.environmentId === target.environmentId)
      ?.environmentId ?? defaultEnvironment?.environmentId;
  const openedCreate = useRef(false);
  useEffect(() => {
    if (!target.create || openedCreate.current || !createEnvironmentId || !canCreate) return;
    openedCreate.current = true;
    setEditor({ environmentId: createEnvironmentId, task: null });
  }, [canCreate, createEnvironmentId, target.create]);
  const createTask =
    defaultEnvironment && canCreate
      ? () => setEditor({ environmentId: defaultEnvironment.environmentId, task: null })
      : null;
  const view: TaskListView = {
    matchesTask,
    filtered,
    onClearFilters: () => {
      setQuery("");
      setStatusFilter("all");
    },
    onCreate: createTask,
    toolbar: (
      <SettingsListToolbar>
        <SettingsListSearch label="Search scheduled tasks" value={query} onValueChange={setQuery} />
        <SettingsListFilter
          label="Status"
          value={statusFilter}
          onValueChange={setStatusFilter}
          options={[
            { value: "all", label: "All tasks" },
            { value: "enabled", label: "Active" },
            { value: "paused", label: "Paused" },
          ]}
        />
      </SettingsListToolbar>
    ),
  };
  return (
    <>
      <SettingsSection
        id={searchableSetting("scheduled-tasks").id}
        // The page already says "Scheduled tasks"; the section names what it lists.
        title="Tasks"
        headerAction={
          // With no tasks yet, the empty state carries the one New task action.
          !filtered && noTasksYet ? null : (
            <SettingsSectionAction disabled={!createTask} onClick={() => createTask?.()}>
              New task
            </SettingsSectionAction>
          )
        }
      >
        {scope.kind === "unavailable" ? (
          <SettingsRow title={scope.message} />
        ) : environments.length === 0 ? (
          <SettingsListEmpty
            icon={<Clock3Icon />}
            label="Connect a machine to manage scheduled tasks."
          />
        ) : environments.length > 1 ? (
          <ScheduledTaskEnvironmentList
            key={`${target.environmentId ?? defaultEnvironment?.environmentId}:${target.taskId ?? ""}`}
            environmentId={target.environmentId ?? defaultEnvironment?.environmentId}
            taskId={target.taskId}
            view={view}
            onEdit={openForEdit}
          />
        ) : (
          <>
            {environments.map((entry) => (
              <ScheduledTaskEnvironmentSection
                key={`${entry.environmentId}:${target.taskId ?? ""}`}
                environment={entry}
                taskId={
                  (target.environmentId ?? defaultEnvironment?.environmentId) ===
                  entry.environmentId
                    ? target.taskId
                    : undefined
                }
                view={view}
                onEdit={openForEdit}
              />
            ))}
          </>
        )}
      </SettingsSection>
      <OverlayPresence when={editor}>
        {(editor) => (
          <ScheduledTaskEditorDialog
            key={`${editor.environmentId}:${editor.task?.id ?? "new"}`}
            initialEnvironmentId={editor.environmentId}
            task={editor.task}
            onClose={() => setEditor(null)}
          />
        )}
      </OverlayPresence>
    </>
  );
}

/**
 * Whether every machine that has answered has no scheduled tasks in scope, so
 * the list shows the first-task empty state. Reads the same live queries the
 * lists below subscribe to.
 */
function useNoScheduledTasksYet(
  environments: ReadonlyArray<EnvironmentPresentation>,
  scope: ReturnType<typeof useSettingsScope>["scope"],
): boolean {
  return useAtomValue(
    useMemo(
      () =>
        Atom.make((get) => {
          const lists = environments
            .filter(
              (environment) =>
                environment.connection.phase === "connected" && environment.serverConfig !== null,
            )
            .map((environment) => {
              const query = get(
                serverEnvironment.scheduledTasksLive({
                  environmentId: environment.environmentId,
                  input: {},
                }),
              );
              const data = Option.getOrNull(AsyncResult.value(query));
              return data === null
                ? null
                : data.tasks.filter(() =>
                    matchesScheduledTaskScope(scope, environment.environmentId),
                  );
            });
          const loaded = lists.filter((list) => list !== null);
          return loaded.length > 0 && loaded.every((list) => list.length === 0);
        }),
      [environments, scope],
    ),
  );
}

/** The page's search and filters, which the machine lists show once they have tasks. */
interface TaskListView {
  readonly matchesTask: (task: ScheduledTask) => boolean;
  readonly toolbar: ReactNode;
  readonly filtered: boolean;
  readonly onClearFilters: () => void;
  /** Opens the new-task editor, or null when this connection can't create tasks. */
  readonly onCreate: (() => void) | null;
}

/** No tasks at all invites the first one; tasks hidden by the filters offer to clear them. */
function ScheduledTasksEmpty({ view, hasTasks }: { view: TaskListView; hasTasks: boolean }) {
  return hasTasks || view.filtered ? (
    <SettingsListEmpty
      icon={<Clock3Icon />}
      label="No tasks match these filters."
      action={
        <Button size="xs" variant="outline" onClick={view.onClearFilters}>
          Clear filters
        </Button>
      }
    />
  ) : (
    <SettingsListEmpty
      icon={<Clock3Icon />}
      label="Run a prompt on a schedule, from a webhook, or when Work changes."
      action={
        view.onCreate ? (
          <Button size="xs" variant="outline" onClick={view.onCreate}>
            <PlusIcon />
            New task
          </Button>
        ) : null
      }
    />
  );
}

function ScheduledTaskEnvironmentList({
  environmentId,
  taskId,
  onEdit,
  view,
}: {
  readonly environmentId: EnvironmentId | undefined;
  readonly taskId: ScheduledTaskId | undefined;
  readonly view: TaskListView;
  readonly onEdit: (environmentId: EnvironmentId, task: ScheduledTask) => void;
}) {
  const { matchesTask } = view;
  const { scope, environments } = useSettingsScope();
  const states = useAtomValue(
    useMemo(
      () =>
        Atom.make((get) =>
          environments.map((environment) => {
            const connected =
              environment.connection.phase === "connected" && environment.serverConfig !== null;
            const query = connected
              ? get(
                  serverEnvironment.scheduledTasksLive({
                    environmentId: environment.environmentId,
                    input: {},
                  }),
                )
              : null;
            const data = query === null ? null : Option.getOrNull(AsyncResult.value(query));
            return {
              environment,
              connected,
              tasks: data?.tasks.filter(() =>
                matchesScheduledTaskScope(scope, environment.environmentId),
              ),
              error: query?._tag === "Failure" ? formatEnvironmentQueryError(query.cause) : null,
            };
          }),
        ),
      [environments, scope],
    ),
  );
  const linkedState = states.find((state) => state.environment.environmentId === environmentId);
  const linkedTask = linkedState?.tasks?.find((task) => task.id === taskId);
  const openedLink = useRef(false);
  useEffect(() => {
    if (!openedLink.current && environmentId && linkedTask) {
      openedLink.current = true;
      onEdit(environmentId, linkedTask);
    }
  }, [environmentId, linkedTask, onEdit]);
  useRelativeTimeTick(60_000);

  const loaded = states.filter((state) => state.connected && state.error === null && state.tasks);
  const populated = loaded.filter((state) => state.tasks && state.tasks.some(matchesTask));
  const hasTasks = loaded.some((state) => (state.tasks?.length ?? 0) > 0);
  const summaries: Record<string, string[]> = {
    "Not connected:": [],
    "Loading scheduled tasks on": [],
    "Could not load scheduled tasks:": [],
    "No tasks on": [],
  };
  for (const { environment, connected, tasks, error } of states) {
    const label = settingsScopeEnvironmentLabel(environment, environments);
    if (!connected) {
      summaries["Not connected:"]!.push(
        `${label} (${connectionStatusTitle(environment.connection)})`,
      );
    } else if (error !== null) {
      summaries["Could not load scheduled tasks:"]!.push(`${label}: ${error}`);
    } else if (!tasks) {
      summaries["Loading scheduled tasks on"]!.push(label);
    } else if (tasks.length === 0 && populated.length > 0) {
      summaries["No tasks on"]!.push(label);
    }
  }

  return (
    <>
      {hasTasks || view.filtered ? view.toolbar : null}
      {populated.map(({ environment, tasks }) => {
        const { primary, secondary } = settingsScopeEnvironmentLabels(environment, environments);
        const transport = environmentTransportLabel(environment);
        return (
          <div key={environment.environmentId} className="divide-y divide-border/50">
            <EnvironmentRow
              kind={resolveEnvironmentMachineKind(environment.serverConfig)}
              label={primary}
              subtitle={
                <>
                  {secondary && secondary !== transport ? (
                    <span className="block truncate">{secondary}</span>
                  ) : null}
                  <span className="block truncate">{transport}</span>
                </>
              }
            >
              <ConnectionStatusDot
                dotClassName={connectionPhaseDotClassName(environment.connection.phase)}
                tooltipText={connectionStatusTitle(environment.connection)}
              />
              <span className="text-xs text-muted-foreground">
                {connectionStatusTitle(environment.connection)}
              </span>
            </EnvironmentRow>
            <SettingsList>
              {tasks?.filter(matchesTask).map((task) => (
                <ScheduledTaskRow
                  key={task.id}
                  environmentId={environment.environmentId}
                  task={task}
                  onEdit={() => onEdit(environment.environmentId, task)}
                />
              ))}
            </SettingsList>
          </div>
        );
      })}
      {taskId && linkedState?.tasks && linkedState.error === null && !linkedTask ? (
        <SettingsRow
          title="Task unavailable"
          description="This task no longer exists or is outside the selected machine."
          role="status"
        />
      ) : null}
      {populated.length === 0 && loaded.length > 0 ? (
        <ScheduledTasksEmpty view={view} hasTasks={hasTasks} />
      ) : null}
      {Object.entries(summaries).map(([label, entries]) => {
        if (entries.length === 0) return null;
        const summary = `${label} ${entries.join(", ")}`;
        return (
          <Tooltip key={label}>
            <TooltipTrigger render={<SettingsNote className="truncate" role="status" />}>
              {summary}
            </TooltipTrigger>
            <TooltipPopup>{summary}</TooltipPopup>
          </Tooltip>
        );
      })}
    </>
  );
}

function ScheduledTaskEnvironmentSection({
  environment,
  taskId,
  onEdit,
  view,
}: {
  readonly environment: EnvironmentPresentation;
  readonly taskId?: ScheduledTaskId | undefined;
  readonly view: TaskListView;
  readonly onEdit: (environmentId: EnvironmentId, task: ScheduledTask) => void;
}) {
  const { matchesTask } = view;
  const { scope } = useSettingsScope();
  const connected =
    environment.connection.phase === "connected" && environment.serverConfig !== null;
  const tasksQuery = useEnvironmentQuery(
    connected
      ? serverEnvironment.scheduledTasksLive({
          environmentId: environment.environmentId,
          input: {},
        })
      : null,
  );
  const tasks = tasksQuery.data?.tasks.filter(() =>
    matchesScheduledTaskScope(scope, environment.environmentId),
  );
  const linkedTask = tasks?.find((task) => task.id === taskId);
  const openedLink = useRef(false);
  useEffect(() => {
    if (!openedLink.current && linkedTask) {
      openedLink.current = true;
      onEdit(environment.environmentId, linkedTask);
    }
  }, [environment.environmentId, linkedTask, onEdit]);
  useRelativeTimeTick(60_000);
  return (
    <>
      {!connected ? (
        <SettingsRow
          title="Machine disconnected"
          description={`Reconnect ${environment.label} to view its scheduled tasks.`}
        />
      ) : tasksQuery.error ? (
        <SettingsRow title="Could not load scheduled tasks" description={tasksQuery.error} />
      ) : !tasks ? (
        <SettingsRow title="Loading scheduled tasks…" role="status" />
      ) : (
        <>
          {tasks.length > 0 || view.filtered ? view.toolbar : null}
          {taskId && !linkedTask ? (
            <SettingsRow
              title="Task unavailable"
              description="This task no longer exists or is outside the selected machine."
              role="status"
            />
          ) : null}
          {tasks.filter(matchesTask).length === 0 ? (
            <ScheduledTasksEmpty view={view} hasTasks={tasks.length > 0} />
          ) : (
            <SettingsList>
              {tasks.filter(matchesTask).map((task) => (
                <ScheduledTaskRow
                  key={task.id}
                  environmentId={environment.environmentId}
                  task={task}
                  onEdit={() => onEdit(environment.environmentId, task)}
                />
              ))}
            </SettingsList>
          )}
        </>
      )}
    </>
  );
}

function ScheduledTaskRow({
  environmentId,
  task,
  onEdit,
}: {
  readonly environmentId: EnvironmentId;
  readonly task: ScheduledTask;
  readonly onEdit: () => void;
}) {
  const canOperate = useAtomValue(
    serverEnvironment.upsertScheduledTask.permissionAtom(environmentId),
  );
  const [busy, setBusy] = useState(false);
  const [deliveriesOpen, setDeliveriesOpen] = useState(false);
  const isWebhook = task.schedule.type === "webhook";
  const isEvent = task.schedule.type === "event";
  const { labels } = useEnvironmentProjectLabels(isEvent ? environmentId : null);
  const allProjects = useProjects();
  const filterNames = {
    labelName: (id: string) => labels.find((label) => label.id === id)?.name,
    repositoryName: (id: string) =>
      allProjects.find((project) => project.environmentId === environmentId && project.id === id)
        ?.title,
  };
  const repositoryName = filterNames.repositoryName(task.projectId);
  const attention = scheduledTaskAttentionTone(
    useOpenMachineHealthAlerts(),
    environmentId,
    task.id,
  );
  const toggle = useAtomCommand(serverEnvironment.setScheduledTaskEnabled, {
    label: "scheduled task enabled",
  });
  const run = useAtomCommand(serverEnvironment.runScheduledTaskNow, {
    label: "scheduled task run now",
  });
  const remove = useAtomCommand(serverEnvironment.deleteScheduledTask, {
    label: "scheduled task delete",
  });
  const act = async (action: "toggle" | "run" | "delete") => {
    if (busy || !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) return;
    if (action === "delete") {
      const message = `Delete “${task.title}”?\nIt stops running and can't be restored.`;
      const confirmed =
        (await requestConfirmDialog(message, { variant: "destructive" })) ??
        window.confirm(message);
      if (!confirmed) return;
    }
    setBusy(true);
    const result =
      action === "toggle"
        ? await toggle({ environmentId, input: { id: task.id, enabled: !task.enabled } })
        : action === "run"
          ? await run({ environmentId, input: { id: task.id } })
          : await remove({ environmentId, input: { id: task.id } });
    setBusy(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not update scheduled task",
          description: triggerErrorMessage(
            squashAtomCommandFailure(result),
            "The server rejected the change.",
          ),
        }),
      );
    }
  };
  const lastRun = scheduledTaskLastRun(
    task.lastRunStatus,
    task.lastRunAt ? relativeLabel(task.lastRunAt) : null,
  );
  return (
    <SettingsListItem
      title={<SettingsAttentionTitle tone={attention}>{task.title}</SettingsAttentionTitle>}
      description={<span className="line-clamp-2">{task.prompt}</span>}
      status={
        <>
          <SettingsListMeta>
            {scheduleLabel(task.schedule, filterNames)}
            {repositoryName}
            {!task.enabled
              ? "Paused"
              : isWebhook || isEvent
                ? "Listening"
                : task.nextRunAt
                  ? `Next run ${relativeLabel(task.nextRunAt)}`
                  : "Not scheduled"}
            {lastRun === null ? null : lastRun.tone === null ? (
              lastRun.text
            ) : (
              <SettingsStatusBadge tone={lastRun.tone}>{lastRun.text}</SettingsStatusBadge>
            )}
          </SettingsListMeta>
          {task.lastRunError ? (
            <Tooltip>
              <TooltipTrigger render={<p className="mt-1 line-clamp-2 text-destructive" />}>
                {task.lastRunError}
              </TooltipTrigger>
              <TooltipPopup>{task.lastRunError}</TooltipPopup>
            </Tooltip>
          ) : null}
        </>
      }
      control={
        <div className="flex items-center gap-2">
          <Switch
            checked={task.enabled}
            disabled={busy || !canOperate}
            aria-label={`Active: ${task.title}`}
            onCheckedChange={() => void act("toggle")}
          />
          <Menu>
            <MenuTrigger
              render={
                <Button
                  size="icon-sm"
                  variant="ghost"
                  disabled={busy || !canOperate}
                  aria-label={`Actions for ${task.title}`}
                />
              }
            >
              <MoreHorizontalIcon className="size-4" />
            </MenuTrigger>
            <MenuPopup align="end">
              <MenuItem onClick={onEdit}>
                <PencilIcon />
                Edit
              </MenuItem>
              {isWebhook ? (
                <MenuItem onClick={() => setDeliveriesOpen(true)}>
                  <InboxIcon />
                  Deliveries
                </MenuItem>
              ) : isEvent ? (
                // The server refuses manual runs: an event run needs a real source event.
                <MenuItem disabled>
                  <PlayIcon />
                  <span className="flex flex-col">
                    Run now
                    <span className="text-xs text-muted-foreground">
                      {EVENT_RUN_NOW_UNSUPPORTED_MESSAGE}
                    </span>
                  </span>
                </MenuItem>
              ) : (
                <MenuItem onClick={() => void act("run")}>
                  <PlayIcon />
                  Run now
                </MenuItem>
              )}
              <MenuSeparator />
              <MenuItem variant="destructive" onClick={() => void act("delete")}>
                <Trash2Icon />
                Delete
              </MenuItem>
            </MenuPopup>
          </Menu>
          <OverlayPresence when={deliveriesOpen}>
            {() => (
              <WebhookDeliveriesDialog
                environmentId={environmentId}
                task={task}
                onClose={() => setDeliveriesOpen(false)}
              />
            )}
          </OverlayPresence>
        </div>
      }
    />
  );
}

function WebhookDeliveriesDialog({
  environmentId,
  task,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly task: ScheduledTask;
  readonly onClose: () => void;
}) {
  const deliveriesQuery = useEnvironmentQuery(
    serverEnvironment.scheduledTaskWebhookDeliveries({ environmentId, input: { id: task.id } }),
  );
  const [selectedId, setSelectedId] = useState<ScheduledTaskWebhookDeliverySummary["id"] | null>(
    null,
  );
  const selectedQuery = useEnvironmentQuery(
    selectedId === null
      ? null
      : serverEnvironment.scheduledTaskWebhookDelivery({
          environmentId,
          input: { id: task.id, deliveryId: selectedId },
        }),
  );
  const deliveries = deliveriesQuery.data?.deliveries ?? null;
  const selected = selectedQuery.data?.delivery ?? null;
  const error = selectedId === null ? deliveriesQuery.error : selectedQuery.error;

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Deliveries · {task.title}</DialogTitle>
          <DialogDescription>Recent requests to this task's webhook URL.</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          {selectedId !== null && selected === null && selectedQuery.error === null ? (
            <p className="text-sm text-muted-foreground" role="status">
              Loading delivery…
            </p>
          ) : selected ? (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <SettingsStatusBadge tone={deliveryOutcomeTone(selected.outcome)}>
                  {DELIVERY_OUTCOME_LABELS[selected.outcome]}
                </SettingsStatusBadge>
                <span>
                  {selected.method} · {relativeLabel(selected.receivedAt)}
                </span>
                {selected.signatureVerified ? (
                  <span className="text-muted-foreground">Signature verified</span>
                ) : null}
              </div>
              {selected.error ? <p className="text-sm text-destructive">{selected.error}</p> : null}
              <DeliveryBlock title="Prompt sent to the agent">
                {selected.renderedPrompt ?? "No run was started for this request."}
              </DeliveryBlock>
              {selected.missingFields.length > 0 ? (
                <p className="text-sm text-muted-foreground">
                  Empty placeholders: {selected.missingFields.join(", ")}
                </p>
              ) : null}
              <DeliveryBlock title="Headers">
                {Object.entries(selected.headers)
                  .map(([name, value]) => `${name}: ${value}`)
                  .join("\n")}
              </DeliveryBlock>
              {selected.query ? (
                <DeliveryBlock title="Query">{selected.query}</DeliveryBlock>
              ) : null}
              <DeliveryBlock title={selected.bodyTruncated ? "Body (truncated)" : "Body"}>
                {selected.body || "(empty)"}
              </DeliveryBlock>
            </div>
          ) : selectedId !== null ? null : deliveries === null ? (
            <p className="text-sm text-muted-foreground" role="status">
              Loading deliveries…
            </p>
          ) : deliveries.length === 0 ? (
            <p className="text-sm text-muted-foreground">No requests yet.</p>
          ) : (
            <ul className="divide-y divide-border">
              {deliveries.map((delivery) => (
                <li key={delivery.id}>
                  <button
                    type="button"
                    className="flex w-full flex-wrap items-center gap-2 py-2 text-left text-sm state-hover"
                    onClick={() => setSelectedId(delivery.id)}
                  >
                    <SettingsStatusBadge tone={deliveryOutcomeTone(delivery.outcome)}>
                      {DELIVERY_OUTCOME_LABELS[delivery.outcome]}
                    </SettingsStatusBadge>
                    <span>{delivery.method}</span>
                    <span className="text-muted-foreground">
                      {relativeLabel(delivery.receivedAt)}
                    </span>
                    {delivery.missingFields.length > 0 ? (
                      <span className="text-muted-foreground">
                        {delivery.missingFields.length} empty placeholder
                        {delivery.missingFields.length === 1 ? "" : "s"}
                      </span>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </DialogPanel>
        <DialogFooter>
          {selectedId !== null ? (
            <Button variant="outline" size="sm" onClick={() => setSelectedId(null)}>
              Back
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              disabled={deliveriesQuery.isPending}
              onClick={deliveriesQuery.refresh}
            >
              Refresh
            </Button>
          )}
          <DialogClose render={<Button size="sm" />}>Done</DialogClose>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function DeliveryBlock({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <Label>{title}</Label>
      <pre className="scroll-fade-y max-h-64 overflow-auto rounded-md bg-muted p-2 text-xs whitespace-pre-wrap break-all">
        {children}
      </pre>
    </div>
  );
}

function WebhookEndpointField({
  environmentId,
  task,
}: {
  readonly environmentId: EnvironmentId;
  readonly task: ScheduledTask | null;
}) {
  const canRotate = useAtomValue(
    serverEnvironment.rotateScheduledTaskWebhookToken.permissionAtom(environmentId),
  );
  const httpBaseUrl = useEnvironmentHttpBaseUrl(environmentId);
  const rotate = useAtomCommand(serverEnvironment.rotateScheduledTaskWebhookToken, {
    label: "scheduled task rotate webhook token",
  });
  const [rotating, setRotating] = useState(false);
  const endpoint = task?.webhook;
  if (!task || !endpoint) {
    return <p className="text-sm text-muted-foreground">The URL appears after you save.</p>;
  }
  const { address: url, copyable, note } = webhookAddress(endpoint, httpBaseUrl);
  const rotateUrl = async () => {
    const confirmed =
      (await requestConfirmDialog("Rotate this webhook URL?\nThe current URL stops working.", {
        variant: "destructive",
      })) ??
      // No themed dialog host is mounted; fall back to the native prompt
      // rather than rotating unasked.
      window.confirm("Rotate this webhook URL? The current URL stops working.");
    if (!confirmed) return;
    setRotating(true);
    const result = await rotate({ environmentId, input: { id: task.id } });
    setRotating(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not rotate webhook URL",
          description: String(squashAtomCommandFailure(result)),
        }),
      );
    }
  };
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <Input
          readOnly
          aria-label="Webhook URL"
          value={url}
          onFocus={(event) => event.currentTarget.select()}
        />
        <CopyButton
          label="Copy webhook URL"
          size="sm"
          target="webhook URL"
          value={url}
          variant="outline"
          // A bare path is not a URL a sender can call.
          disabled={!copyable}
        >
          Copy
        </CopyButton>
        <Button
          size="sm"
          variant="outline"
          type="button"
          disabled={rotating || !canRotate}
          onClick={() => void rotateUrl()}
        >
          Rotate
        </Button>
      </div>
      {note !== null ? <p className="text-xs text-muted-foreground">{note}</p> : null}
      {endpoint.url !== null ? <WebhookDeliveryMode environmentId={environmentId} /> : null}
    </div>
  );
}

/**
 * Whether Cogenly Connect forwards requests live or holds them while the
 * environment is offline. The setting is per environment and only readable
 * for this machine's own environment, so other environments show nothing.
 */
function WebhookDeliveryMode({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const cloudLink = usePrimaryCloudLinkState();
  if (cloudLink.target?.environmentId !== environmentId || cloudLink.data === null) return null;
  return (
    <p className="text-xs text-muted-foreground">
      {cloudLink.data.holdWebhooksWhileOffline
        ? "Held for up to 24 hours while this machine is offline. "
        : "Forwarded live. Requests fail while this machine is offline. "}
      <Link to="/settings/connections" className="link">
        Change in Connections
      </Link>
    </p>
  );
}

function ScheduledTaskEditorDialog({
  initialEnvironmentId,
  task,
  onClose,
}: {
  readonly initialEnvironmentId: EnvironmentId;
  readonly task: ScheduledTask | null;
  readonly onClose: () => void;
}) {
  const { scope, connectedEnvironments } = useSettingsScope();
  const [environmentId, setEnvironmentId] = useState(initialEnvironmentId);
  const [targetMachine, setTargetMachine] = useState<EnvironmentId | null>(task?.machine ?? null);
  const machineList = useEnvironmentMachineList(environmentId);
  const runTarget =
    targetMachine ??
    task?.ownerMachine ??
    (machineList?.link._tag === "spoke" ? machineList.link.hubEnvironmentId : environmentId);
  const runOnOptions = mergeRunOnOptions({
    environments: connectedEnvironments.map((entry) => ({
      environmentId: entry.environmentId,
      projectId: null,
      label: entry.label,
      isPrimary: entry.environmentId === environmentId,
      machine: resolveEnvironmentMachineKind(entry.serverConfig),
    })),
    machines: machineList,
    pickedMachine: targetMachine,
  });
  // With one machine there is nothing to pick, unless the task points somewhere else.
  const runsOnIds = new Set([
    ...connectedEnvironments.map((entry) => entry.environmentId),
    ...runOnOptions
      .filter((option) => option.pairedMachine !== undefined)
      .map((option) => option.environmentId),
  ]);
  const showRunsOn = runsOnIds.size > 1 || !runsOnIds.has(runTarget);
  const environment = useEnvironment(environmentId);
  const connected =
    environment?.connection.phase === "connected" && environment.serverConfig !== null;
  const tasksQuery = useEnvironmentQuery(
    connected ? serverEnvironment.scheduledTasksLive({ environmentId, input: {} }) : null,
  );
  const allProjects = useProjects();
  const projects = useMemo(
    () =>
      allProjects.filter(
        (project) =>
          project.environmentId === environmentId &&
          matchesScheduledTaskScope(scope, environmentId),
      ),
    [allProjects, environmentId, scope],
  );
  const settings = useEnvironmentSettings(environmentId);
  const localProviders =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const remoteProviders = useEnvironmentQuery(
    runTarget === environmentId
      ? null
      : serverEnvironment.machineProviders({ environmentId, input: { machine: runTarget } }),
  );
  const providers = remoteProviders.data?.providers ?? localProviders;
  const canOperate = useAtomValue(
    serverEnvironment.upsertScheduledTask.permissionAtom(environmentId),
  );
  const upsertTask = useAtomCommand(serverEnvironment.upsertScheduledTask, {
    label: "scheduled task upsert",
  });
  const [draft, setDraft] = useState<DraftState>(() =>
    task ? taskToDraft(task) : { ...EMPTY_DRAFT, projectId: projects[0]?.id ?? "" },
  );
  const [saving, setSaving] = useState(false);
  // Shown beside the event filter, where an out-of-scope project or repository is fixed.
  const [eventFilterError, setEventFilterError] = useState<string | null>(null);
  const submissionPending = useRef(false);
  const editingTaskMissing =
    draft.editingId !== null &&
    tasksQuery.data !== null &&
    !tasksQuery.data.tasks.some((entry) => entry.id === draft.editingId);
  // The live row, so a rotated URL shows up without reopening the dialog.
  // Once the list has loaded, a missing task is gone; don't keep showing its URL.
  const liveTask = tasksQuery.data
    ? (tasksQuery.data.tasks.find((entry) => entry.id === draft.editingId) ?? null)
    : task;
  const selectedProjectId = draft.projectId || projects[0]?.id || "";
  const selectedProject = projects.find((project) => project.id === selectedProjectId);
  const instanceEntries = useMemo(
    () =>
      sortProviderInstanceEntries(
        applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings),
      ),
    [providers, settings],
  );

  // The real model picker is keyed by a `${instanceId}:${model}` string, which
  // is exactly how the draft stores its selection.
  const firstInstance = instanceEntries[0];
  const draftSelection = draft.modelKey ? splitModelKey(draft.modelKey) : null;
  const activeSelection =
    draftSelection &&
    instanceEntries.some((entry) => entry.instanceId === draftSelection.instanceId && entry.enabled)
      ? draftSelection
      : scheduledTaskDefaultModel(settings, instanceEntries);
  const activeInstanceId =
    activeSelection?.instanceId ?? firstInstance?.instanceId ?? ("" as ProviderInstanceId);
  const activeModel = activeSelection?.model ?? "";
  const modelOptionsByInstance = useMemo(
    () => getCustomModelOptionsByInstance(settings, providers, activeInstanceId, activeModel),
    [settings, providers, activeInstanceId, activeModel],
  );

  const reportFailure = (title: string, error: unknown) => {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title,
        description: error instanceof Error ? error.message : String(error),
      }),
    );
  };

  const submit = async () => {
    if (
      !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope) ||
      submissionPending.current ||
      saving ||
      editingTaskMissing ||
      !connected ||
      tasksQuery.data === null
    )
      return;
    const selection = activeSelection;
    if (
      !draft.title.trim() ||
      !draft.prompt.trim() ||
      !projects.some((project) => project.id === selectedProjectId) ||
      selection === null
    ) {
      reportFailure("Scheduled task is incomplete", "Add a title, prompt, repository, and model.");
      return;
    }
    if (draft.scheduleMode === "event" && draft.agentId === null) {
      reportFailure("Choose an agent", "An event trigger wakes one of your agents.");
      return;
    }
    const schedule = scheduleFromDraft(draft);
    if (schedule === null) {
      reportFailure(
        "Invalid age limit",
        `Enter whole minutes from 1 to ${MAX_WEBHOOK_DELIVERY_AGE_MINUTES}, or leave it blank.`,
      );
      return;
    }
    if (
      schedule.type === "webhook" &&
      schedule.signature &&
      (!schedule.signature.header ||
        (!schedule.signature.secret &&
          !(liveTask?.schedule.type === "webhook" && liveTask.webhook?.hasSecret)))
    ) {
      reportFailure("Signing secret is required", "Enter the signature header and secret.");
      return;
    }
    if (
      schedule.type === "interval" &&
      (!Number.isSafeInteger(schedule.everyMs) || schedule.everyMs < MIN_SCHEDULED_TASK_INTERVAL_MS)
    ) {
      reportFailure("Invalid interval", "Enter an interval of at least one minute.");
      return;
    }
    if (draft.workspaceMode === "existing_worktree" && !draft.existingWorktreePath.trim()) {
      reportFailure("Checkout path is required", "Enter the path of the checkout to run in.");
      return;
    }
    // Keep the original selection object (with provider options) when the
    // picker still points at the same instance+model.
    const modelSelection =
      draft.baseModelSelection !== null &&
      draft.baseModelSelection.instanceId === selection.instanceId &&
      draft.baseModelSelection.model === selection.model
        ? draft.baseModelSelection
        : selection;
    const workspaceStrategy: OrchestrationV2ThreadLaunchWorkspaceStrategy =
      draft.workspaceMode === "root"
        ? { type: "root" }
        : draft.workspaceMode === "existing_worktree"
          ? { type: "existing_worktree", worktreePath: draft.existingWorktreePath.trim() }
          : {
              type: "worktree",
              baseRef: draft.baseRef.trim() || "main",
              startFromOrigin: draft.startFromOrigin,
            };
    const input: ScheduledTaskUpsertInput = {
      ...(draft.editingId ? { id: draft.editingId as ScheduledTaskId, requireExisting: true } : {}),
      machine: draft.threadId || draft.agentId ? null : targetMachine,
      title: draft.title.trim(),
      prompt: draft.prompt.trim(),
      enabled: draft.enabled,
      schedule,
      ...(draft.scheduleMode === "event" && draft.agentId
        ? { agentId: AgentId.make(draft.agentId) }
        : {}),
      projectId: selectedProjectId as ProjectId,
      threadId: draft.threadId ? (draft.threadId as ThreadId) : null,
      workspaceStrategy,
      modelSelection,
      runtimeMode: draft.runtimeMode,
      interactionMode: draft.interactionMode,
      creationSource: "web",
    };
    // Lock before React renders, and keep successful creates locked until the form closes.
    submissionPending.current = true;
    setSaving(true);
    setEventFilterError(null);
    const result = await upsertTask({ environmentId, input });
    setSaving(false);
    if (result._tag === "Failure") {
      submissionPending.current = false;
      if (!isAtomCommandInterrupted(result)) {
        const failure = squashAtomCommandFailure(result);
        if (scheduledTaskErrorCode(failure) === "event_filter_out_of_scope")
          setEventFilterError(EVENT_FILTER_OUT_OF_SCOPE_MESSAGE);
        else reportFailure("Could not save scheduled task", failure);
      }
      return;
    }
    onClose();
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{draft.editingId ? "Edit task" : "New task"}</DialogTitle>
          <DialogDescription>
            Runs a prompt on a schedule, when a webhook is called, or when something happens in
            Work.
          </DialogDescription>
        </DialogHeader>

        <DialogPanel>
          <fieldset disabled={saving} className="space-y-5">
            {!connected ? (
              <p className="text-sm text-destructive">Reconnect this machine before saving.</p>
            ) : null}
            {tasksQuery.error ? (
              <p className="text-sm text-destructive" role="status">
                {tasksQuery.error}
              </p>
            ) : null}
            {editingTaskMissing ? (
              <p className="text-xs text-destructive" role="status">
                This scheduled task no longer exists.
              </p>
            ) : null}
            <Field label="Name" htmlFor="scheduled-task-title">
              <Input
                id="scheduled-task-title"
                placeholder="e.g. Check for Sentry issues"
                value={draft.title}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, title: event.target.value }))
                }
              />
            </Field>

            <Field label="Prompt" htmlFor="scheduled-task-prompt">
              <Textarea
                id="scheduled-task-prompt"
                className="max-h-64 overflow-y-auto"
                placeholder="What should the agent do each time this runs?"
                value={draft.prompt}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, prompt: event.target.value }))
                }
              />
            </Field>

            <div className="space-y-3">
              {task?.schedule.type === "interval" &&
              task.schedule.everyMs < MIN_SCHEDULED_TASK_INTERVAL_MS ? (
                <p className="text-sm text-muted-foreground" role="status">
                  This task uses a legacy interval below one minute. Saving updates it to at least
                  one minute.
                </p>
              ) : null}
              <div className="flex items-center justify-between gap-2">
                <Label>Schedule</Label>
                <ToggleGroup
                  aria-label="Schedule type"
                  value={[draft.scheduleMode]}
                  onValueChange={(values) => {
                    const mode = values[0] as ScheduleMode | undefined;
                    if (
                      mode === "fixed" ||
                      mode === "interval" ||
                      mode === "webhook" ||
                      mode === "event"
                    )
                      setDraft((current) => ({
                        ...current,
                        scheduleMode: mode,
                        prompt:
                          mode === "webhook" && !current.prompt.trim()
                            ? DEFAULT_WEBHOOK_PROMPT
                            : current.prompt,
                      }));
                  }}
                >
                  <Toggle value="fixed">At a time</Toggle>
                  <Toggle value="interval">Every interval</Toggle>
                  <Toggle value="webhook">On webhook</Toggle>
                  <Toggle value="event">On event</Toggle>
                </ToggleGroup>
              </div>

              {draft.scheduleMode === "event" ? (
                <EventScheduleFields
                  environmentId={environmentId}
                  draft={draft}
                  repositories={projects}
                  agentLocked={task?.agentId != null}
                  error={eventFilterError}
                  onChange={(patch) => {
                    setEventFilterError(null);
                    setDraft((current) => ({ ...current, ...patch }));
                  }}
                />
              ) : draft.scheduleMode === "webhook" ? (
                <div className="space-y-4">
                  <WebhookEndpointField environmentId={environmentId} task={liveTask} />
                  <p className="text-xs text-muted-foreground">
                    {
                      "Each request runs the prompt. Use {{body.path}}, {{headers.name}}, {{query.name}}, {{body}} or {{request}} in the prompt; only what it names reaches the agent."
                    }
                  </p>
                  <Field
                    label="Skip requests older than"
                    hint="minutes, optional"
                    htmlFor="scheduled-task-max-age"
                  >
                    <Input
                      id="scheduled-task-max-age"
                      type="number"
                      nativeInput
                      min={1}
                      max={MAX_WEBHOOK_DELIVERY_AGE_MINUTES}
                      placeholder="Run every request"
                      value={draft.maxDeliveryAgeMinutes}
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          maxDeliveryAgeMinutes: event.target.value,
                        }))
                      }
                    />
                  </Field>
                  <div className="flex items-center justify-between gap-4">
                    <div className="min-w-0 space-y-1">
                      <Label htmlFor="scheduled-task-signature">Require signature</Label>
                      <p className="text-sm text-muted-foreground">
                        Reject requests without a valid HMAC-SHA256 signature of the body.
                      </p>
                    </div>
                    <Switch
                      id="scheduled-task-signature"
                      checked={draft.signatureEnabled}
                      onCheckedChange={(signatureEnabled) =>
                        setDraft((current) => ({ ...current, signatureEnabled }))
                      }
                    />
                  </div>
                  {draft.signatureEnabled ? (
                    <div className="grid gap-3 sm:grid-cols-2">
                      <Field label="Header" htmlFor="scheduled-task-signature-header">
                        <Input
                          id="scheduled-task-signature-header"
                          value={draft.signatureHeader}
                          onChange={(event) =>
                            setDraft((current) => ({
                              ...current,
                              signatureHeader: event.target.value,
                            }))
                          }
                        />
                      </Field>
                      <Field label="Prefix" htmlFor="scheduled-task-signature-prefix">
                        <Input
                          id="scheduled-task-signature-prefix"
                          value={draft.signaturePrefix}
                          placeholder="None"
                          onChange={(event) =>
                            setDraft((current) => ({
                              ...current,
                              signaturePrefix: event.target.value,
                            }))
                          }
                        />
                      </Field>
                      <Field label="Encoding" htmlFor="scheduled-task-signature-encoding">
                        <Select
                          value={draft.signatureEncoding}
                          onValueChange={(value) =>
                            setDraft((current) => ({
                              ...current,
                              signatureEncoding: value === "base64" ? "base64" : "hex",
                            }))
                          }
                        >
                          <SelectTrigger size="sm" id="scheduled-task-signature-encoding">
                            <SelectValue>{draft.signatureEncoding}</SelectValue>
                          </SelectTrigger>
                          <SelectPopup>
                            <SelectItem value="hex">hex</SelectItem>
                            <SelectItem value="base64">base64</SelectItem>
                          </SelectPopup>
                        </Select>
                      </Field>
                      <Field label="Secret" htmlFor="scheduled-task-signature-secret">
                        <Input
                          id="scheduled-task-signature-secret"
                          type="password"
                          autoComplete="off"
                          value={draft.signatureSecret}
                          placeholder={
                            liveTask?.schedule.type === "webhook" && liveTask.webhook?.hasSecret
                              ? "Unchanged"
                              : "Shared secret"
                          }
                          onChange={(event) =>
                            setDraft((current) => ({
                              ...current,
                              signatureSecret: event.target.value,
                            }))
                          }
                        />
                      </Field>
                    </div>
                  ) : null}
                </div>
              ) : draft.scheduleMode === "fixed" ? (
                <div className="flex flex-wrap items-center gap-3">
                  <div className="flex items-center gap-2">
                    <Label htmlFor="scheduled-task-time">Run at</Label>
                    <Input
                      type="time"
                      id="scheduled-task-time"
                      nativeInput
                      className="w-32"
                      value={draft.timeOfDay}
                      onChange={(event) =>
                        setDraft((current) => ({ ...current, timeOfDay: event.target.value }))
                      }
                    />
                    <span className="text-xs text-muted-foreground">on</span>
                  </div>
                  <ToggleGroup
                    multiple
                    variant="outline"
                    size="sm"
                    aria-label="Days to run"
                    value={[...draft.weekdays].map(String)}
                    onValueChange={(values) => {
                      if (values.length === 0) return;
                      setDraft((current) => ({
                        ...current,
                        weekdays: new Set(values.map(Number)),
                      }));
                    }}
                  >
                    {WEEKDAY_ORDER.map((day) => (
                      <Toggle key={day} value={String(day)} aria-label={WEEKDAY_LABELS[day]}>
                        {WEEKDAY_SHORT[day]}
                      </Toggle>
                    ))}
                  </ToggleGroup>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <Label htmlFor="scheduled-task-interval">Run every</Label>
                  <Input
                    type="number"
                    id="scheduled-task-interval"
                    nativeInput
                    min={1}
                    step="any"
                    className="w-24"
                    value={draft.intervalMinutes}
                    onChange={(event) =>
                      setDraft((current) => ({ ...current, intervalMinutes: event.target.value }))
                    }
                  />
                  <span className="text-xs text-muted-foreground">minutes</span>
                </div>
              )}
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Repository" htmlFor="scheduled-task-project">
                <Select
                  value={selectedProjectId}
                  // An event trigger runs in its agent's repository.
                  disabled={draft.scheduleMode === "event" && draft.agentId !== null}
                  onValueChange={(projectId) =>
                    setDraft((current) => ({ ...current, projectId: projectId ?? "" }))
                  }
                >
                  <SelectTrigger size="sm" id="scheduled-task-project">
                    <SelectValue placeholder="Select a repository">
                      {selectedProject?.title}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {projects.map((project) => (
                      <SelectItem key={project.id} value={project.id} label={project.title}>
                        <span className="block truncate">{project.title}</span>
                        {allProjects.some(
                          (other) =>
                            other.title === project.title &&
                            (other.environmentId !== project.environmentId ||
                              other.id !== project.id),
                        ) ? (
                          <span className="block max-w-72 truncate text-xs text-muted-foreground">
                            {project.workspaceRoot}
                          </span>
                        ) : null}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </Field>

              <Field label="Workspace" htmlFor="scheduled-task-workspace">
                <Select
                  value={draft.workspaceMode}
                  onValueChange={(value) =>
                    setDraft((current) => ({ ...current, workspaceMode: value as WorkspaceMode }))
                  }
                >
                  <SelectTrigger size="sm" id="scheduled-task-workspace">
                    <SelectValue>{WORKSPACE_MODE_LABELS[draft.workspaceMode]}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    <SelectItem value="worktree">Create a new worktree</SelectItem>
                    <SelectItem value="root">Use the repository checkout</SelectItem>
                    <SelectItem value="existing_worktree">Use a specific checkout</SelectItem>
                  </SelectPopup>
                </Select>
              </Field>
            </div>

            {draft.workspaceMode === "worktree" ? (
              <Field label="Base branch" htmlFor="scheduled-task-base-ref">
                <WorktreeBaseBranchPicker
                  key={`${environmentId}:${selectedProjectId}`}
                  id="scheduled-task-base-ref"
                  environmentId={environmentId}
                  cwd={selectedProject?.workspaceRoot ?? null}
                  value={draft.baseRef}
                  onValueChange={(baseRef) => setDraft((current) => ({ ...current, baseRef }))}
                  startFromOrigin={draft.startFromOrigin}
                  onStartFromOriginChange={(startFromOrigin) =>
                    setDraft((current) => ({ ...current, startFromOrigin }))
                  }
                  disabled={saving || !connected}
                />
              </Field>
            ) : null}
            {draft.workspaceMode === "existing_worktree" ? (
              <Field label="Checkout path" htmlFor="scheduled-task-checkout">
                <Input
                  id="scheduled-task-checkout"
                  value={draft.existingWorktreePath}
                  placeholder="/path/to/checkout"
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      existingWorktreePath: event.target.value,
                    }))
                  }
                />
              </Field>
            ) : null}

            <Field label="Model">
              <div className="flex *:min-w-0 *:flex-1">
                <ProviderModelPicker
                  environmentId={environmentId}
                  disabled={saving || !connected}
                  activeInstanceId={activeInstanceId}
                  model={activeModel}
                  lockedProvider={null}
                  instanceEntries={instanceEntries}
                  modelOptionsByInstance={modelOptionsByInstance}
                  isComposerOwned={false}
                  triggerVariant="field"
                  onInstanceModelChange={(instanceId, model) =>
                    setDraft((current) => ({ ...current, modelKey: `${instanceId}:${model}` }))
                  }
                />
              </div>
            </Field>

            {showRunsOn ? (
              <Field label="Runs on" htmlFor="scheduled-task-environment">
                <Select
                  value={runTarget}
                  disabled={saving || Boolean(draft.threadId) || Boolean(draft.agentId)}
                  onValueChange={(id) => {
                    const next = connectedEnvironments.find((entry) => entry.environmentId === id);
                    if (!next) {
                      const picked = runOnOptions.find((option) => option.environmentId === id);
                      if (!picked) return;
                      setTargetMachine(picked.environmentId);
                      setDraft((current) =>
                        current.workspaceMode === "existing_worktree"
                          ? { ...current, workspaceMode: "worktree", existingWorktreePath: "" }
                          : current,
                      );
                      return;
                    }
                    if (task !== null && next.environmentId !== environmentId) {
                      setTargetMachine(next.environmentId);
                      return;
                    }
                    setTargetMachine(next.environmentId);
                    setEnvironmentId(next.environmentId);
                    setDraft((current) => ({
                      ...current,
                      projectId: "",
                      modelKey: "",
                      baseModelSelection: null,
                      baseRef: "main",
                      startFromOrigin: true,
                      existingWorktreePath: "",
                    }));
                  }}
                >
                  <SelectTrigger id="scheduled-task-environment" size="sm">
                    <SelectValue>
                      <span className="flex items-center gap-2">
                        <EnvironmentMachineIcon
                          kind={
                            runOnOptions.find((option) => option.environmentId === runTarget)
                              ?.machine ??
                            resolveEnvironmentMachineKind(environment?.serverConfig ?? null)
                          }
                          className="size-4"
                        />
                        {runOnOptions.find((option) => option.environmentId === runTarget)?.label ??
                          environment?.label ??
                          "Unavailable machine"}
                      </span>
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {connectedEnvironments.map((entry) => {
                      const { secondary } = settingsScopeEnvironmentLabels(
                        entry,
                        connectedEnvironments,
                      );
                      return (
                        <SelectItem
                          key={entry.environmentId}
                          value={entry.environmentId}
                          label={entry.label}
                        >
                          <span className="flex min-w-0 items-center gap-2">
                            <EnvironmentMachineIcon
                              kind={resolveEnvironmentMachineKind(entry.serverConfig)}
                              className="size-4"
                            />
                            <span className="min-w-0">
                              <span className="block truncate">{entry.label}</span>
                              {secondary ? (
                                <span className="block max-w-72 truncate text-xs text-muted-foreground">
                                  {secondary}
                                </span>
                              ) : null}
                            </span>
                          </span>
                        </SelectItem>
                      );
                    })}
                    {runOnOptions
                      .filter((option) => option.pairedMachine !== undefined)
                      .map((option) => (
                        <SelectItem
                          key={option.environmentId}
                          value={option.environmentId}
                          label={option.label}
                        >
                          <EnvironmentOptionContent option={option} />
                        </SelectItem>
                      ))}
                  </SelectPopup>
                </Select>
              </Field>
            ) : null}

            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0 space-y-1">
                <Label htmlFor="scheduled-task-enabled">Active</Label>
                <p
                  id="scheduled-task-enabled-description"
                  className="text-sm text-muted-foreground"
                >
                  Paused tasks stay saved but don't run.
                </p>
              </div>
              <Switch
                id="scheduled-task-enabled"
                aria-describedby="scheduled-task-enabled-description"
                checked={draft.enabled}
                onCheckedChange={(enabled) => setDraft((current) => ({ ...current, enabled }))}
              />
            </div>
          </fieldset>
        </DialogPanel>

        <DialogFooter>
          <DialogClose render={<Button variant="outline" size="sm" disabled={saving} />}>
            Cancel
          </DialogClose>
          <Button
            size="sm"
            disabled={!canOperate || saving || editingTaskMissing || !connected || !tasksQuery.data}
            onClick={() => void submit()}
          >
            {draft.editingId ? "Save task" : "Create task"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/**
 * Which agent an event trigger wakes and what wakes it. Choosing the agent binds the
 * task to its conversation, repository and model, as triggers made from the agent are.
 */
function EventScheduleFields({
  environmentId,
  draft,
  repositories,
  agentLocked,
  error,
  onChange,
}: {
  readonly environmentId: EnvironmentId;
  readonly draft: DraftState;
  readonly repositories: ReadonlyArray<{ id: ProjectId; title: string }>;
  /** An agent's own trigger keeps its agent. */
  readonly agentLocked: boolean;
  /** Why the server rejected the filter, shown under it. */
  readonly error: string | null;
  readonly onChange: (patch: Partial<DraftState>) => void;
}) {
  const { agents } = useAgents();
  const { labels } = useEnvironmentProjectLabels(environmentId);
  const candidates = agents.filter((agent) => agent.environmentId === environmentId);
  const selected = candidates.find((agent) => agent.id === draft.agentId);
  // The filter may name only what the chosen agent can read; nothing before one is chosen.
  const choices = selected
    ? eventFilterChoices(selected, labels, repositories)
    : { labels: [], repositories: [] };
  return (
    <div className="space-y-4">
      <Field label="Wakes" htmlFor="scheduled-task-agent">
        <Select
          value={draft.agentId ?? ""}
          disabled={agentLocked}
          onValueChange={(id) => {
            const agent = candidates.find((candidate) => candidate.id === id);
            if (!agent) return;
            onChange({
              agentId: agent.id,
              threadId: agent.conversationThreadId,
              ...(agent.projectId ? { projectId: agent.projectId } : {}),
              workspaceMode: "root",
              runtimeMode: agent.runtimeMode,
              modelKey: `${agent.modelSelection.instanceId}:${agent.modelSelection.model}`,
              baseModelSelection: agent.modelSelection,
            });
          }}
        >
          <SelectTrigger size="sm" id="scheduled-task-agent">
            <SelectValue placeholder="Choose an agent">
              {selected?.name ?? (draft.agentId ? "Unknown agent" : undefined)}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup>
            {candidates.map((agent) => (
              <SelectItem key={agent.id} value={agent.id} label={agent.name}>
                {agent.name}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </Field>
      {candidates.length === 0 && draft.agentId === null ? (
        <p className="text-xs text-muted-foreground">
          Events wake an agent. Create one in Agents first.
        </p>
      ) : null}
      <EventTriggerFields
        value={draft.event}
        environmentId={environmentId}
        {...choices}
        Field={Field}
        onChange={(event) => onChange({ event })}
      />
      {error ? (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
