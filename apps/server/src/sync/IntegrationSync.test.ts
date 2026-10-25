import { describe, expect, it } from "@effect/vitest";
import {
  IntegrationId,
  IntegrationName,
  ProjectLabelId,
  type IntegrationScope,
  type SharedDocumentChangeWire,
} from "@cogenly/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import { FetchHttpClient } from "effect/http";
import * as Machines from "../machines/Machines.ts";
import { pair, startMachine } from "../machines/testkit.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as Integrations from "../integrations/Integrations.ts";
import * as Credentials from "../integrations/IntegrationCredentials.ts";
import * as IntegrationSyncPeers from "../integrations/IntegrationSyncPeers.ts";
import { mapNativeIntegrations } from "../integrations/NativeIntegrationImport.ts";
import * as Tokens from "../integrations/IntegrationTokens.ts";
import { StoredIntegration } from "../integrations/StoredIntegration.ts";
import * as IntegrationSync from "./IntegrationSync.ts";
import * as SharedState from "./SharedState.ts";
import * as SharedSync from "./SharedSync.ts";

const encode = Schema.encodeSync(Schema.fromJsonString(StoredIntegration));
const decode = Schema.decodeUnknownSync(Schema.fromJsonString(StoredIntegration));
const at = "2026-01-01T00:00:00.000Z";
const definition = (id: string, name = "linear"): StoredIntegration => ({
  id: IntegrationId.make(id),
  name: IntegrationName.make(name),
  displayName: "Linear",
  transport: "http",
  url: "https://mcp.linear.app/mcp",
  headers: {},
  auth: { type: "oauth" },
  enabled: true,
  scope: { type: "all" },
  hint: "Work",
  createdAt: at,
  updatedAt: at,
  deletedAt: null,
});

const start = Effect.fn("startIntegrationMachine")(function* (
  name: string,
  role: "computer" | "cloud-server",
) {
  const machine = yield* startMachine(name, role);
  const sql = yield* machine.run(SqlClient.SqlClient);
  const stateContext = yield* machine.run(Layer.build(SharedState.layer));
  const state = yield* SharedState.SharedState.pipe(Effect.provideContext(stateContext));
  const quietState = Layer.succeed(SharedState.SharedState, { ...state, changes: Stream.never });
  const context = yield* machine.run(
    Layer.build(
      Layer.mergeAll(
        SharedSync.layer.pipe(
          Layer.provide(
            Layer.succeed(Machines.Machines, { ...machine.machines, subscribe: Stream.never }),
          ),
          Layer.provide(Layer.succeed(Scheduler.Scheduler, { register: () => Effect.void })),
        ),
        Integrations.layer.pipe(
          Layer.provide(IntegrationSyncPeers.layerFor(machine.environmentId)),
          Layer.provide(
            Layer.succeed(Credentials.IntegrationCredentials, {
              resolve: () => Effect.succeedNone,
            }),
          ),
          Layer.provide(
            Layer.succeed(Tokens.IntegrationTokens, {
              read: () => Effect.succeedNone,
              revision: () => Effect.succeedSome(1),
              clientSecret: () => Effect.succeed(undefined),
              backfillAttachment: () => Effect.void,
              clearGrant: () => Effect.void,
              attached: Effect.succeed([]),
              syncedChanges: Stream.never,
              write: () => Effect.die("No sign-in in sync tests"),
              remove: () => Effect.void,
            }),
          ),
          Layer.provide(Layer.succeed(Credentials.IntegrationSecrets, { save: () => Effect.void })),
          Layer.provide(FetchHttpClient.layer),
        ),
      ).pipe(
        Layer.provideMerge(IntegrationSync.layerWithoutWatch),
        Layer.provide(quietState),
        Layer.provide(Layer.succeed(Machines.Machines, machine.machines)),
      ),
    ),
  );
  const provide = Effect.provideContext(context);
  const service = yield* IntegrationSync.IntegrationSync.pipe(provide);
  const integrations = yield* Integrations.Integrations.pipe(provide);
  const store = (integration: StoredIntegration) =>
    sql`INSERT INTO integrations(id,name,payload_json,deleted_at,updated_at) VALUES (${integration.id},${integration.name},${encode(integration)},${integration.deletedAt},${integration.updatedAt}) ON CONFLICT(id) DO UPDATE SET name=excluded.name,payload_json=excluded.payload_json,deleted_at=excluded.deleted_at,updated_at=excluded.updated_at`;
  const read = (id: string) =>
    sql<{ payload_json: string }>`SELECT payload_json FROM integrations WHERE id=${id}`.pipe(
      Effect.map((rows) => (rows[0] ? decode(rows[0].payload_json) : undefined)),
    );
  return {
    ...machine,
    state,
    sql,
    store,
    read,
    integrations,
    reconcile: service.reconcile,
    publish: service.publish,
    sync: yield* SharedSync.SharedSync.pipe(provide),
  };
});
const exchange = (
  hub: Effect.Success<ReturnType<typeof start>>,
  spoke: Effect.Success<ReturnType<typeof start>>,
) =>
  Effect.gen(function* () {
    yield* hub.reconcile;
    yield* spoke.reconcile;
    yield* spoke.sync.sync(hub.environmentId);
    yield* hub.reconcile;
    yield* spoke.reconcile;
  });

const paired = Effect.gen(function* () {
  const hub = yield* start("integrations-hub", "cloud-server");
  const spoke = yield* start("integrations-spoke", "computer");
  yield* pair(hub, spoke);
  return { hub, spoke };
});

describe("integration definitions between paired machines", () => {
  it.live(
    "private paths never enter shared documents, from native import, direct creation or legacy rows",
    () =>
      Effect.gen(function* () {
        const { hub, spoke } = yield* paired;
        const privateUrl = "https://vendor.example/sse/bearer-PRIVATE-capability";
        const imported = mapNativeIntegrations(
          { mcpServers: { private: { url: privateUrl } } },
          {},
        );
        const direct = (yield* hub.integrations.create({
          ...definition("integration:unused", "direct"),
          url: privateUrl,
        })).integration;
        const native = (yield* hub.integrations.create(imported.definitions[0]!)).integration;
        const legacy = { ...definition("integration:legacy", "legacy"), url: privateUrl };
        yield* hub.store(legacy);
        yield* exchange(hub, spoke);
        for (const id of [direct.id, native.id]) {
          expect((yield* hub.read(id))?.endpointRef).toBeDefined();
          expect((yield* spoke.read(id))?.url).toBe("https://vendor.example/");
          expect(JSON.stringify(yield* hub.state.get("integration", id))).not.toContain(
            "bearer-PRIVATE",
          );
        }
        expect(yield* spoke.read(legacy.id)).toBeUndefined();
        expect(JSON.stringify(yield* hub.state.get("integration", legacy.id))).not.toContain(
          "bearer-PRIVATE",
        );
      }).pipe(Effect.scoped),
    20000,
  );

  it.live(
    "URL credentials and unrecognized query parameters never publish or bootstrap",
    () =>
      Effect.gen(function* () {
        const { hub, spoke } = yield* paired;
        const queries = [
          "api_key=secret",
          "token=secret",
          "key=secret",
          "access_token=secret",
          "X-Amz-Signature=secret",
          "sig=secret",
          "unknown=secret",
          "%74oken=secret",
        ];
        for (const [index, query] of queries.entries()) {
          const url = `https://example.com/mcp?${query}`;
          const created = (yield* hub.integrations.create({
            name: IntegrationName.make(`query-${index}`),
            displayName: "Private endpoint",
            transport: "http",
            url,
            headers: {},
            scope: { type: "all" },
            hint: "",
          })).integration;
          expect(yield* hub.state.get("integration", created.id)).toBeUndefined();
          const existing = {
            ...definition(`integration:bootstrap-${index}`, `bootstrap-${index}`),
            url,
          };
          yield* hub.store(existing);
          yield* exchange(hub, spoke);
          expect(yield* hub.state.get("integration", existing.id)).toBeUndefined();
          expect(yield* spoke.read(created.id)).toBeUndefined();
          expect(yield* spoke.read(existing.id)).toBeUndefined();
          const summary = (yield* hub.integrations.list()).integrations.find(
            (item) => item.integration.id === created.id,
          )!;
          expect(summary).toHaveProperty(
            "notSyncedReason",
            "Not synced: URL query parameters may contain credentials.",
          );
        }
        // A previously shared endpoint can become local without exporting its new URL
        // or having the old shared document overwrite the local edit on reconciliation.
        const original = definition("integration:query-edit", "query-edit");
        yield* hub.store(original);
        yield* exchange(hub, spoke);
        const url = "https://example.com/mcp?token=local-secret";
        yield* hub.integrations.update({ id: original.id, url });
        yield* exchange(hub, spoke);
        expect((yield* hub.read(original.id))?.url).toBe(url);
        expect(
          JSON.stringify((yield* hub.state.get("integration", original.id))?.fields),
        ).not.toContain("local-secret");
        expect((yield* spoke.read(original.id))?.url).toBe(original.url);
        // The way back becomes shareable again.
        yield* hub.integrations.update({ id: original.id, url: "https://example.com/sse" });
        yield* exchange(hub, spoke);
        expect((yield* spoke.read(original.id))?.url).toBe("https://example.com/sse");
      }).pipe(Effect.scoped),
    20000,
  );

  it.live(
    "scope widening clears local authorization while narrowing preserves it",
    () =>
      Effect.gen(function* () {
        const { hub, spoke } = yield* paired;
        const projects = (...ids: string[]): IntegrationScope => ({
          type: "projects",
          labelIds: ids.map((id) => ProjectLabelId.make(id)),
        });
        const cases: ReadonlyArray<{
          from: IntegrationScope;
          to: IntegrationScope;
          keep: boolean;
        }> = [
          { from: projects("label:a"), to: { type: "all" }, keep: false },
          { from: projects("label:a"), to: projects("label:a", "label:b"), keep: false },
          { from: projects("label:a"), to: projects("label:b"), keep: false },
          { from: { type: "all" }, to: projects("label:a"), keep: true },
          { from: projects("label:a", "label:b"), to: projects("label:a"), keep: true },
          { from: projects("label:a", "label:b"), to: projects("label:b", "label:a"), keep: true },
        ];
        for (const [index, scenario] of cases.entries()) {
          const original = {
            ...definition(`integration:scope-${index}`, `scope-${index}`),
            scope: scenario.from,
          };
          yield* hub.store(original);
          yield* exchange(hub, spoke);
          const credentials = {
            headers: { authorization: "Bearer {{credential:local-item.value}}" },
            approvedCredentialItems: ["local-item"],
            oauthState: { signedIn: true, tokenItemId: "local-token" },
            auth: {
              type: "oauth" as const,
              clientId: "local-client",
              clientSecret: "{{credential:local-client.secret}}",
            },
          };
          yield* spoke.store({ ...(yield* spoke.read(original.id))!, ...credentials });
          yield* hub.integrations.update({ id: original.id, scope: scenario.to });
          yield* exchange(hub, spoke);
          const received = (yield* spoke.read(original.id))!;
          expect(received.scope).toEqual(scenario.to);
          expect(received.headers).toEqual(scenario.keep ? credentials.headers : {});
          expect(received.approvedCredentialItems).toEqual(
            scenario.keep ? credentials.approvedCredentialItems : [],
          );
          expect(received.oauthState).toEqual(scenario.keep ? credentials.oauthState : undefined);
          expect(received.auth).toEqual(scenario.keep ? credentials.auth : { type: "oauth" });
        }
      }).pipe(Effect.scoped),
    20000,
  );

  it.live(
    "web definitions need local sign-in; cosmetic edits preserve the local grant and never send it",
    () =>
      Effect.gen(function* () {
        const { hub, spoke } = yield* paired;
        const { id } = (yield* hub.integrations.create({
          name: IntegrationName.make("linear"),
          displayName: "Linear",
          transport: "http",
          url: "https://mcp.linear.app/mcp",
          headers: { authorization: "Bearer private-literal" },
          auth: {
            type: "oauth",
            clientId: "local-client",
            clientSecret: "{{credential:linear-client.secret}}",
            scope: "read",
          },
          scope: { type: "all" },
          hint: "Work",
        })).integration;
        yield* exchange(hub, spoke);
        const received = (yield* spoke.integrations.list()).integrations[0]!;
        expect(received.status).toBe("needs_sign_in");
        expect(received.syncedFrom).toEqual({ machineLabel: "integrations-hub" });
        expect(received.setup?.type).toBe("sign_in");
        expect(received.setup?.title).toBe("Sign in on this machine");
        expect(received.integration.headers).toEqual({});
        expect(received.integration.auth).toEqual({ type: "oauth", scope: "read" });
        expect(received.integration.approvedCredentialItems).toEqual([]);
        const local = (yield* spoke.read(id))!;
        yield* spoke.store({
          ...local,
          oauthState: { signedIn: true, tokenItemId: "local-token" },
        });
        expect((yield* spoke.integrations.list()).integrations[0]?.syncedFrom).toBeUndefined();
        yield* spoke.integrations.update({ id, displayName: "Team", enabled: false });
        yield* exchange(hub, spoke);
        expect((yield* hub.read(id))?.displayName).toBe("Team");
        expect((yield* hub.read(id))?.enabled).toBe(false);
        expect((yield* spoke.read(id))?.oauthState?.signedIn).toBe(true);
        expect(JSON.stringify((yield* spoke.state.get("integration", id))?.fields)).not.toMatch(
          /local-token|private-literal|clientId|clientSecret|headers|approvedCredential/,
        );
        // Peer URL edits discard this machine's grant and cannot retarget its headers.
        yield* hub.integrations.update({ id, url: "https://mcp.linear.app/sse" });
        yield* exchange(hub, spoke);
        expect((yield* spoke.read(id))?.oauthState).toBeUndefined();
        expect((yield* spoke.read(id))?.headers).toEqual({});
        yield* spoke.integrations.remove(id);
        yield* exchange(hub, spoke);
        expect((yield* hub.read(id))?.deletedAt).not.toBeNull();
        expect((yield* hub.state.get("integration", id))?.tombstone).not.toBeNull();
        expect((yield* hub.integrations.list()).integrations).toEqual([]);
      }).pipe(Effect.scoped),
    20000,
  );

  it.live(
    "imported native definitions: web ones ask for sign-in on the peer, command runners stay home",
    () =>
      Effect.gen(function* () {
        const { hub, spoke } = yield* paired;
        // What the Mac's import creates from its Claude config.
        const preview = mapNativeIntegrations(
          {
            mcpServers: {
              linear: { type: "http", url: "https://mcp.linear.app/mcp" },
              notion: {
                type: "http",
                url: "https://mcp.notion.com/mcp",
                headers: { Authorization: "Bearer native-private" },
              },
              repl: { command: "node", env: { TOKEN: "native-private" } },
            },
          },
          {},
        );
        for (const imported of preview.definitions) yield* hub.integrations.create(imported);
        yield* exchange(hub, spoke);

        const received = (yield* spoke.integrations.list()).integrations;
        expect(received.map((summary) => summary.integration.name).sort()).toEqual([
          "claude-linear",
          "claude-notion",
        ]);
        for (const summary of received) {
          expect(summary.status).toBe("needs_sign_in");
          expect(summary.setup?.title).toBe("Sign in on this machine");
          expect(summary.integration.enabled).toBe(false);
          // Credentials reach a peer only through vault sync, never in the definition.
          expect(summary.integration.headers).toEqual({});
        }
        const shared = yield* hub.sql<{
          fields_json: string;
        }>`SELECT fields_json FROM shared_documents WHERE kind = 'integration'`;
        expect(shared).toHaveLength(2);
        expect(JSON.stringify(shared)).not.toMatch(/native-private|credential:|"node"/);
      }).pipe(Effect.scoped),
    20000,
  );

  it.live(
    "a public HTTP endpoint has no local sign-in to complete",
    () =>
      Effect.gen(function* () {
        const { hub, spoke } = yield* paired;
        const { auth: _, ...publicEndpoint } = definition("integration:public", "public");
        yield* hub.store({ ...publicEndpoint, url: "https://public.example/mcp" });
        yield* exchange(hub, spoke);
        const summary = (yield* spoke.integrations.list()).integrations[0]!;
        expect(summary.status).toBe("unknown");
        expect(summary.syncedFrom).toBeUndefined();
        expect(summary.setup).toBeUndefined();
      }).pipe(Effect.scoped),
    20000,
  );

  it.live(
    "command runners never sync, and forged headers, approvals and local transports never execute",
    () =>
      Effect.gen(function* () {
        const { hub, spoke } = yield* paired;
        const local = {
          ...definition("integration:local"),
          transport: "local" as const,
          local: {
            preset: "google-workspace" as const,
            version: "1",
            callbackOrigin: "http://localhost",
          },
        };
        yield* hub.store(local);
        yield* exchange(hub, spoke);
        expect(yield* hub.state.get("integration", local.id)).toBeUndefined();
        expect(yield* spoke.read(local.id)).toBeUndefined();
        const wall = yield* Clock.currentTimeMillis;
        const send = (id: string, fields: Record<string, Schema.Json>) =>
          Effect.gen(function* () {
            const after = (yield* spoke.state.cursors(hub.environmentId)).received;
            const change: SharedDocumentChangeWire = {
              kind: "integration",
              id,
              fields,
              clocks: Object.fromEntries(
                Object.keys(fields).map((key) => [
                  key,
                  { wall, logical: 0, node: hub.environmentId },
                ]),
              ),
              tombstone: null,
              updatedBy: hub.environmentId,
            };
            yield* spoke.state.receive(
              { after, cursor: after + 1, changes: [change] },
              hub.environmentId,
              false,
            );
            yield* spoke.reconcile;
          });
        const fields = {
          name: "forged",
          displayName: "Forged",
          hint: "",
          transport: "local",
          url: "file:///bin/sh",
          auth: null,
          scope: { type: "all" },
          enabled: true,
          createdAt: at,
        } satisfies Record<string, Schema.Json>;
        yield* send("integration:forged", fields);
        expect(yield* spoke.read("integration:forged")).toBeUndefined();
        yield* send("integration:credential-url", {
          ...fields,
          transport: "http",
          url: "https://example.com/mcp?token=peer-secret",
        });
        expect(yield* spoke.read("integration:credential-url")).toBeUndefined();
        yield* send("integration:safe", {
          ...fields,
          transport: "http",
          url: "https://example.com/mcp",
          headers: { authorization: "stolen" },
          approvedCredentialItems: ["all"],
          local: { command: "sh" },
          oauthState: { signedIn: true },
        });
        const safe = yield* spoke.read("integration:safe");
        expect(safe?.transport).toBe("http");
        expect(safe?.headers).toEqual({});
        expect(safe?.approvedCredentialItems).toEqual([]);
        expect(safe?.local).toBeUndefined();
        expect(safe?.oauthState).toBeUndefined();
      }).pipe(Effect.scoped),
    20000,
  );

  it.live(
    "incoming name collisions get a stable local alias that never publishes back",
    () =>
      Effect.gen(function* () {
        const { hub, spoke } = yield* paired;
        const original = definition("integration:abcdef12");
        yield* hub.store(original);
        yield* spoke.store(definition("integration:local123"));
        // Publish the source first, then receive before bootstrapping the local row.
        yield* hub.reconcile;
        yield* spoke.sync.sync(hub.environmentId);
        yield* spoke.reconcile;
        const incoming = (yield* spoke.read(original.id))!;
        expect(incoming.name).toBe("linear-abcdef");
        yield* spoke.integrations.update({ id: incoming.id, displayName: "Changed here" });
        yield* exchange(hub, spoke);
        expect((yield* spoke.read(original.id))?.name).toBe("linear-abcdef");
        expect((yield* hub.state.get("integration", original.id))?.fields.name).toBe("linear");
        expect((yield* hub.read(original.id))?.name).toBe("linear");
        const count = yield* spoke.sql`SELECT COUNT(*) AS count FROM shared_changes`;
        yield* spoke.reconcile;
        expect(yield* spoke.sql`SELECT COUNT(*) AS count FROM shared_changes`).toEqual(count);
      }).pipe(Effect.scoped),
    20000,
  );

  it.live(
    "an older build retains unknown fields and keeps syncing after local edits",
    () =>
      Effect.gen(function* () {
        const { hub, spoke } = yield* paired;
        const original = definition("integration:newer");
        yield* hub.store(original);
        yield* exchange(hub, spoke);
        const wall = yield* Clock.currentTimeMillis;
        const after = (yield* spoke.state.cursors(hub.environmentId)).received;
        yield* spoke.state.receive(
          {
            after,
            cursor: after + 1,
            changes: [
              {
                kind: "integration",
                id: original.id,
                fields: { newerPreference: { color: "blue" } },
                clocks: { newerPreference: { wall, logical: 0, node: hub.environmentId } },
                tombstone: null,
                updatedBy: hub.environmentId,
              },
            ],
          },
          hub.environmentId,
          false,
        );
        yield* spoke.reconcile;
        yield* spoke.integrations.update({ id: original.id, enabled: false });
        expect((yield* spoke.state.get("integration", original.id))?.fields).toMatchObject({
          enabled: false,
          newerPreference: { color: "blue" },
        });
        expect((yield* spoke.state.cursors(hub.environmentId)).received).toBe(after + 1);
      }).pipe(Effect.scoped),
    20000,
  );
});
