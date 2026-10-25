import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as NodeSqliteClient from "@cogenly/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { migrationManifest, runMigrations } from "./Migrations.ts";

const layer = NodeSqliteClient.layer({ filename: ":memory:" }).pipe(
  Layer.provide(NodeServices.layer),
);

describe("v0.3.0 integrated migrations", () => {
  it.effect(
    "upgrades released main and preserves every shared document kind through settings",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        // v0.2.5 (512dbc2a) shipped through 091; its IDs and names must stay stable.
        yield* runMigrations({ toMigrationInclusive: 91 });
        const at = "2026-01-01T00:00:00.000Z";
        yield* sql`INSERT INTO project_labels(label_id,name,created_at,updated_at) VALUES ('label:keep','Keep',${at},${at})`;
        yield* sql`INSERT INTO label_repositories(label_id,repository_id,remote,directory_name) VALUES ('label:keep','repo:keep','github.com/test/keep','keep')`;
        yield* sql`INSERT INTO facts(id,status,payload_json,updated_at) VALUES ('fact:keep','confirmed','{"text":"preserved"}',${at})`;
        yield* sql`INSERT INTO vault_items(id,name,type,metadata_json,policy_json,allowed_domains_json,ciphertext,wrapped_keys_json,created_at,updated_at) VALUES ('vault:keep','Keep','note','{}','{}','[]','sealed','{}',${at},${at})`;
        yield* sql`INSERT INTO scheduled_tasks(task_id,title,prompt,enabled,schedule_json,project_id,workspace_strategy_json,model_selection_json,runtime_mode,interaction_mode,created_by,creation_source,created_at,updated_at,last_run_status,run_count) VALUES ('task:keep','Keep','Preserved prompt',0,'{}','repo:keep','{"type":"root"}','{}','full-access','default','user','web',${at},${at},'never',0)`;
        yield* sql`INSERT INTO accounts(id, payload_json) VALUES ('account:keep', '{}')`;
        yield* sql`INSERT INTO shared_documents(kind,id,fields_json,clocks_json,updated_by_env)
        VALUES ('project','project:keep','{}','{}','local')`;
        expect(yield* runMigrations({ toMigrationInclusive: 97 })).toEqual(
          migrationManifest.filter(([id]) => id > 91 && id <= 97),
        );
        // Settings and integration migrations must also preserve documents written
        // by vault, memory and a newer peer before this upgrade continues.
        for (const kind of ["fact", "vault", "future-kind"])
          yield* sql`INSERT INTO shared_documents(kind,id,fields_json,clocks_json,updated_by_env)
          VALUES (${kind},${kind + ":keep"},'{}','{}','local')`;
        expect(yield* runMigrations()).toEqual(migrationManifest.filter(([id]) => id > 97));
        expect(yield* sql`SELECT id FROM accounts`).toEqual([{ id: "account:keep" }]);
        expect(yield* sql`SELECT kind FROM shared_documents ORDER BY kind`).toEqual([
          { kind: "fact" },
          { kind: "future-kind" },
          { kind: "project" },
          { kind: "vault" },
        ]);
        expect(
          yield* sql`SELECT repository_id,remote,directory_name,icon_path FROM label_repositories`,
        ).toEqual([
          {
            repository_id: "repo:keep",
            remote: "github.com/test/keep",
            directory_name: "keep",
            icon_path: null,
          },
        ]);
        expect(
          yield* sql`SELECT id,status,payload_json,dedupe_key,duplicate_of FROM facts`,
        ).toEqual([
          {
            id: "fact:keep",
            status: "confirmed",
            payload_json: '{"text":"preserved"}',
            dedupe_key: null,
            duplicate_of: null,
          },
        ]);
        expect(
          yield* sql`SELECT id,ciphertext,portability,sync_attachment_json,sync_extras FROM vault_items`,
        ).toEqual([
          {
            id: "vault:keep",
            ciphertext: "sealed",
            portability: "shared",
            sync_attachment_json: null,
            sync_extras: null,
          },
        ]);
        expect(
          yield* sql`SELECT task_id,prompt,target_machine,project_folder_id FROM scheduled_tasks`,
        ).toEqual([
          {
            task_id: "task:keep",
            prompt: "Preserved prompt",
            target_machine: null,
            project_folder_id: null,
          },
        ]);
        yield* sql`SELECT icon_path FROM label_repositories`;
        yield* sql`SELECT meta_extra_json FROM thread_owners`;
        yield* sql`SELECT event_json FROM thread_replication_raw_events`;
        yield* sql`SELECT sharing_enabled FROM vault_peer_shares`;
        yield* sql`SELECT duplicate_of FROM facts`;
        yield* sql`SELECT value_json FROM settings_sync_base`;
        yield* sql`SELECT applied_version FROM integration_sync_state`;
        yield* sql`SELECT target_machine FROM scheduled_tasks`;
        const ids = migrationManifest.map(([id]) => id);
        expect(ids).toEqual(Array.from({ length: ids.at(-1)! }, (_, index) => index + 1));
        expect(
          yield* sql`SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id`,
        ).toEqual(migrationManifest.map(([id, name]) => ({ migration_id: id, name })));
        expect(yield* runMigrations()).toEqual([]);
      }).pipe(Effect.provide(layer)),
  );
});
