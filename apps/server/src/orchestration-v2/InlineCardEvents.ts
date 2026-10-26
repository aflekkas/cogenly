// @effect-diagnostics-next-line nodeBuiltinImport:off -- Hash callback capabilities before recording delivery identifiers.
import * as NodeCrypto from "node:crypto";
import type { ThreadId } from "@cogenly/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";

/** Integration callbacks sit below orchestration; queue only metadata for its delivery worker. */
export class InlineCardEvents extends Context.Service<
  InlineCardEvents,
  {
    readonly answers: Queue.Queue<{ threadId: ThreadId; key: string; summary: string }>;
  }
>()("cogenly-server/orchestration-v2/InlineCardEvents") {}
export const layer = Layer.effect(
  InlineCardEvents,
  Effect.gen(function* () {
    return InlineCardEvents.of({
      answers: yield* Queue.unbounded<{ threadId: ThreadId; key: string; summary: string }>(),
    });
  }),
);
export const optional = Effect.serviceOption(InlineCardEvents).pipe(
  Effect.map((service) => ({
    answered: (input: { threadId: ThreadId; key: string; summary: string }) =>
      service._tag === "Some"
        ? Queue.offer(service.value.answers, input).pipe(Effect.asVoid)
        : Effect.void,
  })),
);

/** The OAuth state must never become a transcript or event identifier. */
export const signInAnswerKey = (state: string) =>
  `sign-in:${NodeCrypto.createHash("sha256").update(state).digest("hex").slice(0, 32)}`;
