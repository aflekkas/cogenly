import * as Schema from "effect/Schema";

import { NonNegativeInt, ProjectId } from "./baseSchemas.ts";

/**
 * Import from T3 Code: copies projects, threads (with their full event
 * history), attachments and a few settings from a local T3 Code install
 * (`~/.t3/userdata`) into this environment.
 *
 * RPCs (all need the settings write grant):
 * - `t3Import.status` (stream of `T3ImportStatus`): the source install
 *   (`source`: found?, T3 running?, unflushed WAL bytes, its projects with
 *   default selection and the Cogenly project each merges into) plus the
 *   server-side job (`job`: Idle | Scanning | Scanned | Importing | Completed |
 *   Cancelled | Failed, with progress). Jobs run on the server, so a reload resumes the
 *   view. `source.running` re-polls every few seconds while subscribed.
 * - `t3Import.scan` (`T3ImportScanInput`): starts a dry run for the selected
 *   T3 project ids. Writes nothing; the job ends as `Scanned` with a report.
 * - `t3Import.run` (`T3ImportRunInput`): imports what the given `reportId`
 *   described. Rejected (`T3ImportError`) while T3 is running, while another
 *   job runs, or when the report is not the latest scan. Backs up the database
 *   first (`Importing.backupPath`, then `Completed.result.backupPath`).
 * - `t3Import.cancel`: stops a running scan or import between batches. What was
 *   already written stays; re-running continues where it stopped.
 */

/** Which T3 projects to import, by their T3 project id. Empty means the default selection. */
export const T3ImportScope = Schema.Struct({
  sourceProjectIds: Schema.Array(Schema.String),
});
export type T3ImportScope = typeof T3ImportScope.Type;

export const T3ImportSourceProject = Schema.Struct({
  sourceProjectId: Schema.String,
  title: Schema.String,
  workspaceRoot: Schema.String,
  threadCount: NonNegativeInt,
  rootThreadCount: NonNegativeInt,
  /** The Cogenly project at the same folder, merged into instead of duplicated. */
  existingProjectId: Schema.NullOr(ProjectId),
  existingProjectTitle: Schema.NullOr(Schema.String),
  /** T3's scratch area: many one-off folders, so it is left out of the default selection. */
  isScratch: Schema.Boolean,
  selectedByDefault: Schema.Boolean,
});
export type T3ImportSourceProject = typeof T3ImportSourceProject.Type;

export const T3ImportSource = Schema.Struct({
  available: Schema.Boolean,
  databasePath: Schema.String,
  /** T3 Code's server is running; its database can change under the import. */
  running: Schema.Boolean,
  /** Bytes in T3's write-ahead log, which a read-only snapshot cannot include. */
  pendingWalBytes: NonNegativeInt,
  projects: Schema.Array(T3ImportSourceProject),
  /** Where the pre-import database backup is written, on the environment's machine. */
  backupDirectory: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
});
export type T3ImportSource = typeof T3ImportSource.Type;

export const T3ImportProjectReport = Schema.Struct({
  sourceProjectId: Schema.String,
  title: Schema.String,
  workspaceRoot: Schema.String,
  action: Schema.Literals(["merge", "create"]),
  projectId: ProjectId,
  projectTitle: Schema.String,
  threads: NonNegativeInt,
  rootThreads: NonNegativeInt,
  subagentThreads: NonNegativeInt,
  forkThreads: NonNegativeInt,
  messages: NonNegativeInt,
  events: NonNegativeInt,
  attachments: NonNegativeInt,
  attachmentBytes: NonNegativeInt,
  /** Threads already imported and unchanged in T3 since. */
  upToDateThreads: NonNegativeInt,
  /** Threads already imported that gained events in T3; only the new events are appended. */
  updatedThreads: NonNegativeInt,
  /** Threads continued in Cogenly after an earlier import; T3 changes are not applied. */
  divergedThreads: NonNegativeInt,
});
export type T3ImportProjectReport = typeof T3ImportProjectReport.Type;

export const T3ImportSkippedEvent = Schema.Struct({
  threadId: Schema.String,
  sequence: Schema.optional(NonNegativeInt),
  eventType: Schema.optional(Schema.String),
  reason: Schema.String,
});
export type T3ImportSkippedEvent = typeof T3ImportSkippedEvent.Type;

export const T3ImportProviderBinding = Schema.Struct({
  instanceId: Schema.String,
  driver: Schema.String,
  threads: NonNegativeInt,
  /**
   * builtin: Cogenly's own instance with this id. create: the import adds it
   * with T3's configuration. exists: already configured the same way.
   * conflict: configured differently; left alone, so resume may not find sessions.
   */
  status: Schema.Literals(["builtin", "create", "exists", "conflict"]),
  homePath: Schema.optional(Schema.String),
});
export type T3ImportProviderBinding = typeof T3ImportProviderBinding.Type;

export const T3ImportSettingChange = Schema.Struct({
  setting: Schema.String,
  action: Schema.Literals(["set", "add", "keep"]),
  detail: Schema.String,
});
export type T3ImportSettingChange = typeof T3ImportSettingChange.Type;

export const T3ImportTotals = Schema.Struct({
  threads: NonNegativeInt,
  messages: NonNegativeInt,
  events: NonNegativeInt,
  newEvents: NonNegativeInt,
  attachments: NonNegativeInt,
  attachmentBytes: NonNegativeInt,
  skippedEvents: NonNegativeInt,
  /** Runs, sessions, requests and items T3 left live (running, pending, ready), imported as stopped. */
  normalizedEvents: NonNegativeInt,
});
export type T3ImportTotals = typeof T3ImportTotals.Type;

export const T3ImportReport = Schema.Struct({
  reportId: Schema.String,
  generatedAt: Schema.String,
  scope: T3ImportScope,
  projects: Schema.Array(T3ImportProjectReport),
  totals: T3ImportTotals,
  /** The first skipped events, for display; `totals.skippedEvents` counts all of them. */
  skipped: Schema.Array(T3ImportSkippedEvent),
  providers: Schema.Array(T3ImportProviderBinding),
  settings: Schema.Array(T3ImportSettingChange),
  warnings: Schema.Array(Schema.String),
});
export type T3ImportReport = typeof T3ImportReport.Type;

export const T3ImportResult = Schema.Struct({
  report: T3ImportReport,
  backupPath: Schema.String,
  importedThreads: NonNegativeInt,
  writtenEvents: NonNegativeInt,
  skippedEvents: NonNegativeInt,
  copiedAttachments: NonNegativeInt,
  completedAt: Schema.String,
});
export type T3ImportResult = typeof T3ImportResult.Type;

export const T3ImportPhase = Schema.Literals([
  "reading",
  "backup",
  "projects",
  "settings",
  "events",
  "attachments",
]);
export type T3ImportPhase = typeof T3ImportPhase.Type;

export const T3ImportProgress = Schema.Struct({
  phase: T3ImportPhase,
  processedEvents: NonNegativeInt,
  totalEvents: NonNegativeInt,
});
export type T3ImportProgress = typeof T3ImportProgress.Type;

export const T3ImportJob = Schema.Union([
  Schema.TaggedStruct("Idle", {}),
  Schema.TaggedStruct("Scanning", { progress: T3ImportProgress }),
  Schema.TaggedStruct("Scanned", { report: T3ImportReport }),
  Schema.TaggedStruct("Importing", {
    report: T3ImportReport,
    progress: T3ImportProgress,
    backupPath: Schema.NullOr(Schema.String),
  }),
  Schema.TaggedStruct("Completed", { result: T3ImportResult }),
  /** Stopped by `t3Import.cancel`; what was written stays and a re-run continues it. */
  Schema.TaggedStruct("Cancelled", {
    backupPath: Schema.NullOr(Schema.String),
    writtenEvents: NonNegativeInt,
  }),
  Schema.TaggedStruct("Failed", {
    message: Schema.String,
    backupPath: Schema.NullOr(Schema.String),
  }),
]);
export type T3ImportJob = typeof T3ImportJob.Type;

export const T3ImportStatus = Schema.Struct({
  source: T3ImportSource,
  job: T3ImportJob,
});
export type T3ImportStatus = typeof T3ImportStatus.Type;

export const T3ImportScanInput = Schema.Struct({ scope: T3ImportScope });
export type T3ImportScanInput = typeof T3ImportScanInput.Type;

export const T3ImportRunInput = Schema.Struct({
  /** The scanned report the user confirmed; a different scope or a newer scan is rejected. */
  reportId: Schema.String,
  includeSettings: Schema.Boolean,
});
export type T3ImportRunInput = typeof T3ImportRunInput.Type;

export const T3ImportStarted = Schema.Struct({ started: Schema.Boolean });

export class T3ImportError extends Schema.TaggedError<T3ImportError>()("T3ImportError", {
  reason: Schema.Literals(["busy", "source-unavailable", "source-running", "stale-report"]),
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}
