import { terminalSections, type AgentTerminalEntry } from "../AgentTerminalsPanel.logic";

/** As in T3 Code's terminal drawer: a fresh panel's height, and the floor a drag stops at. */
export const BOTTOM_PANEL_DEFAULT_HEIGHT = 280;
export const BOTTOM_PANEL_MIN_HEIGHT = 180;
const BOTTOM_PANEL_MAX_VIEWPORT_RATIO = 0.75;
/** What the chat column keeps above the panel: the header and a docked composer. */
const BOTTOM_PANEL_CHAT_RESERVE = 220;

/**
 * The tallest the panel may render: three quarters of the window, and never
 * so tall that the composer is pushed into the header.
 */
export function bottomPanelMaxHeight(input: {
  readonly viewportHeight: number;
  readonly columnHeight?: number;
}): number {
  const windowCap = Math.floor(input.viewportHeight * BOTTOM_PANEL_MAX_VIEWPORT_RATIO);
  const columnCap =
    input.columnHeight === undefined
      ? windowCap
      : Math.floor(input.columnHeight - BOTTOM_PANEL_CHAT_RESERVE);
  return Math.max(BOTTOM_PANEL_MIN_HEIGHT, Math.min(windowCap, columnCap));
}

/** The stored preference is kept as is; the layout only clamps what renders. */
export function clampBottomPanelHeight(height: number | undefined, maxHeight: number): number {
  const safe =
    height !== undefined && Number.isFinite(height) ? height : BOTTOM_PANEL_DEFAULT_HEIGHT;
  return Math.min(Math.max(Math.round(safe), BOTTOM_PANEL_MIN_HEIGHT), maxHeight);
}

/** An agent whose commands can get a tab: the thread's own agent, or a subagent thread under it. */
export interface BottomPanelAgent {
  readonly threadId: string;
  readonly title: string;
}

export interface BottomPanelTab {
  /** The agent's thread id; one tab per agent. */
  readonly id: string;
  readonly threadId: string;
  readonly title: string;
  /** True for the thread's own agent, whose tab comes first. */
  readonly primary: boolean;
  /** Live commands first, each group newest first. */
  readonly runs: ReadonlyArray<AgentTerminalEntry>;
  readonly liveRunCount: number;
  /** When the agent's newest command started, for un-hiding a closed tab. */
  readonly latestRunKey: string;
}

/**
 * One tab per agent that has run commands, the thread's own agent first and
 * subagents in the order they first ran something, so a tab never jumps when
 * another agent starts a command. A tab the user closed stays hidden until its
 * agent starts a command after it was closed. Nothing here opens the panel:
 * a new run only adds or updates a tab in the background.
 */
export function bottomPanelTabs(input: {
  readonly primary: BottomPanelAgent;
  readonly subagents: ReadonlyArray<BottomPanelAgent>;
  /** Each agent thread's terminals in `agentTerminalEntries` order. */
  readonly entriesByThreadId: ReadonlyMap<string, ReadonlyArray<AgentTerminalEntry>>;
  /** Closed tabs, keyed by tab id, holding the newest run key when they were closed. */
  readonly hiddenTabs: Readonly<Record<string, string>> | undefined;
}): BottomPanelTab[] {
  const seen = new Set<string>();
  const tabs: Array<BottomPanelTab & { readonly firstRunKey: string }> = [];
  for (const [index, agent] of [input.primary, ...input.subagents].entries()) {
    if (seen.has(agent.threadId)) continue;
    seen.add(agent.threadId);
    const { runs, liveRunCount } = terminalSections(
      input.entriesByThreadId.get(agent.threadId) ?? [],
    );
    if (runs.length === 0) continue;
    let latestRunKey = "";
    let firstRunKey: string | null = null;
    for (const run of runs) {
      if (run.sortKey > latestRunKey) latestRunKey = run.sortKey;
      if (firstRunKey === null || run.sortKey < firstRunKey) firstRunKey = run.sortKey;
    }
    const hiddenAt = input.hiddenTabs?.[agent.threadId];
    if (hiddenAt !== undefined && latestRunKey <= hiddenAt) continue;
    tabs.push({
      id: agent.threadId,
      threadId: agent.threadId,
      title: agent.title,
      primary: index === 0,
      runs,
      liveRunCount,
      latestRunKey,
      firstRunKey: firstRunKey ?? "",
    });
  }
  return tabs
    .toSorted(
      (left, right) =>
        Number(right.primary) - Number(left.primary) ||
        left.firstRunKey.localeCompare(right.firstRunKey) ||
        left.id.localeCompare(right.id),
    )
    .map(({ firstRunKey: _firstRunKey, ...tab }) => tab);
}

/** The tab with `tabId`, else the first one. */
export function resolveActiveBottomPanelTab(
  tabs: ReadonlyArray<BottomPanelTab>,
  tabId: string | null | undefined,
): BottomPanelTab | null {
  return tabs.find((tab) => tab.id === tabId) ?? tabs[0] ?? null;
}

/**
 * The header toggle's dot: an agent command is running while the panel is
 * closed. The panel never opens by itself, so this is how a run gets noticed.
 */
export function bottomPanelToggleShowsActivity(
  open: boolean,
  tabs: ReadonlyArray<Pick<BottomPanelTab, "liveRunCount">>,
): boolean {
  return !open && tabs.some((tab) => tab.liveRunCount > 0);
}

// Matches inside a JSON string too, where the result's own JSON is escaped.
const TERMINAL_ID_IN_OUTPUT = /\\?"terminalId\\?"\s*:\s*\\?"(agent-[\w-]+)/;

function stringifyOutput(output: unknown): string {
  if (typeof output === "string") return output;
  if (output === undefined || output === null) return "";
  try {
    return JSON.stringify(output);
  } catch {
    return "";
  }
}

/**
 * The agent command a timeline "Terminal run" row started. The tool's result
 * names its terminal; when the result was withheld or has not arrived, the run
 * with the same command that started closest after the call is taken.
 */
export function findRunForToolCall(
  tabs: ReadonlyArray<Pick<BottomPanelTab, "id" | "runs">>,
  call: { readonly output: unknown; readonly command: string | null; readonly startedAt: string },
): { readonly tabId: string; readonly terminalId: string } | null {
  const named = TERMINAL_ID_IN_OUTPUT.exec(stringifyOutput(call.output))?.[1];
  if (named) {
    for (const tab of tabs) {
      if (tab.runs.some((run) => run.terminalId === named)) {
        return { tabId: tab.id, terminalId: named };
      }
    }
  }
  const command = call.command?.trim();
  if (!command) return null;
  const calledAt = Date.parse(call.startedAt);
  let best: { tabId: string; terminalId: string; distance: number } | null = null;
  for (const tab of tabs) {
    for (const run of tab.runs) {
      if (run.label.trim() !== command) continue;
      const startedAt = Date.parse(run.startedAt ?? run.updatedAt);
      // A run cannot start before the call that made it; allow a little clock skew.
      const distance =
        Number.isFinite(calledAt) && Number.isFinite(startedAt)
          ? startedAt - calledAt
          : Number.MAX_SAFE_INTEGER;
      if (distance < -5_000) continue;
      const score = Math.abs(distance);
      if (best === null || score < best.distance) {
        best = { tabId: tab.id, terminalId: run.terminalId, distance: score };
      }
    }
  }
  return best ? { tabId: best.tabId, terminalId: best.terminalId } : null;
}
