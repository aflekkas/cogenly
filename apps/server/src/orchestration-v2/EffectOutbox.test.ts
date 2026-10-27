import { expect, it } from "@effect/vitest";
import {
  CommandId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  ThreadId,
} from "@cogenly/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as Sqlite from "../persistence/Sqlite.ts";
import * as EffectOutbox from "./EffectOutbox.ts";

const layer = EffectOutbox.layer.pipe(Layer.provideMerge(Sqlite.layerMemory));

it.effect("an interrupt skips the thread's running work and holds back later lifecycle work", () =>
  Effect.gen(function* () {
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const threadId = ThreadId.make("thread:stop");
    const commandId = CommandId.make("command:stop");
    const claim = outbox
      .claimNext({ workerId: "test", leaseDurationMs: 60_000 })
      .pipe(Effect.map((claimed) => Option.getOrUndefined(claimed)?.id));
    yield* outbox.enqueue([
      {
        id: "effect:start",
        commandId,
        threadId,
        request: { type: "provider-turn.start", runId: RunId.make("run:1") },
      },
    ]);
    expect(yield* claim).toBe("effect:start");
    yield* outbox.enqueue([
      {
        id: "effect:next-start",
        commandId,
        threadId,
        request: { type: "provider-turn.start", runId: RunId.make("run:2") },
      },
      {
        id: "effect:interrupt",
        commandId,
        threadId,
        request: {
          type: "provider-turn.interrupt",
          providerSessionId: ProviderSessionId.make("session:1"),
          providerThreadId: ProviderThreadId.make("provider-thread:1"),
          providerTurnId: ProviderTurnId.make("provider-turn:1"),
        },
      },
    ]);
    // The start is still running, yet the interrupt is claimable at once.
    expect(yield* claim).toBe("effect:interrupt");
    expect(yield* claim).toBeUndefined();
    yield* outbox.succeed({ effectId: "effect:start", workerId: "test" });
    // The next start waits for the interrupt, not only for the earlier start.
    expect(yield* claim).toBeUndefined();
    yield* outbox.succeed({ effectId: "effect:interrupt", workerId: "test" });
    expect(yield* claim).toBe("effect:next-start");
  }).pipe(Effect.provide(layer)),
);
