import type { ContextMenuItem } from "@t3tools/contracts";
import type { SnoozePreset } from "@t3tools/client-runtime/state/thread-settled";

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
  | "open-project"
  | `open-project:${string}`
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
  /** The thread's projects, each opening its project view; omitted where the surface shows tags itself. */
  readonly projects?: ReadonlyArray<{ readonly key: string; readonly name: string }>;
}

/** Local navigation, read markers, and copying remain available to read-only clients. */
export function threadActionRequiresOperate(action: ThreadActionMenuId): boolean {
  if (action.startsWith("open-project")) return false;
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

/** One project opens directly; several nest under "Open project". */
function projectMenuItems(
  projects: ReadonlyArray<{ readonly key: string; readonly name: string }>,
): ReadonlyArray<ContextMenuItem<ThreadActionMenuId>> {
  if (projects.length === 0) return [];
  if (projects.length === 1)
    return [
      { id: `open-project:${projects[0]!.key}`, label: `Open ${projects[0]!.name}`, icon: "tag" },
    ];
  return [
    {
      id: "open-project",
      label: "Open project",
      icon: "tag",
      children: projects.map((project) => ({
        id: `open-project:${project.key}` as const,
        label: project.name,
      })),
    },
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
    ...(can.startWork ? [{ id: "start-work" as const, label: "Start Work…", icon: "code" }] : []),
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
    ...(can.projectTags ? projectMenuItems(state.projects ?? []) : []),
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
