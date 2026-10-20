import * as Facts from "../context/FactService.ts";
import {
  AgentMemoryListResult,
  FactCreateInput,
  FactSupersedeInput,
  FactListInput,
  FactResult,
  FactListResult,
  AgentMemoryWriteInput,
  AgentMemoryWriteResult,
  AgentDeleteResult,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as AgentStore from "./AgentStore.ts";
import * as Invocation from "../mcp/McpInvocationContext.ts";
import * as Access from "../mcp/McpToolAccess.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    AgentStore.AgentStore,
    Facts.FactService,
    Invocation.McpInvocationContext,
    Threads.ThreadManagementService,
  ],
};
const writeParameters = Schema.Struct({
  id: AgentMemoryWriteInput.fields.id,
  text: AgentMemoryWriteInput.fields.text,
});
const Read = Tool.make("memory_read", {
  ...shared,
  description:
    "Read durable notes for your agent identity. Scope comes from this thread's credential, never a caller-supplied agent ID.",
  success: AgentMemoryListResult,
}).annotate(Tool.Readonly, true);
const Remember = Tool.make("memory_remember", {
  ...shared,
  description:
    "Propose a durable fact for your agent. Supply an existing note id to propose a correction; only the owner can confirm it.",
  parameters: writeParameters,
  success: AgentMemoryWriteResult,
});
const Write = Tool.make("memory_write", {
  ...shared,
  description: "Write or edit a durable memory note for your agent (alias of memory_remember).",
  parameters: writeParameters,
  success: AgentMemoryWriteResult,
});
const Forget = Tool.make("memory_forget", {
  ...shared,
  description: "Forget a note belonging to your agent.",
  parameters: Schema.Struct({ id: Schema.String }),
  success: AgentDeleteResult,
});
const Search = Tool.make("fact_search", {
  ...shared,
  description:
    "Search facts owned by you or shared with your explicit readable label scope. Tags never grant access.",
  parameters: Schema.Struct({
    labelId: FactListInput.fields.labelId,
    status: FactListInput.fields.status,
    query: FactListInput.fields.query,
  }),
  success: FactListResult,
}).annotate(Tool.Readonly, true);
const Propose = Tool.make("fact_propose", {
  ...shared,
  description:
    "Propose a source-referenced fact. Only the user can confirm it. Your identity is resolved from the thread credential.",
  parameters: Schema.Struct({
    subject: FactCreateInput.fields.subject,
    predicate: FactCreateInput.fields.predicate,
    text: FactCreateInput.fields.text,
    labelIds: FactCreateInput.fields.labelIds,
    visibility: FactCreateInput.fields.visibility,
    sourceRefs: FactCreateInput.fields.sourceRefs,
    validFrom: FactCreateInput.fields.validFrom,
  }),
  success: FactResult,
});
const Supersede = Tool.make("fact_supersede", {
  ...shared,
  description:
    "Propose a replacement for one of your facts, preserving history. Confirmed knowledge changes only after owner confirmation.",
  parameters: Schema.Struct({
    id: FactSupersedeInput.fields.id,
    replacement: Schema.Struct({
      subject: FactCreateInput.fields.subject,
      predicate: FactCreateInput.fields.predicate,
      text: FactCreateInput.fields.text,
      labelIds: FactCreateInput.fields.labelIds,
      visibility: FactCreateInput.fields.visibility,
      sourceRefs: FactCreateInput.fields.sourceRefs,
      validFrom: FactCreateInput.fields.validFrom,
    }),
  }),
  success: FactResult,
});
export const toolkit = Toolkit.make(Read, Remember, Write, Forget, Search, Propose, Supersede);
const unavailable = (_cause: unknown) =>
  new OrchestratorMcpFailure({
    code: "orchestration_error",
    message: "Could not access agent memory.",
  });
/** No agent id is accepted from a tool caller. Both conversation and work threads resolve in the store. */
export const callingAgent = Effect.gen(function* () {
  const scope = yield* Invocation.McpInvocationContext;
  if (scope.thread === undefined)
    return yield* new OrchestratorMcpFailure({
      code: "thread_credential_required",
      message: "Memory tools require an agent thread.",
    });
  const store = yield* AgentStore.AgentStore;
  const agent = yield* store.forThread(scope.thread.threadId).pipe(Effect.mapError(unavailable));
  if (agent === null)
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message: "This thread does not belong to a persistent agent.",
    });
  return { agent, store, threadId: scope.thread.threadId };
});
const remember = (input: typeof writeParameters.Type) =>
  Effect.gen(function* () {
    const { agent, store, threadId } = yield* callingAgent;
    const note = yield* store
      .remember({ ...input, agentId: agent.id, source: `thread:${threadId}` }, `agent:${agent.id}`)
      .pipe(Effect.mapError(unavailable));
    return { note };
  });
export const handlers = Access.toLayer(toolkit, {
  fact_search: Access.readsAsCaller((input) =>
    Effect.gen(function* () {
      const { agent } = yield* callingAgent;
      return yield* (yield* Facts.FactService).list(input, `agent:${agent.id}`);
    }).pipe(Effect.mapError(unavailable)),
  ),
  fact_propose: Access.actsAsCaller((input) =>
    Effect.gen(function* () {
      const { agent } = yield* callingAgent;
      return yield* (yield* Facts.FactService).create(
        { ...input, agentId: agent.id },
        `agent:${agent.id}`,
      );
    }).pipe(Effect.mapError(unavailable)),
  ),
  fact_supersede: Access.actsAsCaller((input) =>
    Effect.gen(function* () {
      const { agent } = yield* callingAgent;
      return yield* (yield* Facts.FactService).supersede(
        { id: input.id, replacement: { ...input.replacement, agentId: agent.id } },
        `agent:${agent.id}`,
      );
    }).pipe(Effect.mapError(unavailable)),
  ),
  memory_read: Access.readsAsCaller(() =>
    callingAgent.pipe(
      Effect.flatMap(({ agent, store }) => store.memory(agent.id)),
      Effect.map((notes) => ({ notes })),
      Effect.mapError(unavailable),
    ),
  ),
  memory_remember: Access.actsAsCaller(remember),
  memory_write: Access.actsAsCaller(remember),
  memory_forget: Access.actsAsCaller((input) =>
    callingAgent.pipe(
      Effect.flatMap(({ agent, store }) => store.forget(agent.id, input.id, `agent:${agent.id}`)),
      Effect.map((deleted) => ({ deleted })),
      Effect.mapError(unavailable),
    ),
  ),
});
