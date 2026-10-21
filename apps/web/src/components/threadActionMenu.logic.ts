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
  | "new-thread-on-branch"
  | "start-work"
  | "project-settings"
  | `open-project:${string}`
  | "move-folder"
  | `move-folder:${string}`
  | "remove-folder"
  | "new-folder"
  | "settle"
  | "unsettle"
  | "auto-settle"
  | "auto-settle:enabled"
  | "auto-settle:disabled"
  | "snooze"
  | `snooze:${string}`
  | "unsnooze"
  | "rename"
  | "regenerate-title"
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

export type DraftActionMenuId =
  | "copy"
  | "copy-path"
  | "copy-branch"
  | "project-settings"
  | "discard";

/** Right-click menu for an unsent draft row in the sidebar. */
export function buildDraftActionMenuItems(options: {
  readonly hasPath: boolean;
  readonly hasBranch: boolean;
  readonly hasProject: boolean;
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
    ...(options.hasProject
      ? [{ id: "project-settings" as const, label: "Repository settings", icon: "settings" }]
      : []),
    {
      id: "discard",
      label: "Discard draft",
      icon: "trash",
      destructive: true,
      separatorBefore: copyChildren.length > 0 || options.hasProject,
    },
  ];
}

export interface ThreadActionMenuState {
  /** What the thread's kind allows; anything it does not is left out entirely. */
  readonly capabilities: ThreadCapabilities;
  readonly canOperate: boolean;
  readonly branch: string | null;
  readonly isSettled: boolean;
  /** False while the user has turned automatic settlement off for this thread. */
  readonly autoSettleEnabled: boolean;
  readonly isSnoozed: boolean;
  readonly canSnoozeNow: boolean;
  /** Offers "Mark read" in place of "Mark unread". */
  readonly isUnread?: boolean;
  readonly isRegeneratingTitle: boolean;
  /** Archive rejects a thread with an attached provider, so disable it here rather than let the action fail. */
  readonly isRunning: boolean;
  /** What the thread's environment understands; a kind's action still needs its server. */
  readonly supports: {
    readonly settlement: boolean;
    /** Server understands thread.auto-settle.set. */
    readonly autoSettleOptOut: boolean;
    readonly snooze: boolean;
    readonly titleRegeneration: boolean;
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
    "new-thread-on-branch",
    "project-settings",
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
 * "Open <folder>" when filed, then "Move to folder" with every folder (the
 * current one checked), "Remove from folder", and "New project…" at the end.
 */
function folderMenuItems(
  folder: ThreadActionMenuFolder | undefined,
): ReadonlyArray<ContextMenuItem<ThreadActionMenuId>> {
  if (folder === undefined) return [];
  const { current } = folder;
  const disabled = !folder.canMove;
  const children: Array<ContextMenuItem<ThreadActionMenuId>> = folder.options.map((option) => ({
    id: `move-folder:${option.id}` as const,
    label: option.name,
    icon: "folder",
    iconColor: projectLabelColorValue(option.color),
    checked: option.id === current?.id,
    disabled: disabled || option.id === current?.id,
  }));
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
  return [
    ...(current !== null
      ? [
          {
            id: `open-project:${current.key}` as const,
            label: `Open ${current.name}`,
            icon: "folder",
          },
        ]
      : []),
    { id: "move-folder", label: "Move to folder", icon: "folder", children },
  ];
}

type MenuItems = ReadonlyArray<ContextMenuItem<ThreadActionMenuId>>;

/**
 * Single source for the per-thread action menu: the sidebar row's right-click
 * menu and the chat header menu share labels, ordering, and gating. The
 * thread's kind decides which actions exist at all; the state decides each
 * one's current direction (settle or un-settle, snooze or wake).
 */
export function buildThreadActionMenuItems(state: ThreadActionMenuState): MenuItems {
  const can = state.capabilities;
  const lifecycle: MenuItems = [
    ...(can.git && state.branch
      ? [
          {
            id: "new-thread-on-branch" as const,
            label: `New thread on ${state.branch}`,
            icon: "message-square-plus",
          },
        ]
      : []),
    ...(can.startWork ? [{ id: "start-work" as const, label: "Start Work…", icon: "hammer" }] : []),
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
  ];
  const identity: MenuItems = [
    ...(can.rename ? [{ id: "rename" as const, label: "Rename thread", icon: "pencil" }] : []),
    ...(can.regenerateTitle && state.supports.titleRegeneration
      ? [
          {
            id: "regenerate-title" as const,
            label: state.isRegeneratingTitle ? "Regenerating…" : "Regenerate title",
            icon: "refresh-cw",
            disabled: state.isRegeneratingTitle,
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
    // A submenu with the current option checked, not a one-shot action:
    // this is a setting, and it sits with the other per-thread settings
    // rather than the lifecycle verbs above. Disabled keeps long-running
    // threads out of the settled shelf no matter how quiet they get.
    ...(can.autoSettle && state.supports.autoSettleOptOut
      ? [
          {
            id: "auto-settle" as const,
            label: "Auto-settle behavior",
            icon: "timer",
            children: [
              {
                id: "auto-settle:enabled" as const,
                label: "Enabled",
                checked: state.autoSettleEnabled,
              },
              {
                id: "auto-settle:disabled" as const,
                label: "Disabled",
                checked: !state.autoSettleEnabled,
              },
            ],
          },
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
  const places: MenuItems = [
    ...(copyChildren.length > 0
      ? [{ id: "copy" as const, label: "Copy", icon: "copy", children: copyChildren }]
      : []),
    ...(can.repositorySettings
      ? [{ id: "project-settings" as const, label: "Repository settings", icon: "settings" }]
      : []),
    ...(can.projectFolder ? folderMenuItems(state.folder) : []),
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
  const items = [lifecycle, identity, places, removal]
    .filter((group) => group.length > 0)
    .flatMap((group, index) =>
      index === 0 ? group : [{ ...group[0]!, separatorBefore: true }, ...group.slice(1)],
    );
  return state.canOperate
    ? items
    : items.map((item) =>
        threadActionRequiresOperate(item.id)
          ? {
              ...item,
              disabled: true,
              ...(item.children
                ? { children: item.children.map((child) => ({ ...child, disabled: true })) }
                : {}),
            }
          : item,
      );
}
