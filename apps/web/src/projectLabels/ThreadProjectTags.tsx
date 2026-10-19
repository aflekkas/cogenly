import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  ProjectLabelId,
  ProjectLabelWithRepositories,
  ThreadId,
  ThreadProjectLabel,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import type * as Cause from "effect/Cause";
import { CheckIcon, PlusIcon, Settings2Icon, TagIcon, XIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Button } from "../components/ui/button";
import {
  Combobox,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxSearchInput,
  ComboboxStatus,
  ComboboxTrigger,
} from "../components/ui/combobox";
import { toastManager } from "../components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { useThreadShell } from "../state/entities";
import { useEnvironmentQuery } from "../state/query";
import { serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";
import { ProjectContextToggle } from "../context/ThreadContext";
import {
  nextThreadLabelIds,
  PROJECT_LABEL_COLORS,
  resolveThreadTags,
  sortProjectLabels,
  splitTagChips,
} from "./projectLabels.logic";
import { subscribeThreadProjectTagsOpen } from "./projectTagsActionBus";
import { ProjectColorDot, ProjectTag } from "./ProjectTag";
import { useEnvironmentProjectLabels } from "./useProjectLabels";

const EMPTY_TAGS: ReadonlyArray<ThreadProjectLabel> = [];

// Threads already asked for suggestions this session. Asking again after a
// navigation would only re-propose what the user has not acted on yet.
const suggestionRequested = new Set<string>();

type TagOption =
  | { readonly kind: "none"; readonly key: "none" }
  | {
      readonly kind: "label";
      readonly key: string;
      readonly label: ProjectLabelWithRepositories;
      readonly state: "confirmed" | "suggested" | "off";
    }
  | { readonly kind: "create"; readonly key: "create"; readonly name: string };

function optionText(option: TagOption): string {
  switch (option.kind) {
    case "none":
      return "No project";
    case "label":
      return option.label.name;
    case "create":
      return `Create ${option.name}`;
  }
}

function reportFailure(title: string, result: { readonly cause: Cause.Cause<unknown> }) {
  const error = squashAtomCommandFailure(result);
  toastManager.add({
    type: "error",
    title,
    description: error instanceof Error ? error.message : "An error occurred.",
  });
}

/**
 * The thread header's project tags: up to two chips (+N), and a picker to
 * add, remove, create, or clear them. Suggestions stay outlined until the
 * user accepts one; nothing here confirms a tag on its own.
 */
export function ThreadProjectTags(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const { environmentId, threadId } = props;
  const navigate = useNavigate();
  const { labels, isLoaded: labelsLoaded } = useEnvironmentProjectLabels(environmentId);
  const tagsQuery = useEnvironmentQuery(
    serverEnvironment.threadProjectLabelsLive({ environmentId, input: { threadId } }),
  );
  const tags = tagsQuery.data?.labels ?? EMPTY_TAGS;
  const canEdit = useAtomValue(
    serverEnvironment.setThreadProjectLabels.permissionAtom(environmentId),
  );
  const setThreadLabels = useAtomCommand(serverEnvironment.setThreadProjectLabels, "tag thread");
  const reviewSuggestion = useAtomCommand(
    serverEnvironment.reviewThreadProjectLabelSuggestion,
    "review thread tag suggestion",
  );
  const suggestLabels = useAtomCommand(
    serverEnvironment.suggestThreadProjectLabels,
    "suggest thread tags",
  );
  const createLabel = useAtomCommand(serverEnvironment.createProjectLabel, "create project");
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);

  // Wait a frame so the palette closing (and restoring focus) cannot close the picker.
  useEffect(
    () => subscribeThreadProjectTagsOpen(() => requestAnimationFrame(() => setOpen(true))),
    [],
  );

  // Ask for suggestions once, after the first exchange, for an untagged thread.
  const shell = useThreadShell(
    useMemo(() => scopeThreadRef(environmentId, threadId), [environmentId, threadId]),
  );
  const hasFinishedExchange =
    shell?.latestRun?.status === "completed" && shell.latestRun.assistantMessageId !== null;
  const tagsLoaded = tagsQuery.data !== null;
  useEffect(() => {
    const key = `${environmentId}:${threadId}`;
    if (
      !canEdit ||
      !hasFinishedExchange ||
      !labelsLoaded ||
      labels.length === 0 ||
      !tagsLoaded ||
      tags.length > 0 ||
      suggestionRequested.has(key)
    ) {
      return;
    }
    suggestionRequested.add(key);
    // Best effort: a failed suggestion leaves the thread untagged, which is honest.
    void suggestLabels({ environmentId, input: { threadId } });
  }, [
    canEdit,
    environmentId,
    hasFinishedExchange,
    labels.length,
    labelsLoaded,
    suggestLabels,
    tags.length,
    tagsLoaded,
    threadId,
  ]);

  const labelsById = useMemo(
    () => new Map(labels.map((label) => [label.id as string, label] as const)),
    [labels],
  );
  const resolved = useMemo(() => resolveThreadTags(tags, labelsById), [labelsById, tags]);
  const chips = splitTagChips(resolved);
  const suggestions = resolved.filter((entry) => entry.suggested);
  const hasConfirmed = resolved.some((entry) => !entry.suggested);

  const options = useMemo((): TagOption[] => {
    const stateById = new Map(
      tags.map(
        (tag) => [tag.labelId as string, tag.confirmedByUser ? "confirmed" : "suggested"] as const,
      ),
    );
    const needle = query.trim().toLowerCase();
    const matching = sortProjectLabels(labels.map((label) => ({ label })))
      .map((entry) => entry.label)
      .filter((label) => needle === "" || label.name.toLowerCase().includes(needle));
    const result: TagOption[] = [];
    if (needle === "") result.push({ kind: "none", key: "none" });
    for (const label of matching) {
      result.push({ kind: "label", key: label.id, label, state: stateById.get(label.id) ?? "off" });
    }
    if (needle !== "" && !labels.some((label) => label.name.toLowerCase() === needle)) {
      result.push({ kind: "create", key: "create", name: query.trim() });
    }
    return result;
  }, [labels, query, tags]);

  const run = async (action: () => Promise<void>) => {
    if (busy || !canEdit) return;
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  };

  const setLabels = async (labelIds: ProjectLabelId[]) => {
    const result = await setThreadLabels({ environmentId, input: { threadId, labelIds } });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      reportFailure("Could not update projects", result);
    }
  };

  const review = (labelId: ProjectLabelId, accept: boolean) =>
    run(async () => {
      const result = await reviewSuggestion({
        environmentId,
        input: { threadId, labelId, accept },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        reportFailure(accept ? "Could not add project" : "Could not dismiss suggestion", result);
      }
    });

  const choose = (option: TagOption) =>
    run(async () => {
      if (option.kind === "none") {
        await setLabels([]);
        return;
      }
      if (option.kind === "label") {
        if (option.state === "suggested") {
          const result = await reviewSuggestion({
            environmentId,
            input: { threadId, labelId: option.label.id, accept: true },
          });
          if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
            reportFailure("Could not add project", result);
          }
          return;
        }
        await setLabels(nextThreadLabelIds(tags, option.label.id, option.state === "off"));
        return;
      }
      const color = PROJECT_LABEL_COLORS[labels.length % PROJECT_LABEL_COLORS.length]?.value;
      const created = await createLabel({
        environmentId,
        input: { name: option.name, ...(color ? { color } : {}) },
      });
      if (created._tag === "Failure") {
        if (!isAtomCommandInterrupted(created)) reportFailure("Could not create project", created);
        return;
      }
      setQuery("");
      await setLabels(nextThreadLabelIds(tags, created.value.label.id, true));
    });

  // Nothing to show and nothing the viewer could do.
  if (!canEdit && resolved.length === 0) return null;

  const triggerLabel =
    resolved.length === 0
      ? "Add to a project"
      : `Projects: ${resolved.map((entry) => `${entry.label.name}${entry.suggested ? " (suggested)" : ""}`).join(", ")}`;

  return (
    <Combobox
      items={options}
      filteredItems={options}
      autoHighlight
      value={null}
      open={open}
      onOpenChange={(next, details) => {
        // Stay open while toggling several projects in a row.
        if (!next && details.reason === "item-press") return;
        setOpen(next);
        if (!next) setQuery("");
      }}
      itemToStringLabel={optionText}
      isItemEqualToValue={(left, right) => left.key === right.key}
      onValueChange={(option) => {
        if (option) void choose(option);
      }}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <ComboboxTrigger
              render={
                <Button
                  type="button"
                  variant="ghost-muted"
                  size={resolved.length === 0 ? "icon-xs" : "xs"}
                  aria-label={triggerLabel}
                />
              }
            />
          }
        >
          {resolved.length === 0 ? (
            <TagIcon />
          ) : (
            <>
              {chips.visible.map((entry) => (
                <ProjectTag
                  key={entry.label.id}
                  name={entry.label.name}
                  color={entry.label.color}
                  suggested={entry.suggested}
                />
              ))}
              {chips.overflow.length > 0 ? (
                <span className="text-2xs tabular-nums">+{chips.overflow.length}</span>
              ) : null}
            </>
          )}
        </TooltipTrigger>
        <TooltipPopup side="bottom">{triggerLabel}</TooltipPopup>
      </Tooltip>
      <ComboboxPopup align="start" className="w-64">
        {suggestions.length > 0 && canEdit ? (
          <div className="border-b border-border/70 px-3 py-2">
            <div className="mb-1.5 text-2xs font-medium text-muted-foreground">Suggested</div>
            <ul className="space-y-1">
              {suggestions.map((entry) => (
                <li key={entry.label.id} className="flex items-center gap-1">
                  <ProjectTag name={entry.label.name} color={entry.label.color} suggested />
                  <span className="flex-1" />
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost"
                    aria-label={`Add ${entry.label.name}`}
                    disabled={busy}
                    onClick={() => void review(entry.label.id, true)}
                  >
                    <CheckIcon />
                  </Button>
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost-muted"
                    aria-label={`Dismiss ${entry.label.name}`}
                    disabled={busy}
                    onClick={() => void review(entry.label.id, false)}
                  >
                    <XIcon />
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <ComboboxSearchInput
          aria-label="Find or create a project"
          placeholder={canEdit ? "Find or create a project" : "Find a project"}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        {!canEdit ? (
          <ComboboxStatus>You can see this thread's projects but not change them.</ComboboxStatus>
        ) : null}
        <ComboboxList>
          {(option: TagOption) => (
            <ComboboxItem
              key={option.key}
              value={option}
              disabled={!canEdit || busy || (option.kind === "create" && option.name.length > 200)}
            >
              {option.kind === "none" ? (
                <>
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">No project</span>
                  {!hasConfirmed ? <CheckIcon className="ml-auto" /> : null}
                </>
              ) : option.kind === "label" ? (
                <>
                  <ProjectColorDot color={option.label.color} />
                  <span className="min-w-0 flex-1 truncate">{option.label.name}</span>
                  {option.state === "suggested" ? (
                    <span className="text-2xs text-muted-foreground">Suggested</span>
                  ) : null}
                  {option.state === "confirmed" ? <CheckIcon className="ml-auto" /> : null}
                </>
              ) : (
                <>
                  <PlusIcon />
                  <span className="min-w-0 flex-1 truncate">Create “{option.name}”</span>
                </>
              )}
            </ComboboxItem>
          )}
        </ComboboxList>
        {hasConfirmed ? (
          <ProjectContextToggle environmentId={environmentId} threadId={threadId} />
        ) : null}
        <div className="border-t border-border/70 p-1">
          <Button
            type="button"
            variant="ghost-muted"
            size="xs"
            onClick={() => {
              setOpen(false);
              void navigate({ to: "/settings/project-tags" });
            }}
          >
            <Settings2Icon />
            Manage projects
          </Button>
        </div>
      </ComboboxPopup>
    </Combobox>
  );
}
