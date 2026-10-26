import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ProjectLabelId, ThreadId } from "@cogenly/contracts";
import { FolderIcon, PlusIcon } from "lucide-react";
import { useMemo, useState } from "react";

import {
  ComposerControl,
  ComposerControlChevron,
  ComposerControlIcon,
  composerControlGapClassName,
  type ComposerControlSize,
} from "../components/chat/ComposerControl";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxSearchInput,
  ComboboxTrigger,
} from "../components/ui/combobox";
import { InlineButton } from "../components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import type { DraftId } from "../composerDraftStore";
import { cn } from "../lib/utils";
import { serverEnvironment } from "../state/server";
import { openCreateProjectDialog } from "./CreateProjectDialogHost";
import { setPendingProjectFolder } from "./pendingProjectFolders";
import {
  PROJECT_LABEL_COLORS,
  isProjectChatThread,
  priorFiling,
  projectLabelsOn,
  type EnvironmentProjectLabel,
  threadFolderState,
  threadForksIntoProjects,
  threadProjectFolderId,
} from "./projectLabels.logic";
import { HeroProjectSuffixText } from "./HeroProjectSuffix";
import { HERO_INLINE_ICON_STYLE, ProjectFolderIcon } from "./ProjectFolderMark";
import { ProjectPickerRow } from "./ProjectPickerRow";
import { useComposerProjectFolder } from "./useComposerProjectFolder";
import { useMoveThreadToFolder } from "./useMoveThreadToFolder";
import { pickNoProjectForWork } from "./workNoProjectPicks";
import { WorkHeroCrumbText } from "../components/chat/WorkHeroSentence";

type ProjectOption =
  | {
      readonly kind: "project";
      readonly key: string;
      readonly id: ProjectLabelId;
      readonly name: string;
      readonly project: EnvironmentProjectLabel;
    }
  /** "No project" while in none; "Remove from project", the way out, while in one. */
  | { readonly kind: "none"; readonly key: "none"; readonly label: string }
  | { readonly kind: "new"; readonly key: "new" }
  | { readonly kind: "create"; readonly key: "create"; readonly name: string };

/**
 * The composer's project chip, inside a collapsible `ComposerControl`: the project's
 * mark and name, or No project. Every composer with a project picker draws this, so
 * a narrow composer collapses each to its icon alike.
 */
export function ComposerProjectChip({
  project,
  size = "sm",
}: {
  project: EnvironmentProjectLabel | null;
  size?: ComposerControlSize | undefined;
}) {
  return (
    <>
      {/* A picked project fades in where the last one was. */}
      <span
        key={project?.key ?? "none"}
        className={cn("swap-motion flex min-w-0 items-center", composerControlGapClassName(size))}
      >
        {project ? (
          <ProjectFolderIcon project={project} className={size === "xs" ? "size-3" : "size-4"} />
        ) : (
          <ComposerControlIcon icon={FolderIcon} size={size} />
        )}
        <span
          data-composer-control-label
          className={cn("max-w-40 truncate", project === null && "text-muted-foreground")}
        >
          <span>{project ? project.label.name : "No project"}</span>
        </span>
      </span>
      <ComposerControlChevron size={size} />
    </>
  );
}

function optionText(option: ProjectOption): string {
  switch (option.kind) {
    case "project":
      return option.name;
    case "none":
      return option.label;
    case "new":
      return "New project";
    case "create":
      return `New project ${option.name}`;
  }
}

/** Share picker eligibility with the toolbar so absent controls take no layout space. */
export function useComposerProjectPickerState(
  environmentId: EnvironmentId,
  threadId: ThreadId | null,
  draftId: DraftId | null,
) {
  const { directory, thread, draftSurface, isWorkDraft, current } = useComposerProjectFolder({
    environmentId,
    threadId,
    draftId,
  });
  const canMove = useAtomValue(
    serverEnvironment.moveThreadProjectFolder.permissionAtom(environmentId),
  );
  // Chats, and Work drafts: existing Work follows its repository (moved from
  // its row's menu), and an agent's conversation belongs to the agent.
  const surface = thread ? thread.source.surface : draftSurface;
  // A project's own conversation is that project's for good, so it has no
  // picker: the page it lives on already names the project.
  const isChat =
    surface !== "work" &&
    surface !== "builder" &&
    thread?.source.agent === undefined &&
    !(thread !== null && isProjectChatThread(thread, directory.labels));

  return {
    directory,
    thread,
    draftSurface,
    current,
    isWorkDraft,
    canPickProject: canMove && (isChat || isWorkDraft),
  };
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
   * `headline` is the project half of the Work hero's "What should we build
   * in <project> / <repo>?", reading "No project" without one.
   */
  readonly appearance?: "toolbar" | "hero" | "headline";
}) {
  const { environmentId, threadId } = props;
  const { directory, thread, isWorkDraft, current, canPickProject } = useComposerProjectPickerState(
    environmentId,
    threadId,
    props.draftId,
  );
  const canCreate = useAtomValue(
    serverEnvironment.createProjectLabel.permissionAtom(environmentId),
  );
  const moveThread = useMoveThreadToFolder();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);

  const projects = useMemo(
    // Archived projects are not offered; one the thread is already in still
    // names itself as `current`.
    () => projectLabelsOn(directory.active, environmentId),
    [directory.active, environmentId],
  );
  const options = useMemo((): ProjectOption[] => {
    // "No project" is a choice like any project, so it leads the list;
    // creating one is the lone action at the end. For Work it moves the draft
    // to a repository in no project (DraftHeroHeadline).
    const needle = query.trim().toLowerCase();
    const result: ProjectOption[] =
      needle === ""
        ? [
            {
              kind: "none",
              key: "none",
              label: current === null ? "No project" : "Remove from project",
            },
          ]
        : [];
    for (const entry of projects) {
      if (needle !== "" && !entry.label.name.toLowerCase().includes(needle)) continue;
      result.push({
        kind: "project",
        key: entry.key,
        id: entry.label.id,
        name: entry.label.name,
        project: entry,
      });
    }
    if (canCreate) {
      if (needle === "") result.push({ kind: "new", key: "new" });
      else if (!projects.some((entry) => entry.label.name.toLowerCase() === needle)) {
        result.push({ kind: "create", key: "create", name: query.trim() });
      }
    }
    return result;
  }, [canCreate, current, projects, query]);

  const isHeadline = props.appearance === "headline";
  const headlineIcon = (
    <ProjectFolderIcon project={current} className="inline-block" style={HERO_INLINE_ICON_STYLE} />
  );
  if (!canPickProject) {
    // The Work hero still names its project when it cannot be changed here.
    return isHeadline ? (
      <WorkHeroCrumbText
        crumb={
          current
            ? { text: current.label.name, placeholder: false }
            : { text: "No project", placeholder: true }
        }
        icon={headlineIcon}
      />
    ) : null;
  }
  // Chats re-home into another project in place; forks are explicit only.
  const forks = thread !== null && threadForksIntoProjects(thread);

  const assign = async (folder: { id: ProjectLabelId; name: string } | null) => {
    if (thread === null) {
      // The hero answers it with a repository in no project; nothing to file.
      if (folder === null && isWorkDraft && current !== null) pickNoProjectForWork(threadId);
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
    // An explicit fork may wait for a running turn; its toast reports it,
    // so the picker closes now rather than staying open for the whole turn.
    if (folder !== null && threadForksIntoProjects(thread)) return;
    await moved;
  };

  const choose = async (option: ProjectOption) => {
    if (busy) return;
    if (option.kind === "new" || option.kind === "create") {
      setOpen(false);
      setQuery("");
      const color = PROJECT_LABEL_COLORS[projects.length % PROJECT_LABEL_COLORS.length]?.value;
      openCreateProjectDialog({
        environmentId,
        ...(option.kind === "create" ? { initialName: option.name } : {}),
        ...(color ? { initialColor: color } : {}),
        // The new project is picked here, as choosing an existing one would.
        onCreated: (id, name) => void assign({ id, name }),
      });
      return;
    }
    setBusy(true);
    try {
      await assign(option.kind === "project" ? { id: option.id, name: option.name } : null);
      setOpen(false);
      setQuery("");
    } finally {
      setBusy(false);
    }
  };

  const triggerLabel = current ? `Project: ${current.label.name}` : "No project";
  const isHero = props.appearance === "hero";
  const inSentence = isHero || isHeadline;
  const isChosen = (option: ProjectOption) =>
    option.kind === "project"
      ? option.id === current?.label.id
      : option.kind === "none" && current === null;

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
        if (!next) setQuery("");
      }}
      itemToStringLabel={optionText}
      isItemEqualToValue={(left, right) => left.key === right.key}
      onValueChange={(option) => {
        if (option) void choose(option);
      }}
    >
      {isHeadline ? (
        // Named mid-sentence: the visible project name is the accessible name.
        // It shrinks (truncating) before the breadcrumb outgrows its line.
        <ComboboxTrigger
          disabled={props.disabled}
          data-hero-project-picker=""
          render={
            <InlineButton
              tone="picker"
              weight="normal"
              className="pointer-events-auto min-w-0 max-w-64 shrink align-baseline"
            />
          }
        >
          <span className={cn("block truncate", current === null && "text-muted-foreground")}>
            {current ? headlineIcon : null}
            {current?.label.name ?? "No project"}
          </span>
        </ComboboxTrigger>
      ) : isHero ? (
        // The headline owns the fade; the suffix only renders its reserved name slot.
        <ComboboxTrigger
          disabled={props.disabled}
          aria-label={current ? `In ${current.label.name}. Move to project` : undefined}
          aria-hidden={current === null || undefined}
          tabIndex={current === null ? -1 : undefined}
          data-hero-project-suffix=""
          render={
            <button
              type="button"
              className={cn(
                "group/hero-suffix pointer-events-auto inline-block max-w-full cursor-pointer rounded-sm align-baseline text-foreground outline-none focus-visible:outline-2 focus-visible:outline-ring",
                current === null && "pointer-events-none",
              )}
            />
          }
        >
          <HeroProjectSuffixText
            name={current?.label.name ?? null}
            project={current ?? null}
            open={open}
          />
        </ComboboxTrigger>
      ) : (
        <Tooltip>
          <TooltipTrigger
            render={
              <ComboboxTrigger
                disabled={props.disabled}
                aria-label={triggerLabel}
                data-composer-project-picker=""
                render={<ComposerControl size={props.size} collapsible />}
              />
            }
          >
            <ComposerProjectChip project={current} size={props.size} />
          </TooltipTrigger>
          <TooltipPopup side="top">
            {forks ? "Fork into project…" : "Move to project…"}
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
          aria-label="Find a project"
          placeholder={canCreate ? "Find or create a project" : "Find a project"}
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
              <ProjectOptionRow option={option} chosen={isChosen(option)} />
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxPopup>
    </Combobox>
  );
  return picker;
}

function ProjectOptionRow(props: { readonly option: ProjectOption; readonly chosen: boolean }) {
  const { option, chosen } = props;
  switch (option.kind) {
    case "project":
      return <ProjectPickerRow project={option.project} label={option.name} chosen={chosen} />;
    case "none":
      return <ProjectPickerRow project={null} label={option.label} chosen={chosen} />;
    case "new":
      return <ProjectPickerRow icon={<PlusIcon />} label="New project…" />;
    case "create":
      return <ProjectPickerRow icon={<PlusIcon />} label={`New project “${option.name}”…`} />;
  }
}
