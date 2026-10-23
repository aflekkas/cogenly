import * as Schema from "effect/Schema";
import { AuthSyncReplicateScope } from "./auth.ts";
import { EnvironmentId } from "./baseSchemas.ts";
import { makePeerChannel } from "./machine.ts";

export const SHARED_BATCH_LIMIT = 32;
export const SHARED_BATCH_BYTES = 256 * 1024;
export const SHARED_DOCUMENT_BYTES = 96 * 1024;
const Counter = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
);
const Id = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,199}$/));
export const HybridClock = Schema.Struct({
  wall: Counter,
  logical: Counter,
  node: Id,
});
export type HybridClock = typeof HybridClock.Type;
export const SharedDocumentKind = Schema.Literals(["project", "agent", "schedule"]);
export type SharedDocumentKind = typeof SharedDocumentKind.Type;
/** A delta contains only fields authored by this edit; relay preserves their clocks. */
export const SharedDocumentChange = Schema.Struct({
  kind: SharedDocumentKind,
  id: Id,
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
