import type { ServerProviderUsageLimits } from "@t3tools/contracts";
import {
  ProviderDriverKind,
  type ModelSelection,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2TurnItem,
  type OrchestrationV2TurnItemStatus,
  type OrchestrationV2PlanStep,
  type PlanId,
  type ProviderInstanceId,
  type RuntimeRequestId,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { COGENLY_ORCHESTRATION_INSTRUCTIONS } from "@t3tools/provider-core/server/orchestrationInstructions";
import { AgentScope } from "@t3tools/shared/AgentScope";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSession from "@t3tools/provider-core/server/mcpSession";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import type * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import {
  isProviderNativeImageAttachment,
  providerMessageTextWithAttachmentPaths,
} from "@t3tools/provider-core/server/attachmentPrompt";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import {
  CONVERSATION_MODE_INSTRUCTIONS,
  buildRuntimeInstructions,
} from "@t3tools/provider-core/server/runtimeInstructions";
import { turnScopedSelectionTransition } from "@t3tools/provider-core/server/selectionTransition";

import type { GrokSettings } from "../settings.ts";
import {
  AcpRpcError,
  createGrokAcpHost,
  createGrokAcpHostEffect,
  type GrokAcpHost,
} from "./acp.ts";
import {
  GROK_DEFAULT_MODEL,
  grokModelCapabilities,
  resolveGrokReasoningEffort,
} from "./modelCatalog.ts";
import {
  applyGrokToolPatch,
  GROK_MODEL_CONFIG_ID,
  GROK_REASONING_CONFIG_ID,
  GROK_MUTATING_TOOL_KINDS,
  grokApprovalOptions,
  grokPermissionOutcome,
  grokRequestKind,
  grokToolPresentation,
  isGrokUsageLimitError,
  parseGrokPermissionRequest,
  parseGrokPromptUsage,
  parseGrokSessionResult,
  parseGrokSessionUpdate,
  parseGrokStopReason,
  type GrokPermissionRequest,
  type GrokSessionUpdate,
  type GrokToolCall,
} from "./protocol.ts";
import { readGrokBillingFromHost } from "./usageLimits.ts";

const GROK_PROVIDER = ProviderDriverKind.make("grok");
const isProtocolError = Schema.is(ProviderAdapter.ProviderAdapterProtocolError);

const GrokProviderCapabilitiesV2 = {
  runtimePolicy: { enforcement: "native" },
  sessions: {
    supportsMultipleProviderThreadsPerSession: false,
    supportsModelSwitchInSession: true,
    supportsProviderSwitchingViaHandoff: true,
    supportsRuntimeModeSwitchInSession: false,
    pendingRequestsSurviveRestart: false,
  },
  threads: {
    canCreateEmptyThread: true,
    // ACP has no read-back; Cogenly owns the transcript.
    canReadThreadSnapshot: false,
    canRollbackThread: false,
    canForkThread: false,
    canForkFromTurn: false,
    canForkFromSubagentThread: false,
    exposesNativeThreadId: true,
  },
  turns: {
    exposesNativeTurnId: false,
    emitsTurnStarted: true,
    emitsTurnCompleted: true,
    supportsInterrupt: true,
    supportsActiveSteering: false,
    supportsSteeringByInterruptRestart: false,
    supportsQueuedMessages: true,
    terminalStatusQuality: "strong",
  },
  streaming: {
    streamsAssistantText: true,
    streamsReasoning: true,
    streamsToolOutput: true,
    streamsPlanText: false,
    emitsMessageCompleted: true,
  },
  tools: {
    exposesToolItemIds: true,
    emitsToolStarted: true,
    emitsToolCompleted: true,
    emitsToolOutput: true,
    supportsMcpTools: true,
    supportsDynamicToolCallbacks: false,
  },
  approvals: {
    supportsCommandApproval: true,
    supportsFileReadApproval: true,
    supportsFileChangeApproval: true,
    supportsApplyPatchApproval: false,
    approvalsHaveNativeRequestIds: true,
    approvalCallbacksAreLiveOnly: true,
    approvalsCanOriginateFromSubagents: false,
  },
  planning: {
    emitsPlanUpdated: true,
    emitsTodoList: true,
    emitsProposedPlan: false,
    supportsStructuredQuestions: false,
    planDeltasHaveItemIds: false,
  },
  subagents: {
    supportsSubagents: false,
    exposesSubagentThreadIds: false,
    emitsSubagentLifecycle: false,
    canWaitForSubagents: false,
    canCloseSubagents: false,
    canForkSubagentThread: false,
  },
  context: {
    acceptsSystemContext: false,
    acceptsDeveloperContext: false,
    acceptsSyntheticUserContext: true,
    canGenerateSummaries: false,
    canConsumeHandoffSummaries: true,
    supportsDeltaHandoff: true,
    supportsFullThreadHandoff: true,
    maxRecommendedHandoffChars: null,
  },
  checkpointing: {
    appCanCheckpointFilesystem: true,
    supportsNestedCheckpointScopes: false,
    providerCanRollbackConversation: false,
    providerRollbackReturnsSnapshot: false,
    providerCanReadConversationSnapshot: false,
  },
  identity: {
    nativeThreadIds: "strong",
    nativeTurnIds: "weak",
    nativeItemIds: "strong",
    nativeRequestIds: "strong",
  },
} satisfies OrchestrationV2ProviderCapabilities;

export interface GrokAdapterV2Options {
  readonly instanceId: ProviderInstanceId;
  readonly settings: GrokSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly modelCatalog?: Effect.Effect<ReadonlyArray<ServerProviderModel>>;
  readonly createHost?: typeof createGrokAcpHost;
  readonly requestTimeoutMs?: number;
  readonly onUsageLimits?: (limits: ServerProviderUsageLimits) => Effect.Effect<void>;
  readonly nativeEventLogger?: ProviderEventLoggers.EventNdjsonLogger;
}

/** A streamed text segment: one assistant message or one reasoning block. */
interface Segment {
  readonly key: string;
  text: string;
}

interface ActiveTurn {
  readonly input: ProviderAdapter.ProviderAdapterV2TurnInput;
  providerTurn: OrchestrationV2ProviderTurn;
  readonly nativeId: string;
  readonly ordinals: Map<string, number>;
  readonly started: Map<string, DateTime.Utc>;
  readonly tools: Map<string, GrokToolCall>;
  readonly done: Deferred.Deferred<void>;
  message: Segment | undefined;
  reasoning: Segment | undefined;
  segments: number;
  dirty: boolean;
  flushScheduled: boolean;
  planId?: PlanId;
  nextOrdinal: number;
  interruptRequested: boolean;
}

interface PendingRequest {
  readonly native: GrokPermissionRequest;
  readonly answer: (outcome: unknown) => void;
  request: OrchestrationV2RuntimeRequest;
  node: OrchestrationV2ExecutionNode;
  item: OrchestrationV2TurnItem;
  response?: Pick<OrchestrationV2RuntimeRequest, "decision">;
}

type Inbox =
  | {
      readonly type: "notification";
      readonly method: string;
      readonly params: unknown;
      readonly epoch: number;
    }
  | {
      readonly type: "permission";
      readonly params: unknown;
      readonly answer: (outcome: unknown) => void;
      readonly epoch: number;
    }
  | { readonly type: "promptDone"; readonly turn: ActiveTurn; readonly result: unknown }
  | { readonly type: "promptFailed"; readonly turn: ActiveTurn; readonly cause: unknown }
  | { readonly type: "failure"; readonly cause: unknown; readonly epoch: number }
  | { readonly type: "flush"; readonly turn: ActiveTurn };

const nativeRef = (nativeId: string) => ({
  driver: GROK_PROVIDER,
  nativeId,
  strength: "strong" as const,
});
const CANCELLED_OUTCOME = { outcome: { outcome: "cancelled" } };

/** One scoped Grok ACP host owns one native session; the orchestrator owns runs and queuing. */
export const makeGrokAdapterV2 = Effect.fn("makeGrokAdapterV2")(function* (
  options: GrokAdapterV2Options,
) {
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  const providerHost = yield* ProviderHost.ProviderHost;
  const fileSystem = yield* FileSystem.FileSystem;
  const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
  const agentScope = yield* AgentScope;

  const protocolError = (detail: string, payload?: unknown) =>
    new ProviderAdapter.ProviderAdapterProtocolError({
      driver: GROK_PROVIDER,
      detail,
      ...(payload === undefined ? {} : { payload }),
    });

  return ProviderAdapter.ProviderAdapterV2.of({
    instanceId: options.instanceId,
    driver: GROK_PROVIDER,
    getCapabilities: () => Effect.succeed(GrokProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed(turnScopedSelectionTransition()),
    openSession: Effect.fn("GrokAdapterV2.openSession")(function* (
      input: ProviderAdapter.ProviderAdapterV2OpenSessionInput,
    ) {
      if (!options.settings.enabled) return yield* protocolError("Grok is disabled");
      if (input.runtimePolicy.interactionMode === "plan")
        return yield* protocolError("Grok does not support dedicated Plan mode");
      const scope = yield* Effect.scope;
      const requestedCwd = input.runtimePolicy.cwd ?? providerHost.paths.cwd;
      const cwd = yield* fileSystem
        .realPath(requestedCwd)
        .pipe(Effect.orElseSucceed(() => requestedCwd));
      const conversationMode = input.runtimePolicy.conversationMode === true;
      const now = yield* DateTime.now;
      let session: OrchestrationV2ProviderSession = {
        id: input.providerSessionId,
        driver: GROK_PROVIDER,
        providerInstanceId: options.instanceId,
        status: "ready",
        cwd,
        model: input.modelSelection.model,
        capabilities: GrokProviderCapabilitiesV2,
        createdAt: now,
        updatedAt: now,
        lastError: null,
      };
      const events = yield* Queue.unbounded<
        ProviderAdapter.ProviderAdapterV2Event,
        ProviderAdapter.ProviderAdapterV2Error | Cause.Done
      >();
      const inbox = yield* Queue.unbounded<Inbox>();
      const commands = yield* Semaphore.make(1);
      const eventPermit = yield* Semaphore.make(1);
      let host: GrokAcpHost;
      let hostEpoch = 0;
      let closed = false;
      let broken = false;
      let nativeSessionId: string | undefined;
      let thread: OrchestrationV2ProviderThread | undefined;
      let active: ActiveTurn | undefined;
      const pending = new Map<RuntimeRequestId, PendingRequest>();

      const emit = (event: ProviderAdapter.ProviderAdapterV2Event) =>
        Queue.offer(events, event).pipe(Effect.asVoid);
      const request = (method: string, params: Record<string, unknown>) =>
        Effect.tryPromise({
          try: () => host.connection.request(method, params),
          catch: (cause) =>
            protocolError(
              cause instanceof Error && cause.message
                ? `Grok ${method} failed: ${cause.message}`
                : `Grok ${method} failed`,
              cause,
            ),
        }).pipe(
          Effect.timeout(options.requestTimeoutMs ?? 30_000),
          Effect.catchTags({
            TimeoutError: (cause) =>
              Effect.gen(function* () {
                yield* eventPermit.withPermits(1)(failHost(cause));
                return yield* protocolError(`Grok ${method} timed out; its host was closed`, cause);
              }),
          }),
        );
      const updateSession = Effect.fnUntraced(function* (
        status: OrchestrationV2ProviderSession["status"],
        lastError: string | null = null,
      ) {
        session = { ...session, status, lastError, updatedAt: yield* DateTime.now };
        yield* emit({
          type: "provider_session.updated",
          driver: GROK_PROVIDER,
          providerSession: session,
        });
      });
      const updateThread = Effect.fnUntraced(function* (
        patch: Partial<OrchestrationV2ProviderThread>,
      ) {
        if (!thread) return;
        thread = { ...thread, ...patch, updatedAt: yield* DateTime.now };
        yield* emit({
          type: "provider_thread.updated",
          driver: GROK_PROVIDER,
          providerThread: thread,
        });
      });
      const itemIdentity = (turn: ActiveTurn, nativeId: string) =>
        `${options.instanceId}:${turn.input.providerThread.id}:${turn.nativeId}:${nativeId}`;
      const baseItem = (turn: ActiveTurn, nativeId: string, time: DateTime.Utc) => {
        if (!turn.ordinals.has(nativeId)) turn.ordinals.set(nativeId, turn.nextOrdinal++);
        if (!turn.started.has(nativeId)) turn.started.set(nativeId, time);
        const identity = itemIdentity(turn, nativeId);
        return {
          id: idAllocator.derive.turnItemFromProviderItem({
            driver: GROK_PROVIDER,
            nativeItemId: identity,
          }),
          nodeId: idAllocator.derive.nodeFromProviderItem({
            driver: GROK_PROVIDER,
            nativeItemId: identity,
          }),
          threadId: turn.input.threadId,
          runId: turn.input.runId,
          providerThreadId: turn.input.providerThread.id,
          providerTurnId: turn.providerTurn.id,
          nativeItemRef: nativeRef(nativeId),
          parentItemId: null,
          ordinal: turn.ordinals.get(nativeId)!,
          startedAt: turn.started.get(nativeId)!,
          updatedAt: time,
        };
      };
      const emitNode = (
        turn: ActiveTurn,
        base: ReturnType<typeof baseItem>,
        kind: OrchestrationV2ExecutionNode["kind"],
        status: OrchestrationV2TurnItemStatus,
        completedAt: DateTime.Utc | null,
      ) =>
        emit({
          type: "node.updated",
          driver: GROK_PROVIDER,
          node: {
            id: base.nodeId,
            threadId: base.threadId,
            runId: base.runId,
            parentNodeId: turn.input.rootNodeId,
            rootNodeId: turn.input.rootNodeId,
            kind,
            status,
            countsForRun: false,
            providerThreadId: base.providerThreadId,
            providerTurnId: base.providerTurnId,
            nativeItemRef: base.nativeItemRef,
            runtimeRequestId: null,
            checkpointScopeId: null,
            startedAt: base.startedAt,
            completedAt,
          },
        });

      /** Shows one text segment: an assistant message, or a reasoning block. */
      const publishSegment = Effect.fnUntraced(function* (
        turn: ActiveTurn,
        kind: "message" | "reasoning",
        segment: Segment,
        streaming: boolean,
      ) {
        const time = yield* DateTime.now;
        const status: OrchestrationV2TurnItemStatus = streaming ? "running" : "completed";
        const base = baseItem(turn, segment.key, time);
        const completedAt = streaming ? null : time;
        if (kind === "message") {
          const messageId = idAllocator.derive.messageFromProviderItem({
            driver: GROK_PROVIDER,
            nativeItemId: itemIdentity(turn, segment.key),
          });
          const message: OrchestrationV2ConversationMessage = {
            id: messageId,
            threadId: turn.input.threadId,
            runId: turn.input.runId,
            nodeId: base.nodeId,
            role: "assistant",
            text: segment.text,
            attachments: [],
            streaming,
            createdBy: "agent",
            creationSource: "provider",
            createdAt: base.startedAt,
            updatedAt: time,
          };
          yield* emit({ type: "message.updated", driver: GROK_PROVIDER, message });
          yield* emitNode(turn, base, "assistant_message", status, completedAt);
          yield* emit({
            type: "turn_item.updated",
            driver: GROK_PROVIDER,
            turnItem: {
              ...base,
              status,
              title: null,
              completedAt,
              type: "assistant_message",
              messageId,
              text: segment.text,
              streaming,
            },
          });
        } else {
          yield* emitNode(turn, base, "reasoning", status, completedAt);
          yield* emit({
            type: "turn_item.updated",
            driver: GROK_PROVIDER,
            turnItem: {
              ...base,
              status,
              title: null,
              completedAt,
              type: "reasoning",
              text: segment.text,
              streaming,
            },
          });
        }
      });
      /** Ends the open message and reasoning segments, so later text starts a new row. */
      const closeSegments = Effect.fnUntraced(function* (turn: ActiveTurn) {
        if (turn.reasoning) yield* publishSegment(turn, "reasoning", turn.reasoning, false);
        if (turn.message) yield* publishSegment(turn, "message", turn.message, false);
        turn.reasoning = undefined;
        turn.message = undefined;
        turn.dirty = false;
      });
      const publishTool = Effect.fnUntraced(function* (
        turn: ActiveTurn,
        tool: GrokToolCall,
        override?: OrchestrationV2TurnItemStatus,
      ) {
        const time = yield* DateTime.now;
        const presentation = grokToolPresentation(tool);
        const status = override ?? presentation.status;
        const base = baseItem(turn, `tool:${tool.toolCallId}`, time);
        const completedAt = status === "running" || status === "pending" ? null : time;
        yield* emitNode(turn, base, "tool_call", status, completedAt);
        yield* emit({
          type: "turn_item.updated",
          driver: GROK_PROVIDER,
          turnItem: { ...base, ...presentation, status, completedAt },
        });
      });
      const publishPlan = Effect.fnUntraced(function* (
        turn: ActiveTurn,
        update: Extract<GrokSessionUpdate, { type: "plan" }>,
      ) {
        const steps: ReadonlyArray<OrchestrationV2PlanStep> = update.entries.map(
          (entry, index) => ({
            id: `${turn.nativeId}:plan:${index}`,
            text: entry.content,
            status:
              entry.status === "completed"
                ? "completed"
                : entry.status === "in_progress"
                  ? "running"
                  : "pending",
          }),
        );
        const time = yield* DateTime.now;
        const base = baseItem(turn, "plan", time);
        const planId =
          turn.planId ??
          (yield* idAllocator.allocate
            .plan({ threadId: turn.input.threadId, runId: turn.input.runId, driver: GROK_PROVIDER })
            .pipe(Effect.mapError((cause) => protocolError("Cannot allocate Grok plan", cause))));
        turn.planId = planId;
        yield* emit({
          type: "plan.updated",
          driver: GROK_PROVIDER,
          plan: {
            id: planId,
            threadId: turn.input.threadId,
            runId: turn.input.runId,
            nodeId: base.nodeId,
            kind: "todo_list",
            status: steps.every((step) => step.status === "completed") ? "completed" : "active",
            steps,
          },
        });
        yield* emit({
          type: "node.updated",
          driver: GROK_PROVIDER,
          node: {
            id: base.nodeId,
            threadId: base.threadId,
            runId: base.runId,
            parentNodeId: turn.input.rootNodeId,
            rootNodeId: turn.input.rootNodeId,
            kind: "todo_list",
            status: "completed",
            countsForRun: false,
            providerThreadId: base.providerThreadId,
            providerTurnId: base.providerTurnId,
            nativeItemRef: null,
            runtimeRequestId: null,
            checkpointScopeId: null,
            startedAt: base.startedAt,
            completedAt: time,
          },
        });
        yield* emit({
          type: "turn_item.updated",
          driver: GROK_PROVIDER,
          turnItem: {
            ...base,
            nativeItemRef: null,
            type: "todo_list",
            status: "completed",
            title: null,
            completedAt: time,
            planId,
            steps,
          },
        });
      });
      const resolvePending = Effect.fnUntraced(function* (
        entry: PendingRequest,
        status: "resolved" | "cancelled",
      ) {
        const time = yield* DateTime.now;
        entry.request = {
          ...entry.request,
          ...(status === "resolved" ? entry.response : undefined),
          status,
          resolvedAt: time,
          responseCapability: { type: "not_resumable", reason: "This Grok request has ended." },
        };
        entry.node = {
          ...entry.node,
          status: status === "resolved" ? "completed" : "cancelled",
          completedAt: time,
        };
        entry.item = {
          ...entry.item,
          status: status === "resolved" ? "completed" : "cancelled",
          completedAt: time,
          updatedAt: time,
        };
        pending.delete(entry.request.id);
        yield* emit({
          type: "runtime_request.updated",
          driver: GROK_PROVIDER,
          threadId: input.threadId,
          runtimeRequest: entry.request,
        });
        yield* emit({ type: "node.updated", driver: GROK_PROVIDER, node: entry.node });
        yield* emit({ type: "turn_item.updated", driver: GROK_PROVIDER, turnItem: entry.item });
      });
      /** Answers every open permission request with ACP's cancelled outcome. */
      const cancelPending = Effect.fnUntraced(function* () {
        for (const entry of [...pending.values()]) {
          entry.answer(CANCELLED_OUTCOME);
          yield* resolvePending(entry, "cancelled");
        }
      });
      const finish = Effect.fnUntraced(function* (
        turn: ActiveTurn,
        status: "completed" | "cancelled" | "interrupted" | "failed",
        detail?: string,
        disposition: "reusable" | "broken" = "reusable",
        failureOverride?: ReturnType<typeof makeProviderFailure>,
      ) {
        if (active !== turn) return;
        const completedAt = yield* DateTime.now;
        yield* closeSegments(turn);
        // Tools still running when the turn ends end with it.
        for (const tool of turn.tools.values())
          if (tool.status === "pending" || tool.status === "in_progress")
            yield* publishTool(turn, tool, status === "completed" ? "completed" : "cancelled");
        yield* cancelPending();
        turn.providerTurn = { ...turn.providerTurn, status, completedAt };
        yield* emit({
          type: "provider_turn.updated",
          driver: GROK_PROVIDER,
          threadId: turn.input.threadId,
          providerTurn: turn.providerTurn,
        });
        yield* updateThread({ status: disposition === "broken" ? "error" : "idle" });
        yield* updateSession(
          disposition === "broken" ? "error" : "ready",
          status === "failed" || disposition === "broken" ? (detail ?? null) : null,
        );
        active = undefined;
        if (status === "failed") {
          const failure =
            failureOverride ??
            makeProviderFailure({
              class: disposition === "broken" ? "transport_error" : "provider_error",
              message: detail ?? "Grok turn failed.",
            });
          const base = baseItem(turn, `failure:${turn.nativeId}`, completedAt);
          yield* emit({
            type: "turn_item.updated",
            driver: GROK_PROVIDER,
            turnItem: {
              ...base,
              type: "error",
              status: "failed",
              title: null,
              completedAt,
              failure,
            },
          });
          yield* emit({
            type: "turn.terminal",
            driver: GROK_PROVIDER,
            providerThreadId: turn.providerTurn.providerThreadId,
            providerTurnId: turn.providerTurn.id,
            runOrdinal: turn.input.runOrdinal,
            status,
            failure,
            failureItemOrdinal: base.ordinal,
            threadDisposition: disposition,
          });
        } else {
          yield* emit({
            type: "turn.terminal",
            driver: GROK_PROVIDER,
            providerThreadId: turn.providerTurn.providerThreadId,
            providerTurnId: turn.providerTurn.id,
            runOrdinal: turn.input.runOrdinal,
            status,
            failure: null,
            threadDisposition: disposition,
          });
        }
        yield* Deferred.succeed(turn.done, undefined);
      });
      const failHost = Effect.fnUntraced(function* (cause: unknown) {
        if (closed || broken) return;
        broken = true;
        const rootCause = Cause.isCause(cause) ? Cause.squash(cause) : cause;
        const detail = isProtocolError(rootCause)
          ? rootCause.detail
          : rootCause instanceof Error
            ? rootCause.message
            : "Grok transport failed.";
        if (active) yield* finish(active, "failed", detail, "broken");
        else {
          yield* updateThread({ status: "error" });
          yield* updateSession("error", detail);
        }
        yield* Queue.fail(events, protocolError(detail, cause));
        const failed = host;
        yield* Effect.tryPromise(() => failed.close()).pipe(Effect.ignore, Effect.forkIn(scope));
      });
      /** Shows a Grok permission request as a Cogenly approval. */
      const publishRequest = Effect.fnUntraced(function* (
        turn: ActiveTurn,
        native: GrokPermissionRequest,
        answer: (outcome: unknown) => void,
      ) {
        if (!thread) {
          answer(CANCELLED_OUTCOME);
          return;
        }
        const nativeId = native.toolCallId ?? `permission:${turn.nativeId}:${pending.size}`;
        const requestId = yield* idAllocator.allocate
          .runtimeRequest({
            driver: GROK_PROVIDER,
            providerTurnId: turn.providerTurn.id,
            nativeRequestId: nativeId,
          })
          .pipe(Effect.mapError((cause) => protocolError("Cannot allocate Grok request", cause)));
        const time = yield* DateTime.now;
        const nodeId = idAllocator.derive.approvalNode({ requestId });
        const kind = grokRequestKind(native.kind);
        const runtimeRequest: OrchestrationV2RuntimeRequest = {
          id: requestId,
          nodeId,
          providerTurnId: turn.providerTurn.id,
          nativeRequestRef: nativeRef(nativeId),
          kind,
          status: "pending",
          responseCapability: { type: "live", providerSessionId: input.providerSessionId },
          createdAt: time,
          resolvedAt: null,
        };
        const node: OrchestrationV2ExecutionNode = {
          id: nodeId,
          threadId: turn.input.threadId,
          runId: turn.input.runId,
          parentNodeId: turn.input.rootNodeId,
          rootNodeId: turn.input.rootNodeId,
          kind: "approval_request",
          status: "waiting",
          countsForRun: false,
          providerThreadId: thread.id,
          providerTurnId: turn.providerTurn.id,
          nativeItemRef: nativeRef(nativeId),
          runtimeRequestId: requestId,
          checkpointScopeId: null,
          startedAt: time,
          completedAt: null,
        };
        const command =
          typeof (native.rawInput as { command?: unknown } | undefined)?.command === "string"
            ? (native.rawInput as { command: string }).command
            : undefined;
        const item: OrchestrationV2TurnItem = {
          ...baseItem(turn, `request:${nativeId}`, time),
          id: idAllocator.derive.approvalTurnItem({ requestId }),
          nodeId,
          status: "waiting",
          title: null,
          completedAt: null,
          type: "approval_request",
          requestId,
          requestKind: kind,
          prompt: command ?? native.title,
          options: grokApprovalOptions(native),
        };
        pending.set(requestId, { native, answer, request: runtimeRequest, node, item });
        yield* emit({
          type: "runtime_request.updated",
          driver: GROK_PROVIDER,
          threadId: turn.input.threadId,
          runtimeRequest,
        });
        yield* emit({ type: "node.updated", driver: GROK_PROVIDER, node });
        yield* emit({ type: "turn_item.updated", driver: GROK_PROVIDER, turnItem: item });
        yield* updateSession("waiting");
      });
      /**
       * Grok asks before acting. Full-access Work approves on the user's behalf;
       * chat-surface threads decline anything that changes the machine; other
       * modes wait for the user.
       */
      const handlePermission = Effect.fnUntraced(function* (
        params: unknown,
        answer: (outcome: unknown) => void,
      ) {
        const native = parseGrokPermissionRequest(params);
        const turn = active;
        if (!native || !turn || native.sessionId !== nativeSessionId) {
          answer(CANCELLED_OUTCOME);
          return;
        }
        if (conversationMode && native.kind && GROK_MUTATING_TOOL_KINDS.has(native.kind)) {
          answer({ outcome: grokPermissionOutcome(native, "decline") ?? { outcome: "cancelled" } });
          return;
        }
        if (input.runtimePolicy.runtimeMode === "full-access") {
          const outcome = grokPermissionOutcome(native, "accept");
          if (outcome) {
            answer({ outcome });
            return;
          }
        }
        yield* publishRequest(turn, native, answer);
      });
      const handleUpdate = Effect.fnUntraced(function* (
        turn: ActiveTurn,
        update: GrokSessionUpdate,
      ) {
        switch (update.type) {
          case "agent_message_chunk":
          case "agent_thought_chunk": {
            const kind = update.type === "agent_message_chunk" ? "message" : "reasoning";
            // A switch between thinking and answering closes the other block.
            const other = kind === "message" ? turn.reasoning : turn.message;
            if (other) {
              yield* publishSegment(
                turn,
                kind === "message" ? "reasoning" : "message",
                other,
                false,
              );
              if (kind === "message") turn.reasoning = undefined;
              else turn.message = undefined;
            }
            const current =
              (kind === "message" ? turn.message : turn.reasoning) ??
              ({ key: `${kind}:${turn.segments++}`, text: "" } satisfies Segment);
            current.text += update.text;
            if (kind === "message") turn.message = current;
            else turn.reasoning = current;
            turn.dirty = true;
            if (!turn.flushScheduled) {
              turn.flushScheduled = true;
              yield* Effect.sleep(50).pipe(
                Effect.andThen(Queue.offer(inbox, { type: "flush", turn })),
                Effect.forkIn(scope),
              );
            }
            return;
          }
          case "tool_call": {
            yield* closeSegments(turn);
            turn.tools.set(update.toolCall.toolCallId, update.toolCall);
            return yield* publishTool(turn, update.toolCall);
          }
          case "tool_call_update": {
            const previous = turn.tools.get(update.toolCallId) ?? {
              toolCallId: update.toolCallId,
              title: "Tool",
              kind: undefined,
              status: "in_progress" as const,
              rawInput: undefined,
              rawOutput: undefined,
              text: [],
              diffs: [],
              locations: [],
            };
            const tool = applyGrokToolPatch(previous, update.patch);
            turn.tools.set(tool.toolCallId, tool);
            return yield* publishTool(turn, tool);
          }
          case "plan":
            return yield* publishPlan(turn, update);
          case "usage_update": {
            const tokenUsage = {
              ...turn.providerTurn.tokenUsage,
              usedTokens: update.used,
              maxTokens: update.size ?? turn.providerTurn.tokenUsage?.maxTokens ?? undefined,
              updatedAt: DateTime.formatIso(yield* DateTime.now),
            };
            yield* updateThread({ contextUsage: tokenUsage });
            turn.providerTurn = { ...turn.providerTurn, tokenUsage };
            return yield* emit({
              type: "provider_turn.updated",
              driver: GROK_PROVIDER,
              providerTurn: turn.providerTurn,
            });
          }
        }
      });
      /** The `session/prompt` reply ends the turn: its stop reason and usage. */
      const handlePromptDone = Effect.fnUntraced(function* (turn: ActiveTurn, result: unknown) {
        if (active !== turn) return;
        const usage = parseGrokPromptUsage(result);
        if (usage)
          turn.providerTurn = {
            ...turn.providerTurn,
            turnTokenUsage: {
              usageScope: "main_agent",
              usageStatus: "complete",
              hasSubagents: false,
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
              cachedInputTokens: usage.cachedInputTokens,
              reasoningTokens: usage.reasoningTokens,
              ...(usage.cacheCreationTokens === undefined
                ? {}
                : { cacheCreationTokens: usage.cacheCreationTokens }),
            },
          };
        const stopReason = parseGrokStopReason(result);
        if (stopReason === "cancelled")
          return yield* finish(turn, turn.interruptRequested ? "interrupted" : "cancelled");
        if (stopReason === "refusal")
          return yield* finish(turn, "failed", "Grok declined to continue this request.");
        yield* finish(turn, "completed");
        // A turn spends from the shared Grok pool; refresh the bars without blocking.
        if (options.onUsageLimits) {
          const onUsageLimits = options.onUsageLimits;
          yield* readGrokBillingFromHost(host).pipe(
            Effect.flatMap((limits) => (limits ? onUsageLimits(limits) : Effect.void)),
            Effect.ignore,
            Effect.forkIn(scope),
          );
        }
      });
      const handlePromptFailed = Effect.fnUntraced(function* (turn: ActiveTurn, cause: unknown) {
        if (active !== turn) return;
        const message = cause instanceof Error ? cause.message : "Grok could not run this turn.";
        const data = cause instanceof AcpRpcError ? cause.data : undefined;
        if (turn.interruptRequested) return yield* finish(turn, "interrupted");
        yield* finish(
          turn,
          "failed",
          message,
          "reusable",
          isGrokUsageLimitError(message, data)
            ? makeProviderFailure({ class: "usage_limit", message, retryable: true })
            : undefined,
        );
      });

      yield* Stream.fromQueue(inbox).pipe(
        Stream.runForEach((entry) =>
          Effect.gen(function* () {
            switch (entry.type) {
              case "flush": {
                const turn = entry.turn;
                turn.flushScheduled = false;
                if (active !== turn || !turn.dirty) return;
                turn.dirty = false;
                if (turn.reasoning) yield* publishSegment(turn, "reasoning", turn.reasoning, true);
                if (turn.message) yield* publishSegment(turn, "message", turn.message, true);
                return;
              }
              case "promptDone":
                return yield* handlePromptDone(entry.turn, entry.result).pipe(
                  Effect.catch(failHost),
                );
              case "promptFailed":
                return yield* handlePromptFailed(entry.turn, entry.cause).pipe(
                  Effect.catch(failHost),
                );
              case "failure":
                if (entry.epoch === hostEpoch) yield* failHost(entry.cause);
                return;
              case "permission":
                if (entry.epoch !== hostEpoch) {
                  entry.answer(CANCELLED_OUTCOME);
                  return;
                }
                return yield* handlePermission(entry.params, entry.answer).pipe(
                  Effect.catch((cause) =>
                    Effect.sync(() => entry.answer(CANCELLED_OUTCOME)).pipe(
                      Effect.andThen(failHost(cause)),
                    ),
                  ),
                );
              case "notification": {
                if (entry.epoch !== hostEpoch || entry.method !== "session/update") return;
                const params = entry.params as
                  | { sessionId?: unknown; update?: unknown }
                  | undefined;
                if (params?.sessionId !== nativeSessionId) return;
                const update = parseGrokSessionUpdate(params?.update);
                if (!update) return;
                if (
                  options.nativeEventLogger &&
                  update.type !== "agent_message_chunk" &&
                  update.type !== "agent_thought_chunk"
                )
                  yield* options.nativeEventLogger.write(
                    { provider: "grok", method: entry.method, params: entry.params },
                    input.threadId,
                  );
                // Updates outside a turn replay history during session/load; Cogenly already has it.
                const turn = active;
                if (!turn) return;
                return yield* handleUpdate(turn, update).pipe(
                  Effect.catch((cause) =>
                    Effect.logWarning("Skipped an unreadable Grok update", cause),
                  ),
                );
              }
            }
          }).pipe(eventPermit.withPermits(1)),
        ),
        Effect.forkIn(scope),
      );

      const launchHost = Effect.fnUntraced(function* () {
        const epoch = ++hostEpoch;
        const mcpSession = yield* mcpSessions.read(input.threadId);
        const environment = McpProviderSession.withAgentDeviceEnvironment(
          options.environment,
          mcpSession,
        );
        const launch = yield* agentScope.wrap({
          command: options.settings.binaryPath || "grok",
          args: [],
          name: "grok",
          threadId: input.threadId,
          env: environment,
        });
        const created = yield* Effect.acquireRelease(
          createGrokAcpHostEffect(
            {
              binaryPath: launch.command,
              launchArgs: launch.args,
              cwd,
              environment,
            },
            options.createHost,
          ).pipe(
            Effect.mapError(
              (error) =>
                new ProviderAdapter.ProviderAdapterOpenSessionError({
                  driver: GROK_PROVIDER,
                  providerSessionId: input.providerSessionId,
                  cause: error.cause,
                }),
            ),
          ),
          (created) =>
            Effect.gen(function* () {
              if (host === created) {
                closed = true;
                hostEpoch++;
              }
              yield* Effect.tryPromise(() => created.close()).pipe(Effect.ignore);
            }),
          { interruptible: true },
        ).pipe(Effect.provideService(Scope.Scope, scope));
        host = created;
        created.connection.onNotification((notification) => {
          Queue.offerUnsafe(inbox, {
            type: "notification",
            method: notification.method,
            params: notification.params,
            epoch,
          });
        });
        created.connection.onProtocolError((cause) => {
          Queue.offerUnsafe(inbox, { type: "failure", cause, epoch });
        });
        created.connection.onRequest(async (agentRequest) => {
          if (agentRequest.method !== "session/request_permission")
            throw new Error(`Unsupported Grok request: ${agentRequest.method}`);
          return await new Promise<unknown>((resolve) => {
            Queue.offerUnsafe(inbox, {
              type: "permission",
              params: agentRequest.params,
              answer: resolve,
              epoch,
            });
          });
        });
        void created.exited.then((exit) => {
          if (!closed && epoch === hostEpoch) {
            const reason = created
              .stderrTail()
              .findLast((line) => line.trim())
              ?.trim();
            Queue.offerUnsafe(inbox, {
              type: "failure",
              cause: new Error(
                `Grok exited unexpectedly (${exit.code ?? exit.signal})${reason ? `: ${reason}` : ""}`,
              ),
              epoch,
            });
          }
        });
      });
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          closed = true;
          hostEpoch++;
          if (active) yield* finish(active, "cancelled", "Grok session closed", "broken");
          yield* Queue.shutdown(inbox);
          yield* Queue.shutdown(events);
        }).pipe(eventPermit.withPermits(1)),
      );
      yield* launchHost();

      /** The Cogenly MCP server, attached when Grok accepts HTTP MCP servers. */
      const mcpServersFor = Effect.fnUntraced(function* (
        threadId: ProviderAdapter.ProviderAdapterV2EnsureThreadInput["threadId"],
      ) {
        const mcp = yield* mcpSessions.read(threadId);
        if (!mcp || !host.initializeResult.agentCapabilities.mcpHttp) return [];
        return [
          {
            type: "http",
            name: "cogenly",
            url: mcp.endpoint,
            headers: [{ name: "Authorization", value: mcp.authorizationHeader }],
          },
        ];
      });
      // The catalog's default model, from the provider snapshot, when the selection names none.
      const resolveModel = Effect.fnUntraced(function* (selection: ModelSelection) {
        const slug = selection.model.trim();
        if (slug && slug !== "default") return slug;
        const catalog = options.modelCatalog ? yield* options.modelCatalog : [];
        return (
          catalog.find((model) => model.isDefault && !model.isCustom)?.slug ?? GROK_DEFAULT_MODEL
        );
      });
      // The reasoning tier the session runs at, as Grok last reported or Cogenly set it.
      let currentEffort: string | undefined;
      /** Applies the selection's model and reasoning tier; a refusal keeps the current ones. */
      const setModel = Effect.fnUntraced(function* (selection: ModelSelection) {
        const sessionId = nativeSessionId;
        if (!sessionId) return;
        const model = yield* resolveModel(selection);
        if (session.model !== model)
          // Grok 1.0.67 takes the model as a config option; `session/set_model` is the older ACP method.
          yield* request("session/set_config_option", {
            sessionId,
            configId: GROK_MODEL_CONFIG_ID,
            value: model,
          }).pipe(
            Effect.catch(() => request("session/set_model", { sessionId, modelId: model })),
            Effect.tap(() => Effect.sync(() => (session = { ...session, model }))),
            Effect.catch((cause) => Effect.logWarning("Grok kept its model", cause)),
          );
        const catalog = options.modelCatalog ? yield* options.modelCatalog : [];
        const effort = resolveGrokReasoningEffort(
          catalog.find((entry) => entry.slug === model)?.capabilities ?? grokModelCapabilities(),
          getModelSelectionStringOptionValue(selection, "reasoningEffort"),
        );
        if (effort && effort !== currentEffort)
          yield* request("session/set_config_option", {
            sessionId,
            configId: GROK_REASONING_CONFIG_ID,
            value: effort,
          }).pipe(
            Effect.tap(() => Effect.sync(() => (currentEffort = effort))),
            Effect.catch((cause) => Effect.logWarning("Grok kept its reasoning effort", cause)),
          );
      });

      const register = Effect.fnUntraced(function* (
        args: ProviderAdapter.ProviderAdapterV2EnsureThreadInput,
      ) {
        if (broken || closed)
          return yield* protocolError("Grok host is unavailable; reopen the session");
        if (active)
          return yield* protocolError("Cannot change Grok sessions during an active turn");
        const existing = args.existingProviderThread;
        if (
          existing &&
          (existing.driver !== GROK_PROVIDER || existing.providerInstanceId !== options.instanceId)
        )
          return yield* protocolError("Grok thread belongs to another provider instance");
        const requestedId = existing
          ? (existing.nativeThreadRef?.nativeId ?? undefined)
          : input.initialNativeThreadId;
        if (
          thread &&
          (!requestedId || requestedId === nativeSessionId) &&
          thread.appThreadId === args.threadId
        )
          return thread;
        if (thread) return yield* protocolError("Open a new host to attach another Grok session");
        const mcpServers = yield* mcpServersFor(args.threadId);
        if (requestedId) {
          if (!host.initializeResult.agentCapabilities.loadSession)
            return yield* protocolError("This Grok Build CLI cannot resume a saved session");
          // History replays as session/update while no turn is active, and is ignored.
          const loaded = parseGrokSessionResult(
            yield* request("session/load", { sessionId: requestedId, cwd, mcpServers }),
          );
          nativeSessionId = requestedId;
          if (loaded.currentModelId) session = { ...session, model: loaded.currentModelId };
          currentEffort = loaded.reasoningEffort;
        } else {
          const result = parseGrokSessionResult(yield* request("session/new", { cwd, mcpServers }));
          if (!result.sessionId) return yield* protocolError("Grok did not return a session id");
          nativeSessionId = result.sessionId;
          if (result.currentModelId) session = { ...session, model: result.currentModelId };
          currentEffort = result.reasoningEffort;
        }
        yield* setModel(args.modelSelection);
        const createdAt = yield* DateTime.now;
        thread = existing
          ? {
              ...existing,
              providerSessionId: input.providerSessionId,
              nativeThreadRef: nativeRef(nativeSessionId),
              status: "idle",
              updatedAt: createdAt,
            }
          : {
              id: idAllocator.derive.providerThread({
                driver: GROK_PROVIDER,
                providerInstanceId: options.instanceId,
                nativeThreadId: nativeSessionId,
              }),
              driver: GROK_PROVIDER,
              providerInstanceId: options.instanceId,
              providerSessionId: input.providerSessionId,
              appThreadId: args.threadId,
              ownerNodeId: null,
              nativeThreadRef: nativeRef(nativeSessionId),
              nativeConversationHeadRef: null,
              status: "idle",
              firstRunOrdinal: null,
              lastRunOrdinal: null,
              handoffIds: [],
              forkedFrom: null,
              createdAt,
              updatedAt: createdAt,
            };
        yield* emit({
          type: "provider_thread.updated",
          driver: GROK_PROVIDER,
          providerThread: thread,
        });
        return thread;
      });
      /** The user's message as ACP content blocks: text, then native images. */
      const promptBlocks = Effect.fnUntraced(function* (
        message: ProviderAdapter.ProviderAdapterV2TurnMessage,
      ) {
        const blocks: Array<Record<string, unknown>> = [];
        const text = providerMessageTextWithAttachmentPaths({
          text: message.text,
          attachments: message.attachments,
          resolveAttachmentPath: providerHost.resolveAttachmentPath,
        });
        if (text) blocks.push({ type: "text", text });
        if (host.initializeResult.agentCapabilities.image)
          for (const attachment of message.attachments)
            if (isProviderNativeImageAttachment(attachment)) {
              const path = providerHost.resolveAttachmentPath(attachment);
              if (!path) return yield* protocolError("Grok image attachment is missing");
              const bytes = yield* fileSystem
                .readFile(path)
                .pipe(Effect.mapError((cause) => protocolError("Cannot read Grok image", cause)));
              blocks.push({
                type: "image",
                mimeType: attachment.mimeType,
                data: Buffer.from(bytes).toString("base64"),
              });
            }
        if (!blocks.length) return yield* protocolError("Grok needs text or an image");
        return blocks;
      });
      const validateThread = (candidate: OrchestrationV2ProviderThread) =>
        thread !== undefined &&
        candidate.driver === GROK_PROVIDER &&
        candidate.providerInstanceId === options.instanceId &&
        candidate.appThreadId === thread.appThreadId &&
        candidate.nativeThreadRef?.nativeId === nativeSessionId;

      const start = Effect.fnUntraced(function* (
        turnInput: ProviderAdapter.ProviderAdapterV2TurnInput,
      ) {
        if (!validateThread(turnInput.providerThread) || broken || closed || !nativeSessionId)
          return yield* protocolError("Grok thread is not attached to this host");
        if (active)
          return yield* protocolError(
            "Grok already has an active turn; queue through the orchestrator",
          );
        if (turnInput.runtimePolicy.interactionMode === "plan")
          return yield* protocolError("Grok does not support dedicated Plan mode");
        if (turnInput.runtimePolicy.runtimeMode !== input.runtimePolicy.runtimeMode)
          return yield* protocolError("Runtime policy changes require a fresh Grok host");
        const blocks = yield* promptBlocks(turnInput.message);
        yield* setModel(turnInput.modelSelection);
        const mcp = yield* mcpSessions.read(turnInput.threadId);
        const instructions =
          buildRuntimeInstructions({ harness: "Grok Build", model: session.model ?? undefined }) +
          (turnInput.runtimePolicy.conversationMode === true
            ? `\n${CONVERSATION_MODE_INSTRUCTIONS}`
            : "") +
          (turnInput.runtimePolicy.projectManifest === undefined
            ? ""
            : `\n${turnInput.runtimePolicy.projectManifest}`) +
          (mcp && host.initializeResult.agentCapabilities.mcpHttp
            ? `\n${COGENLY_ORCHESTRATION_INSTRUCTIONS.replaceAll("T3", "Cogenly")}`
            : "");
        // ACP has no turn ids; each run attempt is its own turn.
        const nativeId = `turn-${turnInput.attemptId}`;
        const startedAt = yield* DateTime.now;
        const providerTurn: OrchestrationV2ProviderTurn = {
          id: idAllocator.derive.providerTurn({
            driver: GROK_PROVIDER,
            nativeTurnId: `${options.instanceId}:${nativeSessionId}:${turnInput.runId}:${nativeId}`,
          }),
          providerThreadId: turnInput.providerThread.id,
          nodeId: turnInput.rootNodeId,
          runAttemptId: turnInput.attemptId,
          // ACP has no turn ids; this one is Cogenly's.
          nativeTurnRef: { ...nativeRef(nativeId), strength: "weak" },
          ordinal: turnInput.providerTurnOrdinal,
          status: "running",
          startedAt,
          completedAt: null,
        };
        const turn: ActiveTurn = {
          input: turnInput,
          providerTurn,
          nativeId,
          ordinals: new Map(),
          started: new Map(),
          tools: new Map(),
          done: yield* Deferred.make<void>(),
          message: undefined,
          reasoning: undefined,
          segments: 0,
          dirty: false,
          flushScheduled: false,
          nextOrdinal: turnInput.providerTurnOrdinal * 100 + 1,
          interruptRequested: false,
        };
        yield* Effect.gen(function* () {
          thread = turnInput.providerThread;
          active = turn;
          yield* emit({
            type: "provider_turn.updated",
            driver: GROK_PROVIDER,
            threadId: turnInput.threadId,
            providerTurn,
          });
          yield* updateThread({
            status: "active",
            firstRunOrdinal: thread.firstRunOrdinal ?? turnInput.runOrdinal,
            lastRunOrdinal: turnInput.runOrdinal,
          });
          yield* updateSession("running");
        }).pipe(eventPermit.withPermits(1));
        // The reply arrives when the turn ends; it is queued behind the turn's
        // own updates, so the last text lands before the turn finishes.
        const sessionId = nativeSessionId;
        const connection = host.connection;
        yield* Effect.sync(() => {
          void connection
            .request("session/prompt", {
              sessionId,
              prompt: [{ type: "text", text: instructions }, ...blocks],
            })
            .then(
              (result) => Queue.offerUnsafe(inbox, { type: "promptDone", turn, result }),
              (cause: unknown) => Queue.offerUnsafe(inbox, { type: "promptFailed", turn, cause }),
            );
        });
      });

      const runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime = {
        instanceId: options.instanceId,
        driver: GROK_PROVIDER,
        providerSessionId: input.providerSessionId,
        providerSession: session,
        events: Stream.fromQueue(events),
        ensureThread: (args) =>
          register(args).pipe(
            commands.withPermits(1),
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterEnsureThreadError({
                  driver: GROK_PROVIDER,
                  threadId: args.threadId,
                  cause,
                }),
            ),
          ),
        resumeThread: (args) =>
          register({
            threadId: args.threadId ?? args.providerThread.appThreadId ?? input.threadId,
            modelSelection: args.modelSelection ?? input.modelSelection,
            runtimePolicy: args.runtimePolicy ?? input.runtimePolicy,
            existingProviderThread: args.providerThread,
          }).pipe(
            commands.withPermits(1),
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterResumeThreadError({
                  driver: GROK_PROVIDER,
                  providerSessionId: input.providerSessionId,
                  providerThreadId: args.providerThread.id,
                  cause,
                }),
            ),
          ),
        startTurn: (args) =>
          start(args).pipe(
            commands.withPermits(1),
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterTurnStartError({
                  driver: GROK_PROVIDER,
                  threadId: args.threadId,
                  providerThreadId: args.providerThread.id,
                  runId: args.runId,
                  cause,
                }),
            ),
          ),
        steerTurn: (args) =>
          Effect.fail(
            new ProviderAdapter.ProviderAdapterSteerRunUnsupportedError({
              driver: GROK_PROVIDER,
              providerThreadId: args.providerThread.id,
            }),
          ),
        interruptTurn: (args) =>
          Effect.gen(function* () {
            const turn = active;
            if (
              !turn ||
              turn.providerTurn.id !== args.providerTurnId ||
              !validateThread(args.providerThread) ||
              !nativeSessionId
            )
              return yield* protocolError("This Grok turn is no longer active");
            turn.interruptRequested = true;
            const sessionId = nativeSessionId;
            yield* eventPermit.withPermits(1)(cancelPending());
            yield* Effect.sync(() => host.connection.notify("session/cancel", { sessionId }));
            yield* Deferred.await(turn.done).pipe(
              Effect.timeout(options.requestTimeoutMs ?? 30_000),
              Effect.mapError((cause) => protocolError("Grok did not confirm interruption", cause)),
              Effect.onError((cause) => eventPermit.withPermits(1)(failHost(cause))),
            );
          }).pipe(
            commands.withPermits(1),
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterInterruptError({
                  driver: GROK_PROVIDER,
                  providerThreadId: args.providerThread.id,
                  providerTurnId: args.providerTurnId,
                  cause,
                }),
            ),
          ),
        respondToRuntimeRequest: (args) =>
          Effect.gen(function* () {
            const entry = pending.get(args.requestId);
            if (!entry) return yield* protocolError("This Grok request is no longer pending");
            const decision = args.decision ?? "cancel";
            const outcome = grokPermissionOutcome(entry.native, decision);
            if (!outcome) return yield* protocolError("Grok did not offer this approval decision");
            entry.response = { decision };
            entry.answer({ outcome });
            yield* eventPermit.withPermits(1)(
              Effect.gen(function* () {
                yield* resolvePending(entry, "resolved");
                if (!pending.size) yield* updateSession(active ? "running" : "ready");
              }),
            );
          }).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterRuntimeRequestResponseError({
                  driver: GROK_PROVIDER,
                  requestId: args.requestId,
                  cause,
                }),
            ),
          ),
        // ACP cannot read a conversation back; Cogenly owns turn and item history.
        readThreadSnapshot: (args) =>
          Effect.succeed({
            providerThread: args.providerThread,
            providerTurns: [],
            messages: [],
            runtimeRequests: [...pending.values()].map((entry) => entry.request),
          }),
        rollbackThread: (args) =>
          Effect.fail(
            new ProviderAdapter.ProviderAdapterRollbackThreadError({
              driver: GROK_PROVIDER,
              providerThreadId: args.providerThread.id,
              checkpointId: args.target.checkpointId,
              cause: "Grok cannot rewind its conversation in Cogenly.",
            }),
          ),
        forkThread: (args) =>
          Effect.fail(
            new ProviderAdapter.ProviderAdapterForkThreadError({
              driver: GROK_PROVIDER,
              providerThreadId: args.sourceProviderThread.id,
              cause: "Grok does not support native forks in Cogenly.",
            }),
          ),
      };
      return runtime;
    }),
  });
});
