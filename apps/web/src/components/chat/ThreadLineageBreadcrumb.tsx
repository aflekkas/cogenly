import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@cogenly/client-runtime/environment";
import type { EnvironmentThreadShell } from "@cogenly/client-runtime/state/models";
import type { EnvironmentId, ProjectLabelId, ThreadId } from "@cogenly/contracts";
import { EllipsisIcon } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";

import { cn } from "~/lib/utils";

import { shortcutLabelForCommand } from "~/keybindings";
import { threadHeaderProject } from "~/projectLabels/projectMeta.logic";
import { useProjectLabelDirectory } from "~/projectLabels/useProjectLabels";
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

// The title row is a size container, so the trail drops its earliest segments
// by the room it has: the project below 36rem (16rem when it is the only one
// before the title), the root and the "…" menu below 28rem, the parent below
// 16rem. Below 16rem the title alone shrinks.
const PROJECT_HIDE_CLASS = "@max-[36rem]/thread-title:hidden";
const LONE_PROJECT_HIDE_CLASS = "@max-[16rem]/thread-title:hidden";
const ROOT_HIDE_CLASS = "@max-[28rem]/thread-title:hidden";
const PARENT_HIDE_CLASS = "@max-[16rem]/thread-title:hidden";

/**
 * The chat header's leading title, always visible at the pane's left gutter
 * (after the toggle and back/forward pair while the sidebar is collapsed).
 * A thread in a project leads with `Project /`, which starts a new chat in
 * that project; "No project" leads with nothing. A subagent, fork, or Work
 * started from a chat or an agent conversation adds `Parent title /` before
 * its own, where a deeper chain keeps its root and direct parent and folds the
 * middle into a "…" menu. Until the thread's shell loads, the title shows alone.
 */
export function ThreadHeaderTitle(props: Parameters<typeof ThreadHeaderTitleContent>[0]) {
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
        <ThreadHeaderTitleContent {...props} />
      </div>
    </WorkspacePageTitle>
  );
}

/** The thread's project, named as its sidebar row names it. */
function useThreadHeaderProject(
  shell: EnvironmentThreadShell | null,
  placement: { readonly isWork: boolean; readonly inRepository: boolean },
) {
  const environmentId = shell?.environmentId ?? null;
  const environmentIds = useMemo(
    () => (environmentId === null ? [] : [environmentId]),
    [environmentId],
  );
  const directory = useProjectLabelDirectory(environmentIds);
  return shell === null ? null : threadHeaderProject(shell, { ...placement, directory });
}

function ThreadHeaderTitleContent(props: {
  readonly shell: EnvironmentThreadShell | null;
  readonly title: string;
  /** For Work started from a chat: how many of the chat's messages the handoff carried. */
  readonly messagesCarried?: number | null;
  /** Work, which names its repository's project (see threadHeaderProject). */
  readonly isWork: boolean;
  /** Work in a real repository, not its project's folder. */
  readonly inRepository: boolean;
  readonly onOpenThread: (threadId: ThreadId) => void;
  /** Starts a new chat filed in the project. */
  readonly onOpenProject: (environmentId: EnvironmentId, folderId: ProjectLabelId) => void;
}) {
  const ancestors = useThreadLineageChain(props.shell);
  const segments = collapseThreadBreadcrumb(ancestors);
  const project = useThreadHeaderProject(props.shell, {
    isWork: props.isWork,
    inRepository: props.inRepository,
  });
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  // A rename fades the new title in place; opening another thread shows its
  // title at once, like the rest of the page.
  const threadKey = props.shell ? `${props.shell.environmentId}:${props.shell.id}` : null;
  const [titleSwap, setTitleSwap] = useState({ threadKey, title: props.title, fade: false });
  if (titleSwap.threadKey !== threadKey || titleSwap.title !== props.title) {
    setTitleSwap({ threadKey, title: props.title, fade: titleSwap.threadKey === threadKey });
  }
  if (props.shell === null || (segments === null && project === null)) {
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

  // A muted link; the current title after it stays emphasized.
  const link = (label: string, tooltip: ReactNode, onClick: () => void) => (
    <Tooltip>
      <TooltipTrigger
        delay={300}
        render={
          <Button variant="ghost-muted" size="xs" className={SEGMENT_CLASS} onClick={onClick} />
        }
      >
        <span className="min-w-0 truncate">{label}</span>
      </TooltipTrigger>
      <TooltipPopup side="bottom">{tooltip}</TooltipPopup>
    </Tooltip>
  );
  // A link back to an ancestor.
  const segment = (ancestor: ThreadLineageAncestor, isParent: boolean) => {
    const title = ancestor.title ?? "Untitled thread";
    return link(
      title,
      <>
        {isParent && ancestor.kind === "chat"
          ? formatWorkHandoffSourceDetail(title, props.messagesCarried)
          : title}
        {isParent && shortcut ? ` (${shortcut})` : null}
      </>,
      () => props.onOpenThread(ancestor.threadId),
    );
  };
  const environmentId = props.shell.environmentId;
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
      aria-label="Breadcrumb"
      // Clickable through the desktop titlebar's drag strip it sits in.
      className="flex min-w-0 items-center text-xs [-webkit-app-region:no-drag]"
    >
      <h2 className="sr-only">{props.title}</h2>
      {project ? (
        <>
          <span
            className={cn(
              "flex min-w-0 shrink-[60]",
              segments ? PROJECT_HIDE_CLASS : LONE_PROJECT_HIDE_CLASS,
            )}
          >
            {link(project.label.name, `New chat in ${project.label.name}`, () =>
              props.onOpenProject(environmentId, project.label.id),
            )}
          </span>
          {separator(segments ? PROJECT_HIDE_CLASS : LONE_PROJECT_HIDE_CLASS)}
        </>
      ) : null}
      {segments?.root ? (
        <>
          <span className={cn("flex min-w-0 shrink-[40]", ROOT_HIDE_CLASS)}>
            {segment(segments.root, false)}
          </span>
          {separator(ROOT_HIDE_CLASS)}
        </>
      ) : null}
      {segments && segments.hidden.length > 0 ? (
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
      {segments ? (
        <>
          <span className={cn("flex min-w-0 shrink-[20]", PARENT_HIDE_CLASS)}>
            {segment(segments.parent, true)}
          </span>
          {separator(PARENT_HIDE_CLASS)}
        </>
      ) : null}
      {/* The size the title has alone, so filing a thread never resizes it. */}
      <span
        key={props.title}
        aria-current="page"
        className={cn(
          titleSwap.fade && "swap-motion",
          "min-w-0 shrink truncate px-1 text-sm font-medium text-foreground",
        )}
      >
        {props.title}
      </span>
    </nav>
  );
}
