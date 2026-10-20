import { describe, expect, it } from "@effect/vitest";
import {
  ContextHandoffId,
  MessageId,
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ContextHandoff,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { historyCost } from "@t3tools/provider-core/server/handoffBudget";
import { deliverContextHandoffs } from "../orchestration-v2/ContextHandoffDelivery.ts";
import * as Handoff from "./WorkHandoffContext.ts";

const sourceId = ThreadId.make("chat:source");
const at = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z");

const message = (
  role: "user" | "assistant" | "system",
  text: string,
  index: number,
  extra?: Partial<OrchestrationV2ConversationMessage>,
): OrchestrationV2ConversationMessage => ({
  id: MessageId.make(`chat:${index}`),
  nodeId: NodeId.make(`chat-node:${index}`),
  runId: null,
  createdBy: "user",
  creationSource: "web",
  threadId: sourceId,
  role,
  text,
  streaming: false,
  createdAt: at,
  updatedAt: at,
  attachments: [],
  ...extra,
});

describe("filler skipping", () => {
  it.each([
    "hi",
    "Hi!",
    "hello",
    "hey there",
    "thanks",
    "Thank you!",
    "ok",
    "k",
    "👍",
    "test",
    "  ",
  ])("treats %j as filler", (text) => {
    expect(Handoff.isFillerMessage(text)).toBe(true);
  });

  it.each([
    "hi, i want a custom t shirt",
    "make it red",
    "Fix booking-audit validation.",
    "go ahead and merge",
    "no, keep the old copy",
  ])("keeps %j as substantive", (text) => {
    expect(Handoff.isFillerMessage(text)).toBe(false);
  });

  it("skips greetings and filler in the fallback brief", () => {
    const brief = Handoff.fallbackHandoffBrief([
      message("user", "hi", 0),
      message("user", "i want to make a custom t shirt, get it before halloween", 1),
      message("user", "thanks!", 2),
      message("user", "Make it red. Ship it express.", 3),
    ]);
    expect(brief.goal).toBe("i want to make a custom t shirt, get it before halloween");
    expect(brief.bullets).toEqual(["Make it red.", "Ship it express."]);
    expect(Handoff.formatHandoffBrief(brief.goal, brief.bullets)).toBe(
      "i want to make a custom t shirt, get it before halloween\n- Make it red.\n- Ship it express.",
    );
  });

  it("falls back to a generic goal when nothing substantive was said", () => {
    const brief = Handoff.fallbackHandoffBrief([message("user", "hi", 0)]);
    expect(brief.goal).toContain("Continue the work");
    expect(brief.bullets).toEqual([]);
  });
});

describe("transcript building", () => {
  const carried = [
    message("user", "Add booking-audit validation.", 0),
    message("assistant", "Plan: validate dates first, then totals.", 1),
    message("system", "compacted earlier", 2),
    message("user", "Also rename the invoice template.", 3),
    { ...message("user", "Still typing…", 4), streaming: true },
    message("assistant", "   ", 5),
  ];

  it("carries settled user and assistant turns in order", () => {
    const transcript = carried.filter(Handoff.isHandoffTranscriptMessage);
    expect(transcript.map((candidate) => candidate.text)).toEqual([
      "Add booking-audit validation.",
      "Plan: validate dates first, then totals.",
      "Also rename the invoice template.",
    ]);
  });

  it("builds namespaced history messages with roles and provenance", () => {
    const transcript = carried.filter(Handoff.isHandoffTranscriptMessage);
    const history = transcript.map((candidate) =>
      Handoff.toHandoffHistoricalMessage(candidate, sourceId),
    );
    expect(history.map((candidate) => candidate.role)).toEqual(["user", "assistant", "user"]);
    expect(history[0]?.threadId).toBe(sourceId);
    expect(history[0]?.itemId).toBe(`handoff:${sourceId}:chat:0`);
    expect(history[0]?.kind).toBe("user_message");
    expect(history[1]?.kind).toBe("assistant_message");
    expect(history.map((candidate) => candidate.status)).toEqual([
      "completed",
      "completed",
      "completed",
    ]);
  });

  it("caps a single oversized message instead of dropping it whole", () => {
    const [item] = [
      Handoff.toHandoffHistoricalMessage(
        message("assistant", `Plan: ${"x".repeat(20_000)}`, 0),
        sourceId,
      ),
    ];
    expect(item?.text.length).toBeLessThanOrEqual(
      Handoff.HANDOFF_MESSAGE_CHARS + "…[truncated]".length,
    );
    expect(item?.text).toContain("…[truncated]");
  });

  it("collects links and attachments as artifacts", () => {
    const withArtifacts = [
      message("user", "See https://example.com/spec and https://example.com/spec.", 0),
      message("assistant", "Drafted it.", 1, {
        attachments: [
          {
            type: "file",
            id: "attach:1",
            name: "spec.md",
            mimeType: "text/markdown",
            sizeBytes: 12,
          } as OrchestrationV2ConversationMessage["attachments"][number],
        ],
      }),
    ];
    expect(Handoff.extractHandoffLinks(withArtifacts)).toEqual(["https://example.com/spec"]);
    expect(Handoff.summarizeHandoffAttachments(withArtifacts)).toEqual(["- file: spec.md (file)"]);
  });
});

describe("truncation and summary threshold", () => {
  const chat = (count: number) =>
    Array.from({ length: count }, (_, index) =>
      message(
        index % 2 === 0 ? "user" : "assistant",
        `Turn ${index}: ${"request ".repeat(20)}`,
        index,
      ),
    );

  it("carries a short chat in full with no summary", () => {
    const { older, recent } = Handoff.splitTranscriptTail(chat(6));
    expect(older).toEqual([]);
    expect(recent).toHaveLength(6);
    // Chat order is preserved on both sides of the split.
    expect(recent.map((candidate) => candidate.id)).toEqual(
      chat(6).map((candidate) => candidate.id),
    );
  });

  it("summarizes older turns once past the full tail", () => {
    const carried = chat(Handoff.HANDOFF_FULL_TAIL_MESSAGES + 6);
    const { older, recent } = Handoff.splitTranscriptTail(carried);
    expect(older).toHaveLength(6);
    expect(recent).toHaveLength(Handoff.HANDOFF_FULL_TAIL_MESSAGES);
    expect(older[0]?.text).toContain("Turn 0");
    expect(recent.at(-1)?.text).toContain(`Turn ${carried.length - 1}`);
    const compacted = Handoff.compactOlderTurns(older);
    expect(compacted).toHaveLength(6);
    expect(compacted[0]).toMatch(/^- User: Turn 0/);
  });

  it("splits on characters when turns are long", () => {
    const carried = [
      message("user", "First, a very long request. " + "x".repeat(13_000), 0),
      message("assistant", "Working on it.", 1),
      message("user", "Follow-up.", 2),
    ];
    const { older, recent } = Handoff.splitTranscriptTail(carried);
    expect(older.map((candidate) => candidate.text.slice(0, 5))).toEqual(["First"]);
    expect(recent).toHaveLength(2);
  });

  it("keeps the prepared history within budget", () => {
    const carried = chat(Handoff.HANDOFF_FULL_TAIL_MESSAGES);
    const { recent } = Handoff.splitTranscriptTail(carried);
    const coverage = Handoff.buildHandoffCoverage({
      sourceThreadId: sourceId,
      sourceThreadTitle: "Audit design",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
      messagesCarried: carried.length,
      recentCount: recent.length,
      olderCount: 0,
      olderSummaryLines: [],
      links: [],
      attachments: [],
      toolLines: [],
    });
    const selected = Handoff.selectHandoffHistory(recent, sourceId, coverage);
    expect(
      historyCost(
        [...selected.messages],
        `${coverage}\nSelected ${selected.messages.length} intact items.`,
      ),
    ).toBeLessThanOrEqual(Handoff.HANDOFF_PREPARATION_BUDGET);
  });

  it("builds coverage with the summary, artifacts, model and recovery pointer", () => {
    const coverage = Handoff.buildHandoffCoverage({
      sourceThreadId: sourceId,
      sourceThreadTitle: "Audit design",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
      messagesCarried: 26,
      recentCount: 20,
      olderCount: 6,
      olderSummaryLines: ["- Fix booking-audit validation."],
      links: ["https://example.com/spec"],
      attachments: ["- file: spec.md (file)"],
      toolLines: ["- command `vp test` (exit 0): all green"],
    });
    expect(coverage).toContain('Work handoff from chat "Audit design"');
    expect(coverage).toContain("Source chat model: gpt-5 (provider codex)");
    expect(coverage).toContain("Carried 26 chat messages");
    expect(coverage).toContain("- Fix booking-audit validation.");
    expect(coverage).toContain("- link: https://example.com/spec");
    expect(coverage).toContain("- file: spec.md (file)");
    expect(coverage).toContain("- command `vp test` (exit 0): all green");
    expect(coverage).toContain(`t3_thread_read({threadId:"${sourceId}"`);
  });
});

describe("tool and subagent artifacts", () => {
  const base = {
    threadId: sourceId,
    runId: RunId.make("run:source"),
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    status: "completed" as const,
    title: null,
    startedAt: null,
    completedAt: null,
    updatedAt: at,
  };
  const items: ReadonlyArray<OrchestrationV2TurnItem> = [
    {
      ...base,
      id: TurnItemId.make("item:command"),
      ordinal: 3,
      type: "command_execution",
      input: "vp test",
      output: `ok\n${"x".repeat(500)}`,
      exitCode: 0,
    },
    {
      ...base,
      id: TurnItemId.make("item:search"),
      ordinal: 4,
      type: "web_search",
      patterns: ["t shirt express shipping"],
      results: [],
    },
    {
      ...base,
      id: TurnItemId.make("item:subagent"),
      ordinal: 5,
      type: "subagent",
      subagentId: NodeId.make("node:sub"),
      origin: "app_owned",
      driver: ProviderDriverKind.make("codex"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      childThreadId: null,
      prompt: "Research blank apparel suppliers.",
      result: "Three suppliers found.",
    },
    {
      ...base,
      id: TurnItemId.make("item:reasoning"),
      ordinal: 6,
      type: "reasoning",
      text: "private reasoning",
      streaming: false,
    },
  ];

  it("summarizes tool and subagent calls, one line each", () => {
    const lines = Handoff.summarizeHandoffToolItems(items);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^- command `vp test` \(exit 0\): ok/);
    expect(lines[1]).toBe("- web search `t shirt express shipping`: 0 results");
    expect(lines[2]).toMatch(
      /^- subagent \(codex, completed\): Research blank apparel suppliers\. → Three suppliers found\./,
    );
    expect(lines.join("\n")).not.toContain("private reasoning");
  });

  it("cuts artifacts off at the handoff message", () => {
    const withMessages: ReadonlyArray<OrchestrationV2TurnItem> = [
      {
        ...base,
        id: TurnItemId.make("item:user-one"),
        ordinal: 1,
        type: "user_message",
        createdBy: "user",
        creationSource: "web",
        messageId: MessageId.make("chat:0"),
        inputIntent: "turn_start",
        text: "First request.",
        attachments: [],
      },
      ...items,
      {
        ...base,
        id: TurnItemId.make("item:user-two"),
        ordinal: 7,
        type: "user_message",
        createdBy: "user",
        creationSource: "web",
        messageId: MessageId.make("chat:7"),
        inputIntent: "turn_start",
        text: "Unrelated later request.",
        attachments: [],
      },
    ];
    expect(
      Handoff.filterHandoffItemsThroughCutoff(withMessages, new Set(["chat:0"]), "chat:0").map(
        (item) => item.id,
      ),
    ).toEqual(["item:user-one"]);
    expect(
      Handoff.filterHandoffItemsThroughCutoff(
        withMessages,
        new Set(["chat:0", "chat:7"]),
        undefined,
      ),
    ).toHaveLength(withMessages.length);
  });
});

describe("handoff delivery", () => {
  const providerThread: OrchestrationV2ProviderThread = {
    id: ProviderThreadId.make("provider-thread:target"),
    driver: ProviderDriverKind.make("codex"),
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerSessionId: null,
    appThreadId: ThreadId.make("thread:work"),
    ownerNodeId: null,
    nativeThreadRef: {
      driver: ProviderDriverKind.make("codex"),
      strength: "strong",
      nativeId: "native:target",
    },
    nativeConversationHeadRef: null,
    status: "idle",
    firstRunOrdinal: null,
    lastRunOrdinal: null,
    handoffIds: [],
    forkedFrom: null,
    createdAt: at,
    updatedAt: at,
  };
  const handoffFor = (
    history: ReadonlyArray<{ role: "user" | "assistant"; text: string }>,
  ): OrchestrationV2ContextHandoff => ({
    id: ContextHandoffId.make("handoff:work"),
    threadId: ThreadId.make("thread:work"),
    sourceThreadId: sourceId,
    targetRunId: RunId.make("run:one"),
    fromProviderThreadIds: [],
    toProviderThreadId: providerThread.id,
    coveredRunOrdinals: { from: 1, to: 1 },
    strategy: "manual_context",
    status: "ready",
    summaryMessageId: null,
    summaryText: "Make a custom t shirt.",
    history: {
      messages: history.map((entry, index) =>
        Handoff.toHandoffHistoricalMessage(message(entry.role, entry.text, index), sourceId),
      ),
      coverage: "Work handoff from chat.",
      omittedItems: 0,
    },
    createdByProviderInstanceId: null,
    createdAt: at,
    updatedAt: at,
  });

  it.effect("delivers the carried transcript once, then never re-injects it", () =>
    Effect.gen(function* () {
      const handoff = handoffFor([
        { role: "user", text: "i want a custom t shirt" },
        { role: "assistant", text: "What color?" },
      ]);
      const persisted: OrchestrationV2ContextHandoff[] = [];
      const deliver = (candidates: ReadonlyArray<OrchestrationV2ContextHandoff>) =>
        deliverContextHandoffs({
          handoffs: candidates,
          providerThread,
          budget: 16_000,
          alreadyDeliveredItemIds: new Set(),
          persist: (candidate) =>
            Effect.sync(() => {
              persisted.push(candidate);
            }),
        });
      const first = yield* deliver([handoff]);
      expect(first.context).toContain("i want a custom t shirt");
      expect(first.context).toContain("What color?");
      yield* first.delivered;
      const settled = persisted.at(-1)!;
      expect(settled.delivery?.status).toBe("inline");
      // The settled handoff carries delivery receipts: later turns skip it,
      // so the source chat is never injected twice.
      const second = yield* deliver([{ ...handoff, delivery: settled.delivery }]);
      expect(second.context).toBe("");
    }),
  );
});
