import type { EnvironmentId, ProjectLabelId } from "@cogenly/contracts";
import { CheckIcon, FolderMinusIcon } from "lucide-react";
import { useMemo, useState, type ReactElement, type ReactNode } from "react";

import {
  Combobox,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxSearchInput,
  ComboboxTrigger,
} from "~/components/ui/combobox";
import type { EnvironmentProjectLabel } from "~/projectLabels/projectLabels.logic";
import { ProjectFolderIcon } from "~/projectLabels/ProjectFolderMark";
import { useProjectLabelDirectory } from "~/projectLabels/useProjectLabels";

type ProjectOption =
  | { readonly kind: "folder"; readonly key: string; readonly folder: EnvironmentProjectLabel }
  | { readonly kind: "none"; readonly key: "none" };

const optionText = (option: ProjectOption) =>
  option.kind === "folder" ? option.folder.label.name : "No project";

/**
 * An environment's active project folders by name, and the one `id` names if
 * it still exists (archived or not).
 */
export function useAgentProjectFolders(
  environmentId: EnvironmentId | null,
  id: ProjectLabelId | null,
) {
  const environmentIds = useMemo(
    () => (environmentId === null ? [] : [environmentId]),
    [environmentId],
  );
  const directory = useProjectLabelDirectory(environmentIds);
  const current =
    id === null ? null : (directory.labels.find((entry) => entry.label.id === id) ?? null);
  return { folders: directory.active, current };
}

/**
 * Pick the one project an agent is filed in, or No project. The caller owns
 * the value and saves it (a live agent moves at once; the builder's card keeps
 * it until the agent is created). `trigger` is the element that opens it.
 */
export function AgentProjectPicker(props: {
  readonly environmentId: EnvironmentId;
  readonly value: ProjectLabelId | null;
  readonly onChange: (projectFolderId: ProjectLabelId | null) => void;
  readonly trigger: ReactElement;
  /** The trigger's content, for a trigger that doesn't render its own. */
  readonly children?: ReactNode;
  readonly disabled?: boolean;
  readonly "aria-label"?: string;
}) {
  const { folders, current } = useAgentProjectFolders(props.environmentId, props.value);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const options = useMemo((): ProjectOption[] => {
    const needle = query.trim().toLowerCase();
    const matches: ProjectOption[] = folders
      .filter((folder) => needle === "" || folder.label.name.toLowerCase().includes(needle))
      .map((folder) => ({ kind: "folder", key: folder.key, folder }));
    if (needle === "" || "no project".includes(needle)) matches.push({ kind: "none", key: "none" });
    return matches;
  }, [folders, query]);
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
        if (!option) return;
        const next = option.kind === "folder" ? option.folder.label.id : null;
        setOpen(false);
        setQuery("");
        if (next !== (current?.label.id ?? null)) props.onChange(next);
      }}
    >
      <ComboboxTrigger
        disabled={props.disabled}
        aria-label={props["aria-label"] ?? (current ? `Project: ${current.label.name}` : "Project")}
        render={props.trigger}
      >
        {props.children}
      </ComboboxTrigger>
      <ComboboxPopup align="start" className="w-64">
        <ComboboxSearchInput
          aria-label="Find a project"
          placeholder="Find a project"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <ComboboxEmpty>No matching project.</ComboboxEmpty>
        <ComboboxList>
          {(option: ProjectOption) => (
            <ComboboxItem key={option.key} value={option}>
              {option.kind === "folder" ? (
                <>
                  <ProjectFolderIcon project={option.folder} className="size-4" />
                  <span className="min-w-0 flex-1 truncate">{option.folder.label.name}</span>
                  {option.folder.key === current?.key ? <CheckIcon className="ml-auto" /> : null}
                </>
              ) : (
                <>
                  <FolderMinusIcon />
                  <span className="min-w-0 flex-1 truncate">No project</span>
                  {current === null ? <CheckIcon className="ml-auto" /> : null}
                </>
              )}
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxPopup>
    </Combobox>
  );
}
