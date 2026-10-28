import type { IntegrationSource, LinkContextRecord, ThreadSource } from "@cogenly/contracts";

/** The stack shows this many icons, then "+N". */
export const COMPOSER_SOURCE_STACK_MAX = 4;

/**
 * The connected integrations a thread is using: the ones its draft mentions
 * (newest mention first), then the ones its messages mentioned or its agent
 * called, most recent first. A source the user removed from the thread stays
 * out until they mention or pick it again. Sources the environment no longer
 * has are skipped, since the picker cannot act on them.
 */
export function deriveComposerSourcesInUse(input: {
  readonly draftContexts: ReadonlyArray<LinkContextRecord>;
  readonly threadSources: ReadonlyArray<ThreadSource> | null;
  readonly removed: ReadonlyArray<string>;
  readonly all: ReadonlyArray<IntegrationSource>;
}): IntegrationSource[] {
  const byId = new Map(input.all.map((source) => [source.id as string, source]));
  const byName = new Map(input.all.map((source) => [source.name as string, source]));
  const removed = new Set(input.removed);
  const seen = new Set<string>();
  const inUse: IntegrationSource[] = [];
  const add = (source: IntegrationSource | undefined) => {
    if (source === undefined || seen.has(source.id)) return;
    seen.add(source.id);
    inUse.push(source);
  };
  for (const record of input.draftContexts.toReversed()) {
    if (record.kind === "integration") add(byId.get(record.integrationId));
  }
  for (const source of input.threadSources ?? []) {
    if (source.kind !== "integration") continue;
    const live = byName.get(source.name);
    if (live !== undefined && !removed.has(live.name)) add(live);
  }
  return inUse;
}

/** The icons the stack draws and how many more it folds into "+N". */
export function composerSourceStackWindow<T>(sources: ReadonlyArray<T>): {
  readonly shown: ReadonlyArray<T>;
  readonly overflow: number;
} {
  const shown = sources.slice(0, COMPOSER_SOURCE_STACK_MAX);
  return { shown, overflow: sources.length - shown.length };
}
