import * as Schema from "effect/Schema";

import { CommandId, MessageId, NonNegativeInt, ThreadId } from "./baseSchemas.ts";

/** Largest visual state or submit payload, in UTF-8 bytes of its canonical JSON. */
export const VISUAL_STATE_MAX_BYTES = 64 * 1024;

/**
 * One rendered visual's interactive document, keyed by its `html_render` tool
 * result within a thread. Pages read and write it through `window.cogenly`;
 * agents read it with `html_state_read` and write it with `html_state_write`;
 * every change is an orchestration `visual-state.updated` event, so clients
 * following the thread projection see it live.
 */
export const VisualState = Schema.Struct({
  threadId: ThreadId,
  /** The `html_render` result's attachment id. */
  renderId: Schema.String,
  title: Schema.String,
  /** The page's document (`null` when only a submit has landed so far). */
  state: Schema.Unknown,
  /** Starts at 1. `visual.state.set` must pass the version it read. */
  version: NonNegativeInt,
  /** A locked visual rejects further sets and submits (a submitted quiz). */
  locked: Schema.Boolean,
  submittedAt: Schema.NullOr(Schema.DateTimeUtc),
  updatedAt: Schema.DateTimeUtc,
});
export type VisualState = typeof VisualState.Type;

export const VisualStateJson = VisualState.mapFields((fields) => ({
  ...fields,
  submittedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  updatedAt: Schema.DateTimeUtcFromString,
}));
export type VisualStateJson = typeof VisualStateJson.Type;

export const VisualStateGetInput = Schema.Struct({
  threadId: ThreadId,
  renderId: Schema.String,
});
export type VisualStateGetInput = typeof VisualStateGetInput.Type;

export const VisualStateGetResult = Schema.Struct({
  state: Schema.NullOr(VisualState),
});
export type VisualStateGetResult = typeof VisualStateGetResult.Type;

export const VisualStateSetInput = Schema.Struct({
  threadId: ThreadId,
  renderId: Schema.String,
  title: Schema.optional(Schema.String),
  state: Schema.Unknown,
  /** The version `visual.state.get` returned (0 when no state exists yet). */
  expectedVersion: NonNegativeInt,
});
export type VisualStateSetInput = typeof VisualStateSetInput.Type;

export const VisualStateSubmitInput = Schema.Struct({
  threadId: ThreadId,
  renderId: Schema.String,
  title: Schema.optional(Schema.String),
  payload: Schema.Unknown,
  /** Lock the visual after submitting, so a quiz cannot be taken twice. */
  lock: Schema.optional(Schema.Boolean),
});
export type VisualStateSubmitInput = typeof VisualStateSubmitInput.Type;

export const VisualStateSubmitResult = Schema.Struct({
  state: VisualState,
  messageId: MessageId,
});
export type VisualStateSubmitResult = typeof VisualStateSubmitResult.Type;

export class VisualStateError extends Schema.TaggedError<VisualStateError>()("VisualStateError", {
  operation: Schema.Literals(["get", "set", "submit"]),
  reason: Schema.Literals(["storage", "too_large", "version_conflict", "locked"]),
  renderId: Schema.String,
  /** The version the writer based its update on; absent for pure size rejects. */
  expectedVersion: Schema.optional(NonNegativeInt),
  /** The version that won; present when a newer document already exists. */
  actualVersion: Schema.optional(NonNegativeInt),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message() {
    switch (this.reason) {
      case "too_large":
        return `Visual state for ${this.renderId} is larger than ${VISUAL_STATE_MAX_BYTES} bytes.`;
      case "version_conflict":
        return `Visual state for ${this.renderId} changed since version ${this.expectedVersion ?? "unknown"} (now ${this.actualVersion ?? "unknown"}); read it again and retry.`;
      case "locked":
        return `Visual ${this.renderId} already submitted and is locked.`;
      case "storage":
        return `Could not ${this.operation} visual state for ${this.renderId}.`;
    }
  }
}

export const VisualStateCommandIdFields = {
  commandId: CommandId,
  threadId: ThreadId,
  renderId: Schema.String,
} as const;
