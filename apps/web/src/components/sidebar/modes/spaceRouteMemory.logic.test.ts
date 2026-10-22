import { describe, expect, it } from "vite-plus/test";

import {
  forgetSpaceRoute,
  parseStoredSpaceRouteMemory,
  rememberSpaceRoute,
  resolveSpaceReturn,
  spaceOfRoute,
  spaceRouteForMatch,
  type SpaceRoute,
  type SpaceRouteMemory,
} from "./spaceRouteMemory.logic";

const workThread: SpaceRoute = { kind: "thread", environmentId: "env-1", threadId: "work-1" };
const chatThread: SpaceRoute = { kind: "thread", environmentId: "env-1", threadId: "chat-1" };

/** Walks a sequence of settled pages the way the tracker records them. */
function visit(
  memory: SpaceRouteMemory,
  pages: ReadonlyArray<{ href: string; route: SpaceRoute; mode?: "chats" | "tasks" | "agents" }>,
): SpaceRouteMemory {
  return pages.reduce((current, page) => {
    const space = spaceOfRoute(page.route, page.mode ?? null);
    return space === null
      ? current
      : rememberSpaceRoute(current, space, { href: page.href, route: page.route });
  }, memory);
}

const always = () => "available" as const;

describe("spaceRouteForMatch", () => {
  it("reads the pages a space owns from the leaf route", () => {
    expect(
      spaceRouteForMatch({
        routeId: "/_chat/$environmentId/$threadId",
        params: { environmentId: "env-1", threadId: "work-1" },
      }),
    ).toEqual(workThread);
    expect(
      spaceRouteForMatch({ routeId: "/_chat/draft/$draftId", params: { draftId: "d1" } }),
    ).toEqual({ kind: "draft", draftId: "d1" });
    expect(
      spaceRouteForMatch({
        routeId: "/_chat/project/$environmentId/$labelId",
        params: { environmentId: "env-1", labelId: "l1" },
      }),
    ).toEqual({ kind: "project", environmentId: "env-1", labelId: "l1" });
    expect(spaceRouteForMatch({ routeId: "/settings/keybindings", params: {} })).toEqual({
      kind: "settings",
    });
  });

  it("leaves the index, Usage and legacy links to no space", () => {
    for (const routeId of ["/_chat/", "/usage", "/projects/$projectKey", "/welcome"]) {
      expect(spaceRouteForMatch({ routeId, params: { projectKey: "x" } })).toBeNull();
    }
  });
});

describe("space route memory", () => {
  it("returns each space to the page it last showed", () => {
    const memory = visit({}, [
      { href: "/env-1/work-1", route: workThread, mode: "tasks" },
      { href: "/env-1/chat-1", route: chatThread, mode: "chats" },
      { href: "/settings/appearance", route: { kind: "settings" } },
      {
        href: "/project/env-1/l1",
        route: { kind: "project", environmentId: "env-1", labelId: "l1" },
      },
    ]);
    expect(resolveSpaceReturn(memory, "tasks", always)).toBe("/env-1/work-1");
    expect(resolveSpaceReturn(memory, "chats", always)).toBe("/env-1/chat-1");
    expect(resolveSpaceReturn(memory, "settings", always)).toBe("/settings/appearance");
    expect(resolveSpaceReturn(memory, "projects", always)).toBe("/project/env-1/l1");
    expect(resolveSpaceReturn(memory, "agents", always)).toBeNull();
  });

  it("keeps the newest page per space and the search it was on", () => {
    const memory = visit({}, [
      { href: "/env-1/work-1", route: workThread, mode: "tasks" },
      {
        href: "/env-1/work-2?panel=diff",
        route: { kind: "thread", environmentId: "env-1", threadId: "work-2" },
        mode: "tasks",
      },
    ]);
    expect(resolveSpaceReturn(memory, "tasks", always)).toBe("/env-1/work-2?panel=diff");
  });

  it("does not record a thread whose mode is not known yet", () => {
    expect(visit({}, [{ href: "/env-1/work-1", route: workThread }])).toEqual({});
  });

  it("falls back to landing when the remembered page is gone", () => {
    const memory = visit({}, [{ href: "/env-1/work-1", route: workThread, mode: "tasks" }]);
    expect(resolveSpaceReturn(memory, "tasks", () => "gone")).toBeNull();
    // Still loading: return there and let the page show its own loading state.
    expect(resolveSpaceReturn(memory, "tasks", () => "unknown")).toBe("/env-1/work-1");
    expect(resolveSpaceReturn(forgetSpaceRoute(memory, "tasks"), "tasks", always)).toBeNull();
  });

  it("checks availability against the space being returned to", () => {
    const memory = visit({}, [{ href: "/env-1/work-1", route: workThread, mode: "tasks" }]);
    // A thread that now belongs to another mode (say it became an agent's) is gone for Work.
    expect(
      resolveSpaceReturn(memory, "tasks", (_route, space) =>
        space === "agents" ? "available" : "gone",
      ),
    ).toBeNull();
  });

  it("never sends a space to a page another space owns", () => {
    const stored = parseStoredSpaceRouteMemory({
      projects: { href: "/settings/general", route: { kind: "settings" } },
    });
    expect(resolveSpaceReturn(stored, "projects", always)).toBeNull();
  });
});

describe("parseStoredSpaceRouteMemory", () => {
  it("round-trips what it stores", () => {
    const memory = visit({}, [
      { href: "/env-1/chat-1", route: chatThread, mode: "chats" },
      { href: "/project", route: { kind: "projects-overview" } },
    ]);
    expect(parseStoredSpaceRouteMemory(JSON.parse(JSON.stringify(memory)))).toEqual(memory);
  });

  it("drops malformed entries and hrefs that leave the app", () => {
    expect(
      parseStoredSpaceRouteMemory({
        chats: { href: "//evil.example/x", route: chatThread },
        tasks: { href: "https://evil.example", route: workThread },
        agents: { href: "/agents/new", route: { kind: "nope" } },
        nonsense: { href: "/x", route: { kind: "settings" } },
        settings: { href: "/settings/data", route: { kind: "settings" } },
      }),
    ).toEqual({ settings: { href: "/settings/data", route: { kind: "settings" } } });
    expect(parseStoredSpaceRouteMemory("garbage")).toEqual({});
  });
});
