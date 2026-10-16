import { describe, expect, it } from "vite-plus/test";
import {
  conversationRows,
  messageDelivery,
  reconcileAgentMessages,
  mergeLatestMessage,
  formatContactTime,
  formatMessageTime,
  sortAgentContacts,
  groupAgentContacts,
} from "./agents.logic";
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
    expect(formatContactTime(at(16, 7, 13), now, "en-US")).toBe("7:13 AM");
    expect(formatContactTime(at(15, 19, 5), now, "en-US")).toBe("Oct 15");
    expect(formatContactTime("bad", now)).toBe("");
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

describe("project contact groups", () => {
  it("puts no-project agents first without a label, then projects by name and contacts by activity", () => {
    const contacts = [
      { id: "older", name: "Older", projectId: "z", updatedAt: at(16, 7, 0) },
      { id: "newer", name: "Newer", projectId: "z", updatedAt: at(16, 8, 0) },
      { id: "free", name: "Free", projectId: null, updatedAt: at(16, 6, 0) },
      { id: "alpha", name: "Alpha", projectId: "a", updatedAt: at(16, 5, 0) },
    ] as AgentContact[];
    const groups = groupAgentContacts(contacts, (agent) =>
      agent.projectId
        ? { key: agent.projectId, label: agent.projectId === "a" ? "Alpha" : "Zulu" }
        : null,
    );
    expect(groups.map((group) => group.label)).toEqual([null, "Alpha", "Zulu"]);
    expect(groups[0]?.agents.map((agent) => agent.id)).toEqual(["free"]);
    expect(groups[2]?.agents.map((agent) => agent.id)).toEqual(["newer", "older"]);
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
