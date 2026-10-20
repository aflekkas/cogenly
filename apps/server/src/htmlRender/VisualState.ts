import {
  CommandId,
  MessageId,
  VISUAL_STATE_MAX_BYTES,
  VisualStateError,
  type ThreadId,
  type VisualState,
} from "@t3tools/contracts";
import { visualStateJsonBytes } from "@t3tools/shared/htmlRender";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";

const isVisualStateError = Schema.is(VisualStateError);

/**
 * The server side of interactive visuals: one JSON document per rendered
 * visual, stored with its thread. Writes go through orchestration commands
 * (`visual-state.set`, `visual-state.submit`), so every change is an event in
 * the thread log and every client following the thread projection sees it.
 * Reads come from the projection, so a re-mounted page gets the latest
 * document without waiting for the agent.
 */
export class VisualStateService extends Context.Service<
  VisualStateService,
  {
    /** The stored document, or null before the first set or submit. */
    readonly get: (input: {
      readonly threadId: ThreadId;
      readonly renderId: string;
    }) => Effect.Effect<VisualState | null, VisualStateError>;
    /** Stores the document; fails when the version moved or the visual locked. */
    readonly set: (input: {
      readonly threadId: ThreadId;
      readonly renderId: string;
      readonly title?: string | undefined;
      readonly state: unknown;
      readonly expectedVersion: number;
    }) => Effect.Effect<VisualState, VisualStateError>;
    /**
     * Records the payload and delivers it to the agent as a new user turn in
     * the same thread (queued behind a running turn). With `lock`, the visual
     * rejects further writes and submits.
     */
    readonly submit: (input: {
      readonly threadId: ThreadId;
      readonly renderId: string;
      readonly title?: string | undefined;
      readonly payload: unknown;
      readonly lock?: boolean | undefined;
    }) => Effect.Effect<
      { readonly state: VisualState; readonly messageId: MessageId },
      VisualStateError
    >;
  }
>()("t3/htmlRender/VisualState/VisualStateService") {}

const storageFailure = (operation: "get" | "set" | "submit", renderId: string, cause: unknown) =>
  new VisualStateError({ operation, reason: "storage", renderId, cause });

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const crypto = yield* Crypto.Crypto;

  const read = Effect.fn("VisualState.read")(function* (
    threadId: ThreadId,
    renderId: string,
    operation: "get" | "set" | "submit",
  ) {
    const records = yield* threads
      .getThreadRecords(threadId, ["visualStates"])
      .pipe(Effect.mapError((cause) => storageFailure(operation, renderId, cause)));
    return records.visualStates.find((candidate) => candidate.renderId === renderId) ?? null;
  });

  const readAfterWrite = Effect.fn("VisualState.readAfterWrite")(function* (
    threadId: ThreadId,
    renderId: string,
    operation: "set" | "submit",
  ) {
    const next = yield* read(threadId, renderId, operation);
    if (next === null) {
      return yield* Effect.fail(
        storageFailure(operation, renderId, new Error("Visual state is missing after write.")),
      );
    }
    return next;
  });

  // A lost race, or a direct command from another writer, can still fail the
  // dispatch after the checks below passed. Re-read to report the conflict
  // (or lock) instead of a generic failure.
  const classifyWriteFailure = Effect.fn("VisualState.classifyWriteFailure")(function* (
    threadId: ThreadId,
    renderId: string,
    operation: "set" | "submit",
    expectedVersion: number,
  ) {
    const reread = yield* Effect.exit(read(threadId, renderId, operation));
    if (reread._tag === "Failure") {
      return yield* Effect.fail(storageFailure(operation, renderId, reread.cause));
    }
    const current = reread.value;
    if (current?.locked === true) {
      return yield* Effect.fail(new VisualStateError({ operation, reason: "locked", renderId }));
    }
    if ((current?.version ?? 0) !== expectedVersion) {
      return yield* Effect.fail(
        new VisualStateError({
          operation,
          reason: "version_conflict",
          renderId,
          expectedVersion,
          actualVersion: current?.version ?? 0,
        }),
      );
    }
    return yield* Effect.fail(
      storageFailure(operation, renderId, new Error("Visual state write was rejected.")),
    );
  });

  const get = Effect.fn("VisualState.get")(function* (input: {
    readonly threadId: ThreadId;
    readonly renderId: string;
  }) {
    return yield* read(input.threadId, input.renderId, "get");
  });

  const set = Effect.fn("VisualState.set")(function* (input: {
    readonly threadId: ThreadId;
    readonly renderId: string;
    readonly title?: string | undefined;
    readonly state: unknown;
    readonly expectedVersion: number;
  }) {
    const size = visualStateJsonBytes(input.state);
    if (size === null || size > VISUAL_STATE_MAX_BYTES) {
      return yield* Effect.fail(
        new VisualStateError({
          operation: "set",
          reason: "too_large",
          renderId: input.renderId,
          expectedVersion: input.expectedVersion,
        }),
      );
    }
    const current = yield* read(input.threadId, input.renderId, "set");
    if (current?.locked === true) {
      return yield* Effect.fail(
        new VisualStateError({ operation: "set", reason: "locked", renderId: input.renderId }),
      );
    }
    if ((current?.version ?? 0) !== input.expectedVersion) {
      return yield* Effect.fail(
        new VisualStateError({
          operation: "set",
          reason: "version_conflict",
          renderId: input.renderId,
          expectedVersion: input.expectedVersion,
          actualVersion: current?.version ?? 0,
        }),
      );
    }
    const commandId = CommandId.make(
      `visual-state:${yield* crypto.randomUUIDv4().pipe(Effect.orDie)}`,
    );
    return yield* threads
      .dispatch({
        type: "visual-state.set",
        commandId,
        threadId: input.threadId,
        renderId: input.renderId,
        ...(input.title === undefined ? {} : { title: input.title }),
        state: input.state,
        expectedVersion: input.expectedVersion,
      })
      .pipe(
        Effect.andThen(readAfterWrite(input.threadId, input.renderId, "set")),
        Effect.catchTags({
          OrchestratorDispatchError: () =>
            classifyWriteFailure(input.threadId, input.renderId, "set", input.expectedVersion),
        }),
        Effect.mapError((cause) =>
          isVisualStateError(cause) ? cause : storageFailure("set", input.renderId, cause),
        ),
      );
  });

  const submit = Effect.fn("VisualState.submit")(function* (input: {
    readonly threadId: ThreadId;
    readonly renderId: string;
    readonly title?: string | undefined;
    readonly payload: unknown;
    readonly lock?: boolean | undefined;
  }) {
    const size = visualStateJsonBytes(input.payload);
    if (size === null || size > VISUAL_STATE_MAX_BYTES) {
      return yield* Effect.fail(
        new VisualStateError({
          operation: "submit",
          reason: "too_large",
          renderId: input.renderId,
        }),
      );
    }
    const current = yield* read(input.threadId, input.renderId, "submit");
    if (current?.locked === true) {
      return yield* Effect.fail(
        new VisualStateError({ operation: "submit", reason: "locked", renderId: input.renderId }),
      );
    }
    const commandId = CommandId.make(
      `visual-state:${yield* crypto.randomUUIDv4().pipe(Effect.orDie)}`,
    );
    const messageId = MessageId.make(
      `visual-submit:${yield* crypto.randomUUIDv4().pipe(Effect.orDie)}`,
    );
    const state = yield* threads
      .dispatch({
        type: "visual-state.submit",
        commandId,
        threadId: input.threadId,
        renderId: input.renderId,
        ...(input.title === undefined ? {} : { title: input.title }),
        payload: input.payload,
        ...(input.lock === undefined ? {} : { lock: input.lock }),
        messageId,
      })
      .pipe(
        Effect.andThen(readAfterWrite(input.threadId, input.renderId, "submit")),
        Effect.catchTags({
          OrchestratorDispatchError: () =>
            classifyWriteFailure(input.threadId, input.renderId, "submit", current?.version ?? 0),
        }),
        Effect.mapError((cause) =>
          isVisualStateError(cause) ? cause : storageFailure("submit", input.renderId, cause),
        ),
      );
    return { state, messageId };
  });

  return VisualStateService.of({ get, set, submit });
});

export const layer = Layer.effect(VisualStateService, make);
