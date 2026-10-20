import type { ProjectLabelId, ProjectLabelWithRepositories } from "@t3tools/contracts";
import { CheckIcon, PlusIcon, Settings2Icon } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

import { Button } from "../components/ui/button";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxSearchInput,
  ComboboxTrigger,
} from "../components/ui/combobox";
import { sortProjectLabels } from "./projectLabels.logic";
import { ProjectColorDot, ProjectTag } from "./ProjectTag";

/**
 * Choose several projects from one environment's list. Unlike the thread tag picker
 * it holds no state of its own: the caller owns the selection (an agent's scope, a
 * new open item's projects) and saves it however that record saves.
 */
export function ProjectLabelPicker(props: {
  labels: ReadonlyArray<ProjectLabelWithRepositories>;
  selectedIds: ReadonlyArray<ProjectLabelId>;
  onToggle: (labelId: ProjectLabelId, selected: boolean) => void;
  disabled?: boolean;
  /** The trigger's content; defaults to "Add project". */
  children?: ReactNode;
  "aria-label"?: string;
  /** Opens Settings → Projects; omitted where there is no router. */
  onManage?: (() => void) | undefined;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const selected = new Set<string>(props.selectedIds);
  const options = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return sortProjectLabels(props.labels.map((label) => ({ label })))
      .map((entry) => entry.label)
      .filter((label) => needle === "" || label.name.toLowerCase().includes(needle));
  }, [props.labels, query]);
  return (
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
      itemToStringLabel={(label: ProjectLabelWithRepositories) => label.name}
      isItemEqualToValue={(left, right) => left.id === right.id}
      onValueChange={(label) => {
        if (label) props.onToggle(label.id, !selected.has(label.id));
      }}
    >
      <ComboboxTrigger
        disabled={props.disabled}
        aria-label={props["aria-label"] ?? "Add project"}
        render={<Button type="button" variant="ghost-muted" size="xs" />}
      >
        {props.children ?? (
          <>
            <PlusIcon />
            Add project
          </>
        )}
      </ComboboxTrigger>
      <ComboboxPopup align="start" className="w-64">
        <ComboboxSearchInput
          aria-label="Find a project"
          placeholder="Find a project"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <ComboboxEmpty>
          {props.labels.length === 0 ? "No projects yet." : "No matching project."}
        </ComboboxEmpty>
        <ComboboxList>
          {(label: ProjectLabelWithRepositories) => (
            <ComboboxItem key={label.id} value={label}>
              <ProjectColorDot color={label.color} />
              <span className="min-w-0 flex-1 truncate">{label.name}</span>
              {selected.has(label.id) ? <CheckIcon className="ml-auto" /> : null}
            </ComboboxItem>
          )}
        </ComboboxList>
        {props.onManage && (
          <div className="border-t border-border/70 p-1">
            <Button
              type="button"
              variant="ghost-muted"
              size="xs"
              onClick={() => {
                setOpen(false);
                props.onManage?.();
              }}
            >
              <Settings2Icon />
              Manage projects
            </Button>
          </div>
        )}
      </ComboboxPopup>
    </Combobox>
  );
}

/** Selected projects as tags, for forms that pair them with a picker. */
export function ProjectLabelChips(props: {
  labels: ReadonlyArray<ProjectLabelWithRepositories>;
  ids: ReadonlyArray<ProjectLabelId>;
}) {
  const byId = new Map(props.labels.map((label) => [label.id as string, label]));
  return (
    <>
      {props.ids.map((id) => {
        const label = byId.get(id);
        return label ? <ProjectTag key={id} name={label.name} color={label.color} /> : null;
      })}
    </>
  );
}
