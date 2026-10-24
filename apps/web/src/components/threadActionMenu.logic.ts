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
  | "move-machine"
  | `move-machine:${string}`
  | "pin"
  | "unpin"
  | "settle"
  | "unsettle"
  | "snooze"
  | `snooze:${string}`
  | "unsnooze"
  | "limit-resume:on"
  | "limit-resume:off"
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
      label: "Discard Draft",
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
    { id: "new-thread", label: "New Thread", icon: "message-square-plus" },
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
      label: "Repository Settings",
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
  /** Offers "Mark as Read" in place of "Mark as Unread". */
  readonly isUnread?: boolean;
  /** Delete asks first (the confirm setting, or a kind that always confirms), so it reads "Delete…". */
  readonly confirmsDelete?: boolean;
  /** Archive rejects a thread with an attached provider, so disable it here rather than let the action fail. */
  readonly isRunning: boolean;
  /** The agent is already naming the thread again, so Regenerate Title waits. */
  readonly isRegeneratingTitle?: boolean;
  /** What the thread's environment understands; a kind's action still needs its server. */
  readonly supports: {
    readonly settlement: boolean;
    readonly snooze: boolean;
    /** Server understands thread.pin / thread.unpin. */
    readonly pinning: boolean;
    /** Server understands regenerateTitle on thread.meta.update. */
    readonly titleRegeneration?: boolean;
  };
  readonly snoozePresets: ReadonlyArray<SnoozePreset>;
  /** A usage-limit stop whose reset is ahead: whether it resumes then. Omitted otherwise. */
  readonly limitResume?: "scheduled" | "cancelled" | null;
  /** The thread's project folder and where it can move; omitted where folders are unknown. */
  readonly folder?: ThreadActionMenuFolder;
  /** Paired machines the thread can move to; omitted or empty on a standalone machine. */
  readonly machines?: ThreadActionMenuMachines;
}

export interface ThreadActionMenuMachines {
  /** Excludes the machine that runs the thread now. */
  readonly targets: ReadonlyArray<{
    readonly environmentId: string;
    readonly name: string;
    readonly online: boolean;
  }>;
  /** The move command's permission on the thread's environment. */
  readonly canMove: boolean;
}

/**
 * "Move to <machine>" for the one paired machine, or a "Move to Machine"
 * submenu with one item per machine. Offline machines show but stay disabled.
 * `countSuffix` labels a bulk move, such as " (12)".
 */
export function machineMenuItems(
  machines: ThreadActionMenuMachines | undefined,
  countSuffix = "",
): ReadonlyArray<ContextMenuItem<ThreadActionMenuId>> {
  if (machines === undefined || machines.targets.length === 0) return [];
  const item = (target: ThreadActionMenuMachines["targets"][number], label: string) => ({
    id: `move-machine:${target.environmentId}` as const,
    label: target.online ? label : `${label} (Offline)`,
    icon: "server",
    disabled: !machines.canMove || !target.online,
  });
  const [only] = machines.targets;
  if (machines.targets.length === 1 && only !== undefined) {
    return [item(only, `Move to ${only.name}${countSuffix}`)];
  }
  return [
    {
      id: "move-machine",
      label: `Move to Machine${countSuffix}`,
      icon: "server",
      disabled: !machines.canMove,
      children: machines.targets.map((target) => item(target, target.name)),
    },
  ];
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
  /** A chat with turns: picking a project forks it there instead of moving it. */
  readonly forks?: boolean;
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
 * "Move to folder" ("Fork into project" for a chat with turns, which goes
 * into a project as a fork) with "Open <folder>" first when filed, then every folder
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
      label: "Remove from Folder",
      disabled,
      separatorBefore: children.length > 0,
    });
  }
  children.push({
    id: "new-folder",
    label: "New Project…",
    separatorBefore: children.length > 0,
  });
  const label = folder.forks === true ? "Fork into Project" : "Move to Folder";
  return [{ id: "move-folder", label, icon: "folder", children }];
}

type MenuItems = ReadonlyArray<ContextMenuItem<ThreadActionMenuId>>;

/**
 * The sidebar row's right-click menu for one thread, in every mode (Chats,
 * Work, Agents). The thread's kind decides which actions exist at all; the state decides each
 * one's current direction (settle or un-settle, snooze or wake).
 *
 * Three groups: the thread's state, the thread itself, and removal.
 * Repository actions (new thread, settings, opening its folder) sit on the
 * Work list's repository heading.
 */
export function buildThreadActionMenuItems(state: ThreadActionMenuState): MenuItems {
  const can = state.capabilities;
  const status: MenuItems = [
    ...(can.startWork ? [{ id: "start-work" as const, label: "Start Work…", icon: "hammer" }] : []),
    ...(can.pin && state.supports.pinning
      ? [
          state.isPinned
            ? { id: "unpin" as const, label: "Unpin Thread", icon: "pin-off" }
            : { id: "pin" as const, label: "Pin Thread", icon: "pin" },
        ]
      : []),
    ...(can.settle && state.supports.settlement
      ? [
          state.isSettled
            ? { id: "unsettle" as const, label: "Un-settle Thread", icon: "circle-check" }
            : { id: "settle" as const, label: "Settle Thread", icon: "circle-check" },
        ]
      : []),
    ...(can.snooze && state.supports.snooze
      ? [
          state.isSnoozed
            ? { id: "unsnooze" as const, label: "Wake Thread", icon: "clock" }
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
    ...(state.limitResume === "scheduled"
      ? [{ id: "limit-resume:off" as const, label: "Don't Resume at Reset", icon: "timer-off" }]
      : state.limitResume === "cancelled"
        ? [{ id: "limit-resume:on" as const, label: "Resume at Reset", icon: "clock" }]
        : []),
    ...(can.markUnread
      ? [
          state.isUnread
            ? { id: "mark-read" as const, label: "Mark as Read", icon: "mail" }
            : { id: "mark-unread" as const, label: "Mark as Unread", icon: "mail-open" },
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
          { id: "copy-thread-link" as const, label: "Thread Link", icon: "link" },
          { id: "copy-thread-id" as const, label: "Thread ID", icon: "hash" },
        ]
      : []),
  ];
  const thread: MenuItems = [
    ...(can.rename ? [{ id: "rename" as const, label: "Rename…", icon: "pencil" }] : []),
    ...(can.regenerateTitle && state.supports.titleRegeneration === true
      ? [
          {
            id: "regenerate-title" as const,
            label: state.isRegeneratingTitle === true ? "Regenerating Title…" : "Regenerate Title",
            icon: "refresh-cw",
            disabled: state.isRegeneratingTitle === true,
          },
        ]
      : []),
    ...(can.projectFolder ? folderMenuItems(state.folder) : []),
    ...machineMenuItems(state.machines),
    ...(copyChildren.length > 0
      ? [{ id: "copy" as const, label: "Copy", icon: "copy", children: copyChildren }]
      : []),
    ...(can.agentSettings
      ? [{ id: "agent-settings" as const, label: "Agent Settings", icon: "settings" }]
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
            label: state.isRunning ? "Archive Thread (Stop It First)" : "Archive Thread",
            icon: "archive",
            disabled: state.isRunning,
          },
        ]
      : []),
    ...(can.delete !== false
      ? [
          {
            id: "delete" as const,
            // HIG: an ellipsis when the item asks before acting.
            label: state.confirmsDelete === true ? "Delete…" : "Delete",
            destructive: true,
            icon: "trash",
          },
        ]
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
