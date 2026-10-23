import {
  Agent,
  ProjectLabel,
  ProjectSourceLink,
  ScheduledTask,
  SharedStateError,
  SHARED_DOCUMENT_BYTES,
  type SharedDocumentChange,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const PortableId = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,199}$/));
const Remote = Schema.String.check(
  Schema.isMaxLength(1000),
  Schema.isPattern(/^[a-z0-9.-]+\.[a-z0-9.-]+\/[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)+$/),
);
const RelativePath = Schema.String.check(
  Schema.isMaxLength(1000),
  Schema.isPattern(/^(?![A-Za-z]:)(?![\\/~])[^\\\x00]+$/),
  Schema.makeFilter((value) =>
    value.split("/").every((part) => part !== ".." && part !== "." && part.length > 0),
  ),
);
const Selection = Agent.fields.modelSelection;
export const ProjectFields = Schema.Struct({
  name: ProjectLabel.fields.name,
  color: Schema.NullOr(Schema.String.check(Schema.isMaxLength(100))),
  description: Schema.NullOr(Schema.String.check(Schema.isMaxLength(32000))),
  instructions: Schema.String.check(Schema.isMaxLength(32000)),
  archivedAt: Schema.NullOr(Schema.String.check(Schema.isMaxLength(50))),
  repositories: Schema.Array(
    Schema.Struct({ remote: Remote, directoryName: Schema.NullOr(RelativePath) }),
  ).check(Schema.isMaxLength(100)),
  sourceLinks: Schema.Array(ProjectSourceLink).check(Schema.isMaxLength(100)),
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
  fallbackChain: Schema.Array(Selection).check(Schema.isMaxLength(16)),
  runtimeMode: Agent.fields.runtimeMode,
  dailyRunCap: Agent.fields.dailyRunCap,
  repositoryRemote: Schema.NullOr(Remote),
  ownerMachine: PortableId,
  createdAt: Agent.fields.createdAt,
});
export const ScheduleFields = Schema.Struct({
  agentId: Schema.NullOr(PortableId),
  title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  prompt: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(32000)),
  enabled: Schema.Boolean,
  schedule: ScheduledTask.fields.schedule,
  repositoryRemote: Schema.NullOr(Remote),
  // An existing worktree travels by path relative to the owning repository.
  workspaceStrategy: Schema.Union([
    Schema.Struct({
      type: Schema.Literal("root"),
      branch: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
    }),
    Schema.Struct({
      type: Schema.Literal("worktree"),
      baseRef: Schema.String.check(Schema.isMaxLength(200)),
      branch: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
      startFromOrigin: Schema.optional(Schema.Boolean),
    }),
    Schema.Struct({
      type: Schema.Literal("existing_worktree"),
      relativePath: RelativePath,
      branch: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
    }),
  ]),
  modelSelection: Selection,
  runtimeMode: ScheduledTask.fields.runtimeMode,
  interactionMode: ScheduledTask.fields.interactionMode,
  ownerMachine: PortableId,
  createdAt: Agent.fields.createdAt,
});
const partials = {
  project: Schema.Struct(
    Object.fromEntries(
      Object.entries(ProjectFields.fields).map(([key, schema]) => [
        key,
        Schema.optionalKey(schema),
      ]),
    ),
  ),
  agent: Schema.Struct(
    Object.fromEntries(
      Object.entries(AgentFields.fields).map(([key, schema]) => [key, Schema.optionalKey(schema)]),
    ),
  ),
  schedule: Schema.Struct(
    Object.fromEntries(
      Object.entries(ScheduleFields.fields).map(([key, schema]) => [
        key,
        Schema.optionalKey(schema),
      ]),
    ),
  ),
};
/** Reject excess properties as well as malformed values, including nested secrets/path fields. */
export const validateChange = (change: SharedDocumentChange) =>
  Effect.gen(function* () {
    const invalid = () => new SharedStateError({ reason: "invalid-document" });
    if (new TextEncoder().encode(encodeJson(change)).length > SHARED_DOCUMENT_BYTES)
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
    yield* Schema.decodeUnknownEffect(partials[change.kind])(change.fields, {
      onExcessProperty: "error",
    }).pipe(Effect.mapError(invalid));
  });
export const decodeProject = Schema.decodeUnknownEffect(ProjectFields);
export const decodeAgent = Schema.decodeUnknownEffect(AgentFields);
export const decodeSchedule = Schema.decodeUnknownEffect(ScheduleFields);
