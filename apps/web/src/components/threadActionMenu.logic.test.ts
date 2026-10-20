import type { ContextMenuItem } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { threadCapabilities, type ThreadKind } from "../threadCapabilities";
import {
  buildDraftActionMenuItems,
  buildThreadActionMenuItems,
  type DraftActionMenuId,
  type ThreadActionMenuId,
  type ThreadActionMenuState,
} from "./threadActionMenu.logic";

function stateFor(kind: ThreadKind, overrides: Partial<ThreadActionMenuState> = {}) {
  const state: ThreadActionMenuState = {
    capabilities: threadCapabilities(kind),
    canOperate: true,
    branch: "feature/x",
    isSettled: false,
    autoSettleEnabled: true,
    isSnoozed: false,
    canSnoozeNow: true,
    isRegeneratingTitle: false,
    isRunning: false,
    supports: { settlement: true, autoSettleOptOut: true, snooze: true, titleRegeneration: true },
    snoozePresets: [],
    projects: [{ key: "env:spawn", name: "Spawn" }],
    ...overrides,
  };
  return state;
}

function ids(
  items: ReadonlyArray<ContextMenuItem<ThreadActionMenuId | DraftActionMenuId>>,
): string[] {
  return items.flatMap((item) => [item.id, ...(item.children ? ids(item.children) : [])]);
}

describe("buildThreadActionMenuItems per thread kind", () => {
  it("offers a chat only conversation actions", () => {
    expect(ids(buildThreadActionMenuItems(stateFor("chat")))).toEqual([
      "start-work",
      "rename",
      "regenerate-title",
      "mark-unread",
      "copy",
      "copy-thread-link",
      "copy-thread-id",
      "open-project:env:spawn",
      "delete",
    ]);
  });

  it("offers Work its lifecycle and repository actions, without Start Work", () => {
    expect(ids(buildThreadActionMenuItems(stateFor("work")))).toEqual([
      "new-thread-on-branch",
      "settle",
      "snooze",
      "snooze:custom",
      "rename",
      "regenerate-title",
      "mark-unread",
      "auto-settle",
      "auto-settle:enabled",
      "auto-settle:disabled",
      "copy",
      "copy-path",
      "copy-branch",
      "copy-thread-link",
      "copy-thread-id",
      "project-settings",
      "open-project:env:spawn",
      "archive",
      "delete",
    ]);
  });

  it("offers an agent conversation reading, copying and its agent's settings", () => {
    expect(ids(buildThreadActionMenuItems(stateFor("agentConversation")))).toEqual([
      "mark-unread",
      "copy",
      "copy-thread-link",
      "copy-thread-id",
      "agent-settings",
    ]);
  });

  it("opens each group after the first with a separator, wherever the group starts", () => {
    const items = buildThreadActionMenuItems(stateFor("agentConversation"));
    expect(items.map((item) => [item.id, item.separatorBefore === true])).toEqual([
      ["mark-unread", false],
      ["copy", true],
      ["agent-settings", false],
    ]);
  });

  it("keeps the reverse of each supported action", () => {
    const work = ids(
      buildThreadActionMenuItems(
        stateFor("work", { isSettled: true, isSnoozed: true, isUnread: true }),
      ),
    );
    expect(work).toContain("unsettle");
    expect(work).toContain("unsnooze");
    expect(work).toContain("mark-read");
    expect(work).not.toContain("mark-unread");
    expect(ids(buildThreadActionMenuItems(stateFor("chat", { isUnread: true })))).toContain(
      "mark-read",
    );
  });

  it("disables archive with its reason while the thread runs, rather than hiding it", () => {
    const archive = buildThreadActionMenuItems(stateFor("work", { isRunning: true })).find(
      (item) => item.id === "archive",
    );
    expect(archive).toMatchObject({ disabled: true, label: "Archive thread (stop it first)" });
  });

  it("still needs the server to support a kind's lifecycle actions", () => {
    const items = ids(
      buildThreadActionMenuItems(
        stateFor("work", {
          supports: {
            settlement: false,
            autoSettleOptOut: false,
            snooze: false,
            titleRegeneration: false,
          },
        }),
      ),
    );
    expect(items).not.toContain("settle");
    expect(items).not.toContain("snooze");
    expect(items).not.toContain("auto-settle");
    expect(items).not.toContain("regenerate-title");
  });

  it("drops the branch items without a branch", () => {
    const items = ids(buildThreadActionMenuItems(stateFor("work", { branch: null })));
    expect(items).not.toContain("new-thread-on-branch");
    expect(items).not.toContain("copy-branch");
  });
});

describe("Open project in the thread action menu", () => {
  const projectItem = (menuState: ThreadActionMenuState) =>
    buildThreadActionMenuItems(menuState).find((item) => item.id.startsWith("open-project"));

  it("opens a single project directly and nests several, even for read-only clients", () => {
    const readOnly = stateFor("work", { canOperate: false, projects: [] });
    expect(projectItem(readOnly)).toBeUndefined();
    const one = projectItem({ ...readOnly, projects: [{ key: "env:spawn", name: "Spawn" }] });
    expect(one).toMatchObject({ id: "open-project:env:spawn", label: "Open Spawn" });
    expect(one?.disabled).toBeUndefined();
    const several = projectItem({
      ...readOnly,
      projects: [
        { key: "env:bartr", name: "Bartr" },
        { key: "env:spawn", name: "Spawn" },
      ],
    });
    expect(several?.children?.map((child) => child.id)).toEqual([
      "open-project:env:bartr",
      "open-project:env:spawn",
    ]);
  });
});

describe("Start Work in the thread action menu", () => {
  const startWork = (menuState: ThreadActionMenuState) =>
    buildThreadActionMenuItems(menuState).find((item) => item.id === "start-work");

  it("is offered only on chats, and disabled without operate access", () => {
    expect(startWork(stateFor("work"))).toBeUndefined();
    expect(startWork(stateFor("agentConversation"))).toBeUndefined();
    expect(startWork(stateFor("chat"))?.disabled).toBeUndefined();
    expect(startWork(stateFor("chat", { canOperate: false }))?.disabled).toBe(true);
  });
});

describe("buildDraftActionMenuItems", () => {
  it("gives a chat draft only Discard, with nothing to copy or configure", () => {
    expect(
      ids(buildDraftActionMenuItems({ hasPath: false, hasBranch: false, hasProject: false })),
    ).toEqual(["discard"]);
  });

  it("gives a repository draft its copy and settings items", () => {
    expect(
      ids(buildDraftActionMenuItems({ hasPath: true, hasBranch: true, hasProject: true })),
    ).toEqual(["copy", "copy-path", "copy-branch", "project-settings", "discard"]);
  });
});
