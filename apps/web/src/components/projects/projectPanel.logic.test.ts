import { describe, expect, it } from "vite-plus/test";

import { latestProjectActivity, projectPanelSummary, sortRecentFirst } from "./projectPanel.logic";

describe("projectPanelSummary", () => {
  it("names what the folder holds, counting Work with chats", () => {
    expect(projectPanelSummary({ repositories: 1, chats: 3, work: 1, files: 2 })).toBe(
      "1 repo · 4 chats · 2 files",
    );
  });

  it("leaves out what it has none of, with singular forms", () => {
    expect(projectPanelSummary({ repositories: 2, chats: 0, work: 1, files: 0 })).toBe(
      "2 repos · 1 chat",
    );
    expect(projectPanelSummary({ repositories: 0, chats: 0, work: 0, files: 1 })).toBe("1 file");
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
