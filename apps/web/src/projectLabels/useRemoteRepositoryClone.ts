import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  projectCloneProgressSummary,
  type ProjectId,
  type ProjectLabelOwnerRepository,
  type ScopedProjectRef,
  SourceControlProviderKind,
} from "@t3tools/contracts";
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
  | { readonly phase: "failed"; readonly message: string; readonly canRemove: boolean }
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
 * retry or remove once it failed. While it is followed here the clone toast
 * stays away; `ref` names the new repository once the server created it.
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
  // A finished clone leaves the server's list after a while; one that was
  // seen and then left is done.
  const [seenProjectId, setSeenProjectId] = useState<ProjectId | null>(null);
  useEffect(() => {
    if (snapshot !== null) setSeenProjectId(snapshot.projectId);
  }, [snapshot]);

  const view = useMemo((): RemoteCloneView | null => {
    if (active === null) return null;
    if (active.startError !== null) {
      return { phase: "failed", message: active.startError, canRemove: false };
    }
    if (snapshot === null) {
      return active.projectId !== null && seenProjectId === active.projectId
        ? { phase: "done" }
        : { phase: "starting" };
    }
    switch (snapshot.phase) {
      case "running":
        return { phase: "running", summary: projectCloneProgressSummary(snapshot) };
      case "done":
        return { phase: "done" };
      case "cancelled":
        return { phase: "cancelled" };
      default:
        return {
          phase: "failed",
          message: snapshot.error ?? "The clone failed.",
          canRemove: true,
        };
    }
  }, [active, seenProjectId, snapshot]);

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
      if (ref === null) {
        await start(active.target);
        return;
      }
      setActive({ ...active, startError: null });
      reportActionFailure(
        await retryClone({ environmentId: ref.environmentId, input: { projectId: ref.projectId } }),
      );
    },
    remove: async () => {
      if (ref === null) return;
      await removeClonedProject(ref);
      setActive(null);
    },
    dismiss: () => setActive(null),
  };
}
