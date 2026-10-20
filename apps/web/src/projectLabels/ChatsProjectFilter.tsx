import { TagIcon } from "lucide-react";

import { SidebarHeaderIconButton } from "../components/sidebar/SidebarThreadHeader";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "../components/ui/menu";
import type { EnvironmentProjectLabel, ProjectLabelKey } from "./projectLabels.logic";
import { ProjectColorDot } from "./ProjectTag";

const ALL = "all";

/**
 * Chats stay one flat recent list; this narrows it to chats tagged with one
 * project. Hidden until a project exists.
 */
export function ChatsProjectFilter(props: {
  readonly labels: ReadonlyArray<EnvironmentProjectLabel>;
  readonly value: ProjectLabelKey | null;
  readonly onChange: (value: ProjectLabelKey | null) => void;
  /** Disambiguates same-named projects when more than one environment is connected. */
  readonly environmentLabel: (entry: EnvironmentProjectLabel) => string | null;
}) {
  if (props.labels.length === 0) return null;
  const active = props.labels.find((entry) => entry.key === props.value) ?? null;
  return (
    <Menu>
      <MenuTrigger
        render={
          <SidebarHeaderIconButton
            label={active ? `Showing chats in ${active.label.name}` : "Filter chats by project"}
          />
        }
      >
        {active ? <ProjectColorDot color={active.label.color} className="size-2.5" /> : <TagIcon />}
      </MenuTrigger>
      <MenuPopup align="end" className="w-56">
        <MenuGroup>
          <MenuGroupLabel>Show chats in</MenuGroupLabel>
          <MenuRadioGroup
            value={props.value ?? ALL}
            onValueChange={(value) =>
              props.onChange(value === ALL ? null : (value as ProjectLabelKey))
            }
          >
            <MenuRadioItem value={ALL} closeOnClick>
              All projects
            </MenuRadioItem>
            {props.labels.map((entry) => {
              const environment = props.environmentLabel(entry);
              return (
                <MenuRadioItem key={entry.key} value={entry.key} closeOnClick>
                  <ProjectColorDot color={entry.label.color} />
                  <span className="min-w-0 flex-1 truncate">{entry.label.name}</span>
                  {environment ? (
                    <span className="text-2xs text-muted-foreground">{environment}</span>
                  ) : null}
                </MenuRadioItem>
              );
            })}
          </MenuRadioGroup>
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}
