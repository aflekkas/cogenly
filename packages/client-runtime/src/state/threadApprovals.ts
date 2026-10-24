import {
  WS_METHODS,
  type AgentApproval,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcSubscriptionAtomFamily } from "./runtime.ts";

const EMPTY_APPROVALS: ReadonlyArray<AgentApproval> = Object.freeze([]);
const EMPTY_THREAD_IDS: ReadonlySet<ThreadId> = new Set();

/** The thread an ordinary thread's approval waits in; both the vault and accounts kinds carry it. */
export function threadApprovalThreadId(approval: Pick<AgentApproval, "action">): ThreadId | null {
  return approval.action.actionKind === "vault_use" ? approval.action.payload.threadId : null;
}

/**
 * Pending owner approvals raised by ordinary threads (a vault fill, a CLI token),
 * live per environment. The thread-id set marks those threads as waiting on the
 * user wherever thread shells are presented.
 */
export function createThreadApprovalAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const live = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "thread-approvals:live",
    tag: WS_METHODS.threadApprovalsSubscribe,
  });

  // Keeps its identity until the pending set changes, so a re-sent equal list re-renders nothing.
  const pendingAtom = Atom.family((environmentId: EnvironmentId) => {
    let previous = EMPTY_APPROVALS;
    return Atom.make((get) => {
      const result = get(live({ environmentId, input: {} }));
      const next = Option.match(AsyncResult.value(result), {
        onNone: () => previous,
        onSome: (value) => value.approvals,
      });
      if (
        next.length === previous.length &&
        next.every((approval, index) => approval.id === previous[index]?.id)
      )
        return previous;
      previous = next.length === 0 ? EMPTY_APPROVALS : next;
      return previous;
    }).pipe(Atom.withLabel(`thread-approvals:pending:${environmentId}`));
  });

  const threadIdsAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get): ReadonlySet<ThreadId> => {
      const approvals = get(pendingAtom(environmentId));
      if (approvals.length === 0) return EMPTY_THREAD_IDS;
      return new Set(approvals.flatMap((approval) => threadApprovalThreadId(approval) ?? []));
    }).pipe(Atom.withLabel(`thread-approvals:threads:${environmentId}`)),
  );

  const forThreadAtom = Atom.family((key: `${EnvironmentId}\u0000${ThreadId}`) => {
    const [environmentId, threadId] = key.split("\u0000") as [EnvironmentId, ThreadId];
    let previous = EMPTY_APPROVALS;
    return Atom.make((get) => {
      const next = get(pendingAtom(environmentId)).filter(
        (approval) => threadApprovalThreadId(approval) === threadId,
      );
      if (
        next.length === previous.length &&
        next.every((approval, index) => approval.id === previous[index]?.id)
      )
        return previous;
      previous = next.length === 0 ? EMPTY_APPROVALS : next;
      return previous;
    }).pipe(Atom.withLabel(`thread-approvals:thread:${environmentId}:${threadId}`));
  });

  return {
    pendingAtom,
    threadIdsAtom,
    forThreadAtom: (environmentId: EnvironmentId, threadId: ThreadId) =>
      forThreadAtom(`${environmentId}\u0000${threadId}`),
  };
}
