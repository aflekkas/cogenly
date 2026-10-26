// @effect-diagnostics-next-line nodeBuiltinImport:off -- document ids hash synchronously; Effect's Crypto digest is async.
import * as NodeCrypto from "node:crypto";
import {
  Agent,
  AgentId,
  ContextPrincipal,
  Fact,
  FactId,
  IsoDateTime,
  PROJECT_INSTRUCTIONS_MAX_LENGTH,
  ProjectLabel,
  ProjectLabelId,
  ProjectFileSha256,
  ProjectSourceLink,
  ScheduledTaskFields,
  TrimmedNonEmptyString,
  SharedStateError,
  SharedRepositoryRemote,
  type SharedDocumentChange,
  SharedDocumentChangeWire,
  SharedDocumentId,
  SharedDocumentKind,
} from "@cogenly/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { IntegrationFields } from "./integrationDocument.ts";
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
  mergedInto: Schema.optionalKey(ProjectLabelId),
  mergeSourceName: Schema.optionalKey(ProjectLabel.fields.name),
  dismissedDuplicateIds: Schema.optionalKey(Schema.Array(ProjectLabelId)),
  dismissedHomeOwnerSuggestion: Schema.optionalKey(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  ),
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
  coreMemory: Schema.optionalKey(Agent.fields.coreMemory),
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
  projectFolderId: Schema.optionalKey(Schema.NullOr(ProjectLabelId)),
  machine: Schema.optionalKey(Schema.NullOr(PortableId)),
  agentId: Schema.NullOr(PortableId),
  title: ScheduledTaskFields.title,
  prompt: ScheduledTaskFields.prompt,
  enabled: Schema.Boolean,
  schedule: ScheduledTaskFields.schedule,
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
  runtimeMode: ScheduledTaskFields.runtimeMode,
  interactionMode: ScheduledTaskFields.interactionMode,
  ownerMachine: PortableId,
  createdAt: Agent.fields.createdAt,
});
/**
 * One file or folder in a project folder (see ProjectFileSync). `entry`
 * changes as one field, so content, kind and deletion never mix between two
 * writers. `baseSha256` is the content the author replaced: a receiver whose
 * file is neither that nor the new content keeps its own as a conflict copy.
 * A delete is `deleted`, not a tombstone, so the path can be created again.
 */
export const ProjectFileFields = Schema.Struct({
  projectId: ProjectLabelId,
  path: RelativePath.check(Schema.isMaxLength(1024)),
  entry: Schema.Struct({
    kind: Schema.Literals(["file", "folder"]),
    sha256: Schema.NullOr(ProjectFileSha256),
    sizeBytes: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
    baseSha256: Schema.NullOr(ProjectFileSha256),
    deleted: Schema.Boolean,
  }),
});
export type ProjectFileFields = typeof ProjectFileFields.Type;
/** One document per project and path, on every machine. */
export const projectFileDocumentId = (projectId: string, relativePath: string) =>
  `project-file:${NodeCrypto.createHash("sha256").update(`${projectId}\n${relativePath}`).digest("hex").slice(0, 40)}`;
const LegacyNoteText = Schema.String.check(Schema.isMaxLength(4000));
/**
 * A fact's status is not a field. Each transition sets its own marker, and
 * the projection ranks them retracted > superseded > confirmed > proposed, so
 * concurrent transitions on two machines end in the same status.
 */
export const FactFields = Schema.Struct({
  // The fact's own id, present only when it is not a portable document id.
  factId: FactId,
  subject: Fact.fields.subject,
  predicate: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(500))),
  text: Fact.fields.text,
  labelIds: Fact.fields.labelIds,
  visibility: Fact.fields.visibility,
  agentId: Schema.NullOr(AgentId),
  sourceRefs: Fact.fields.sourceRefs,
  validFrom: Schema.NullOr(IsoDateTime),
  supersedes: Schema.NullOr(FactId),
  createdBy: ContextPrincipal,
  createdAt: IsoDateTime,
  // The memory_* note id and source a fact answers to, when it has one.
  legacyNoteId: Schema.NullOr(LegacyNoteText),
  legacySource: Schema.NullOr(LegacyNoteText),
  // Cleared only by a later explicit demotion to a proposal.
  confirmedAt: Schema.NullOr(IsoDateTime),
  supersededBy: Schema.NullOr(FactId),
  retractedAt: Schema.NullOr(IsoDateTime),
});
/** How a projection reads a fact: the fields a fact is created with, and the rest when present. */
const FactDocument = Schema.Struct({
  ...FactFields.fields,
  factId: Schema.optional(FactFields.fields.factId),
  predicate: Schema.optional(FactFields.fields.predicate),
  agentId: Schema.optional(FactFields.fields.agentId),
  validFrom: Schema.optional(FactFields.fields.validFrom),
  supersedes: Schema.optional(FactFields.fields.supersedes),
  legacyNoteId: Schema.optional(FactFields.fields.legacyNoteId),
  legacySource: Schema.optional(FactFields.fields.legacySource),
  confirmedAt: Schema.optional(FactFields.fields.confirmedAt),
  supersededBy: Schema.optional(FactFields.fields.supersededBy),
  retractedAt: Schema.optional(FactFields.fields.retractedAt),
});
/**
 * The document id for a fact. New fact ids are portable; legacy memory ids
 * (`legacy-memory:["agent","note"]`) are not, so they hash, and the document
 * carries the original in `factId`.
 */
export const factDocumentId = (factId: string) =>
  isPortableId(factId)
    ? factId
    : `fact:digest:${NodeCrypto.createHash("sha256").update(factId).digest("hex").slice(0, 32)}`;
const Base64 = Schema.String.check(
  Schema.isMaxLength(4 * 1024 * 1024),
  Schema.isPattern(/^[A-Za-z0-9+/_-]*={0,2}$/),
);
/**
 * One author's newest revision of an item (`sealed:<author>`), sealed under
 * that revision's data key; see vault/VaultCrypto.ts.
 */
export const VaultSealedField = Schema.Struct({
  v: Schema.Literal(1),
  nonce: Base64,
  ciphertext: Base64,
});
/** That data key for one recipient, made by one holder (`wrap:<recipient>:<by>`). */
export const VaultWrapField = Schema.Struct({
  v: Schema.Literal(1),
  sealedDigest: Base64,
  ephemeralPublicKey: Base64,
  nonce: Base64,
  ciphertext: Base64,
});
export const VAULT_SEALED_PREFIX = "sealed:";
export const VAULT_WRAP_PREFIX = "wrap:";
// An environment id inside a vault field key; environment ids never contain ":".
const VaultKeySegment = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/;
export type VaultFieldKey =
  | { readonly _tag: "sealed"; readonly author: string }
  | { readonly _tag: "wrap"; readonly recipient: string; readonly by: string };
/** The meaning of a vault document key; undefined for a key this build does not know. */
export const parseVaultKey = (key: string): VaultFieldKey | undefined => {
  if (key.startsWith(VAULT_SEALED_PREFIX)) {
    const author = key.slice(VAULT_SEALED_PREFIX.length);
    return VaultKeySegment.test(author) ? { _tag: "sealed", author } : undefined;
  }
  if (key.startsWith(VAULT_WRAP_PREFIX)) {
    const [recipient, by, ...rest] = key.slice(VAULT_WRAP_PREFIX.length).split(":");
    return rest.length === 0 &&
      recipient !== undefined &&
      by !== undefined &&
      VaultKeySegment.test(recipient) &&
      VaultKeySegment.test(by)
      ? { _tag: "wrap", recipient, by }
      : undefined;
  }
  return undefined;
};
export const vaultSealedKey = (author: string) => `${VAULT_SEALED_PREFIX}${author}`;
export const vaultWrapKey = (recipient: string, by: string) =>
  `${VAULT_WRAP_PREFIX}${recipient}:${by}`;
type FieldCodec = {
  readonly decode: (value: unknown) => Option.Option<unknown>;
  readonly encode: (value: unknown) => Option.Option<unknown>;
};
type FieldCodecs = {
  readonly get: (key: string) => FieldCodec | undefined;
  readonly has: (key: string) => boolean;
};
const codec = (schema: Schema.Struct.Fields[string]): FieldCodec => ({
  // Nested keys this build does not know are ignored when reading.
  decode: Schema.decodeUnknownOption(schema as Schema.Codec<unknown>),
  encode: Schema.encodeUnknownOption(schema as Schema.Codec<unknown>),
});
const codecs = (fields: Schema.Struct.Fields): ReadonlyMap<string, FieldCodec> =>
  new Map(Object.entries(fields).map(([key, schema]) => [key, codec(schema)]));
const sealedCodec = codec(VaultSealedField);
const wrapCodec = codec(VaultWrapField);
// One field per author and per recipient and wrapper, so concurrent writers
// never clobber each other, and one machine can only ever write its own.
const vaultCodecFor = (key: string) => {
  const parsed = parseVaultKey(key);
  return parsed === undefined ? undefined : parsed._tag === "sealed" ? sealedCodec : wrapCodec;
};
/** The machine a vault field belongs to: a revision's author or a wrap's maker. */
const vaultFieldOwner = (key: string) => {
  const parsed = parseVaultKey(key);
  return parsed === undefined ? undefined : parsed._tag === "sealed" ? parsed.author : parsed.by;
};
/**
 * The part of a vault change its author may make: only its own revisions and
 * wraps, and never a tombstone, since a delete is a sealed revision that only
 * holders can open. Anything else is dropped, never refused, so a machine
 * outside the vault cannot mask, freeze or delete what holders wrote.
 */
const vaultAuthored = (change: SharedDocumentChangeWire): SharedDocumentChangeWire => {
  const keys = Object.keys(change.fields).filter((key) => {
    const owner = vaultFieldOwner(key);
    return owner === undefined || owner === change.updatedBy;
  });
  return {
    ...change,
    fields: Object.fromEntries(keys.map((key) => [key, change.fields[key]!])),
    clocks: Object.fromEntries(keys.map((key) => [key, change.clocks[key]!])),
    tombstone: null,
  };
};
/** What this build reads of each document kind; any other key is a newer build's. */
const FIELD_CODECS: Readonly<Record<SharedDocumentKind, FieldCodecs>> = {
  project: codecs(ProjectFields.fields),
  agent: codecs(AgentFields.fields),
  schedule: codecs(ScheduleFields.fields),
  fact: codecs(FactFields.fields),
  vault: { get: vaultCodecFor, has: (key) => vaultCodecFor(key) !== undefined },
  integration: codecs(IntegrationFields.fields),
  settings: UNIVERSAL_SETTINGS_CODECS,
  "project-settings": PROJECT_SETTINGS_CODECS,
  "project-file": codecs(ProjectFileFields.fields),
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
    if (
      change.kind === "fact" &&
      Object.hasOwn(change.fields, "factId") &&
      (typeof change.fields.factId !== "string" ||
        factDocumentId(change.fields.factId) !== change.id)
    )
      return yield* invalid();
    // A project file's id names its project and path; neither can be pointed elsewhere.
    if (
      change.kind === "project-file" &&
      (Object.hasOwn(change.fields, "projectId") || Object.hasOwn(change.fields, "path")) &&
      (typeof change.fields.projectId !== "string" ||
        typeof change.fields.path !== "string" ||
        projectFileDocumentId(change.fields.projectId, change.fields.path) !== change.id)
    )
      return yield* invalid();
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
 * for a later build. An unknown document kind is deferred whole. A vault
 * change keeps only what its author may write (`vaultAuthored`).
 */
export const splitChange = (
  change: SharedDocumentChangeWire,
): { readonly accepted: SharedDocumentChange | null; readonly deferred: boolean } => {
  if (!isKnownKind(change.kind)) return { accepted: null, deferred: true };
  const authored = change.kind === "vault" ? vaultAuthored(change) : change;
  const known = FIELD_CODECS[change.kind];
  const keys = Object.keys(authored.fields);
  const keep = keys.filter((key) => {
    const fieldCodec = known.get(key);
    return fieldCodec === undefined || Option.isSome(fieldCodec.decode(authored.fields[key]));
  });
  const deferred = keep.length !== keys.length;
  const fields = Object.fromEntries(keep.map((key) => [key, authored.fields[key]!]));
  const clocks = Object.fromEntries(keep.map((key) => [key, authored.clocks[key]!]));
  const accepted =
    keep.length === 0 && authored.tombstone === null
      ? null
      : { ...authored, kind: change.kind, fields, clocks };
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
    // A vault write that splitChange would trim is a bug here, not a peer's forgery.
    if (
      change.kind === "vault" &&
      (change.tombstone !== null ||
        Object.keys(accepted?.fields ?? {}).length !== Object.keys(change.fields).length)
    )
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
  // Sealed values and wraps are signed whole; carrying a newer build's keys
  // into a rewritten one would break the digest every wrap commits to.
  if (kind === "vault") return value;
  const fieldCodec = FIELD_CODECS[kind].get(key);
  if (fieldCodec === undefined || stored === undefined) return value;
  const known = fieldCodec.decode(stored).pipe(Option.flatMap(fieldCodec.encode));
  return Option.isNone(known) ? value : carry(value, stored, known.value);
};
export const decodeProject = Schema.decodeUnknownEffect(ProjectFields);
export const decodeAgent = Schema.decodeUnknownEffect(AgentFields);
export const decodeSchedule = Schema.decodeUnknownEffect(ScheduleFields);
export const decodeFact = Schema.decodeUnknownEffect(FactDocument);
export const decodeProjectFile = Schema.decodeUnknownOption(ProjectFileFields);
export const decodeVaultSealed = Schema.decodeUnknownOption(VaultSealedField);
export const decodeVaultWrap = Schema.decodeUnknownOption(VaultWrapField);
