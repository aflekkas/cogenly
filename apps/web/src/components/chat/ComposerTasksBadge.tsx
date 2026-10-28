import { CheckIcon, CircleDotIcon, CircleIcon, ListTodoIcon } from "lucide-react";
import { memo, useId, type ComponentProps } from "react";

import { formatDuration } from "../../session-logic";
import { cn } from "~/lib/utils";
import { ComposerBanner } from "./ComposerBanner";
import { ComposerTray, useComposerTrayDisclosure } from "./ComposerTray";

export interface ComposerTasksProgress {
  readonly step: string;
  readonly completedSteps: number;
  readonly totalSteps: number;
}

export interface ComposerTaskStep {
  readonly durationMs?: number;
  readonly step: string;
  readonly status: "pending" | "inProgress" | "completed";
}

const MAX_TASK_SEGMENTS = 10;

const taskStatusLabels = {
  pending: "Pending",
  inProgress: "Running",
  completed: "Completed",
} satisfies Record<ComposerTaskStep["status"], string>;

function keyedTaskSteps(steps: readonly ComposerTaskStep[]) {
  const occurrences = new Map<string, number>();
  return steps.map((step) => {
    const occurrence = occurrences.get(step.step) ?? 0;
    occurrences.set(step.step, occurrence + 1);
    return { key: `${step.step}:${occurrence}`, step };
  });
}

function TaskSegments({
  className,
  steps,
}: {
  readonly className?: string;
  readonly steps: readonly ComposerTaskStep[];
}) {
  if (steps.length <= 1 || steps.length > MAX_TASK_SEGMENTS) return null;

  return (
    <span
      aria-hidden
      className={cn("pointer-events-none flex w-10 shrink-0 items-center gap-0.5", className)}
    >
      {keyedTaskSteps(steps).map(({ key, step }) => (
        <span
          key={key}
          className={cn(
            "h-[3px] min-w-0 flex-1 rounded-full",
            step.status === "completed"
              ? "bg-success"
              : step.status === "inProgress"
                ? "bg-primary"
                : "bg-muted-foreground/25",
          )}
        />
      ))}
    </span>
  );
}

export const ComposerTasksBadge = memo(function ComposerTasksBadge({
  expanded,
  onToggle,
  listId,
  placement = "tab",
  progress,
  steps,
}: {
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly listId?: string;
  readonly placement?: "inline" | "tab";
  readonly progress: ComposerTasksProgress;
  readonly steps: readonly ComposerTaskStep[];
}) {
  if (progress.totalSteps <= 0) return null;

  const row = (
    <ComposerTray.Header
      data-composer-tasks-badge="true"
      icon={<ListTodoIcon />}
      title="Tasks"
      summary={<span data-composer-task-current="true">{progress.step}</span>}
      actions={<TaskSegments className="hidden w-20 @min-[560px]:flex" steps={steps} />}
      count={
        <span
          className={progress.completedSteps >= progress.totalSteps ? "text-success" : undefined}
          data-composer-task-progress="true"
        >
          {progress.completedSteps}/{progress.totalSteps}
        </span>
      }
      open={expanded}
      onToggle={onToggle}
      toggleLabel={`${expanded ? "Collapse tasks" : "Tasks"}: ${progress.completedSteps} of ${progress.totalSteps} complete. Current task: ${progress.step}`}
      controls={listId}
    />
  );
  return placement === "inline" ? (
    row
  ) : (
    <ComposerTray.Root data-composer-shoulder-tab>{row}</ComposerTray.Root>
  );
});

export const ComposerTasksContent = memo(function ComposerTasksContent({
  expanded,
  onToggle,
  progress,
  steps,
}: {
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly progress: ComposerTasksProgress;
  readonly steps: readonly ComposerTaskStep[];
}) {
  // The stack may fold the list to its header when it runs out of room.
  const tray = useComposerTrayDisclosure("tasks", expanded, onToggle);
  const listId = useId();
  return (
    <div
      data-chat-composer-collapsed-controls="true"
      data-chat-composer-tasks-drawer={tray.shown ? "true" : undefined}
    >
      <ComposerTasksBadge
        expanded={tray.shown}
        onToggle={tray.toggle}
        listId={listId}
        placement="inline"
        progress={progress}
        steps={steps}
      />
      <ComposerTray.Body id={listId} trayId="tasks" open={expanded} shown={tray.shown}>
        <ComposerTray.List
          render={<ul role="list" />}
          aria-label={`Task list. ${progress.completedSteps} of ${progress.totalSteps} complete.`}
          data-composer-tasks-list="true"
        >
          {keyedTaskSteps(steps).map(({ key, step }) => (
            <ComposerTray.Item key={key} render={<li />} className="items-start py-1 pe-2">
              <ComposerBanner.Icon
                className={cn(
                  "h-4",
                  step.status === "completed"
                    ? "text-success"
                    : step.status === "inProgress"
                      ? "text-primary"
                      : "text-muted-foreground/40",
                )}
              >
                {step.status === "completed" ? (
                  <CheckIcon />
                ) : step.status === "inProgress" ? (
                  <CircleDotIcon />
                ) : (
                  <CircleIcon />
                )}
              </ComposerBanner.Icon>
              <ComposerBanner.Content
                className={cn(
                  "block wrap-anywhere",
                  step.status === "completed"
                    ? "text-muted-foreground/55"
                    : step.status === "inProgress"
                      ? "text-foreground/90"
                      : "text-muted-foreground/70",
                )}
              >
                <span className="sr-only">{taskStatusLabels[step.status]}: </span>
                {step.step}
              </ComposerBanner.Content>
              <ComposerBanner.Actions>
                <span
                  className="w-12 text-right text-3xs/4 text-muted-foreground/45 tabular-nums"
                  data-composer-task-duration="true"
                >
                  {step.durationMs !== undefined
                    ? formatDuration(step.durationMs)
                    : step.status === "inProgress"
                      ? "now"
                      : null}
                </span>
              </ComposerBanner.Actions>
            </ComposerTray.Item>
          ))}
        </ComposerTray.List>
      </ComposerTray.Body>
    </div>
  );
});

/**
 * The tasks tab and its open list as one surface; the caller places it in a
 * composer attachment. Toggling grows the list under the same header, so the
 * chevron turns and the surface never swaps.
 */
export const ComposerTasksPanel = memo(function ComposerTasksPanel(
  props: ComponentProps<typeof ComposerTasksContent>,
) {
  return (
    <ComposerTray.Root data-composer-shoulder-tab={props.expanded ? undefined : true}>
      <ComposerTasksContent {...props} />
    </ComposerTray.Root>
  );
});
