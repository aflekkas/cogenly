import {
  AgentError,
  AgentHandoffBrief,
  AgentHandoffNarrative,
  Agent,
  type AgentId,
  type ModelSelection,
} from "@cogenly/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Text from "../textGeneration/TextGeneration.ts";
import * as Store from "./AgentStore.ts";

export const HANDOFF_SOFT_RUNS = 32;
export const HANDOFF_MAX_CHARS = 180_000;
type State = ReadonlyArray<{ readonly heading: string; readonly rows: ReadonlyArray<string> }>;

/** Exact records stay outside the model's narrative and are never clipped to fit. */
export const renderHandoffState = (state: State) =>
  state
    .map((section) => `${section.heading}:\n${section.rows.join("\n") || "(none)"}`)
    .join("\n\n");
export const validateHandoff = (text: string, state: State) =>
  text.length <= HANDOFF_MAX_CHARS &&
  state.every((section) =>
    text.includes(`${section.heading}:\n${section.rows.join("\n") || "(none)"}`),
  );

export class AgentHandoff extends Context.Service<
  AgentHandoff,
  {
    readonly request: (input: {
      readonly agent: Agent;
      readonly ordinal: number;
      readonly cwd: string;
      readonly selections: ReadonlyArray<ModelSelection>;
    }) => Effect.Effect<void, AgentError>;
    readonly drain: Effect.Effect<void>;
    readonly prepare: (
      agentId: AgentId,
      ordinal: number,
    ) => Effect.Effect<AgentHandoffBrief | null, AgentError>;
  }
>()("cogenly-server/agents/AgentHandoff") {}
const failure = (cause: unknown) =>
  new AgentError({ message: "Could not prepare agent handoff.", cause });
const decodeBrief = Schema.decodeUnknownEffect(Schema.fromJsonString(AgentHandoffBrief));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeNarrative = Schema.decodeUnknownEffect(Schema.fromJsonString(AgentHandoffNarrative));
const encodeNarrative = Schema.encodeSync(Schema.fromJsonString(AgentHandoffNarrative));
const renderNarrative = (n: AgentHandoffNarrative) =>
  n.entries
    .map(
      (e) =>
        `${e.text} ${e.messageIds.map((id) => `[message:${id}]`).join(" ")} ${e.runIds.map((id) => `[run:${id}]`).join(" ")}`,
    )
    .join("\n");
const encodeAgent = Schema.encodeSync(Schema.fromJsonString(Agent));
const encodeBrief = Schema.encodeSync(Schema.fromJsonString(AgentHandoffBrief));
const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const store = yield* Store.AgentStore;
  const text = yield* Text.TextGeneration;
  const scope = yield* Effect.scope;
  // Scoped to the server, not the turn's worker fiber. Failed generations are retried on the next turn.
  const generating = new Set<string>();
  const pending = new Map<string, Fiber.Fiber<void>>();
  const messages = (agent: Agent, after: number, through: number) => sql<{
    id: string;
    runId: string | null;
    role: string;
    text: string;
  }>`SELECT m.message_id AS id, m.run_id AS runId, m.role, json_extract(m.payload_json, '$.text') AS text
     FROM orchestration_v2_projection_messages m LEFT JOIN orchestration_v2_projection_runs r ON r.run_id = m.run_id
     WHERE m.thread_id = ${agent.conversationThreadId} AND m.streaming = 0 AND m.role IN ('user','assistant')
       AND (m.run_id IS NULL OR (r.ordinal > ${after} AND r.ordinal <= ${through}))
     ORDER BY m.created_at, m.message_id`;
  const state = (agent: Agent) =>
    Effect.gen(function* () {
      const commitments = yield* sql<{
        payload_json: string;
      }>`SELECT c.payload_json FROM commitments c WHERE c.status IN ('proposed','open','in_progress','waiting') AND (c.agent_id = ${agent.id} OR (c.agent_id IS NULL AND ${agent.permissions.read ? 1 : 0} = 1 AND EXISTS (SELECT 1 FROM commitment_labels l WHERE l.commitment_id = c.id))) ORDER BY c.id`;
      const work =
        yield* sql`SELECT * FROM agent_work_runs WHERE agent_id = ${agent.id} AND (status NOT IN ('completed','failed') OR posted = 0) ORDER BY run_id`;
      const threads = yield* sql<{
        payload_json: string;
      }>`SELECT r.payload_json FROM orchestration_v2_projection_runs r JOIN agent_run_threads t ON t.thread_id = r.thread_id WHERE t.agent_id = ${agent.id} AND r.status IN ('queued','starting','running','waiting') ORDER BY r.run_id`;
      const children = yield* sql<{
        payload_json: string;
      }>`SELECT payload_json FROM orchestration_v2_projection_subagents WHERE (thread_id = ${agent.conversationThreadId} OR thread_id IN (SELECT thread_id FROM agent_run_threads WHERE agent_id = ${agent.id}) OR thread_id IN (SELECT work_thread_id FROM agent_work_runs WHERE agent_id = ${agent.id})) AND (status NOT IN ('completed','failed','cancelled','interrupted') OR json_extract(payload_json, '$.completionDelivery.state') IN ('pending','claimed','acknowledged')) ORDER BY subagent_id`;
      const approvals =
        yield* sql`SELECT * FROM agent_approvals WHERE agent_id = ${agent.id} AND status = 'pending' ORDER BY id`;
      const runtimeApprovals = yield* sql<{
        payload_json: string;
      }>`SELECT payload_json FROM orchestration_v2_projection_runtime_requests WHERE status = 'pending' AND (thread_id = ${agent.conversationThreadId} OR thread_id IN (SELECT thread_id FROM agent_run_threads WHERE agent_id = ${agent.id}) OR thread_id IN (SELECT work_thread_id FROM agent_work_runs WHERE agent_id = ${agent.id})) ORDER BY runtime_request_id`;
      const triggers =
        yield* sql`SELECT * FROM scheduled_tasks WHERE agent_id = ${agent.id} AND enabled = 1 ORDER BY task_id`;
      const facts = yield* sql<{
        payload_json: string;
      }>`SELECT payload_json FROM facts WHERE agent_id = ${agent.id} AND status IN ('confirmed', 'proposed') ORDER BY updated_at, id`;
      return [
        {
          heading: "Identity and standing instructions",
          rows: [encodeAgent(agent), agent.instructions, agent.responsibility],
        },
        { heading: "Core memory", rows: [agent.coreMemory ?? ""] },
        {
          heading: "Open commitments and next checks",
          rows: commitments.map((r) => r.payload_json),
        },
        {
          heading: "Pending Work and background tasks",
          rows: [
            ...work.map((r) => encodeJson(r)),
            ...threads.map((r) => r.payload_json),
            ...children.map((r) => r.payload_json),
          ],
        },
        {
          heading: "Pending approvals",
          rows: [
            ...approvals.map((r) => encodeJson(r)),
            ...runtimeApprovals.map((r) => r.payload_json),
          ],
        },
        { heading: "Active triggers", rows: triggers.map((r) => encodeJson(r)) },
        {
          heading: "Decisions recorded as facts (status retained)",
          rows: facts.map((r) => r.payload_json),
        },
      ];
    });
  return AgentHandoff.of({
    drain: Effect.suspend(() =>
      Effect.forEach([...pending.values()], Fiber.join, { discard: true }),
    ),
    request: (input) =>
      Effect.gen(function* () {
        if (generating.has(input.agent.id)) return;
        const existing = yield* sql<{
          ordinal: number;
        }>`SELECT MAX(covered_run_ordinal) AS ordinal FROM agent_handoff_narratives WHERE agent_id = ${input.agent.id}`;
        const used = yield* sql<{
          ordinal: number;
        }>`SELECT MAX(covered_run_ordinal) AS ordinal FROM agent_handoff_briefs WHERE agent_id = ${input.agent.id}`;
        if (
          (existing[0]?.ordinal ?? -1) > (used[0]?.ordinal ?? -1) &&
          input.ordinal - (existing[0]?.ordinal ?? -1) < 8
        )
          return;
        generating.add(input.agent.id);
        const fiber = yield* Effect.gen(function* () {
          const previous = yield* sql<{
            narrative: string;
            covered_run_ordinal: number;
          }>`SELECT * FROM agent_handoff_narratives WHERE agent_id = ${input.agent.id} ORDER BY covered_run_ordinal DESC LIMIT 1`;
          const transcript = yield* messages(
            input.agent,
            previous[0]?.covered_run_ordinal ?? 0,
            input.ordinal,
          );
          const source = encodeJson({
            previousNarrative: previous[0]?.narrative ?? "",
            messages: transcript,
          });
          // Refuse oversized input rather than silently cutting a constraint in half.
          if (source.length > 500_000)
            return yield* new AgentError({ message: "Agent narrative source exceeds its budget." });
          const prior = previous[0]
            ? yield* decodeNarrative(previous[0].narrative)
            : { entries: [] };
          let narrative: AgentHandoffNarrative | undefined;
          for (const modelSelection of input.selections) {
            const result = yield* Effect.result(
              text.generateAgentNarrative({ cwd: input.cwd, transcript: source, modelSelection }),
            );
            if (result._tag === "Success") {
              narrative = result.success;
              break;
            }
          }
          if (narrative === undefined)
            return yield* new AgentError({ message: "Agent narrative generation failed." });
          const messageIds = new Set([
            ...transcript.map((m) => m.id),
            ...prior.entries.flatMap((e) => e.messageIds),
          ]);
          const runIds = new Set([
            ...transcript.flatMap((m) => (m.runId === null ? [] : [m.runId])),
            ...prior.entries.flatMap((e) => e.runIds),
          ]);
          if (
            renderNarrative(narrative).length > 24000 ||
            (transcript.length > 0 && narrative.entries.length === 0) ||
            narrative.entries.some(
              (e) =>
                !e.messageIds.length ||
                e.messageIds.some((id) => !messageIds.has(id)) ||
                e.runIds.some((id) => !runIds.has(id)) ||
                e.messageIds.some((id) => {
                  const message = transcript.find((m) => m.id === id);
                  return message?.runId != null && !e.runIds.includes(message.runId);
                }),
            )
          )
            return yield* new AgentError({
              message: "Agent narrative has invalid source references or exceeds its budget.",
            });
          const at = DateTime.formatIso(yield* DateTime.now);
          yield* sql`INSERT OR IGNORE INTO agent_handoff_narratives(agent_id, covered_run_ordinal, narrative, created_at) VALUES (${input.agent.id}, ${input.ordinal}, ${encodeNarrative(narrative)}, ${at})`;
        }).pipe(
          Effect.catchCause(() =>
            Effect.logWarning("Agent handoff narrative generation will retry", {
              agentId: input.agent.id,
            }),
          ),
          Effect.ensuring(
            Effect.sync(() => {
              generating.delete(input.agent.id);
            }),
          ),
          Effect.forkIn(scope),
        );
        pending.set(input.agent.id, fiber);
      }).pipe(Effect.mapError(failure)),
    prepare: (agentId, ordinal) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const saved = yield* sql<{
              payload_json: string;
            }>`SELECT payload_json FROM agent_handoff_briefs WHERE agent_id = ${agentId} AND covered_run_ordinal = ${ordinal} ORDER BY version DESC LIMIT 1`;
            if (saved[0]) {
              const brief = yield* decodeBrief(saved[0].payload_json);
              if (validateHandoff(brief.text, yield* state(yield* store.get(agentId))))
                return brief;
              // A failed validation needs a newly generated narrative before this
              // ordinal can receive another immutable revision.
            }
            const latest = yield* sql<{
              covered_run_ordinal: number;
              version: number;
            }>`SELECT covered_run_ordinal, version FROM agent_handoff_briefs WHERE agent_id = ${agentId} ORDER BY version DESC LIMIT 1`;
            const ready = yield* sql<{
              narrative: string;
              covered_run_ordinal: number;
            }>`SELECT narrative, covered_run_ordinal FROM agent_handoff_narratives WHERE agent_id = ${agentId} AND covered_run_ordinal > ${saved.length > 0 ? ordinal - 1 : (latest[0]?.covered_run_ordinal ?? -1)} AND covered_run_ordinal <= ${ordinal} ORDER BY covered_run_ordinal DESC LIMIT 1`;
            if (!ready[0]) return null;
            const agent = yield* store.get(agentId);
            const snapshot = yield* state(agent);
            const tail = yield* messages(agent, ready[0].covered_run_ordinal, ordinal);
            const createdAt = DateTime.formatIso(yield* DateTime.now);
            const version = (latest[0]?.version ?? 0) + 1;
            const body = `HANDOFF BRIEF v1 / revision ${version}\nAgent: ${agentId}; covers runs 1..${ordinal}; generated: ${createdAt}\n\n${renderHandoffState(snapshot)}\n\nNarrative (model-written, source-referenced; through run ${ready[0].covered_run_ordinal}):\n${renderNarrative(yield* decodeNarrative(ready[0].narrative))}\n\nMessages since narrative (verbatim):\n${encodeJson(tail)}`;
            if (!validateHandoff(body, snapshot)) return null;
            const brief = {
              formatVersion: 1 as const,
              version,
              coveredRunOrdinal: ordinal,
              createdAt,
              text: body,
            };
            yield* sql`INSERT INTO agent_conversation_context(agent_id, summary, covered_run_ordinal) VALUES (${agentId}, ${renderNarrative(yield* decodeNarrative(ready[0].narrative))}, ${ordinal}) ON CONFLICT(agent_id) DO UPDATE SET summary = excluded.summary, covered_run_ordinal = excluded.covered_run_ordinal`;
            yield* sql`INSERT INTO agent_handoff_briefs(agent_id, version, covered_run_ordinal, payload_json) VALUES (${agentId}, ${version}, ${ordinal}, ${encodeBrief(brief)})`;
            return brief;
          }),
        )
        .pipe(Effect.mapError(failure)),
  });
});
export const layer = Layer.effect(AgentHandoff, make);
