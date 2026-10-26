import { CommandId, MessageId, type ThreadId } from "@cogenly/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as InlineCardEvents from "./InlineCardEvents.ts";
import * as Threads from "./ThreadManagementService.ts";

export class InlineCardNotifications extends Context.Service<
  InlineCardNotifications,
  {
    readonly answered: (input: {
      threadId: ThreadId;
      key: string;
      summary: string;
    }) => Effect.Effect<void>;
  }
>()("cogenly-server/orchestration-v2/InlineCardNotifications") {}

const make = Effect.gen(function* () {
  const threads = yield* Threads.ThreadManagementService;
  const service = InlineCardNotifications.of({
    answered: (input) =>
      threads
        .dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`inline-card:${input.key}`),
          messageId: MessageId.make(`message:inline-card:${input.key}`),
          threadId: input.threadId,
          text: `${input.summary}. Continue the work using this decision; do not ask the user to type continue.`,
          notification: { source: { kind: "command" }, outcome: "updated", summary: input.summary },
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "agent",
          creationSource: "server",
        })
        .pipe(
          Effect.asVoid,
          Effect.catch(() => Effect.logWarning("Could not deliver an inline card answer")),
        ),
  });
  const events = yield* Effect.serviceOption(InlineCardEvents.InlineCardEvents);
  if (events._tag === "Some")
    yield* Queue.take(events.value.answers).pipe(
      Effect.flatMap(service.answered),
      Effect.forever,
      Effect.forkScoped,
    );
  return service;
});
export const layer = Layer.effect(InlineCardNotifications, make);

/** Optional only for isolated domain test layers; the application always provides delivery. */
export const optional = Effect.serviceOption(InlineCardNotifications).pipe(
  Effect.map((service) =>
    service._tag === "Some"
      ? service.value
      : InlineCardNotifications.of({ answered: () => Effect.void }),
  ),
);
