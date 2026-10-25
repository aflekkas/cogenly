import { EnvironmentId, ThreadId, type OrchestrationV2ThreadShell } from "@cogenly/contracts";
import { describe, expect, it } from "vite-plus/test";
import { Atom, AtomRegistry } from "effect/reactivity";

import { v2ShellSnapshot, v2ThreadShell } from "./orchestrationV2TestFixtures.ts";
import { createEnvironmentThreadShellAtoms, preferredThreadCopies } from "./threadShell.ts";
import type { EnvironmentCatalogState } from "./connections.ts";

const mac = EnvironmentId.make("mac");
const vps = EnvironmentId.make("vps");
const shared = ThreadId.make("thread-shared");
const vpsOwn = ThreadId.make("thread-vps");

// Paired machines each hold every thread: the Mac runs `shared`, the VPS keeps
// a replica of it, and the VPS runs `vpsOwn`, which the Mac replicates.
const onMac: ReadonlyArray<OrchestrationV2ThreadShell> = [
  { ...v2ThreadShell, id: shared, ownerMachine: null },
  { ...v2ThreadShell, id: vpsOwn, ownerMachine: vps },
];
const onVps: ReadonlyArray<OrchestrationV2ThreadShell> = [
  { ...v2ThreadShell, id: shared, ownerMachine: mac },
  { ...v2ThreadShell, id: vpsOwn, ownerMachine: null },
];

function setup(connected: ReadonlyArray<EnvironmentId>) {
  const threadsOf = new Map([
    [mac, onMac],
    [vps, onVps],
  ]);
  const atoms = createEnvironmentThreadShellAtoms({
    catalogValueAtom: Atom.make({
      entries: new Map(connected.map((environmentId) => [environmentId, { enabled: true }])),
    } as unknown as EnvironmentCatalogState),
    snapshotAtom: (environmentId) =>
      Atom.make({ ...v2ShellSnapshot, threads: threadsOf.get(environmentId) ?? [] }),
  });
  return { registry: AtomRegistry.make(), atoms };
}

describe("threads replicated across connected machines", () => {
  it("lists each thread once, from the machine that runs it", () => {
    const { registry, atoms } = setup([mac, vps]);
    const listed = registry
      .get(atoms.threadShellsAtom)
      .map((thread) => [thread.id, thread.environmentId] as const);
    expect(listed).toEqual([
      [shared, mac],
      [vpsOwn, vps],
    ]);
    expect(registry.get(atoms.navigationThreadShellsAtom)).toHaveLength(2);
    expect(registry.get(atoms.threadRefsAtom)).toEqual([
      { environmentId: mac, threadId: shared },
      { environmentId: vps, threadId: vpsOwn },
    ]);
  });

  it("lists the replica, which still names its runner, when only that machine is connected", () => {
    const { registry, atoms } = setup([vps]);
    const listed = registry.get(atoms.threadShellsAtom);
    expect(listed.map((thread) => [thread.id, thread.source.ownerMachine ?? null])).toEqual([
      [shared, mac],
      [vpsOwn, null],
    ]);
  });

  it("keeps a replica reachable by its own ref", () => {
    const { registry, atoms } = setup([mac, vps]);
    expect(registry.get(atoms.threadShellAtom({ environmentId: vps, threadId: shared }))).not.toBe(
      null,
    );
  });
});

describe("preferredThreadCopies", () => {
  it("prefers the runner's copy, else the first machine listed", () => {
    const outside = EnvironmentId.make("laptop");
    const preferred = preferredThreadCopies([
      { environmentId: vps, threads: [{ id: shared, ownerMachine: outside }] },
      { environmentId: mac, threads: [{ id: shared, ownerMachine: outside }] },
    ]);
    expect(preferred.get(shared)).toBe(vps);
    const withRunner = preferredThreadCopies([
      { environmentId: vps, threads: onVps },
      { environmentId: mac, threads: onMac },
    ]);
    expect(withRunner.get(shared)).toBe(mac);
    expect(withRunner.get(vpsOwn)).toBe(vps);
  });
});
