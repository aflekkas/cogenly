import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ProjectLabelId } from "@cogenly/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useEffect, useMemo, useState } from "react";

import { serverEnvironment } from "../state/server";
import {
  projectLabelKey,
  type EnvironmentProjectLabel,
  type ProjectLabelKey,
} from "./projectLabels.logic";
import {
  linkedGitHubOwners,
  ownerSearchErrorMessage,
  ownerSearchProjects,
  type OwnerSearchState,
} from "./projectSourceLinks.logic";

/** Typing settles this long before GitHub is asked; the server allows 8s per owner. */
const SEARCH_DEBOUNCE_MS = 250;
/** A search that answers faster than this never shows its spinner. */
const LOADING_ROW_DELAY_MS = 300;

interface SearchTarget {
  readonly environmentId: EnvironmentId;
  readonly labelId: ProjectLabelId;
  readonly owners: ReadonlyArray<string>;
}

type RawState = OwnerSearchState | { readonly status: "pending" };

const EMPTY_RAW = new Map<ProjectLabelKey, RawState>();
const EMPTY_RAW_ATOM = Atom.make(EMPTY_RAW).pipe(Atom.withLabel("owner-repository-search:empty"));
const EMPTY_STATES = new Map<ProjectLabelKey, OwnerSearchState>();

function searchErrorReason(cause: Cause.Cause<unknown>) {
  const error = Option.getOrNull(Cause.findErrorOption(cause));
  return typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    error._tag === "ProjectLabelOwnerSearchError" &&
    "reason" in error
    ? (error.reason as Parameters<typeof ownerSearchErrorMessage>[0])
    : null;
}

/**
 * GitHub repositories under each project's linked owners (or the signed-in
 * account's, when it links none) that match the picker's search, keyed by
 * project. Searches while `active` (the picker is open): an empty query lists
 * recent pushes, a typed one asks once typing pauses. Keeps a project's last
 * results on screen while the next search runs, and reports loading only once
 * the spinner delay passed (absent before then).
 */
export function useOwnerRepositorySearch(
  projects: ReadonlyArray<EnvironmentProjectLabel>,
  query: string,
  active: boolean,
): ReadonlyMap<ProjectLabelKey, OwnerSearchState> {
  const trimmed = query.trim();
  const [debounced, setDebounced] = useState(trimmed);
  useEffect(() => {
    if (trimmed === debounced) return;
    const timeout = window.setTimeout(() => setDebounced(trimmed), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timeout);
  }, [debounced, trimmed]);

  const targets = useMemo(
    (): SearchTarget[] =>
      ownerSearchProjects(projects, active).map((project) => ({
        environmentId: project.environmentId,
        labelId: project.label.id,
        owners: linkedGitHubOwners(project),
      })),
    [projects, active],
  );
  // Clearing the search lists recent pushes again at once, without the debounce.
  const searchedQuery = trimmed.length === 0 ? "" : debounced;
  const targetsKey = JSON.stringify(targets);
  const atom = useMemo(() => {
    const parsed = JSON.parse(targetsKey) as SearchTarget[];
    if (parsed.length === 0) return EMPTY_RAW_ATOM;
    return Atom.make((get) => {
      const states = new Map<ProjectLabelKey, RawState>();
      for (const target of parsed) {
        const result = get(
          serverEnvironment.projectLabelOwnerRepositories({
            environmentId: target.environmentId,
            input: { id: target.labelId, query: searchedQuery },
          }),
        );
        const key = projectLabelKey(target.environmentId, target.labelId);
        if (result._tag === "Success" && !result.waiting) {
          states.set(key, { status: "done", repositories: result.value.repositories });
        } else if (result._tag === "Failure" && !result.waiting) {
          states.set(key, {
            status: "error",
            message: ownerSearchErrorMessage(searchErrorReason(result.cause), target.owners),
          });
        } else {
          const previous = Option.getOrNull(AsyncResult.value(result));
          states.set(
            key,
            previous
              ? { status: "done", repositories: previous.repositories }
              : { status: "pending" },
          );
        }
      }
      return states;
    }).pipe(Atom.withLabel("owner-repository-search"));
  }, [searchedQuery, targetsKey]);
  const raw = useAtomValue(atom);

  // Last settled state per project, shown while a newer search runs, so rows
  // update in place instead of blinking out on every keystroke.
  const [settled, setSettled] = useState(EMPTY_STATES);
  useEffect(() => {
    const next = new Map<ProjectLabelKey, OwnerSearchState>();
    let changed = false;
    for (const [key, state] of raw) {
      if (state.status === "pending") continue;
      next.set(key, state);
      changed = true;
    }
    if (changed) setSettled((current) => new Map([...current, ...next]));
  }, [raw]);

  // A closed picker opens next time from nothing, not from old results.
  useEffect(() => {
    if (!active) setSettled((current) => (current.size === 0 ? current : EMPTY_STATES));
  }, [active]);

  const fresh = searchedQuery === trimmed;
  const waiting =
    targets.length > 0 &&
    (!fresh ||
      targets.some((target) => {
        const state = raw.get(projectLabelKey(target.environmentId, target.labelId));
        return state === undefined || state.status === "pending";
      }));
  const requestKey = `${targetsKey}\u0000${trimmed}`;
  const [slowRequestKey, setSlowRequestKey] = useState<string | null>(null);
  useEffect(() => {
    if (!waiting) return;
    const timeout = window.setTimeout(() => setSlowRequestKey(requestKey), LOADING_ROW_DELAY_MS);
    return () => window.clearTimeout(timeout);
  }, [requestKey, waiting]);
  const showLoading = waiting && slowRequestKey === requestKey;

  return useMemo(() => {
    if (targets.length === 0) return EMPTY_STATES;
    const states = new Map<ProjectLabelKey, OwnerSearchState>();
    for (const target of targets) {
      const key = projectLabelKey(target.environmentId, target.labelId);
      const current = fresh ? raw.get(key) : undefined;
      if (current && current.status !== "pending") {
        states.set(key, current);
        continue;
      }
      const previous = settled.get(key);
      if (previous?.status === "done") states.set(key, previous);
      else if (showLoading) states.set(key, { status: "loading" });
    }
    return states;
  }, [fresh, raw, settled, showLoading, targets]);
}
