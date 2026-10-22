import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ProjectLabelId, ThreadId } from "@t3tools/contracts";
import { CheckIcon, FolderIcon, FolderMinusIcon, PlusIcon } from "lucide-react";
import { Fragment, useMemo, useRef, useState, type ReactNode } from "react";

import {
  ComposerControl,
  ComposerControlIcon,
  type ComposerControlSize,
} from "../components/chat/ComposerControl";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxItemIcon,
  ComboboxList,
  ComboboxPopup,
  ComboboxSearchInput,
  ComboboxTrigger,
} from "../components/ui/combobox";
import { InlineButton } from "../components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { type DraftId, useComposerDraftStore } from "../composerDraftStore";
import { cn } from "../lib/utils";
import { useThreadShell } from "../state/entities";
import { serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";
import { setPendingProjectFolder, usePendingProjectFolderStore } from "./pendingProjectFolders";
import {
  PROJECT_LABEL_COLORS,
  priorFiling,
  projectLabelKey,
  scopedRepositoryKey,
  threadFolderState,
  threadForksIntoProjects,
  threadProjectFolderId,
} from "./projectLabels.logic";
import { composerProjectFolderId } from "./projectMeta.logic";
import { HeroProjectSuffixText } from "./HeroProjectSuffix";
import { HERO_INLINE_ICON_STYLE, ProjectFolderIcon } from "./ProjectFolderMark";
import { reportProjectFolderFailure, useMoveThreadToFolder } from "./useMoveThreadToFolder";
import { useProjectLabelDirectory } from "./useProjectLabels";

type ProjectOption =
  | {
      readonly kind: "project";
      readonly key: string;
      readonly id: ProjectLabelId;
      readonly name: string;
      readonly color: string | undefined;
    }
  | { readonly kind: "none"; readonly key: "none" }
  | { readonly kind: "new"; readonly key: "new" }
  | { readonly kind: "create"; readonly key: "create"; readonly name: string };

function optionText(option: ProjectOption): string {
  switch (option.kind) {
    case "project":
      return option.name;
    case "none":
      return "No project";
    case "new":
      return "New project";
    case "create":
      return `Create ${option.name}`;
  }
}

/**
 * The composer toolbar's project control: which project this chat belongs to.
 * A draft keeps its pick until it is sent (PendingProjectFolderCoordinator
 * files the new thread); an existing chat moves right away, with Undo.
 *
 * A Work draft can be given a project too. Until one is picked it shows its
 * repository's project, which Work follows; the Work hero answers a pick by
 * moving the draft to one of the project's repositories.
 */
export function ComposerProjectPicker(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  /** Set on the new-chat screen, where the draft says whether this is a chat. */
  readonly draftId: DraftId | null;
  readonly size: ComposerControlSize;
  readonly disabled?: boolean;
  /**
   * `hero` is the new-chat greeting's " · in <project>" tail: the same picker,
   * opened from the project's name, and nothing to click without a project.
   * `headline` is the Work hero's "What should we build in <project>?".
   * `subline` is the quiet "in a project…" under the Work hero's heading, for
   * Work without a project yet.
   */
  readonly appearance?: "toolbar" | "hero" | "headline" | "subline";
  /**
   * `subline` only: what follows the picker on its line, after a middle dot.
   * Shown alone when no project can be picked here.
   */
  readonly trailing?: ReactNode;
}) {
  const { environmentId, threadId } = props;
  const environmentIds = useMemo(() => [environmentId], [environmentId]);
  const directory = useProjectLabelDirectory(environmentIds);
  const thread = useThreadShell(
    useMemo(() => scopeThreadRef(environmentId, threadId), [environmentId, threadId]),
  );
  const pending = usePendingProjectFolderStore((state) => {
    const entry = state.byThreadId[threadId];
    return entry?.environmentId === environmentId ? entry : null;
  });
  const canMove = useAtomValue(
    serverEnvironment.moveThreadProjectFolder.permissionAtom(environmentId),
  );
  const canCreate = useAtomValue(
    serverEnvironment.createProjectLabel.permissionAtom(environmentId),
  );
  const moveThread = useMoveThreadToFolder();
  const createLabel = useAtomCommand(serverEnvironment.createProjectLabel, {
    label: "create project",
    reportFailure: false,
  });
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  // "New project…" keeps the popup open and turns the search into a name field.
  const [naming, setNaming] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  const projects = useMemo(
    () => directory.labels.filter((entry) => entry.environmentId === environmentId),
    [directory.labels, environmentId],
  );
  const draft = useComposerDraftStore((store) =>
    props.draftId === null ? undefined : store.draftThreadsByThreadKey[props.draftId],
  );
  const draftSurface = draft?.surface;
  const isWorkDraft = thread === null && draftSurface === "work";
  // The project a Work draft's repository is in, which it follows unless another is picked.
  const repositoryFolder =
    isWorkDraft && draft
      ? (directory.folderByRepository.get(scopedRepositoryKey(environmentId, draft.projectId)) ??
        null)
      : null;
  const currentId =
    composerProjectFolderId({
      pendingFolderId: pending?.folderId ?? null,
      threadFolderId: thread ? threadProjectFolderId(thread) : null,
    }) ??
    repositoryFolder?.label.id ??
    null;
  const current =
    currentId === null
      ? null
      : (directory.byKey.get(projectLabelKey(environmentId, currentId)) ?? null);

  const options = useMemo((): ProjectOption[] => {
    // "No project" is a choice like any project, so it leads the list;
    // creating one is the lone action at the end.
    const needle = query.trim().toLowerCase();
    // Work in a repository's project cannot leave it, only go to another.
    const result: ProjectOption[] =
      needle === "" && repositoryFolder === null ? [{ kind: "none", key: "none" }] : [];
    for (const entry of projects) {
      if (needle !== "" && !entry.label.name.toLowerCase().includes(needle)) continue;
      result.push({
        kind: "project",
        key: entry.key,
        id: entry.label.id,
        name: entry.label.name,
        color: entry.label.color,
      });
    }
    if (canCreate) {
      if (needle === "") result.push({ kind: "new", key: "new" });
      else if (!projects.some((entry) => entry.label.name.toLowerCase() === needle)) {
        result.push({ kind: "create", key: "create", name: query.trim() });
      }
    }
    return result;
  }, [canCreate, projects, query, repositoryFolder]);

  // Chats, and Work drafts: existing Work follows its repository (moved from
  // its row's menu), and an agent's conversation belongs to the agent.
  const surface = thread ? thread.source.surface : draftSurface;
  const isChat = surface !== "work" && surface !== "builder" && thread?.source.agent === undefined;

  const isHeadline = props.appearance === "headline";
  const isSubline = props.appearance === "subline";
  if (isSubline && (!canMove || !isWorkDraft || (projects.length === 0 && !canCreate))) {
    return props.trailing ?? null;
  }
  if (!canMove || !(isChat || isWorkDraft)) {
    // The Work hero still names its project when it cannot be changed here.
    return isHeadline && current ? (
      <span className="inline-block max-w-64 truncate align-baseline">
        <ProjectFolderIcon
          color={current.label.color}
          className="inline-block"
          style={HERO_INLINE_ICON_STYLE}
        />
        {current.label.name}
      </span>
    ) : null;
  }
  // A chat with turns goes into another project as a fork; the picker says so.
  const forks = thread !== null && threadForksIntoProjects(thread);

  const assign = async (folder: { id: ProjectLabelId; name: string } | null) => {
    if (thread === null) {
      setPendingProjectFolder(
        threadId,
        folder
          ? { environmentId, folderId: folder.id, ...(isWorkDraft ? { chosen: true } : {}) }
          : null,
      );
      return;
    }
    setPendingProjectFolder(threadId, null);
    if ((folder?.id ?? null) === threadProjectFolderId(thread)) return;
    const moved = moveThread({
      thread,
      folder,
      previous: priorFiling(threadFolderState(thread, directory)),
    });
    // A fork may wait for a running turn; its toast reports it, so the
    // picker closes now rather than staying open for the whole turn.
    if (folder !== null && threadForksIntoProjects(thread)) return;
    await moved;
  };

  const choose = async (option: ProjectOption) => {
    if (busy) return;
    if (option.kind === "new") {
      setNaming(true);
      searchRef.current?.focus();
      return;
    }
    setBusy(true);
    try {
      if (option.kind === "project") {
        await assign({ id: option.id, name: option.name });
      } else if (option.kind === "none") {
        await assign(null);
      } else {
        const color = PROJECT_LABEL_COLORS[projects.length % PROJECT_LABEL_COLORS.length]?.value;
        const created = await createLabel({
          environmentId,
          input: { name: option.name, ...(color ? { color } : {}) },
        });
        if (created._tag === "Failure") {
          if (!isAtomCommandInterrupted(created)) {
            reportProjectFolderFailure("Could not create project", created);
          }
          return;
        }
        await assign({ id: created.value.label.id, name: created.value.label.name });
      }
      setOpen(false);
      setQuery("");
      setNaming(false);
    } finally {
      setBusy(false);
    }
  };

  const triggerLabel = current ? `Project: ${current.label.name}` : "No project";
  const isHero = props.appearance === "hero";
  const inSentence = isHero || isHeadline || isSubline;

  const picker = (
    <Combobox
      items={options}
      filteredItems={options}
      autoHighlight
      value={null}
      open={open}
      onOpenChange={(next, details) => {
        if (!next && details.reason === "item-press") return;
        setOpen(next);
        if (!next) {
          setQuery("");
          setNaming(false);
        }
      }}
      itemToStringLabel={optionText}
      isItemEqualToValue={(left, right) => left.key === right.key}
      onValueChange={(option) => {
        if (option) void choose(option);
      }}
    >
      {isSubline ? (
        // Its visible text names it, as the line's other choices are named.
        <ComboboxTrigger
          disabled={props.disabled}
          data-hero-project-subline=""
          render={<InlineButton tone="muted" />}
          className="pointer-events-auto"
        >
          in a project…
        </ComboboxTrigger>
      ) : isHeadline ? (
        // Named mid-sentence: the visible project name is the accessible name.
        <ComboboxTrigger
          disabled={props.disabled}
          data-hero-project-picker=""
          render={<InlineButton tone="picker" />}
          className="pointer-events-auto max-w-64 align-baseline"
        >
          <span className="block truncate">
            <ProjectFolderIcon
              color={current?.label.color}
              className="inline-block"
              style={HERO_INLINE_ICON_STYLE}
            />
            {current?.label.name ?? "a project"}
          </span>
        </ComboboxTrigger>
      ) : isHero ? (
        // Stays mounted without a project, empty and out of reach, so the
        // name can fade out and the greeting glide back to centre. On its own
        // line under a stacked heading, it is a size smaller.
        <ComboboxTrigger
          disabled={props.disabled}
          aria-label={current ? `In ${current.label.name}. Change project` : undefined}
          aria-hidden={current === null || undefined}
          tabIndex={current === null ? -1 : undefined}
          data-hero-project-suffix=""
          render={
            <button
              type="button"
              className={cn(
                "group/hero-suffix pointer-events-auto inline-block cursor-pointer rounded-sm align-baseline text-muted-foreground/60 group-data-stacked/hero-headline:text-base outline-none transition-colors duration-(--motion-duration-fast) hover:text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring data-popup-open:text-muted-foreground",
                current === null && "pointer-events-none",
              )}
            />
          }
        >
          <HeroProjectSuffixText name={current?.label.name ?? null} />
        </ComboboxTrigger>
      ) : (
        <Tooltip>
          <TooltipTrigger
            render={
              <ComboboxTrigger
                disabled={props.disabled}
                aria-label={triggerLabel}
                data-composer-project-picker=""
                render={<ComposerControl size={props.size} className="min-w-0" />}
              />
            }
          >
            {current ? (
              <ProjectFolderIcon
                color={current.label.color}
                className={props.size === "xs" ? "size-3" : "size-4"}
              />
            ) : (
              <ComposerControlIcon icon={FolderIcon} size={props.size} />
            )}
            <span
              data-composer-control-label
              className={cn("max-w-40 truncate", current === null && "text-muted-foreground")}
            >
              {current ? current.label.name : "No project"}
            </span>
          </TooltipTrigger>
          <TooltipPopup side="top">
            {forks ? "Fork into a project" : current ? "Change project" : "Add to a project"}
          </TooltipPopup>
        </Tooltip>
      )}
      <ComboboxPopup
        align={inSentence ? "center" : "start"}
        // Under the hero sentence, clear of its underline, as the Work hero's pickers sit.
        {...(inSentence ? { sideOffset: 8 } : {})}
        className="w-64"
      >
        <ComboboxSearchInput
          ref={searchRef}
          aria-label={naming ? "New project name" : "Find a project"}
          placeholder={
            naming
              ? "Name the new project"
              : canCreate
                ? "Find or create a project"
                : "Find a project"
          }
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <ComboboxEmpty>
          {projects.length === 0 ? "No projects yet." : "No matching project."}
        </ComboboxEmpty>
        <ComboboxList>
          {(option: ProjectOption) => (
            <ComboboxItem
              key={option.key}
              value={option}
              hideIndicator
              tone={option.kind === "new" || option.kind === "create" ? "action" : "default"}
              // One hairline sets the create action apart from the choices.
              divider={(option.kind === "new" || option.kind === "create") && options.length > 1}
              disabled={busy || (option.kind === "create" && option.name.length > 200)}
            >
              {option.kind === "project" ? (
                <>
                  <ComboboxItemIcon>
                    <ProjectFolderIcon color={option.color} className="size-4" />
                  </ComboboxItemIcon>
                  <span className="min-w-0 flex-1 truncate">{option.name}</span>
                  {option.id === current?.label.id ? <CheckIcon className="ml-auto" /> : null}
                </>
              ) : option.kind === "new" ? (
                <>
                  <ComboboxItemIcon>
                    <PlusIcon />
                  </ComboboxItemIcon>
                  <span className="min-w-0 flex-1 truncate">New project…</span>
                </>
              ) : option.kind === "none" ? (
                <>
                  <ComboboxItemIcon>
                    <FolderMinusIcon className="text-muted-foreground" />
                  </ComboboxItemIcon>
                  <span className="min-w-0 flex-1 truncate">No project</span>
                  {current === null ? <CheckIcon className="ml-auto" /> : null}
                </>
              ) : (
                <>
                  <ComboboxItemIcon>
                    <PlusIcon />
                  </ComboboxItemIcon>
                  <span className="min-w-0 flex-1 truncate">Create “{option.name}”</span>
                </>
              )}
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxPopup>
    </Combobox>
  );
  return isSubline && props.trailing ? (
    <Fragment>
      {picker} · {props.trailing}
    </Fragment>
  ) : (
    picker
  );
}
