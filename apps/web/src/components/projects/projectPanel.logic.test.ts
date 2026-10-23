import { describe, expect, it } from "vite-plus/test";

import { latestProjectActivity, projectPanelSummary, sortRecentFirst } from "./projectPanel.logic";

describe("projectPanelSummary", () => {
  it("names repos, chats, Work and files, each only when there are some", () => {
    expect(projectPanelSummary({ repositories: 1, chats: 1, work: 3, files: 2 })).toBe(
      "1 repo · 1 chat · 3 Work · 2 files",
    );
    expect(projectPanelSummary({ repositories: 2, chats: 0, work: 1, files: 0 })).toBe(
      "2 repos · 1 Work",
    );
    expect(projectPanelSummary({ repositories: 0, chats: 4, work: 0, files: 1 })).toBe(
      "4 chats · 1 file",
    );
    expect(projectPanelSummary({ repositories: 0, chats: 2, work: 1, files: 0, agents: 1 })).toBe(
      "2 chats · 1 Work · 1 agent",
    );
    expect(projectPanelSummary({ repositories: 0, chats: 0, work: 0, files: 0, agents: 3 })).toBe(
      "3 agents",
    );
  });

  it("is null for an empty folder", () => {
    expect(projectPanelSummary({ repositories: 0, chats: 0, work: 0, files: 0 })).toBeNull();
  });
});

const at = (iso: string) => ({ at: iso });
const activityAt = (thread: { at: string }) => thread.at;

describe("latestProjectActivity", () => {
  it("picks the newest time across chats and Work regardless of order", () => {
    const contents = {
      chats: [at("2026-10-01T00:00:00Z"), at("2026-10-03T00:00:00Z")],
      work: [at("2026-10-02T00:00:00Z")],
    };
    expect(latestProjectActivity(contents, activityAt)).toBe("2026-10-03T00:00:00Z");
    expect(
      latestProjectActivity({ chats: [], work: [at("2026-10-05T00:00:00Z")] }, activityAt),
    ).toBe("2026-10-05T00:00:00Z");
  });

  it("is null with nothing filed or no contents", () => {
    expect(latestProjectActivity({ chats: [], work: [] }, activityAt)).toBeNull();
    expect(latestProjectActivity(undefined, activityAt)).toBeNull();
  });

  it("skips times it cannot parse", () => {
    expect(
      latestProjectActivity(
        { chats: [at("nope"), at("2026-10-01T00:00:00Z")], work: [] },
        activityAt,
      ),
    ).toBe("2026-10-01T00:00:00Z");
  });
});

describe("sortRecentFirst", () => {
  it("orders newest first and keeps ties in input order", () => {
    const a = { id: "a", at: "2026-10-01T00:00:00Z" };
    const b = { id: "b", at: "2026-10-03T00:00:00Z" };
    const c = { id: "c", at: "2026-10-03T00:00:00Z" };
    expect(sortRecentFirst([a, b, c], activityAt).map((thread) => thread.id)).toEqual([
      "b",
      "c",
      "a",
    ]);
  });
});
