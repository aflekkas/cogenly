import type { ContextMenuItem } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { threadCapabilities, type ThreadKind } from "../threadCapabilities";
import {
  buildDraftActionMenuItems,
  buildRepositoryActionMenuItems,
  buildThreadActionMenuItems,
  machineMenuItems,
  type ThreadActionMenuState,
} from "./threadActionMenu.logic";

function stateFor(kind: ThreadKind, overrides: Partial<ThreadActionMenuState> = {}) {
  const state: ThreadActionMenuState = {
    capabilities: threadCapabilities(kind),
    canOperate: true,
    branch: "feature/x",
    isPinned: false,
    isSettled: false,
    isSnoozed: false,
    canSnoozeNow: true,
    isRunning: false,
    supports: {
      settlement: true,
      snooze: true,
      pinning: true,
    },
    snoozePresets: [],
    folder: {
      current: { key: "env:spawn", id: "spawn", name: "Spawn" },
      removable: true,
      options: [
        { id: "bartr", name: "Bartr" },
        { id: "spawn", name: "Spawn", color: "violet" },
      ],
      canMove: true,
    },
    ...overrides,
  };
  return state;
}

function ids(items: ReadonlyArray<ContextMenuItem<string>>): string[] {
  return items.flatMap((item) => [item.id, ...(item.children ? ids(item.children) : [])]);
}

describe("buildThreadActionMenuItems per thread kind", () => {
  it("offers a chat only conversation actions", () => {
    expect(ids(buildThreadActionMenuItems(stateFor("chat")))).toEqual([
      "start-work",
      "pin",
      "mark-unread",
      "rename",
      "move-folder",
      "open-project:env:spawn",
      "move-folder:bartr",
      "move-folder:spawn",
      "remove-folder",
      "new-folder",
      "copy",
      "copy-thread-link",
      "copy-thread-id",
      "delete",
    ]);
  });

  it("offers Work its state, thread and removal actions, leaving repository actions to its heading", () => {
    const items = buildThreadActionMenuItems(stateFor("work"));
    expect(ids(items)).toEqual([
      "settle",
      "snooze",
      "snooze:custom",
      "mark-unread",
      "rename",
      "move-folder",
      "open-project:env:spawn",
      "move-folder:bartr",
      "move-folder:spawn",
      "remove-folder",
      "new-folder",
      "copy",
      "copy-path",
      "copy-branch",
      "copy-thread-link",
      "copy-thread-id",
      "archive",
      "delete",
    ]);
    expect(items.filter((item) => item.separatorBefore).map((item) => item.id)).toEqual([
      "rename",
      "archive",
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
    const pinnedChat = ids(buildThreadActionMenuItems(stateFor("chat", { isPinned: true })));
    expect(pinnedChat).toContain("unpin");
    expect(pinnedChat).not.toContain("pin");
  });

  it("disables archive with its reason while the thread runs, rather than hiding it", () => {
    const archive = buildThreadActionMenuItems(stateFor("work", { isRunning: true })).find(
      (item) => item.id === "archive",
    );
    expect(archive).toMatchObject({ disabled: true, label: "Archive Thread (Stop It First)" });
  });

  it("ends Delete with an ellipsis only when it asks first", () => {
    const deleteLabel = (confirmsDelete: boolean) =>
      buildThreadActionMenuItems(stateFor("chat", { confirmsDelete })).find(
        (item) => item.id === "delete",
      )?.label;
    expect(deleteLabel(true)).toBe("Delete…");
    expect(deleteLabel(false)).toBe("Delete");
  });

  it("still needs the server to support a kind's lifecycle actions", () => {
    const items = ids(
      buildThreadActionMenuItems(
        stateFor("work", {
          supports: {
            settlement: false,
            snooze: false,
            pinning: false,
          },
        }),
      ),
    );
    expect(items).not.toContain("settle");
    expect(items).not.toContain("snooze");
  });

  it("offers pinning on chats only, and only when the server supports it", () => {
    expect(ids(buildThreadActionMenuItems(stateFor("work")))).not.toContain("pin");
    expect(ids(buildThreadActionMenuItems(stateFor("agentConversation")))).not.toContain("pin");
    const unsupported = stateFor("chat");
    expect(
      ids(
        buildThreadActionMenuItems({
          ...unsupported,
          supports: { ...unsupported.supports, pinning: false },
        }),
      ),
    ).not.toContain("pin");
  });

  it("offers Regenerate Title after Rename when the server supports it, waiting while it runs", () => {
    const withRegeneration = (kind: ThreadKind, isRegeneratingTitle = false) => {
      const base = stateFor(kind, { isRegeneratingTitle });
      return buildThreadActionMenuItems({
        ...base,
        supports: { ...base.supports, titleRegeneration: true },
      });
    };
    for (const kind of ["chat", "work"] as const) {
      const items = ids(withRegeneration(kind));
      expect(items.indexOf("regenerate-title")).toBe(items.indexOf("rename") + 1);
    }
    const pending = withRegeneration("work", true).find((item) => item.id === "regenerate-title");
    expect(pending).toMatchObject({ label: "Regenerating Title…", disabled: true });
    expect(ids(buildThreadActionMenuItems(stateFor("work")))).not.toContain("regenerate-title");
    expect(ids(withRegeneration("agentConversation"))).not.toContain("regenerate-title");
  });

  it("drops the branch items without a branch", () => {
    const items = ids(buildThreadActionMenuItems(stateFor("work", { branch: null })));
    expect(items).not.toContain("copy-branch");
  });
});

describe("Move to folder in the thread action menu", () => {
  const folderItems = (menuState: ThreadActionMenuState) =>
    buildThreadActionMenuItems(menuState).filter((item) => item.id === "move-folder");
  const base = stateFor("chat").folder!;

  it("offers an unfiled thread every folder and a new one, with no way out to show", () => {
    const items = folderItems(stateFor("chat", { folder: { ...base, current: null } }));
    expect(ids(items)).toEqual([
      "move-folder",
      "move-folder:bartr",
      "move-folder:spawn",
      "new-folder",
    ]);
    expect(items[0]?.children?.some((child) => child.checked)).toBe(false);
  });

  it("checks the current folder and offers the way back out", () => {
    const move = folderItems(stateFor("chat")).find((item) => item.id === "move-folder");
    expect(move?.children?.find((child) => child.id === "move-folder:spawn")).toMatchObject({
      checked: true,
      disabled: true,
    });
    expect(move?.children?.some((child) => child.id === "remove-folder")).toBe(true);
  });

  it("does not offer removal for Work that sits in its repository's folder", () => {
    const items = folderItems(stateFor("work", { folder: { ...base, removable: false } }));
    expect(ids(items)).not.toContain("remove-folder");
    expect(ids(items)).toContain("move-folder:bartr");
  });

  it("disables moves without permission but still opens the folder", () => {
    const items = folderItems(stateFor("chat", { folder: { ...base, canMove: false } }));
    const move = items.find((item) => item.id === "move-folder");
    expect(
      move?.children
        ?.filter((child) => child.id.startsWith("move-folder:") || child.id === "remove-folder")
        .every((c) => c.disabled),
    ).toBe(true);
    const readOnly = folderItems(stateFor("chat", { canOperate: false }))[0];
    // The submenu stays reachable for its local actions; only the moves lock.
    expect(readOnly?.disabled).toBeUndefined();
    expect(
      readOnly?.children?.find((child) => child.id === "open-project:env:spawn")?.disabled,
    ).toBeUndefined();
    expect(readOnly?.children?.find((child) => child.id === "remove-folder")?.disabled).toBe(true);
  });

  it("names the submenu for what picking does: a chat with turns forks", () => {
    expect(folderItems(stateFor("chat"))[0]?.label).toBe("Move to Folder");
    expect(folderItems(stateFor("chat", { folder: { ...base, forks: true } }))[0]?.label).toBe(
      "Fork into Project",
    );
  });

  it("leaves folders off agent conversations", () => {
    expect(folderItems(stateFor("agentConversation"))).toEqual([]);
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

describe("Resume at reset in the thread action menu", () => {
  const limitIds = (menuState: ThreadActionMenuState) =>
    ids(buildThreadActionMenuItems(menuState)).filter((id) => id.startsWith("limit-resume"));

  it("offers the way out of a scheduled resume and the way back in", () => {
    expect(limitIds(stateFor("work", { limitResume: "scheduled" }))).toEqual(["limit-resume:off"]);
    expect(limitIds(stateFor("work", { limitResume: "cancelled" }))).toEqual(["limit-resume:on"]);
  });

  it("is absent when the thread has no usage-limit reset ahead", () => {
    expect(limitIds(stateFor("work"))).toEqual([]);
    expect(limitIds(stateFor("work", { limitResume: null }))).toEqual([]);
  });
});

describe("buildDraftActionMenuItems", () => {
  it("gives a chat draft only Discard, with nothing to copy", () => {
    expect(ids(buildDraftActionMenuItems({ hasPath: false, hasBranch: false }))).toEqual([
      "discard",
    ]);
  });

  it("gives a repository draft its copy items", () => {
    expect(ids(buildDraftActionMenuItems({ hasPath: true, hasBranch: true }))).toEqual([
      "copy",
      "copy-path",
      "copy-branch",
      "discard",
    ]);
  });
});

describe("buildRepositoryActionMenuItems", () => {
  it("offers a new thread and the repository's settings, and its folder when filed", () => {
    expect(ids(buildRepositoryActionMenuItems({ folder: null }))).toEqual([
      "new-thread",
      "project-settings",
    ]);
    expect(
      buildRepositoryActionMenuItems({ folder: { key: "env:spawn", name: "Spawn" } }).map(
        (item) => item.label,
      ),
    ).toEqual(["New Thread", "Open Spawn", "Repository Settings"]);
  });
});

describe("Move to folder options", () => {
  it("lead each project with its folder in the project's color", () => {
    const move = buildThreadActionMenuItems(stateFor("chat")).find(
      (item) => item.id === "move-folder",
    );
    expect(
      move?.children
        ?.filter((item) => item.id.startsWith("move-folder:"))
        .map((item) => [item.icon, item.iconColor, item.checked]),
    ).toEqual([
      ["folder", "var(--color-gray-500)", false],
      ["folder", "var(--color-violet-500)", true],
    ]);
  });
});

describe("Move to Machine", () => {
  const vps = { environmentId: "vps", name: "VPS", online: true };
  const mini = { environmentId: "mini", name: "Mac mini", online: false };

  it("is absent on a standalone machine", () => {
    expect(ids(buildThreadActionMenuItems(stateFor("chat")))).not.toContain("move-machine");
    expect(machineMenuItems({ targets: [], canMove: true })).toEqual([]);
  });

  it("names the one paired machine directly, with a bulk count", () => {
    expect(
      machineMenuItems({ targets: [vps], canMove: true }, " (3)").map((item) => [
        item.id,
        item.label,
        item.disabled,
      ]),
    ).toEqual([["move-machine:vps", "Move to VPS (3)", false]]);
  });

  it("lists several machines in a submenu, offline ones disabled", () => {
    const [submenu] = machineMenuItems({ targets: [mini, vps], canMove: true });
    expect(submenu?.id).toBe("move-machine");
    expect(submenu?.children?.map((item) => [item.label, item.disabled])).toEqual([
      ["Mac mini (Offline)", true],
      ["VPS", false],
    ]);
  });

  it("stays disabled for a client without the move permission", () => {
    const items = buildThreadActionMenuItems(
      stateFor("work", { machines: { targets: [vps], canMove: false } }),
    );
    expect(items.find((item) => item.id === "move-machine:vps")?.disabled).toBe(true);
  });
});
