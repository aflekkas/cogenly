import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ProjectCloneSnapshot, ProjectId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { requestConfirmDialog } from "../confirmDialog";
import { environmentProjectClonesAtom } from "../state/projectClones";
import { serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";
import type { EnvironmentProjectLabel } from "./projectLabels.logic";
import {
  canMoveIntoProjectFolder,
  canRemoveCheckout,
  isRepositoryRequestSettled,
  repositoryRowAction,
  repositoryRowView,
  type RepositoryCheckoutRequest,
  type RepositoryListRow,
  type RepositoryRowView,
  type RepositoryRowWork,
} from "./repositoryPicker.logic";
import { repositoryRowMenuIcons, type RepositoryRowMenuAction } from "./RepositorySourceRows";
import { reportProjectFolderFailure } from "./useMoveThreadToFolder";
import {
  useCanRemoveRepositoryFromProject,
  useRemoveRepositoryFromProject,
} from "./useRemoveRepositoryFromProject";

const NO_CLONES = Atom.make<ReadonlyArray<ProjectCloneSnapshot>>([]).pipe(
  Atom.withLabel("repository-checkout:no-clones"),
);

function failureMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim().length > 0 ? error.message : fallback;
}

/**
 * Clones a project's linked repositories onto one machine and follows them:
 * `viewOf` gives each row's state (the link's checkout, the tracked clone's
 * progress, and what was asked for here), and `start` resolves with this
 * machine's record once the clone runs, or null when it was refused (the
 * row then shows the server's message). Shared by every repository list.
 */
export function useRepositoryCheckouts(environmentId: EnvironmentId | null) {
  const checkout = useAtomCommand(serverEnvironment.checkoutProjectLabelRepository, {
    label: "clone repository to this machine",
    reportFailure: false,
  });
  const canCheckout = useAtomValue(
    serverEnvironment.checkoutProjectLabelRepository.permissionAtom(environmentId),
  );
  const clones = useAtomValue(
    environmentId === null ? NO_CLONES : environmentProjectClonesAtom(environmentId),
  );
  const [requests, setRequests] = useState<ReadonlyMap<string, RepositoryCheckoutRequest>>(
    () => new Map(),
  );
  const [work, setWork] = useState<ReadonlyMap<string, RepositoryRowWork>>(() => new Map());
  const requestKey = (row: Pick<RepositoryListRow, "key" | "project">) =>
    `${row.project?.key ?? ""}|${row.key}`;
  // Requests the server's state has overtaken, noted while rendering rows
  // and dropped after the render, so a request never outlives its clone.
  const settled = useRef(new Set<string>());
  useEffect(() => {
    if (settled.current.size === 0) return;
    const keys = [...settled.current];
    settled.current.clear();
    setRequests((current) => {
      if (!keys.some((key) => current.has(key))) return current;
      const next = new Map(current);
      for (const key of keys) next.delete(key);
      return next;
    });
  });
  const cloneFor = useCallback(
    (repositoryId: ProjectId | null) =>
      repositoryId === null
        ? null
        : (clones.find((clone) => clone.projectId === repositoryId) ?? null),
    [clones],
  );

  const setRequest = (key: string, request: RepositoryCheckoutRequest | null) =>
    setRequests((current) => {
      const next = new Map(current);
      if (request === null) next.delete(key);
      else next.set(key, request);
      return next;
    });

  const start = async (
    row: RepositoryListRow & { readonly project: EnvironmentProjectLabel },
  ): Promise<ProjectId | null> => {
    if (row.remote === null || environmentId === null) return null;
    const key = requestKey(row);
    const baselineSequence = cloneFor(row.repositoryId)?.sequence ?? null;
    setRequest(key, { phase: "starting" });
    const result = await checkout({
      environmentId,
      input: { labelId: row.project.label.id, remote: row.remote },
    });
    if (result._tag === "Success") {
      const { repositoryId } = result.value;
      setRequest(key, {
        phase: "started",
        repositoryId,
        // A record the row did not know (a not-cloned link) has no older clone to mistake.
        baselineSequence: repositoryId === row.repositoryId ? baselineSequence : null,
      });
      return repositoryId;
    }
    if (isAtomCommandInterrupted(result)) {
      setRequest(key, null);
      return null;
    }
    setRequest(key, {
      phase: "error",
      message: failureMessage(squashAtomCommandFailure(result), "The clone could not start."),
    });
    return null;
  };

  return {
    canCheckout,
    start,
    /** The record a clone asked for here lands in, before the link reports it. */
    startedRepositoryId: (row: RepositoryListRow): ProjectId | null => {
      const request = requests.get(requestKey(row));
      return request?.phase === "started" ? request.repositoryId : null;
    },
    viewOf: (row: RepositoryListRow): RepositoryRowView => {
      const key = requestKey(row);
      const request = requests.get(key) ?? null;
      const repositoryId =
        row.repositoryId ?? (request?.phase === "started" ? request.repositoryId : null);
      const clone = cloneFor(repositoryId);
      if (request !== null && isRepositoryRequestSettled(row, request, clone))
        settled.current.add(key);
      return repositoryRowView(row, request, clone, {
        cloneable: canCheckout && repositoryRowAction(row) === "checkout",
        work: work.get(key) ?? null,
      });
    },
    /** Forgets what was asked for a row, so its next state comes from the server alone. */
    forget: (row: RepositoryListRow) => {
      if (requests.has(requestKey(row))) setRequest(requestKey(row), null);
    },
    /** Runs a row action, showing it on the row (`working`) until it settles. */
    track: async <A>(row: RepositoryListRow, kind: RepositoryRowWork, run: () => Promise<A>) => {
      const key = requestKey(row);
      setWork((current) => new Map(current).set(key, kind));
      try {
        return await run();
      } finally {
        setWork((current) => {
          const next = new Map(current);
          next.delete(key);
          return next;
        });
      }
    },
  };
}

/** What `useRepositoryCheckouts` gives the row actions: a way to show work on a row. */
export type RepositoryRowWorkTracker = Pick<ReturnType<typeof useRepositoryCheckouts>, "track">;

/**
 * The row menu's machine actions: "Remove from this machine" (deletes the
 * checkout here after a confirm; the project keeps the link) and "Move into
 * project folder" (moves the checkout to `<project>/repos/<name>`). Refusals
 * show the server's reason.
 */
export function useRepositoryMachineActions(environmentId: EnvironmentId | null) {
  const removeCheckout = useAtomCommand(serverEnvironment.removeProjectLabelCheckout, {
    label: "remove repository from this machine",
    reportFailure: false,
  });
  const adopt = useAtomCommand(serverEnvironment.adoptProjectLabelRepository, {
    label: "move repository into project folder",
    reportFailure: false,
  });
  const mayRemoveCheckout = useAtomValue(
    serverEnvironment.removeProjectLabelCheckout.permissionAtom(environmentId),
  );
  const canAdopt = useAtomValue(
    serverEnvironment.adoptProjectLabelRepository.permissionAtom(environmentId),
  );
  return useMemo(
    () => ({
      canRemoveCheckout: mayRemoveCheckout,
      canAdopt,
      removeFromMachine: async (
        row: RepositoryListRow,
        during: <A>(run: () => Promise<A>) => Promise<A> = (run) => run(),
      ): Promise<boolean> => {
        const { project, repositoryId } = row;
        if (project === null || repositoryId === null) return false;
        const message = `Remove ${row.name} from this machine?\nIts folder here is deleted. ${project.label.name} keeps it, and any machine can clone it again.`;
        const confirmed =
          (await requestConfirmDialog(message, { variant: "destructive" })) ??
          window.confirm(message);
        if (!confirmed) return false;
        const result = await during(() =>
          removeCheckout({
            environmentId: project.environmentId,
            input: { labelId: project.label.id, repositoryId },
          }),
        );
        if (result._tag === "Failure") {
          if (!isAtomCommandInterrupted(result)) {
            reportProjectFolderFailure(`Could not remove ${row.name} from this machine`, result);
          }
          return false;
        }
        return result.value.removed;
      },
      moveIntoProjectFolder: async (row: RepositoryListRow): Promise<boolean> => {
        if (row.project === null || row.repositoryId === null) return false;
        const result = await adopt({
          environmentId: row.project.environmentId,
          input: { labelId: row.project.label.id, repositoryId: row.repositoryId },
        });
        if (result._tag === "Failure") {
          if (!isAtomCommandInterrupted(result)) {
            reportProjectFolderFailure(`Could not move ${row.name}`, result);
          }
          return false;
        }
        return result.value.moved;
      },
    }),
    [adopt, canAdopt, mayRemoveCheckout, removeCheckout],
  );
}

/**
 * A row menu's actions, the same on every surface: "Move into project
 * folder" for a checkout outside `<project>/repos/`, "Remove from this
 * machine" for a cloned repository with a remote, and "Remove from <project>"
 * (unlink) for one with a record here. Each is offered only where this
 * connection may do it. `onLeave` runs first, for a picker that closes
 * before a dialog.
 */
export function useRepositoryRowActions(
  environmentId: EnvironmentId | null,
  tracker: RepositoryRowWorkTracker,
) {
  const machine = useRepositoryMachineActions(environmentId);
  const canUnlink = useCanRemoveRepositoryFromProject(environmentId);
  const removeFromProject = useRemoveRepositoryFromProject();
  return (
    row: RepositoryListRow,
    options: { readonly onLeave?: () => void; readonly unlink?: boolean } = {},
  ): RepositoryRowMenuAction[] => {
    const leave = (run: () => Promise<unknown>) => () => {
      options.onLeave?.();
      void run();
    };
    // Shown on the row only while the request runs, never during its confirm.
    const during =
      (kind: RepositoryRowWork) =>
      <A>(run: () => Promise<A>) =>
        tracker.track(row, kind, run);
    const actions: RepositoryRowMenuAction[] = [];
    if (machine.canAdopt && canMoveIntoProjectFolder(row)) {
      actions.push({
        key: "move-into-project-folder",
        label: "Move into project folder",
        icon: repositoryRowMenuIcons.moveIntoProjectFolder,
        onSelect: leave(() => during("moving")(() => machine.moveIntoProjectFolder(row))),
      });
    }
    if (machine.canRemoveCheckout && canRemoveCheckout(row)) {
      actions.push({
        key: "remove-from-machine",
        label: "Remove from this machine",
        icon: repositoryRowMenuIcons.removeFromMachine,
        destructive: true,
        onSelect: leave(() => machine.removeFromMachine(row, during("removing"))),
      });
    }
    // By the link's own id, so a repository not cloned here can be unlinked too.
    const { project, linkId } = row;
    if ((options.unlink ?? true) && canUnlink && project !== null && linkId !== null) {
      actions.push({
        key: "remove-from-project",
        label: `Remove from ${project.label.name}`,
        icon: repositoryRowMenuIcons.removeFromProject,
        destructive: true,
        onSelect: leave(() =>
          removeFromProject({
            project,
            repositoryId: linkId,
            title: row.name,
            onDisk: row.repositoryId !== null,
            during: during("unlinking"),
          }),
        ),
      });
    }
    return actions;
  };
}
