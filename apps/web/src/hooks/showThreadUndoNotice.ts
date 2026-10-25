import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@cogenly/client-runtime/state/runtime";
import { create } from "zustand";

import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { shortcutLabelForCommand } from "../keybindings";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { primaryServerKeybindingsAtom } from "../state/server";
import * as ThreadUndo from "./threadUndo";

type UndoOptions = {
  action: "Settled" | "Snoozed" | "Unpinned" | "Archived" | "Discarded";
  undo: () => Promise<AtomCommandResult<unknown, unknown>>;
  failureTitle: string;
  claim: ReturnType<typeof ThreadUndo.begin>;
  /** Runs once the action can no longer be undone. */
  commit?: () => void;
};

type UndoNotice = {
  action: UndoOptions["action"];
  count: number;
  undo: () => Promise<void>;
};

export const useThreadUndoNotice = create<{ notice: UndoNotice | null }>(() => ({ notice: null }));

// Shared across sidebar, header and menu actions. Consecutive actions of the
// same kind share one notice and can be restored together.
let liveUndos: UndoOptions[] = [];
let expiry: ReturnType<typeof setTimeout> | undefined;
/** How long a thread action stays undoable; its toast stays up for the same time. */
const UNDO_WINDOW_MS = 5_000;
let undoToastId: ReturnType<typeof toastManager.add> | null = null;
let undoToastKey = "";

/**
 * Shows the live undo group as a standard toast with an Undo action, and
 * closes it when nothing is left to undo. The toast follows the group, so a
 * further action of the same kind replaces it with the larger count.
 */
function syncUndoToast(notice: UndoNotice | null) {
  const key = notice ? `${notice.action}:${notice.count}` : "";
  if (key === undoToastKey) return;
  undoToastKey = key;
  if (undoToastId !== null) toastManager.close(undoToastId);
  undoToastId = null;
  if (!notice) return;
  const shortcut = shortcutLabelForCommand(
    appAtomRegistry.get(primaryServerKeybindingsAtom),
    "thread.undo",
  );
  undoToastId = toastManager.add({
    type: "success",
    title: undoNoticeTitle(notice),
    ...(shortcut ? { description: `${shortcut} to undo` } : {}),
    timeout: UNDO_WINDOW_MS,
    actionProps: { children: "Undo", onClick: () => void undoLatestThreadAction() },
  });
}

/** "Discarded 2 drafts", "Archived 1 thread". */
export function undoNoticeTitle(notice: Pick<UndoNotice, "action" | "count">) {
  const noun = notice.action === "Discarded" ? "draft" : "thread";
  return `${notice.action} ${notice.count} ${noun}${notice.count === 1 ? "" : "s"}`;
}

function refreshNotice() {
  const stale = liveUndos.filter(({ claim }) => !claim.isCurrent());
  liveUndos = liveUndos.filter((entry) => !stale.includes(entry));
  for (const entry of stale) entry.commit?.();
  const latest = liveUndos.at(-1);
  if (!latest) {
    clearTimeout(expiry);
    useThreadUndoNotice.setState({ notice: null });
    syncUndoToast(null);
    return;
  }
  const group: UndoOptions[] = [];
  for (let index = liveUndos.length - 1; index >= 0; index--) {
    const entry = liveUndos[index]!;
    if (entry.action !== latest.action) break;
    group.push(entry);
  }
  const notice: UndoNotice = {
    action: latest.action,
    count: group.length,
    undo: async () => {
      const current = group.filter((entry) => liveUndos.includes(entry) && entry.claim.isCurrent());
      liveUndos = liveUndos.filter((entry) => !group.includes(entry));
      // Consume every claim before awaiting, so repeated clicks or shortcuts
      // cannot restore the same group twice.
      for (const entry of current) entry.claim.finish();
      refreshNotice();
      await Promise.all(
        current.map(async ({ undo, failureTitle }) => {
          const reportFailure = (error: unknown) => {
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: failureTitle,
                description: error instanceof Error ? error.message : "An error occurred.",
              }),
            );
          };
          try {
            const result = await undo();
            if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
              reportFailure(squashAtomCommandFailure(result));
            }
          } catch (error) {
            reportFailure(error);
          }
        }),
      );
    },
  };
  useThreadUndoNotice.setState({ notice });
  syncUndoToast(notice);
}

ThreadUndo.subscribe(refreshNotice);

/** Runs the group the undo toast offers; false when nothing is left to undo. */
export function undoLatestThreadAction(): boolean {
  const notice = useThreadUndoNotice.getState().notice;
  if (!notice) return false;
  void notice.undo();
  return true;
}

/** Shows one undo toast for the currently undoable thread actions. */
export function showThreadUndoNotice(options: UndoOptions) {
  if (!options.claim.isCurrent()) return;
  liveUndos.push(options);
  refreshNotice();
  clearTimeout(expiry);
  expiry = setTimeout(() => {
    const expired = liveUndos;
    liveUndos = [];
    for (const { claim, commit } of expired) {
      claim.finish();
      commit?.();
    }
    refreshNotice();
  }, UNDO_WINDOW_MS);
}
