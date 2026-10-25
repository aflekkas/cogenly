/**
 * Keeps this machine's settings.json in step with the shared `settings`
 * documents, so universal settings and project overrides follow the user to
 * every paired machine. SharedSync moves the documents; this service only
 * reconciles them with the local file, after every local settings change and
 * every shared change. Machine-local keys never enter a document.
 *
 * A project override is stored per local repository (the key every
 * resolver reads), and the project document keeps all of the project's
 * repositories, on every machine, carrying the same entry.
 *
 * @module SettingsSync
 */
import { type ProjectId, type ServerSettingsError, SharedStateError } from "@cogenly/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import { ServerSettingsService } from "../serverSettings.ts";
import { SharedState } from "./SharedState.ts";
import {
  projectSettingsDocumentId,
  settingsDocumentAddress,
  UNIVERSAL_SETTINGS_DOCUMENT_ID,
} from "./settingsDocument.ts";
import {
  canonicalJson,
  planSettingsReconcile,
  settingsBaseKey,
  type SettingsReconcilePlan,
} from "./settingsReconcile.ts";

export class SettingsSync extends Context.Service<
  SettingsSync,
  {
    /** One reconciliation pass; serialized, and a no-op when both sides agree. */
    readonly reconcile: Effect.Effect<void, SharedStateError | ServerSettingsError>;
  }
>()("cogenly-server/sync/SettingsSync") {}

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json));
const isSharedStateError = Schema.is(SharedStateError);
const storage = (cause: unknown) =>
  isSharedStateError(cause) ? cause : new SharedStateError({ reason: "storage", cause });

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const shared = yield* SharedState;
  const settings = yield* ServerSettingsService;
  const permit = yield* Semaphore.make(1);

  const readInputs = Effect.gen(function* () {
    const baseRows = yield* sql<{
      document_id: string;
      scope: string;
      key: string;
      value_json: string;
    }>`SELECT document_id,scope,key,value_json FROM settings_sync_base`;
    const memberships = yield* sql<{
      label_id: string;
      repository_id: string;
    }>`SELECT r.label_id,r.repository_id FROM label_repositories r JOIN projection_projects p ON p.project_id=r.repository_id WHERE p.deleted_at IS NULL ORDER BY r.label_id,r.repository_id`;
    const projects = new Map<string, ProjectId[]>();
    for (const row of memberships) {
      const repositories = projects.get(row.label_id) ?? [];
      repositories.push(row.repository_id as ProjectId);
      projects.set(row.label_id, repositories);
    }
    const documents = new Map<string, Readonly<Record<string, Schema.Json>>>();
    for (const id of [
      UNIVERSAL_SETTINGS_DOCUMENT_ID,
      ...[...projects.keys()].map(projectSettingsDocumentId),
    ]) {
      const address = settingsDocumentAddress(id);
      const document = yield* shared.get(address.kind, address.id);
      if (document) documents.set(id, document.fields);
    }
    const base = new Map(
      baseRows.map((row) => [
        settingsBaseKey(row.document_id, row.scope, row.key),
        decodeJson(row.value_json),
      ]),
    );
    return { base, documents, projects };
  }).pipe(Effect.mapError(storage));

  const recordBase = (entries: SettingsReconcilePlan["base"]) =>
    sql
      .withTransaction(
        Effect.forEach(
          entries,
          (entry) =>
            sql`INSERT INTO settings_sync_base(document_id,scope,key,value_json) VALUES (${entry.documentId},${entry.scope},${entry.key},${canonicalJson(entry.value)}) ON CONFLICT(document_id,scope,key) DO UPDATE SET value_json=excluded.value_json`,
          { discard: true },
        ),
      )
      .pipe(Effect.mapError(storage));

  const reconcile = permit.withPermits(1)(
    Effect.gen(function* () {
      const inputs = yield* readInputs;
      let plan: SettingsReconcilePlan | undefined;
      // Decided against the stored snapshot inside the settings write lock, so
      // a local edit cannot slip between the decision and the file write.
      yield* settings.updateStoredSettings((current) => {
        plan = planSettingsReconcile({ settings: current, ...inputs });
        return plan.settings;
      });
      if (plan === undefined) return;
      // Publish before recording, and record applied values only after the
      // file write: an interrupted pass then repeats rather than reverting.
      for (const [documentId, fields] of plan.publish) {
        const address = settingsDocumentAddress(documentId);
        yield* shared.write(address.kind, address.id, fields);
      }
      if (plan.base.length > 0) yield* recordBase(plan.base);
    }),
  );

  return SettingsSync.of({ reconcile });
});

/** The service alone, for tests that drive passes explicitly. */
export const layerWithoutWatch = Layer.effect(SettingsSync, make);

/** Reconciles at startup, after every settings change and after every shared change. */
export const layer = Layer.effect(
  SettingsSync,
  Effect.gen(function* () {
    const service = yield* make;
    const settings = yield* ServerSettingsService;
    const shared = yield* SharedState;
    const wake = yield* Queue.sliding<void>(1);
    yield* Stream.merge(settings.streamChanges, shared.changes).pipe(
      Stream.runForEach(() => Queue.offer(wake, undefined)),
      Effect.forkScoped,
    );
    yield* Effect.gen(function* () {
      yield* settings.ready;
      yield* Queue.offer(wake, undefined);
      return yield* Effect.forever(
        Queue.take(wake).pipe(
          Effect.andThen(service.reconcile),
          Effect.catch((error) =>
            Effect.logWarning("Settings sync pass deferred", { reason: error.message }),
          ),
        ),
      );
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Settings sync did not start", { reason: error.message }),
      ),
      Effect.forkScoped,
    );
    return service;
  }),
);
