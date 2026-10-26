import type {
  EnvironmentId,
  IntegrationSource,
  ProjectLabelId,
  ScopedThreadRef,
  ThreadId,
} from "@cogenly/contracts";

/** Per section with a query; bare `@` shows fewer, as a hint of what it can find. */
const MENTION_RESULT_LIMIT = 4;
const MENTION_RECENT_LIMIT = 2;

/** The `@` sections in display order, before ranking moves the closest match up. */
export const COMPOSER_MENTION_GROUPS = ["tasks", "chats", "agents", "projects", "sources"] as const;
export type ComposerMentionGroup = (typeof COMPOSER_MENTION_GROUPS)[number];

export interface ComposerThreadCandidate {
  /** The environment this copy was read from. */
  readonly environmentId: EnvironmentId;
  readonly id: ThreadId;
  readonly title: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
  /** Work tasks and chats get their own sections; agent conversations surface as the agent. */
  readonly kind: "work" | "chat" | "agentConversation";
  /** The machine that runs it: the copy's `ownerMachine`, else its own environment. */
  readonly runsOn: EnvironmentId;
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
  /** The copy the row was read from; the inserted link names only the thread id. */
  readonly thread: ScopedThreadRef;
  /** The machine that runs it, when that is not the composer's own. */
  readonly runsOn: EnvironmentId | null;
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

/** A connected integration; its row names the service and the account, like the Sources picker. */
export interface ComposerSourceItem {
  readonly id: string;
  readonly type: "integration";
  readonly group: "sources";
  readonly source: IntegrationSource;
  readonly label: string;
  readonly description: string;
}

export type ComposerMentionItem =
  | ComposerThreadItem
  | ComposerAgentItem
  | ComposerProjectFolderItem
  | ComposerSourceItem;

/**
 * The sources a thread in `projectLabelId` can use, as the server decides it
 * (`integrationVisibleTo`): every all-project integration, plus those scoped to
 * this project. A thread in no project gets only the all-project ones.
 */
export function integrationSourcesForProject(
  sources: ReadonlyArray<IntegrationSource>,
  projectLabelId: ProjectLabelId | null,
): IntegrationSource[] {
  return sources.filter(
    (source) =>
      source.scope.type === "all" ||
      (projectLabelId !== null && source.scope.labelIds.includes(projectLabelId)),
  );
}

/** A source's row: the service, then which account (or the integration's own name). */
export function integrationSourceRowText(
  source: Pick<IntegrationSource, "serviceName" | "displayName" | "accountLabel">,
): { readonly label: string; readonly description: string } {
  const account = source.accountLabel?.trim();
  if (account) return { label: source.serviceName, description: account };
  const displayName = source.displayName.trim();
  return {
    label: source.serviceName,
    description: displayName !== source.serviceName ? displayName : "",
  };
}

/** A source's chip text: "Gmail · work", or the service alone when it names no account. */
export function integrationSourceChipLabel(
  source: Pick<IntegrationSource, "serviceName" | "displayName" | "accountLabel">,
): string {
  const { label, description } = integrationSourceRowText(source);
  return description ? `${label} · ${description}` : label;
}

export interface IntegrationSourceNotice {
  /** The short badge on its row. */
  readonly badge: string;
  readonly tone: "warning" | "error";
  /** What is wrong and what to do, for a chip's tooltip. */
  readonly detail: string;
}

/** What a source's row badge and chip warning say; null when it is ready to use. */
export function integrationSourceNotice(
  source: Pick<IntegrationSource, "status" | "message" | "syncedFrom">,
): IntegrationSourceNotice | null {
  const message = source.message?.trim();
  switch (source.status) {
    case "connected":
      return null;
    case "needs_sign_in":
      return source.syncedFrom
        ? {
            badge: "Sign in on this machine",
            tone: "warning",
            detail: `Connected on ${source.syncedFrom.machineLabel}. Sign in on this machine in Settings → Integrations before the agent can use it.`,
          }
        : {
            badge: "Needs sign-in",
            tone: "warning",
            detail:
              message || "Sign in again in Settings → Integrations before the agent can use it.",
          };
    case "error":
      return {
        badge: "Error",
        tone: "error",
        detail: message || "This source is not working. Check it in Settings → Integrations.",
      };
  }
}

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
 * The threads the composer's agent can follow a link to, one per thread id. Paired machines
 * each hold a copy of every thread under the same id, so a thread listed from a paired
 * machine resolves on the composer's own server too; a server outside the pairing does not.
 * The composer's own copy wins, else the first one listed.
 */
export function reachableThreadCandidates(input: {
  threads: ReadonlyArray<ComposerThreadCandidate>;
  environmentId: EnvironmentId;
  pairedEnvironmentIds: ReadonlySet<EnvironmentId>;
}): ComposerThreadCandidate[] {
  const byId = new Map<ThreadId, ComposerThreadCandidate>();
  for (const thread of input.threads) {
    const here = thread.environmentId === input.environmentId;
    if (!here && !input.pairedEnvironmentIds.has(thread.environmentId)) continue;
    if (here || !byId.has(thread.id)) byId.set(thread.id, thread);
  }
  return [...byId.values()];
}

/**
 * What the `@` picker offers next to file paths, grouped into sections. Threads come from
 * every paired machine (see `reachableThreadCandidates`); agents and project folders stay
 * within the composer's environment. Within a section the closest match leads and recency
 * breaks ties; sections are ordered by their closest match, so typing an agent's exact name
 * puts Agents first. With no query each section shows its most recent entries.
 */
export function matchComposerMentionItems(input: {
  threads: ReadonlyArray<ComposerThreadCandidate>;
  agents: ReadonlyArray<ComposerAgentCandidate>;
  projectFolders: ReadonlyArray<ComposerProjectFolderCandidate>;
  /** This environment's sources, already kept to the thread's project. */
  sources?: ReadonlyArray<IntegrationSource>;
  environmentId: EnvironmentId;
  /** Machines paired with the composer's environment. */
  pairedEnvironmentIds?: ReadonlySet<EnvironmentId>;
  excludeThreadId: ThreadId | null;
  query: string;
}): ComposerMentionItem[] {
  const query = input.query.trim().toLowerCase();
  const limit = query.length === 0 ? MENTION_RECENT_LIMIT : MENTION_RESULT_LIMIT;
  const inEnvironment = <T extends { readonly environmentId: EnvironmentId }>(
    candidates: ReadonlyArray<T>,
  ) => candidates.filter((candidate) => candidate.environmentId === input.environmentId);
  const threads = reachableThreadCandidates({
    threads: input.threads,
    environmentId: input.environmentId,
    pairedEnvironmentIds: input.pairedEnvironmentIds ?? new Set(),
  });

  const threadsOf = (kind: ComposerThreadCandidate["kind"], group: ComposerThreadItem["group"]) =>
    rank(
      threads.flatMap((thread): Ranked<ComposerThreadItem>[] => {
        if (thread.kind !== kind || thread.archivedAt !== null) return [];
        if (thread.id === input.excludeThreadId) return [];
        const score = mentionMatchScore(thread.title, query);
        if (score === null) return [];
        return [
          {
            score,
            at: thread.updatedAt,
            item: {
              id: `thread:${thread.id}`,
              type: "thread",
              group,
              thread: { environmentId: thread.environmentId, threadId: thread.id },
              runsOn: thread.runsOn === input.environmentId ? null : thread.runsOn,
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

  // Sources have no recency, so equally close matches keep the server's order.
  const sources = rank(
    (input.sources ?? []).flatMap((source): Ranked<ComposerSourceItem>[] => {
      const { label, description } = integrationSourceRowText(source);
      const scores = [label, description, source.displayName, source.name].flatMap((text) => {
        const score = text ? mentionMatchScore(text, query) : null;
        return score === null ? [] : [score];
      });
      if (scores.length === 0) return [];
      return [
        {
          score: Math.min(...scores),
          at: "",
          item: {
            id: `integration:${source.id}`,
            type: "integration",
            group: "sources",
            source,
            label,
            description,
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
    sources,
  ];
  return sections
    .map((entries, order) => ({ entries, order, best: entries[0]?.score ?? Infinity }))
    .filter((section) => section.entries.length > 0)
    .sort((left, right) => left.best - right.best || left.order - right.order)
    .flatMap((section) => section.entries.map((entry) => entry.item));
}
