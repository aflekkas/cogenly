import * as Schema from "effect/Schema";
import { AuthSyncReplicateScope } from "./auth.ts";
import { EnvironmentId } from "./baseSchemas.ts";
import { makePeerChannel } from "./machine.ts";

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
 * `settings` documents carry universal server settings (id `universal`) and a
 * project's setting overrides (id `project:<label id>`); see SettingsSync.
 */
export const SharedDocumentKind = Schema.Literals(["project", "agent", "schedule", "settings"]);
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
export const SharedChangeBatch = Schema.Struct({
  after: Counter,
  cursor: Counter,
  changes: Schema.Array(SharedDocumentChange).check(Schema.isMaxLength(SHARED_BATCH_LIMIT)),
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
export const SharedChangesRead = makePeerChannel({
  name: "sync.documents.read.v1",
  scope: AuthSyncReplicateScope,
  payload: Schema.Struct({ after: Counter }),
  success: SharedChangeBatch,
  error: SharedStateError,
});
export const SharedChangesApply = makePeerChannel({
  name: "sync.documents.apply.v1",
  scope: AuthSyncReplicateScope,
  payload: SharedChangeBatch,
  success: Schema.Struct({ acknowledged: Counter }),
  error: SharedStateError,
});
