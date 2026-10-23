import {
  Agent,
  SharedStateError,
  type SharedDocumentChange,
  type SharedDocumentKind,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { nextScheduledRunAt } from "../scheduledTasks/Schedule.ts";
import { decodeAgent, decodeProject, decodeSchedule } from "./documentSchemas.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const json = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)),
);
const storage = (cause: unknown) => new SharedStateError({ reason: "storage", cause });
const repository = Effect.fn("SharedState.repository")(function* (id: string | null) {
  const sql = yield* SqlClient.SqlClient;
  if (id === null) return null;
  const rows = yield* sql<{
    remote: string | null;
  }>`SELECT remote FROM label_repositories WHERE repository_id=${id} LIMIT 1`;
  return rows[0]?.remote ?? null;
});
/** Only portable configuration is extracted; counters, secrets, paths and fallback state stay local. */
export const readConfiguration = Effect.fn("SharedState.readConfiguration")(function* (
  kind: SharedDocumentKind,
  id: string,
) {
  const sql = yield* SqlClient.SqlClient;
  if (kind === "project") {
    const rows = yield* sql<{
      name: string;
      color: string | null;
      description: string | null;
      instructions: string;
      archived_at: string | null;
      created_at: string;
    }>`SELECT * FROM project_labels WHERE label_id=${id}`;
    const row = rows[0];
    if (!row) return null;
    const repositories = yield* sql<{
      remote: string;
      directoryName: string | null;
    }>`SELECT DISTINCT remote, directory_name AS directoryName FROM label_repositories WHERE label_id=${id} AND remote IS NOT NULL ORDER BY remote`;
    const sources = yield* sql<{
      kind: string;
      owner: string;
      repo: string;
    }>`SELECT kind,owner,repo FROM label_source_links WHERE label_id=${id} ORDER BY kind,owner,repo`;
    return {
      name: row.name,
      color: row.color,
      description: row.description,
      instructions: row.instructions,
      archivedAt: row.archived_at,
      createdAt: row.created_at,
      repositories,
      sourceLinks: sources.map((source) =>
        source.kind === "github-owner" ? { kind: source.kind, owner: source.owner } : source,
      ),
    };
  }
  if (kind === "agent") {
    const rows = yield* sql<{
      payload_json: string;
      owner_machine: string;
    }>`SELECT payload_json,owner_machine FROM agents WHERE agent_id=${id}`;
    if (!rows[0]) return null;
    const data = yield* json(rows[0].payload_json);
    const fields = Object.fromEntries(
      [
        "name",
        "avatar",
        "instructions",
        "responsibility",
        "permissions",
        "notifyPolicy",
        "modelSelection",
        "fallbackChain",
        "runtimeMode",
        "dailyRunCap",
        "createdAt",
      ].map((key) => [key, data[key]]),
    );
    return {
      ...fields,
      fallbackChain: data.fallbackChain ?? [],
      ownerMachine: rows[0].owner_machine,
      repositoryRemote: yield* repository(
        typeof data.projectId === "string" ? data.projectId : null,
      ),
    };
  }
  const rows = yield* sql<{
    agent_id: string | null;
    title: string;
    prompt: string;
    enabled: number;
    schedule_json: string;
    project_id: string;
    workspace_strategy_json: string;
    model_selection_json: string;
    runtime_mode: string;
    interaction_mode: string;
    owner_machine: string;
    created_at: string;
  }>`SELECT * FROM scheduled_tasks WHERE task_id=${id}`;
  const row = rows[0];
  if (!row) return null;
  const strategy = { ...(yield* json(row.workspace_strategy_json)) };
  if (strategy.type === "existing_worktree") {
    const projects = yield* sql<{
      workspace_root: string;
    }>`SELECT workspace_root FROM projection_projects WHERE project_id=${row.project_id}`;
    const root = projects[0]?.workspace_root.replace(/\/+$/, "");
    // Existing worktrees outside the repository cannot be portable; keep the local strategy,
    // and sync the intention to use the repository root until clone/launch routing exists.
    const path = strategy.worktreePath;
    if (root && typeof path === "string" && path.startsWith(`${root}/`)) {
      strategy.relativePath = path.slice(root.length + 1);
      delete strategy.worktreePath;
    } else {
      delete strategy.worktreePath;
      strategy.type = "root";
    }
  }
  return {
    agentId: row.agent_id,
    title: row.title,
    prompt: row.prompt,
    enabled: row.enabled === 1,
    schedule: yield* json(row.schedule_json),
    repositoryRemote: yield* repository(row.project_id),
    workspaceStrategy: strategy,
    modelSelection: yield* json(row.model_selection_json),
    runtimeMode: row.runtime_mode,
    interactionMode: row.interaction_mode,
    ownerMachine: row.owner_machine,
    createdAt: row.created_at,
  };
}, Effect.mapError(storage));

/** Shared writes and peer merges use this projection; it never launches or deletes threads. */
export const projectDocument = Effect.fn("SharedState.projectDocument")(function* (
  document: SharedDocumentChange,
) {
  const sql = yield* SqlClient.SqlClient;
  const { kind, id, fields } = document;
  const at = DateTime.formatIso(yield* DateTime.now);
  if (document.tombstone) {
    if (kind === "project") {
      yield* sql`UPDATE commitments SET payload_json=json_set(payload_json,'$.labelIds',json((SELECT json_group_array(l.value) FROM json_each(commitments.payload_json,'$.labelIds') l WHERE l.value<>${id}))) WHERE id IN (SELECT commitment_id FROM commitment_labels WHERE label_id=${id})`;
      yield* sql`DELETE FROM commitment_labels WHERE label_id=${id}`;
      yield* sql`UPDATE facts SET updated_at=${at},payload_json=json_set(payload_json,'$.updatedAt',${at},'$.labelIds',json((SELECT json_group_array(l.value) FROM json_each(facts.payload_json,'$.labelIds') l WHERE l.value<>${id}))) WHERE id IN (SELECT fact_id FROM fact_labels WHERE label_id=${id})`;
      yield* sql`INSERT INTO fact_history(fact_id,payload_json) SELECT f.id,json_object('id',${`sync-delete:${id}:${at}:`} || f.id,'factId',f.id,'who','user','at',${at},'fact',json(f.payload_json)) FROM facts f WHERE f.id IN (SELECT fact_id FROM fact_labels WHERE label_id=${id})`;
      yield* sql`DELETE FROM project_labels WHERE label_id=${id}`;
    }
    if (kind === "agent") {
      // Keep the row and run ledger until AgentService uses its normal stop/delete path.
      yield* sql`UPDATE agents SET enabled=0 WHERE agent_id=${id}`;
      yield* sql`DELETE FROM scheduled_task_webhook_deliveries WHERE task_id IN (SELECT task_id FROM scheduled_tasks WHERE agent_id=${id})`;
      yield* sql`DELETE FROM scheduled_tasks WHERE agent_id=${id}`;
    }
    if (kind === "schedule") {
      yield* sql`DELETE FROM scheduled_task_webhook_deliveries WHERE task_id=${id}`;
      yield* sql`DELETE FROM scheduled_tasks WHERE task_id=${id}`;
    }
    return;
  }
  if (kind === "project") {
    // Deltas may arrive before their creation during relay; incomplete documents stay durable
    // but do not appear in read models until the required fields have arrived.
    const decoded = yield* Effect.result(decodeProject(fields));
    if (decoded._tag === "Failure") return;
    const f = decoded.success;
    yield* sql`INSERT INTO project_labels(label_id,name,color,description,instructions,archived_at,created_at,updated_at) VALUES (${id},${f.name},${f.color},${f.description},${f.instructions},${f.archivedAt},${f.createdAt},${at}) ON CONFLICT(label_id) DO UPDATE SET name=excluded.name,color=excluded.color,description=excluded.description,instructions=excluded.instructions,archived_at=excluded.archived_at,updated_at=excluded.updated_at`;
    yield* sql`DELETE FROM label_source_links WHERE label_id=${id}`;
    for (const source of f.sourceLinks)
      yield* sql`INSERT INTO label_source_links(label_id,kind,owner,repo,created_at) VALUES (${id},${source.kind},${source.owner},${source.kind === "github-owner" ? "" : source.repo},${at})`;
    const existing = yield* sql<{
      repository_id: string;
      remote: string;
    }>`SELECT repository_id,remote FROM label_repositories WHERE label_id=${id} AND remote IS NOT NULL`;
    for (const link of existing)
      if (!f.repositories.some((repo) => repo.remote === link.remote))
        yield* sql`DELETE FROM label_repositories WHERE label_id=${id} AND repository_id=${link.repository_id}`;
    for (const link of f.repositories) {
      const local = yield* sql<{
        repository_id: string;
      }>`SELECT repository_id FROM label_repositories WHERE remote=${link.remote} ORDER BY repository_id LIMIT 1`;
      const repositoryId = local[0]?.repository_id ?? `remote:${link.remote}`;
      yield* sql`INSERT INTO label_repositories(label_id,repository_id,remote,directory_name) VALUES (${id},${repositoryId},${link.remote},${link.directoryName}) ON CONFLICT(repository_id) DO UPDATE SET label_id=excluded.label_id,remote=excluded.remote,directory_name=excluded.directory_name`;
    }
    yield* sql`INSERT OR IGNORE INTO shared_possible_duplicates(kind,first_id,second_id) SELECT 'project',min(label_id,${id}),max(label_id,${id}) FROM project_labels WHERE lower(trim(name))=lower(trim(${f.name})) AND label_id<>${id}`;
    return;
  }
  const remote = typeof fields.repositoryRemote === "string" ? fields.repositoryRemote : null;
  const locals =
    remote === null
      ? []
      : yield* sql<{
          project_id: string;
          workspace_root: string;
        }>`SELECT p.project_id,p.workspace_root FROM projection_projects p JOIN label_repositories r ON r.repository_id=p.project_id WHERE r.remote=${remote} AND p.deleted_at IS NULL LIMIT 1`;
  if (kind === "agent") {
    const decoded = yield* Effect.result(decodeAgent(fields));
    if (decoded._tag === "Failure") return;
    const f = decoded.success;
    const existing = yield* sql<{
      payload_json: string;
    }>`SELECT payload_json FROM agents WHERE agent_id=${id}`;
    const previous = existing[0] ? yield* json(existing[0].payload_json) : {};
    const { repositoryRemote: _, ...profile } = f;
    const payload = {
      ...previous,
      ...profile,
      id,
      projectId: locals[0]?.project_id ?? previous.projectId ?? null,
      conversationThreadId: previous.conversationThreadId ?? `agent-conversation:${id}`,
      projectFolderId: null,
      updatedAt: at,
      consecutiveFailures: 0,
      backoffUntil: null,
      fallbackIndex: previous.fallbackIndex ?? 0,
      fallbackReason: previous.fallbackReason ?? null,
      fallbackUntil: previous.fallbackUntil ?? null,
    };
    const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Agent))(
      yield* Schema.decodeUnknownEffect(Agent)(payload),
    );
    yield* sql`INSERT INTO agents(agent_id,conversation_thread_id,payload_json,enabled,daily_run_cap,owner_machine) VALUES (${id},${payload.conversationThreadId},${encoded},1,${f.dailyRunCap},${f.ownerMachine}) ON CONFLICT(agent_id) DO UPDATE SET payload_json=excluded.payload_json,daily_run_cap=excluded.daily_run_cap,owner_machine=excluded.owner_machine`;
    return;
  }
  const decoded = yield* Effect.result(decodeSchedule(fields));
  if (decoded._tag === "Failure") return;
  const f = decoded.success;
  // An agent schedule arriving before the agent remains durable; a later agent projection retries it.
  if (
    f.agentId !== null &&
    (yield* sql`SELECT 1 FROM agents WHERE agent_id=${f.agentId}`).length === 0
  )
    return;
  const previous = yield* sql<{
    project_id: string;
    thread_id: string | null;
    workspace_strategy_json: string;
  }>`SELECT project_id,thread_id,workspace_strategy_json FROM scheduled_tasks WHERE task_id=${id}`;
  const strategy =
    f.workspaceStrategy.type === "existing_worktree"
      ? locals[0]
        ? {
            type: "existing_worktree",
            worktreePath: `${locals[0].workspace_root}/${f.workspaceStrategy.relativePath}`,
            ...(f.workspaceStrategy.branch ? { branch: f.workspaceStrategy.branch } : {}),
          }
        : previous[0]
          ? yield* json(previous[0].workspace_strategy_json)
          : { type: "root" }
      : f.workspaceStrategy;
  const projectId = locals[0]?.project_id ?? previous[0]?.project_id ?? `remote:${remote ?? id}`;
  const schedule = encodeJson(f.schedule);
  const occurrence = f.enabled
    ? nextScheduledRunAt(f.schedule, yield* DateTime.now, {
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      })
    : null;
  const next = occurrence === null ? null : DateTime.formatIso(occurrence);
  yield* sql`INSERT INTO scheduled_tasks(task_id,agent_id,title,prompt,enabled,schedule_json,project_id,thread_id,workspace_strategy_json,model_selection_json,runtime_mode,interaction_mode,created_by,creation_source,created_at,updated_at,next_run_at,last_run_status,run_count,owner_machine) VALUES (${id},${f.agentId},${f.title},${f.prompt},${f.enabled ? 1 : 0},${schedule},${projectId},${previous[0]?.thread_id ?? null},${encodeJson(strategy)},${encodeJson(f.modelSelection)},${f.runtimeMode},${f.interactionMode},'user','web',${f.createdAt},${at},${next},'never',0,${f.ownerMachine}) ON CONFLICT(task_id) DO UPDATE SET agent_id=excluded.agent_id,title=excluded.title,prompt=excluded.prompt,enabled=excluded.enabled,schedule_json=excluded.schedule_json,project_id=excluded.project_id,workspace_strategy_json=excluded.workspace_strategy_json,model_selection_json=excluded.model_selection_json,runtime_mode=excluded.runtime_mode,interaction_mode=excluded.interaction_mode,updated_at=excluded.updated_at,owner_machine=excluded.owner_machine,next_run_at=CASE WHEN scheduled_tasks.schedule_json=excluded.schedule_json AND scheduled_tasks.enabled=excluded.enabled THEN scheduled_tasks.next_run_at ELSE excluded.next_run_at END`;
}, Effect.mapError(storage));
