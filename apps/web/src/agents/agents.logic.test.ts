import { describe, expect, it } from "vite-plus/test";
import {
  agentConversationState,
  conversationRows,
  messageDelivery,
  reconcileAgentMessages,
  mergeLatestMessage,
  formatMessageTime,
  sortAgentContacts,
  modelSwitches,
  modelDisplayName,
  resolveAgentModelStatus,
  agentStatusLabel,
  INITIAL_TYPING_SLOT,
  stepTypingSlot,
  agentAttachmentIdentity,
  agentAttachmentSupport,
  wireAgentAttachments,
} from "./agents.logic";
import { ChatAttachmentId, ProviderInstanceId } from "@cogenly/contracts";
import * as DateTime from "effect/DateTime";
import type { AgentContact, AgentMessage } from "./agents.types";

const now = new Date(2026, 9, 16, 10, 30);
const at = (day: number, hour: number, minute: number) =>
  new Date(2026, 9, day, hour, minute).toISOString();
const message = (id: string, role: AgentMessage["role"], createdAt: string): AgentMessage => ({
  id,
  role,
  createdAt,
  text: id,
});
describe("agent text attachments", () => {
  const image = {
    type: "image" as const,
    id: ChatAttachmentId.make("pending-00000000-0000-4000-8000-000000000001"),
    name: "screen.png",
    mimeType: "image/png",
    sizeBytes: 3,
  };
  it("keeps the local preview on this client and sends the upload as stored", () => {
    const file = {
      type: "file" as const,
      id: ChatAttachmentId.make("pending-00000000-0000-4000-8000-000000000002"),
      name: "notes.txt",
      mimeType: "text/plain",
      sizeBytes: 5,
    };
    expect(wireAgentAttachments([{ ...image, previewUrl: "blob:local" }, file])).toEqual([
      image,
      file,
    ]);
  });
  it("reuses a retry's ids only for the same files", () => {
    const other = { ...image, id: ChatAttachmentId.make("pending-other") };
    expect(agentAttachmentIdentity([image])).toBe(agentAttachmentIdentity([image]));
    expect(agentAttachmentIdentity([image])).not.toBe(agentAttachmentIdentity([image, other]));
    expect(agentAttachmentIdentity([])).not.toBe(agentAttachmentIdentity([image]));
  });
  it("offers attachments only where the server claims them for agents", () => {
    expect(agentAttachmentSupport(undefined)).toBeNull();
    expect(agentAttachmentSupport({ attachmentUploads: true })).toBeNull();
    expect(agentAttachmentSupport({ agentAttachments: true })).toBeNull();
    expect(agentAttachmentSupport({ agentAttachments: true, attachmentUploads: true })).toEqual({
      maxFileBytes: null,
    });
    expect(
      agentAttachmentSupport({
        agentAttachments: true,
        attachmentUploads: true,
        fileAttachments: { maxUploadBytes: 1024 },
      }),
    ).toEqual({ maxFileBytes: 1024 });
  });
});

describe("texting timeline", () => {
  it("groups only adjacent messages by the same sender within three minutes", () => {
    const rows = conversationRows(
      [
        message("a", "assistant", at(16, 7, 10)),
        message("b", "assistant", at(16, 7, 12)),
        message("c", "user", at(16, 7, 13)),
        message("d", "user", at(16, 7, 17)),
      ],
      now,
      "en-US",
    );
    expect(rows.map((row) => row.grouped)).toEqual([false, true, false, false]);
    expect(rows.map((row) => row.separator)).toEqual(["Today 7:10 AM", null, null, null]);
  });
  it("separates a new day even when consecutive messages are less than three minutes apart", () => {
    const rows = conversationRows(
      [message("a", "assistant", at(15, 23, 59)), message("b", "assistant", at(16, 0, 1))],
      now,
      "en-US",
    );
    expect(rows[1]).toMatchObject({ grouped: false, separator: "Today 12:01 AM" });
  });
  it("separates a thirty minute gap and keeps a triggered message in its own group", () => {
    const rows = conversationRows(
      [
        message("a", "assistant", at(16, 7, 10)),
        message("b", "assistant", at(16, 7, 40)),
        {
          ...message("c", "assistant", at(16, 7, 41)),
          source: { name: "Audit", threadId: "work" as AgentContact["conversationThreadId"] },
        },
      ],
      now,
      "en-US",
    );
    expect(rows[1]?.separator).toBe("Today 7:40 AM");
    expect(rows[2]?.grouped).toBe(false);
  });
  it("formats local today, yesterday, older dates, and invalid dates", () => {
    expect(formatMessageTime(at(16, 7, 13), now, "en-US")).toBe("Today 7:13 AM");
    expect(formatMessageTime(at(15, 19, 5), now, "en-US")).toBe("Yesterday 7:05 PM");
    expect(formatMessageTime(at(12, 9, 0), now, "en-US")).toBe("Oct 12 9:00 AM");
    expect(formatMessageTime("bad", now, "en-US")).toBe("");
  });
});
describe("contact ordering", () => {
  it("sorts by activity without mutating the source, with stable ties", () => {
    const agents = [
      { id: "a", name: "Atlas", updatedAt: at(16, 7, 10) },
      { id: "j", name: "Juniper", updatedAt: at(16, 9, 0) },
      { id: "e", name: "Echo", updatedAt: at(16, 7, 10) },
    ] as AgentContact[];
    expect(sortAgentContacts(agents).map((agent) => agent.id)).toEqual(["j", "a", "e"]);
    expect(agents[0]?.id).toBe("a");
  });
});

describe("shell updates", () => {
  it("keeps history and counts new messages while a contact is closed", () => {
    const viewed = [message("a", "assistant", at(16, 7, 10))];
    const updated = mergeLatestMessage(viewed, message("b", "assistant", at(16, 8, 0)));
    expect(updated.map((item) => item.id)).toEqual(["a", "b"]);
    expect(mergeLatestMessage(updated, updated[1]!)).toBe(updated);
  });
  it("updates streaming text without duplicating a message or moving its timestamp", () => {
    const existing = message("a", "assistant", at(16, 7, 10));
    expect(
      mergeLatestMessage([existing], { ...existing, text: "Finished", createdAt: at(16, 7, 12) }),
    ).toEqual([{ ...existing, text: "Finished" }]);
  });
});

describe("owner message delivery", () => {
  it("shows provider failures instead of a successful delivery receipt", () => {
    expect(messageDelivery({ status: "failed", startedAt: null })).toBe("failed");
    expect(
      messageDelivery({ status: "failed", startedAt: DateTime.makeUnsafe("2026-10-16T09:00:00Z") }),
    ).toBe("failed");
    expect(messageDelivery({ status: "cancelled", startedAt: null })).toBe("interrupted");
    expect(messageDelivery({ status: "queued", startedAt: null })).toBe("queued");
    expect(messageDelivery({ status: "starting", startedAt: null })).toBe("delivered");
    expect(
      messageDelivery({
        status: "running",
        startedAt: DateTime.makeUnsafe("2026-10-16T09:00:00Z"),
      }),
    ).toBe("read");
    expect(messageDelivery({ status: "completed", startedAt: null })).toBe("read");
  });
  it("reconciles optimistic sends by identity, including identical texts and failed acknowledgements", () => {
    const optimistic = {
      ...message("one", "user", at(16, 9, 0)),
      text: "hi",
      optimistic: true,
      delivery: "failed" as const,
    };
    const second = { ...optimistic, id: "two", delivery: "sending" as const };
    const persisted = { ...optimistic, optimistic: false, delivery: "read" as const };
    expect(reconcileAgentMessages([persisted], [optimistic, second])).toEqual([persisted, second]);
    expect(reconcileAgentMessages([], [optimistic])).toEqual([optimistic]);
  });
});

describe("model switches", () => {
  const codex = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6" };
  const claude = { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-opus-5-5" };
  const sent = (id: string, model: typeof codex): AgentMessage => ({
    ...message(id, "user", at(16, 9, 0)),
    model,
  });
  it("marks the first text to each new model and a switch the next text will use", () => {
    const messages = [
      sent("a", codex),
      message("r1", "assistant", at(16, 9, 1)),
      sent("b", codex),
      sent("c", claude),
      sent("d", claude),
    ];
    const switches = modelSwitches(messages, codex);
    expect([...switches.before.keys()]).toEqual(["c"]);
    expect(switches.trailing).toEqual(codex);
    expect(modelSwitches(messages, claude).trailing).toBeNull();
    // A new agent's first text has nothing to switch from.
    expect(modelSwitches([], claude)).toEqual({ before: new Map(), trailing: null });
  });
  it("names models from the live catalog with a slug fallback", () => {
    const models = [
      { label: "Claude · Claude Opus 5.5", name: "Claude Opus 5.5", selection: claude },
      { label: "Codex · GPT-6", selection: codex },
    ];
    expect(modelDisplayName(models, claude)).toBe("Claude Opus 5.5");
    expect(modelDisplayName(models, codex)).toBe("GPT-6");
    expect(modelDisplayName(models, { ...codex, model: "gpt-x" })).toBe("gpt-x");
  });
});

describe("model availability", () => {
  const codex = {
    instanceId: "codex",
    driver: "codex",
    enabled: true,
    models: [{ slug: "gpt-6.1-sol" }, { slug: "gpt-6-astra" }],
  };
  const pick = (model: string, instanceId = "codex") => ({
    instanceId: ProviderInstanceId.make(instanceId),
    model,
  });
  it("flags a model missing from its provider's live catalog", () => {
    expect(resolveAgentModelStatus([codex], pick("gpt-5.4"))).toEqual({
      status: "unavailable",
      providerName: "Codex",
    });
    expect(resolveAgentModelStatus([codex], pick("gpt-6-astra")).status).toBe("available");
  });
  it("flags a missing or disabled provider instance", () => {
    expect(resolveAgentModelStatus([codex], pick("claude-opus-5-5", "claudeAgent")).status).toBe(
      "unavailable",
    );
    expect(
      resolveAgentModelStatus([{ ...codex, enabled: false }], pick("gpt-6-astra")).status,
    ).toBe("unavailable");
  });
  it("waits while the catalog loads or a provider is still probing", () => {
    expect(resolveAgentModelStatus(undefined, pick("gpt-5.4")).status).toBe("unknown");
    expect(resolveAgentModelStatus([{ ...codex, models: [] }], pick("gpt-5.4")).status).toBe(
      "unknown",
    );
  });
});

describe("agentStatusLabel", () => {
  const status = (patch: Partial<Pick<AgentContact, "state" | "requests" | "approvals">> = {}) =>
    agentStatusLabel({ state: "idle", requests: [], ...patch });
  const request = (kind: "approval" | "question") => ({
    id: kind,
    kind,
    text: kind,
    createdAt: at(16, 10, 0),
    canRespond: true,
  });

  it("calls an agent with nothing running idle, not active", () => {
    expect(status()).toBe("Idle");
    expect(status({ state: "done" })).toBe("Idle");
    expect(status({ state: "asleep" })).toBe("Idle");
  });

  it("reports running only while a run is live", () => {
    expect(status({ state: "thinking" })).toBe("Running");
    expect(status({ state: "working" })).toBe("Running");
  });

  it("puts pending approvals and questions ahead of everything", () => {
    expect(status({ state: "thinking", requests: [request("approval")] })).toBe("Needs approval");
    expect(status({ requests: [request("question")] })).toBe("Needs you");
    // The contact list knows only that a thread is waiting, not on what.
    expect(status({ state: "blocked" })).toBe("Needs you");
  });

  it("asks for approval while the agent waits on an owner decision", () => {
    const approval = { id: "approval-1" } as AgentContact["approvals"][number];
    expect(status({ approvals: [approval] })).toBe("Needs approval");
  });
});

describe("typing slot", () => {
  const user = (id: string) => ({ id, role: "user" as const, streaming: false });
  const reply = (id: string, streaming = false) => ({ id, role: "assistant" as const, streaming });

  it("shows while the agent works and hands its key to the reply that arrives", () => {
    let step = stepTypingSlot(INITIAL_TYPING_SLOT, [user("u1")], false);
    expect(step.typingKey).toBeNull();
    step = stepTypingSlot(step.state, [user("u1")], true);
    expect(step.typingKey).toBe("typing-0");
    // The reply streams in: it takes the slot's key and the bubble is gone.
    step = stepTypingSlot(step.state, [user("u1"), reply("a1", true)], true);
    expect(step.typingKey).toBeNull();
    expect(step.state.claimed.get("a1")).toBe("typing-0");
    // Still working after the reply (a tool call): a fresh slot.
    step = stepTypingSlot(step.state, [user("u1"), reply("a1")], true);
    expect(step.typingKey).toBe("typing-1");
    step = stepTypingSlot(step.state, [user("u1"), reply("a1"), reply("a2")], false);
    expect(step.typingKey).toBeNull();
    expect(step.state.claimed.get("a2")).toBe("typing-1");
    expect(step.state.claimed.get("a1")).toBe("typing-0");
  });

  it("never claims history loaded while nothing was showing", () => {
    const step = stepTypingSlot(INITIAL_TYPING_SLOT, [reply("old")], false);
    expect(step.state.claimed.size).toBe(0);
    expect(step.typingKey).toBeNull();
  });
});

it("updates contact state through queued, running and finished projections", () => {
  expect(
    agentConversationState({ needsInput: false, runStatuses: ["queued"], prior: "idle" }),
  ).toBe("thinking");
  expect(
    agentConversationState({ needsInput: false, runStatuses: ["running"], prior: "idle" }),
  ).toBe("thinking");
  expect(
    agentConversationState({ needsInput: false, runStatuses: ["completed"], prior: "thinking" }),
  ).toBe("idle");
  expect(
    agentConversationState({ needsInput: true, runStatuses: ["waiting"], prior: "thinking" }),
  ).toBe("blocked");
});
