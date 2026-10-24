import * as Access from "../agents/AgentAccessScope.ts";
import { factDocumentId } from "../sync/documentSchemas.ts";
import * as SharedState from "../sync/SharedState.ts";
import {
  AgentId,
  Fact,
  FactError,
  FactHistoryEntry,
  FactId,
  ProjectLabelId,
  type ContextPrincipal,
  type FactCreateInput,
  type FactListInput,
  type FactSupersedeInput,
  type FactUpdateInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(Fact));
const encode = Schema.encodeEffect(Schema.fromJsonString(Fact));
const decodeHistory = Schema.decodeUnknownEffect(Schema.fromJsonString(FactHistoryEntry));
const encodeHistory = Schema.encodeEffect(Schema.fromJsonString(FactHistoryEntry));
const isError = Schema.is(FactError);
const failure = (operation: string) => (cause: unknown) =>
  isError(cause) ? cause : new FactError({ operation, reason: "storage", cause });

export class FactService extends Context.Service<
  FactService,
  {
    readonly list: (
      input: FactListInput & { readonly labelIds?: ReadonlyArray<ProjectLabelId> },
      principal?: ContextPrincipal,
    ) => Effect.Effect<{ facts: ReadonlyArray<Fact> }, FactError>;
    readonly create: (
      input: FactCreateInput,
      principal?: ContextPrincipal,
    ) => Effect.Effect<{ fact: Fact }, FactError>;
    readonly update: (input: FactUpdateInput) => Effect.Effect<{ fact: Fact }, FactError>;
    readonly supersede: (
      input: FactSupersedeInput,
      principal?: ContextPrincipal,
    ) => Effect.Effect<{ fact: Fact }, FactError>;
    readonly retract: (
      id: FactId,
      principal?: ContextPrincipal,
    ) => Effect.Effect<{ fact: Fact }, FactError>;
    readonly history: (
      id: FactId,
    ) => Effect.Effect<{ history: ReadonlyArray<FactHistoryEntry> }, FactError>;
    readonly readableLabels: (
      principal: ContextPrincipal,
    ) => Effect.Effect<ReadonlyArray<ProjectLabelId>, FactError>;
  }
>()("cogenly-server/context/FactService") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const access = yield* Access.AgentAccessScope;
  const crypto = yield* Crypto.Crypto;
  const shared = yield* SharedState.SharedState;
  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const owner = (principal: ContextPrincipal) =>
    principal === "user" ? undefined : AgentId.make(principal.slice(6));
  const readableLabels = (principal: ContextPrincipal) => {
    const agentId = owner(principal);
    return (
      agentId === undefined
        ? sql<{ label_id: string }>`SELECT label_id FROM project_labels`.pipe(
            Effect.map((rows) => rows.map((r) => ProjectLabelId.make(r.label_id))),
          )
        : access.resolve(agentId).pipe(Effect.map((scope) => scope.readableLabelIds))
    ).pipe(Effect.mapError(failure("scope")));
  };
  const accessPredicate = (principal: ContextPrincipal) =>
    Effect.gen(function* () {
      const id = owner(principal);
      if (id === undefined) return sql`1=1`;
      const scope = yield* access.resolve(id);
      return scope.agent.permissions.read
        ? sql`(f.agent_id = ${id} OR (json_extract(f.payload_json,'$.visibility') = 'labels' AND EXISTS (SELECT 1 FROM fact_labels fl WHERE fl.fact_id=f.id AND fl.label_id IN ${sql.in(scope.readableLabelIds)})))`
        : sql`0=1`;
    });
  const get = (id: FactId, principal: ContextPrincipal) =>
    Effect.gen(function* () {
      return yield* sql<{
        payload_json: string;
      }>`SELECT f.payload_json FROM facts f WHERE f.id = ${id} AND ${yield* accessPredicate(principal)}`.pipe(
        Effect.flatMap((rows) =>
          rows[0]
            ? decode(rows[0].payload_json).pipe(Effect.mapError(failure("read")))
            : Effect.fail(new FactError({ operation: "read", reason: "not_found" })),
        ),
      );
    });
  const authorizeWrite = (input: FactCreateInput, principal: ContextPrincipal) =>
    Effect.gen(function* () {
      for (const label of input.labelIds) {
        const rows = yield* sql`SELECT 1 FROM project_labels WHERE label_id = ${label}`;
        if (!rows.length) return yield* new FactError({ operation: "write", reason: "not_found" });
      }
      const id = owner(principal);
      if (input.agentId !== undefined) {
        const agents = yield* sql`SELECT 1 FROM agents WHERE agent_id = ${input.agentId}`;
        if (!agents.length)
          return yield* new FactError({ operation: "write", reason: "not_found" });
      }
      if (id === undefined) return;
      const scope = yield* access.resolve(id);
      if (
        !scope.agent.permissions.read ||
        !scope.agent.permissions.draft ||
        input.agentId !== id ||
        input.labelIds.some((label) => !scope.draftableLabelIds.includes(label))
      )
        return yield* new FactError({ operation: "write", reason: "forbidden" });
    });
  const persist = (fact: Fact, who: ContextPrincipal) =>
    Effect.gen(function* () {
      const payload = yield* encode(fact);
      yield* sql`INSERT INTO facts(id,agent_id,status,payload_json,updated_at) VALUES (${fact.id},${fact.agentId ?? null},${fact.status},${payload},${fact.updatedAt}) ON CONFLICT(id) DO UPDATE SET status=excluded.status,payload_json=excluded.payload_json,updated_at=excluded.updated_at`;
      yield* sql`DELETE FROM fact_labels WHERE fact_id = ${fact.id}`;
      for (const label of new Set(fact.labelIds))
        yield* sql`INSERT INTO fact_labels(fact_id,label_id) VALUES (${fact.id},${label})`;
      const history = yield* encodeHistory({
        id: yield* crypto.randomUUIDv4(),
        factId: fact.id,
        who,
        at: fact.updatedAt,
        fact,
      });
      yield* sql`INSERT INTO fact_history(fact_id,payload_json) VALUES (${fact.id},${history})`;
      // Paired machines receive the change from the same transaction.
      yield* shared.capture("fact", factDocumentId(fact.id));
      return { fact };
    });
  /** The fact as projected, which may hide it behind an identical one. */
  const projected = (id: FactId) =>
    sql<{ payload_json: string }>`SELECT payload_json FROM facts WHERE id = ${id}`.pipe(
      Effect.flatMap((rows) => decode(rows[0]?.payload_json ?? "")),
      Effect.map((fact) => ({ fact })),
    );
  /**
   * Copies hidden behind a fact (made on another machine, or proposed again)
   * follow it out of use, so they do not resurface once it is gone. Read them
   * before changing the fact: its projection re-places them.
   */
  const twinsOf = (id: FactId) =>
    sql<{ payload_json: string }>`SELECT payload_json FROM facts WHERE duplicate_of = ${id}`.pipe(
      Effect.flatMap((rows) => Effect.forEach(rows, (row) => decode(row.payload_json))),
    );
  const retire = (
    twins: ReadonlyArray<Fact>,
    change: (twin: Fact) => Fact,
    who: ContextPrincipal,
  ) =>
    Effect.forEach(twins, (twin) =>
      now.pipe(Effect.flatMap((updatedAt) => persist({ ...change(twin), updatedAt }, who))),
    );
  const create = (input: FactCreateInput, principal: ContextPrincipal) =>
    Effect.gen(function* () {
      if (input.visibility === "labels" && !input.labelIds.length)
        return yield* new FactError({ operation: "create", reason: "invalid_state" });
      yield* authorizeWrite(input, principal);
      const at = yield* now;
      return yield* persist(
        {
          ...input,
          labelIds: [...new Set(input.labelIds)],
          id: FactId.make(`fact:${yield* crypto.randomUUIDv4()}`),
          status: principal === "user" ? "confirmed" : "proposed",
          createdBy: principal,
          createdAt: at,
          updatedAt: at,
        },
        principal,
      );
    });
  const retract = (id: FactId, principal: ContextPrincipal = "user") =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const fact = yield* get(id, principal);
          yield* authorizeWrite(fact, principal);
          if (fact.status === "superseded")
            return yield* new FactError({ operation: "retract", reason: "invalid_state" });
          const twins = yield* twinsOf(id);
          yield* persist({ ...fact, status: "retracted", updatedAt: yield* now }, principal);
          yield* retire(twins, (twin) => ({ ...twin, status: "retracted" }), principal);
          return yield* projected(id);
        }),
      )
      .pipe(Effect.mapError(failure("retract")));
  return FactService.of({
    readableLabels,
    list: (input, principal = "user") =>
      Effect.gen(function* () {
        return yield* sql<{
          payload_json: string;
        }>`SELECT f.payload_json FROM facts f WHERE ${yield* accessPredicate(principal)}
      ${input.labelIds === undefined ? sql`` : sql`AND (${owner(principal) === undefined ? sql`0=1` : sql`f.agent_id=${owner(principal)!}`} OR EXISTS(SELECT 1 FROM fact_labels fl WHERE fl.fact_id=f.id AND fl.label_id IN ${sql.in(input.labelIds)}))`}
      ${input.agentId === undefined ? sql`` : sql`AND f.agent_id = ${input.agentId}`}
      ${input.status === undefined ? sql`` : sql`AND f.status = ${input.status}`}
      ${input.labelId === undefined ? sql`` : sql`AND EXISTS (SELECT 1 FROM fact_labels fl WHERE fl.fact_id=f.id AND fl.label_id=${input.labelId})`}
      ${!input.query ? sql`` : sql`AND instr(lower(json_extract(f.payload_json,'$.subject') || ' ' || json_extract(f.payload_json,'$.text')),lower(${input.query})) > 0`}
      ORDER BY f.updated_at DESC,f.id LIMIT 500`.pipe(
          Effect.flatMap((rows) => Effect.forEach(rows, (r) => decode(r.payload_json))),
          Effect.map((facts) => ({ facts })),
          Effect.mapError(failure("list")),
        );
      }).pipe(Effect.mapError(failure("list"))),
    create: (input, principal = "user") =>
      sql
        .withTransaction(
          create(input, principal).pipe(Effect.flatMap(({ fact }) => projected(fact.id))),
        )
        .pipe(Effect.mapError(failure("create"))),
    update: (input) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const fact = yield* get(input.id, "user");
            if (fact.status === "superseded" || fact.status === "retracted")
              return yield* new FactError({ operation: "update", reason: "invalid_state" });
            if (input.status === "confirmed" && fact.supersedes !== undefined) {
              const previous = yield* get(fact.supersedes, "user");
              if (
                previous.status === "retracted" ||
                (previous.supersededBy !== undefined && previous.supersededBy !== fact.id)
              )
                return yield* new FactError({ operation: "confirm", reason: "invalid_state" });
              if (previous.status !== "superseded") {
                const twins = yield* twinsOf(previous.id);
                yield* persist(
                  {
                    ...previous,
                    status: "superseded",
                    supersededBy: fact.id,
                    updatedAt: yield* now,
                  },
                  "user",
                );
                yield* retire(
                  twins,
                  (twin) => ({ ...twin, status: "superseded", supersededBy: fact.id }),
                  "user",
                );
              }
            }
            const hidden = input.status === "retracted" ? yield* twinsOf(fact.id) : [];
            yield* persist({ ...fact, status: input.status, updatedAt: yield* now }, "user");
            yield* retire(hidden, (twin) => ({ ...twin, status: "retracted" }), "user");
            return yield* projected(fact.id);
          }),
        )
        .pipe(Effect.mapError(failure("update"))),
    supersede: (input, principal = "user") =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const old = yield* get(input.id, principal);
            if (old.status === "superseded" || old.status === "retracted")
              return yield* new FactError({ operation: "supersede", reason: "invalid_state" });
            yield* authorizeWrite(old, principal);
            const twins = yield* twinsOf(old.id);
            const result = yield* create(input.replacement, principal);
            // A proposed correction cannot erase confirmed knowledge. Confirmation atomically
            // activates the replacement and links the old fact; superseded proposals retain their chain.
            const supersedes =
              old.status === "proposed" && old.supersedes !== undefined ? old.supersedes : old.id;
            yield* persist({ ...result.fact, supersedes }, principal);
            if (old.status !== "confirmed" || result.fact.status === "confirmed") {
              yield* persist(
                {
                  ...old,
                  status: "superseded",
                  supersededBy: result.fact.id,
                  updatedAt: yield* now,
                },
                principal,
              );
              yield* retire(
                twins.filter((twin) => twin.id !== result.fact.id),
                (twin) => ({ ...twin, status: "superseded", supersededBy: result.fact.id }),
                principal,
              );
            }
            return yield* projected(result.fact.id);
          }),
        )
        .pipe(Effect.mapError(failure("supersede"))),
    retract,
    history: (id) =>
      get(id, "user").pipe(
        Effect.andThen(
          sql<{
            payload_json: string;
          }>`SELECT payload_json FROM fact_history WHERE fact_id=${id} ORDER BY sequence`,
        ),
        Effect.flatMap((rows) => Effect.forEach(rows, (r) => decodeHistory(r.payload_json))),
        Effect.map((history) => ({ history })),
        Effect.mapError(failure("history")),
      ),
  });
});
export const layer = Layer.effect(FactService, make).pipe(
  Layer.provide(Access.layer),
  Layer.provide(SharedState.layer),
);
