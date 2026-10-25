import {
  SharedDocumentKind,
  SharedStateError,
  type SharedSyncStatusInput,
  type SharedSyncStatusResult,
} from "@cogenly/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Machines from "../machines/Machines.ts";
import * as SharedState from "./SharedState.ts";

export class SharedSyncStatus extends Context.Service<
  SharedSyncStatus,
  {
    /** Per directly paired machine, what it has not yet acknowledged from this one. */
    readonly status: (
      input: SharedSyncStatusInput,
    ) => Effect.Effect<SharedSyncStatusResult, SharedStateError>;
  }
>()("cogenly-server/sync/SharedSyncStatus") {}

const storage = (cause: unknown) => new SharedStateError({ reason: "storage", cause });
const isSharedStateError = Schema.is(SharedStateError);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const state = yield* SharedState.SharedState;
  const machines = yield* Machines.Machines;
  const status: SharedSyncStatus["Service"]["status"] = Effect.fn("SharedSyncStatus.status")(
    function* (input) {
      const view = yield* machines.list.pipe(Effect.mapError(storage));
      const kinds = input.kinds ?? SharedDocumentKind.literals;
      // Mirrors SharedState.readBatch: a spoke sends only its own edits, a hub
      // relays everything except what the peer itself authored.
      const localOnly = view.link._tag === "spoke";
      const peers = [];
      for (const machine of view.machines) {
        if (machine.relation !== "hub" && machine.relation !== "spoke") continue;
        const { acknowledged } = yield* state.cursors(machine.environmentId);
        const counts =
          kinds.length === 0
            ? []
            : yield* sql<{
                kind: string;
                count: number;
              }>`SELECT json_extract(change_json,'$.kind') AS kind,COUNT(*) AS count FROM shared_changes WHERE cursor>${acknowledged} AND json_extract(change_json,'$.updatedBy')<>${machine.environmentId} AND (${localOnly ? 1 : 0}=0 OR json_extract(change_json,'$.updatedBy')=${state.environmentId}) AND json_extract(change_json,'$.kind') IN ${sql.in(kinds)} GROUP BY 1`;
        peers.push({
          environmentId: machine.environmentId,
          label: machine.name,
          online: machine.online,
          relation: machine.relation,
          kinds: kinds.map((kind) => ({
            kind,
            pendingOutgoing: counts.find((row) => row.kind === kind)?.count ?? 0,
          })),
        });
      }
      return { peers };
    },
    Effect.mapError((cause) => (isSharedStateError(cause) ? cause : storage(cause))),
  );
  return SharedSyncStatus.of({ status });
});

export const layer = Layer.effect(SharedSyncStatus, make).pipe(Layer.provide(SharedState.layer));
