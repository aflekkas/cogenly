import { useSensor, useSensors, type DragEndEvent, type UniqueIdentifier } from "@dnd-kit/core";
import { arrayMove, SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { useAtomValue } from "@effect/atom-react";
import { planPinnedReorder } from "@t3tools/client-runtime/state/thread-sort";
import type { ContextMenuItem, EnvironmentId, ProjectLabelId } from "@t3tools/contracts";
import { formatThreadLink } from "@t3tools/shared/threadLinks";
import * as Schema from "effect/Schema";
import { EllipsisIcon } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { avatarFaceProps } from "~/components/agents/face/agentAvatar.logic";
import { AgentFace } from "~/components/agents/face";
import { ProviderInstanceIcon } from "~/components/chat/ProviderInstanceIcon";
import {
  SidebarDragLifecycle,
  SidebarSortSensor,
  type SidebarPointerSensor,
  type SidebarSortSensorOptions,
} from "~/components/Sidebar.pointer";
import { PanOnHoverText } from "~/components/sidebar/PanOnHoverText";
import { SidebarChatStatusSlot } from "~/components/sidebar/SidebarChatStatusSlot";
import {
  SidebarCardBody,
  sidebarCardClassName,
  SidebarCardItem,
  SidebarCardLine,
  SidebarList,
} from "~/components/sidebar/SidebarList";
import { SidebarListEmptyState } from "~/components/sidebar/SidebarListEmptyState";
import {
  SIDEBAR_SORT_DISTANCE,
  SidebarSortContext,
  sidebarGroupCollision,
  useSidebarSortableItem,
} from "~/components/sidebar/SidebarSortable";
import { useSidebarRowActionsOverlap } from "~/components/sidebar/useSidebarRowActionsOverlap";
import {
  applyDrawnOrder,
  moveInOrder,
  placeInGroupOrder,
} from "~/components/sidebar/workCards.logic";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Button } from "~/components/ui/button";
import { OverlayPresence } from "~/components/ui/overlay-presence";
import { PopoverTrigger } from "~/components/ui/popover";
import { showCopiedToast, showCopyFailedToast } from "~/components/ui/copiedToast";
import { toastManager } from "~/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { useMediaQuery } from "~/hooks/useMediaQuery";
import { useStableCallback } from "~/hooks/useStableCallback";
import { cn } from "~/lib/utils";
import { readLocalApi } from "~/localApi";
import {
  isProjectLabelArchived,
  projectLabelColorValue,
  type EnvironmentProjectLabel,
} from "~/projectLabels/projectLabels.logic";
import { toggleCollapsedGroup } from "~/projectLabels/projectMeta.logic";
import { useProjectLabelDirectory } from "~/projectLabels/useProjectLabels";
import { deriveProviderInstanceEntries } from "~/providerInstances";
import { agentsRpc } from "~/rpc/agents";
import { useServerConfigs } from "~/state/entities";
import { formatRelativeTime } from "~/timestampFormat";
import { takeAgentArrival } from "./agentArrivals";
import { groupAgentsByProject, orderAgentsForList } from "./agentGroups.logic";
import { AgentProjectGroup } from "./AgentProjectGroup";
import { requestAgentCreation } from "./AgentsCreateHost";
import { useShownAgentListFilter } from "./AgentsShelfBar";
import { AgentAvatarPicker } from "./AgentAvatarPicker";
import { agentViewKey, requestAgentView } from "./agentViewIntent";
import { agentContactKey, agentDraft, agentStatusLabel } from "./agents.logic";
import { agentAttentionCount } from "./agentWorkspace.logic";
import { useAgentUnread, useAgents, useAgentsClient } from "./agentsClient";
import type { AgentContact } from "./agents.types";
import { useAgentGroupFlip } from "./useAgentGroupFlip";

type AgentMenuAction =
  | "open"
  | "details"
  | "rename"
  | "face"
  | "move-project"
  | `move-project:${string}`
  | "move-project-none"
  | "mark-read"
  | "copy-link"
  | "delete";

// Project groups the user collapsed in the Agents list, kept per device.
const COLLAPSED_GROUPS_STORAGE_KEY = "cogenly:agents:collapsed-projects";
const CollapsedGroupKeys = Schema.mutable(Schema.Array(Schema.String));
const EMPTY_GROUP_KEYS: string[] = [];
const EMPTY_FOLDERS: ReadonlyArray<EnvironmentProjectLabel> = [];
const EMPTY_SORT_ITEMS: string[] = [];

const flipKey = (agent: AgentContact) => `agent:${agentContactKey(agent)}`;

/**
 * The Agents list: one card per agent, the size of a Work card (its face,
 * then its name and status over two lines of its latest reply). Like the
 * other lists it stacks up from the bottom of the column against the search
 * dock. Once any agent is filed in a project, cards group under their project
 * folders (in name order, No project last), each group collapsible; a group's
 * right-click menu starts a new agent in it. Cards sort inside their group by
 * drag or alt+arrow, as Work's do (`orderAgentsForList`). The Needs attention
 * filter keeps only agents waiting on you, inside their groups.
 */
export function AgentContacts({
  activeKey,
  onOpen,
}: {
  activeKey: string | null;
  onOpen: (agent: AgentContact) => void;
  /** Unused since the empty state moved to the index route; kept so callers stay stable. */
  onCreate: () => void;
}) {
  const { agents, loading, reconnecting, error } = useAgents();
  const client = useAgentsClient();
  const { filter } = useShownAgentListFilter();
  const environmentKey = [...new Set(agents.map((agent) => agent.environmentId))].join("\0");
  const environmentIds = useMemo(
    () => (environmentKey === "" ? [] : (environmentKey.split("\0") as EnvironmentId[])),
    [environmentKey],
  );
  const directory = useProjectLabelDirectory(environmentIds);
  const foldersByEnvironment = useMemo(() => {
    const map = new Map<EnvironmentId, EnvironmentProjectLabel[]>();
    for (const entry of directory.labels) {
      const list = map.get(entry.environmentId);
      if (list) list.push(entry);
      else map.set(entry.environmentId, [entry]);
    }
    return map;
  }, [directory.labels]);
  // A drop's order holds until the list's own order matches it (`settled`
  // once its writes are saved), so the cards never swing back and forth.
  const [dragPreview, setDragPreview] = useState<{
    readonly key: string;
    readonly order: readonly string[];
    readonly settled?: boolean;
  } | null>(null);
  const { grouped, groups, dropLanded } = useMemo(() => {
    const result = groupAgentsByProject({
      agents: orderAgentsForList(agents),
      folders: directory.labels,
      include: filter === "attention" ? (agent) => agentAttentionCount(agent) > 0 : undefined,
    });
    if (dragPreview === null) return { ...result, dropLanded: true };
    let landed = true;
    const previewed = result.groups.map((group) => {
      if (!group.agents.some((agent) => agentContactKey(agent) === dragPreview.key)) return group;
      const byKey = new Map(group.agents.map((agent) => [agentContactKey(agent), agent]));
      const saved = [...byKey.keys()];
      const order = applyDrawnOrder(saved, dragPreview.order);
      if (order.some((key, index) => saved[index] !== key)) landed = false;
      return { ...group, agents: order.map((key) => byKey.get(key)!) };
    });
    return { ...result, groups: previewed, dropLanded: landed };
  }, [agents, directory.labels, filter, dragPreview]);
  useEffect(() => {
    if (dragPreview?.settled !== true) return;
    const key = dragPreview.key;
    const release = () => setDragPreview((current) => (current?.key === key ? null : current));
    if (dropLanded) {
      release();
      return;
    }
    // Moved elsewhere too: let go after a while and show the saved order.
    const timer = window.setTimeout(release, 4000);
    return () => window.clearTimeout(timer);
  }, [dragPreview, dropLanded]);
  const [collapsedGroupKeys, setCollapsedGroupKeys] = useLocalStorage(
    COLLAPSED_GROUPS_STORAGE_KEY,
    EMPTY_GROUP_KEYS,
    CollapsedGroupKeys,
  );
  // The cards that can move, per open group: agents this connection may arrange,
  // in groups of two or more. A card only ever moves among its own group's.
  const sort = useMemo(() => {
    const groupOf = new Map<string, string>();
    const orders = new Map<string, string[]>();
    const drawn = new Map<string, string[]>();
    for (const group of groups) {
      if (grouped && collapsedGroupKeys.includes(group.key)) continue;
      const keys = group.agents.flatMap((agent) =>
        client.canReorder?.(agent) ? [agentContactKey(agent)] : [],
      );
      if (keys.length < 2) continue;
      orders.set(group.key, keys);
      drawn.set(group.key, group.agents.map(agentContactKey));
      for (const key of keys) groupOf.set(key, group.key);
    }
    return { groupOf, orders, drawn };
  }, [client, collapsedGroupKeys, groups, grouped]);
  const [reorderAnnouncement, setReorderAnnouncement] = useState("");
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  /** The sortable cards of `key`'s group as drawn, when it can move in one. */
  const groupOrderOf = (key: string) => {
    const groupKey = sort.groupOf.get(key);
    return groupKey === undefined ? undefined : sort.orders.get(groupKey);
  };
  /** Moves `key` to its place in `groupOrder` (its group's sortable cards, reordered) and saves it. */
  const commitReorder = (key: string, groupOrder: readonly string[]) => {
    const groupKey = sort.groupOf.get(key);
    const drawn = groupKey === undefined ? undefined : sort.drawn.get(groupKey);
    if (!drawn || !client.reorder) return;
    const byKey = new Map(agents.map((agent) => [agentContactKey(agent), agent]));
    const writes = planPinnedReorder({
      orderedIds: groupOrder,
      // Every agent's key, so a new one never repeats a key held elsewhere.
      keysById: new Map([...byKey].map(([id, agent]) => [id, agent.orderKey ?? null])),
      movedId: key,
    });
    if (writes.length === 0) return;
    setDragPreview({ key, order: placeInGroupOrder(drawn, groupOrder, key) });
    void client
      .reorder(
        writes.flatMap(({ id, orderKey }) => {
          const agent = byKey.get(id);
          return agent ? [{ agent, orderKey }] : [];
        }),
      )
      .then(
        () =>
          setDragPreview((current) =>
            current?.key === key ? { ...current, settled: true } : current,
          ),
        (cause: unknown) => {
          setDragPreview((current) => (current?.key === key ? null : current));
          toastManager.add({
            type: "error",
            title: "Could not reorder agents",
            description: cause instanceof Error ? cause.message : undefined,
          });
        },
      );
  };
  /** alt+ArrowUp / alt+ArrowDown on a focused agent moves it one place in its group. */
  const moveAgent = (agent: AgentContact, delta: -1 | 1): boolean => {
    const key = agentContactKey(agent);
    const groupOrder = groupOrderOf(key);
    if (!groupOrder) return false;
    const next = moveInOrder(groupOrder, key, delta);
    if (next === null) return true;
    setReorderAnnouncement(`${agent.name} moved to ${next.indexOf(key) + 1} of ${next.length}`);
    commitReorder(key, next);
    return true;
  };
  const sensorRef = useRef<SidebarPointerSensor | null>(null);
  const cancelSort = useCallback(() => sensorRef.current?.cancel(), []);
  const sensorOptions = useMemo(
    (): SidebarSortSensorOptions => ({
      distance: SIDEBAR_SORT_DISTANCE,
      canActivate: () => sensorRef.current === null,
      onAttach: (sensor) => {
        sensorRef.current = sensor;
      },
      onFinish: () => {
        sensorRef.current = null;
      },
    }),
    [],
  );
  const sensors = useSensors(useSensor(SidebarSortSensor, sensorOptions));
  // Read while a card is dragged, never during render.
  const sortGroupOf = useStableCallback((id: string) => sort.groupOf.get(id));
  const collision = useMemo(() => sidebarGroupCollision(sortGroupOf), [sortGroupOf]);
  const describeAgent = useStableCallback(
    (id: UniqueIdentifier) =>
      agents.find((agent) => agentContactKey(agent) === String(id))?.name ?? "Agent",
  );
  const handleSortEnd = ({ active, over }: DragEndEvent) => {
    const key = String(active.id);
    const groupOrder = groupOrderOf(key);
    if (over === null || !groupOrder) return;
    const from = groupOrder.indexOf(key);
    const to = groupOrder.indexOf(String(over.id));
    if (from === -1 || to === -1 || from === to) return;
    commitReorder(key, arrayMove([...groupOrder], from, to));
  };
  const listRef = useRef<HTMLUListElement | null>(null);
  const flipFolders = useMemo(
    () => new Map(agents.map((agent) => [flipKey(agent), agent.projectFolderId] as const)),
    [agents],
  );
  const { onTransitionEnd } = useAgentGroupFlip(listRef, flipFolders);
  const shownCount = groups.reduce((count, group) => count + group.agents.length, 0);
  return (
    <>
      {error && (
        <p role="alert" className="agent-error">
          {error}
        </p>
      )}
      {loading && (
        <p
          role="status"
          className="flex flex-1 flex-col items-center justify-center gap-2 px-2 py-6 text-center text-xs text-muted-foreground reveal-motion"
        >
          Connecting to your agents…
        </p>
      )}
      {reconnecting && !loading && (
        <p role="status" className="px-2.5 py-1 text-2xs text-muted-foreground reveal-motion">
          Reconnecting…
        </p>
      )}
      {/* With no agents at all the list column is hidden and the index route shows
          the one empty state; only the attention filter can be empty here. */}
      <SidebarSortContext
        sensors={sensors}
        collisionDetection={collision}
        onDragEnd={handleSortEnd}
        describe={describeAgent}
      >
        <SidebarDragLifecycle onUnmount={cancelSort} />
        {/* Announces keyboard reorders (alt+arrow). */}
        <span role="status" aria-live="polite" className="sr-only">
          {reorderAnnouncement}
        </span>
        <SidebarList
          ref={listRef}
          key={filter}
          aria-label={filter === "attention" ? "Agents needing attention" : "Agents"}
          data-agents-list
          // Groups hold cards: no row gap between them, only the group space.
          density="cards"
          className="reveal-motion"
          grow={shownCount > 0 || !loading}
          onTransitionEnd={onTransitionEnd}
        >
          {shownCount === 0 && !loading && !reconnecting ? (
            // A filter never lands on nothing (see useShownAgentListFilter), so
            // only a list with no agents at all gets here.
            <li className="flex flex-1 list-none">
              <SidebarListEmptyState
                label="No agents yet"
                action={{
                  label: "New agent",
                  onClick: () => requestAgentCreation(agents[0]?.environmentId ?? null),
                }}
              />
            </li>
          ) : null}
          {groups.map((group) => (
            <AgentProjectGroup
              key={group.key}
              groupKey={group.key}
              folder={group.folder}
              heading={grouped}
              count={group.agents.length}
              open={!collapsedGroupKeys.includes(group.key)}
              onToggle={() =>
                setCollapsedGroupKeys((keys) => toggleCollapsedGroup(keys, group.key))
              }
              onCreate={
                group.folder && (client.canWrite?.(group.folder.environmentId) ?? true)
                  ? () => {
                      const { environmentId, label } = group.folder!;
                      requestAgentCreation(environmentId, { projectFolderId: label.id });
                    }
                  : undefined
              }
            >
              <SortableContext
                id={`agent-sort:${group.key}`}
                items={sort.orders.get(group.key) ?? EMPTY_SORT_ITEMS}
                strategy={verticalListSortingStrategy}
              >
                {group.agents.map((agent) => (
                  <AgentRow
                    key={agentContactKey(agent)}
                    agent={agent}
                    active={activeKey === agentContactKey(agent)}
                    folders={foldersByEnvironment.get(agent.environmentId) ?? EMPTY_FOLDERS}
                    sortable={sort.groupOf.has(agentContactKey(agent))}
                    reducedMotion={reducedMotion}
                    onOpen={onOpen}
                    onMove={moveAgent}
                  />
                ))}
              </SortableContext>
            </AgentProjectGroup>
          ))}
        </SidebarList>
      </SidebarSortContext>
    </>
  );
}

function summaryLine(agent: AgentContact): string {
  const latest = agent.latestMessage;
  const text = latest?.role === "assistant" ? latest.text : agent.responsibility;
  // Two clamped lines of it; the cap keeps a long reply out of the DOM.
  return text.slice(0, 400).replace(/\s+/g, " ").trim();
}

function AgentRow({
  agent,
  active,
  folders,
  sortable,
  reducedMotion,
  onOpen,
  onMove,
}: {
  agent: AgentContact;
  active: boolean;
  /** The project folders on the agent's environment, for Move to project. */
  folders: ReadonlyArray<EnvironmentProjectLabel>;
  /** The card can be dragged (or alt+arrowed) to a new place in its group. */
  sortable: boolean;
  reducedMotion: boolean;
  onOpen: (agent: AgentContact) => void;
  /** Moves the card one place; false when it cannot move in its group. */
  onMove: (agent: AgentContact, delta: -1 | 1) => boolean;
}) {
  const client = useAgentsClient();
  const canWrite = client.canWrite?.(agent.environmentId) ?? true;
  const canMoveProject = useAtomValue(agentsRpc.setProject.permissionAtom(agent.environmentId));
  const currentFolderId = folders.some((entry) => entry.label.id === agent.projectFolderId)
    ? agent.projectFolderId
    : null;
  const unread = useAgentUnread(agent);
  const status = agentStatusLabel(agent);
  // Only decisions waiting on the owner earn a count; unread replies get a dot.
  const attention = agentAttentionCount(agent);
  const running = agent.state === "thinking" || agent.state === "working";
  // A row for an agent made in this session fades in once, when it first mounts.
  const [arrived] = useState(() => takeAgentArrival(agentContactKey(agent)));
  const setRowElement = useSidebarRowActionsOverlap();
  const rowRef = useRef<HTMLDivElement | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [facePicker, setFacePicker] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [pending, setPending] = useState(false);
  const since = formatRelativeTime(agent.updatedAt);
  const configs = useServerConfigs();
  const providerEntry = useMemo(
    () =>
      deriveProviderInstanceEntries(configs.get(agent.environmentId)?.providers ?? []).find(
        (entry) => entry.instanceId === agent.modelSelection.instanceId,
      ) ?? null,
    [configs, agent.environmentId, agent.modelSelection.instanceId],
  );
  const { copyToClipboard } = useCopyToClipboard<{ link: string }>({
    onCopy: ({ link }) => showCopiedToast({ kind: "thread-link", link, threadTitle: agent.name }),
    onError: (cause) => showCopyFailedToast(cause),
  });
  const fail = (cause: unknown, fallback: string) =>
    toastManager.add({
      type: "error",
      title: fallback,
      description: cause instanceof Error ? cause.message : undefined,
    });
  const mutate = async (action: () => Promise<unknown>, fallback: string) => {
    if (pending) return;
    setPending(true);
    try {
      await action();
    } catch (cause) {
      fail(cause, fallback);
    } finally {
      setPending(false);
    }
  };
  const latestReply = agent.latestMessage?.role === "assistant" ? agent.latestMessage : null;

  const run = (action: AgentMenuAction) => {
    switch (action) {
      case "open":
        onOpen(agent);
        return;
      case "details":
        requestAgentView(agentViewKey(agent), "details");
        onOpen(agent);
        return;
      case "rename":
        setRenaming(agent.name);
        return;
      case "face":
        setFacePicker(true);
        return;
      case "move-project":
        return;
      case "move-project-none":
        if (currentFolderId !== null)
          void mutate(() => client.setProject(agent, null), "Could not move the agent");
        return;
      case "mark-read":
        if (latestReply)
          void mutate(() => client.markRead(agent, latestReply.id), "Could not mark as read");
        return;
      case "copy-link": {
        const link = formatThreadLink(agent.conversationThreadId, agent.name);
        copyToClipboard(link, { link });
        return;
      }
      case "delete":
        setConfirmingDelete(true);
        return;
      default: {
        const folderId = action.slice("move-project:".length) as ProjectLabelId;
        if (folderId !== currentFolderId)
          void mutate(() => client.setProject(agent, folderId), "Could not move the agent");
      }
    }
  };
  // The same menu as a thread row: the desktop's native menu, or the web fallback.
  const openMenu = async (position: { x: number; y: number }) => {
    const api = readLocalApi();
    if (!api) return;
    const items: ContextMenuItem<AgentMenuAction>[] = [
      { id: "open", label: "Open", icon: "mail-open" },
      { id: "details", label: "Open Details", icon: "settings" },
      { id: "rename", label: "Rename", icon: "pencil", disabled: !canWrite },
      { id: "face", label: "Change Face…", disabled: !canWrite },
      ...(folders.length > 0 || currentFolderId !== null
        ? [
            {
              id: "move-project" as const,
              label: "Move to Project",
              icon: "folder",
              disabled: !canMoveProject,
              children: [
                // Archived projects are not offered, except the one it is in.
                ...folders
                  .filter(
                    (entry) =>
                      !isProjectLabelArchived(entry.label) || entry.label.id === currentFolderId,
                  )
                  .map((entry) => ({
                    id: `move-project:${entry.label.id}` as const,
                    label: entry.label.name,
                    icon: "folder",
                    iconColor: projectLabelColorValue(entry.label.color),
                    checked: entry.label.id === currentFolderId,
                    disabled: entry.label.id === currentFolderId,
                  })),
                {
                  id: "move-project-none" as const,
                  label: "No Project",
                  checked: currentFolderId === null,
                  disabled: currentFolderId === null,
                  separatorBefore: folders.length > 0,
                },
              ],
            },
          ]
        : []),
      ...(unread > 0 && latestReply
        ? [{ id: "mark-read" as const, label: "Mark as Read", icon: "check" }]
        : []),
      { id: "copy-link", label: "Copy Link", icon: "link" },
      {
        id: "delete",
        label: "Delete…",
        icon: "trash",
        destructive: true,
        separatorBefore: true,
        disabled: !canWrite,
      },
    ];
    const clicked = await api.contextMenu.show(items, position);
    if (clicked) run(clicked);
  };
  const onContextMenu = (event: ReactMouseEvent) => {
    event.preventDefault();
    void openMenu({ x: event.clientX, y: event.clientY });
  };
  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (event.target !== event.currentTarget) return;
    if (
      event.altKey &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.shiftKey &&
      (event.key === "ArrowUp" || event.key === "ArrowDown")
    ) {
      if (!onMove(agent, event.key === "ArrowUp" ? -1 : 1)) return;
      event.preventDefault();
      // Moving a card can drop focus from it; keep it on the card that moved.
      const focused = event.currentTarget as HTMLElement;
      requestAnimationFrame(() => {
        if (focused.isConnected && document.activeElement !== focused) focused.focus();
      });
      return;
    }
    if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
      event.preventDefault();
      const rect = event.currentTarget.getBoundingClientRect();
      void openMenu({ x: rect.left, y: rect.bottom });
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onOpen(agent);
    }
  };
  const commitRename = () => {
    const name = renaming?.trim() ?? "";
    setRenaming(null);
    if (!name || name === agent.name) return;
    void mutate(
      () => client.save(agent.environmentId, { ...agentDraft(agent), name }),
      "Could not rename",
    );
  };
  const summary = summaryLine(agent);
  const modelLabel = providerEntry
    ? `${providerEntry.displayName} · ${agent.modelSelection.model}`
    : agent.modelSelection.model;
  const sortItem = useSidebarSortableItem({
    id: agentContactKey(agent),
    sortable: sortable && renaming === null,
    reducedMotion,
  });

  return (
    <SidebarCardItem
      {...sortItem.listeners}
      ref={sortItem.setNodeRef}
      style={sortItem.style}
      data-agent-flip={flipKey(agent)}
      className={cn("relative", sortItem.className)}
    >
      <div
        ref={(node) => {
          rowRef.current = node;
          setRowElement(node);
        }}
        role="button"
        tabIndex={0}
        aria-label={`${agent.name}, ${status}`}
        aria-current={active ? "page" : undefined}
        data-testid="sidebar-row-agent"
        data-actions-pinned={facePicker || undefined}
        className={sidebarCardClassName({
          selected: active,
          className: arrived && "swap-motion",
        })}
        onClick={() => {
          if (renaming === null) onOpen(agent);
        }}
        onDoubleClick={(event) => {
          if (!canWrite || (event.target as HTMLElement).closest("button, input")) return;
          event.preventDefault();
          setRenaming(agent.name);
        }}
        onKeyDown={onKeyDown}
        onContextMenu={onContextMenu}
      >
        {/* The face beside a 20px name line and two 16px lines of the latest
            reply, centred in a Work card's height so both lists share a pitch. */}
        <SidebarCardBody>
          <div className="flex min-w-0 gap-2.5">
            <AgentAvatarPicker
              avatar={agent.avatar}
              open={facePicker}
              onOpenChange={setFacePicker}
              onChange={(avatar) =>
                void mutate(
                  () => client.save(agent.environmentId, { ...agentDraft(agent), avatar }),
                  "Could not change the face",
                )
              }
            >
              <PopoverTrigger
                render={
                  <span className="flex size-8 shrink-0 items-center justify-center" aria-hidden />
                }
                tabIndex={-1}
                onClick={(event) => event.stopPropagation()}
              >
                <AgentFace {...avatarFaceProps(agent.avatar)} state={agent.state} size={32} />
              </PopoverTrigger>
            </AgentAvatarPicker>
            <div className="flex min-w-0 flex-1 flex-col">
              <SidebarCardLine line="head">
                {renaming !== null && canWrite ? (
                  <input
                    autoFocus
                    value={renaming}
                    aria-label="Agent name"
                    maxLength={200}
                    onChange={(event) => setRenaming(event.target.value)}
                    onFocus={(event) => event.currentTarget.select()}
                    onKeyDown={(event) => {
                      event.stopPropagation();
                      if (event.key === "Enter") {
                        event.preventDefault();
                        commitRename();
                      } else if (event.key === "Escape") {
                        event.preventDefault();
                        setRenaming(null);
                      }
                    }}
                    onBlur={commitRename}
                    onClick={(event) => event.stopPropagation()}
                    className="min-w-0 flex-1 rounded-sm border border-input bg-card px-1 text-sm text-card-foreground outline-none focus:border-foreground"
                  />
                ) : (
                  <PanOnHoverText
                    className={cn(
                      "min-w-0 flex-1 text-sm",
                      unread > 0 || attention > 0 ? "font-medium text-foreground" : "font-normal",
                      active
                        ? "text-foreground"
                        : !(unread > 0 || attention > 0) && "text-foreground/80",
                    )}
                  >
                    <span aria-hidden>{agent.name}</span>
                  </PanOnHoverText>
                )}
                {providerEntry ? (
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <span
                          role="img"
                          aria-label={`Model: ${modelLabel}`}
                          className="inline-flex shrink-0 items-center"
                        />
                      }
                    >
                      <ProviderInstanceIcon
                        driverKind={providerEntry.driverKind}
                        displayName={providerEntry.displayName}
                        accentColor={providerEntry.accentColor}
                        showBadge={providerEntry.accentColor !== undefined}
                        iconClassName="size-3.5 opacity-60"
                      />
                    </TooltipTrigger>
                    <TooltipPopup side="top">{modelLabel}</TooltipPopup>
                  </Tooltip>
                ) : null}
                {/* The status owns this slot's width; the hover actions cross-fade
                in over it, so the name never reflows. */}
                <span className="group/sidebar-status-slot relative ml-auto flex h-5 min-w-8 shrink-0 items-stretch justify-end text-xs">
                  <span className="pointer-events-none flex items-center gap-1.5 self-center justify-self-end tabular-nums text-secondary-label transition-opacity duration-(--motion-duration-base) ease-standard group-has-[:focus-visible]/sidebar-status-slot:opacity-0 group-any-hover/sidebar-row:opacity-0 motion-reduce:transition-none">
                    {attention > 0 ? (
                      <span
                        key="attention"
                        className="swap-motion inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-warning px-1 text-2xs font-semibold leading-none text-background"
                        aria-label={`${attention} waiting on you`}
                      >
                        {attention > 99 ? "99+" : attention}
                      </span>
                    ) : null}
                    <SidebarChatStatusSlot
                      isRunning={running}
                      dot={attention > 0 ? "warning" : unread > 0 ? "info" : null}
                    />
                    {!running && since ? (
                      <span key="time" className="swap-motion">
                        {since.value}
                      </span>
                    ) : null}
                  </span>
                  <span
                    data-row-hover-actions=""
                    className="pointer-events-none absolute inset-y-0 right-0 flex items-stretch opacity-0 transition-opacity duration-(--motion-duration-base) ease-standard has-[:focus-visible]:pointer-events-auto has-[:focus-visible]:opacity-100 group-any-hover/sidebar-row:pointer-events-auto group-any-hover/sidebar-row:opacity-100 motion-reduce:transition-none"
                  >
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <button
                            type="button"
                            aria-label={`More for ${agent.name}`}
                            aria-haspopup="menu"
                            onClick={(event) => {
                              event.stopPropagation();
                              const rect = event.currentTarget.getBoundingClientRect();
                              void openMenu({ x: rect.right, y: rect.bottom });
                            }}
                            onPointerDown={(event) => event.stopPropagation()}
                            className="inline-flex cursor-pointer items-center rounded-md bg-transparent px-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
                          />
                        }
                      >
                        <EllipsisIcon className="size-3.5" />
                      </TooltipTrigger>
                      <TooltipPopup side="top">More</TooltipPopup>
                    </Tooltip>
                  </span>
                </span>
              </SidebarCardLine>
              {/* The latest reply (or the agent's job), two muted lines that
              brighten a step while the card is selected. */}
              <span className="mt-1 line-clamp-2 h-8 min-w-0 text-xs leading-4 text-muted-foreground transition-colors duration-(--motion-duration-fast) ease-standard group-[.state-selected]/sidebar-row:text-secondary-label motion-reduce:transition-none">
                {summary || status}
              </span>
            </div>
          </div>
        </SidebarCardBody>
      </div>
      <OverlayPresence when={confirmingDelete}>
        {() => (
          <AlertDialog open onOpenChange={(open) => !open && setConfirmingDelete(false)}>
            <AlertDialogPopup>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete {agent.name}?</AlertDialogTitle>
                <AlertDialogDescription>
                  Its triggers and memory go with it. Its conversation and Work threads remain.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
                <Button
                  variant="destructive"
                  disabled={pending}
                  onClick={() =>
                    void mutate(async () => {
                      await client.remove(agent);
                      setConfirmingDelete(false);
                    }, "Could not delete the agent")
                  }
                >
                  Delete
                </Button>
              </AlertDialogFooter>
            </AlertDialogPopup>
          </AlertDialog>
        )}
      </OverlayPresence>
    </SidebarCardItem>
  );
}
