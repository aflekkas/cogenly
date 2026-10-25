import { EnvironmentId } from "@cogenly/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
/** Stable local identity for isolated domain tests that do not construct a server. */
export const layerIdentity = Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
  getEnvironmentId: Effect.succeed(EnvironmentId.make("test-local-machine")),
});
