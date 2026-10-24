import {
  Agent,
  IsoDateTime,
  PROJECT_INSTRUCTIONS_MAX_LENGTH,
  ProjectLabel,
  ProjectSourceLink,
  ScheduledTask,
  TrimmedNonEmptyString,
  SharedStateError,
  SharedRepositoryRemote,
  type SharedDocumentChange,
  SharedDocumentChangeWire,
  SharedDocumentId,
  SharedDocumentKind,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { PROJECT_SETTINGS_CODECS, UNIVERSAL_SETTINGS_CODECS } from "./settingsDocument.ts";

const decodeWire = Schema.decodeUnknownEffect(SharedDocumentChangeWire);
const isPortableId = Schema.is(SharedDocumentId);
const PortableId = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,199}$/));
const Remote = SharedRepositoryRemote;
const RelativePath = Schema.String.check(
  Schema.isPattern(/^(?![A-Za-z]:)(?![\\/~])[^\\\x00]+$/),
  Schema.makeFilter((value) =>
    value.split("/").every((part) => part !== ".." && part !== "." && part.length > 0),
  ),
);
const Selection = Agent.fields.modelSelection;
export const ProjectFields = Schema.Struct({
  name: ProjectLabel.fields.name,
  color: Schema.NullOr(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100))),
  description: Schema.NullOr(Schema.String.check(Schema.isMaxLength(4000))),
  instructions: Schema.String.check(Schema.isMaxLength(PROJECT_INSTRUCTIONS_MAX_LENGTH)),
  archivedAt: Schema.NullOr(IsoDateTime),
  repositories: Schema.Array(
    Schema.Struct({
      remote: Remote,
      directoryName: Schema.NullOr(RelativePath),
      // The icon a checkout found, relative to the repository root.
      iconPath: Schema.optionalKey(RelativePath.check(Schema.isMaxLength(1024))),
    }),
  ),
  sourceLinks: Schema.Array(ProjectSourceLink),
  createdAt: Agent.fields.createdAt,
});
export const AgentFields = Schema.Struct({
  name: Agent.fields.name,
  avatar: Agent.fields.avatar,
  instructions: Agent.fields.instructions,
  responsibility: Agent.fields.responsibility,
  permissions: Agent.fields.permissions,
  notifyPolicy: Agent.fields.notifyPolicy,
  modelSelection: Selection,
  fallbackChain: Schema.Array(Selection),
  runtimeMode: Agent.fields.runtimeMode,
  dailyRunCap: Agent.fields.dailyRunCap,
  repositoryRemote: Schema.NullOr(Remote),
  ownerMachine: PortableId,
  createdAt: Agent.fields.createdAt,
});
export const ScheduleFields = Schema.Struct({
  agentId: Schema.NullOr(PortableId),
  title: ScheduledTask.fields.title,
  prompt: ScheduledTask.fields.prompt,
  enabled: Schema.Boolean,
  schedule: ScheduledTask.fields.schedule,
  repositoryRemote: Schema.NullOr(Remote),
  // An existing worktree travels by path relative to the owning repository.
  workspaceStrategy: Schema.Union([
    Schema.Struct({
      type: Schema.Literal("root"),
      branch: Schema.optional(TrimmedNonEmptyString),
    }),
    Schema.Struct({
      type: Schema.Literal("worktree"),
      baseRef: TrimmedNonEmptyString,
      branch: Schema.optional(TrimmedNonEmptyString),
      startFromOrigin: Schema.optional(Schema.Boolean),
    }),
    Schema.Struct({
      type: Schema.Literal("existing_worktree"),
      relativePath: RelativePath,
      branch: Schema.optional(TrimmedNonEmptyString),
    }),
  ]),
  modelSelection: Selection,
  runtimeMode: ScheduledTask.fields.runtimeMode,
  interactionMode: ScheduledTask.fields.interactionMode,
  ownerMachine: PortableId,
  createdAt: Agent.fields.createdAt,
});
type FieldCodec = {
  readonly decode: (value: unknown) => Option.Option<unknown>;
  readonly encode: (value: unknown) => Option.Option<unknown>;
};
const codecs = (fields: Schema.Struct.Fields): ReadonlyMap<string, FieldCodec> =>
  new Map(
    Object.entries(fields).map(([key, schema]) => [
      key,
      {
        // Nested keys this build does not know are ignored when reading.
        decode: Schema.decodeUnknownOption(schema as Schema.Codec<unknown>),
        encode: Schema.encodeUnknownOption(schema as Schema.Codec<unknown>),
      },
    ]),
  );
/** What this build reads of each document kind; any other key is a newer build's. */
const FIELD_CODECS: Readonly<Record<SharedDocumentKind, ReadonlyMap<string, FieldCodec>>> = {
  project: codecs(ProjectFields.fields),
  agent: codecs(AgentFields.fields),
  schedule: codecs(ScheduleFields.fields),
  settings: UNIVERSAL_SETTINGS_CODECS,
  "project-settings": PROJECT_SETTINGS_CODECS,
};
const isKnownKind = Schema.is(SharedDocumentKind);
const invalid = (cause?: unknown) => new SharedStateError({ reason: "invalid-document", cause });

/**
 * The parts of a change that do not depend on the build: its shape, a
 * portable id, a clock per field, and every clock written by its author.
 * A failure here is a broken or forged change and refuses the batch.
 */
export const checkIntegrity = (change: SharedDocumentChangeWire) =>
  Effect.gen(function* () {
    yield* decodeWire(change).pipe(Effect.mapError(invalid));
    if (change.kind !== "schedule" && !isPortableId(change.id)) return yield* invalid();
    const keys = Object.keys(change.fields);
    if (
      keys.length !== Object.keys(change.clocks).length ||
      keys.some((key) => !Object.hasOwn(change.clocks, key))
    )
      return yield* invalid();
    if (
      Object.values(change.clocks).some((clock) => clock.node !== change.updatedBy) ||
      (change.tombstone && change.tombstone.node !== change.updatedBy)
    )
      return yield* invalid();
    // Settings documents are never deleted: a reset is a field value.
    if ((change.kind === "settings" || change.kind === "project-settings") && change.tombstone)
      return yield* invalid();
  });

/**
 * Splits a peer's change by what this build understands. Keys it does not
 * know are newer fields: they are kept and relayed as they are, and read by
 * no projection here. A known field whose value does not validate here (a
 * newer build widened it, or a peer sent something invalid) is held back:
 * it is never applied, and `deferred` asks the caller to keep the original
 * for a later build. An unknown document kind is deferred whole.
 */
export const splitChange = (
  change: SharedDocumentChangeWire,
): { readonly accepted: SharedDocumentChange | null; readonly deferred: boolean } => {
  if (!isKnownKind(change.kind)) return { accepted: null, deferred: true };
  const known = FIELD_CODECS[change.kind];
  const keep = Object.keys(change.fields).filter((key) => {
    const codec = known.get(key);
    return codec === undefined || Option.isSome(codec.decode(change.fields[key]));
  });
  const deferred = keep.length !== Object.keys(change.fields).length;
  const fields = Object.fromEntries(keep.map((key) => [key, change.fields[key]!]));
  const clocks = Object.fromEntries(keep.map((key) => [key, change.clocks[key]!]));
  const accepted =
    keep.length === 0 && change.tombstone === null
      ? null
      : { ...change, kind: change.kind, fields, clocks };
  return { accepted, deferred };
};

/** A local write must be fully valid: it comes from this build's own model. */
export const validateChange = (change: SharedDocumentChange) =>
  Effect.gen(function* () {
    yield* checkIntegrity(change);
    const { accepted, deferred } = splitChange(change);
    const known = FIELD_CODECS[change.kind];
    if (deferred || Object.keys(accepted?.fields ?? {}).some((key) => !known.has(key)))
      return yield* invalid();
  });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const sameJson = (a: unknown, b: unknown) => encodeJson(a) === encodeJson(b);

/**
 * Puts back what `stored` holds that this build does not know into `local`,
 * at any depth. `known` is `stored` as this build reads it, so a key in
 * `stored` but not in `known` belongs to a newer build. A key this build
 * knows and `local` dropped stays dropped. Array items pair up by their known
 * form, then by position, so an unchanged repository keeps its newer fields.
 */
const carry = (local: unknown, stored: unknown, known: unknown): unknown => {
  if (isRecord(local) && isRecord(stored) && isRecord(known)) {
    const result: Record<string, unknown> = { ...local };
    for (const [key, value] of Object.entries(stored)) {
      if (!Object.hasOwn(known, key)) {
        if (!Object.hasOwn(local, key)) result[key] = value;
      } else if (Object.hasOwn(local, key)) {
        result[key] = carry(local[key], value, known[key]);
      }
    }
    return result;
  }
  if (Array.isArray(local) && Array.isArray(stored) && Array.isArray(known)) {
    const used = new Set<number>();
    return local.map((item, index) => {
      let match = known.findIndex((candidate, at) => !used.has(at) && sameJson(candidate, item));
      if (match === -1 && local.length === stored.length && !used.has(index)) match = index;
      if (match === -1) return item;
      used.add(match);
      return carry(item, stored[match], known[match]);
    });
  }
  return local;
};

/**
 * `value` for `key`, with whatever the stored value carries that this build
 * does not understand put back, so writing a document never drops a newer
 * build's nested fields.
 */
export const preserveUnknown = (
  kind: SharedDocumentKind,
  key: string,
  value: unknown,
  stored: unknown,
): unknown => {
  const codec = FIELD_CODECS[kind].get(key);
  if (codec === undefined || stored === undefined) return value;
  const known = codec.decode(stored).pipe(Option.flatMap(codec.encode));
  return Option.isNone(known) ? value : carry(value, stored, known.value);
};
export const decodeProject = Schema.decodeUnknownEffect(ProjectFields);
export const decodeAgent = Schema.decodeUnknownEffect(AgentFields);
export const decodeSchedule = Schema.decodeUnknownEffect(ScheduleFields);
