import { formatProviderSkillDisplayName } from "@cogenly/shared/inlineSkills";
import {
  resolveProviderSkillSourceKind,
  type ProviderSkillSourceKind,
} from "@cogenly/client-runtime/providerSkills";
import type {
  ComposerMentionGroup,
  ComposerMentionItem,
} from "@cogenly/client-runtime/composerThreadItems";
import {
  type ProjectEntry,
  type ProviderDriverKind,
  type PullRequestContextMetadata,
  type ServerProviderSkill,
  type ServerProviderSlashCommand,
} from "@cogenly/contracts";
import {
  BlocksIcon,
  BotIcon,
  FileIcon,
  FolderIcon,
  HammerIcon,
  MessageCircleIcon,
  PackageIcon,
  SettingsIcon,
  UserRoundIcon,
  type LucideIcon,
} from "lucide-react";
import { memo, useLayoutEffect, useRef } from "react";

import { type ComposerSlashCommand, type ComposerTriggerKind } from "../../composer-logic";
import { useAnimatedPanelHeight } from "../ui/animated-panel-height";
import { Badge } from "../ui/badge";
import { Command, CommandGroup, CommandGroupLabel, CommandItem, CommandList } from "../ui/command";
import { PierreEntryIcon } from "./PierreEntryIcon";
import { ComposerBanner } from "./ComposerBanner";

export type ComposerCommandItem =
  | {
      id: string;
      type: "path";
      group: "files";
      path: string;
      pathKind: ProjectEntry["kind"];
      label: string;
      description: string;
    }
  | {
      id: string;
      type: "slash-command";
      command: ComposerSlashCommand;
      label: string;
      description: string;
    }
  | {
      id: string;
      type: "provider-slash-command";
      provider: ProviderDriverKind;
      command: ServerProviderSlashCommand;
      label: string;
      description: string;
    }
  | {
      id: string;
      type: "skill";
      provider: ProviderDriverKind;
      skill: ServerProviderSkill;
      label: string;
      description: string;
    }
  | {
      id: string;
      type: "pull-request";
      pullRequest: PullRequestContextMetadata;
      label: string;
      description: string;
    }
  | ComposerMentionItem;

type ComposerMenuGroup = ComposerMentionGroup | "files";

const MENU_GROUP_PRESENTATION: Record<ComposerMenuGroup, { label: string; icon: LucideIcon }> = {
  tasks: { label: "Tasks", icon: HammerIcon },
  chats: { label: "Chats", icon: MessageCircleIcon },
  agents: { label: "Agents", icon: BotIcon },
  projects: { label: "Projects", icon: FolderIcon },
  files: { label: "Files and folders", icon: FileIcon },
};

function menuGroupOf(item: ComposerCommandItem): ComposerMenuGroup | null {
  return "group" in item ? item.group : null;
}

/**
 * Consecutive items of one `@` section. Items arrive already in section order, which is also
 * keyboard order, so sections are runs, not a regrouping. Slash and skill menus stay one run.
 */
function menuSections(items: ReadonlyArray<ComposerCommandItem>) {
  const sections: { group: ComposerMenuGroup | null; items: ComposerCommandItem[] }[] = [];
  for (const item of items) {
    const group = menuGroupOf(item);
    const last = sections.at(-1);
    if (last && last.group === group) last.items.push(item);
    else sections.push({ group, items: [item] });
  }
  return sections;
}

export const ComposerCommandMenu = memo(function ComposerCommandMenu(props: {
  listId: string;
  items: ComposerCommandItem[];
  resolvedTheme: "light" | "dark";
  isLoading: boolean;
  triggerKind: ComposerTriggerKind | null;
  emptyStateText?: string;
  activeItemId: string | null;
  onHighlightedItemChange: (itemId: string | null) => void;
  onSelect: (item: ComposerCommandItem) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  // The drawer sits on the composer by its bottom edge, so a height change grows it upward.
  const panel = useAnimatedPanelHeight();
  const sections = menuSections(props.items);
  // Headings only once there is more than one kind of thing to tell apart.
  const showHeadings = sections.length > 1 || sections[0]?.group !== "files";

  useLayoutEffect(() => {
    if (!props.activeItemId || !listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>(
      `[data-composer-item-id="${CSS.escape(props.activeItemId)}"]`,
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [props.activeItemId]);

  return (
    <Command
      autoHighlight={false}
      mode="none"
      onItemHighlighted={(highlightedValue) => {
        props.onHighlightedItemChange(
          typeof highlightedValue === "string" ? highlightedValue : null,
        );
      }}
    >
      <ComposerBanner.Surface
        ref={listRef}
        {...panel.panelProps}
        className="panel-height-motion min-h-0 w-full **:data-[slot=command-item]:rounded-lg **:data-[slot=scroll-area-scrollbar]:data-[orientation=vertical]:my-4"
        data-composer-command-drawer="true"
      >
        <div
          ref={panel.contentRef}
          className="flex flex-col pb-(--chat-composer-attachment-overlap)"
        >
          {props.items.length > 0 ? (
            <CommandList
              id={props.listId}
              aria-label={
                props.triggerKind ? LISTBOX_LABEL_BY_TRIGGER[props.triggerKind] : undefined
              }
              className="max-h-72 min-h-0 scroll-pb-6"
            >
              {sections.map((section, index) => {
                const presentation =
                  showHeadings && section.group ? MENU_GROUP_PRESENTATION[section.group] : null;
                const Icon = presentation?.icon;
                return (
                  <CommandGroup key={section.group ?? `section-${index}`}>
                    {presentation && Icon ? (
                      <CommandGroupLabel>
                        <span className="flex items-center gap-1.5">
                          <Icon aria-hidden="true" className="size-3.5 shrink-0" />
                          {presentation.label}
                        </span>
                      </CommandGroupLabel>
                    ) : null}
                    {section.items.map((item) => (
                      <ComposerCommandMenuItem
                        key={item.id}
                        optionId={composerSuggestionOptionId(props.listId, item.id)}
                        item={item}
                        triggerKind={props.triggerKind}
                        resolvedTheme={props.resolvedTheme}
                        isActive={props.activeItemId === item.id}
                        onHighlight={props.onHighlightedItemChange}
                        onSelect={props.onSelect}
                      />
                    ))}
                  </CommandGroup>
                );
              })}
            </CommandList>
          ) : (
            // One list-item row (same p-2 inset, same min height) so the empty state is as tall as
            // a single result; the tucked overlap below it is the wrapper's padding, not extra.
            <div className="p-2">
              <p className="flex min-h-8 items-center px-2 text-secondary-label text-xs sm:min-h-7">
                {props.isLoading
                  ? props.triggerKind === "skill"
                    ? "Searching workspace skills..."
                    : props.triggerKind === "pull-request"
                      ? "Finding pull request..."
                      : "Searching workspace files..."
                  : (props.emptyStateText ??
                    (props.triggerKind === "skill"
                      ? "No skills found. Try / to browse provider commands."
                      : props.triggerKind === "path"
                        ? "No matching tasks, chats, agents, projects or files."
                        : "No matching command."))}
              </p>
            </div>
          )}
        </div>
      </ComposerBanner.Surface>
    </Command>
  );
});

const ComposerCommandMenuItem = memo(function ComposerCommandMenuItem(props: {
  optionId: string;
  item: ComposerCommandItem;
  triggerKind: ComposerTriggerKind | null;
  resolvedTheme: "light" | "dark";
  isActive: boolean;
  onHighlight: (itemId: string | null) => void;
  onSelect: (item: ComposerCommandItem) => void;
}) {
  const skillSourceKind =
    props.item.type === "skill" ? resolveProviderSkillSourceKind(props.item.skill) : null;
  const isSlashSkill =
    props.triggerKind === "slash-command" && props.item.type === "skill" ? props.item.skill : null;

  return (
    <CommandItem
      render={<div id={props.optionId} />}
      aria-selected={props.isActive}
      value={props.item.id}
      data-composer-item-id={props.item.id}
      active={props.isActive}
      onMouseMove={() => {
        if (!props.isActive) props.onHighlight(props.item.id);
      }}
      onMouseDown={(event) => {
        event.preventDefault();
      }}
      onClick={() => {
        props.onSelect(props.item);
      }}
    >
      {props.item.type === "path" ? (
        <PierreEntryIcon
          pathValue={props.item.path}
          kind={props.item.pathKind}
          theme={props.resolvedTheme}
        />
      ) : null}
      {props.item.type === "thread" ||
      props.item.type === "agent" ||
      props.item.type === "project-folder" ? (
        <MentionItemIcon group={props.item.group} />
      ) : null}
      <span className="flex min-w-0 flex-1 items-center gap-2">
        <span className="min-w-0 max-w-[45%] shrink-0 truncate font-sans text-xs font-medium">
          {isSlashSkill ? (
            <>
              <span className="text-secondary-label">/skill:</span>
              {formatProviderSkillDisplayName(isSlashSkill)}
            </>
          ) : (
            props.item.label
          )}
        </span>
        <span className="min-w-0 flex-1 truncate text-left text-secondary-label text-xs">
          {props.item.description}
        </span>
        {skillSourceKind ? (
          <SkillSourceBadge
            kind={skillSourceKind}
            showSkillSuffix={props.triggerKind === "skill"}
          />
        ) : null}
      </span>
    </CommandItem>
  );
});

function MentionItemIcon(props: { group: ComposerMentionGroup }) {
  const Icon = MENU_GROUP_PRESENTATION[props.group].icon;
  return <Icon aria-hidden="true" className="size-4 shrink-0 text-secondary-label" />;
}

export function composerSuggestionOptionId(listId: string, itemId: string): string {
  // JSON escapes lone UTF-16 surrogates before URI encoding without losing identity.
  return `${listId}-${encodeURIComponent(JSON.stringify(itemId))}`;
}

const LISTBOX_LABEL_BY_TRIGGER: Record<ComposerTriggerKind, string> = {
  path: "Tasks, chats, agents, projects and files",
  "pull-request": "Pull requests",
  "slash-command": "Commands",
  skill: "Skills",
};

const SKILL_SOURCE_ICON_BY_KIND: Record<ProviderSkillSourceKind, LucideIcon> = {
  app: BlocksIcon,
  repo: FolderIcon,
  project: FolderIcon,
  personal: UserRoundIcon,
  system: SettingsIcon,
  other: PackageIcon,
};

const SKILL_SOURCE_LABEL_BY_KIND: Record<ProviderSkillSourceKind, string> = {
  app: "App",
  repo: "Repo",
  project: "Project",
  personal: "Personal",
  system: "System",
  other: "Provider",
};

function SkillSourceBadge(props: { kind: ProviderSkillSourceKind; showSkillSuffix: boolean }) {
  const Icon = SKILL_SOURCE_ICON_BY_KIND[props.kind];
  return (
    <Badge className="ms-auto" variant="secondary">
      <Icon aria-hidden="true" className="text-current" />
      {SKILL_SOURCE_LABEL_BY_KIND[props.kind]}
      {props.showSkillSuffix ? " Skill" : null}
    </Badge>
  );
}
