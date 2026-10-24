import { EnvironmentId, ThreadId, type OrchestrationV2ThreadShell } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { Atom, AtomRegistry } from "effect/reactivity";

import { v2ShellSnapshot, v2ThreadShell, v2ThreadId } from "./orchestrationV2TestFixtures.ts";
import { createEnvironmentThreadShellAtoms } from "./threadShell.ts";
import type { EnvironmentCatalogState } from "./connections.ts";

const environmentId = EnvironmentId.make("env");
const other = ThreadId.make("thread-other");

function setup(threads: ReadonlyArray<OrchestrationV2ThreadShell>) {
  const waiting = Atom.make<ReadonlyArray<ThreadId>>([]);
  const waitingSet = Atom.map(waiting, (ids): ReadonlySet<ThreadId> => new Set(ids));
  const atoms = createEnvironmentThreadShellAtoms({
    catalogValueAtom: Atom.make({
      environments: [{ environmentId, enabled: true }],
    } as unknown as EnvironmentCatalogState),
    snapshotAtom: () => Atom.make({ ...v2ShellSnapshot, threads }),
    ownerApprovalThreadIdsAtom: () => waitingSet,
  });
  const registry = AtomRegistry.make();
  const shell = (threadId: ThreadId) =>
    registry.get(atoms.threadShellAtom({ environmentId, threadId }));
  return { registry, waiting, shell };
}

describe("owner approvals on thread shells", () => {
  it("marks only the waiting thread as needing approval, and clears when it is decided", () => {
    const { registry, waiting, shell } = setup([v2ThreadShell, { ...v2ThreadShell, id: other }]);
    expect(shell(v2ThreadId)?.hasPendingApprovals).toBe(false);
    registry.set(waiting, [v2ThreadId]);
    expect(shell(v2ThreadId)?.hasPendingApprovals).toBe(true);
    expect(shell(other)?.hasPendingApprovals).toBe(false);
    registry.set(waiting, []);
    expect(shell(v2ThreadId)?.hasPendingApprovals).toBe(false);
  });

  it("does not mark a settled thread as waiting", () => {
    const { registry, waiting, shell } = setup([{ ...v2ThreadShell, settledOverride: "settled" }]);
    registry.set(waiting, [v2ThreadId]);
    expect(shell(v2ThreadId)?.hasPendingApprovals).toBe(false);
  });
});
