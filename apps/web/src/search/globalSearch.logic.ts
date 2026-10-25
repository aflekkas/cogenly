import type {
  Commitment,
  EnvironmentId,
  ProjectLabelId,
  SearchKind,
  SearchQueryResult,
  ThreadId,
} from "@cogenly/contracts";

/** Shorter queries match too much of everything to be worth a server round trip. */
export const GLOBAL_SEARCH_MIN_QUERY_LENGTH = 2;
/** Per environment; the server caps at 100. */
export const GLOBAL_SEARCH_LIMIT = 30;
/** Rows per kind in the palette, so one noisy kind cannot bury the rest. */
export const GLOBAL_SEARCH_PER_KIND = 5;

export type GlobalSearchResult = SearchQueryResult["results"][number] & {
  readonly environmentId: EnvironmentId;
};

export const GLOBAL_SEARCH_KIND_ORDER: ReadonlyArray<SearchKind> = [
  "chat",
  "work",
  "agent",
  "commitment",
  "project",
  "fact",
  "pr",
];

export const GLOBAL_SEARCH_KIND_LABEL: Record<SearchKind, string> = {
  chat: "Chats",
  work: "Work",
  agent: "Agents",
  commitment: "Open items",
  project: "Projects",
  fact: "Memory",
  pr: "Pull requests",
};

export function globalSearchQuery(raw: string): string | null {
  const query = raw.trim();
  // `>` filters the palette to actions; searching content there would be noise.
  if (query.startsWith(">")) return null;
  return query.length >= GLOBAL_SEARCH_MIN_QUERY_LENGTH ? query.slice(0, 500) : null;
}

/**
 * Groups results by kind in a fixed order. Within a kind, environments take turns so
 * each keeps its own server ranking and none crowds out the others.
 */
export function groupGlobalSearchResults(
  perEnvironment: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly results: SearchQueryResult["results"];
  }>,
  perKind = GLOBAL_SEARCH_PER_KIND,
): Array<{ kind: SearchKind; results: GlobalSearchResult[] }> {
  const groups: Array<{ kind: SearchKind; results: GlobalSearchResult[] }> = [];
  for (const kind of GLOBAL_SEARCH_KIND_ORDER) {
    const queues = perEnvironment.map((entry) =>
      entry.results
        .filter((result) => result.kind === kind)
        .map((result) => ({ ...result, environmentId: entry.environmentId })),
    );
    const seen = new Set<string>();
    const results: GlobalSearchResult[] = [];
    for (let index = 0; results.length < perKind; index++) {
      if (queues.every((queue) => index >= queue.length)) break;
      for (const queue of queues) {
        const result = queue[index];
        if (!result || results.length >= perKind) continue;
        const key = `${result.environmentId}:${result.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        results.push(result);
      }
    }
    if (results.length > 0) groups.push({ kind, results });
  }
  return groups;
}

export interface SnippetPart {
  readonly text: string;
  readonly match: boolean;
}

const INVISIBLE_FORMATTING = /[​-‏‪-‮⁦-⁩]/g;

/** Turns control characters into spaces, drops invisible formatting, collapses whitespace. */
export function cleanSnippet(snippet: string): string {
  return Array.from(snippet, (character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f ? " " : character;
  })
    .join("")
    .replace(INVISIBLE_FORMATTING, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Splits a snippet into plain and matched runs for every query word, case-insensitive.
 * The result is rendered as text nodes, so markup in a message never becomes HTML.
 */
export function highlightSnippet(snippet: string, query: string): SnippetPart[] {
  const text = cleanSnippet(snippet);
  const words = [
    ...new Set(
      query
        .toLowerCase()
        .split(/[^\p{L}\p{N}_]+/u)
        .filter((word) => word.length > 0),
    ),
  ].toSorted((left, right) => right.length - left.length);
  if (text.length === 0) return [];
  if (words.length === 0) return [{ text, match: false }];
  const lower = text.toLowerCase();
  const parts: SnippetPart[] = [];
  let plainStart = 0;
  let cursor = 0;
  while (cursor < text.length) {
    const word = words.find((candidate) => lower.startsWith(candidate, cursor));
    if (!word) {
      cursor++;
      continue;
    }
    if (cursor > plainStart) parts.push({ text: text.slice(plainStart, cursor), match: false });
    parts.push({ text: text.slice(cursor, cursor + word.length), match: true });
    cursor += word.length;
    plainStart = cursor;
  }
  if (plainStart < text.length) parts.push({ text: text.slice(plainStart), match: false });
  return parts;
}

export function safeExternalUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

export type GlobalSearchTarget =
  | { readonly kind: "thread"; readonly environmentId: EnvironmentId; readonly threadId: ThreadId }
  | {
      readonly kind: "agent";
      readonly environmentId: EnvironmentId;
      readonly threadId: ThreadId;
      readonly tab: "chat" | "items";
    }
  | { readonly kind: "commitment"; readonly environmentId: EnvironmentId; readonly id: string }
  | {
      readonly kind: "project";
      readonly environmentId: EnvironmentId;
      readonly labelId: ProjectLabelId;
    }
  | { readonly kind: "memory"; readonly environmentId: EnvironmentId }
  | { readonly kind: "external"; readonly href: string }
  | { readonly kind: "unavailable"; readonly reason: string };

/** Where selecting a result goes. Open items resolve later, from the item itself. */
export function globalSearchTarget(
  result: GlobalSearchResult,
  agentThread: (environmentId: EnvironmentId, agentId: string) => ThreadId | null,
): GlobalSearchTarget {
  const environmentId = result.environmentId;
  switch (result.kind) {
    case "chat":
    case "work":
      return result.threadId
        ? { kind: "thread", environmentId, threadId: result.threadId }
        : { kind: "unavailable", reason: "This thread is no longer available." };
    case "agent": {
      const threadId = result.threadId ?? agentThread(environmentId, result.id);
      return threadId
        ? { kind: "agent", environmentId, threadId, tab: "chat" }
        : { kind: "unavailable", reason: "This agent is no longer available." };
    }
    case "commitment":
      return { kind: "commitment", environmentId, id: result.id };
    case "project":
      return { kind: "project", environmentId, labelId: result.id as ProjectLabelId };
    case "fact":
      return { kind: "memory", environmentId };
    case "pr": {
      const href = safeExternalUrl(result.id);
      if (href) return { kind: "external", href };
      return result.threadId
        ? { kind: "thread", environmentId, threadId: result.threadId }
        : { kind: "unavailable", reason: "This pull request link is not a web address." };
    }
  }
}

/**
 * An open item opens in its agent's Open items when it has one; otherwise in the
 * first thread it references, then the first link it cites.
 */
export function commitmentTarget(
  environmentId: EnvironmentId,
  commitment: Pick<Commitment, "agentId" | "sourceRefs" | "evidenceRefs"> | null,
  agentThread: (environmentId: EnvironmentId, agentId: string) => ThreadId | null,
): GlobalSearchTarget {
  if (!commitment) return { kind: "unavailable", reason: "This open item is no longer available." };
  if (commitment.agentId) {
    const threadId = agentThread(environmentId, commitment.agentId);
    if (threadId) return { kind: "agent", environmentId, threadId, tab: "items" };
  }
  const refs = [...commitment.sourceRefs, ...commitment.evidenceRefs];
  const thread = refs.find((ref) => ref.kind === "thread");
  if (thread) return { kind: "thread", environmentId, threadId: thread.id as ThreadId };
  for (const ref of refs) {
    if (ref.kind !== "pr" && ref.kind !== "url") continue;
    const href = safeExternalUrl(ref.id);
    if (href) return { kind: "external", href };
  }
  return { kind: "unavailable", reason: "This open item has no agent or linked thread to open." };
}
