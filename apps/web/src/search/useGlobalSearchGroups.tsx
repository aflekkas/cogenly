import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, SearchKind, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import {
  BotIcon,
  BrainIcon,
  CircleDotIcon,
  CodeXmlIcon,
  MessageCircleIcon,
  SearchIcon,
  TagIcon,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { useAgentsIfProvided } from "../agents/agentsClient";
import { PullRequestGlyph } from "../components/changeRequestIcons";
import { requestAgentTab } from "../agents/agentTabRequest";
import {
  ITEM_ICON_CLASS,
  type CommandPaletteActionItem,
  type CommandPaletteGroup,
} from "../components/CommandPalette.logic";
import { toastManager } from "../components/ui/toast";
import { readLocalApi } from "../localApi";
import { projectLabelKey } from "../projectLabels/projectLabels.logic";
import { ProjectTag } from "../projectLabels/ProjectTag";
import { useProjectLabelDirectory } from "../projectLabels/useProjectLabels";
import { agentWorkspaceRpc } from "../rpc/agents";
import { useConnectedEnvironmentIds } from "../state/environments";
import { serverEnvironment } from "../state/server";
import { useAtomQueryRunner } from "../state/use-atom-query-runner";
import { buildThreadRouteParams } from "../threadRoutes";
import {
  commitmentTarget,
  GLOBAL_SEARCH_KIND_LABEL,
  GLOBAL_SEARCH_LIMIT,
  globalSearchQuery,
  globalSearchTarget,
  groupGlobalSearchResults,
  highlightSnippet,
  type GlobalSearchResult,
  type GlobalSearchTarget,
} from "./globalSearch.logic";

const DEBOUNCE_MS = 200;
/** Environments searched at once; more would fan out a request per keystroke pause. */
const MAX_ENVIRONMENTS = 4;

const KIND_ICON: Record<SearchKind, LucideIcon> = {
  chat: MessageCircleIcon,
  work: CodeXmlIcon,
  agent: BotIcon,
  commitment: CircleDotIcon,
  project: TagIcon,
  fact: BrainIcon,
  pr: PullRequestGlyph.pullRequest,
};

const EMPTY_ATOM = Atom.make(
  [] as ReadonlyArray<{
    environmentId: EnvironmentId;
    result: AsyncResult.AsyncResult<
      { readonly results: ReadonlyArray<Omit<GlobalSearchResult, "environmentId">> },
      unknown
    >;
  }>,
).pipe(Atom.withLabel("global-search:idle"));

/** The value after it stops changing; clearing to null applies at once. */
function useDebounced(value: string | null) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    if (value === null) return;
    const timer = window.setTimeout(() => setDebounced(value), DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [value]);
  return value === null ? null : debounced;
}

function SearchSnippet(props: { snippet: string; query: string }) {
  const parts = highlightSnippet(props.snippet, props.query);
  if (parts.length === 0) return null;
  return (
    <span className="line-clamp-1 break-all">
      {parts.map((part, index) =>
        part.match ? (
          // oxlint-disable-next-line react/no-array-index-key -- parts never reorder
          <mark key={index} className="bg-transparent font-semibold text-foreground">
            {part.text}
          </mark>
        ) : (
          part.text
        ),
      )}
    </span>
  );
}

/**
 * "Search everything" groups for the command palette: chats, Work, agents, open items,
 * projects and pull requests across connected environments, from the server's index.
 * Returns no groups until the query is long enough; status rows say what is happening.
 */
export function useGlobalSearchGroups(input: {
  readonly query: string;
  readonly enabled: boolean;
}): ReadonlyArray<CommandPaletteGroup> {
  const navigate = useNavigate();
  const agents = useAgentsIfProvided();
  const allEnvironmentIds = useConnectedEnvironmentIds();
  const environmentIds = useMemo(
    () => allEnvironmentIds.slice(0, MAX_ENVIRONMENTS),
    [allEnvironmentIds],
  );
  const directory = useProjectLabelDirectory(environmentIds);
  const loadCommitments = useAtomQueryRunner(agentWorkspaceRpc.commitmentsList, {
    reportFailure: false,
  });
  const liveQuery = input.enabled ? globalSearchQuery(input.query) : null;
  const query = useDebounced(liveQuery);
  const idsKey = environmentIds.join("\0");
  const atom = useMemo(
    () =>
      query === null || idsKey === ""
        ? EMPTY_ATOM
        : Atom.make((get) =>
            (idsKey.split("\0") as EnvironmentId[]).map((environmentId) => ({
              environmentId,
              result: get(
                serverEnvironment.searchQuery({
                  environmentId,
                  input: { query, limit: GLOBAL_SEARCH_LIMIT },
                }),
              ),
            })),
          ).pipe(Atom.withLabel("global-search")),
    [idsKey, query],
  );
  const responses = useAtomValue(atom);

  const agentThread = useMemo(() => {
    const byKey = new Map(
      agents.map((agent) => [`${agent.environmentId}:${agent.id}`, agent.conversationThreadId]),
    );
    return (environmentId: EnvironmentId, agentId: string) =>
      (byKey.get(`${environmentId}:${agentId}`) as ThreadId | undefined) ?? null;
  }, [agents]);

  return useMemo(() => {
    if (liveQuery === null) return [];
    const settled = responses.map((response) => ({
      environmentId: response.environmentId,
      data: Option.getOrNull(AsyncResult.value(response.result)),
      failed: response.result._tag === "Failure",
      error: response.result._tag === "Failure" ? Cause.squash(response.result.cause) : undefined,
      waiting: response.result.waiting || response.result._tag === "Initial",
    }));
    const stale = query !== liveQuery;
    const groups = stale
      ? []
      : groupGlobalSearchResults(
          settled.flatMap((entry) =>
            entry.data ? [{ environmentId: entry.environmentId, results: entry.data.results }] : [],
          ),
        );

    const go = async (target: GlobalSearchTarget): Promise<void> => {
      switch (target.kind) {
        case "thread":
          await navigate({
            to: "/$environmentId/$threadId",
            params: buildThreadRouteParams(scopeThreadRef(target.environmentId, target.threadId)),
          });
          return;
        case "agent":
          requestAgentTab(`${target.environmentId}:${target.threadId}`, target.tab);
          await navigate({
            to: "/$environmentId/$threadId",
            params: buildThreadRouteParams(scopeThreadRef(target.environmentId, target.threadId)),
          });
          return;
        case "commitment": {
          const loaded = await loadCommitments({
            environmentId: target.environmentId,
            input: {},
          });
          if (loaded._tag === "Failure") {
            toastManager.add({ type: "error", title: "Could not open this open item" });
            return;
          }
          const commitment =
            loaded.value.commitments.find((candidate) => candidate.id === target.id) ?? null;
          await go(commitmentTarget(target.environmentId, commitment, agentThread));
          return;
        }
        case "project":
          await navigate({ to: "/settings/project-tags" });
          return;
        case "memory":
          await navigate({ to: "/settings/memory" });
          return;
        case "external":
          void readLocalApi()?.shell.openExternal(target.href);
          return;
        case "unavailable":
          toastManager.add({ type: "info", title: target.reason });
          return;
      }
    };

    const toItem = (result: GlobalSearchResult): CommandPaletteActionItem => {
      const Icon = KIND_ICON[result.kind];
      const chips =
        result.kind === "project"
          ? []
          : result.labelIds.flatMap((labelId) => {
              const entry = directory.byKey.get(projectLabelKey(result.environmentId, labelId));
              return entry ? [entry] : [];
            });
      const snippet =
        result.snippet.trim() && result.snippet.trim() !== result.title.trim() ? (
          <SearchSnippet snippet={result.snippet} query={liveQuery} />
        ) : undefined;
      return {
        kind: "action",
        value: `search:${result.kind}:${result.environmentId}:${result.id}`,
        searchTerms: [],
        title: result.title.trim() || "Untitled",
        ...(snippet ? { description: snippet } : {}),
        icon: <Icon className={ITEM_ICON_CLASS} />,
        ...(chips.length > 0
          ? {
              titleTrailingContent: (
                <span className="flex shrink-0 items-center gap-1">
                  {chips.slice(0, 2).map((entry) => (
                    <ProjectTag key={entry.key} name={entry.label.name} color={entry.label.color} />
                  ))}
                </span>
              ),
            }
          : {}),
        run: () => go(globalSearchTarget(result, agentThread)),
      };
    };

    const status = (title: string): CommandPaletteGroup => ({
      value: "search-everything",
      label: "Search everything",
      items: [
        {
          kind: "action",
          value: "search-everything:status",
          searchTerms: [],
          title,
          icon: <SearchIcon className={ITEM_ICON_CLASS} />,
          disabled: true,
          run: async () => {},
        },
      ],
    });

    if (groups.length > 0) {
      return groups.map((group) => ({
        value: `search-everything:${group.kind}`,
        // Prefixed so these never read as the palette's own Projects or thread groups.
        label: `Search everything · ${GLOBAL_SEARCH_KIND_LABEL[group.kind]}`,
        items: group.results.map(toItem),
      }));
    }
    if (environmentIds.length === 0) return [status("Connect an environment to search it.")];
    if (stale || settled.some((entry) => entry.waiting)) return [status("Searching everything…")];
    if (settled.every((entry) => entry.failed)) {
      const error = settled[0]?.error;
      return [
        status(
          error instanceof Error && error.message.trim()
            ? `Search is unavailable: ${error.message}`
            : "Search is unavailable right now.",
        ),
      ];
    }
    return [status("No chats, Work, agents, open items, projects or pull requests match.")];
  }, [
    agentThread,
    directory.byKey,
    environmentIds.length,
    liveQuery,
    loadCommitments,
    navigate,
    query,
    responses,
  ]);
}
