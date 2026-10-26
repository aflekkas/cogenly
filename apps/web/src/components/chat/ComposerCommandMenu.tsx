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
  type EnvironmentId,
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
  PlugIcon,
  SettingsIcon,
  UserRoundIcon,
  type LucideIcon,
} from "lucide-react";
import { memo, useLayoutEffect, useRef, useState } from "react";

import { type ComposerSlashCommand, type ComposerTriggerKind } from "../../composer-logic";
import { useAnimatedPanelHeight } from "../ui/animated-panel-height";
import { Command, CommandGroup, CommandGroupLabel, CommandItem, CommandList } from "../ui/command";
import {
  SearchListEmpty,
  SearchListRowBadge,
  SearchListRowDescription,
  SearchListRowIcon,
  SearchListRowLabel,
  SearchListRowText,
  SearchListRowTrailing,
  searchListRowVariants,
} from "../ui/search-list";
import { useMachineLabel } from "../../machines/useMachineLabel";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { PierreEntryIcon } from "./PierreEntryIcon";
import { IntegrationSourceRowContent } from "./ComposerSourcesPicker";
import { ComposerBanner } from "./ComposerBanner";
import {
  composerMenuEmptyText,
  composerMenuRowChanges,
  composerMenuSections,
} from "./ComposerCommandMenu.logic";

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

/**
 * Each `@` section's heading and its rows' leading mark (headings stay text-only, like every
 * searchable list's). A new `@` item kind adds its group here
 * (and to `ComposerCommandItem`); its rows then render through `ComposerCommandMenuItem`.
 */
const MENU_GROUP_PRESENTATION: Record<ComposerMenuGroup, { label: string; icon: LucideIcon }> = {
  tasks: { label: "Tasks", icon: HammerIcon },
  chats: { label: "Chats", icon: MessageCircleIcon },
  agents: { label: "Agents", icon: BotIcon },
  projects: { label: "Projects", icon: FolderIcon },
  sources: { label: "Sources", icon: PlugIcon },
  files: { label: "Files and folders", icon: FileIcon },
};

/** About a full drawer of rows (`max-h-72`): more would sit past its top edge. */
const LEAVING_ROWS_MAX = 9;

function menuGroupOf(item: ComposerCommandItem): ComposerMenuGroup | null {
  return "group" in item ? item.group : null;
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
  // The drawer sits on the composer by its bottom edge and hugs its rows, so a height change only
  // glides the top edge. The rows are laid out from the bottom, so the ones by the input hold still
  // while the top edge reveals or clips the rows above them.
  const panel = useAnimatedPanelHeight();
  const { sections, showHeadings } = composerMenuSections(props.items, menuGroupOf);
  // Rows a keystroke brought fade in; rows it dropped stay drawn above the new ones, fading, while
  // the top edge glides down over them, so a shrinking drawer never shows bare surface. A larger
  // drawer clips them. Rows on screen when the menu opens arrive with it.
  const [shownItems, setShownItems] = useState(props.items);
  const [arrived, setArrived] = useState<ReadonlySet<string>>(() => new Set());
  const [leaving, setLeaving] = useState<{ rows: ComposerCommandItem[]; generation: number }>({
    rows: [],
    generation: 0,
  });
  if (shownItems !== props.items) {
    setShownItems(props.items);
    const changes = composerMenuRowChanges(shownItems, props.items, LEAVING_ROWS_MAX);
    setArrived(changes.arrived);
    // Rows still fading from an earlier keystroke finish unless this one drops others.
    if (changes.leaving.length > 0) {
      setLeaving({ rows: changes.leaving, generation: leaving.generation + 1 });
    }
  }

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
        className="panel-height-motion flex min-h-0 w-full flex-col justify-end **:data-[slot=scroll-area-scrollbar]:data-[orientation=vertical]:my-4"
        data-composer-command-drawer="true"
      >
        <div
          ref={panel.contentRef}
          className="relative flex shrink-0 flex-col pb-(--chat-composer-attachment-overlap)"
        >
          {leaving.rows.length > 0 ? (
            <div
              key={leaving.generation}
              aria-hidden="true"
              inert
              // Overlaps the list's top padding so the rows keep their old spacing.
              className="animate-row-leave pointer-events-none absolute inset-x-0 bottom-[calc(100%-(--spacing(2)))] flex flex-col px-2"
              data-composer-leaving-rows=""
              onAnimationEnd={(event) => {
                if (event.target === event.currentTarget) setLeaving({ ...leaving, rows: [] });
              }}
            >
              {leaving.rows.map((item) => (
                <div key={item.id} className={searchListRowVariants({ highlight: "none" })}>
                  <ComposerCommandRowContent
                    item={item}
                    triggerKind={props.triggerKind}
                    resolvedTheme={props.resolvedTheme}
                  />
                </div>
              ))}
            </div>
          ) : null}
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
                return (
                  <CommandGroup key={section.group ?? `section-${index}`}>
                    {presentation ? (
                      <CommandGroupLabel>{presentation.label}</CommandGroupLabel>
                    ) : null}
                    {section.items.map((item) => (
                      <ComposerCommandMenuItem
                        key={item.id}
                        optionId={composerSuggestionOptionId(props.listId, item.id)}
                        item={item}
                        triggerKind={props.triggerKind}
                        resolvedTheme={props.resolvedTheme}
                        isActive={props.activeItemId === item.id}
                        arrived={arrived.has(item.id)}
                        onHighlight={props.onHighlightedItemChange}
                        onSelect={props.onSelect}
                      />
                    ))}
                  </CommandGroup>
                );
              })}
            </CommandList>
          ) : (
            // One result row tall, so the drawer does not jump while results come and go; the
            // tucked overlap below it is the wrapper's padding, not extra.
            <SearchListEmpty size="row">
              {composerMenuEmptyText({
                triggerKind: props.triggerKind,
                isLoading: props.isLoading,
                emptyStateText: props.emptyStateText,
              })}
            </SearchListEmpty>
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
  /** Read once at mount: the keystroke that rendered this row brought it, so it fades in. */
  arrived: boolean;
  onHighlight: (itemId: string | null) => void;
  onSelect: (item: ComposerCommandItem) => void;
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  // A row that moves to another section remounts; it was already on screen, so it does not fade.
  const [fadeIn] = useState(props.arrived);
  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row || !fadeIn) return;
    // Dropped once played: a later keystroke that reorders the rows moves this node, which would
    // restart the fade.
    const settle = (event: AnimationEvent) => {
      if (event.target !== row) return;
      row.classList.remove("animate-row-enter");
      row.removeEventListener("animationend", settle);
    };
    row.classList.add("animate-row-enter");
    row.addEventListener("animationend", settle);
    return () => row.removeEventListener("animationend", settle);
  }, [fadeIn]);

  return (
    <CommandItem
      render={<div id={props.optionId} />}
      aria-selected={props.isActive}
      value={props.item.id}
      data-composer-item-id={props.item.id}
      active={props.isActive}
      ref={rowRef}
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
      <ComposerCommandRowContent
        item={props.item}
        triggerKind={props.triggerKind}
        resolvedTheme={props.resolvedTheme}
      />
    </CommandItem>
  );
});

/** A row's icon, text and badge, shared by the pickable rows and the ones fading out. */
function ComposerCommandRowContent(props: {
  item: ComposerCommandItem;
  triggerKind: ComposerTriggerKind | null;
  resolvedTheme: "light" | "dark";
}) {
  const skillSourceKind =
    props.item.type === "skill" ? resolveProviderSkillSourceKind(props.item.skill) : null;
  const isSlashSkill =
    props.triggerKind === "slash-command" && props.item.type === "skill" ? props.item.skill : null;

  return (
    <>
      {props.item.type === "integration" ? (
        <IntegrationSourceRowContent source={props.item.source} />
      ) : null}
      {props.item.type === "path" ? (
        <SearchListRowIcon>
          <PierreEntryIcon
            pathValue={props.item.path}
            kind={props.item.pathKind}
            theme={props.resolvedTheme}
          />
        </SearchListRowIcon>
      ) : null}
      {props.item.type === "thread" ||
      props.item.type === "agent" ||
      props.item.type === "project-folder" ? (
        <SearchListRowIcon>
          <MentionItemIcon group={props.item.group} />
        </SearchListRowIcon>
      ) : null}
      {props.item.type === "integration" ? null : (
        <SearchListRowText layout="inline">
          <SearchListRowLabel>
            {isSlashSkill ? (
              <>
                <span className="text-muted-foreground">/skill:</span>
                {formatProviderSkillDisplayName(isSlashSkill)}
              </>
            ) : (
              props.item.label
            )}
          </SearchListRowLabel>
          {props.item.description ? (
            <SearchListRowDescription>{props.item.description}</SearchListRowDescription>
          ) : null}
        </SearchListRowText>
      )}
      {skillSourceKind ? (
        <SearchListRowTrailing>
          <SkillSourceBadge
            kind={skillSourceKind}
            showSkillSuffix={props.triggerKind === "skill"}
          />
        </SearchListRowTrailing>
      ) : null}
      {props.item.type === "thread" && props.item.runsOn !== null ? (
        <ThreadMachineBadge machineId={props.item.runsOn} via={props.item.thread.environmentId} />
      ) : null}
    </>
  );
}

function MentionItemIcon(props: { group: ComposerMentionGroup }) {
  const Icon = MENU_GROUP_PRESENTATION[props.group].icon;
  return <Icon aria-hidden="true" className="size-4 text-icon-muted" />;
}

export function composerSuggestionOptionId(listId: string, itemId: string): string {
  // JSON escapes lone UTF-16 surrogates before URI encoding without losing identity.
  return `${listId}-${encodeURIComponent(JSON.stringify(itemId))}`;
}

const LISTBOX_LABEL_BY_TRIGGER: Record<ComposerTriggerKind, string> = {
  path: "Tasks, chats, agents, projects, sources and files",
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

/** The machine a task or chat from another paired machine runs on. */
function ThreadMachineBadge(props: { machineId: EnvironmentId; via: EnvironmentId }) {
  const machine = useMachineLabel(props.machineId, props.via);
  if (machine === null) return null;
  return (
    <SearchListRowTrailing>
      <SearchListRowBadge>
        <EnvironmentMachineIcon aria-hidden kind={machine.kind} />
        {machine.name}
      </SearchListRowBadge>
    </SearchListRowTrailing>
  );
}

function SkillSourceBadge(props: { kind: ProviderSkillSourceKind; showSkillSuffix: boolean }) {
  const Icon = SKILL_SOURCE_ICON_BY_KIND[props.kind];
  return (
    <SearchListRowBadge>
      <Icon aria-hidden="true" />
      {SKILL_SOURCE_LABEL_BY_KIND[props.kind]}
      {props.showSkillSuffix ? " Skill" : null}
    </SearchListRowBadge>
  );
}
