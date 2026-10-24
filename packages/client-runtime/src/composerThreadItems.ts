import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@cogenly/contracts";

/** Per section with a query; bare `@` shows fewer, as a hint of what it can find. */
const MENTION_RESULT_LIMIT = 4;
const MENTION_RECENT_LIMIT = 2;

/** The `@` sections in display order, before ranking moves the closest match up. */
export const COMPOSER_MENTION_GROUPS = ["tasks", "chats", "agents", "projects"] as const;
export type ComposerMentionGroup = (typeof COMPOSER_MENTION_GROUPS)[number];

export interface ComposerThreadCandidate {
  readonly environmentId: EnvironmentId;
  readonly id: ThreadId;
  readonly title: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
  /** Work tasks and chats get their own sections; agent conversations surface as the agent. */
  readonly kind: "work" | "chat" | "agentConversation";
}

export interface ComposerAgentCandidate {
  readonly environmentId: EnvironmentId;
  readonly id: string;
  readonly name: string;
  readonly conversationThreadId: ThreadId;
  /** Last activity, for ordering equally close matches. */
  readonly activeAt: string;
}

export interface ComposerProjectFolderCandidate {
  readonly environmentId: EnvironmentId;
  readonly id: string;
  readonly name: string;
  readonly updatedAt: string;
}

// Section headings name the kind, so mention rows carry no description.
export interface ComposerThreadItem {
  readonly id: string;
  readonly type: "thread";
  readonly group: "tasks" | "chats";
  readonly thread: ScopedThreadRef;
  readonly label: string;
  readonly description: string;
}

export interface ComposerAgentItem {
  readonly id: string;
  readonly type: "agent";
  readonly group: "agents";
  readonly agent: Omit<ComposerAgentCandidate, "activeAt">;
  readonly label: string;
  readonly description: string;
}

export interface ComposerProjectFolderItem {
  readonly id: string;
  readonly type: "project-folder";
  readonly group: "projects";
  readonly projectFolder: Omit<ComposerProjectFolderCandidate, "updatedAt">;
  readonly label: string;
  readonly description: string;
}

export type ComposerMentionItem =
  | ComposerThreadItem
  | ComposerAgentItem
  | ComposerProjectFolderItem;

/**
 * How closely `name` matches `query`, lower is closer: exact, prefix, word prefix, then
 * substring. Null when it does not match. An empty query matches everything equally.
 */
export function mentionMatchScore(name: string, query: string): number | null {
  if (query.length === 0) return 0;
  const haystack = name.trim().toLowerCase();
  if (haystack === query) return 0;
  if (haystack.startsWith(query)) return 1;
  const index = haystack.indexOf(query);
  if (index === -1) return null;
  return /[\s\-_/.:([]/.test(haystack.charAt(index - 1)) ? 2 : 3;
}

interface Ranked<T> {
  readonly item: T;
  readonly score: number;
  readonly at: string;
}

/** Closest first, then most recent. */
function rank<T>(entries: ReadonlyArray<Ranked<T>>, limit: number): Ranked<T>[] {
  return [...entries]
    .sort((left, right) => left.score - right.score || right.at.localeCompare(left.at))
    .slice(0, limit);
}

/**
 * What the `@` picker offers next to file paths, grouped into sections. The agent can only
 * follow links on its own server, so candidates stay within the composer's environment.
 * Within a section the closest match leads and recency breaks ties; sections are ordered by
 * their closest match, so typing an agent's exact name puts Agents first. With no query each
 * section shows its most recent entries.
 */
export function matchComposerMentionItems(input: {
  threads: ReadonlyArray<ComposerThreadCandidate>;
  agents: ReadonlyArray<ComposerAgentCandidate>;
  projectFolders: ReadonlyArray<ComposerProjectFolderCandidate>;
  environmentId: EnvironmentId;
  excludeThreadId: ThreadId | null;
  query: string;
}): ComposerMentionItem[] {
  const query = input.query.trim().toLowerCase();
  const limit = query.length === 0 ? MENTION_RECENT_LIMIT : MENTION_RESULT_LIMIT;
  const inEnvironment = <T extends { readonly environmentId: EnvironmentId }>(
    candidates: ReadonlyArray<T>,
  ) => candidates.filter((candidate) => candidate.environmentId === input.environmentId);

  const threadsOf = (kind: ComposerThreadCandidate["kind"], group: ComposerThreadItem["group"]) =>
    rank(
      inEnvironment(input.threads).flatMap((thread): Ranked<ComposerThreadItem>[] => {
        if (thread.kind !== kind || thread.archivedAt !== null) return [];
        if (thread.id === input.excludeThreadId) return [];
        const score = mentionMatchScore(thread.title, query);
        if (score === null) return [];
        return [
          {
            score,
            at: thread.updatedAt,
            item: {
              id: `thread:${thread.environmentId}:${thread.id}`,
              type: "thread",
              group,
              thread: { environmentId: thread.environmentId, threadId: thread.id },
              label: thread.title,
              description: "",
            },
          },
        ];
      }),
      limit,
    );

  const agents = rank(
    inEnvironment(input.agents).flatMap((agent): Ranked<ComposerAgentItem>[] => {
      if (agent.conversationThreadId === input.excludeThreadId) return [];
      const score = mentionMatchScore(agent.name, query);
      if (score === null) return [];
      const { activeAt, ...identity } = agent;
      return [
        {
          score,
          at: activeAt,
          item: {
            id: `agent:${agent.environmentId}:${agent.id}`,
            type: "agent",
            group: "agents",
            agent: identity,
            label: agent.name,
            description: "",
          },
        },
      ];
    }),
    limit,
  );

  const projectFolders = rank(
    inEnvironment(input.projectFolders).flatMap((folder): Ranked<ComposerProjectFolderItem>[] => {
      const score = mentionMatchScore(folder.name, query);
      if (score === null) return [];
      const { updatedAt, ...identity } = folder;
      return [
        {
          score,
          at: updatedAt,
          item: {
            id: `project-folder:${folder.environmentId}:${folder.id}`,
            type: "project-folder",
            group: "projects",
            projectFolder: identity,
            label: folder.name,
            description: "",
          },
        },
      ];
    }),
    limit,
  );

  const sections: ReadonlyArray<ReadonlyArray<Ranked<ComposerMentionItem>>> = [
    threadsOf("work", "tasks"),
    threadsOf("chat", "chats"),
    agents,
    projectFolders,
  ];
  return sections
    .map((entries, order) => ({ entries, order, best: entries[0]?.score ?? Infinity }))
    .filter((section) => section.entries.length > 0)
    .sort((left, right) => left.best - right.best || left.order - right.order)
    .flatMap((section) => section.entries.map((entry) => entry.item));
}
