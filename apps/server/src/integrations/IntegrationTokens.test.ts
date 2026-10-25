import { describe, expect, it } from "@effect/vitest";
import { VaultItemId, type VaultError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";
import type * as Statement from "effect/sql/Statement";

import * as Vault from "../vault/Vault.ts";
import { Network, startNode } from "../vault/vaultSync.testkit.ts";
import * as Tokens from "./IntegrationTokens.ts";

const encodeAttachment = Schema.encodeSync(Tokens.SignInAttachment);
const attachment = (clientId: string): Tokens.SignInAttachment => ({
  kind: "integration-oauth",
  v: 1,
  integrationId: "integration:test",
  server: {
    resource: "https://example.com/mcp",
    issuer: "https://example.com",
    authorizationEndpoint: "https://example.com/authorize",
    tokenEndpoint: "https://example.com/token",
  },
  registration: { clientId, authMethod: "none", redirectUris: [] },
  expiresAt: null,
  refreshOwner: "env-server",
});
const input = {
  itemId: undefined,
  name: "Sign-in",
  label: "Sign-in",
  host: "example.com",
  tokens: {
    accessToken: "old-access",
    refreshToken: "old-refresh",
    clientSecret: "old-client-secret",
  },
  attachment: attachment("old-client"),
};

/** Inject a peer projection after a row read or immediately after a mutation commits. */
const harness = Effect.gen(function* () {
  const node = yield* startNode(new Network(), "Server");
  const hooks: {
    afterRead?: ReturnType<Vault.Vault["Service"]["applySynced"]>;
    afterCommit?: Effect.Effect<unknown, VaultError | SqlError.SqlError>;
  } = {};
  const sql = node.sql;
  const intercepted = new Proxy(sql, {
    apply(target, receiver, args: Array<unknown>) {
      const query = Reflect.apply(target, receiver, args) as Statement.Statement<unknown>;
      if (!query.compile()[0].includes("FROM vault_items WHERE id =")) return query;
      return query.pipe(
        Effect.tap(() => {
          const projection = hooks.afterRead;
          delete hooks.afterRead;
          return projection ?? Effect.void;
        }),
      );
    },
    get(target, property, receiver) {
      if (property !== "withTransaction") return Reflect.get(target, property, receiver);
      return <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        sql.withTransaction(effect).pipe(
          Effect.tap(() => {
            const projection = hooks.afterCommit;
            delete hooks.afterCommit;
            return projection ?? Effect.void;
          }),
        );
    },
  });
  const context = yield* Layer.build(
    Tokens.layer.pipe(
      Layer.provideMerge(Vault.layer),
      Layer.provide(Layer.succeed(SqlClient.SqlClient, intercepted)),
      Layer.provide(Layer.succeedContext(node.context)),
    ),
  );
  const project = (itemId: string) =>
    node.vault.applySynced({
      itemId,
      sourceLabel: "Peer",
      extras: {},
      payload: {
        name: input.name,
        type: "api_key",
        scopeProjectId: null,
        allowedDomains: [input.host],
        createdAt: "2026-10-01T00:00:00.000Z",
        updatedAt: "2026-10-02T00:00:00.000Z",
        secretFields: {
          value: "peer-access",
          password: "peer-refresh",
          username: "peer-client-secret",
        },
        attachment: encodeAttachment(attachment("peer-client")) as Record<string, Schema.Json>,
      },
    });
  return { node, hooks, project, tokens: Context.get(context, Tokens.IntegrationTokens) };
});

describe("IntegrationTokens snapshots", () => {
  it.effect("reads tokens, client, attachment and revision from the same row", () =>
    Effect.gen(function* () {
      const { tokens, hooks, project } = yield* harness;
      const written = yield* tokens.write(input);
      hooks.afterRead = project(written.itemId);
      const first = yield* tokens.read(written.itemId);
      expect(Option.getOrThrow(first)).toEqual({
        tokens: input.tokens,
        attachment: input.attachment,
        revision: written.revision,
      });
      const second = Option.getOrThrow(yield* tokens.read(written.itemId));
      expect(second.revision).toBe(written.revision + 1);
      expect(second.tokens.accessToken).toBe("peer-access");
      expect(second.attachment?.registration?.clientId).toBe("peer-client");
    }).pipe(Effect.scoped),
  );

  it.effect.each([true, false])(
    "returns the written revision even when a peer writes after commit (create=%s)",
    (creating) =>
      Effect.gen(function* () {
        const { node, tokens, hooks, project } = yield* harness;
        const previous = creating ? undefined : yield* tokens.write(input);
        hooks.afterCommit = Effect.gen(function* () {
          const [row] = yield* node.sql<{
            id: string;
          }>`SELECT id FROM vault_items WHERE name = ${input.name}`;
          yield* project(row!.id);
        });
        const written = yield* tokens.write({ ...input, itemId: previous?.itemId });
        expect(written.revision).toBe(creating ? 1 : 2);
        expect(yield* node.vault.credentialRevision(VaultItemId.make(written.itemId))).toBe(
          written.revision + 1,
        );
      }).pipe(Effect.scoped),
  );
});
