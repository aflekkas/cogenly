import { describe, expect, it } from "vite-plus/test";
import {
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  NodeId,
  CheckpointId,
  CheckpointScopeId,
  CheckpointRef,
  RuntimeRequestId,
  RunId,
  ThreadId,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { deriveWorkStatus } from "./workStatus.ts";

const now = DateTime.makeUnsafe("2026-06-20T00:00:00.000Z");
const threadId = ThreadId.make("thread-reducer");
const runId = RunId.make("run-reducer");
const run = {
  id: runId,
  threadId,
  ordinal: 1,
  providerInstanceId: ProviderInstanceId.make("codex"),
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  providerThreadId: null,
  userMessageId: MessageId.make("message-reducer"),
  rootNodeId: null,
  activeAttemptId: null,
  status: "completed",
  requestedAt: now,
  startedAt: now,
  completedAt: now,
  checkpointId: null,
  contextHandoffId: null,
} satisfies OrchestrationV2Run;

const emptyProjection = {
  thread: {
    id: threadId,
    projectId: ProjectId.make("project-reducer"),
    title: "Reducer",
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  },
  runs: [],
  attempts: [],
  nodes: [],
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
  updatedAt: now,
} satisfies OrchestrationV2ThreadProjection;
const projection = (status: OrchestrationV2Run["status"]): OrchestrationV2ThreadProjection => ({
  ...emptyProjection,
  runs: [{ ...run, status }],
});
const checkpoint = {
  id: CheckpointId.make("checkpoint"),
  threadId,
  scopeId: CheckpointScopeId.make("scope"),
  runId,
  nodeId: NodeId.make("root"),
  parentCheckpointId: null,
  ordinalWithinScope: 1,
  appRunOrdinal: 1,
  ref: CheckpointRef.make("refs/checkpoints/one"),
  status: "ready" as const,
  files: [{ path: "src/main.ts", kind: "modified", additions: 1, deletions: 0 }],
  capturedAt: now,
};
// Only these process fields are read; the production projection provides the rest.
const withProcess = (
  state: OrchestrationV2ThreadProjection,
  status: "stopped" | "error" | "running" | "ready",
) =>
  ({
    ...state,
    thread: { ...state.thread, activeProviderThreadId: ProviderThreadId.make("provider") },
    providerThreads: [
      {
        id: ProviderThreadId.make("provider"),
        providerSessionId: ProviderSessionId.make("session"),
        status: "idle",
      },
    ],
    providerSessions: [{ id: ProviderSessionId.make("session"), status }],
  }) as unknown as OrchestrationV2ThreadProjection;

describe("deriveWorkStatus", () => {
  it("has no activity until a run exists", () =>
    expect(deriveWorkStatus(emptyProjection)).toBe("draft"));
  it.each([
    ["preparing", "queued"],
    ["queued", "queued"],
    ["starting", "running"],
    ["running", "running"],
    ["waiting", "running"],
    ["completed", "completed"],
    ["failed", "failed"],
    ["cancelled", "canceled"],
    ["rolled_back", "canceled"],
    ["interrupted", "paused"],
  ] as const)("maps %s to %s", (status, expected) =>
    expect(deriveWorkStatus(projection(status))).toBe(expected),
  );
  it("active work outranks a newer queued run", () => {
    const state = projection("running");
    expect(
      deriveWorkStatus({
        ...state,
        runs: [...state.runs, { ...run, id: RunId.make("queued"), ordinal: 2, status: "queued" }],
      }),
    ).toBe("running");
  });
  it.each(["user_input", "command_approval"] as const)(
    "awaits pending human %s requests",
    (kind) => {
      const state = projection("running");
      const nodeId = NodeId.make("root");
      const requests = {
        ...state,
        nodes: [{ id: nodeId, runId }],
        runtimeRequests: [
          {
            id: RuntimeRequestId.make("request"),
            nodeId,
            kind,
            status: "pending",
            responseCapability: { type: "live" },
          },
        ],
      } as unknown as OrchestrationV2ThreadProjection;
      expect(deriveWorkStatus(requests)).toBe("awaiting_input");
      expect(
        deriveWorkStatus({
          ...requests,
          runtimeRequests: requests.runtimeRequests.map((request) => ({
            ...request,
            status: "resolved",
          })),
        }),
      ).toBe("running");
      for (const machineRequest of ["dynamic_tool_call", "auth_refresh"] as const) {
        expect(
          deriveWorkStatus({
            ...requests,
            runtimeRequests: requests.runtimeRequests.map((request) => ({
              ...request,
              kind: machineRequest,
            })),
          }),
        ).toBe("running");
      }
      expect(
        deriveWorkStatus({
          ...requests,
          runs: [
            { ...run, status: "completed" },
            { ...run, ordinal: 2, id: RunId.make("new"), status: "running" },
          ],
        }),
      ).toBe("running");
    },
  );
  it("awaits secret input from the current run", () => {
    const state = projection("waiting");
    const requests = {
      ...state,
      turnItems: [{ type: "secret_request", status: "waiting", runId }],
    } as unknown as OrchestrationV2ThreadProjection;
    expect(deriveWorkStatus(requests)).toBe("awaiting_input");
  });
  it.each(["stopped", "error", "running", "ready"] as const)(
    "uses the active process's %s state",
    (status) => {
      expect(deriveWorkStatus(withProcess(projection("running"), status))).toBe(
        status === "stopped" ? "paused" : status === "error" ? "failed" : "running",
      );
    },
  );
  it("ignores an unrelated stopped process", () => {
    const state = withProcess(projection("running"), "stopped");
    expect(
      deriveWorkStatus({ ...state, thread: { ...state.thread, activeProviderThreadId: null } }),
    ).toBe("running");
  });
  it("reviews ready diffs, and never uses assistant completion claims", () => {
    const state = projection("completed");
    expect(deriveWorkStatus({ ...state, checkpoints: [checkpoint] })).toBe("review_ready");
    expect(
      deriveWorkStatus({ ...state, checkpoints: [{ ...checkpoint, status: "missing" }] }),
    ).toBe("completed");
    expect(deriveWorkStatus({ ...state, checkpoints: [{ ...checkpoint, files: [] }] })).toBe(
      "completed",
    );
    expect(deriveWorkStatus({ ...projection("failed"), checkpoints: [checkpoint] })).toBe("failed");
  });
  it("settlement and archive complete idle sessions; live work still wins", () => {
    const state = { ...projection("completed"), checkpoints: [checkpoint] };
    expect(deriveWorkStatus({ ...state, thread: { ...state.thread, settledAt: now } })).toBe(
      "completed",
    );
    expect(deriveWorkStatus({ ...state, thread: { ...state.thread, archivedAt: now } })).toBe(
      "completed",
    );
    expect(
      deriveWorkStatus({ ...projection("running"), thread: { ...state.thread, archivedAt: now } }),
    ).toBe("running");
  });
  it("a later successful run supersedes failure", () => {
    expect(
      deriveWorkStatus({
        ...projection("failed"),
        runs: [
          { ...run, status: "failed" },
          { ...run, ordinal: 2, status: "completed" },
        ],
      }),
    ).toBe("completed");
  });
});
