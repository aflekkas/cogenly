import { type ResolvedKeybindingsConfig } from "@cogenly/contracts";
import { LegendList, type LegendListRef } from "@legendapp/list/react";
import { type RefObject } from "react";
import { shortcutLabelForCommand } from "../keybindings";
import {
  type CommandPaletteActionItem,
  type CommandPaletteGroup,
  type CommandPaletteRow,
  type CommandPaletteSubmenuItem,
} from "./CommandPalette.logic";
import {
  CommandCollection,
  CommandGroup,
  CommandGroupLabel,
  CommandItem,
  CommandList,
  CommandListHeading,
  CommandListVirtualized,
} from "./ui/command";
import {
  SearchListEmpty,
  SearchListRowDescription,
  SearchListRowIcon,
  SearchListRowLabel,
  SearchListRowMeta,
  SearchListRowShortcut,
  SearchListRowSubmenu,
  SearchListRowText,
  SearchListRowTrailing,
  SearchListStaticRow,
} from "./ui/search-list";
import { ThreadSearchMatchExcerpt } from "./ThreadSearchMatch";

interface CommandPaletteResultsProps {
  emptyStateMessage?: string;
  groups: ReadonlyArray<CommandPaletteGroup>;
  highlightedItemValue?: string | null;
  isActionsOnly: boolean;
  keybindings: ResolvedKeybindingsConfig;
  onExecuteItem: (item: CommandPaletteActionItem | CommandPaletteSubmenuItem) => void;
}

function CommandPaletteEmptyState(props: { emptyStateMessage?: string; isActionsOnly: boolean }) {
  return (
    <SearchListEmpty size="dialog">
      {props.emptyStateMessage ??
        (props.isActionsOnly
          ? "No matching actions."
          : "No matching commands, repositories, or threads.")}
    </SearchListEmpty>
  );
}

export function CommandPaletteResults(props: CommandPaletteResultsProps) {
  if (props.groups.length === 0) {
    return <CommandPaletteEmptyState {...props} />;
  }

  return (
    <CommandList>
      {props.groups.map((group) => (
        <CommandGroup items={group.items} key={group.value}>
          {group.label ? <CommandGroupLabel>{group.label}</CommandGroupLabel> : null}
          <CommandCollection>
            {(item) =>
              item.disabled ? (
                <DisabledCommandPaletteResultRow item={item} key={item.value} />
              ) : (
                <CommandPaletteResultRow
                  item={item}
                  key={item.value}
                  keybindings={props.keybindings}
                  isActive={props.highlightedItemValue === item.value}
                  onExecuteItem={props.onExecuteItem}
                />
              )
            }
          </CommandCollection>
        </CommandGroup>
      ))}
    </CommandList>
  );
}

/**
 * Scrolls a keyboard highlight into view the way the unvirtualized list did:
 * nearest edge, clear of the scroll fade. Rows outside the rendered window
 * fall back to the list's own scrolling.
 */
export function scrollCommandPaletteRowIntoView(list: LegendListRef | null, rowIndex: number) {
  const element = list?.getState?.().elementAtIndex(rowIndex);
  if (element instanceof HTMLElement) {
    element.scrollIntoView({ block: "nearest" });
    return;
  }
  void list?.scrollIndexIntoView?.({ index: rowIndex, animated: false });
}

interface CommandPaletteVirtualizedResultsProps extends Omit<CommandPaletteResultsProps, "groups"> {
  rows: ReadonlyArray<CommandPaletteRow>;
  listRef: RefObject<LegendListRef | null>;
}

/**
 * Renders only the visible rows. The parent passes the flat item order to the
 * Command root as `items` with `virtualized`, scrolls keyboard highlights into
 * view through `listRef`, and runs Enter itself since the row may be unmounted.
 */
export function CommandPaletteVirtualizedResults(props: CommandPaletteVirtualizedResultsProps) {
  const { listRef } = props;

  if (props.rows.length === 0) {
    return <CommandPaletteEmptyState {...props} />;
  }

  return (
    <CommandListVirtualized>
      <LegendList<CommandPaletteRow>
        ref={listRef}
        data={props.rows}
        keyExtractor={(row) => row.key}
        getItemType={(row) => row.kind}
        extraData={props.highlightedItemValue}
        renderItem={({ item: row }) =>
          row.kind === "label" ? (
            <div className={row.first ? undefined : "pt-1.5"}>
              <CommandListHeading>{row.label}</CommandListHeading>
            </div>
          ) : row.itemIndex === null ? (
            <DisabledCommandPaletteResultRow item={row.item} />
          ) : (
            <CommandPaletteResultRow
              index={row.itemIndex}
              item={row.item}
              keybindings={props.keybindings}
              isActive={props.highlightedItemValue === row.item.value}
              onExecuteItem={props.onExecuteItem}
            />
          )
        }
        estimatedItemSize={40}
        drawDistance={400}
        contentContainerClassName="px-2"
        className="scroll-fade-y min-h-0 scroll-py-6 overflow-x-hidden overscroll-y-contain py-2 [&::-webkit-scrollbar-track]:my-2"
      />
    </CommandListVirtualized>
  );
}

/** A palette row's content, the same whether it can be picked or not. */
function CommandPaletteRowContent(props: {
  item: CommandPaletteActionItem | CommandPaletteSubmenuItem;
  shortcutLabel?: string | null;
}) {
  const { item } = props;
  const hasTrailing =
    item.titleTrailingContent || item.timestamp || props.shortcutLabel || item.kind === "submenu";
  return (
    <>
      {item.icon ? <SearchListRowIcon>{item.icon}</SearchListRowIcon> : null}
      <SearchListRowText>
        <SearchListRowLabel leading={item.titleLeadingContent}>{item.title}</SearchListRowLabel>
        {item.threadContentMatch ? (
          <ThreadSearchMatchExcerpt match={item.threadContentMatch} />
        ) : null}
        {item.description ? (
          <SearchListRowDescription>{item.description}</SearchListRowDescription>
        ) : null}
      </SearchListRowText>
      {hasTrailing ? (
        <SearchListRowTrailing>
          {item.titleTrailingContent}
          {item.timestamp ? <SearchListRowMeta>{item.timestamp}</SearchListRowMeta> : null}
          {props.shortcutLabel ? (
            <SearchListRowShortcut>{props.shortcutLabel}</SearchListRowShortcut>
          ) : null}
          {item.kind === "submenu" ? <SearchListRowSubmenu /> : null}
        </SearchListRowTrailing>
      ) : null}
    </>
  );
}

function DisabledCommandPaletteResultRow(props: {
  item: CommandPaletteActionItem | CommandPaletteSubmenuItem;
}) {
  return (
    <SearchListStaticRow>
      <CommandPaletteRowContent item={props.item} />
    </SearchListStaticRow>
  );
}

function CommandPaletteResultRow(props: {
  index?: number;
  item: CommandPaletteActionItem | CommandPaletteSubmenuItem;
  isActive: boolean;
  keybindings: ResolvedKeybindingsConfig;
  onExecuteItem: (item: CommandPaletteActionItem | CommandPaletteSubmenuItem) => void;
}) {
  const shortcutLabel = props.item.shortcutCommand
    ? shortcutLabelForCommand(props.keybindings, props.item.shortcutCommand)
    : null;

  return (
    <CommandItem
      {...(props.index === undefined ? {} : { index: props.index })}
      value={props.item.value}
      active={props.isActive}
      onMouseDown={(event) => {
        event.preventDefault();
      }}
      onClick={() => {
        props.onExecuteItem(props.item);
      }}
    >
      <CommandPaletteRowContent item={props.item} shortcutLabel={shortcutLabel} />
    </CommandItem>
  );
}
