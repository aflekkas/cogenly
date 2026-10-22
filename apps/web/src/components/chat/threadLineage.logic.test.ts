import { RunId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildThreadLineageChain,
  collapseThreadBreadcrumb,
  resolveThreadOrigin,
  type ThreadLineageAncestor,
} from "./threadLineage.logic";

type Source = Parameters<typeof resolveThreadOrigin>[0];

function source(id: string, overrides: Partial<Source> = {}): Source {
  return {
    id: ThreadId.make(id),
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: ThreadId.make(id) },
    forkedFrom: null,
    ...overrides,
  };
}

function subagentOf(id: string, parent: string, extra: Partial<Source> = {}): Source {
  return source(id, {
    lineage: {
      parentThreadId: ThreadId.make(parent),
      relationshipToParent: "subagent",
      rootThreadId: ThreadId.make(parent),
    },
    ...extra,
  });
}

function workFromChat(id: string, chat: string): Source {
  return source(id, { workOrigin: "chat", sourceThreadId: ThreadId.make(chat) });
}

function lookupFrom(threads: ReadonlyArray<{ title: string; source: Source }>) {
  return (threadId: ThreadId) => threads.find((thread) => thread.source.id === threadId) ?? null;
}

describe("resolveThreadOrigin", () => {
  it("names a subagent's parent agent", () => {
    expect(resolveThreadOrigin(subagentOf("child", "parent"))).toEqual({
      kind: "subagent",
      threadId: "parent",
    });
  });

  it("takes a fork's source thread from the run it forked", () => {
    const fork = source("fork", {
      lineage: {
        parentThreadId: null,
        relationshipToParent: "fork",
        rootThreadId: ThreadId.make("fork"),
      },
      forkedFrom: { type: "run", threadId: ThreadId.make("original"), runId: RunId.make("run-1") },
    });
    expect(resolveThreadOrigin(fork)).toEqual({ kind: "fork", threadId: "original" });
  });

  it("links Work back to the chat or agent conversation it was started from", () => {
    expect(resolveThreadOrigin(workFromChat("work", "chat"))).toEqual({
      kind: "chat",
      threadId: "chat",
    });
    expect(
      resolveThreadOrigin(
        source("work", { workOrigin: "agent", sourceThreadId: ThreadId.make("conversation") }),
      ),
    ).toEqual({ kind: "agent-conversation", threadId: "conversation" });
  });

  it("prefers the spawning agent over an inherited source chat", () => {
    const child = subagentOf("child", "work", {
      workOrigin: "chat",
      sourceThreadId: ThreadId.make("chat"),
    });
    expect(resolveThreadOrigin(child)?.threadId).toBe("work");
  });

  it("ignores a thread that points at itself", () => {
    expect(resolveThreadOrigin(subagentOf("loop", "loop"))).toBeNull();
    expect(resolveThreadOrigin(source("top"))).toBeNull();
  });
});

describe("buildThreadLineageChain", () => {
  it("walks to the root, root first", () => {
    const threads = [
      { title: "Plan the browser", source: source("chat") },
      { title: "Uninstall Nook", source: workFromChat("work", "chat") },
      { title: "Fix CI", source: subagentOf("child", "work") },
    ];
    expect(buildThreadLineageChain(subagentOf("grandchild", "child"), lookupFrom(threads))).toEqual(
      [
        { threadId: "chat", title: "Plan the browser", kind: "chat" },
        { threadId: "work", title: "Uninstall Nook", kind: "subagent" },
        { threadId: "child", title: "Fix CI", kind: "subagent" },
      ],
    );
  });

  it("keeps an unknown ancestor without a title and stops there", () => {
    expect(buildThreadLineageChain(subagentOf("child", "gone"), () => null)).toEqual([
      { threadId: "gone", title: null, kind: "subagent" },
    ]);
  });

  it("stops at a cycle and at the depth limit", () => {
    const threads = [
      { title: "A", source: subagentOf("a", "b") },
      { title: "B", source: subagentOf("b", "a") },
    ];
    expect(
      buildThreadLineageChain(subagentOf("c", "a"), lookupFrom(threads)).map((a) => a.threadId),
    ).toEqual(["b", "a"]);

    const deep = Array.from({ length: 10 }, (_, index) => ({
      title: `T${index}`,
      source: subagentOf(`t${index}`, `t${index + 1}`),
    }));
    expect(buildThreadLineageChain(subagentOf("leaf", "t0"), lookupFrom(deep), 3)).toHaveLength(3);
  });

  it("treats a blank title as unknown", () => {
    const threads = [{ title: "  ", source: source("parent") }];
    expect(buildThreadLineageChain(subagentOf("child", "parent"), lookupFrom(threads))).toEqual([
      { threadId: "parent", title: null, kind: "subagent" },
    ]);
  });
});

describe("collapseThreadBreadcrumb", () => {
  const ancestor = (id: string): ThreadLineageAncestor => ({
    threadId: ThreadId.make(id),
    title: id,
    kind: "subagent",
  });

  it("is empty for a top-level thread", () => {
    expect(collapseThreadBreadcrumb([])).toBeNull();
  });

  it("shows a lone parent, or a root and parent, in full", () => {
    expect(collapseThreadBreadcrumb([ancestor("p")])).toEqual({
      root: null,
      hidden: [],
      parent: ancestor("p"),
    });
    expect(collapseThreadBreadcrumb([ancestor("r"), ancestor("p")])).toEqual({
      root: ancestor("r"),
      hidden: [],
      parent: ancestor("p"),
    });
  });

  it("folds everything between the root and the parent", () => {
    expect(
      collapseThreadBreadcrumb([ancestor("r"), ancestor("a"), ancestor("b"), ancestor("p")]),
    ).toEqual({
      root: ancestor("r"),
      hidden: [ancestor("a"), ancestor("b")],
      parent: ancestor("p"),
    });
  });
});
