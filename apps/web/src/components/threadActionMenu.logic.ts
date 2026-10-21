import type { ContextMenuItem } from "@t3tools/contracts";
import type { SnoozePreset } from "@t3tools/client-runtime/state/thread-settled";

import { projectLabelColorValue } from "../projectLabels/projectLabels.logic";
import type { ThreadCapabilities } from "../threadCapabilities";

/**
 * Ids for the per-thread action menu. Snooze presets are dispatched as
 * `snooze:<presetId>` so the union stays closed while the preset list
 * remains data-driven.
 */
export type ThreadActionMenuId =
  | "start-work"
  | `open-project:${string}`
  | "move-folder"
  | `move-folder:${string}`
  | "remove-folder"
  | "new-folder"
  | "pin"
  | "unpin"
  | "settle"
  | "unsettle"
  | "snooze"
  | `snooze:${string}`
  | "unsnooze"
  | "rename"
  | "mark-unread"
  | "mark-read"
  | "agent-settings"
  | "copy"
  | "copy-path"
  | "copy-branch"
  | "copy-thread-link"
  | "copy-thread-id"
  | "archive"
  | "delete";

export type DraftActionMenuId = "copy" | "copy-path" | "copy-branch" | "discard";

/**
 * Right-click menu for an unsent draft row in the sidebar. Repository actions
 * live on the Work list's repository heading, not on each row.
 */
export function buildDraftActionMenuItems(options: {
  readonly hasPath: boolean;
  readonly hasBranch: boolean;
}): ReadonlyArray<ContextMenuItem<DraftActionMenuId>> {
  const copyChildren: ReadonlyArray<ContextMenuItem<DraftActionMenuId>> = [
    ...(options.hasPath ? [{ id: "copy-path" as const, label: "Path", icon: "folder" }] : []),
    ...(options.hasBranch
      ? [{ id: "copy-branch" as const, label: "Branch", icon: "git-branch" }]
      : []),
  ];
  return [
    // A chat draft has nothing to copy yet, so it gets no Copy at all.
    ...(copyChildren.length > 0
      ? [{ id: "copy" as const, label: "Copy", icon: "copy", children: copyChildren }]
      : []),
    {
      id: "discard",
      label: "Discard draft",
      icon: "trash",
      destructive: true,
      separatorBefore: copyChildren.length > 0,
    },
  ];
}

export type RepositoryActionMenuId = "new-thread" | `open-project:${string}` | "project-settings";

/**
 * Right-click menu for a repository heading in the Work list: the actions
 * that belong to the repository rather than to one of its threads.
 */
export function buildRepositoryActionMenuItems(options: {
  /** The project folder the repository is filed in, if any. */
  readonly folder: { readonly key: string; readonly name: string } | null;
}): ReadonlyArray<ContextMenuItem<RepositoryActionMenuId>> {
  return [
    { id: "new-thread", label: "New thread", icon: "message-square-plus" },
    ...(options.folder
      ? [
          {
            id: `open-project:${options.folder.key}` as const,
            label: `Open ${options.folder.name}`,
            icon: "folder",
          },
        ]
      : []),
    {
      id: "project-settings",
      label: "Repository settings",
      icon: "settings",
      separatorBefore: true,
    },
  ];
}

export interface ThreadActionMenuState {
  /** What the thread's kind allows; anything it does not is left out entirely. */
  readonly capabilities: ThreadCapabilities;
  readonly canOperate: boolean;
  readonly branch: string | null;
  readonly isPinned: boolean;
  readonly isSettled: boolean;
  readonly isSnoozed: boolean;
  readonly canSnoozeNow: boolean;
  /** Offers "Mark read" in place of "Mark unread". */
  readonly isUnread?: boolean;
  /** Archive rejects a thread with an attached provider, so disable it here rather than let the action fail. */
  readonly isRunning: boolean;
  /** What the thread's environment understands; a kind's action still needs its server. */
  readonly supports: {
    readonly settlement: boolean;
    readonly snooze: boolean;
    /** Server understands thread.pin / thread.unpin. */
    readonly pinning: boolean;
  };
  readonly snoozePresets: ReadonlyArray<SnoozePreset>;
  /** The thread's project folder and where it can move; omitted where folders are unknown. */
  readonly folder?: ThreadActionMenuFolder;
}

export interface ThreadActionMenuFolder {
  /** `key` opens the folder's view; `id` is what a move sends. */
  readonly current: { readonly key: string; readonly id: string; readonly name: string } | null;
  /** Only an explicit filing offers "Remove from folder"; Work in its repository's folder does not. */
  readonly removable: boolean;
  readonly options: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    /** The project's stored color name; its folder icon takes it. */
    readonly color?: string | undefined;
  }>;
  /** The move command's permission on the thread's environment. */
  readonly canMove: boolean;
}

/** Local navigation, read markers, and copying remain available to read-only clients. */
export function threadActionRequiresOperate(action: ThreadActionMenuId): boolean {
  if (action.startsWith("open-project") || action === "new-folder") return false;
  return ![
    "agent-settings",
    "mark-unread",
    "mark-read",
    "copy",
    "copy-path",
    "copy-branch",
    "copy-thread-link",
    "copy-thread-id",
  ].includes(action);
}

/**
 * "Move to folder" with "Open <folder>" first when filed, then every folder
 * (the current one checked), "Remove from folder", and "New project…".
 */
function folderMenuItems(
  folder: ThreadActionMenuFolder | undefined,
): ReadonlyArray<ContextMenuItem<ThreadActionMenuId>> {
  if (folder === undefined) return [];
  const { current } = folder;
  const disabled = !folder.canMove;
  const children: Array<ContextMenuItem<ThreadActionMenuId>> = [];
  if (current !== null) {
    children.push({
      id: `open-project:${current.key}`,
      label: `Open ${current.name}`,
      icon: "folder",
    });
  }
  folder.options.forEach((option, index) => {
    children.push({
      id: `move-folder:${option.id}`,
      label: option.name,
      icon: "folder",
      iconColor: projectLabelColorValue(option.color),
      checked: option.id === current?.id,
      disabled: disabled || option.id === current?.id,
      separatorBefore: index === 0 && children.length > 0,
    });
  });
  if (current !== null && folder.removable) {
    children.push({
      id: "remove-folder",
      label: "Remove from folder",
      disabled,
      separatorBefore: children.length > 0,
    });
  }
  children.push({
    id: "new-folder",
    label: "New project…",
    separatorBefore: children.length > 0,
  });
  return [{ id: "move-folder", label: "Move to folder", icon: "folder", children }];
}

type MenuItems = ReadonlyArray<ContextMenuItem<ThreadActionMenuId>>;

/**
 * The sidebar row's right-click menu for one thread, in every mode (Chats,
 * Work, Agents). The thread's kind decides which actions exist at all; the state decides each
 * one's current direction (settle or un-settle, snooze or wake).
 *
 * Three groups: the thread's state, the thread itself, and removal.
 * Repository actions (new thread, settings, opening its folder) sit on the
 * Work list's repository heading; title regeneration sits in the rename
 * field; auto-settle sits in the thread details popover.
 */
export function buildThreadActionMenuItems(state: ThreadActionMenuState): MenuItems {
  const can = state.capabilities;
  const status: MenuItems = [
    ...(can.startWork ? [{ id: "start-work" as const, label: "Start Work…", icon: "hammer" }] : []),
    ...(can.pin && state.supports.pinning
      ? [
          state.isPinned
            ? { id: "unpin" as const, label: "Unpin thread", icon: "pin-off" }
            : { id: "pin" as const, label: "Pin thread", icon: "pin" },
        ]
      : []),
    ...(can.settle && state.supports.settlement
      ? [
          state.isSettled
            ? { id: "unsettle" as const, label: "Un-settle thread", icon: "circle-check" }
            : { id: "settle" as const, label: "Settle thread", icon: "circle-check" },
        ]
      : []),
    ...(can.snooze && state.supports.snooze
      ? [
          state.isSnoozed
            ? { id: "unsnooze" as const, label: "Wake thread", icon: "clock" }
            : {
                id: "snooze" as const,
                label: "Snooze",
                icon: "clock",
                disabled: !state.canSnoozeNow,
                children: [
                  ...state.snoozePresets.map((preset) => ({
                    id: `snooze:${preset.id}` as const,
                    label: `${preset.label} (${preset.whenLabel})`,
                  })),
                  { id: "snooze:custom" as const, label: "Custom…", separatorBefore: true },
                ],
              },
        ]
      : []),
    ...(can.markUnread
      ? [
          state.isUnread
            ? { id: "mark-read" as const, label: "Mark read", icon: "mail" }
            : { id: "mark-unread" as const, label: "Mark unread", icon: "mail-open" },
        ]
      : []),
  ];
  const copyChildren: MenuItems = [
    ...(can.copyWorkspace ? [{ id: "copy-path" as const, label: "Path", icon: "folder" }] : []),
    ...(can.copyWorkspace && state.branch
      ? [{ id: "copy-branch" as const, label: "Branch", icon: "git-branch" }]
      : []),
    ...(can.copyLink
      ? [
          { id: "copy-thread-link" as const, label: "Thread link", icon: "link" },
          { id: "copy-thread-id" as const, label: "Thread ID", icon: "hash" },
        ]
      : []),
  ];
  const thread: MenuItems = [
    ...(can.rename ? [{ id: "rename" as const, label: "Rename…", icon: "pencil" }] : []),
    ...(can.projectFolder ? folderMenuItems(state.folder) : []),
    ...(copyChildren.length > 0
      ? [{ id: "copy" as const, label: "Copy", icon: "copy", children: copyChildren }]
      : []),
    ...(can.agentSettings
      ? [{ id: "agent-settings" as const, label: "Agent settings", icon: "settings" }]
      : []),
  ];
  // Archive removes the thread from the sidebar while keeping its
  // conversation under Settings > Archived threads — distinct from Settle
  // (stays visible in the Settled shelf) and Delete (clears history for
  // good), so it sits beside Delete without borrowing its destructive
  // styling.
  const removal: MenuItems = [
    ...(can.archive
      ? [
          {
            id: "archive" as const,
            // Supported but unavailable right now, so it says why.
            label: state.isRunning ? "Archive thread (stop it first)" : "Archive thread",
            icon: "archive",
            disabled: state.isRunning,
          },
        ]
      : []),
    ...(can.delete !== false
      ? [{ id: "delete" as const, label: "Delete", destructive: true, icon: "trash" }]
      : []),
  ];
  const items = [status, thread, removal]
    .filter((group) => group.length > 0)
    .flatMap((group, index) =>
      index === 0 ? group : [{ ...group[0]!, separatorBefore: true }, ...group.slice(1)],
    );
  return state.canOperate ? items : items.map(withoutOperateActions);
}

/**
 * A read-only client keeps local actions (opening, copying, read markers);
 * a submenu stays open while any of its children still works.
 */
function withoutOperateActions(
  item: ContextMenuItem<ThreadActionMenuId>,
): ContextMenuItem<ThreadActionMenuId> {
  if (item.children) {
    const children = item.children.map(withoutOperateActions);
    return {
      ...item,
      children,
      ...(children.every((child) => child.disabled === true) ? { disabled: true } : {}),
    };
  }
  return threadActionRequiresOperate(item.id) ? { ...item, disabled: true } : item;
}
