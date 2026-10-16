import {
  createEnvironmentCommand,
  createEnvironmentQueryAtomFamily,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
  type AtomCommand,
} from "@t3tools/client-runtime/state/runtime";
import {
  WS_METHODS,
  type CommandId,
  type EnvironmentId,
  type MessageId,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { type AsyncResult, type Atom, type AtomRegistry } from "effect/reactivity";
import { connectionAtomRuntime } from "../connection/runtime";
import type { AgentRecord, AgentDraft, AgentMemory, AgentActivity } from "../agents/agents.types";

class AgentBackendUnavailable extends Data.TaggedError("AgentBackendUnavailable")<{
  message: string;
}> {}
const unavailable = () =>
  Effect.fail(
    new AgentBackendUnavailable({
      message: "Agent profiles need the updated server and client contracts.",
    }),
  );
export const hasAgentContracts = "agentsSubscribe" in WS_METHODS;
type Target<Input> = { environmentId: EnvironmentId; input: Input };
type Query<Input, Output> = (
  target: Target<Input>,
) => Atom.Atom<AsyncResult.AsyncResult<Output, unknown>>;
type Method =
  | "agents.subscribe"
  | "agents.upsert"
  | "agents.delete"
  | "agents.send"
  | "agents.memoryList"
  | "agents.memoryWrite"
  | "agents.memoryForget"
  | "agents.runs";
type Success<Input, Output> = (
  target: Target<Input>,
  registry: AtomRegistry.AtomRegistry,
  result: Output,
) => Effect.Effect<void>;

// TODO(agents-core): remove this typed compatibility facade once 39866fb66 is
// integrated here. The current worktree's contracts predate these tags. Runtime
// feature detection uses the real permission-aware RPC factories immediately
// when the shared contracts are present; it never opens a second transport.
const rpcCommand = createEnvironmentRpcCommand as unknown as <Input, Output>(
  runtime: typeof connectionAtomRuntime,
  options: { label: string; tag: Method; onSuccess?: Success<Input, Output> },
) => AtomCommand<Target<Input>, Output, unknown>;
const rpcQuery = createEnvironmentRpcQueryAtomFamily as unknown as <Input, Output>(
  runtime: typeof connectionAtomRuntime,
  options: {
    label: string;
    tag: Method;
    staleTimeMs?: number;
    refreshTrigger?: (target: Target<Input>) => Atom.Atom<unknown>;
  },
) => Query<Input, Output>;
const rpcSubscription = createEnvironmentRpcSubscriptionAtomFamily as unknown as <Input, Output>(
  runtime: typeof connectionAtomRuntime,
  options: { label: string; tag: Method },
) => Query<Input, Output>;
function command<Input, Output>(tag: Method, onSuccess?: Success<Input, Output>) {
  return hasAgentContracts
    ? rpcCommand<Input, Output>(connectionAtomRuntime, {
        label: tag,
        tag,
        ...(onSuccess ? { onSuccess } : {}),
      })
    : createEnvironmentCommand(connectionAtomRuntime, {
        label: tag,
        execute: (_input: Input): Effect.Effect<Output, AgentBackendUnavailable> => unavailable(),
      });
}
const list: Query<Record<string, never>, { agents: ReadonlyArray<AgentRecord> }> = hasAgentContracts
  ? rpcSubscription(connectionAtomRuntime, { label: "agents:live", tag: "agents.subscribe" })
  : createEnvironmentQueryAtomFamily(connectionAtomRuntime, {
      label: "agents:unavailable",
      execute: (
        _input: Record<string, never>,
      ): Effect.Effect<{ agents: ReadonlyArray<AgentRecord> }, AgentBackendUnavailable> =>
        unavailable(),
    });
function query<Input, Output>(tag: Method): Query<Input, Output> {
  return hasAgentContracts
    ? rpcQuery(connectionAtomRuntime, {
        label: tag,
        tag,
        staleTimeMs: 5_000,
        refreshTrigger: (target) => list({ environmentId: target.environmentId, input: {} }),
      })
    : createEnvironmentQueryAtomFamily(connectionAtomRuntime, {
        label: tag,
        execute: (_input: Input): Effect.Effect<Output, AgentBackendUnavailable> => unavailable(),
      });
}
const memory = query<{ agentId: string }, { notes: ReadonlyArray<AgentMemory> }>(
  "agents.memoryList",
);
const refreshMemory = <Input extends { agentId: string }, Output>(
  target: Target<Input>,
  registry: AtomRegistry.AtomRegistry,
  _result: Output,
) =>
  Effect.sync(() => {
    registry.refresh(
      memory({ environmentId: target.environmentId, input: { agentId: target.input.agentId } }),
    );
  });
export const agentsRpc = {
  list,
  save: command<AgentDraft, { agent: AgentRecord }>("agents.upsert"),
  remove: command<{ id: string }, { deleted: boolean }>("agents.delete"),
  send: command<
    {
      id: string;
      commandId: CommandId;
      messageId: MessageId;
      text: string;
      mode: "auto" | "queue" | "steer";
    },
    { threadId: ThreadId; runId: RunId; delivery: "started" | "queued" | "steered" | "restarted" }
  >("agents.send"),
  memory,
  saveMemory: command<
    { agentId: string; id?: string; text: string; source?: string },
    { note: AgentMemory }
  >("agents.memoryWrite", refreshMemory),
  deleteMemory: command<{ agentId: string; id: string }, { deleted: boolean }>(
    "agents.memoryForget",
    refreshMemory,
  ),
  activity: query<{ id: string }, { runs: ReadonlyArray<AgentActivity> }>("agents.runs"),
};
