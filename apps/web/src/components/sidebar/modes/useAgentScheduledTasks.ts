import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ScheduledTask } from "@cogenly/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useMemo } from "react";

import { serverEnvironment } from "../../../state/server";

export interface EnvironmentScheduledTask {
  readonly environmentId: EnvironmentId;
  readonly task: ScheduledTask;
}

const EMPTY: ReadonlyArray<EnvironmentScheduledTask> = [];
const EMPTY_ATOM = Atom.make(EMPTY).pipe(Atom.withLabel("sidebar-agent-tasks:empty"));

/**
 * Every scheduled task on every given environment, from the same live
 * subscription the settings page and thread panel use. An environment that is
 * loading or failed simply contributes nothing; agents there appear once its
 * list arrives.
 */
export function useAgentScheduledTasks(
  environmentIds: ReadonlyArray<EnvironmentId>,
): ReadonlyArray<EnvironmentScheduledTask> {
  const idsKey = environmentIds.join("\0");
  const atom = useMemo(
    () =>
      idsKey === ""
        ? EMPTY_ATOM
        : Atom.make((get) =>
            (idsKey.split("\0") as EnvironmentId[]).flatMap((environmentId) => {
              const result = get(
                serverEnvironment.scheduledTasksLive({ environmentId, input: {} }),
              );
              const tasks = Option.getOrNull(AsyncResult.value(result))?.tasks ?? [];
              return tasks.map((task) => ({ environmentId, task }));
            }),
          ).pipe(Atom.withLabel("sidebar-agent-tasks")),
    [idsKey],
  );
  return useAtomValue(atom);
}
