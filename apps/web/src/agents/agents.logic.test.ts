import { describe, expect, it } from "vite-plus/test";
import {
  conversationRows,
  mergeLatestMessage,
  agentThreadRole,
  formatContactTime,
  formatMessageTime,
  readCursor,
  unreadCount,
  sortAgentContacts,
} from "./agents.logic";
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
describe("agent unread messages", () => {
  const messages = [
    message("a", "assistant", at(16, 7, 10)),
    message("owner", "user", at(16, 7, 11)),
    message("b", "assistant", at(16, 7, 12)),
    message("c", "assistant", at(16, 7, 12)),
  ];
  it("counts only agent messages and clears when viewed", () => {
    expect(unreadCount(messages, null)).toBe(3);
    expect(unreadCount(messages, readCursor(messages))).toBe(0);
    expect(readCursor([messages[1]!])).toBeNull();
  });
  it("counts a newly arrived message sharing a timestamp with a read message", () => {
    const cursor = readCursor(messages.slice(0, 3));
    expect(unreadCount(messages, cursor)).toBe(1);
  });
  it("ignores older history loaded after viewing and handles out of order input", () => {
    const cursor = readCursor([messages[2]!, messages[0]!, messages[3]!]);
    expect(unreadCount([message("history", "assistant", at(15, 7, 0)), ...messages], cursor)).toBe(
      0,
    );
  });
  it("adds a later background result to the unread count", () => {
    expect(
      unreadCount(
        [...messages, message("result", "assistant", at(16, 8, 0))],
        readCursor(messages),
      ),
    ).toBe(1);
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
    expect(unreadCount(updated, readCursor(viewed))).toBe(1);
    expect(mergeLatestMessage(updated, updated[1]!)).toBe(updated);
  });
  it("updates streaming text without duplicating a message or moving its timestamp", () => {
    const existing = message("a", "assistant", at(16, 7, 10));
    expect(
      mergeLatestMessage([existing], { ...existing, text: "Finished", createdAt: at(16, 7, 12) }),
    ).toEqual([{ ...existing, text: "Finished" }]);
  });
  it("recognizes background work ownership and accepts older shell contracts", () => {
    expect(agentThreadRole({ agent: { role: "work" } })).toBe("work");
    expect(agentThreadRole({ agent: { role: "conversation" } })).toBe("conversation");
    expect(agentThreadRole({})).toBeNull();
    expect(agentThreadRole({ agent: { role: "new-kind" } })).toBeNull();
  });
});
