import type {
  AgentEventFilter,
  AgentEventKind,
  ProjectId,
  ProjectLabelWithRepositories,
} from "@t3tools/contracts";
import { FolderGit2Icon, PlusIcon } from "lucide-react";
import type { ComponentType, ReactNode } from "react";
import { Button } from "~/components/ui/button";
import { Menu, MenuCheckboxItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { ProjectLabelChips, ProjectLabelPicker } from "~/projectLabels/ProjectLabelPicker";
import {
  EVENT_ORIGIN_LABEL,
  EVENT_TRIGGER_OPTIONS,
  eventFiltersWork,
  normalizeEventFilter,
} from "./agentWorkspace.logic";

export interface EventTriggerValue {
  event: AgentEventKind;
  filter?: typeof AgentEventFilter.Type | undefined;
}

/** The default an editor switches to when the owner picks "When something happens". */
export const DEFAULT_EVENT_TRIGGER = { type: "event", event: "pr.checks_failed" } as const;

const ORIGIN_OPTIONS = [
  { value: "any", label: "Any Work" },
  ...Object.entries(EVENT_ORIGIN_LABEL).map(([value, label]) => ({ value, label })),
];

function CompactField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5 text-xs font-medium text-muted-foreground">
      {label}
      {children}
    </div>
  );
}

/**
 * The event, and optionally which projects, repositories and Work origin it is
 * limited to. Filters only narrow what the agent already receives; the server
 * delivers events from repositories in its scope and wakes it once per event.
 */
export function EventTriggerFields({
  value,
  onChange,
  labels,
  repositories,
  onManageProjects,
  Field = CompactField,
}: {
  value: EventTriggerValue;
  onChange: (value: { event: AgentEventKind; filter?: EventTriggerValue["filter"] }) => void;
  /** Projects the filter may name. */
  labels: ReadonlyArray<ProjectLabelWithRepositories>;
  /** Repositories the filter may name. */
  repositories: ReadonlyArray<{ id: ProjectId; title: string }>;
  onManageProjects?: (() => void) | undefined;
  Field?: ComponentType<{ label: string; children: ReactNode }>;
}) {
  const filter = value.filter;
  const labelIds = filter?.labelIds ?? [];
  const projectIds = filter?.projectIds ?? [];
  const update = (event: AgentEventKind, next: EventTriggerValue["filter"]) => {
    const normalized = normalizeEventFilter(event, next);
    onChange(normalized ? { event, filter: normalized } : { event });
  };
  const work = eventFiltersWork(value.event);
  const selectedRepositories = repositories.filter((repository) =>
    projectIds.includes(repository.id),
  );
  return (
    <>
      <Field label="What happens">
        <Select
          value={value.event}
          onValueChange={(next) => {
            const option = EVENT_TRIGGER_OPTIONS.find((item) => item.value === next);
            if (option) update(option.value, filter);
          }}
        >
          <SelectTrigger size="sm" aria-label="What happens">
            <SelectValue>
              {EVENT_TRIGGER_OPTIONS.find((item) => item.value === value.event)?.label}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup>
            {EVENT_TRIGGER_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value} label={option.label}>
                {option.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </Field>
      <Field label={work ? "Only in these projects or repositories" : "Only in these projects"}>
        <div className="flex flex-wrap items-center gap-1">
          <ProjectLabelChips labels={labels} ids={labelIds} />
          {work &&
            selectedRepositories.map((repository) => (
              <span
                key={repository.id}
                className="inline-flex items-center gap-1 text-xs font-normal text-foreground"
              >
                <FolderGit2Icon className="size-3.5 text-muted-foreground" />
                {repository.title}
              </span>
            ))}
          <ProjectLabelPicker
            labels={labels}
            selectedIds={labelIds}
            onManage={onManageProjects}
            onToggle={(labelId, selected) =>
              update(value.event, {
                ...filter,
                labelIds: selected
                  ? [...labelIds, labelId]
                  : labelIds.filter((id) => id !== labelId),
              })
            }
          >
            <PlusIcon />
            Project
          </ProjectLabelPicker>
          {work && repositories.length > 0 && (
            <Menu>
              <MenuTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost-muted"
                    size="xs"
                    aria-label="Choose repositories"
                  />
                }
              >
                <PlusIcon />
                Repository
              </MenuTrigger>
              <MenuPopup align="start">
                {repositories.map((repository) => (
                  <MenuCheckboxItem
                    key={repository.id}
                    checked={projectIds.includes(repository.id)}
                    onCheckedChange={(checked) =>
                      update(value.event, {
                        ...filter,
                        projectIds: checked
                          ? [...projectIds, repository.id]
                          : projectIds.filter((id) => id !== repository.id),
                      })
                    }
                  >
                    {repository.title}
                  </MenuCheckboxItem>
                ))}
              </MenuPopup>
            </Menu>
          )}
          {labelIds.length === 0 && projectIds.length === 0 && (
            <span className="text-xs font-normal text-muted-foreground">Anywhere</span>
          )}
        </div>
      </Field>
      {work && (
        <Field label="Started by">
          <Select
            value={filter?.origin ?? "any"}
            onValueChange={(next) =>
              update(value.event, {
                ...filter,
                origin: next === "direct" || next === "chat" || next === "agent" ? next : undefined,
              })
            }
          >
            <SelectTrigger size="sm" aria-label="Started by">
              <SelectValue>
                {filter?.origin ? EVENT_ORIGIN_LABEL[filter.origin] : "Any Work"}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {ORIGIN_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value} label={option.label}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </Field>
      )}
      <p className="text-xs font-normal text-muted-foreground">
        It only reacts to events in repositories it’s scoped to, and a repeated event wakes it once.
      </p>
    </>
  );
}
