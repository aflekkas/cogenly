import {
  EnvironmentId,
  MessageId,
  RunId,
  ThreadId,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ThreadShell,
} from "@cogenly/contracts";
import * as DateTime from "effect/DateTime";
import { Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import type { EnvironmentCatalogState } from "./connections.ts";
import { v2Now, v2ShellSnapshot, v2ThreadShell } from "./orchestrationV2TestFixtures.ts";
import { createEnvironmentThreadShellAtoms } from "./threadShell.ts";

const environmentId = EnvironmentId.make("mac");
const runId = RunId.make("streaming-run");
const other = { ...v2ThreadShell, id: ThreadId.make("thread-idle") };
const running: OrchestrationV2ThreadShell = {
  ...v2ThreadShell,
  latestRunId: runId,
  activeRunId: runId,
  status: "running",
  activityRunStatus: "running",
  itemCount: 1,
  visibleItemCount: 1,
};
const at = (seconds: number) => DateTime.add(v2Now, { seconds });

function setup() {
  const snapshotAtom = Atom.make<OrchestrationV2ShellSnapshot | null>(null);
  const atoms = createEnvironmentThreadShellAtoms({
    catalogValueAtom: Atom.make({
      entries: new Map([[environmentId, { enabled: true }]]),
    } as unknown as EnvironmentCatalogState),
    snapshotAtom: () => snapshotAtom,
  });
  const registry = AtomRegistry.make();
  let sequence = 0;
  const setThreads = (...threads: ReadonlyArray<OrchestrationV2ThreadShell>) =>
    registry.set(snapshotAtom, {
      ...v2ShellSnapshot,
      snapshotSequence: ++sequence,
      threads,
    });
  return { atoms, registry, setThreads };
}

describe("quiet thread shell list", () => {
  it("keeps the list through streaming ticks while the live list follows them", () => {
    const { atoms, registry, setThreads } = setup();
    setThreads(running, other);
    const dispose = registry.mount(atoms.quietThreadShellsAtom);
    try {
      const first = registry.get(atoms.quietThreadShellsAtom);
      setThreads(
        {
          ...running,
          updatedAt: at(1),
          itemCount: 4,
          visibleItemCount: 3,
          latestVisibleMessage: {
            id: MessageId.make("message"),
            role: "assistant",
            text: "Streaming",
            updatedAt: at(1),
          },
        },
        other,
      );
      expect(registry.get(atoms.quietThreadShellsAtom)).toBe(first);
      expect(registry.get(atoms.threadShellsAtom)[0]?.itemCount).toBe(4);
    } finally {
      dispose();
      registry.dispose();
    }
  });

  it("takes every real change, and every change once the run stops", () => {
    const { atoms, registry, setThreads } = setup();
    setThreads(running, other);
    const dispose = registry.mount(atoms.quietThreadShellsAtom);
    try {
      const first = registry.get(atoms.quietThreadShellsAtom);
      setThreads({ ...running, updatedAt: at(1), title: "Renamed" }, other);
      const renamed = registry.get(atoms.quietThreadShellsAtom);
      expect(renamed).not.toBe(first);
      expect(renamed[0]?.title).toBe("Renamed");
      // The idle thread's row is untouched.
      expect(renamed[1]).toBe(first[1]);

      const stopped: OrchestrationV2ThreadShell = {
        ...running,
        title: "Renamed",
        activeRunId: null,
        activityRunStatus: null,
        status: "completed",
      };
      setThreads({ ...stopped, updatedAt: at(2) }, other);
      const completed = registry.get(atoms.quietThreadShellsAtom);
      expect(completed[0]?.runtime?.status).toBe("completed");
      setThreads({ ...stopped, updatedAt: at(3) }, other);
      expect(registry.get(atoms.quietThreadShellsAtom)[0]?.updatedAt).toBe(
        DateTime.formatIso(at(3)),
      );
    } finally {
      dispose();
      registry.dispose();
    }
  });

  it("follows a thread's first item, which marks it as started", () => {
    const { atoms, registry, setThreads } = setup();
    setThreads({ ...running, itemCount: 0, visibleItemCount: 0 });
    const dispose = registry.mount(atoms.quietThreadShellsAtom);
    try {
      const empty = registry.get(atoms.quietThreadShellsAtom);
      setThreads({ ...running, itemCount: 1, visibleItemCount: 1 });
      expect(registry.get(atoms.quietThreadShellsAtom)).not.toBe(empty);
      expect(registry.get(atoms.quietThreadShellsAtom)[0]?.itemCount).toBe(1);
    } finally {
      dispose();
      registry.dispose();
    }
  });
});
