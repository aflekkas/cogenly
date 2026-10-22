import type {
  T3ImportPhase,
  T3ImportProgress,
  T3ImportProviderBinding,
  T3ImportReport,
  T3ImportResult,
  T3ImportScope,
  T3ImportSkippedEvent,
  T3ImportSource,
  T3ImportSourceProject,
  T3ImportStatus,
} from "@t3tools/contracts";

/**
 * The server may also report where the pre-import backup goes. The contract
 * does not carry it yet, so the page reads it when present and otherwise
 * names the folder in words.
 */
/** The source info; `backupDirectory` is part of the contract now. */
export type T3ImportSourceWithBackup = T3ImportSource;

/** The screen the import page shows, derived from the server's job and the local selection. */
export type T3ImportView =
  | { readonly kind: "loading" }
  | { readonly kind: "unavailable"; readonly message: string }
  | { readonly kind: "intro" }
  | { readonly kind: "scanning"; readonly percent: number | null }
  | { readonly kind: "report"; readonly report: T3ImportReport; readonly stale: boolean }
  | {
      readonly kind: "importing";
      readonly report: T3ImportReport;
      readonly progress: T3ImportProgress;
      readonly percent: number;
      readonly backupPath: string | null;
    }
  | { readonly kind: "done"; readonly result: T3ImportResult }
  | {
      readonly kind: "cancelled";
      readonly backupPath: string | null;
      readonly writtenEvents: number;
    }
  | { readonly kind: "failed"; readonly message: string; readonly backupPath: string | null };

export interface T3ImportViewState {
  readonly view: T3ImportView;
  /**
   * T3 Code is running, so checking and importing wait until it quits. An
   * import already under way keeps going: the server read its snapshot first.
   */
  readonly blocked: boolean;
}

/** T3 projects ticked when the page opens: the server's defaults, never Scratch. */
export function defaultT3ImportSelection(
  projects: ReadonlyArray<T3ImportSourceProject>,
): ReadonlySet<string> {
  return new Set(
    projects
      .filter((project) => project.selectedByDefault && !project.isScratch)
      .map((project) => project.sourceProjectId),
  );
}

/** An empty scope means the server's default selection. */
function resolveScope(
  scope: T3ImportScope,
  projects: ReadonlyArray<T3ImportSourceProject>,
): ReadonlySet<string> {
  return scope.sourceProjectIds.length === 0
    ? defaultT3ImportSelection(projects)
    : new Set(scope.sourceProjectIds);
}

/**
 * The selection the page starts from: the scope of a check already on the
 * server (so returning to the page keeps its report), else the defaults.
 */
export function initialT3ImportSelection(status: T3ImportStatus): ReadonlySet<string> {
  const { job, source } = status;
  const report =
    job._tag === "Scanned" || job._tag === "Importing"
      ? job.report
      : job._tag === "Completed"
        ? job.result.report
        : null;
  return report
    ? resolveScope(report.scope, source.projects)
    : defaultT3ImportSelection(source.projects);
}

/** A report covers other projects than the ones ticked now, so importing it would surprise. */
export function isT3ImportReportStale(
  report: T3ImportReport,
  selection: ReadonlySet<string>,
  projects: ReadonlyArray<T3ImportSourceProject>,
): boolean {
  const scoped = resolveScope(report.scope, projects);
  if (scoped.size !== selection.size) return true;
  for (const id of selection) if (!scoped.has(id)) return true;
  return false;
}

/** Share of the bar each phase owns. Events dominate a real import, so they get most of it. */
const PHASE_SPANS: Readonly<Record<T3ImportPhase, readonly [start: number, end: number]>> = {
  reading: [0, 5],
  backup: [5, 10],
  projects: [10, 12],
  settings: [12, 14],
  events: [14, 95],
  attachments: [95, 100],
};

/**
 * Overall percent for an import: each phase fills its span, and the events
 * phase advances with the events written. Never 100 until the job completes.
 */
export function t3ImportProgressPercent(progress: T3ImportProgress): number {
  const [start, end] = PHASE_SPANS[progress.phase];
  const fraction =
    progress.totalEvents > 0
      ? Math.min(1, progress.processedEvents / progress.totalEvents)
      : progress.phase === "events"
        ? 1
        : 0;
  return Math.min(99, start + (end - start) * fraction);
}

/** A scan only has a meaningful fraction while it decodes events. */
export function t3ScanProgressPercent(progress: T3ImportProgress): number | null {
  if (progress.totalEvents <= 0) return null;
  return Math.min(99, (progress.processedEvents / progress.totalEvents) * 100);
}

export const T3_IMPORT_PHASE_LABELS: Readonly<Record<T3ImportPhase, string>> = {
  reading: "Reading T3 Code's data",
  backup: "Backing up Cogenly",
  projects: "Setting up projects",
  settings: "Applying settings",
  events: "Importing history",
  attachments: "Copying attachments",
};

export function deriveT3ImportView(
  status: T3ImportStatus | null,
  selection: ReadonlySet<string>,
): T3ImportViewState {
  if (status === null) return { view: { kind: "loading" }, blocked: false };
  const { source, job } = status;
  const blocked = source.available && source.running;
  switch (job._tag) {
    case "Scanning":
      return {
        view: { kind: "scanning", percent: t3ScanProgressPercent(job.progress) },
        blocked: false,
      };
    case "Importing":
      return {
        view: {
          kind: "importing",
          report: job.report,
          progress: job.progress,
          percent: t3ImportProgressPercent(job.progress),
          backupPath: job.backupPath,
        },
        blocked: false,
      };
    case "Completed":
      // People reopen T3 Code after importing; the summary shouldn't nag them to quit it.
      return { view: { kind: "done", result: job.result }, blocked: false };
    case "Cancelled":
      return {
        view: { kind: "cancelled", backupPath: job.backupPath, writtenEvents: job.writtenEvents },
        blocked,
      };
    case "Failed":
      return {
        view: { kind: "failed", message: job.message, backupPath: job.backupPath },
        blocked,
      };
    case "Scanned":
      return {
        view: {
          kind: "report",
          report: job.report,
          stale: isT3ImportReportStale(job.report, selection, source.projects),
        },
        blocked,
      };
    case "Idle":
      if (!source.available) {
        return {
          view: {
            kind: "unavailable",
            message: source.error ?? "No T3 Code data was found on this machine.",
          },
          blocked: false,
        };
      }
      return { view: { kind: "intro" }, blocked };
  }
}

type T3ImportErrorReason = "busy" | "source-unavailable" | "source-running" | "stale-report";

const ERROR_MESSAGES: Readonly<Record<T3ImportErrorReason, string>> = {
  busy: "Another check or import is already running. Wait for it to finish.",
  "source-unavailable": "T3 Code's data couldn't be read.",
  "source-running": "Quit T3 Code to continue.",
  "stale-report": "T3 Code's data changed since the check. Check again before importing.",
};

function isT3ImportErrorReason(value: unknown): value is T3ImportErrorReason {
  return typeof value === "string" && value in ERROR_MESSAGES;
}

/** A plain sentence for a failed scan or run request, with the server's detail where it helps. */
export function describeT3ImportFailure(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const candidate = error as { _tag?: unknown; reason?: unknown; detail?: unknown };
    if (candidate._tag === "T3ImportError" && isT3ImportErrorReason(candidate.reason)) {
      const base = ERROR_MESSAGES[candidate.reason];
      return candidate.reason === "source-unavailable" && typeof candidate.detail === "string"
        ? `${base} ${candidate.detail}`
        : base;
    }
    if (error instanceof Error && error.message.length > 0) return error.message;
  }
  return "The request failed. Try again.";
}

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count.toLocaleString()} ${count === 1 ? singular : plural}`;
}

export const T3_PROVIDER_STATUS_LABELS: Readonly<
  Record<T3ImportProviderBinding["status"], string>
> = {
  builtin: "Built in",
  create: "Will be added",
  exists: "Already set up",
  conflict: "Set up differently here; resuming may not find its sessions",
};

export interface T3ImportReportSummary {
  readonly threads: number;
  readonly subagentThreads: number;
  readonly forkThreads: number;
  readonly newProjects: number;
  readonly mergedProjects: number;
  /** Threads already imported and unchanged; a re-run leaves them alone. */
  readonly upToDateThreads: number;
  readonly updatedThreads: number;
  readonly divergedThreads: number;
  /** Nothing new to write: every thread was imported before and is unchanged. */
  readonly nothingToImport: boolean;
}

export function summarizeT3ImportReport(report: T3ImportReport): T3ImportReportSummary {
  let subagentThreads = 0;
  let forkThreads = 0;
  let newProjects = 0;
  let mergedProjects = 0;
  let upToDateThreads = 0;
  let updatedThreads = 0;
  let divergedThreads = 0;
  for (const project of report.projects) {
    subagentThreads += project.subagentThreads;
    forkThreads += project.forkThreads;
    upToDateThreads += project.upToDateThreads;
    updatedThreads += project.updatedThreads;
    divergedThreads += project.divergedThreads;
    if (project.action === "create") newProjects += 1;
    else mergedProjects += 1;
  }
  return {
    threads: report.totals.threads,
    subagentThreads,
    forkThreads,
    newProjects,
    mergedProjects,
    upToDateThreads,
    updatedThreads,
    divergedThreads,
    nothingToImport: report.totals.newEvents === 0,
  };
}

export interface T3SkippedListing {
  /** One line per skipped event shown: the thread id, and the event's position when known. */
  readonly rows: ReadonlyArray<{ readonly key: string; readonly label: string }>;
  /** Skipped events the report counted but did not list. */
  readonly hidden: number;
}

/** Skipped events by id only; their payloads may hold private chat text. */
export function listT3SkippedEvents(
  skipped: ReadonlyArray<T3ImportSkippedEvent>,
  total: number,
): T3SkippedListing {
  const rows = skipped.map((event, index) => ({
    key: `${event.threadId}:${event.sequence ?? "thread"}:${index}`,
    label: event.sequence === undefined ? event.threadId : `${event.threadId} · #${event.sequence}`,
  }));
  return { rows, hidden: Math.max(0, total - skipped.length) };
}
