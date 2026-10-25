import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@cogenly/client-runtime/environment";
import type { EnvironmentThreadShell } from "@cogenly/client-runtime/state/models";
import type { ThreadId } from "@cogenly/contracts";
import { EllipsisIcon } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";

import { cn } from "~/lib/utils";

import { shortcutLabelForCommand } from "~/keybindings";
import { primaryServerKeybindingsAtom } from "~/state/server";
import { useThreadShell } from "~/state/entities";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { WorkspacePageTitle } from "../WorkspacePageTitle";
import { formatWorkHandoffSourceDetail } from "../work/WorkHandoffMarkers";
import {
  buildThreadLineageChain,
  collapseThreadBreadcrumb,
  resolveThreadOrigin,
  type ThreadLineageAncestor,
} from "./threadLineage.logic";

/** The thread a shell goes back to, scoped to its environment. */
function originRef(shell: EnvironmentThreadShell | null) {
  if (shell === null) return null;
  const origin = resolveThreadOrigin(shell.source);
  return origin === null ? null : scopeThreadRef(shell.environmentId, origin.threadId);
}

/**
 * Ancestors of a thread, root first. One shell subscription per level, up to
 * THREAD_LINEAGE_MAX_DEPTH, so the header re-renders only when a thread in its
 * own chain changes.
 */
function useThreadLineageChain(shell: EnvironmentThreadShell | null) {
  const first = useThreadShell(originRef(shell));
  const second = useThreadShell(originRef(first));
  const third = useThreadShell(originRef(second));
  const fourth = useThreadShell(originRef(third));
  return useMemo(() => {
    if (shell === null) return [];
    const known = [first, second, third, fourth];
    return buildThreadLineageChain(
      shell.source,
      (threadId) => known.find((candidate) => candidate?.id === threadId) ?? null,
    );
  }, [shell, first, second, third, fourth]);
}

const SEGMENT_CLASS = "min-w-0 max-w-full [-webkit-app-region:no-drag]";

// Inline in a page's own top bar (no nav rail): clear of the fixed titlebar
// controls at the header's right edge. The rail's titlebar slot lifts the cap.
const HEADER_TITLE_MAX_WIDTH_CLASS = "max-w-[min(40rem,calc(100%-10rem))]";

// The title row is a size container, so the trail drops ancestors by the room
// it has: the root and the "…" menu below 28rem, the parent below 16rem.
// Every minimum left at those widths fits beside the "Runs on" chip, so the
// trail never runs under it; below 16rem the title alone shrinks.
const ROOT_HIDE_CLASS = "@max-[28rem]/thread-title:hidden";
const PARENT_HIDE_CLASS = "@max-[16rem]/thread-title:hidden";

/**
 * The chat header's leading title, always visible at the pane's left gutter
 * (after the toggle and back/forward pair while the sidebar is collapsed).
 * A top-level thread shows its title; a subagent, fork, or Work started from a
 * chat or an agent conversation shows `Parent title / This thread` instead, where
 * a deeper chain keeps its root and direct parent and folds the middle into a
 * "…" menu. Until the thread's shell loads, the title shows alone.
 */
export function ThreadHeaderTitle(
  props: Parameters<typeof ThreadHeaderTitleContent>[0] & {
    /**
     * Shown right after the title, such as the "Runs on" chip. It shares the
     * title's row wherever the title renders (the page's top bar or the fixed
     * titlebar slot), so the title truncates before the two can overlap.
     */
    readonly trailing?: ReactNode;
  },
) {
  const { trailing, ...titleProps } = props;
  return (
    <WorkspacePageTitle>
      <div
        className={cn(
          "@container/thread-title flex min-w-0 flex-1 items-center",
          HEADER_TITLE_MAX_WIDTH_CLASS,
        )}
        // Leads the top bar, so it rides the pane's left edge when the sidebar toggles.
        data-panel-flip="start"
      >
        <ThreadHeaderTitleContent {...titleProps} />
        {trailing}
      </div>
    </WorkspacePageTitle>
  );
}

function ThreadHeaderTitleContent(props: {
  readonly shell: EnvironmentThreadShell | null;
  readonly title: string;
  /** For Work started from a chat: how many of the chat's messages the handoff carried. */
  readonly messagesCarried?: number | null;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const ancestors = useThreadLineageChain(props.shell);
  const segments = collapseThreadBreadcrumb(ancestors);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  // A rename fades the new title in place; opening another thread shows its
  // title at once, like the rest of the page.
  const threadKey = props.shell ? `${props.shell.environmentId}:${props.shell.id}` : null;
  const [titleSwap, setTitleSwap] = useState({ threadKey, title: props.title, fade: false });
  if (titleSwap.threadKey !== threadKey || titleSwap.title !== props.title) {
    setTitleSwap({ threadKey, title: props.title, fade: titleSwap.threadKey === threadKey });
  }
  if (props.shell === null || segments === null) {
    return (
      <h2
        key={props.title}
        className={cn(
          titleSwap.fade && "swap-motion",
          "min-w-0 truncate text-sm font-medium text-foreground",
        )}
      >
        {props.title}
      </h2>
    );
  }
  const shortcut = shortcutLabelForCommand(keybindings, "thread.openParent");

  // A muted link back to an ancestor; the current title after it stays emphasized.
  const segment = (ancestor: ThreadLineageAncestor, isParent: boolean) => {
    const title = ancestor.title ?? "Untitled thread";
    return (
      <Tooltip>
        <TooltipTrigger
          delay={300}
          render={
            <Button
              variant="ghost-muted"
              size="xs"
              className={SEGMENT_CLASS}
              onClick={() => props.onOpenThread(ancestor.threadId)}
            />
          }
        >
          <span className="min-w-0 truncate">{title}</span>
        </TooltipTrigger>
        <TooltipPopup side="bottom">
          {isParent && ancestor.kind === "chat"
            ? formatWorkHandoffSourceDetail(title, props.messagesCarried)
            : title}
          {isParent && shortcut ? ` (${shortcut})` : null}
        </TooltipPopup>
      </Tooltip>
    );
  };
  const separator = (hideClass: string) => (
    <span
      aria-hidden
      className={cn("shrink-0 px-0.5 text-muted-foreground/50 select-none", hideClass)}
    >
      /
    </span>
  );

  return (
    <nav
      // Keyed by thread: a navigation mounts a fresh trail, shown at once.
      key={`${props.shell.environmentId}:${props.shell.id}`}
      aria-label="Thread lineage"
      // Clickable through the desktop titlebar's drag strip it sits in.
      className="flex min-w-0 items-center text-xs [-webkit-app-region:no-drag]"
    >
      <h2 className="sr-only">{props.title}</h2>
      {segments.root ? (
        <>
          <span className={cn("flex min-w-0 shrink-[40]", ROOT_HIDE_CLASS)}>
            {segment(segments.root, false)}
          </span>
          {separator(ROOT_HIDE_CLASS)}
        </>
      ) : null}
      {segments.hidden.length > 0 ? (
        <>
          <Menu>
            <MenuTrigger
              render={
                <Button
                  variant="ghost-muted"
                  size="icon-xs"
                  className={cn("shrink-0 [-webkit-app-region:no-drag]", ROOT_HIDE_CLASS)}
                  aria-label={`${segments.hidden.length} more in this thread's lineage`}
                />
              }
            >
              <EllipsisIcon aria-hidden />
            </MenuTrigger>
            <MenuPopup align="start">
              {segments.hidden.map((ancestor) => (
                <MenuItem
                  key={ancestor.threadId}
                  onClick={() => props.onOpenThread(ancestor.threadId)}
                >
                  <span className="max-w-72 truncate">{ancestor.title ?? "Untitled thread"}</span>
                </MenuItem>
              ))}
            </MenuPopup>
          </Menu>
          {separator(ROOT_HIDE_CLASS)}
        </>
      ) : null}
      {/* Every segment shows in full while the trail fits. Short of room the
          ancestors truncate well before the title (their shrink weights dwarf
          its own), then drop out at the container widths above. No percentage
          caps: the trail is sized by its content, so a percentage would
          resolve against itself. */}
      <span className={cn("flex min-w-0 shrink-[20]", PARENT_HIDE_CLASS)}>
        {segment(segments.parent, true)}
      </span>
      {separator(PARENT_HIDE_CLASS)}
      <span
        aria-current="page"
        className="min-w-0 shrink truncate px-1 font-medium text-foreground"
      >
        {props.shell.title}
      </span>
    </nav>
  );
}
