/**
 * The seam where ThreadLaunchService hands a launch for another machine to
 * thread sync, which registers the launcher once the machine link exists.
 * Kept as a registry, like RemoteThreadCommands, so orchestration does not
 * depend on the machine link.
 */
import { type EnvironmentId, ThreadRemoteError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";

import type { ThreadLaunchInput, ThreadLaunchResult } from "./ThreadLaunchService.ts";

/**
 * None when `machine` is this one, so the launch runs here; otherwise the
 * result of launching on `machine`, read from the replica it pushed here.
 */
export type RemoteThreadLauncher = (
  machine: EnvironmentId,
  input: ThreadLaunchInput,
) => Effect.Effect<Option.Option<ThreadLaunchResult>, ThreadRemoteError>;

export class RemoteThreadLaunch extends Context.Service<
  RemoteThreadLaunch,
  {
    readonly register: (launcher: RemoteThreadLauncher) => Effect.Effect<void, never, Scope.Scope>;
    readonly launch: RemoteThreadLauncher;
  }
>()("cogenly-server/orchestration-v2/RemoteThreadLaunch") {}

export const layer = Layer.effect(
  RemoteThreadLaunch,
  Effect.gen(function* () {
    const current = yield* Ref.make<RemoteThreadLauncher | undefined>(undefined);
    return RemoteThreadLaunch.of({
      register: (launcher) =>
        Effect.acquireRelease(Ref.set(current, launcher), () => Ref.set(current, undefined)),
      launch: (machine, input) =>
        Ref.get(current).pipe(
          Effect.flatMap((launcher) =>
            launcher === undefined
              ? Effect.fail(
                  new ThreadRemoteError({
                    reason: "rejected",
                    detail: "This server cannot reach other machines.",
                  }),
                )
              : launcher(machine, input),
          ),
        ),
    });
  }),
);
