import { ProjectLabelId } from "@cogenly/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  hasProjectNamed,
  orderProjectsByUse,
  projectLastUsedAt,
  rankProjectMatches,
  sameProjectLastUsedAt,
} from "./projectOrder.logic";

const id = (value: string) => ProjectLabelId.make(value);
const project = (name: string) => ({ label: { id: id(name.toLowerCase()), name } });
const names = (entries: ReadonlyArray<{ readonly label: { readonly name: string } }>) =>
  entries.map((entry) => entry.label.name);

function thread(
  folder: string | null,
  at: { authored?: string | null; user?: string | null; created?: string; deleted?: string },
) {
  return {
    source: { projectFolderId: folder === null ? null : id(folder) },
    createdAt: at.created ?? "2026-01-01T00:00:00.000Z",
    latestUserMessageAt: at.user ?? null,
    ...(at.authored === undefined ? {} : { latestUserAuthoredMessageAt: at.authored }),
    deletedAt: at.deleted ?? null,
  };
}

describe("projectLastUsedAt", () => {
  it("keeps each project's latest user message across its threads", () => {
    const lastUsed = projectLastUsedAt([
      thread("bartr", { authored: "2026-10-01T00:00:00.000Z" }),
      thread("bartr", { authored: "2026-10-05T00:00:00.000Z" }),
      thread("spawn", { user: "2026-10-03T00:00:00.000Z" }),
    ]);
    expect(lastUsed.get(id("bartr"))).toBe("2026-10-05T00:00:00.000Z");
    expect(lastUsed.get(id("spawn"))).toBe("2026-10-03T00:00:00.000Z");
  });

  it("prefers the message the user wrote over the latest user-role message", () => {
    const lastUsed = projectLastUsedAt([
      thread("bartr", {
        authored: "2026-10-01T00:00:00.000Z",
        user: "2026-10-09T00:00:00.000Z",
      }),
    ]);
    expect(lastUsed.get(id("bartr"))).toBe("2026-10-01T00:00:00.000Z");
  });

  it("falls back to when an unwritten thread started, and skips unfiled and deleted threads", () => {
    const lastUsed = projectLastUsedAt([
      thread("bartr", { created: "2026-10-02T00:00:00.000Z" }),
      thread(null, { authored: "2026-10-09T00:00:00.000Z" }),
      thread("spawn", {
        authored: "2026-10-09T00:00:00.000Z",
        deleted: "2026-10-10T00:00:00.000Z",
      }),
    ]);
    expect([...lastUsed]).toEqual([[id("bartr"), "2026-10-02T00:00:00.000Z"]]);
  });
});

describe("orderProjectsByUse", () => {
  const projects = [
    project("Spawn Partners"),
    project("bartr"),
    project("GreekUGC"),
    project("CMSC 20300 HCI"),
    project("SOSC 14100 Mind"),
  ];

  it("leads with recently used projects, newest first, then the rest by name", () => {
    const { recent, rest } = orderProjectsByUse(
      projects,
      new Map([
        [id("greekugc"), "2026-10-01T00:00:00.000Z"],
        [id("sosc 14100 mind"), "2026-10-20T00:00:00.000Z"],
      ]),
    );
    expect(names(recent)).toEqual(["SOSC 14100 Mind", "GreekUGC"]);
    expect(names(rest)).toEqual(["bartr", "CMSC 20300 HCI", "Spawn Partners"]);
  });

  it("caps the recent group, sending older projects back to their place by name", () => {
    const lastUsed = new Map(
      projects.map((entry, index) => [entry.label.id, `2026-10-0${index + 1}T00:00:00.000Z`]),
    );
    const { recent, rest } = orderProjectsByUse(projects, lastUsed, 2);
    expect(names(recent)).toEqual(["SOSC 14100 Mind", "CMSC 20300 HCI"]);
    expect(names(rest)).toEqual(["bartr", "GreekUGC", "Spawn Partners"]);
  });

  it("is alphabetical with no activity, and ignores activity in projects not offered", () => {
    const { recent, rest } = orderProjectsByUse(
      projects,
      new Map([[id("archived"), "2026-10-20T00:00:00.000Z"]]),
    );
    expect(recent).toEqual([]);
    expect(names(rest)).toEqual([
      "bartr",
      "CMSC 20300 HCI",
      "GreekUGC",
      "SOSC 14100 Mind",
      "Spawn Partners",
    ]);
  });
});

describe("rankProjectMatches", () => {
  // Already in picker order: recent first.
  const ordered = [
    project("SOSC 14100 Mind"),
    project("Spawn Partners"),
    project("bartr"),
    project("Mindful"),
    project("Admin"),
  ];

  it("ranks names starting with the query, then a word starting with it, then any match", () => {
    expect(names(rankProjectMatches(ordered, "min"))).toEqual([
      "Mindful",
      "SOSC 14100 Mind",
      "Admin",
    ]);
  });

  it("keeps the given order within a tier, ignoring case and surrounding space", () => {
    expect(names(rankProjectMatches(ordered, "  S "))).toEqual([
      "SOSC 14100 Mind",
      "Spawn Partners",
    ]);
    expect(names(rankProjectMatches(ordered, "A"))).toEqual(["Admin", "Spawn Partners", "bartr"]);
  });

  it("returns everything for an empty query and nothing for no match", () => {
    expect(names(rankProjectMatches(ordered, " "))).toEqual(names(ordered));
    expect(rankProjectMatches(ordered, "zebra")).toEqual([]);
  });
});

describe("hasProjectNamed", () => {
  it("matches a whole name regardless of case, so create is offered only for a new name", () => {
    expect(hasProjectNamed([project("Bartr")], " bartr ")).toBe(true);
    expect(hasProjectNamed([project("Bartr")], "bart")).toBe(false);
  });
});

describe("sameProjectLastUsedAt", () => {
  it("compares projects and times, not identity", () => {
    const at = "2026-10-01T00:00:00.000Z";
    expect(sameProjectLastUsedAt(new Map([[id("a"), at]]), new Map([[id("a"), at]]))).toBe(true);
    expect(
      sameProjectLastUsedAt(
        new Map([[id("a"), at]]),
        new Map([[id("a"), "2026-10-02T00:00:00.000Z"]]),
      ),
    ).toBe(false);
    expect(sameProjectLastUsedAt(new Map([[id("a"), at]]), new Map())).toBe(false);
  });
});
