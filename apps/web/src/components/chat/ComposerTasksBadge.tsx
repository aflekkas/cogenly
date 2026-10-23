import { CheckIcon, CircleDotIcon, CircleIcon, ListTodoIcon } from "lucide-react";
import { memo, type ComponentProps } from "react";

import { formatDuration } from "../../session-logic";
import { cn } from "~/lib/utils";
import { DisclosurePanel } from "../ui/disclosure";
import { ComposerBanner } from "./ComposerBanner";
import { composerStackBodyProps, useComposerStackFold } from "./ComposerStackColumn";

// Folds after background work and before the queue when the stack runs out of room.
const TASKS_STACK_ID = "tasks";
const TASKS_STACK_RANK = 2;

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
    <span aria-hidden className={cn("flex w-10 shrink-0 items-center gap-0.5", className)}>
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

function TaskSummary({
  expanded,
  progress,
  steps,
}: {
  readonly expanded: boolean;
  readonly progress: ComposerTasksProgress;
  readonly steps: readonly ComposerTaskStep[];
}) {
  return (
    <>
      <ComposerBanner.Icon>
        <ListTodoIcon />
      </ComposerBanner.Icon>
      <ComposerBanner.Content>
        <span className="shrink-0 text-muted-foreground">Tasks</span>
        <span
          className="min-w-0 flex-1 truncate text-left font-medium text-foreground/80"
          data-composer-task-current="true"
        >
          {progress.step}
        </span>
      </ComposerBanner.Content>
      <ComposerBanner.Actions>
        <ComposerBanner.Count
          className={progress.completedSteps >= progress.totalSteps ? "text-success" : undefined}
          data-composer-task-progress="true"
        >
          {progress.completedSteps}/{progress.totalSteps}
        </ComposerBanner.Count>
        <TaskSegments className="hidden w-20 @min-[560px]:flex" steps={steps} />
        <ComposerBanner.ToggleIcon expanded={expanded} />
      </ComposerBanner.Actions>
    </>
  );
}

export const ComposerTasksBadge = memo(function ComposerTasksBadge({
  expanded,
  onToggle,
  placement = "tab",
  progress,
  steps,
}: {
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly placement?: "inline" | "tab";
  readonly progress: ComposerTasksProgress;
  readonly steps: readonly ComposerTaskStep[];
}) {
  if (progress.totalSteps <= 0) return null;

  const row = (
    <ComposerBanner.Row
      render={<button type="button" />}
      aria-expanded={expanded}
      aria-label={`${expanded ? "Collapse tasks" : "Tasks"}: ${progress.completedSteps} of ${progress.totalSteps} complete. Current task: ${progress.step}`}
      data-composer-tasks-badge="true"
      onClick={onToggle}
      onPointerDown={(event) => event.preventDefault()}
    >
      <TaskSummary expanded={expanded} progress={progress} steps={steps} />
    </ComposerBanner.Row>
  );
  return placement === "inline" ? (
    row
  ) : (
    <ComposerBanner.Root density="comfortable" data-composer-shoulder-tab>
      {row}
    </ComposerBanner.Root>
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
  const stackFold = useComposerStackFold(TASKS_STACK_ID);
  const listShown = expanded && !stackFold.folded;
  return (
    <div
      data-chat-composer-collapsed-controls="true"
      data-chat-composer-tasks-drawer={listShown ? "true" : undefined}
    >
      <ComposerTasksBadge
        expanded={listShown}
        onToggle={expanded && stackFold.folded ? stackFold.reveal : onToggle}
        placement="inline"
        progress={progress}
        steps={steps}
      />
      <div {...composerStackBodyProps(TASKS_STACK_ID, TASKS_STACK_RANK, expanded)}>
        <DisclosurePanel open={listShown}>
          <ComposerBanner.Scroll data-composer-tasks-scroll="true">
            <ComposerBanner.Children
              render={<ul role="list" />}
              aria-label={`Task list. ${progress.completedSteps} of ${progress.totalSteps} complete.`}
              data-composer-tasks-list="true"
            >
              {keyedTaskSteps(steps).map(({ key, step }) => (
                <ComposerBanner.Row key={key} render={<li />} className="items-start py-1 pe-2">
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
                </ComposerBanner.Row>
              ))}
            </ComposerBanner.Children>
          </ComposerBanner.Scroll>
        </DisclosurePanel>
      </div>
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
    <ComposerBanner.Root
      density="comfortable"
      data-composer-shoulder-tab={props.expanded ? undefined : true}
    >
      <ComposerTasksContent {...props} />
    </ComposerBanner.Root>
  );
});
