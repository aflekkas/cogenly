/**
 * What a draft keeps when the composer's "Run on" moves it to another
 * machine. Projects sync under one id on every machine and repositories are
 * matched by their remote, so a switch keeps the project and the repository
 * wherever the target can hold them, and switching back finds the same ones.
 */
import {
  isRemoteRepositoryPlaceholder,
  type EnvironmentId,
  type ModelSelection,
  type ProjectId,
  type ProjectLabelId,
  type ProjectLabelWithRepositories,
} from "@cogenly/contracts";

import type { ProviderInstanceEntry } from "../providerInstances";

/** The draft as it is on the machine it leaves. */
export interface MachineSwitchDraft {
  /** Its repository there; null when it runs without one, in that machine's no-project home. */
  readonly repository: { readonly id: ProjectId; readonly remote: string | null } | null;
  /** The project it is in (picked, or its repository's), by its synced id. */
  readonly projectId: ProjectLabelId | null;
}

/** What the target machine offers for it. */
export interface MachineSwitchTarget {
  readonly environmentId: EnvironmentId;
  /** The target's checkout of the same repository by remote, as "Run on" lists it. */
  readonly recordId: ProjectId | null;
  /** The draft's project as the target has it; null when the target has no copy. */
  readonly project: Pick<ProjectLabelWithRepositories, "repositories"> | null;
  /** Whether the draft's own machine can launch on the target (they are paired). */
  readonly canLaunchThere: boolean;
}

export type MachineSwitchPlan =
  /**
   * Move the draft to the target: onto `repositoryId`, or with null to the
   * target's no-project home. `keepProject` re-files a picked project there.
   */
  | {
      readonly kind: "move";
      readonly repositoryId: ProjectId | null;
      readonly keepProject: boolean;
    }
  /**
   * Keep the draft, its project and repository where they are and run it on
   * the target, which files its own checkout of the repository or clones it
   * there on send. Switching back is clearing that.
   */
  | { readonly kind: "launch-there" };

function sameRemote(left: string | null | undefined, right: string | null | undefined): boolean {
  return (
    left !== null &&
    left !== undefined &&
    right !== null &&
    right !== undefined &&
    left.toLowerCase() === right.toLowerCase()
  );
}

/**
 * Where the draft lands on the target. A repository the target holds in the
 * same project is moved to; one the project links but the target has not
 * cloned (or holds outside the project) keeps the draft as it is and runs it
 * there, cloning on send; only when neither works does the draft move to the
 * target's copy of the repository, or to its no-project home.
 */
export function planMachineSwitch(
  draft: MachineSwitchDraft,
  target: MachineSwitchTarget,
): MachineSwitchPlan {
  const keepProject = draft.projectId !== null && target.project !== null;
  if (draft.repository === null) return { kind: "move", repositoryId: null, keepProject };
  const { remote } = draft.repository;
  const canCloneThere = target.canLaunchThere && remote !== null;
  if (draft.projectId === null) {
    if (target.recordId !== null)
      return { kind: "move", repositoryId: target.recordId, keepProject: false };
    return canCloneThere
      ? { kind: "launch-there" }
      : { kind: "move", repositoryId: null, keepProject: false };
  }
  const link = (target.project?.repositories ?? []).find(
    (candidate) =>
      sameRemote(candidate.remote, remote) || candidate.repositoryId === draft.repository?.id,
  );
  const heldThere =
    link !== undefined &&
    !isRemoteRepositoryPlaceholder(link.repositoryId) &&
    (link.checkout === undefined || link.checkout === "ready");
  if (heldThere) return { kind: "move", repositoryId: link.repositoryId, keepProject };
  if (canCloneThere && (target.project !== null || target.recordId === null))
    return { kind: "launch-there" };
  return { kind: "move", repositoryId: target.recordId, keepProject };
}

/** The draft's model on the target, and a quiet note when it had to change. */
export interface MachineSwitchModel {
  readonly selection: ModelSelection;
  readonly note: string | null;
}

/**
 * Keeps the draft's model where the target has its provider instance. Where
 * it does not, the same kind of provider stands in (Claude for Claude), on
 * the same model when that one offers it, else on its default; the note says
 * so. Null when nothing needs to change, or no provider of that kind is there
 * (the composer then shows the provider as unavailable, as before).
 */
export function modelOnMachine(input: {
  readonly selection: ModelSelection | null;
  readonly here: ReadonlyArray<ProviderInstanceEntry>;
  readonly there: ReadonlyArray<ProviderInstanceEntry>;
  readonly machineName: string;
}): MachineSwitchModel | null {
  const { selection } = input;
  if (selection === null) return null;
  const usable = (entry: ProviderInstanceEntry) => entry.enabled && entry.isAvailable;
  if (input.there.some((entry) => entry.instanceId === selection.instanceId && usable(entry)))
    return null;
  const source = input.here.find((entry) => entry.instanceId === selection.instanceId);
  if (source === undefined) return null;
  const sameKind = input.there.filter(
    (entry) => entry.driverKind === source.driverKind && usable(entry),
  );
  const stand = sameKind.find((entry) => entry.isDefault) ?? sameKind[0];
  if (stand === undefined) return null;
  const model =
    stand.models.find((candidate) => candidate.slug === selection.model)?.slug ??
    stand.models.find((candidate) => candidate.isDefault)?.slug ??
    stand.models[0]?.slug;
  if (model === undefined) return null;
  // Options (effort and the like) belong to the provider kind, so they carry
  // over with the same model; another model starts from its own.
  const options = model === selection.model ? selection.options : undefined;
  return {
    selection: {
      instanceId: stand.instanceId,
      model,
      ...(options === undefined ? {} : { options }),
    },
    note:
      model === selection.model
        ? `${source.displayName} isn't on ${input.machineName}; using ${stand.displayName}.`
        : `${source.displayName} isn't on ${input.machineName}; using ${stand.displayName} with its default model.`,
  };
}
