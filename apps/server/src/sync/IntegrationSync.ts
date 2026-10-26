import {
  IntegrationId,
  SharedStateError,
  type Integration,
  type SharedDocumentChange,
} from "@cogenly/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as Machines from "../machines/Machines.ts";
import { StoredIntegration } from "../integrations/StoredIntegration.ts";
import { SharedState } from "./SharedState.ts";
import {
  decodeIntegrationFields,
  integrationFields,
  integrationNotSyncedReason,
} from "./integrationDocument.ts";

export class IntegrationSync extends Context.Service<
  IntegrationSync,
  {
    /** Called in the definition mutation's transaction; sign-ins never call it. */
    readonly publish: (
      current: Integration,
      previous?: Integration,
    ) => Effect.Effect<void, SharedStateError>;
    readonly reconcile: Effect.Effect<void, SharedStateError>;
    readonly changes: Stream.Stream<void>;
  }
>()("cogenly-server/sync/IntegrationSync") {}

const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(StoredIntegration));
const encode = Schema.encodeSync(Schema.fromJsonString(StoredIntegration));
const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const storage = (cause: unknown) => new SharedStateError({ reason: "storage", cause });
type Alias = { shared_name: string; local_name: string; applied_version: string };

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const shared = yield* SharedState;
  const machines = yield* Machines.Machines;
  const changes = yield* PubSub.unbounded<void>();
  const alias = (id: string) =>
    sql<Alias>`SELECT shared_name,local_name,applied_version FROM integration_sync_state WHERE integration_id=${id}`;

  const publish: IntegrationSync["Service"]["publish"] = (current, previous) =>
    Effect.gen(function* () {
      if (current.transport !== "http") return;
      const mapping = (yield* alias(current.id))[0];
      const portable = (value: Integration) =>
        integrationFields({
          ...value,
          name: mapping && value.name === mapping.local_name ? mapping.shared_name : value.name,
        });
      const fields = portable(current);
      if (fields === undefined) return;
      const before = previous === undefined ? undefined : portable(previous);
      const changed = Object.fromEntries(
        Object.entries(fields).filter(
          ([key, value]) =>
            before === undefined || json(value) !== json(before[key as keyof typeof before]),
        ),
      );
      // A delete is an irreversible shared tombstone, even after a local grant.
      yield* shared.write("integration", current.id, changed, current.deletedAt !== null);
    }).pipe(Effect.mapError(storage));

  const apply = Effect.fn("IntegrationSync.apply")(function* (document: SharedDocumentChange) {
    const rows = yield* sql<{
      payload_json: string;
    }>`SELECT payload_json FROM integrations WHERE id=${document.id}`;
    const current = rows[0] ? yield* decode(rows[0].payload_json) : undefined;
    // A received document cannot replace a definition intentionally kept local.
    if (current && integrationNotSyncedReason(current) !== undefined) return false;
    const mapping = (yield* alias(document.id))[0];
    const version = json({
      fields: document.fields,
      clocks: document.clocks,
      tombstone: document.tombstone,
    });
    if (mapping?.applied_version === version) return false;
    const at = DateTime.formatIso(yield* DateTime.now);
    if (document.tombstone) {
      if (!current || current.deletedAt !== null) return false;
      const { oauthState: _, ...rest } = current;
      yield* sql`UPDATE integrations SET deleted_at=${at},updated_at=${at},payload_json=${encode({ ...rest, deletedAt: at, updatedAt: at })} WHERE id=${document.id}`;
      return true;
    }
    const parsed = decodeIntegrationFields(document.fields);
    // Partially deferred definitions wait until every required safe field is readable.
    if (Option.isNone(parsed) || current?.deletedAt) return false;
    const fields = parsed.value;
    const clashes = (name: string) =>
      sql<{
        id: string;
      }>`SELECT id FROM integrations WHERE name=${name} AND id<>${document.id} AND deleted_at IS NULL`;
    let name = mapping?.shared_name === fields.name ? mapping.local_name : fields.name;
    if ((yield* clashes(name)).length > 0) {
      const suffix = document.id
        .replace(/^integration:/, "")
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, "-")
        .slice(0, 6);
      name = `${fields.name.slice(0, 57)}-${suffix}`;
      // Also deterministic if a local row already owns the short alias.
      let ordinal = 2;
      const stem = name;
      while ((yield* clashes(name)).length > 0) name = `${stem.slice(0, 58)}-${ordinal++}`;
    }
    const scopeDoesNotWiden =
      current?.scope.type === "all" ||
      (current?.scope.type === "projects" &&
        fields.scope.type === "projects" &&
        fields.scope.labelIds.every(
          (id) => current.scope.type === "projects" && current.scope.labelIds.includes(id),
        ));
    const sameDestination =
      current !== undefined &&
      scopeDoesNotWiden &&
      current.url === fields.url &&
      current.auth?.type === fields.auth?.type &&
      current.auth?.scope === fields.auth?.scope;
    const origin = document.clocks.createdAt?.node ?? document.updatedBy;
    const registry = yield* machines.list;
    const machineLabel =
      registry.machines.find((machine) => machine.environmentId === origin)?.name ??
      "another machine";
    // Local secrets and approvals survive cosmetic edits and scope narrowing. A peer cannot
    // retarget any grant, static header, or manually registered OAuth client.
    const local = sameDestination && current ? current : undefined;
    const integration: StoredIntegration = {
      id: IntegrationId.make(document.id),
      name,
      displayName: fields.displayName,
      hint: fields.hint,
      url: fields.url,
      transport: "http",
      enabled: fields.enabled,
      scope: fields.scope,
      createdAt: fields.createdAt,
      updatedAt: at,
      deletedAt: null,
      headers: local?.headers ?? {},
      ...(local?.endpointRef === undefined ? {} : { endpointRef: local.endpointRef }),
      approvedCredentialItems: local?.approvedCredentialItems ?? [],
      ...(local?.credentialOrigin === undefined
        ? {}
        : { credentialOrigin: local.credentialOrigin }),
      ...(local?.provenance === undefined ? {} : { provenance: local.provenance }),
      ...(current?.accountLabel === undefined ? {} : { accountLabel: current.accountLabel }),
      // Setup notes record this machine's setup (its redirect URIs, its client); they stay local.
      ...(current?.setupNotes === undefined
        ? {}
        : { setupNotes: current.setupNotes, setupNotesUpdatedAt: current.setupNotesUpdatedAt }),
      ...(local?.browserOrigin === undefined ? {} : { browserOrigin: local.browserOrigin }),
      ...(fields.auth === null ? {} : { auth: { ...local?.auth, ...fields.auth } }),
      ...(local?.oauthState === undefined ? {} : { oauthState: local.oauthState }),
      ...(origin === shared.environmentId ? {} : { syncedFrom: { machineLabel } }),
    };
    yield* sql`INSERT INTO integrations(id,name,payload_json,deleted_at,updated_at) VALUES (${integration.id},${name},${encode(integration)},NULL,${at}) ON CONFLICT(id) DO UPDATE SET name=excluded.name,payload_json=excluded.payload_json,deleted_at=NULL,updated_at=excluded.updated_at`;
    yield* sql`INSERT INTO integration_sync_state(integration_id,shared_name,local_name,applied_version) VALUES (${document.id},${fields.name},${name},${version}) ON CONFLICT(integration_id) DO UPDATE SET shared_name=excluded.shared_name,local_name=excluded.local_name,applied_version=excluded.applied_version`;
    return true;
  });

  const reconcile = Effect.gen(function* () {
    // Bootstrap existing web definitions once. Later edits publish in their
    // transaction, so a grant or a collision alias never becomes a peer edit.
    const rows = yield* sql<{
      payload_json: string;
    }>`SELECT payload_json FROM integrations WHERE deleted_at IS NULL ORDER BY id`;
    for (const row of rows) {
      const current = yield* decode(row.payload_json);
      const fields = integrationFields(current);
      if (
        fields !== undefined &&
        Option.isSome(decodeIntegrationFields(fields)) &&
        !(yield* shared.get("integration", current.id))
      )
        yield* publish(current);
    }
    const documents = yield* sql<{
      id: string;
    }>`SELECT id FROM shared_documents WHERE kind='integration' ORDER BY id`;
    let changed = false;
    for (const { id } of documents) {
      const document = yield* shared.get("integration", id);
      if (document) changed = (yield* apply(document)) || changed;
    }
    return changed;
  }).pipe(
    sql.withTransaction,
    Effect.mapError(storage),
    Effect.tap((changed) => (changed ? PubSub.publish(changes, undefined) : Effect.void)),
    Effect.asVoid,
  );
  return IntegrationSync.of({ publish, reconcile, changes: Stream.fromPubSub(changes) });
});

export const layerWithoutWatch = Layer.effect(IntegrationSync, make);
export const layer = Layer.effect(
  IntegrationSync,
  Effect.gen(function* () {
    const service = yield* make;
    const shared = yield* SharedState;
    // Subscribe before the initial pass; local writes and receives both wake it.
    yield* Stream.merge(Stream.make(undefined), shared.changes).pipe(
      Stream.runForEach(() =>
        service.reconcile.pipe(
          Effect.catch(() => Effect.logWarning("Integration sync pass deferred")),
        ),
      ),
      Effect.forkScoped,
    );
    return service;
  }),
);
