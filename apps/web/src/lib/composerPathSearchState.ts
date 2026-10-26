import {
  type ComposerPathSearchState,
  type ComposerPathSearchTarget,
} from "@cogenly/client-runtime/state/threads";

import { useMemo, useState } from "react";

import { useComposerPathSearch as useComposerPathSearchQuery } from "../state/queries";

type PathSearchEntries = ComposerPathSearchState["entries"];

/** The last settled results, and which folder they came from. */
export interface HeldPathSearch {
  readonly scope: string;
  readonly entries: PathSearchEntries;
}

/**
 * What the menu shows while a search runs. Each query is its own request, so a new one starts
 * empty; until it answers, the previous query's results in the same folder stand in, and the
 * menu swaps rows instead of dropping them and growing back on every keystroke.
 */
export function composerPathSearchEntries(input: {
  readonly held: HeldPathSearch | null;
  /** Null without a query to search: nothing is held across it. */
  readonly scope: string | null;
  readonly entries: PathSearchEntries;
  readonly isPending: boolean;
}): PathSearchEntries {
  if (
    input.isPending &&
    input.entries.length === 0 &&
    input.scope !== null &&
    input.held?.scope === input.scope
  ) {
    return input.held.entries;
  }
  return input.entries;
}

export function useComposerPathSearch(target: ComposerPathSearchTarget): ComposerPathSearchState {
  const state = useComposerPathSearchQuery(target);
  const scope =
    target.environmentId !== null && target.cwd !== null && target.query?.trim()
      ? `${target.environmentId}\u0000${target.cwd}`
      : null;
  const [held, setHeld] = useState<HeldPathSearch | null>(null);
  if (scope === null) {
    if (held !== null) setHeld(null);
  } else if (!state.isPending && (held?.scope !== scope || held.entries !== state.entries)) {
    setHeld({ scope, entries: state.entries });
  }
  const shown = composerPathSearchEntries({
    held,
    scope,
    entries: state.entries,
    isPending: state.isPending,
  });
  // A stable list lets the composer menu memo cache between renders.
  const entries = useMemo(
    () => shown.map((entry) => ({ path: entry.path, kind: entry.kind })),
    [shown],
  );
  return {
    entries,
    error: state.error,
    isPending: state.isPending,
  };
}
