import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ToolActivityIcon } from "./providerRuntime.ts";

/**
 * What a thread used and made, derived on request from its persisted messages,
 * tool calls, checkpoints and pull request links (never pushed on the thread
 * stream). Thread details and `thread_read` both show it.
 */

const Name = TrimmedNonEmptyString.check(Schema.isMaxLength(400));
const Path = TrimmedNonEmptyString.check(Schema.isMaxLength(2000));

const sourceFields = {
  /** Dedupe key: one row per integration, file, host, thread or vault item. */
  key: TrimmedNonEmptyString.check(Schema.isMaxLength(2200)),
  /** The latest use. */
  usedAt: IsoDateTime,
  uses: PositiveInt,
};

/** Where a file lives: the project folder, the thread's workspace, or a chat attachment. */
export const ThreadSourceFileLocation = Schema.Literals(["project", "workspace", "attachment"]);
export type ThreadSourceFileLocation = typeof ThreadSourceFileLocation.Type;

export const ThreadSource = Schema.Union([
  Schema.Struct({
    ...sourceFields,
    kind: Schema.Literal("integration"),
    /** The integration's name (`gmail`) or a third-party MCP server's key. */
    name: Name,
    /** Display name, when the call or mention carried one. */
    label: Schema.optional(Name),
    /** A third-party MCP server's own icon. */
    icon: Schema.optional(ToolActivityIcon),
  }),
  Schema.Struct({
    ...sourceFields,
    kind: Schema.Literal("file"),
    location: ThreadSourceFileLocation,
    name: Name,
    path: Schema.optional(Path),
    attachmentId: Schema.optional(Name),
    mimeType: Schema.optional(Name),
    sizeBytes: Schema.optional(NonNegativeInt),
    /** The project folder a project file was read from; absent for the thread's own. */
    projectLabelId: Schema.optional(Name),
  }),
  Schema.Struct({
    ...sourceFields,
    kind: Schema.Literal("project"),
    /** Absent for the thread's own project folder. */
    projectLabelId: Schema.optional(Name),
    label: Schema.optional(Name),
  }),
  Schema.Struct({ ...sourceFields, kind: Schema.Literal("memory") }),
  Schema.Struct({
    ...sourceFields,
    kind: Schema.Literal("vault"),
    /** The item's name only; never a secret or username. */
    name: Name,
    itemId: Schema.optional(Name),
    host: Schema.optional(Name),
  }),
  Schema.Struct({
    ...sourceFields,
    kind: Schema.Literal("page"),
    host: Name,
    /** The latest page visited on the host. */
    url: Path,
  }),
  Schema.Struct({
    ...sourceFields,
    kind: Schema.Literal("thread"),
    threadId: ThreadId,
    title: Schema.optional(Name),
  }),
]);
export type ThreadSource = typeof ThreadSource.Type;

const outputFields = {
  key: TrimmedNonEmptyString.check(Schema.isMaxLength(2200)),
  at: IsoDateTime,
};

export const ThreadOutput = Schema.Union([
  Schema.Struct({
    ...outputFields,
    kind: Schema.Literal("file"),
    location: Schema.Literals(["project", "workspace"]),
    name: Name,
    path: Schema.optional(Path),
    additions: Schema.optional(NonNegativeInt),
    deletions: Schema.optional(NonNegativeInt),
  }),
  Schema.Struct({
    ...outputFields,
    kind: Schema.Literal("page"),
    attachmentId: Name,
    title: Name,
  }),
  Schema.Struct({
    ...outputFields,
    kind: Schema.Literal("attachment"),
    attachmentId: Name,
    name: Name,
    mimeType: Name,
    sizeBytes: Schema.optional(NonNegativeInt),
  }),
  Schema.Struct({
    ...outputFields,
    kind: Schema.Literal("pull_request"),
    url: Path,
    repository: Name,
    number: PositiveInt,
    title: Schema.optional(Name),
  }),
  /** Every file a Work thread's checkpoints changed, as one diff. */
  Schema.Struct({
    ...outputFields,
    kind: Schema.Literal("changes"),
    fileCount: PositiveInt,
    additions: NonNegativeInt,
    deletions: NonNegativeInt,
  }),
]);
export type ThreadOutput = typeof ThreadOutput.Type;

/** Most recent first. Lists stop at a cap; the totals count every entry. */
export const ThreadSourcesResult = Schema.Struct({
  sources: Schema.Array(ThreadSource),
  outputs: Schema.Array(ThreadOutput),
  sourceTotal: NonNegativeInt,
  outputTotal: NonNegativeInt,
});
export type ThreadSourcesResult = typeof ThreadSourcesResult.Type;

export const ThreadSourcesInput = Schema.Struct({
  threadId: ThreadId,
  /** The thread revision the client last saw. Only keys the client cache. */
  revision: Schema.optional(Schema.String),
});
export type ThreadSourcesInput = typeof ThreadSourcesInput.Type;
