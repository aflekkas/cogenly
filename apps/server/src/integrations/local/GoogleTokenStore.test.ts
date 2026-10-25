import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { NodeCrypto } from "@effect/platform-node";
import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Sqlite from "../../persistence/Sqlite.ts";
import { runMigrations } from "../../persistence/Migrations.ts";
import * as Vault from "../../vault/Vault.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as Store from "./GoogleTokenStore.ts";

const secrets = new Map<string, Uint8Array>();
const layer = Store.layer.pipe(
  Layer.provideMerge(Vault.layer),
  Layer.provide(
    Layer.mock(ServerSecretStore.ServerSecretStore)({
      get: (name) => Effect.succeed(Option.fromUndefinedOr(secrets.get(name))),
      create: (name, value) =>
        Effect.sync(() => {
          secrets.set(name, value);
        }),
    }),
  ),
  Layer.provide(
    Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(EnvironmentId.make("test")),
    }),
  ),
  Layer.provideMerge(Sqlite.layerMemory.pipe(Layer.provide(NodeServices.layer))),
  Layer.provide(NodeCrypto.layer),
  Layer.provide(NodeServices.layer),
);

it.effect("stores Google refreshes only in the vault and isolates account grants", () =>
  Effect.gen(function* () {
    yield* runMigrations();
    const store = yield* Store.GoogleTokenStore;
    const vault = yield* Vault.Vault;
    const grant: Store.GoogleGrant = {
      email: "work@example.com",
      credentials: {
        token: "fixture-access",
        refresh_token: "fixture-refresh",
        client_id: "fixture-client",
        client_secret: "fixture-secret",
        token_uri: "https://oauth2.googleapis.com/token",
        scopes: ["gmail.readonly"],
        expiry: null,
      },
    };
    yield* store.write("work", grant);
    expect(yield* store.read("work")).toEqual(Option.some(grant));
    expect(yield* store.read("personal")).toEqual(Option.none());
    const metadata = yield* vault.list({});
    expect(JSON.stringify(metadata)).not.toContain("fixture-refresh");
    expect(JSON.stringify(metadata)).not.toContain("fixture-access");
    yield* store.write("work", {
      ...grant,
      credentials: { ...grant.credentials, token: "new-access" },
    });
    expect((yield* store.read("work")).pipe(Option.getOrThrow).credentials.token).toBe(
      "new-access",
    );
    yield* store.remove("work");
    expect(yield* store.read("work")).toEqual(Option.none());
  }).pipe(Effect.provide(layer)),
);
