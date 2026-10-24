import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, MachineListResult } from "@cogenly/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useMemo } from "react";

import { useEnvironmentQuery } from "../state/query";
import { serverEnvironment } from "../state/server";

/** The machines one environment is paired with, live; null until the list arrives. */
export function useEnvironmentMachineList(
  environmentId: EnvironmentId | null,
): MachineListResult | null {
  return useEnvironmentQuery(
    environmentId === null ? null : serverEnvironment.machinesLive({ environmentId, input: {} }),
  ).data;
}

export type MachineDirectory = ReadonlyMap<EnvironmentId, MachineListResult>;

const EMPTY_DIRECTORY: MachineDirectory = new Map();
const EMPTY_DIRECTORY_ATOM = Atom.make(EMPTY_DIRECTORY).pipe(
  Atom.withLabel("machine-directory:empty"),
);

/**
 * Each environment's machine list, from one live stream per environment. An
 * environment still loading, failed, or too old to list machines contributes
 * nothing, so every move action stays hidden there.
 */
export function useMachineDirectory(
  environmentIds: ReadonlyArray<EnvironmentId>,
): MachineDirectory {
  const idsKey = environmentIds.join("\0");
  const atom = useMemo(
    () =>
      idsKey === ""
        ? EMPTY_DIRECTORY_ATOM
        : Atom.make((get): MachineDirectory => {
            const directory = new Map<EnvironmentId, MachineListResult>();
            for (const environmentId of idsKey.split("\0") as EnvironmentId[]) {
              const list = Option.getOrNull(
                AsyncResult.value(
                  get(serverEnvironment.machinesLive({ environmentId, input: {} })),
                ),
              );
              if (list !== null) directory.set(environmentId, list);
            }
            return directory.size === 0 ? EMPTY_DIRECTORY : directory;
          }).pipe(Atom.withLabel("machine-directory")),
    [idsKey],
  );
  return useAtomValue(atom);
}
