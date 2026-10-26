import type { ComposerTriggerKind } from "../../composer-logic";

export interface ComposerMenuSection<Item, Group extends string> {
  readonly group: Group | null;
  readonly items: Item[];
}

/**
 * Consecutive items of one section. Items arrive already in section order, which is also keyboard
 * order, so sections are runs, not a regrouping: the highlighted index the composer tracks stays
 * the index into `items`. Items without a group (slash commands, skills) form ungrouped runs.
 */
export function composerMenuSections<Item, Group extends string>(
  items: ReadonlyArray<Item>,
  groupOf: (item: Item) => Group | null,
): {
  readonly sections: ReadonlyArray<ComposerMenuSection<Item, Group>>;
  /** Headings only once there is more than one kind of thing to tell apart (files alone need none). */
  readonly showHeadings: boolean;
} {
  const sections: { group: Group | null; items: Item[] }[] = [];
  for (const item of items) {
    const group = groupOf(item);
    const last = sections.at(-1);
    if (last && last.group === group) last.items.push(item);
    else sections.push({ group, items: [item] });
  }
  const only = sections.length === 1 ? sections[0] : undefined;
  const showHeadings = sections.length > 1 || (only !== undefined && only.group !== "files");
  return { sections, showHeadings };
}

/**
 * What a keystroke changed in the rows. `arrived` are the ids that fade in. `leaving` are the
 * dropped rows in their old order, nearest the new rows last and at most `max` of them: the drawer
 * draws them above the new rows, fading, while its top edge glides down.
 */
export function composerMenuRowChanges<Item extends { readonly id: string }>(
  previous: ReadonlyArray<Item>,
  next: ReadonlyArray<Item>,
  max: number,
): { readonly arrived: ReadonlySet<string>; readonly leaving: Item[] } {
  const before = new Set(previous.map((item) => item.id));
  const after = new Set(next.map((item) => item.id));
  return {
    arrived: new Set(next.filter((item) => !before.has(item.id)).map((item) => item.id)),
    leaving: previous.filter((item) => !after.has(item.id)).slice(-max),
  };
}

/** What the menu says while it has no rows: searching, or nothing matched for this trigger. */
export function composerMenuEmptyText(input: {
  readonly triggerKind: ComposerTriggerKind | null;
  readonly isLoading: boolean;
  readonly emptyStateText?: string | undefined;
}): string {
  if (input.isLoading) {
    switch (input.triggerKind) {
      case "skill":
        return "Searching workspace skills...";
      case "pull-request":
        return "Finding pull request...";
      default:
        return "Searching workspace files...";
    }
  }
  if (input.emptyStateText !== undefined) return input.emptyStateText;
  switch (input.triggerKind) {
    case "skill":
      return "No skills found. Try / to browse provider commands.";
    case "path":
      return "No matching tasks, chats, agents, projects, sources or files.";
    default:
      return "No matching command.";
  }
}
