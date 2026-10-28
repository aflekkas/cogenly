import type { EnvironmentId, ProjectLabelId } from "@cogenly/contracts";
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
import { ProjectPickerRow } from "~/projectLabels/ProjectPickerRow";
import { orderProjectsByUse, rankProjectMatches } from "~/projectLabels/projectOrder.logic";
import { useProjectLabelDirectory } from "~/projectLabels/useProjectLabels";
import { useProjectLastUsedAt } from "~/projectLabels/useProjectLastUsed";

type ProjectOption = (
  | { readonly kind: "folder"; readonly key: string; readonly folder: EnvironmentProjectLabel }
  | { readonly kind: "none"; readonly key: "none" }
) & {
  /** A hairline above the row, where a new group starts. */
  readonly divider: boolean;
};

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
  const lastUsedAt = useProjectLastUsedAt();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const options = useMemo((): ProjectOption[] => {
    // Recently used projects first, then by name, as the composer's picker
    // lists them; "No project" sits apart at the end.
    const searching = query.trim() !== "";
    const { recent, rest } = orderProjectsByUse(folders, lastUsedAt);
    const folderOption = (folder: EnvironmentProjectLabel, divider = false): ProjectOption => ({
      kind: "folder",
      key: folder.key,
      folder,
      divider,
    });
    const matches = searching
      ? rankProjectMatches([...recent, ...rest], query).map((folder) => folderOption(folder))
      : [
          ...recent.map((folder) => folderOption(folder)),
          ...rest.map((folder, index) => folderOption(folder, index === 0 && recent.length > 0)),
        ];
    if (!searching || rankProjectMatches([{ label: { name: "No project" } }], query).length > 0) {
      matches.push({ kind: "none", key: "none", divider: matches.length > 0 });
    }
    return matches;
  }, [folders, lastUsedAt, query]);
  const chosenOption = useMemo(
    (): ProjectOption =>
      current === null
        ? { kind: "none", key: "none", divider: false }
        : { kind: "folder", key: current.key, folder: current, divider: false },
    [current],
  );
  return (
    <Combobox
      items={options}
      filteredItems={options}
      autoHighlight
      // The current pick, so the list opens with it highlighted.
      value={chosenOption}
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
            <ComboboxItem key={option.key} value={option} hideIndicator divider={option.divider}>
              {option.kind === "folder" ? (
                <ProjectPickerRow
                  project={option.folder}
                  label={option.folder.label.name}
                  chosen={option.folder.key === current?.key}
                />
              ) : (
                <ProjectPickerRow project={null} label="No project" chosen={current === null} />
              )}
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxPopup>
    </Combobox>
  );
}
