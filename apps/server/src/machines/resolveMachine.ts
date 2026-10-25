import { type EnvironmentId, ThreadRemoteError } from "@cogenly/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Machines from "./Machines.ts";
import { normalizeMachineName } from "./machineName.ts";

/** Resolves a portable tool argument; omitted means this server, even without pairing. */
export const resolveMachine = Effect.fn("Machines.resolveTarget")(function* (
  value: string | undefined,
) {
  if (value === undefined) return undefined;
  const service = yield* Effect.serviceOption(Machines.Machines);
  if (Option.isNone(service))
    return yield* new ThreadRemoteError({
      reason: "rejected",
      detail: "Machine selection is unavailable on this server.",
    });
  const view = yield* service.value.list.pipe(
    Effect.mapError(
      () =>
        new ThreadRemoteError({ reason: "offline", detail: "The machine list could not be read." }),
    ),
  );
  const key = normalizeMachineName(value).toLowerCase();
  const machines = view.machines.filter((machine) => machine.pairing !== "revoked");
  const matches =
    key === "this"
      ? machines.filter((machine) => machine.relation === "this")
      : key === "auto"
        ? [
            machines.find((machine) => machine.relation === "hub") ??
              machines.find((machine) => machine.relation === "this"),
          ].filter((machine) => machine !== undefined)
        : machines.filter(
            (machine) =>
              machine.environmentId === value ||
              normalizeMachineName(machine.name).toLowerCase() === key,
          );
  const candidates =
    matches.length === 0 && key === "vps"
      ? machines.filter((machine) => machine.hardware === "server")
      : matches;
  if (candidates.length !== 1)
    return yield* new ThreadRemoteError({
      reason: "rejected",
      detail:
        candidates.length > 1
          ? `More than one machine matches "${value}". Use its environment ID from machines_list.`
          : `No paired machine matches "${value}". Use machines_list, or omit machine to run here.`,
    });
  return candidates[0]!.environmentId as EnvironmentId;
});
