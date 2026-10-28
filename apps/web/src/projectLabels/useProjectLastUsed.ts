import { useAtomValue } from "@effect/atom-react";
import type { ProjectLabelId } from "@cogenly/contracts";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentThreadShells } from "../state/threads";
import { projectLastUsedAt, sameProjectLastUsedAt } from "./projectOrder.logic";

let previousLastUsedAt: ReadonlyMap<ProjectLabelId, string> = new Map();
/**
 * When the user last worked in each project. It keeps its identity until a
 * project's time changes, so a picker reading it does not re-render on every
 * streamed thread update, only when someone sends a message.
 */
const projectLastUsedAtAtom = Atom.make((get) => {
  const next = projectLastUsedAt(get(environmentThreadShells.threadShellsAtom));
  if (sameProjectLastUsedAt(previousLastUsedAt, next)) return previousLastUsedAt;
  previousLastUsedAt = next;
  return previousLastUsedAt;
}).pipe(Atom.withLabel("web-project-last-used-at"));

/**
 * Project recency for a picker's order. Read while the picker is shut too:
 * the list opens on the current pick, which the combobox finds in the order
 * it had before opening.
 */
export function useProjectLastUsedAt(): ReadonlyMap<ProjectLabelId, string> {
  return useAtomValue(projectLastUsedAtAtom);
}

/** The same, read once, for a menu built at the moment it opens. */
export function readProjectLastUsedAt(): ReadonlyMap<ProjectLabelId, string> {
  return appAtomRegistry.get(projectLastUsedAtAtom);
}
