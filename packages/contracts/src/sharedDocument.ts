import * as Schema from "effect/Schema";
import { AuthSyncReplicateScope } from "./auth.ts";
import { EnvironmentId } from "./baseSchemas.ts";
import { MachineRelation, makePeerChannel } from "./machine.ts";

export const SHARED_BATCH_LIMIT = 32;
export const SHARED_BATCH_BYTES = 256 * 1024;
/** Canonical remote identity, also used to validate the normalizer's output. */
export const SharedRepositoryRemote = Schema.String.check(
  Schema.isPattern(
    /^[a-z0-9][a-z0-9.-]*\/(?:[a-zA-Z0-9_.~-]|%[a-fA-F0-9]{2})+(?:\/(?:[a-zA-Z0-9_.~-]|%[a-fA-F0-9]{2})+)*$/,
  ),
  Schema.makeFilter((value) => value.split("/").every((part) => part !== "." && part !== "..")),
);
const Counter = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
);
export const SharedDocumentId = Schema.String.check(
  Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,199}$/),
);
// v0.1.17 derived task IDs from URI-encoded MCP request keys. Keep their
// references and webhook URLs stable; new task IDs use bounded hashes.
const LegacyScheduleId = Schema.String.check(
  Schema.isPattern(/^scheduled-task:command:mcp:(?:[a-zA-Z0-9:._~!()*'-]|%[a-fA-F0-9]{2})+$/),
);
export const HybridClock = Schema.Struct({
  wall: Counter,
  logical: Counter,
  node: SharedDocumentId,
});
export type HybridClock = typeof HybridClock.Type;
/**
 * `settings` carries universal server settings (id `universal`); see
 * SettingsSync. `project-settings` held per-project overrides from builds
 * before 0.3.2. This build reads none of its fields, so older machines'
 * documents are kept and relayed as they came, and never applied.
 * `project-file` is one file or folder in a project's folder, by relative
 * path; its bytes travel separately over `ProjectFileBlobRead`.
 */
export const SharedDocumentKind = Schema.Literals([
  "project",
  "agent",
  "schedule",
  "fact",
  "vault",
  "settings",
  "project-settings",
  "integration",
  "project-file",
]);
export type SharedDocumentKind = typeof SharedDocumentKind.Type;
/** A delta contains only fields authored by this edit; relay preserves their clocks. */
export const SharedDocumentChange = Schema.Struct({
  kind: SharedDocumentKind,
  id: Schema.Union([SharedDocumentId, LegacyScheduleId]),
  fields: Schema.Record(Schema.String, Schema.Json),
  clocks: Schema.Record(Schema.String, HybridClock),
  tombstone: Schema.NullOr(HybridClock),
  updatedBy: EnvironmentId,
});
export type SharedDocumentChange = typeof SharedDocumentChange.Type;
/**
 * A change as peers send it. The kind stays open so a newer peer's document
 * kind reaches the receiver, which keeps it for a later build instead of
 * refusing the whole batch (see docs/internals/sync.md).
 */
export const SharedDocumentChangeWire = Schema.Struct({
  ...SharedDocumentChange.fields,
  kind: SharedDocumentId,
});
export type SharedDocumentChangeWire = typeof SharedDocumentChangeWire.Type;
export const SharedChangeBatch = Schema.Struct({
  after: Counter,
  cursor: Counter,
  changes: Schema.Array(SharedDocumentChangeWire).check(Schema.isMaxLength(SHARED_BATCH_LIMIT)),
});
export type SharedChangeBatch = typeof SharedChangeBatch.Type;
export class SharedStateError extends Schema.TaggedError<SharedStateError>()("SharedStateError", {
  reason: Schema.Literals(["storage", "invalid-document", "invalid-cursor", "owner-change"]),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message() {
    return `Shared state failed (${this.reason}).`;
  }
}
/** Omit `kinds` for every kind this build syncs. */
export const SharedSyncStatusInput = Schema.Struct({
  kinds: Schema.optional(Schema.Array(SharedDocumentKind)),
});
export type SharedSyncStatusInput = typeof SharedSyncStatusInput.Type;
/** What one directly paired machine has not yet acknowledged, by document kind. */
export const SharedSyncPeerStatus = Schema.Struct({
  environmentId: EnvironmentId,
  label: Schema.String,
  online: Schema.Boolean,
  relation: MachineRelation,
  kinds: Schema.Array(
    Schema.Struct({
      kind: SharedDocumentKind,
      /** Local changes the peer has not acknowledged and would receive on the next pass. */
      pendingOutgoing: Counter,
    }),
  ),
});
export type SharedSyncPeerStatus = typeof SharedSyncPeerStatus.Type;
export const SharedSyncStatusResult = Schema.Struct({ peers: Schema.Array(SharedSyncPeerStatus) });
export type SharedSyncStatusResult = typeof SharedSyncStatusResult.Type;
export const SharedChangesRead = makePeerChannel({
  name: "sync.documents.read.v1",
  scope: AuthSyncReplicateScope,
  payload: Schema.Struct({ after: Counter }),
  success: SharedChangeBatch,
  error: SharedStateError,
});
/** Largest project file that replicates; bigger files stay on their machine. */
export const PROJECT_FILE_SYNC_MAX_BYTES = 100 * 1024 * 1024;
/** Bytes per blob read, so one peer reply stays small. */
export const PROJECT_FILE_BLOB_CHUNK_BYTES = 1024 * 1024;
export const ProjectFileSha256 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/));
export class ProjectFileBlobError extends Schema.TaggedError<ProjectFileBlobError>()(
  "ProjectFileBlobError",
  { reason: Schema.Literals(["not-found", "storage"]) },
) {
  override get message() {
    return `Project file content unavailable (${this.reason}).`;
  }
}
/** One chunk of a project file's content, found by its sha256 in any project. */
export const ProjectFileBlobRead = makePeerChannel({
  name: "sync.project-files.blob.v1",
  scope: AuthSyncReplicateScope,
  payload: Schema.Struct({ sha256: ProjectFileSha256, offset: Counter }),
  success: Schema.Struct({ totalBytes: Counter, base64: Schema.String }),
  error: ProjectFileBlobError,
});
export const SharedChangesApply = makePeerChannel({
  name: "sync.documents.apply.v1",
  scope: AuthSyncReplicateScope,
  payload: SharedChangeBatch,
  success: Schema.Struct({ acknowledged: Counter }),
  error: SharedStateError,
});
