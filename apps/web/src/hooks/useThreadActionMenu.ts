import { scopedThreadKey, scopeProjectRef } from "@t3tools/client-runtime/environment";
import { requestCustomSnooze } from "../components/CustomSnoozeDialog";
import { openCommandPalette } from "../commandPaletteBus";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { canSnooze, effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";
import {
  AuthOrchestrationOperateScope,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import { formatThreadLink } from "@t3tools/shared/threadLinks";
import { useCallback, useMemo } from "react";

import { agentViewKey, requestAgentView } from "../agents/agentViewIntent";
import { hasUnseenCompletion, resolveThreadLastVisitedAt } from "../components/Sidebar.logic";
import { threadCapabilities } from "../threadCapabilities";
import { useUiStateStore } from "../uiStateStore";
import { useThreadKindResolver } from "./useThreadKind";

import { resolveSnoozePresets } from "../components/Sidebar.snooze";
import {
  buildThreadActionMenuItems,
  threadActionRequiresOperate,
  type ThreadActionMenuId,
} from "../components/threadActionMenu.logic";
import { showCopiedToast } from "../components/ui/copiedToast";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { threadEnvironment } from "../state/threads";
import { useOrchestrationCommand } from "../state/use-orchestration-command";
import { readEnvironmentScope } from "../state/session";
import {
  readEnvironmentSupportsAutoSettleOptOut,
  readEnvironmentSupportsSettlement,
  readEnvironmentSupportsSnooze,
  readEnvironmentSupportsTitleRegeneration,
  readThreadShell,
  useProjects,
} from "../state/entities";
import { usePrimaryEnvironmentId } from "../state/environments";
import { readLocalApi } from "../localApi";
import {
  deriveLogicalProjectKeyFromSettings,
  derivePhysicalProjectKey,
  selectProjectGroupingSettings,
} from "../logicalProject";
import { buildPhysicalToLogicalProjectKeyMap } from "../sidebarProjectGrouping";
import { threadRuntimeCanArchive } from "@t3tools/client-runtime/state/models";
import { priorFiling, threadFolderState } from "../projectLabels/projectLabels.logic";
import { useMoveThreadToFolder } from "../projectLabels/useMoveThreadToFolder";
import { useProjectLabelDirectory } from "../projectLabels/useProjectLabels";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { serverEnvironment } from "../state/server";
import { useCopyToClipboard } from "./useCopyToClipboard";
import { useNewThreadHandler } from "./useHandleNewThread";
import { useClientSettings } from "./useSettings";
import { useThreadActions } from "./useThreadActions";

function failureToast(title: string, error: unknown) {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "An error occurred.",
    }),
  );
}

/**
 * The per-thread action menu (settle, snooze, rename, copy, delete…) as
 * a self-contained hook, for surfaces other than the sidebar row — today the
 * chat header. Renders through the native context-menu bridge and dispatches
 * through the same mutations the sidebar uses.
 *
 * Unlike the sidebar, settle and snooze here never navigate away: the caller
 * is acting on the thread they are reading, and ChatView's parked-thread
 * banner already offers the way back.
 */
export function useThreadActionMenu(input: {
  readonly threadRef: ScopedThreadRef | null;
  /** Fallback for "Copy path" when the thread has no worktree. */
  readonly projectCwd: string | null;
  readonly onStartRename: () => void;
}) {
  const { threadRef, projectCwd, onStartRename } = input;
  const router = useRouter();
  const projects = useProjects();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const logicalProjectKeyByPhysicalKey = useMemo(
    () =>
      buildPhysicalToLogicalProjectKeyMap({
        projects,
        settings: projectGroupingSettings,
        primaryEnvironmentId,
      }),
    [primaryEnvironmentId, projectGroupingSettings, projects],
  );
  const {
    settleThread,
    unsettleThread,
    snoozeThread,
    unsnoozeThread,
    setThreadAutoSettle,
    archiveThread,
    deleteThread,
    markThreadUnread,
    markThreadRead,
  } = useThreadActions();
  const resolveThreadKind = useThreadKindResolver();
  const folderEnvironmentIds = useMemo(
    () => (threadRef ? [threadRef.environmentId] : []),
    [threadRef],
  );
  const folderDirectory = useProjectLabelDirectory(folderEnvironmentIds);
  const moveThreadToFolder = useMoveThreadToFolder();
  const updateThreadMetadata = useOrchestrationCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const handleNewThread = useNewThreadHandler();
  const confirmThreadDelete = useClientSettings((s) => s.confirmThreadDelete);
  const confirmThreadArchive = useClientSettings((s) => s.confirmThreadArchive);
  const timestampFormat = useClientSettings((s) => s.timestampFormat);
  const { copyToClipboard: copyPathToClipboard } = useCopyToClipboard<{ path: string }>({
    onCopy: ({ path }) => {
      showCopiedToast({ kind: "path", path });
    },
    onError: (error) => failureToast("Failed to copy path", error),
  });
  const { copyToClipboard: copyBranchToClipboard } = useCopyToClipboard<{ branch: string }>({
    target: "branch name",
    onCopy: ({ branch }) => {
      showCopiedToast({ kind: "branch", branch });
    },
    onError: (error) => failureToast("Failed to copy branch", error),
  });
  const { copyToClipboard: copyThreadLinkToClipboard } = useCopyToClipboard<{ link: string }>({
    onCopy: ({ link }) => {
      showCopiedToast({ kind: "thread-link", link });
    },
    onError: (error) => failureToast("Failed to copy thread link", error),
  });
  const { copyToClipboard: copyThreadIdToClipboard } = useCopyToClipboard<{
    threadId: ThreadId;
    threadTitle: string;
  }>({
    onCopy: ({ threadId, threadTitle }) => {
      showCopiedToast({ kind: "thread-id", threadId, threadTitle });
    },
    onError: (error) => failureToast("Failed to copy thread ID", error),
  });

  const openMenu = useCallback(
    (position: { x: number; y: number }) => {
      if (threadRef === null) return;
      void (async () => {
        const api = readLocalApi();
        if (!api) return;
        // Snapshot at open time — the menu is modal, so state read now is
        // what the user is looking at.
        const thread = readThreadShell(threadRef);
        if (!thread) return;
        const now = new Date();
        const supports = {
          settlement: readEnvironmentSupportsSettlement(threadRef.environmentId),
          autoSettleOptOut: readEnvironmentSupportsAutoSettleOptOut(threadRef.environmentId),
          snooze: readEnvironmentSupportsSnooze(threadRef.environmentId),
          titleRegeneration: readEnvironmentSupportsTitleRegeneration(threadRef.environmentId),
        };
        const isRegeneratingTitle = thread.titleRegeneration != null;
        const snoozePresets = resolveSnoozePresets(now, timestampFormat);
        const threadKind = resolveThreadKind(thread);
        const capabilities = threadCapabilities(threadKind);
        const folderState = threadFolderState(thread, folderDirectory);
        const isUnread = hasUnseenCompletion({
          ...thread,
          lastVisitedAt: resolveThreadLastVisitedAt(
            thread.lastVisitedAt,
            useUiStateStore.getState().threadLastVisitedAtById[scopedThreadKey(threadRef)],
          ),
        });
        const items = buildThreadActionMenuItems({
          capabilities,
          canOperate: readEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope),
          branch: thread.branch ?? null,
          isUnread,
          isSettled: supports.settlement && thread.settledOverride === "settled",
          autoSettleEnabled: thread.autoSettleDisabledAt == null,
          isSnoozed: supports.snooze && effectiveSnoozed(thread, { now: now.toISOString() }),
          canSnoozeNow: canSnooze(thread, { now: now.toISOString() }),
          isRegeneratingTitle,
          isRunning: !threadRuntimeCanArchive(thread.runtime),
          supports,
          snoozePresets,
          folder: {
            current: folderState.current && {
              key: folderState.current.key,
              id: folderState.current.label.id,
              name: folderState.current.label.name,
            },
            removable: folderState.removable,
            options: folderState.options.map((entry) => ({
              id: entry.label.id,
              name: entry.label.name,
              color: entry.label.color,
            })),
            canMove: appAtomRegistry.get(
              serverEnvironment.moveThreadProjectFolder.permissionAtom(threadRef.environmentId),
            ),
          },
        });
        const clicked = await settlePromise(() => api.contextMenu.show(items, position));
        if (clicked._tag === "Failure" || clicked.value === null) return;
        const action: ThreadActionMenuId = clicked.value;
        if (
          threadActionRequiresOperate(action) &&
          !readEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope)
        ) {
          failureToast(
            "Thread action unavailable",
            new Error("This connection cannot change threads."),
          );
          return;
        }
        if (action.startsWith("open-project:") && folderState.current) {
          void router.navigate({
            to: "/project/$environmentId/$labelId",
            params: {
              environmentId: folderState.current.environmentId,
              labelId: folderState.current.label.id,
            },
          });
          return;
        }
        if (action === "new-folder") {
          void router.navigate({
            to: "/project",
            search: { create: true, environmentId: threadRef.environmentId },
          });
          return;
        }
        if (action === "remove-folder" || action.startsWith("move-folder:")) {
          const target =
            action === "remove-folder"
              ? null
              : folderState.options.find(
                  (entry) => entry.label.id === action.slice("move-folder:".length),
                );
          if (target === undefined) return;
          await moveThreadToFolder({
            environmentId: threadRef.environmentId,
            threadId: threadRef.threadId,
            folder: target && { id: target.label.id, name: target.label.name },
            previous: priorFiling(folderState),
          });
          return;
        }
        if (action.startsWith("snooze:")) {
          const preset =
            action === "snooze:custom"
              ? await requestCustomSnooze()
              : snoozePresets.find((candidate) => `snooze:${candidate.id}` === action);
          if (!preset) return;
          const result = await snoozeThread(threadRef, preset.snoozedUntil);
          if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
            failureToast("Failed to snooze thread", squashAtomCommandFailure(result));
          }
          return;
        }
        const reportFailure = async (
          title: string,
          run: () => Promise<AtomCommandResult<unknown, unknown>>,
        ) => {
          const result = await run();
          if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
            failureToast(title, squashAtomCommandFailure(result));
          }
        };
        switch (action) {
          case "project-settings": {
            const project = projects.find(
              (candidate) =>
                candidate.environmentId === thread.environmentId &&
                candidate.id === thread.projectId,
            );
            if (!project) return;
            const projectKey =
              logicalProjectKeyByPhysicalKey.get(derivePhysicalProjectKey(project)) ??
              deriveLogicalProjectKeyFromSettings(project, projectGroupingSettings);
            void router.navigate({
              to: "/projects/$projectKey",
              params: { projectKey },
            });
            return;
          }
          case "new-thread-on-branch": {
            // Explicit branch carry-over: reuse the thread's worktree when it
            // has one, otherwise its branch on the local checkout.
            const result = await settlePromise(() =>
              handleNewThread(scopeProjectRef(threadRef.environmentId, thread.projectId), {
                branch: thread.branch,
                worktreePath: thread.worktreePath,
                envMode: thread.worktreePath ? "worktree" : "local",
                startFromOrigin: false,
              }),
            );
            if (result._tag === "Failure") {
              failureToast("Could not create thread", squashAtomCommandFailure(result));
            }
            return;
          }
          case "start-work":
            openCommandPalette({ open: "start-work", threadRef });
            return;
          case "settle":
            await reportFailure("Failed to settle thread", () => settleThread(threadRef));
            return;
          case "unsettle":
            await reportFailure("Failed to un-settle thread", () => unsettleThread(threadRef));
            return;
          case "unsnooze":
            await reportFailure("Failed to wake thread", () => unsnoozeThread(threadRef));
            return;
          case "auto-settle:enabled":
          case "auto-settle:disabled":
            await reportFailure("Failed to update auto-settle", () =>
              setThreadAutoSettle(threadRef, action === "auto-settle:enabled"),
            );
            return;
          case "rename":
            onStartRename();
            return;
          case "regenerate-title":
            if (isRegeneratingTitle) return;
            await reportFailure("Failed to regenerate thread title", () =>
              updateThreadMetadata({
                environmentId: threadRef.environmentId,
                input: { threadId: threadRef.threadId, regenerateTitle: true },
              }),
            );
            return;
          case "mark-unread":
            markThreadUnread(threadRef);
            return;
          case "mark-read":
            markThreadRead(threadRef);
            return;
          case "agent-settings":
            requestAgentView(
              agentViewKey({
                environmentId: threadRef.environmentId,
                conversationThreadId: threadRef.threadId,
              }),
              "responsibilities",
            );
            return;
          case "copy-thread-link": {
            const link = formatThreadLink(thread.id, thread.title);
            copyThreadLinkToClipboard(link, { link });
            return;
          }
          case "copy-path": {
            const workspacePath = thread.worktreePath ?? projectCwd;
            if (!workspacePath) {
              toastManager.add(
                stackedThreadToast({
                  type: "error",
                  title: "Path unavailable",
                  description: "This thread does not have a workspace path to copy.",
                }),
              );
              return;
            }
            copyPathToClipboard(workspacePath, { path: workspacePath });
            return;
          }
          case "copy-branch":
            if (thread.branch) {
              copyBranchToClipboard(thread.branch, { branch: thread.branch });
            }
            return;
          case "copy-thread-id":
            copyThreadIdToClipboard(thread.id, { threadId: thread.id, threadTitle: thread.title });
            return;
          case "archive": {
            if (confirmThreadArchive) {
              const confirmed = await settlePromise(() =>
                api.dialogs.confirm(`Archive thread "${thread.title}"?`),
              );
              if (confirmed._tag === "Failure" || !confirmed.value) return;
            }
            let didArchive = false;
            const result = await archiveThread(threadRef, {
              onArchived: () => {
                didArchive = true;
              },
            });
            if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
              failureToast(
                didArchive ? "Thread archived, but navigation failed" : "Failed to archive thread",
                squashAtomCommandFailure(result),
              );
            }
            return;
          }
          case "delete": {
            if (capabilities.delete === false) return;
            if (confirmThreadDelete || capabilities.delete === "always-confirm") {
              const confirmed = await settlePromise(() =>
                api.dialogs.confirm(
                  [
                    `Delete thread "${thread.title}"?`,
                    "This permanently clears conversation history for this thread.",
                  ].join("\n"),
                  { variant: "destructive" },
                ),
              );
              if (confirmed._tag === "Failure" || !confirmed.value) return;
            }
            const deleted = await deleteThread(threadRef);
            if (
              deleted._tag === "Failure" &&
              !isAtomCommandInterrupted(deleted) &&
              // A failure with the thread already gone is worktree cleanup
              // failing after a successful delete — deleteThread has toasted
              // that itself, and "Failed to delete thread" would be a lie.
              readThreadShell(threadRef) !== null
            ) {
              failureToast("Failed to delete thread", squashAtomCommandFailure(deleted));
            }
            return;
          }
          default:
            return;
        }
      })();
    },
    [
      archiveThread,
      confirmThreadArchive,
      confirmThreadDelete,
      copyBranchToClipboard,
      copyPathToClipboard,
      copyThreadIdToClipboard,
      copyThreadLinkToClipboard,
      deleteThread,
      folderDirectory,
      handleNewThread,
      logicalProjectKeyByPhysicalKey,
      markThreadRead,
      markThreadUnread,
      moveThreadToFolder,
      onStartRename,
      projectCwd,
      projectGroupingSettings,
      projects,
      resolveThreadKind,
      router,
      setThreadAutoSettle,
      settleThread,
      snoozeThread,
      threadRef,
      timestampFormat,
      unsettleThread,
      unsnoozeThread,
      updateThreadMetadata,
    ],
  );

  const closeMenu = useCallback(() => {
    void readLocalApi()?.contextMenu.close();
  }, []);

  return { openMenu, closeMenu };
}
