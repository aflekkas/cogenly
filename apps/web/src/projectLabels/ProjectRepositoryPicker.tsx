import { PlusIcon } from "lucide-react";
import { useRef, useState } from "react";

import { Button } from "../components/ui/button";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxList,
  ComboboxPopup,
  ComboboxSearchInput,
  ComboboxTrigger,
} from "../components/ui/combobox";
import type { EnvironmentProjectLabel } from "./projectLabels.logic";
import {
  RepositoryPickerGroupContent,
  useRepositoryPicker,
  type RepositoryPickerGroup,
  type RepositoryPickerItem,
} from "./useRepositoryPicker";

/**
 * The project page's "Add repository": the same list the repository pickers
 * open from their last row, this machine's other repositories to link (one
 * in another project asks first) and the project's GitHub repositories to
 * clone, then the palette's folder or URL flow.
 */
export function ProjectRepositoryPicker(props: {
  readonly folder: EnvironmentProjectLabel;
  readonly disabled: boolean;
  /** The trigger's text; "Add repository" unless the surface already says what is added. */
  readonly triggerLabel?: string;
  /** Show only the "+", with the label as its accessible name (a card header's add). */
  readonly iconOnly?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const keepOpenRef = useRef(false);
  const close = () => {
    setOpen(false);
    setQuery("");
  };
  const picker = useRepositoryPicker({
    environmentId: props.folder.environmentId,
    project: props.folder,
    open,
    query,
    addOnly: true,
    // Linked or cloned, it is on the page now.
    onPick: close,
    onClose: close,
  });
  const label = props.triggerLabel ?? "Add repository";

  return (
    <Combobox
      items={picker.groups}
      filteredItems={picker.groups}
      autoHighlight
      value={null}
      open={open}
      onOpenChange={(next, details) => {
        // A GitHub clone and "Show more" keep the picker up.
        if (!next && details.reason === "item-press" && keepOpenRef.current) {
          keepOpenRef.current = false;
          return;
        }
        setOpen(next);
        if (!next) {
          setQuery("");
          picker.reset();
        }
      }}
      itemToStringLabel={(item: RepositoryPickerItem) => item.label}
      isItemEqualToValue={(left: RepositoryPickerItem, right: RepositoryPickerItem) =>
        left.value === right.value
      }
      onValueChange={(item: RepositoryPickerItem | null) => {
        if (item && picker.pick(item)) keepOpenRef.current = true;
      }}
    >
      <ComboboxTrigger
        disabled={props.disabled}
        aria-label={props.iconOnly ? label : undefined}
        title={props.iconOnly ? label : undefined}
        render={
          <Button type="button" size={props.iconOnly ? "icon-xs" : "xs"} variant="ghost-muted" />
        }
      >
        <PlusIcon />
        {props.iconOnly ? null : label}
      </ComboboxTrigger>
      <ComboboxPopup align="end" className="w-72" animateHeight>
        <ComboboxSearchInput
          aria-label="Find a repository"
          placeholder={picker.searchPlaceholder}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <ComboboxEmpty>{picker.emptyText}</ComboboxEmpty>
        <ComboboxList>
          {(group: RepositoryPickerGroup) => (
            <ComboboxGroup
              key={group.value}
              items={group.items}
              className={group.tight === true ? "not-first:mt-0" : undefined}
            >
              <RepositoryPickerGroupContent group={group} renderItem={picker.renderItem} />
            </ComboboxGroup>
          )}
        </ComboboxList>
      </ComboboxPopup>
    </Combobox>
  );
}
