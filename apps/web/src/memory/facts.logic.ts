import type {
  CommitmentRef,
  ContextPrincipal,
  Fact,
  FactCreateInput,
  ProjectLabelId,
  ThreadId,
} from "@t3tools/contracts";

import { safeExternalUrl } from "../search/globalSearch.logic";

export type FactStatus = Fact["status"];
/** "current" is what context can draw on: confirmed facts plus proposals awaiting a decision. */
export type FactStatusFilter = "current" | FactStatus | "all";

export const FACT_STATUS_LABEL: Record<FactStatus, string> = {
  proposed: "Proposed",
  confirmed: "Confirmed",
  superseded: "Replaced",
  retracted: "Forgotten",
};

export const FACT_STATUS_FILTERS: ReadonlyArray<{ value: FactStatusFilter; label: string }> = [
  { value: "current", label: "Current" },
  { value: "proposed", label: "Proposed" },
  { value: "confirmed", label: "Confirmed" },
  { value: "superseded", label: "Replaced" },
  { value: "retracted", label: "Forgotten" },
  { value: "all", label: "All" },
];

const STATUS_RANK: Record<FactStatus, number> = {
  proposed: 0,
  confirmed: 1,
  superseded: 2,
  retracted: 3,
};

/** Proposals first (they need a decision), then newest. */
export function filterFacts(
  facts: ReadonlyArray<Fact>,
  filter: { readonly status: FactStatusFilter; readonly query?: string },
): Fact[] {
  const needle = filter.query?.trim().toLowerCase() ?? "";
  return facts
    .filter((fact) =>
      filter.status === "all"
        ? true
        : filter.status === "current"
          ? fact.status === "proposed" || fact.status === "confirmed"
          : fact.status === filter.status,
    )
    .filter(
      (fact) =>
        needle === "" ||
        fact.subject.toLowerCase().includes(needle) ||
        fact.text.toLowerCase().includes(needle),
    )
    .toSorted(
      (left, right) =>
        STATUS_RANK[left.status] - STATUS_RANK[right.status] ||
        right.updatedAt.localeCompare(left.updatedAt) ||
        left.id.localeCompare(right.id),
    );
}

export function principalAgentId(principal: ContextPrincipal): string | null {
  return principal === "user" ? null : principal.slice("agent:".length);
}

export function principalLabel(
  principal: ContextPrincipal,
  agentName: (agentId: string) => string | undefined,
): string {
  const agentId = principalAgentId(principal);
  return agentId === null ? "You" : (agentName(agentId) ?? "An agent");
}

export type ResolvedFactRef =
  | { readonly kind: "thread"; readonly label: string; readonly threadId: ThreadId }
  | { readonly kind: "external"; readonly label: string; readonly href: string }
  | { readonly kind: "text"; readonly label: string };

/**
 * Sources as links. A message ref has no thread of its own, so it links through the
 * thread ref saved beside it; bare run and message refs stay labels.
 */
export function resolveFactRefs(refs: ReadonlyArray<CommitmentRef>): ResolvedFactRef[] {
  const thread = refs.find((ref) => ref.kind === "thread");
  const resolved: ResolvedFactRef[] = [];
  for (const ref of refs) {
    switch (ref.kind) {
      case "thread":
        if (refs.some((other) => other.kind === "message")) break;
        resolved.push({ kind: "thread", label: "Thread", threadId: ref.id as ThreadId });
        break;
      case "message":
        resolved.push(
          thread
            ? { kind: "thread", label: "Message", threadId: thread.id as ThreadId }
            : { kind: "text", label: "Message" },
        );
        break;
      case "run":
        resolved.push({ kind: "text", label: "Run" });
        break;
      case "pr":
      case "url": {
        const href = safeExternalUrl(ref.id);
        const number = ref.kind === "pr" ? ref.id.match(/\/pull\/(\d+)/)?.[1] : undefined;
        const label = number ? `PR #${number}` : ref.kind === "pr" ? "Pull request" : "Link";
        resolved.push(href ? { kind: "external", label, href } : { kind: "text", label });
        break;
      }
    }
  }
  return resolved;
}

/** The replacement a correction saves: same scope and sources, new wording. */
export function correctedFact(
  fact: Fact,
  edit: {
    readonly subject: string;
    readonly text: string;
    readonly labelIds: ReadonlyArray<ProjectLabelId>;
  },
): FactCreateInput {
  return {
    subject: edit.subject.trim(),
    text: edit.text.trim(),
    labelIds: [...edit.labelIds],
    visibility: edit.labelIds.length > 0 ? "labels" : "user",
    sourceRefs: [...fact.sourceRefs],
    ...(fact.predicate ? { predicate: fact.predicate } : {}),
    ...(fact.agentId ? { agentId: fact.agentId } : {}),
  };
}
