import * as HostProcess from "@cogenly/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";

import * as ProcessRunner from "../processRunner.ts";
import * as Scheduler from "./Scheduler.ts";

/** Four missed scheduler ticks stop watchdog notifications, including before the first tick. */
export function shouldPingWatchdog(nowMs: number, lastTickAtMs: number | null): boolean {
  return lastTickAtMs !== null && nowMs >= lastTickAtMs && nowMs - lastTickAtMs <= 20_000;
}

export class SystemdWatchdog extends Context.Service<
  SystemdWatchdog,
  { readonly start: Effect.Effect<void, never, Scope.Scope> }
>()("cogenly-server/scheduling/SystemdWatchdog") {}

const make = Effect.gen(function* () {
  const platform = yield* HostProcess.Platform;
  const environment = yield* HostProcess.Environment;
  const runner = yield* ProcessRunner.ProcessRunner;
  const start = Effect.gen(function* () {
    if (platform !== "linux" || !environment.NOTIFY_SOCKET) return;
    let ready = false;
    const tick = Effect.gen(function* () {
      const nowMs = yield* Clock.currentTimeMillis;
      const lastTickAtMs = yield* Scheduler.lastSchedulerTickAtMs;
      if (!shouldPingWatchdog(nowMs, lastTickAtMs)) return;
      // systemd supplies this sd_notify wrapper; Node has no built-in Unix
      // datagram transport. Keep its acknowledgement barrier (no --no-block),
      // and NotifyAccess=all: the launcher, server and helper have distinct PIDs.
      const result = yield* runner.run({
        command: "systemd-notify",
        args: ready ? ["WATCHDOG=1"] : ["READY=1", "WATCHDOG=1"],
        env: { NOTIFY_SOCKET: environment.NOTIFY_SOCKET },
        timeout: "2 seconds",
        maxOutputBytes: 1024,
      });
      if (result.code === 0) ready = true;
      else yield* Effect.logWarning("systemd watchdog notification was rejected");
    }).pipe(
      Effect.catch((cause) => Effect.logWarning("Could not notify systemd watchdog", { cause })),
    );
    yield* tick.pipe(Effect.andThen(Effect.sleep("5 seconds")), Effect.forever, Effect.forkScoped);
  });
  return SystemdWatchdog.of({ start });
});

export const layer = Layer.effect(SystemdWatchdog, make).pipe(Layer.provide(ProcessRunner.layer));
