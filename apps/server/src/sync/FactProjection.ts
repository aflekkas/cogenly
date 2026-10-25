// @effect-diagnostics-next-line nodeBuiltinImport:off -- dedupe keys hash synchronously; Effect's Crypto digest is async.
import * as NodeCrypto from "node:crypto";
import {
  Fact,
  FactHistoryEntry,
  FactId,
  SharedStateError,
  type SharedDocumentChange,
} from "@cogenly/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { decodeFact, factDocumentId } from "./documentSchemas.ts";

type FactDocument = Effect.Success<ReturnType<typeof decodeFact>>;
type Member = { readonly id: FactId; readonly fields: FactDocument };
type Placement = {
  readonly status: Fact["status"];
  readonly supersededBy: FactId | undefined;
  readonly duplicateOf: FactId | null;
};

const isSharedStateError = Schema.is(SharedStateError);
const storage = (cause: unknown) =>
  isSharedStateError(cause) ? cause : new SharedStateError({ reason: "storage", cause });
const decodeFactJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Fact));
const encodeFactJson = Schema.encodeEffect(Schema.fromJsonString(Fact));
const encodeHistory = Schema.encodeEffect(Schema.fromJsonString(FactHistoryEntry));
const decodeFields = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)),
);
const ACTIVE: ReadonlySet<Fact["status"]> = new Set(["proposed", "confirmed"]);

/** A fact's own status: the highest-ranked marker any machine has set. */
const ownPlacement = (fields: FactDocument): Placement => ({
  status: fields.retractedAt
    ? "retracted"
    : fields.supersededBy
      ? "superseded"
      : fields.confirmedAt
        ? "confirmed"
        : "proposed",
  supersededBy: fields.supersededBy ?? undefined,
  duplicateOf: null,
});

const normalize = (text: string) => text.toLowerCase().replace(/\s+/g, " ").trim();
/** Copies of one fact share this key wherever they were created. */
const dedupeKey = (fields: FactDocument) =>
  NodeCrypto.createHash("sha256")
    .update(
      JSON.stringify([
        fields.agentId ?? null,
        fields.visibility,
        [...new Set(fields.labelIds)].sort(),
        normalize(fields.subject),
        normalize(fields.predicate ?? ""),
        normalize(fields.text),
      ]),
    )
    .digest("hex");

const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : typeof value === "object" && value !== null
      ? Object.fromEntries(
          Object.entries(value)
            .filter(([, item]) => item !== undefined)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([key, item]) => [key, canonical(item)]),
        )
      : value;
const sameFact = (a: Fact, b: Fact) =>
  JSON.stringify(canonical({ ...a, updatedAt: "" })) ===
  JSON.stringify(canonical({ ...b, updatedAt: "" }));

const loadMember = Effect.fn("FactProjection.loadMember")(function* (id: FactId) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    fields_json: string;
  }>`SELECT fields_json FROM shared_documents WHERE kind='fact' AND id=${factDocumentId(id)} AND tombstone_json IS NULL`;
  if (!rows[0]) return undefined;
  const decoded = yield* Effect.result(
    decodeFields(rows[0].fields_json).pipe(Effect.flatMap(decodeFact)),
  );
  return decoded._tag === "Success" ? { id, fields: decoded.success } : undefined;
});

/** Writes one projected fact. Only a real change touches the row, its labels and its history. */
const writeFact = Effect.fn("FactProjection.writeFact")(function* (
  member: Member,
  placement: Placement,
  key: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const { id, fields: f } = member;
  const at = DateTime.formatIso(yield* DateTime.now);
  // A deleted project's tag stays in the document; its projection drops the tag here.
  const deleted =
    f.labelIds.length === 0
      ? []
      : (yield* sql<{
          id: string;
        }>`SELECT id FROM shared_documents WHERE kind='project' AND tombstone_json IS NOT NULL AND id IN ${sql.in(f.labelIds)}`).map(
          (row) => row.id,
        );
  const fact: Fact = {
    id,
    subject: f.subject,
    ...(f.predicate ? { predicate: f.predicate } : {}),
    text: f.text,
    labelIds: f.labelIds.filter((label) => !deleted.includes(label)),
    visibility: f.visibility,
    ...(f.agentId ? { agentId: f.agentId } : {}),
    sourceRefs: f.sourceRefs,
    ...(f.validFrom ? { validFrom: f.validFrom } : {}),
    status: placement.status,
    ...(placement.supersededBy ? { supersededBy: placement.supersededBy } : {}),
    ...(f.supersedes ? { supersedes: f.supersedes } : {}),
    createdBy: f.createdBy,
    createdAt: f.createdAt,
    updatedAt: at,
  };
  const legacyNoteId = f.legacyNoteId ?? null;
  const legacySource = f.legacySource ?? null;
  const existing = yield* sql<{
    payload_json: string;
    legacy_note_id: string | null;
    legacy_source: string | null;
    dedupe_key: string | null;
    duplicate_of: string | null;
  }>`SELECT payload_json,legacy_note_id,legacy_source,dedupe_key,duplicate_of FROM facts WHERE id=${id}`;
  const previous = existing[0];
  const stored = previous
    ? yield* decodeFactJson(previous.payload_json).pipe(Effect.option)
    : undefined;
  const unchanged =
    previous !== undefined &&
    stored?._tag === "Some" &&
    sameFact(stored.value, fact) &&
    previous.legacy_note_id === legacyNoteId &&
    previous.legacy_source === legacySource;
  if (unchanged) {
    if (previous.dedupe_key !== key || previous.duplicate_of !== placement.duplicateOf)
      yield* sql`UPDATE facts SET dedupe_key=${key},duplicate_of=${placement.duplicateOf} WHERE id=${id}`;
    return;
  }
  const payload = yield* encodeFactJson(fact);
  yield* sql`INSERT INTO facts(id,agent_id,legacy_note_id,legacy_source,status,payload_json,updated_at,dedupe_key,duplicate_of) VALUES (${id},${f.agentId ?? null},${legacyNoteId},${legacySource},${fact.status},${payload},${at},${key},${placement.duplicateOf}) ON CONFLICT(id) DO UPDATE SET agent_id=excluded.agent_id,legacy_note_id=excluded.legacy_note_id,legacy_source=excluded.legacy_source,status=excluded.status,payload_json=excluded.payload_json,updated_at=excluded.updated_at,dedupe_key=excluded.dedupe_key,duplicate_of=excluded.duplicate_of`;
  yield* sql`DELETE FROM fact_labels WHERE fact_id=${id}`;
  // A tag whose project has not arrived yet is linked when it does.
  if (fact.labelIds.length > 0)
    yield* sql`INSERT OR IGNORE INTO fact_labels(fact_id,label_id) SELECT ${id},label_id FROM project_labels WHERE label_id IN ${sql.in(fact.labelIds)}`;
  // Local audit only; fact_history never replicates.
  const history = yield* encodeHistory({
    id: `sync:${id}:${at}`,
    factId: id,
    who: "user",
    at,
    fact,
  });
  yield* sql`INSERT INTO fact_history(fact_id,payload_json) VALUES (${id},${history})`;
});

/**
 * Places every copy of one normalized fact. When several are active, the
 * confirmed one with the lowest id wins (or the lowest-id proposal) and the
 * others project as superseded by it. The rule reads only replicated
 * documents, so every machine places the copies alike without writing any.
 */
const placeGroup = Effect.fn("FactProjection.placeGroup")(function* (key: string, member?: Member) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    id: string;
  }>`SELECT id FROM facts WHERE dedupe_key=${key} ORDER BY id`;
  const members: Member[] = member ? [member] : [];
  for (const row of rows) {
    if (row.id === member?.id) continue;
    const loaded = yield* loadMember(FactId.make(row.id));
    if (loaded && dedupeKey(loaded.fields) === key) members.push(loaded);
  }
  const active = members
    .filter((candidate) => ACTIVE.has(ownPlacement(candidate.fields).status))
    .sort(
      (a, b) =>
        Number(ownPlacement(b.fields).status === "confirmed") -
          Number(ownPlacement(a.fields).status === "confirmed") || (a.id < b.id ? -1 : 1),
    );
  const winner = active.length > 1 ? active[0] : undefined;
  for (const candidate of members) {
    const own = ownPlacement(candidate.fields);
    yield* writeFact(
      candidate,
      winner && candidate !== winner && ACTIVE.has(own.status)
        ? { status: "superseded", supersededBy: winner.id, duplicateOf: winner.id }
        : own,
      key,
    );
  }
});

const liveAgent = (agentId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return (
      (yield* sql`SELECT 1 FROM agents a WHERE agent_id=${agentId} AND NOT EXISTS (SELECT 1 FROM shared_documents d WHERE d.kind='agent' AND d.id=a.agent_id AND d.tombstone_json IS NOT NULL)`)
        .length > 0
    );
  });

/** Shared writes and peer merges of a fact. Facts launch no work. */
export const projectFact = Effect.fn("FactProjection.projectFact")(function* (
  document: SharedDocumentChange,
) {
  const sql = yield* SqlClient.SqlClient;
  const factId = FactId.make(
    typeof document.fields.factId === "string" ? document.fields.factId : document.id,
  );
  if (factDocumentId(factId) !== document.id)
    return yield* new SharedStateError({ reason: "invalid-document" });
  const previous = (yield* sql<{
    dedupe_key: string | null;
  }>`SELECT dedupe_key FROM facts WHERE id=${factId}`)[0]?.dedupe_key;
  if (document.tombstone) {
    yield* sql`DELETE FROM facts WHERE id=${factId}`;
    if (previous) yield* placeGroup(previous);
    return;
  }
  // Deltas may arrive before their creation; an incomplete fact stays durable and unprojected.
  const decoded = yield* Effect.result(decodeFact(document.fields));
  if (decoded._tag === "Failure") return;
  const fields = decoded.success;
  // A fact waits for its agent; the agent's projection places it.
  if (fields.agentId && !(yield* liveAgent(fields.agentId))) return;
  const key = dedupeKey(fields);
  yield* placeGroup(key, { id: factId, fields });
  if (previous && previous !== key) yield* placeGroup(previous);
}, Effect.mapError(storage));

/** Places the facts that arrived before this agent did. */
export const projectWaitingFacts = Effect.fn("FactProjection.projectWaitingFacts")(function* (
  agentId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const waiting = yield* sql<{
    id: string;
    fields_json: string;
    updated_by_env: string;
  }>`SELECT d.id,d.fields_json,d.updated_by_env FROM shared_documents d WHERE d.kind='fact' AND d.tombstone_json IS NULL AND json_extract(d.fields_json,'$.agentId')=${agentId} AND NOT EXISTS (SELECT 1 FROM facts f WHERE f.id=COALESCE(json_extract(d.fields_json,'$.factId'),d.id)) ORDER BY d.rowid`;
  for (const row of waiting)
    yield* projectFact({
      kind: "fact",
      id: row.id,
      fields: yield* decodeFields(row.fields_json),
      clocks: {},
      tombstone: null,
      updatedBy: row.updated_by_env as SharedDocumentChange["updatedBy"],
    });
}, Effect.mapError(storage));

/** Links facts to a project that arrived after them. */
export const linkArrivedProject = Effect.fn("FactProjection.linkArrivedProject")(function* (
  labelId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT OR IGNORE INTO fact_labels(fact_id,label_id) SELECT f.id,${labelId} FROM facts f WHERE EXISTS (SELECT 1 FROM json_each(f.payload_json,'$.labelIds') j WHERE j.value=${labelId})`;
}, Effect.mapError(storage));

/**
 * The portable part of a local fact. Markers come from the status the domain
 * just wrote; a copy hidden behind its twin keeps its own markers.
 */
export const readFactConfiguration = Effect.fn("FactProjection.readFactConfiguration")(function* (
  documentId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const stored = (yield* sql<{
    fields_json: string;
  }>`SELECT fields_json FROM shared_documents WHERE kind='fact' AND id=${documentId}`)[0];
  const saved: { readonly [key: string]: unknown } = stored
    ? yield* decodeFields(stored.fields_json)
    : {};
  const factId =
    typeof saved.factId === "string"
      ? saved.factId
      : (yield* sql`SELECT 1 FROM facts WHERE id=${documentId}`).length > 0
        ? documentId
        : // Only legacy memory ids hash; a first capture finds its fact by hashing them.
          (yield* sql<{ id: string }>`SELECT id FROM facts WHERE id NOT GLOB 'fact:*'`).find(
            (row) => factDocumentId(row.id) === documentId,
          )?.id;
  if (factId === undefined) return null;
  const row = (yield* sql<{
    payload_json: string;
    legacy_note_id: string | null;
    legacy_source: string | null;
    duplicate_of: string | null;
  }>`SELECT payload_json,legacy_note_id,legacy_source,duplicate_of FROM facts WHERE id=${factId}`)[0];
  if (!row) return null;
  const fact = yield* decodeFactJson(row.payload_json);
  const hidden =
    row.duplicate_of !== null &&
    fact.status === "superseded" &&
    fact.supersededBy === row.duplicate_of;
  const status = hidden ? undefined : fact.status;
  const kept = (key: string) => saved[key] ?? null;
  return {
    ...(factId === documentId ? {} : { factId }),
    subject: fact.subject,
    predicate: fact.predicate ?? null,
    text: fact.text,
    labelIds: fact.labelIds,
    visibility: fact.visibility,
    agentId: fact.agentId ?? null,
    sourceRefs: fact.sourceRefs,
    validFrom: fact.validFrom ?? null,
    supersedes: fact.supersedes ?? null,
    createdBy: fact.createdBy,
    createdAt: fact.createdAt,
    legacyNoteId: row.legacy_note_id,
    legacySource: row.legacy_source,
    confirmedAt:
      status === "confirmed"
        ? (kept("confirmedAt") ?? fact.updatedAt)
        : status === "proposed"
          ? null
          : kept("confirmedAt"),
    supersededBy:
      status === "superseded" ? (fact.supersededBy ?? kept("supersededBy")) : kept("supersededBy"),
    retractedAt:
      status === "retracted" ? (kept("retractedAt") ?? fact.updatedAt) : kept("retractedAt"),
  };
}, Effect.mapError(storage));
