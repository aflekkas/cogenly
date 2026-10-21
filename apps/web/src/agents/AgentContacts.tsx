import type { ContextMenuItem } from "@t3tools/contracts";
import { formatThreadLink } from "@t3tools/shared/threadLinks";
import { BellDotIcon, EllipsisIcon } from "lucide-react";
import {
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { avatarFaceProps } from "~/components/agents/face/agentAvatar.logic";
import { AgentFace } from "~/components/agents/face";
import { ProviderInstanceIcon } from "~/components/chat/ProviderInstanceIcon";
import { PanOnHoverText } from "~/components/sidebar/PanOnHoverText";
import { SidebarChatStatusSlot } from "~/components/sidebar/SidebarChatStatusSlot";
import { SidebarListEmptyState } from "~/components/sidebar/SidebarListEmptyState";
import { useSidebarRowActionsOverlap } from "~/components/sidebar/useSidebarRowActionsOverlap";
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
import { toastManager } from "~/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { cn } from "~/lib/utils";
import { readLocalApi } from "~/localApi";
import { deriveProviderInstanceEntries } from "~/providerInstances";
import { useServerConfigs } from "~/state/entities";
import { formatRelativeTime } from "~/timestampFormat";
import { takeAgentArrival } from "./agentArrivals";
import { useAgentListFilter } from "./agentListFilter";
import { AgentAvatarPicker } from "./AgentAvatarPicker";
import { agentViewKey, requestAgentView } from "./agentViewIntent";
import { agentContactKey, agentDraft, agentStatusLabel } from "./agents.logic";
import { agentAttentionCount } from "./agentWorkspace.logic";
import { useAgentUnread, useAgents, useAgentsClient } from "./agentsClient";
import type { AgentContact } from "./agents.types";

type AgentMenuAction =
  | "open"
  | "details"
  | "rename"
  | "face"
  | "mark-read"
  | "copy-link"
  | "delete";

/**
 * The Agents list: one card per agent, with Work's card geometry and surfaces. Like
 * Chats and Work it stacks up from the bottom of the column against the search dock.
 * The Needs attention filter keeps only agents waiting on you.
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
  const { agents, loading, error } = useAgents();
  const filter = useAgentListFilter();
  const shown =
    filter === "attention" ? agents.filter((agent) => agentAttentionCount(agent) > 0) : agents;
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
      {/* With no agents at all the list column is hidden and the index route shows
          the one empty state; only the attention filter can be empty here. */}
      <ul
        key={filter}
        aria-label={filter === "attention" ? "Agents needing attention" : "Agents"}
        data-agents-list
        className={cn(
          "reveal-motion relative flex flex-col gap-0.5",
          // The list stacks up from the bottom, against the search dock.
          (shown.length > 0 || !loading) && "flex-1 justify-end",
        )}
      >
        {shown.length === 0 && !loading && filter === "attention" ? (
          <li className="flex flex-1 list-none">
            <SidebarListEmptyState icon={BellDotIcon}>
              No agent needs you right now
            </SidebarListEmptyState>
          </li>
        ) : null}
        {shown.map((agent) => (
          <AgentCard
            key={agentContactKey(agent)}
            agent={agent}
            active={activeKey === agentContactKey(agent)}
            onOpen={onOpen}
          />
        ))}
      </ul>
    </>
  );
}

function summaryLine(agent: AgentContact): string {
  const latest = agent.latestMessage;
  const text = (latest?.role === "assistant" ? latest.text : agent.responsibility).trim();
  return text.split("\n")[0] ?? "";
}

function AgentCard({
  agent,
  active,
  onOpen,
}: {
  agent: AgentContact;
  active: boolean;
  onOpen: (agent: AgentContact) => void;
}) {
  const client = useAgentsClient();
  const canWrite = client.canWrite?.(agent.environmentId) ?? true;
  const unread = useAgentUnread(agent);
  const status = agentStatusLabel(agent);
  // Only decisions waiting on the owner earn a count; unread replies get a dot.
  const attention = agentAttentionCount(agent);
  const running = agent.state === "thinking" || agent.state === "working";
  // A card for an agent made in this session rises into place once, when it first mounts.
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
    onCopy: ({ link }) =>
      toastManager.add({ type: "success", title: "Agent link copied", description: link }),
    onError: (cause) =>
      toastManager.add({ type: "error", title: "Could not copy", description: cause.message }),
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
    }
  };
  // The same menu as a thread row: the desktop's native menu, or the web fallback.
  const openMenu = async (position: { x: number; y: number }) => {
    const api = readLocalApi();
    if (!api) return;
    const items: ContextMenuItem<AgentMenuAction>[] = [
      { id: "open", label: "Open", icon: "mail-open" },
      { id: "details", label: "Open details", icon: "settings" },
      { id: "rename", label: "Rename", icon: "pencil", disabled: !canWrite },
      { id: "face", label: "Change face…", disabled: !canWrite },
      ...(unread > 0 && latestReply
        ? [{ id: "mark-read" as const, label: "Mark as read", icon: "check" }]
        : []),
      { id: "copy-link", label: "Copy link", icon: "link" },
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

  return (
    <li className="list-none py-1 [content-visibility:auto] [contain-intrinsic-size:auto_64px]">
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
        className={cn(
          "group/sidebar-row sidebar-row-motion relative w-full cursor-pointer overflow-hidden rounded-rail text-left outline-none select-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          active ? "state-selected" : "state-hover bg-(--sidebar-card) text-sidebar-foreground",
          arrived && "swap-motion",
        )}
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
        <div className="relative z-10 h-[66px] px-(--sidebar-row-content-inset) py-(--sidebar-content-inset)">
          <div className="flex h-5 min-w-0 items-center gap-1.5">
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
                render={<span className="flex shrink-0 items-center" aria-hidden />}
                tabIndex={-1}
                onClick={(event) => event.stopPropagation()}
              >
                <AgentFace {...avatarFaceProps(agent.avatar)} state={agent.state} size={16} />
              </PopoverTrigger>
            </AgentAvatarPicker>
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
            {/* The status owns this slot's width; the hover actions cross-fade
                in over it, so the name never reflows. */}
            <span className="group/sidebar-status-slot relative ml-auto flex h-5 min-w-8 shrink-0 items-stretch justify-end text-xs">
              <span className="pointer-events-none flex items-center gap-1.5 self-center justify-self-end tabular-nums text-secondary-label transition-[opacity,translate] duration-(--motion-duration-base) ease-standard group-has-[:focus-visible]/sidebar-status-slot:-translate-x-1 group-has-[:focus-visible]/sidebar-status-slot:opacity-0 group-any-hover/sidebar-row:-translate-x-1 group-any-hover/sidebar-row:opacity-0 motion-reduce:transition-none">
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
                className="pointer-events-none absolute inset-y-0 right-0 flex translate-x-1 items-stretch opacity-0 transition-[opacity,translate] duration-(--motion-duration-base) ease-standard has-[:focus-visible]:pointer-events-auto has-[:focus-visible]:translate-x-0 has-[:focus-visible]:opacity-100 group-any-hover/sidebar-row:pointer-events-auto group-any-hover/sidebar-row:translate-x-0 group-any-hover/sidebar-row:opacity-100 motion-reduce:transition-none"
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
          </div>
          {/* Barely there at rest, a step up when selected, like a Work card's meta line. */}
          <div className="mt-1 flex min-w-0 items-center gap-1.5 text-foreground/12 text-xs transition-colors duration-(--motion-duration-base) group-[.state-selected]/sidebar-row:text-foreground/23 motion-reduce:transition-none">
            <span className="min-w-0 flex-1 fade-truncate">{summary || status}</span>
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
                    iconClassName="size-3.5 opacity-60"
                  />
                </TooltipTrigger>
                <TooltipPopup side="top">{modelLabel}</TooltipPopup>
              </Tooltip>
            ) : null}
          </div>
        </div>
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
    </li>
  );
}
