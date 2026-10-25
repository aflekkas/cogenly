import { scopeProjectRef } from "@cogenly/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@cogenly/client-runtime/state/runtime";
import {
  projectCloneProgressSummary,
  type ProjectCloneSnapshot,
  type ProjectId,
  type ProjectLabelOwnerRepository,
  type ScopedProjectRef,
  SourceControlProviderKind,
} from "@cogenly/contracts";
import { useEffect, useMemo, useState } from "react";

import { useRemoveClonedProject } from "../hooks/useRemoveClonedProject";
import { showProjectCloneInline, useProjectClone } from "../state/projectClones";
import { serverEnvironment } from "../state/server";
import { sourceControlEnvironment } from "../state/sourceControl";
import { useAtomCommand } from "../state/use-atom-command";
import type { EnvironmentProjectLabel } from "./projectLabels.logic";

export interface RemoteCloneTarget {
  readonly project: EnvironmentProjectLabel;
  readonly repository: ProjectLabelOwnerRepository;
}

/** Where a picked GitHub repository's clone is, as its picker row shows it. */
export type RemoteCloneView =
  | { readonly phase: "starting" }
  | { readonly phase: "running"; readonly summary: string }
  | { readonly phase: "failed"; readonly message: string }
  | { readonly phase: "cancelled" }
  | { readonly phase: "done" };

interface ActiveClone {
  readonly target: RemoteCloneTarget;
  readonly projectId: ProjectId | null;
  readonly startError: string | null;
}

const GITHUB = SourceControlProviderKind.make("github");

function errorMessage(error: unknown) {
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "The clone could not start.";
}

/**
 * Clones a GitHub repository the picker found into its project, and follows
 * that clone so the picker can show progress in place: cancel while it runs,
 * retry or dismiss once it failed. A clone that does not land takes its
 * repository with it on the server, so Retry starts a fresh clone, and the
 * failure is forgotten once its row leaves the screen. While it is followed
 * here the clone toast stays away; `ref` names the new repository once the
 * server created it.
 */
export function useRemoteRepositoryClone(
  /** Whether the clone's row is on screen; the clone toast steps aside only then. */
  shownInline: (target: RemoteCloneTarget) => boolean,
) {
  const [active, setActive] = useState<ActiveClone | null>(null);
  const cloneRepository = useAtomCommand(serverEnvironment.cloneProjectLabelRepository, {
    reportFailure: false,
  });
  const cancelClone = useAtomCommand(sourceControlEnvironment.cancelProjectClone, {
    reportFailure: false,
  });
  const retryClone = useAtomCommand(sourceControlEnvironment.retryProjectClone, {
    reportFailure: false,
  });
  const removeClonedProject = useRemoveClonedProject();

  const environmentId = active?.target.project.environmentId ?? null;
  const projectId = active?.projectId ?? null;
  const ref = useMemo<ScopedProjectRef | null>(
    () =>
      environmentId !== null && projectId !== null
        ? scopeProjectRef(environmentId, projectId)
        : null,
    [environmentId, projectId],
  );
  const snapshot = useProjectClone(ref);
  const inline = active !== null && shownInline(active.target);
  useEffect(() => (ref && inline ? showProjectCloneInline(ref) : undefined), [inline, ref]);
  // A clone leaves the server's list after a while. The last phase seen says
  // how it ended: a done one landed, a failed one keeps its error here.
  const [lastSnapshot, setLastSnapshot] = useState<ProjectCloneSnapshot | null>(null);
  if (snapshot !== null && snapshot !== lastSnapshot) setLastSnapshot(snapshot);
  const seen =
    active !== null && lastSnapshot !== null && lastSnapshot.projectId === active.projectId
      ? lastSnapshot
      : null;
  // Older servers keep a failed clone's empty repository; dismissing removes it.
  const projectKept = seen !== null && seen.phase !== "done" && seen.projectRemoved !== true;

  const view = useMemo((): RemoteCloneView | null => {
    if (active === null) return null;
    if (active.startError !== null) return { phase: "failed", message: active.startError };
    const current = snapshot ?? seen;
    if (current === null) return { phase: "starting" };
    switch (current.phase) {
      case "running":
        // Left the list while running: it landed (the list drops done clones).
        return snapshot === null
          ? { phase: "done" }
          : { phase: "running", summary: projectCloneProgressSummary(current) };
      case "done":
        return { phase: "done" };
      case "cancelled":
        return { phase: "cancelled" };
      default:
        return { phase: "failed", message: current.error ?? "The clone failed." };
    }
  }, [active, seen, snapshot]);
  // A failure is shown where it happened, then let go: once its row is off
  // screen (the picker closed, or a search hid it) it is dismissed.
  if (!inline && (view?.phase === "failed" || view?.phase === "cancelled")) setActive(null);

  const start = async (target: RemoteCloneTarget) => {
    setActive({ target, projectId: null, startError: null });
    const result = await cloneRepository({
      environmentId: target.project.environmentId,
      input: {
        id: target.project.label.id,
        provider: GITHUB,
        repository: target.repository.nameWithOwner,
        title: target.repository.name,
      },
    });
    setActive((current) => {
      if (current?.target !== target) return current;
      if (result._tag === "Success") return { ...current, projectId: result.value.projectId };
      if (isAtomCommandInterrupted(result)) return null;
      return { ...current, startError: errorMessage(squashAtomCommandFailure(result)) };
    });
  };

  const isFor = (target: Pick<RemoteCloneTarget, "project" | "repository">) =>
    active !== null &&
    active.target.project.key === target.project.key &&
    active.target.repository.nameWithOwner.toLowerCase() ===
      target.repository.nameWithOwner.toLowerCase();

  // A failed request here has no server-side state to show, so its error
  // takes the row's status line instead.
  const reportActionFailure = (
    result: Awaited<ReturnType<typeof cancelClone>> | Awaited<ReturnType<typeof retryClone>>,
  ) => {
    if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
    const message = errorMessage(squashAtomCommandFailure(result));
    setActive((current) => (current ? { ...current, startError: message } : current));
  };

  return {
    active: active?.target ?? null,
    ref,
    view,
    isFor,
    start,
    cancel: async () => {
      if (ref === null) return;
      reportActionFailure(
        await cancelClone({
          environmentId: ref.environmentId,
          input: { projectId: ref.projectId },
        }),
      );
    },
    retry: async () => {
      if (active === null) return;
      // The failed clone's repository is gone (or never existed): start over.
      if (ref === null || !projectKept) {
        await start(active.target);
        return;
      }
      setActive({ ...active, startError: null });
      reportActionFailure(
        await retryClone({ environmentId: ref.environmentId, input: { projectId: ref.projectId } }),
      );
    },
    /** Clears a failed or cancelled clone's row, and any empty repository it left behind. */
    dismiss: async () => {
      if (ref !== null && projectKept) {
        await removeClonedProject(ref);
      }
      setActive(null);
    },
    /** Lets go of a clone that landed; the picker has already taken it up. */
    release: () => setActive(null),
  };
}
