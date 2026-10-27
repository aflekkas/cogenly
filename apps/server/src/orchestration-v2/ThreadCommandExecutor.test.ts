import { describe, expect, it } from "@effect/vitest";
import { ThreadId } from "@cogenly/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";

describe("update handoff admission", () => {
  it.effect("defers while a command is admitted", () =>
    Effect.gen(function* () {
      const commands = yield* ThreadCommandExecutor.ThreadCommandExecutor;
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const command = yield* commands
        .withLock(
          ThreadId.make("work"),
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
        )
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(entered);
      let activated = false;
      expect(
        Option.isNone(
          yield* commands.withIdleHandoff(
            Effect.sync(() => {
              activated = true;
            }),
          ),
        ),
      ).toBe(true);
      expect(activated).toBe(false);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(command);
      expect(Option.isSome(yield* commands.withIdleHandoff(Effect.void))).toBe(true);
    }).pipe(Effect.provide(ThreadCommandExecutor.layer), Effect.scoped),
  );

  it.effect("blocks commands through activation and reopens after a failed handoff", () =>
    Effect.gen(function* () {
      const commands = yield* ThreadCommandExecutor.ThreadCommandExecutor;
      const checking = yield* Deferred.make<void>();
      const activate = yield* Deferred.make<void>();
      let ran = false;
      const handoff = yield* commands
        .withIdleHandoff(
          Deferred.succeed(checking, undefined).pipe(
            Effect.andThen(Deferred.await(activate)),
            Effect.andThen(Effect.fail("busy")),
          ),
        )
        .pipe(Effect.result, Effect.forkChild);
      yield* Deferred.await(checking);
      const command = yield* commands
        .withLock(
          ThreadId.make("new"),
          Effect.sync(() => {
            ran = true;
          }),
        )
        .pipe(Effect.forkChild({ startImmediately: true }));
      // A second close cannot run its check while the first owns admission.
      expect(Option.isNone(yield* commands.withIdleHandoff(Effect.die("must not activate")))).toBe(
        true,
      );
      expect(ran).toBe(false);
      yield* Deferred.succeed(activate, undefined);
      yield* Fiber.join(handoff);
      yield* Fiber.join(command);
      expect(ran).toBe(true);
      expect(Option.isSome(yield* commands.withIdleHandoff(Effect.void))).toBe(true);
      // A successful handoff keeps admission closed until the old process exits.
      const blocked = yield* commands
        .withLock(
          ThreadId.make("later"),
          Effect.sync(() => {
            ran = false;
          }),
        )
        .pipe(Effect.forkChild({ startImmediately: true }));
      expect(ran).toBe(true);
      yield* Fiber.interrupt(blocked);
    }).pipe(Effect.provide(ThreadCommandExecutor.layer), Effect.scoped),
  );
});
