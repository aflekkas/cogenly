import { describe, expect, it } from "vite-plus/test";
import {
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { deriveProviderSubagentStatus, deriveRunlessWorkStartedAt } from "./threadExecution.ts";

const nativeStart = DateTime.makeUnsafe("2026-06-20T00:00:00.000Z");
const nativeEnd = DateTime.makeUnsafe("2026-06-20T00:06:03.000Z");
const followUpStart = DateTime.makeUnsafe("2026-06-20T00:10:00.000Z");
const threadId = ThreadId.make("thread-native-child");
const parentThreadId = ThreadId.make("thread-parent");
const instanceId = ProviderInstanceId.make("claude");
const modelSelection = { instanceId, model: "claude-opus-5-5" };

const nativeRoot = {
  id: NodeId.make("native-root"),
  threadId,
  runId: null,
  parentNodeId: null,
  rootNodeId: NodeId.make("native-root"),
  kind: "root_turn",
  status: "completed",
  countsForRun: false,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  runtimeRequestId: null,
  checkpointScopeId: null,
  startedAt: nativeStart,
  completedAt: nativeEnd,
} satisfies OrchestrationV2ExecutionNode;

const followUp = {
  id: RunId.make("follow-up"),
  threadId,
  ordinal: 1,
  providerInstanceId: instanceId,
  modelSelection,
  providerThreadId: null,
  userMessageId: MessageId.make("follow-up-message"),
  rootNodeId: null,
  activeAttemptId: null,
  status: "running",
  requestedAt: followUpStart,
  startedAt: followUpStart,
  completedAt: null,
  checkpointId: null,
  contextHandoffId: null,
} satisfies OrchestrationV2Run;

const nativeChild = {
  thread: {
    id: threadId,
    projectId: ProjectId.make("project"),
    title: "Explore",
    providerInstanceId: instanceId,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { rootThreadId: parentThreadId, parentThreadId, relationshipToParent: "subagent" },
    forkedFrom: { type: "node", nodeId: NodeId.make("native-task") },
    createdBy: "agent",
    creationSource: "provider",
    createdAt: nativeStart,
    updatedAt: nativeStart,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  },
  runs: [],
  attempts: [],
  nodes: [nativeRoot],
  subagents: [],
  providerSessions: [],
  providerThreads: [],
  providerTurns: [],
  runtimeRequests: [],
  messages: [],
  plans: [],
  turnItems: [],
  checkpointScopes: [],
  checkpoints: [],
  contextHandoffs: [],
  contextTransfers: [],
  visualStates: [],
  visibleTurnItems: [],
  updatedAt: nativeStart,
} satisfies OrchestrationV2ThreadProjection;

describe("deriveProviderSubagentStatus", () => {
  it("reports the native work until a message gives the child a run of its own", () => {
    expect(deriveProviderSubagentStatus(nativeChild)).toEqual({
      status: "completed",
      startedAt: "2026-06-20T00:00:00.000Z",
      completedAt: "2026-06-20T00:06:03.000Z",
    });
    // Queued behind native work: nothing of the child's own has started yet.
    const queued = {
      ...nativeChild,
      nodes: [{ ...nativeRoot, status: "running" as const, completedAt: null }],
      runs: [{ ...followUp, status: "queued" as const, startedAt: null }],
    };
    expect(deriveProviderSubagentStatus(queued)?.status).toBe("running");
  });

  it("follows the child's latest run once it starts", () => {
    const following = { ...nativeChild, runs: [followUp] };
    expect(deriveProviderSubagentStatus(following)).toEqual({
      status: "running",
      startedAt: "2026-06-20T00:10:00.000Z",
      completedAt: null,
    });
    // The run reports its own work; the finished native turn is not work too.
    expect(deriveRunlessWorkStartedAt(following)).toBeNull();
  });
});
