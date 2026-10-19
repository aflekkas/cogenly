import * as Access from "./AgentAccessScope.ts";
import {
  AgentError,
  AgentEventContext,
  AgentId,
  AgentApproval,
  AgentApprovalAction,
  AgentActivityResult,
  AgentActivityRun,
  AgentRunAction,
  AgentStartWorkInput,
  Commitment,
  CommitmentHistory,
  CommandId,
  ScheduledTaskId,
  ThreadId,
  type Agent,
  type AgentApprovalListInput,
  type CommitmentCreateInput,
  type CommitmentListInput,
  type CommitmentStatusInput,
  type CommitmentRef,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as Store from "./AgentStore.ts";
import * as Agents from "./AgentService.ts";
import * as Work from "../work/WorkHandoffService.ts";
import * as Schedules from "../scheduledTasks/ScheduledTaskService.ts";

const decodeEventContext = Schema.decodeUnknownEffect(Schema.fromJsonString(AgentEventContext));
const isAgentError = Schema.is(AgentError);
const decodeCommitment = Schema.decodeEffect(Schema.fromJsonString(Commitment));
const encodeHistory = Schema.encodeEffect(Schema.fromJsonString(CommitmentHistory));
const encodeCommitment = Schema.encodeEffect(Schema.fromJsonString(Commitment));
const decodeApprovalAction = Schema.decodeUnknownEffect(Schema.fromJsonString(AgentApprovalAction));
const decodeApproval = Schema.decodeUnknownEffect(AgentApproval);
const encodeApprovalAction = Schema.encodeEffect(Schema.fromJsonString(AgentApprovalAction));
const decodeHistory = Schema.decodeUnknownEffect(Schema.fromJsonString(CommitmentHistory));
const decodeJsonRecord = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
const decodeActivityRun = Schema.decodeUnknownEffect(AgentActivityRun);
const decodeRunAction = Schema.decodeUnknownEffect(AgentRunAction);

type AgentActor = { readonly agent: Agent; readonly threadId: ThreadId };
const fail = (message: string) => new AgentError({ message });
const wrap = (cause: unknown) =>
  isAgentError(cause)
    ? cause
    : new AgentError({ message: "Could not access agent workspace state.", cause });
export class AgentWorkspaceService extends Context.Service<
  AgentWorkspaceService,
  {
    readonly listCommitments: (
      input: CommitmentListInput,
      actor?: AgentActor,
    ) => Effect.Effect<{ commitments: ReadonlyArray<Commitment> }, AgentError>;
    readonly listOpenItems: (
      input: CommitmentListInput,
      actor: AgentActor,
    ) => Effect.Effect<{ commitments: ReadonlyArray<Commitment> }, AgentError>;
    readonly createCommitment: (
      input: CommitmentCreateInput,
      actor?: AgentActor,
    ) => Effect.Effect<{ commitment: Commitment }, AgentError>;
    readonly updateCommitmentStatus: (
      input: CommitmentStatusInput,
      actor?: AgentActor,
    ) => Effect.Effect<{ commitment: Commitment }, AgentError>;
    readonly confirmCommitment: (input: {
      id: string;
      why: string;
    }) => Effect.Effect<{ commitment: Commitment }, AgentError>;
    readonly dismissCommitment: (input: {
      id: string;
      why: string;
    }) => Effect.Effect<{ commitment: Commitment }, AgentError>;
    readonly deleteCommitment: (id: string) => Effect.Effect<{ deleted: boolean }, AgentError>;
    readonly commitmentHistory: (
      id: string,
    ) => Effect.Effect<{ history: ReadonlyArray<typeof CommitmentHistory.Type> }, AgentError>;
    readonly requestApproval: (
      agentId: AgentId,
      action: AgentApprovalAction,
      actor?: AgentActor,
    ) => Effect.Effect<{ approval: AgentApproval }, AgentError>;
    readonly listApprovals: (
      input: typeof AgentApprovalListInput.Type,
    ) => Effect.Effect<{ approvals: ReadonlyArray<AgentApproval> }, AgentError>;
    readonly approve: (id: string) => Effect.Effect<{ approval: AgentApproval }, AgentError>;
    readonly reject: (id: string) => Effect.Effect<{ approval: AgentApproval }, AgentError>;
    readonly startWork: (
      input: AgentStartWorkInput,
      actor?: AgentActor,
    ) => Effect.Effect<{ threadId: ThreadId | null; approval: AgentApproval | null }, AgentError>;
    readonly activity: (
      agentId: AgentId,
    ) => Effect.Effect<typeof AgentActivityResult.Type, AgentError>;
    readonly logAction: (
      actor: AgentActor,
      kind: string,
      targetId?: string,
    ) => Effect.Effect<void, AgentError>;
  }
>()("t3/agents/AgentWorkspaceService") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const access = yield* Access.AgentAccessScope;
  const crypto = yield* Crypto.Crypto;
  const store = yield* Store.AgentStore;
  const agents = yield* Agents.AgentService;
  const work = yield* Work.WorkHandoffService;
  const schedules = yield* Schedules.ScheduledTaskService;
  const canSee = (scope: Access.ResolvedAgentAccess, item: Commitment) =>
    scope.agent.permissions.read &&
    (item.agentId === scope.agent.id ||
      item.labelIds.some((id) => scope.readableLabelIds.includes(id)));
  const canDraft = (
    scope: Access.ResolvedAgentAccess,
    item: Pick<Commitment, "labelIds" | "agentId">,
  ) =>
    scope.agent.permissions.draft &&
    scope.agent.autonomy !== "observe" &&
    (item.agentId === scope.agent.id ||
      item.labelIds.some((id) => scope.draftableLabelIds.includes(id)));
  const lock = yield* Semaphore.make(1);
  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const uuid = (prefix: string) =>
    crypto.randomUUIDv4().pipe(Effect.map((id) => `${prefix}:${id}`));
  // Reload policy on every operation: an invocation cannot retain a revoked grant.
  const current = (actor: AgentActor) =>
    store.get(actor.agent.id).pipe(Effect.map((agent) => ({ ...actor, agent })));
  const runIdFor = (actor: AgentActor) =>
    sql<{
      run_id: string;
    }>`SELECT run_id FROM orchestration_v2_projection_runs WHERE thread_id = ${actor.threadId} AND status <> 'queued' ORDER BY CASE WHEN status IN ('running', 'waiting', 'starting', 'preparing') THEN 0 ELSE 1 END, ordinal DESC LIMIT 1`.pipe(
      Effect.map((rows) => rows[0]?.run_id ?? null),
    );
  const logAction = (actor: AgentActor, kind: string, targetId?: string) =>
    Effect.gen(function* () {
      yield* sql`INSERT INTO agent_run_actions(id, agent_id, run_id, kind, target_id, at) VALUES (${yield* uuid("action")}, ${actor.agent.id}, ${yield* runIdFor(actor)}, ${kind}, ${targetId ?? null}, ${yield* now})`;
    }).pipe(Effect.mapError(wrap));
  const getCommitment = (id: string) =>
    Effect.gen(function* () {
      const rows = yield* sql<{
        payload_json: string;
        agent_id: string | null;
      }>`SELECT payload_json, agent_id FROM commitments WHERE id = ${id}`;
      const row = rows[0];
      if (!row) return yield* fail("Commitment not found.");
      const item = yield* decodeCommitment(row.payload_json);
      return {
        ...item,
        agentId: row.agent_id === null ? null : AgentId.make(row.agent_id),
      };
    }).pipe(Effect.mapError(wrap));
  const history = (
    item: Commitment,
    previous: Commitment["status"] | null,
    who: string,
    why: string,
    evidenceRefs: ReadonlyArray<CommitmentRef>,
  ) =>
    Effect.gen(function* () {
      const id = yield* uuid("history");
      const entry = {
        id,
        commitmentId: item.id,
        fromStatus: previous,
        toStatus: item.status,
        who,
        at: item.updatedAt,
        why,
        evidenceRefs,
      };
      yield* sql`INSERT INTO commitment_history(id, commitment_id, payload_json) VALUES (${id}, ${item.id}, ${yield* encodeHistory(entry)})`;
    });
  const updateCommitmentStatus = (input: CommitmentStatusInput, actor?: AgentActor) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const item = yield* getCommitment(input.id);
          const principal = actor ? yield* current(actor) : undefined;
          const scope = principal ? yield* access.resolve(principal.agent.id) : undefined;
          if (scope && (!canSee(scope, item) || !canDraft(scope, item)))
            return yield* fail("This agent cannot change this commitment.");
          if (principal && input.status === "done" && input.evidenceRefs.length === 0)
            return yield* fail("Completing a commitment requires evidence or owner confirmation.");
          if (
            principal &&
            item.status === "proposed" &&
            input.status !== "proposed" &&
            input.status !== "done" &&
            input.status !== "dismissed"
          )
            return yield* fail("Only the owner can confirm a proposed commitment.");
          const commitment: Commitment = {
            ...item,
            status: input.status,
            evidenceRefs: [...item.evidenceRefs, ...input.evidenceRefs],
            updatedAt: yield* now,
          };
          yield* sql`UPDATE commitments SET status = ${commitment.status}, updated_at = ${commitment.updatedAt}, payload_json = ${yield* encodeCommitment(commitment)} WHERE id = ${item.id}`;
          if (item.status !== commitment.status)
            yield* history(
              commitment,
              item.status,
              principal ? `agent:${principal.agent.id}` : "user",
              input.why,
              input.evidenceRefs,
            );
          if (principal) yield* logAction(principal, "commitment_status_changed", item.id);
          return { commitment };
        }),
      )
      .pipe(Effect.mapError(wrap));
  const approvalFromRow = (row: Record<string, unknown>) =>
    Effect.gen(function* () {
      const action = yield* decodeApprovalAction(row.action_json);
      return yield* decodeApproval({
        id: row.id,
        agentId: row.agent_id,
        action,
        actionKind: action.actionKind,
        payload: action.payload,
        status: row.status,
        requestedAt: row.requested_at,
        decidedAt: row.decided_at,
        decidedBy: row.decided_by,
        sourceRunId: row.source_run_id,
        resultThreadId: row.result_thread_id,
      });
    }).pipe(Effect.mapError(wrap));
  // Approval intent is deliberately short-lived; old model proposals must be reviewed afresh.
  const expireApprovals = () =>
    DateTime.now.pipe(
      Effect.map((at) => DateTime.formatIso(DateTime.subtract(at, { days: 7 }))),
      Effect.flatMap((before) =>
        now.pipe(
          Effect.flatMap(
            (at) =>
              sql`UPDATE agent_approvals SET status = 'expired', decided_at = ${at}, decided_by = 'system' WHERE status = 'pending' AND requested_at < ${before}`,
          ),
        ),
      ),
    );
  const getApproval = (id: string) =>
    Effect.gen(function* () {
      yield* expireApprovals();
      const rows = yield* sql`SELECT * FROM agent_approvals WHERE id = ${id}`;
      if (!rows[0]) return yield* fail("Approval not found.");
      return yield* approvalFromRow(rows[0]);
    }).pipe(Effect.mapError(wrap));
  const requestApproval = (agentId: AgentId, action: AgentApprovalAction, actor?: AgentActor) =>
    Effect.gen(function* () {
      const agent = actor ? (yield* current(actor)).agent : yield* store.get(agentId);
      if (agent.id !== agentId)
        return yield* fail("An agent cannot request an action for another agent.");
      if (actor && (agent.autonomy === "observe" || !agent.permissions.draft))
        return yield* fail("This agent can observe only.");
      if (action.actionKind === "start_work") {
        if (action.payload.agentId !== agentId)
          return yield* fail("Work must belong to the requesting agent.");
        if (actor)
          action = { ...action, payload: { ...action.payload, sourceThreadId: actor.threadId } };
      }
      if (action.actionKind === "schedule_trigger") {
        if (action.payload.agentId !== agentId)
          return yield* fail("A trigger must belong to the requesting agent.");
        const schedule = action.payload.schedule;
        if (
          schedule.type === "webhook" &&
          schedule.signature &&
          (schedule.signature.secret !== undefined || schedule.signature.secretRef !== undefined)
        )
          return yield* fail(
            "Configure webhook signing secrets in owner schedule settings; approval records cannot retain secrets or one-use secret references.",
          );
      }
      const id =
        action.actionKind === "start_work" && action.payload.commandId
          ? `approval:${agentId}:${action.payload.commandId}`
          : yield* uuid("approval");
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`INSERT OR IGNORE INTO agent_approvals(id, agent_id, action_json, status, requested_at, source_run_id) VALUES (${id}, ${agentId}, ${yield* encodeApprovalAction(action)}, 'pending', ${yield* now}, ${actor ? yield* runIdFor(actor) : null})`;
          if (actor) yield* logAction({ ...actor, agent }, "approval_requested", id);
        }),
      );
      return { approval: yield* getApproval(id) };
    }).pipe(Effect.mapError(wrap));
  const executeWork = (
    input: AgentStartWorkInput,
    key: string,
    triggerKind: "approval" | "work",
    sourceRunId: string | null,
  ) =>
    Effect.gen(function* () {
      const agent = yield* store.get(input.agentId);
      const id = ThreadId.make(`agent-work:${agent.id}:${key}`);
      // Stable launch identity and the standard launch service make approval retries safe.
      yield* sql`INSERT OR IGNORE INTO agent_run_threads(thread_id, agent_id, trigger_kind, source_run_id) VALUES (${id}, ${agent.id}, ${triggerKind}, ${sourceRunId})`;
      yield* work.start(
        {
          commandId: CommandId.make(`agent-work:${agent.id}:${key}`),
          sourceThreadId: input.sourceThreadId ?? agent.conversationThreadId,
          targetProjectId: input.projectId,
          title: input.title,
          scopeSummary: input.prompt,
          modelSelection: agent.modelSelection,
        },
        {
          origin: "agent",
          threadId: id,
          sourceAgentId: agent.id,
          ...(sourceRunId === null ? {} : { sourceAgentRunId: sourceRunId }),
          runtimeMode: agent.runtimeMode,
          interactionMode: "default",
          workspaceStrategy: input.workspaceStrategy ?? { type: "worktree", baseRef: "HEAD" },
        },
      );
      return id;
    }).pipe(Effect.mapError(wrap));
  const startWork = (input: AgentStartWorkInput, actor?: AgentActor) =>
    Effect.gen(function* () {
      const agent = actor ? (yield* current(actor)).agent : yield* store.get(input.agentId);
      if (actor && agent.id !== input.agentId)
        return yield* fail("An agent cannot start Work as another agent.");
      if (actor && input.sourceThreadId !== undefined && input.sourceThreadId !== actor.threadId)
        return yield* fail("Work must reference the calling conversation.");
      input = { ...input, sourceThreadId: actor?.threadId ?? input.sourceThreadId };
      if (actor && agent.autonomy === "observe")
        return yield* fail("An observe agent cannot start Work.");
      const scope = yield* access.resolve(agent.id);
      if (
        actor &&
        (!agent.enabled ||
          !scope.executableRepositoryIds.includes(input.projectId) ||
          input.workspaceStrategy?.type === "existing_worktree")
      ) {
        const { approval } = yield* requestApproval(
          agent.id,
          { actionKind: "start_work", payload: input },
          actor,
        );
        return { threadId: null, approval };
      }
      const sourceRunId = actor ? yield* runIdFor(actor) : null;
      const threadId = yield* executeWork(
        input,
        input.commandId ?? (yield* uuid("launch")),
        "work",
        sourceRunId,
      );
      yield* sql`INSERT OR IGNORE INTO agent_run_actions(id, agent_id, run_id, kind, target_id, at) VALUES (${`work-started:${threadId}`}, ${agent.id}, ${sourceRunId}, 'work_started', ${threadId}, ${yield* now})`;
      return { threadId, approval: null };
    }).pipe(Effect.mapError(wrap));
  const listCommitments = (input: CommitmentListInput, actor?: AgentActor) =>
    Effect.gen(function* () {
      if (actor && input.agentId !== undefined && input.agentId !== actor.agent.id)
        return yield* fail("An agent cannot select another identity.");
      const viewAgent = actor
        ? (yield* current(actor)).agent
        : input.agentId === undefined
          ? undefined
          : yield* store.get(input.agentId);
      const principal = viewAgent ? { agent: viewAgent } : undefined;
      // The owner-facing agent view includes the same shared items the agent sees.
      // Filter in SQL before decoding; cross-label items never enter model context.
      const labels = principal ? (yield* access.resolve(principal.agent.id)).readableLabelIds : [];
      const rows = yield* sql<{ id: string }>`SELECT c.id FROM commitments c WHERE
        (${input.status ?? null} IS NULL OR c.status = ${input.status ?? null}) AND
        (${input.labelId ?? null} IS NULL OR EXISTS (SELECT 1 FROM commitment_labels l WHERE l.commitment_id = c.id AND l.label_id = ${input.labelId ?? null})) AND
        (${principal ? 1 : 0} = 0 OR (${principal?.agent.permissions.read ? 1 : 0} = 1 AND (c.agent_id = ${principal?.agent.id ?? null} OR EXISTS (SELECT 1 FROM commitment_labels l WHERE l.commitment_id = c.id AND l.label_id IN ${sql.in(labels)}))))
        ORDER BY c.updated_at DESC, c.id LIMIT 500`;
      return { commitments: yield* Effect.forEach(rows, (r) => getCommitment(r.id)) };
    }).pipe(Effect.mapError(wrap));
  return AgentWorkspaceService.of({
    logAction,
    requestApproval,
    startWork,
    listCommitments,
    listOpenItems: (input, actor) =>
      listCommitments(input, actor).pipe(
        Effect.map(({ commitments }) => ({
          commitments: input.status
            ? commitments
            : commitments.filter((c) => c.status !== "done" && c.status !== "dismissed"),
        })),
      ),
    createCommitment: (input, actor) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const principal = actor ? yield* current(actor) : undefined;
            if (input.agentId !== null) yield* store.get(input.agentId);
            const scope = principal ? yield* access.resolve(principal.agent.id) : undefined;
            if (
              principal &&
              (input.agentId !== principal.agent.id ||
                !canDraft(scope!, input) ||
                input.labelIds.some((id) => !scope!.draftableLabelIds.includes(id)))
            )
              return yield* fail("This agent cannot propose a commitment in this scope.");
            const at = yield* now;
            const commitment: Commitment = {
              ...input,
              id: yield* uuid("commitment"),
              status: principal ? "proposed" : "open",
              createdAt: at,
              updatedAt: at,
            };
            yield* sql`INSERT INTO commitments(id, agent_id, status, payload_json, created_at, updated_at, source_thread_id) VALUES (${commitment.id}, ${commitment.agentId}, ${commitment.status}, ${yield* encodeCommitment(commitment)}, ${at}, ${at}, ${actor?.threadId ?? null})`;
            for (const labelId of new Set(input.labelIds))
              yield* sql`INSERT INTO commitment_labels(commitment_id, label_id) VALUES (${commitment.id}, ${labelId})`;
            yield* history(
              commitment,
              null,
              principal ? `agent:${principal.agent.id}` : "user",
              principal
                ? "Agent extraction proposed for owner review."
                : "Owner created commitment.",
              input.evidenceRefs,
            );
            if (principal) yield* logAction(principal, "commitment_proposed", commitment.id);
            return { commitment };
          }),
        )
        .pipe(Effect.mapError(wrap)),
    updateCommitmentStatus,
    confirmCommitment: (input) =>
      updateCommitmentStatus({ ...input, status: "open", evidenceRefs: [] }),
    dismissCommitment: (input) =>
      updateCommitmentStatus({ ...input, status: "dismissed", evidenceRefs: [] }),
    deleteCommitment: (id) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`DELETE FROM commitment_labels WHERE commitment_id = ${id}`;
            yield* sql`DELETE FROM commitment_history WHERE commitment_id = ${id}`;
            const rows = yield* sql`DELETE FROM commitments WHERE id = ${id} RETURNING id`;
            return { deleted: rows.length > 0 };
          }),
        )
        .pipe(Effect.mapError(wrap)),
    commitmentHistory: (id) =>
      getCommitment(id).pipe(
        Effect.andThen(
          sql<{
            payload_json: string;
          }>`SELECT payload_json FROM commitment_history WHERE commitment_id = ${id} ORDER BY rowid`,
        ),
        Effect.flatMap((rows) => Effect.forEach(rows, (r) => decodeHistory(r.payload_json))),
        Effect.map((history) => ({ history })),
        Effect.mapError(wrap),
      ),
    listApprovals: (input) =>
      expireApprovals().pipe(
        Effect.andThen(
          sql`SELECT * FROM agent_approvals WHERE (${input.agentId ?? null} IS NULL OR agent_id = ${input.agentId ?? null}) AND (${input.status ?? null} IS NULL OR status = ${input.status ?? null}) ORDER BY requested_at DESC, id LIMIT 200`,
        ),
        Effect.flatMap((rows) => Effect.forEach(rows, approvalFromRow)),
        Effect.map((approvals) => ({ approvals })),
        Effect.mapError(wrap),
      ),
    approve: (id) =>
      lock
        .withPermits(1)(
          Effect.gen(function* () {
            const approval = yield* getApproval(id);
            if (approval.status === "approved") return { approval };
            if (approval.status !== "pending")
              return yield* fail("This approval is no longer pending.");
            const agent = yield* store.get(approval.agentId);
            let resultThreadId: ThreadId | null = null;
            const action = approval.action;
            switch (action.actionKind) {
              case "start_work":
                // Owner approval authorizes this reviewed target once; it does not alter scope.
                resultThreadId = yield* executeWork(
                  action.payload,
                  action.payload.commandId ?? approval.id,
                  "approval",
                  approval.sourceRunId,
                );
                break;
              case "schedule_trigger":
                yield* schedules.upsert({
                  ...action.payload,
                  agentId: agent.id,
                  id: action.payload.id ?? ScheduledTaskId.make(`agent-trigger:${approval.id}`),
                });
                break;
              case "change_permissions":
                yield* agents.upsert({ ...agent, ...action.payload });
                break;
            }
            yield* sql.withTransaction(
              Effect.gen(function* () {
                yield* sql`UPDATE agent_approvals SET status = 'approved', decided_at = ${yield* now}, decided_by = 'user', result_thread_id = ${resultThreadId} WHERE id = ${id} AND status = 'pending'`;
                yield* sql`INSERT INTO agent_run_actions(id, agent_id, run_id, kind, target_id, at) VALUES (${`approval-action:${id}`}, ${agent.id}, ${approval.sourceRunId}, ${resultThreadId ? "work_started" : action.actionKind}, ${resultThreadId ?? id}, ${yield* now}) ON CONFLICT(id) DO NOTHING`;
              }),
            );
            return { approval: yield* getApproval(id) };
          }),
        )
        .pipe(Effect.mapError(wrap)),
    reject: (id) =>
      lock
        .withPermits(1)(
          Effect.gen(function* () {
            const approval = yield* getApproval(id);
            if (approval.status !== "pending")
              return yield* fail("This approval is no longer pending.");
            yield* sql`UPDATE agent_approvals SET status = 'rejected', decided_at = ${yield* now}, decided_by = 'user' WHERE id = ${id} AND status = 'pending'`;
            return { approval: yield* getApproval(id) };
          }),
        )
        .pipe(Effect.mapError(wrap)),
    activity: (agentId) =>
      Effect.gen(function* () {
        const agent = yield* store.get(agentId);
        const rows = yield* sql<{
          run_id: string;
          thread_id: string;
          status: string;
          payload_json: string;
          trigger_kind: string | null;
          summary: string | null;
          trigger_context_json: string | null;
        }>`SELECT r.*, CASE WHEN r.ordinal = 1 THEN w.trigger_context_json END AS trigger_context_json, CASE WHEN r.ordinal = 1 THEN COALESCE(t.trigger_kind, CASE WHEN w.run_id IS NOT NULL THEN 'trigger' ELSE 'owner_message' END) ELSE 'owner_message' END AS trigger_kind,
        (SELECT substr(json_extract(m.payload_json, '$.text'), 1, 1200) FROM orchestration_v2_projection_messages m WHERE m.thread_id = r.thread_id AND m.run_id = r.run_id AND m.role = 'assistant' AND m.streaming = 0 ORDER BY m.created_at DESC LIMIT 1) AS summary
        FROM orchestration_v2_projection_runs r LEFT JOIN agent_run_threads t ON t.thread_id = r.thread_id LEFT JOIN agent_work_runs w ON w.work_thread_id = r.thread_id
        WHERE r.thread_id = ${agent.conversationThreadId} OR t.agent_id = ${agentId} OR w.agent_id = ${agentId} ORDER BY r.requested_at DESC, r.run_id LIMIT 100`;
        const runs = yield* Effect.forEach(rows, (r) =>
          Effect.gen(function* () {
            const data = yield* decodeJsonRecord(r.payload_json);
            return yield* decodeActivityRun({
              id: r.run_id,
              agentId,
              threadId: r.thread_id,
              triggerKind: r.trigger_kind,
              ...(r.trigger_context_json == null
                ? {}
                : {
                    triggerContext: yield* decodeEventContext(r.trigger_context_json),
                  }),
              status: r.status,
              startedAt: data.startedAt ?? null,
              finishedAt: data.completedAt ?? null,
              modelSelection: data.modelSelection,
              summary: r.summary,
            });
          }),
        );
        const actions =
          yield* sql`SELECT id, agent_id AS agentId, run_id AS runId, kind, target_id AS targetId, at FROM agent_run_actions WHERE agent_id = ${agentId} ORDER BY at DESC, id LIMIT 500`.pipe(
            Effect.flatMap((rows) => Effect.forEach(rows, (r) => decodeRunAction(r))),
          );
        return { runs, actions };
      }).pipe(Effect.mapError(wrap)),
  });
});
export const layer = Layer.effect(AgentWorkspaceService, make).pipe(Layer.provide(Access.layer));
