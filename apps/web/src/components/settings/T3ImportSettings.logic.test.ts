import { describe, expect, it } from "vite-plus/test";
import type {
  ProjectId,
  T3ImportJob,
  T3ImportReport,
  T3ImportSource,
  T3ImportSourceProject,
  T3ImportStatus,
} from "@cogenly/contracts";

import {
  defaultT3ImportSelection,
  deriveT3ImportView,
  describeT3ImportFailure,
  initialT3ImportSelection,
  isT3ImportReportStale,
  listT3SkippedEvents,
  summarizeT3ImportReport,
  t3ImportProgressPercent,
  t3ScanProgressPercent,
} from "./T3ImportSettings.logic";

function project(id: string, overrides: Partial<T3ImportSourceProject> = {}) {
  return {
    sourceProjectId: id,
    title: id,
    workspaceRoot: `/Users/me/${id}`,
    threadCount: 3,
    rootThreadCount: 2,
    existingProjectId: null,
    existingProjectTitle: null,
    isScratch: false,
    selectedByDefault: true,
    ...overrides,
  } satisfies T3ImportSourceProject;
}

const PROJECTS = [
  project("spawn-platform"),
  project("greekugc"),
  project("cogenly"),
  project("scratch", { isScratch: true, selectedByDefault: false }),
];

function source(overrides: Partial<T3ImportSource> = {}): T3ImportSource {
  return {
    available: true,
    databasePath: "/Users/me/.t3/userdata/statev2.sqlite",
    running: false,
    projects: PROJECTS,
    ...overrides,
  };
}

function report(
  sourceProjectIds: string[],
  overrides: Partial<T3ImportReport> = {},
): T3ImportReport {
  return {
    reportId: "report-1",
    generatedAt: "2026-10-22T12:00:00.000Z",
    scope: { sourceProjectIds },
    projects: [],
    totals: {
      threads: 10,
      messages: 200,
      events: 1_000,
      newEvents: 1_000,
      attachments: 4,
      attachmentBytes: 2_048,
      skippedEvents: 0,
      normalizedEvents: 0,
    },
    skipped: [],
    providers: [],
    settings: [],
    warnings: [],
    ...overrides,
  };
}

function status(job: T3ImportJob, sourceOverrides: Partial<T3ImportSource> = {}): T3ImportStatus {
  return { source: source(sourceOverrides), job };
}

const DEFAULTS = new Set(["spawn-platform", "greekugc", "cogenly"]);

describe("T3ImportSettings.logic", () => {
  it("selects the server's defaults and never Scratch", () => {
    const projects = [...PROJECTS, project("odd-scratch", { isScratch: true })];
    expect(defaultT3ImportSelection(projects)).toEqual(DEFAULTS);
  });

  it("starts from the scope of a check already on the server", () => {
    const scanned = status({ _tag: "Scanned", report: report(["greekugc"]) });
    expect(initialT3ImportSelection(scanned)).toEqual(new Set(["greekugc"]));
    const idle = status({ _tag: "Idle" });
    expect(initialT3ImportSelection(idle)).toEqual(DEFAULTS);
  });

  it("treats an empty report scope as the default selection", () => {
    expect(isT3ImportReportStale(report([]), DEFAULTS, PROJECTS)).toBe(false);
    expect(isT3ImportReportStale(report([]), new Set(["cogenly"]), PROJECTS)).toBe(true);
    expect(
      isT3ImportReportStale(
        report(["cogenly", "greekugc"]),
        new Set(["greekugc", "cogenly"]),
        PROJECTS,
      ),
    ).toBe(false);
  });

  it("is loading until the first status arrives", () => {
    expect(deriveT3ImportView(null, DEFAULTS)).toEqual({
      view: { kind: "loading" },
      t3Open: false,
    });
  });

  it("explains a missing T3 install with the server's reason", () => {
    const state = deriveT3ImportView(
      status({ _tag: "Idle" }, { available: false, error: "No database at ~/.t3" }),
      DEFAULTS,
    );
    expect(state.view).toEqual({ kind: "unavailable", message: "No database at ~/.t3" });
  });

  it("never waits for T3 Code to quit, only notes that it is open", () => {
    const running = { running: true };
    const intro = deriveT3ImportView(status({ _tag: "Idle" }, running), DEFAULTS);
    expect(intro).toEqual({ view: { kind: "intro" }, t3Open: true });
    expect(
      deriveT3ImportView(status({ _tag: "Scanned", report: report([]) }, running), DEFAULTS).t3Open,
    ).toBe(true);
    expect(
      deriveT3ImportView(
        status(
          {
            _tag: "Scanning",
            progress: { phase: "snapshot", processedEvents: 0, totalEvents: 0 },
          },
          running,
        ),
        DEFAULTS,
      ).view,
    ).toEqual({ kind: "scanning", percent: null, copying: true });
    const importing = deriveT3ImportView(
      status(
        {
          _tag: "Importing",
          report: report([]),
          progress: { phase: "events", processedEvents: 10, totalEvents: 100 },
          backupPath: "/backups/statev2.sqlite",
        },
        running,
      ),
      DEFAULTS,
    );
    expect(importing.t3Open).toBe(true);
    expect(importing.view.kind).toBe("importing");
  });

  it("shows a cancelled import with what it wrote, and a finished one without the note", () => {
    const cancelled = deriveT3ImportView(
      status({ _tag: "Cancelled", backupPath: "/backups/a.sqlite", writtenEvents: 42 }),
      DEFAULTS,
    );
    expect(cancelled.view).toEqual({
      kind: "cancelled",
      backupPath: "/backups/a.sqlite",
      writtenEvents: 42,
    });
    const result = {
      report: report([]),
      backupPath: "/backups/a.sqlite",
      importedThreads: 10,
      writtenEvents: 1_000,
      skippedEvents: 0,
      copiedAttachments: 4,
      completedAt: "2026-10-22T12:05:00.000Z",
    };
    const done = deriveT3ImportView(
      status({ _tag: "Completed", result }, { running: true }),
      DEFAULTS,
    );
    expect(done).toEqual({ view: { kind: "done", result }, t3Open: false });
  });

  it("marks a report stale once the selection changes", () => {
    const state = deriveT3ImportView(
      status({ _tag: "Scanned", report: report([]) }),
      new Set(["cogenly"]),
    );
    expect(state.view).toMatchObject({ kind: "report", stale: true });
  });

  it("fills each phase's span and holds below 100 until the job completes", () => {
    expect(t3ImportProgressPercent({ phase: "reading", processedEvents: 0, totalEvents: 0 })).toBe(
      0,
    );
    expect(t3ImportProgressPercent({ phase: "events", processedEvents: 0, totalEvents: 100 })).toBe(
      14,
    );
    expect(
      t3ImportProgressPercent({ phase: "events", processedEvents: 50, totalEvents: 100 }),
    ).toBe(54.5);
    expect(
      t3ImportProgressPercent({ phase: "attachments", processedEvents: 100, totalEvents: 100 }),
    ).toBe(99);
  });

  it("has no scan fraction until it knows the event total", () => {
    expect(
      t3ScanProgressPercent({ phase: "reading", processedEvents: 0, totalEvents: 0 }),
    ).toBeNull();
    expect(t3ScanProgressPercent({ phase: "events", processedEvents: 25, totalEvents: 100 })).toBe(
      25,
    );
  });

  it("follows the snapshot copy by bytes before any events are known", () => {
    const copying = { phase: "snapshot", processedEvents: 0, totalEvents: 0 } as const;
    expect(t3ScanProgressPercent(copying)).toBeNull();
    expect(
      t3ScanProgressPercent({ ...copying, copiedBytes: 3 * 1024 ** 3, totalBytes: 12 * 1024 ** 3 }),
    ).toBe(25);
  });

  it("words import errors by reason", () => {
    expect(
      describeT3ImportFailure({
        _tag: "T3ImportError",
        reason: "insufficient-space",
        detail: "Copying T3 Code's data needs 12.3 GB free in /tmp, but only 2.0 GB is free.",
      }),
    ).toBe(
      "There isn't enough free disk space to copy T3 Code's data. Copying T3 Code's data needs 12.3 GB free in /tmp, but only 2.0 GB is free.",
    );
    expect(
      describeT3ImportFailure({
        _tag: "T3ImportError",
        reason: "source-unavailable",
        detail: "Permission denied.",
      }),
    ).toBe("T3 Code's data couldn't be read. Permission denied.");
    expect(describeT3ImportFailure(new Error("Socket closed"))).toBe("Socket closed");
    expect(describeT3ImportFailure(undefined)).toBe("The request failed. Try again.");
  });

  it("totals project counts and notices a re-run with nothing new", () => {
    const projectReport = {
      sourceProjectId: "cogenly",
      title: "cogenly",
      workspaceRoot: "/Users/me/cogenly",
      action: "merge" as const,
      projectId: "project-1" as ProjectId,
      projectTitle: "Cogenly",
      threads: 4,
      rootThreads: 2,
      subagentThreads: 1,
      forkThreads: 1,
      messages: 40,
      events: 400,
      attachments: 0,
      attachmentBytes: 0,
      upToDateThreads: 4,
      updatedThreads: 0,
      divergedThreads: 0,
    };
    const summary = summarizeT3ImportReport(
      report([], {
        projects: [
          projectReport,
          { ...projectReport, sourceProjectId: "greekugc", action: "create" },
        ],
        totals: { ...report([]).totals, newEvents: 0 },
      }),
    );
    expect(summary).toMatchObject({
      subagentThreads: 2,
      forkThreads: 2,
      newProjects: 1,
      mergedProjects: 1,
      upToDateThreads: 8,
      nothingToImport: true,
    });
  });

  it("lists skipped events by id and counts the ones the report left out", () => {
    const listing = listT3SkippedEvents(
      [
        { threadId: "thread-a", sequence: 7, eventType: "message.updated", reason: "decode" },
        { threadId: "thread-b", reason: "missing project" },
      ],
      5,
    );
    expect(listing.rows.map((row) => row.label)).toEqual(["thread-a · #7", "thread-b"]);
    expect(listing.hidden).toBe(3);
  });
});
