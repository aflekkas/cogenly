import { useAtomValue } from "@effect/atom-react";

import { createEnvironmentRpcQueryAtomFamily } from "@cogenly/client-runtime/state/runtime";
import { WS_METHODS } from "@cogenly/contracts";

import type { EnvironmentId, PullRequestListInput } from "@cogenly/contracts";

import * as Option from "effect/Option";

import { AsyncResult, Atom } from "effect/reactivity";

import { useCallback, useMemo } from "react";

import { connectionAtomRuntime } from "../connection/runtime";

import { appAtomRegistry } from "../rpc/atomRegistry";

import { mergePullRequestLists, type MergedPullRequestList } from "~/lib/pullRequestSuggestions";

import { formatEnvironmentQueryError } from "./query";

export const pullRequestEnvironment = {
  list: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "composer:pull-request-suggestions",
    tag: WS_METHODS.pullRequestsList,
    staleTimeMs: 30_000,
  }),
  detail: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "composer:pull-request-reference",
    tag: WS_METHODS.pullRequestsDetail,
    staleTimeMs: 60_000,
  }),
};

export interface EnvironmentQueryTarget<Input> {
  readonly environmentId: EnvironmentId;
  readonly input: Input;
}

interface MergedEnvironmentQueryView<A> {
  /** One entry per query target that has answered, in the order the targets were given. */
  readonly values: ReadonlyArray<readonly [EnvironmentId, A]>;
  /** The first environment that failed. Others may still have answered — this is not fatal. */
  readonly error: string | null;
  readonly isPending: boolean;
  readonly observations: ReadonlyArray<readonly [EnvironmentId, A, number]>;
}

/**
 * The same per-environment query read across several environments at once. React cannot subscribe
 * to a list of atoms whose length changes, so the fan-out happens inside one derived atom keyed by
 * the targets — the same shape the cross-environment thread search uses.
 *
 * An environment that fails contributes nothing rather than blanking the page: the pull request
 * list is a union, and one unreachable machine should not hide the others' rows.
 */
function createMergedEnvironmentQuery<Input, A>(
  label: string,
  atomFor: (
    target: EnvironmentQueryTarget<Input>,
  ) => Atom.Atom<AsyncResult.AsyncResult<A, unknown>>,
) {
  const family = Atom.family((key: string) =>
    Atom.make((get): MergedEnvironmentQueryView<A> => {
      const targets = JSON.parse(key) as ReadonlyArray<EnvironmentQueryTarget<Input>>;
      const values: Array<readonly [EnvironmentId, A]> = [];
      const observations: Array<readonly [EnvironmentId, A, number]> = [];
      let error: string | null = null;
      let isPending = false;
      for (const target of targets) {
        const result = get(atomFor(target));
        isPending ||= result.waiting;
        if (result._tag === "Failure" && error === null) {
          error = formatEnvironmentQueryError(result.cause);
        }
        const value = Option.getOrNull(AsyncResult.value(result));
        if (value !== null) values.push([target.environmentId, value]);
        if (result._tag === "Success") {
          observations.push([target.environmentId, result.value, result.timestamp]);
        }
      }
      return { values, error, isPending, observations };
    }).pipe(Atom.withLabel(`${label}:${key}`)),
  );
  const empty = Atom.make<MergedEnvironmentQueryView<A>>({
    values: [],
    observations: [],
    error: null,
    isPending: false,
  }).pipe(Atom.withLabel(`${label}:empty`));
  return function useMergedQuery(targets: ReadonlyArray<EnvironmentQueryTarget<Input>>) {
    const key = JSON.stringify(targets);
    const view = useAtomValue(targets.length === 0 ? empty : family(key));
    const refresh = useCallback(
      (override?: ReadonlyArray<EnvironmentQueryTarget<Input>>) => {
        const refreshTargets =
          override ?? (JSON.parse(key) as ReadonlyArray<EnvironmentQueryTarget<Input>>);
        for (const atom of new Set(refreshTargets.map(atomFor))) {
          appAtomRegistry.refresh(atom);
        }
      },
      [key],
    );
    return { ...view, refresh };
  };
}

const usePullRequestListsQuery = createMergedEnvironmentQuery(
  "web-pull-requests:list",
  pullRequestEnvironment.list,
);

export interface MergedPullRequestListView {
  readonly data: MergedPullRequestList | null;
  readonly error: string | null;
  readonly isPending: boolean;
  readonly refresh: (targets?: ReadonlyArray<EnvironmentQueryTarget<PullRequestListInput>>) => void;
}

/** One listing per environment, merged into the single list the page renders. */
export function usePullRequestList(
  targets: ReadonlyArray<EnvironmentQueryTarget<PullRequestListInput>>,
): MergedPullRequestListView {
  const query = usePullRequestListsQuery(targets);
  const data = useMemo(() => mergePullRequestLists(query.values), [query.values]);
  return { data, error: query.error, isPending: query.isPending, refresh: query.refresh };
}
