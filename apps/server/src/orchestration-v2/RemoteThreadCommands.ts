/**
 * The seam where the orchestrator hands a command for a thread another
 * machine runs to thread sync. Thread sync registers the forwarder once the
 * machine link exists; until then, and on a standalone server, every thread
 * is local. Kept as a registry so the orchestrator does not depend on the
 * machine link and the link does not depend on the orchestrator.
 */
import type { OrchestrationV2ServerCommand, ThreadRemoteError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";

import type { OrchestratorV2DispatchResult } from "./Orchestrator.ts";

/** None when the thread runs here; otherwise the owner's result, replicated back. */
export type RemoteThreadForwarder = (
  command: OrchestrationV2ServerCommand,
) => Effect.Effect<Option.Option<OrchestratorV2DispatchResult>, ThreadRemoteError>;

export class RemoteThreadCommands extends Context.Service<
  RemoteThreadCommands,
  {
    readonly register: (
      forwarder: RemoteThreadForwarder,
    ) => Effect.Effect<void, never, Scope.Scope>;
    readonly forward: RemoteThreadForwarder;
  }
>()("cogenly-server/orchestration-v2/RemoteThreadCommands") {}

export const layer = Layer.effect(
  RemoteThreadCommands,
  Effect.gen(function* () {
    const current = yield* Ref.make<RemoteThreadForwarder | undefined>(undefined);
    return RemoteThreadCommands.of({
      register: (forwarder) =>
        Effect.acquireRelease(Ref.set(current, forwarder), () => Ref.set(current, undefined)),
      forward: (command) =>
        Ref.get(current).pipe(
          Effect.flatMap((forwarder) =>
            forwarder === undefined ? Effect.succeed(Option.none()) : forwarder(command),
          ),
        ),
    });
  }),
);
