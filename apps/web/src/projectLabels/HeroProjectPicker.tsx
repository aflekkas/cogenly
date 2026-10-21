import { CheckIcon } from "lucide-react";
import { useMemo, useState, type CSSProperties } from "react";

import { InlineButton } from "../components/ui/button";
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
import type { EnvironmentProjectLabel } from "./projectLabels.logic";
import { ProjectFolderIcon } from "./ProjectFolderMark";

// Sized to the capitals of the hero sentence and resting on its baseline.
export const HERO_INLINE_ICON_STYLE: CSSProperties = {
  width: "0.78em",
  height: "0.78em",
  verticalAlign: "-0.06em",
  marginInlineEnd: "0.28em",
};

/**
 * The project part of the Work hero ("What should we build in [Spawn
 * Partners] / platform?"): the project's folder in its color and its name,
 * opening a list of projects. Choosing one hands it to the hero, which
 * narrows the repository picker to it.
 */
export function HeroProjectPicker(props: {
  readonly projects: ReadonlyArray<EnvironmentProjectLabel>;
  readonly current: EnvironmentProjectLabel;
  readonly onChoose: (project: EnvironmentProjectLabel) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const options = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return props.projects.filter(
      (entry) => needle === "" || entry.label.name.toLowerCase().includes(needle),
    );
  }, [props.projects, query]);
  return (
    <Combobox
      items={options}
      filteredItems={options}
      autoHighlight
      value={props.current}
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
      itemToStringLabel={(entry: EnvironmentProjectLabel) => entry.label.name}
      isItemEqualToValue={(left, right) => left.key === right.key}
      onValueChange={(entry) => {
        setOpen(false);
        if (entry) props.onChoose(entry);
      }}
    >
      <ComboboxTrigger
        render={<InlineButton tone="picker" />}
        className="pointer-events-auto max-w-64 align-baseline"
      >
        <span className="block truncate">
          <ProjectFolderIcon
            color={props.current.label.color}
            className="inline-block"
            style={HERO_INLINE_ICON_STYLE}
          />
          {props.current.label.name}
        </span>
      </ComboboxTrigger>
      <ComboboxPopup align="center" sideOffset={8} className="w-64">
        <ComboboxSearchInput
          aria-label="Find a project"
          placeholder="Find a project"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <ComboboxEmpty>No matching project.</ComboboxEmpty>
        <ComboboxList>
          {(entry: EnvironmentProjectLabel) => (
            <ComboboxItem key={entry.key} value={entry} hideIndicator>
              <ComboboxItemIcon>
                <ProjectFolderIcon color={entry.label.color} className="size-4" />
              </ComboboxItemIcon>
              <span className="min-w-0 flex-1 truncate text-sm">{entry.label.name}</span>
              {entry.key === props.current.key ? <CheckIcon className="ml-auto" /> : null}
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxPopup>
    </Combobox>
  );
}
