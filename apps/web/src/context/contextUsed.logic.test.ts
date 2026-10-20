import type { ProjectLabelId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { describeContextItem, groupContextItems, type ContextUsedItem } from "./contextUsed.logic";

const base = {
  labelIds: [] as ProjectLabelId[],
  updatedAt: "2026-10-19T12:00:00.000Z",
};

describe("describeContextItem", () => {
  it("falls back to refs and the client's thread title for older items", () => {
    const item: ContextUsedItem = {
      ...base,
      kind: "message",
      id: "m1",
      text: "Ship the pricing page",
      refs: [
        { kind: "thread", id: "t1" },
        { kind: "message", id: "m1" },
      ],
    };
    expect(describeContextItem(item, "Spawn Partners")).toMatchObject({
      title: "Spawn Partners",
      snippet: "Ship the pricing page",
      reason: "Recent message in Spawn Partners",
      sourceThreadId: "t1",
      sourceMessageId: "m1",
      role: null,
    });
  });

  it("prefers the server's display fields", () => {
    const item = {
      ...base,
      kind: "message" as const,
      id: "m2",
      text: "raw",
      refs: [],
      title: "Pricing",
      snippet: "assistant: short",
      role: "assistant" as const,
      sourceThreadId: "t2" as ThreadId,
      sourceThreadTitle: "Server title",
      createdAt: "2026-10-18T00:00:00.000Z",
      reason: "Matched your question",
    } satisfies ContextUsedItem;
    expect(describeContextItem(item, "Client title")).toMatchObject({
      title: "Pricing",
      snippet: "short",
      role: "assistant",
      reason: "Matched your question",
      sourceThreadId: "t2",
      at: "2026-10-18T00:00:00.000Z",
    });
  });

  it("names conversation summaries and does not link them to a message", () => {
    const item: ContextUsedItem = {
      ...base,
      kind: "message",
      id: "summary:a1",
      text: "Earlier conversation summary: we agreed on Friday",
      refs: [{ kind: "thread", id: "t3" }],
    };
    expect(describeContextItem(item, null)).toMatchObject({
      title: "Earlier conversation",
      snippet: "we agreed on Friday",
      reason: "Conversation summary",
      sourceMessageId: null,
    });
  });
});

describe("groupContextItems", () => {
  it("orders groups and drops empty ones", () => {
    const groups = groupContextItems([
      { kind: "fact" as const },
      { kind: "message" as const },
      { kind: "fact" as const },
    ]);
    expect(groups.map((group) => [group.label, group.items.length])).toEqual([
      ["Messages", 1],
      ["Facts", 2],
    ]);
  });
});
