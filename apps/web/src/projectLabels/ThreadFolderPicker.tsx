import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { CheckIcon, FolderIcon, FolderMinusIcon, PlusIcon, Settings2Icon } from "lucide-react";
import { useMemo, useState } from "react";

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
import { ProjectContextToggle } from "../context/ThreadContext";
import { useThreadShell } from "../state/entities";
import { serverEnvironment } from "../state/server";
import { openCreateProjectDialog } from "./CreateProjectDialogHost";
import {
  PROJECT_LABEL_COLORS,
  priorFiling,
  threadFolderState,
  threadForksIntoProjects,
} from "./projectLabels.logic";
import { ProjectFolderIcon } from "./ProjectFolderMark";
import { useMoveThreadToFolder } from "./useMoveThreadToFolder";
import { useProjectLabelDirectory } from "./useProjectLabels";

type FolderOption =
  | { readonly kind: "folder"; readonly key: string; readonly id: string; readonly name: string }
  | { readonly kind: "remove"; readonly key: "remove" }
  | { readonly kind: "create"; readonly key: "create"; readonly name: string };

function optionText(option: FolderOption): string {
  switch (option.kind) {
    case "folder":
      return option.name;
    case "remove":
      return "Remove from folder";
    case "create":
      return `New project ${option.name}`;
  }
}

/**
 * The thread's project folder, with a picker to move it to another folder,
 * take it out, or file it in a new one. A thread is in at most one folder.
 */
export function ThreadFolderPicker(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const { environmentId, threadId } = props;
  const navigate = useNavigate();
  const environmentIds = useMemo(() => [environmentId], [environmentId]);
  const directory = useProjectLabelDirectory(environmentIds);
  const thread = useThreadShell(
    useMemo(() => scopeThreadRef(environmentId, threadId), [environmentId, threadId]),
  );
  const canMove = useAtomValue(
    serverEnvironment.moveThreadProjectFolder.permissionAtom(environmentId),
  );
  const canCreate = useAtomValue(
    serverEnvironment.createProjectLabel.permissionAtom(environmentId),
  );
  const moveThread = useMoveThreadToFolder();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);

  const state = thread ? threadFolderState(thread, directory) : null;
  const current = state?.current ?? null;

  const options = useMemo((): FolderOption[] => {
    if (state === null) return [];
    const needle = query.trim().toLowerCase();
    const result: FolderOption[] = state.options
      .filter((entry) => needle === "" || entry.label.name.toLowerCase().includes(needle))
      .map((entry) => ({
        kind: "folder",
        key: entry.key,
        id: entry.label.id,
        name: entry.label.name,
      }));
    if (needle === "" && state.current !== null && state.removable) {
      result.push({ kind: "remove", key: "remove" });
    }
    if (
      needle !== "" &&
      canCreate &&
      !state.options.some((entry) => entry.label.name.toLowerCase() === needle)
    ) {
      result.push({ kind: "create", key: "create", name: query.trim() });
    }
    return result;
  }, [canCreate, query, state]);

  if (thread === null || state === null) return null;
  // Nothing to show and nothing the viewer could do.
  if (!canMove && current === null) return null;

  const previous = priorFiling(state);
  const choose = async (option: FolderOption) => {
    if (busy || !canMove) return;
    if (option.kind === "create") {
      setOpen(false);
      setQuery("");
      const color = PROJECT_LABEL_COLORS[state.options.length % PROJECT_LABEL_COLORS.length]?.value;
      openCreateProjectDialog({
        environmentId,
        initialName: option.name,
        ...(color ? { initialColor: color } : {}),
        // Filed into the new project, as picking an existing one would.
        onCreated: (id, name) => void moveThread({ thread, folder: { id, name }, previous }),
      });
      return;
    }
    setBusy(true);
    try {
      if (option.kind === "folder") {
        if (option.id === current?.label.id) return;
        const target = state.options.find((entry) => entry.key === option.key);
        if (!target) return;
        await moveThread({
          thread,
          folder: { id: target.label.id, name: target.label.name },
          previous,
        });
      } else {
        await moveThread({ thread, folder: null, previous });
      }
      setOpen(false);
      setQuery("");
    } finally {
      setBusy(false);
    }
  };

  // Chats re-home in place now; `forks` stays for the explicit fork action.
  const forks = threadForksIntoProjects(thread);
  const action = forks ? "Fork into project" : "Move to folder";
  const triggerLabel = current ? `In ${current.label.name}. ${action}` : action;

  return (
    <Combobox
      items={options}
      filteredItems={options}
      autoHighlight
      value={null}
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
      itemToStringLabel={optionText}
      isItemEqualToValue={(left, right) => left.key === right.key}
      onValueChange={(option) => {
        if (option) void choose(option);
      }}
    >
      <ComboboxTrigger
        render={<Button type="button" variant="ghost-muted" size="xs" aria-label={triggerLabel} />}
      >
        {current ? (
          <>
            <ProjectFolderIcon color={current.label.color} className="size-3.5" />
            <span className="min-w-0 truncate">{current.label.name}</span>
          </>
        ) : (
          `${action}…`
        )}
      </ComboboxTrigger>
      <ComboboxPopup align="start" className="w-64">
        <ComboboxSearchInput
          aria-label="Find a project"
          placeholder={canCreate ? "Find or create a project" : "Find a project"}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        {!canMove ? (
          <ComboboxStatus>You can see this thread's folder but not move it.</ComboboxStatus>
        ) : state.viaRepository && query === "" ? (
          <ComboboxStatus>In {current?.label.name} through its repository.</ComboboxStatus>
        ) : forks && query === "" ? (
          <ComboboxStatus>Opens a copy in the project. This chat stays put.</ComboboxStatus>
        ) : null}
        <ComboboxList>
          {(option: FolderOption) => (
            <ComboboxItem
              key={option.key}
              value={option}
              disabled={!canMove || busy || (option.kind === "create" && option.name.length > 200)}
            >
              {option.kind === "folder" ? (
                <>
                  <ProjectFolderIcon
                    color={state.options.find((entry) => entry.key === option.key)?.label.color}
                    className="size-4"
                  />
                  <span className="min-w-0 flex-1 truncate">{option.name}</span>
                  {option.id === current?.label.id ? <CheckIcon className="ml-auto" /> : null}
                </>
              ) : option.kind === "remove" ? (
                <>
                  <FolderMinusIcon />
                  <span className="min-w-0 flex-1 truncate">Remove from folder</span>
                </>
              ) : (
                <>
                  <PlusIcon />
                  <span className="min-w-0 flex-1 truncate">New project “{option.name}”…</span>
                </>
              )}
            </ComboboxItem>
          )}
        </ComboboxList>
        {current ? (
          <ProjectContextToggle environmentId={environmentId} threadId={threadId} />
        ) : null}
        <div className="flex border-t border-border/70 p-1">
          {current ? (
            <Button
              type="button"
              variant="ghost-muted"
              size="xs"
              onClick={() => {
                setOpen(false);
                void navigate({
                  to: "/project/$environmentId/$labelId",
                  params: { environmentId, labelId: current.label.id },
                });
              }}
            >
              <FolderIcon />
              Open {current.label.name}
            </Button>
          ) : (
            <Button
              type="button"
              variant="ghost-muted"
              size="xs"
              onClick={() => {
                setOpen(false);
                void navigate({ to: "/project" });
              }}
            >
              <Settings2Icon />
              Manage projects
            </Button>
          )}
        </div>
      </ComboboxPopup>
    </Combobox>
  );
}
