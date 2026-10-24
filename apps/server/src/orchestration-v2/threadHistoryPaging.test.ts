import { ThreadId, TurnItemId } from "@cogenly/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  encodeThreadHistoryCursor,
  selectHistoryPageFromCursor,
  selectRecentTimelineWindow,
  THREAD_HISTORY_MAX_RAW_TURNS,
  THREAD_HISTORY_PAGE_POLICY,
} from "./threadHistoryPaging.ts";

type Row = {
  readonly position: number;
  readonly visibility: "local";
  readonly sourceThreadId: ThreadId;
  readonly sourceItemId: TurnItemId;
  readonly item: {
    readonly type: "user_message" | "assistant_message";
    readonly id: string;
    readonly inputIntent?: string;
    readonly createdBy?: string;
    readonly runId: string;
    readonly text?: string;
  };
};

/** One turn: its prompt (typed or agent-sent) and the assistant's reply. */
function turns(senders: ReadonlyArray<"user" | "agent">, replyText = "done"): Row[] {
  const rows: Row[] = [];
  const sourceThreadId = ThreadId.make("thread-1");
  senders.forEach((createdBy, turn) => {
    const runId = `run-${turn}`;
    rows.push(
      {
        position: 0,
        visibility: "local",
        sourceThreadId,
        sourceItemId: TurnItemId.make(`prompt-${turn}`),
        item: {
          type: "user_message",
          id: `prompt-${turn}`,
          inputIntent: "turn_start",
          createdBy,
          runId,
        },
      },
      {
        position: 0,
        visibility: "local",
        sourceThreadId,
        sourceItemId: TurnItemId.make(`reply-${turn}`),
        item: { type: "assistant_message", id: `reply-${turn}`, runId, text: replyText },
      },
    );
  });
  return rows.map((row, position) => ({ ...row, position }));
}

const recentWindow = (items: ReadonlyArray<Row>) =>
  selectRecentTimelineWindow({ items: items as never, snapshotSequence: 1 });

function promptCount(items: ReadonlyArray<{ readonly item: { readonly type: string } }>) {
  return items.filter((row) => row.item.type === "user_message").length;
}

function cursorFor(items: ReadonlyArray<Row>, oldestId: string) {
  const row = items.find((candidate) => candidate.sourceItemId === oldestId)!;
  return encodeThreadHistoryCursor({
    snapshotSequence: 1,
    sourceThreadId: row.sourceThreadId,
    sourceItemId: row.sourceItemId,
    position: row.position,
  });
}

describe("thread history windows", () => {
  it("opens a typed conversation at its last ten prompts", () => {
    const window = recentWindow(turns(Array.from({ length: 15 }, () => "user")));
    expect(promptCount(window.items)).toBe(THREAD_HISTORY_PAGE_POLICY.maxUserTurns);
    expect(window.hasMoreHistory).toBe(true);
  });

  it("opens a thread full of agent-sent messages small", () => {
    // Three typed prompts, then 200 turns started by other agents.
    const items = turns([
      ...Array.from({ length: 3 }, () => "user" as const),
      ...Array.from({ length: 200 }, () => "agent" as const),
    ]);
    const window = recentWindow(items);
    expect(promptCount(window.items)).toBe(THREAD_HISTORY_MAX_RAW_TURNS);
    expect(window.items).toHaveLength(THREAD_HISTORY_MAX_RAW_TURNS * 2);
    // Whole turns only: the window starts at a prompt.
    expect(window.items[0]?.item.type).toBe("user_message");
    expect(window.hasMoreHistory).toBe(true);
  });

  it("pages an agent-heavy thread back to its first turn without gaps or repeats", () => {
    const items = turns([
      ...Array.from({ length: 3 }, () => "user" as const),
      ...Array.from({ length: 200 }, () => "agent" as const),
    ]);
    let page: { items: ReadonlyArray<{ sourceItemId: string }>; nextCursor: string | null } =
      recentWindow(items);
    const seen = page.items.map((row) => row.sourceItemId);
    let requests = 0;
    while (page.nextCursor !== null) {
      requests += 1;
      page = selectHistoryPageFromCursor({
        items,
        cursor: page.nextCursor,
        snapshotSequence: 1,
      });
      seen.unshift(...page.items.map((row) => row.sourceItemId));
    }
    expect(seen).toEqual(items.map((row) => row.sourceItemId));
    expect(requests).toBeLessThanOrEqual(Math.ceil(203 / THREAD_HISTORY_MAX_RAW_TURNS));
  });

  it("stops at a turn boundary once the byte budget is spent", () => {
    // Each turn carries about 400 KB, so three turns pass the 1 MB budget.
    const window = recentWindow(
      turns(
        Array.from({ length: 8 }, () => "user"),
        "x".repeat(400_000),
      ),
    );
    // Turn windows used to ignore bytes, so all eight turns (3.2 MB) opened.
    expect(promptCount(window.items)).toBe(3);
    expect(window.items[0]?.item.type).toBe("user_message");
    expect(window.hasMoreHistory).toBe(true);
  });

  it("still opens one whole turn larger than the budget", () => {
    const window = recentWindow(turns(["user", "user"], "x".repeat(2_000_000)));
    expect(window.items.map((row) => row.sourceItemId)).toEqual(["prompt-1", "reply-1"]);
  });

  it("reaches a search match further back than one page in a single request", () => {
    // One typed prompt makes this a turn-paged thread; the rest are agent sends.
    const items = turns(["user", ...Array.from({ length: 119 }, () => "agent" as const)]);
    const page = selectHistoryPageFromCursor({
      items,
      cursor: cursorFor(items, "prompt-100"),
      snapshotSequence: 1,
      throughEntryId: "prompt-55",
    });
    expect(page.items.some((row) => row.sourceItemId === "prompt-55")).toBe(true);
    expect(page.items.at(-1)?.sourceItemId).toBe("reply-99");
  });
});
