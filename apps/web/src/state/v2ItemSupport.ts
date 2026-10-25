import {
  EMPTY_V2_ITEM_SUPPORT,
  resolveV2ItemSupport,
  v2ItemSupportEqual,
  type V2ItemSupport,
} from "@cogenly/client-runtime/state/item-support";
import type { EnvironmentId, ThreadId, TurnItemId } from "@cogenly/contracts";
import { scopeThreadRef } from "@cogenly/client-runtime/environment";
import { Atom } from "effect/reactivity";

import { environmentThreadDetails } from "./threads";
import { useAtomValueBuiltOutsideRender } from "./useAtomValueBuiltOutsideRender";

function supportKey(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly itemId: TurnItemId;
}): string {
  return JSON.stringify(input);
}

function parseSupportKey(key: string): {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly itemId: TurnItemId;
} {
  return JSON.parse(key) as {
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
    readonly itemId: TurnItemId;
  };
}

const itemSupportAtomFamily = Atom.family((key: string) => {
  const target = parseSupportKey(key);
  const ref = scopeThreadRef(target.environmentId, target.threadId);
  let previous = EMPTY_V2_ITEM_SUPPORT;
  return Atom.make((get): V2ItemSupport => {
    const scoped = get(environmentThreadDetails.threadAtom(ref));
    if (scoped === null) return EMPTY_V2_ITEM_SUPPORT;
    const next = resolveV2ItemSupport(scoped.projection, target.itemId);
    if (v2ItemSupportEqual(previous, next)) return previous;
    previous = next;
    return next;
  }).pipe(Atom.withLabel(`web-v2-item-support:${key}`));
});

const EMPTY_SUPPORT_ATOM = Atom.make(EMPTY_V2_ITEM_SUPPORT).pipe(
  Atom.withLabel("web-v2-item-support:empty"),
);

/**
 * An item's live support. An item inherited from another thread (a fork's
 * history, a subagent's) opens that thread's live state, so it is built
 * outside render.
 */
export function useV2ItemSupport(input: {
  readonly environmentId: EnvironmentId;
  readonly sourceThreadId: ThreadId;
  readonly sourceItemId: TurnItemId;
}): V2ItemSupport {
  return useAtomValueBuiltOutsideRender(
    itemSupportAtomFamily(
      supportKey({
        environmentId: input.environmentId,
        threadId: input.sourceThreadId,
        itemId: input.sourceItemId,
      }),
    ),
    EMPTY_SUPPORT_ATOM,
  );
}
