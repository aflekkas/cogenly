import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { DraftId } from "./composerDraftStore";
import {
  EMPTY_THREAD_VIEW_SLOTS,
  placeThreadRouteTarget,
  slotHolding,
  threadRouteTargetKey,
  threadViewSlotFor,
  type ThreadViewSlotEntry,
} from "./threadRouteSlots";
import type { ThreadRouteTarget } from "./threadRoutes";

function serverThread(threadId: string): ThreadRouteTarget {
  return {
    kind: "server",
    threadRef: { environmentId: "env" as EnvironmentId, threadId: threadId as ThreadId },
  };
}
function entry(target: ThreadRouteTarget): ThreadViewSlotEntry {
  return { key: threadRouteTargetKey(target), target };
}
const chat = entry(serverThread("chat"));
const otherChat = entry(serverThread("chat-2"));
const workDraft = entry({ kind: "draft", draftId: "draft" as DraftId });
const workThread = entry(serverThread("work"));

describe("placeThreadRouteTarget", () => {
  it("gives each mode its own view and switches between them", () => {
    const chats = placeThreadRouteTarget(EMPTY_THREAD_VIEW_SLOTS, chat, () => "chats");
    const work = placeThreadRouteTarget(chats, workDraft, () => "tasks");
    expect(work).toEqual({ active: "tasks", entries: { chats: chat, tasks: workDraft } });

    // Back to Chats reveals the same chat without asking for its mode again.
    const back = placeThreadRouteTarget(work, chat, () => {
      throw new Error("a held thread is not classified");
    });
    expect(back).toEqual({ active: "chats", entries: work.entries });
    expect(back.entries).toBe(work.entries);
  });

  it("returns the same slots when the shown thread is placed again", () => {
    const slots = placeThreadRouteTarget(EMPTY_THREAD_VIEW_SLOTS, chat, () => "chats");
    expect(placeThreadRouteTarget(slots, chat, () => "chats")).toBe(slots);
  });

  it("hands a mode's next thread to that mode's view", () => {
    const slots = placeThreadRouteTarget(
      placeThreadRouteTarget(EMPTY_THREAD_VIEW_SLOTS, chat, () => "chats"),
      workDraft,
      () => "tasks",
    );
    const opened = placeThreadRouteTarget(slots, workThread, () => "tasks");
    expect(opened).toEqual({ active: "tasks", entries: { chats: chat, tasks: workThread } });
    const nextChat = placeThreadRouteTarget(opened, otherChat, () => "chats");
    expect(nextChat).toEqual({
      active: "chats",
      entries: { chats: otherChat, tasks: workThread },
    });
  });

  it("keeps a thread of unknown mode in the shown view", () => {
    const slots = placeThreadRouteTarget(EMPTY_THREAD_VIEW_SLOTS, workDraft, () => "tasks");
    expect(placeThreadRouteTarget(slots, workThread, () => null)).toEqual({
      active: "tasks",
      entries: { tasks: workThread },
    });
    expect(placeThreadRouteTarget(EMPTY_THREAD_VIEW_SLOTS, chat, () => null).active).toBe("chats");
  });
});

describe("threadViewSlotFor", () => {
  it("keeps a mode's draft apart from its threads", () => {
    expect(threadViewSlotFor("tasks", workDraft.target)).toBe("tasks:draft");
    expect(threadViewSlotFor("tasks", workThread.target)).toBe("tasks");
  });

  it("reveals a mode's draft again after a thread opened beside it", () => {
    const slotFor = (target: ThreadRouteTarget) => () => threadViewSlotFor("tasks", target);
    const draft = placeThreadRouteTarget(
      EMPTY_THREAD_VIEW_SLOTS,
      workDraft,
      slotFor(workDraft.target),
    );
    const thread = placeThreadRouteTarget(draft, workThread, slotFor(workThread.target));
    const back = placeThreadRouteTarget(thread, workDraft, slotFor(workDraft.target));
    expect(back).toEqual({
      active: "tasks:draft",
      entries: { "tasks:draft": workDraft, tasks: workThread },
    });
  });
});

describe("slotHolding", () => {
  it("finds the view holding a thread", () => {
    const slots = placeThreadRouteTarget(EMPTY_THREAD_VIEW_SLOTS, workDraft, () => "tasks");
    expect(slotHolding(slots, workDraft.key)).toBe("tasks");
    expect(slotHolding(slots, chat.key)).toBeNull();
  });
});
