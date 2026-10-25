import {
  Agent,
  HybridClock,
  SharedStateError,
  type SharedDocumentChange,
  type SharedDocumentKind,
} from "@cogenly/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { compareClock } from "./merge.ts";
import { nextScheduledRunAt } from "../scheduledTasks/Schedule.ts";
import { decodeAgent, decodeProject, decodeSchedule } from "./documentSchemas.ts";
import {
  linkArrivedProject,
  projectFact,
  projectWaitingFacts,
  readFactConfiguration,
} from "./FactProjection.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const json = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)),
);
const storage = (cause: unknown) => new SharedStateError({ reason: "storage", cause });
/** Keep an active binding to this remote before choosing a default local clone. */
const executionCheckout = Effect.fn("SharedState.executionCheckout")(function* (
  remote: string | null,
  previousId: string | null,
) {
  const sql = yield* SqlClient.SqlClient;
  const previous = yield* sql<{
    project_id: string;
    workspace_root: string;
  }>`SELECT p.project_id,p.workspace_root FROM projection_projects p WHERE p.project_id=${previousId} AND p.deleted_at IS NULL AND (${remote} IS NULL OR EXISTS (SELECT 1 FROM label_repositories r WHERE r.repository_id=p.project_id AND r.remote=${remote}) OR EXISTS (SELECT 1 FROM shared_repository_checkouts r WHERE r.repository_id=p.project_id AND r.remote=${remote}))`;
  if (previous[0] || remote === null) return previous[0];
  const mapped = yield* sql<{
    project_id: string;
    workspace_root: string;
  }>`SELECT p.project_id,p.workspace_root FROM projection_projects p JOIN shared_repository_checkouts r ON r.repository_id=p.project_id WHERE r.remote=${remote} AND p.deleted_at IS NULL LIMIT 1`;
  return mapped[0];
});
const repository = Effect.fn("SharedState.repository")(function* (
  id: string | null,
  kind: SharedDocumentKind,
  documentId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const saved = yield* sql<{
    remote: string | null;
  }>`SELECT json_extract(fields_json,'$.repositoryRemote') AS remote FROM shared_documents WHERE kind=${kind} AND id=${documentId}`;
  if (id === null) return saved[0]?.remote ?? null;
  const rows = yield* sql<{
    remote: string | null;
  }>`SELECT remote FROM label_repositories WHERE repository_id=${id} LIMIT 1`;
  return rows[0]?.remote ?? saved[0]?.remote ?? null;
});
/** Only portable configuration is extracted; counters, secrets, paths and fallback state stay local. */
export const readConfiguration = Effect.fn("SharedState.readConfiguration")(function* (
  kind: SharedDocumentKind,
  id: string,
) {
  const sql = yield* SqlClient.SqlClient;
  if (kind === "fact") return yield* readFactConfiguration(id);
  // Settings live in settings.json; SettingsSync writes their documents directly.
  if (kind === "settings" || kind === "project-settings" || kind === "integration") return null;
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
    // A remote cloned twice here still carries one icon.
    const repositoryRows = yield* sql<{
      remote: string;
      directoryName: string | null;
      iconPath: string | null;
    }>`SELECT remote, directory_name AS directoryName, MAX(icon_path) AS iconPath FROM label_repositories WHERE label_id=${id} AND remote IS NOT NULL GROUP BY remote, directory_name ORDER BY remote`;
    const repositories = repositoryRows.map(({ iconPath, ...link }) =>
      iconPath === null ? link : { ...link, iconPath },
    );
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
        kind,
        id,
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
    project_folder_id: string | null;
    workspace_strategy_json: string;
    model_selection_json: string;
    runtime_mode: string;
    interaction_mode: string;
    owner_machine: string;
    target_machine: string | null;
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
    projectFolderId: row.project_folder_id ?? null,
    repositoryRemote: yield* repository(row.project_id, kind, id),
    workspaceStrategy: strategy,
    modelSelection: yield* json(row.model_selection_json),
    runtimeMode: row.runtime_mode,
    interactionMode: row.interaction_mode,
    ownerMachine: row.owner_machine,
    machine: row.target_machine ?? null,
    createdAt: row.created_at,
  };
}, Effect.mapError(storage));

const decodeClock = Schema.decodeUnknownEffect(Schema.fromJsonString(HybridClock));
const decodeRepositoryRefs = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Array(
      Schema.Struct({
        remote: Schema.String,
        directoryName: Schema.NullOr(Schema.String),
        iconPath: Schema.optionalKey(Schema.String),
      }),
    ),
  ),
);
// The legacy read model allows one project per repository. Concurrent moves in
// different documents therefore need a deterministic winner across those documents.
const reconcileRepositories = Effect.fn("SharedState.reconcileRepositories")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const refs = yield* sql<{
    id: string;
    repositories: string;
    clock: string;
  }>`SELECT d.id,json_extract(d.fields_json,'$.repositories') AS repositories,json_extract(d.clocks_json,'$.repositories') AS clock FROM shared_documents d JOIN project_labels l ON l.label_id=d.id WHERE d.kind='project' AND d.tombstone_json IS NULL AND json_type(d.fields_json,'$.repositories')='array'`;
  const winners = new Map<
    string,
    { id: string; clock: HybridClock; directoryName: string | null; iconPath: string | null }
  >();
  for (const row of refs) {
    const clock = yield* decodeClock(row.clock);
    const repositories = yield* decodeRepositoryRefs(row.repositories);
    for (const link of repositories) {
      const previous = winners.get(link.remote);
      if (
        !previous ||
        compareClock(clock, previous.clock) > 0 ||
        (compareClock(clock, previous.clock) === 0 && row.id > previous.id)
      )
        winners.set(link.remote, {
          id: row.id,
          clock,
          directoryName: link.directoryName,
          iconPath: link.iconPath ?? null,
        });
    }
  }
  const checkouts = yield* sql<{
    remote: string;
    repository_id: string;
    directory_name: string | null;
  }>`SELECT c.remote,c.repository_id,c.directory_name FROM shared_repository_checkouts c JOIN projection_projects p ON p.project_id=c.repository_id WHERE p.deleted_at IS NULL UNION ALL SELECT r.remote,r.repository_id,r.directory_name FROM label_repositories r JOIN projection_projects p ON p.project_id=r.repository_id WHERE r.remote IS NOT NULL AND p.deleted_at IS NULL`;
  // The checkout map chooses a default clone for new execution bindings; it is
  // not an exhaustive inventory. Existing links may contain several local clones.
  const localByRemote = new Map<string, Map<string, (typeof checkouts)[number]>>();
  for (const checkout of checkouts) {
    let clones = localByRemote.get(checkout.remote);
    if (!clones) {
      clones = new Map();
      localByRemote.set(checkout.remote, clones);
    }
    clones.set(checkout.repository_id, checkout);
  }
  const links = yield* sql<{
    label_id: string;
    repository_id: string;
    remote: string;
  }>`SELECT label_id,repository_id,remote FROM label_repositories WHERE remote IS NOT NULL`;
  for (const link of links) {
    const winner = winners.get(link.remote);
    if (
      winner?.id !== link.label_id ||
      !(
        localByRemote.get(link.remote)?.has(link.repository_id) ??
        link.repository_id === `remote:${link.remote}`
      )
    )
      yield* sql`DELETE FROM label_repositories WHERE repository_id=${link.repository_id} AND EXISTS (SELECT 1 FROM shared_documents WHERE kind='project' AND id=${link.label_id})`;
  }
  for (const [remote, winner] of winners) {
    const clones = localByRemote.get(remote)?.values() ?? [
      { repository_id: `remote:${remote}`, directory_name: winner.directoryName },
    ];
    // The synced icon wins; a checkout here that lacks that file records its own on read.
    for (const clone of clones)
      yield* sql`INSERT INTO label_repositories(label_id,repository_id,remote,directory_name,icon_path) VALUES (${winner.id},${clone.repository_id},${remote},${clone.directory_name ?? winner.directoryName},${winner.iconPath}) ON CONFLICT(repository_id) DO UPDATE SET label_id=excluded.label_id,remote=excluded.remote,directory_name=excluded.directory_name,icon_path=COALESCE(excluded.icon_path,label_repositories.icon_path)`;
  }
});

/** Shared writes and peer merges use this projection; it never launches or deletes threads. */
export const projectDocument = Effect.fn("SharedState.projectDocument")(function* (
  document: SharedDocumentChange,
  preserveLocalBindings = false,
  changedFields?: ReadonlyArray<string>,
) {
  // Vault documents project asynchronously through VaultSync, which needs
  // this machine's keys; see docs/internals/vault-sync.md.
  if (document.kind === "vault") return;
  const sql = yield* SqlClient.SqlClient;
  const { kind, id, fields } = document;
  if (kind === "fact") return yield* projectFact(document);
  // SettingsSync applies settings documents to settings.json outside this transaction.
  if (kind === "settings" || kind === "project-settings" || kind === "integration") return;
  const at = DateTime.formatIso(yield* DateTime.now);
  if (kind === "project")
    yield* sql`INSERT INTO shared_repository_checkouts(remote,repository_id,directory_name) SELECT r.remote,r.repository_id,r.directory_name FROM label_repositories r JOIN projection_projects p ON p.project_id=r.repository_id WHERE r.remote IS NOT NULL AND p.deleted_at IS NULL GROUP BY r.remote ON CONFLICT(remote) DO UPDATE SET repository_id=excluded.repository_id,directory_name=excluded.directory_name`;
  if (document.tombstone) {
    if (kind === "project") {
      yield* sql`UPDATE commitments SET payload_json=json_set(payload_json,'$.labelIds',json((SELECT json_group_array(l.value) FROM json_each(commitments.payload_json,'$.labelIds') l WHERE l.value<>${id}))) WHERE id IN (SELECT commitment_id FROM commitment_labels WHERE label_id=${id})`;
      yield* sql`DELETE FROM commitment_labels WHERE label_id=${id}`;
      yield* sql`UPDATE facts SET updated_at=${at},payload_json=json_set(payload_json,'$.updatedAt',${at},'$.labelIds',json((SELECT json_group_array(l.value) FROM json_each(facts.payload_json,'$.labelIds') l WHERE l.value<>${id}))) WHERE id IN (SELECT fact_id FROM fact_labels WHERE label_id=${id})`;
      yield* sql`INSERT INTO fact_history(fact_id,payload_json) SELECT f.id,json_object('id',${`sync-delete:${id}:${at}:`} || f.id,'factId',f.id,'who','user','at',${at},'fact',json(f.payload_json)) FROM facts f WHERE f.id IN (SELECT fact_id FROM fact_labels WHERE label_id=${id})`;
      // Transfer all surviving clones before label deletion cascades their links.
      if (!preserveLocalBindings) yield* reconcileRepositories();
      yield* sql`DELETE FROM project_labels WHERE label_id=${id}`;
    }
    if (kind === "agent") {
      // Keep the row and run ledger until AgentService uses its normal stop/delete path.
      yield* sql`UPDATE agents SET enabled=0 WHERE agent_id=${id}`;
      yield* sql`UPDATE scheduled_tasks SET enabled=0 WHERE agent_id=${id}`;
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
    // Domain mutations already updated the local links. Other documents may still be
    // awaiting capture in the same transaction (for example the destination of a move).
    if (
      !preserveLocalBindings &&
      (changedFields === undefined || changedFields.includes("repositories"))
    )
      yield* reconcileRepositories();
    yield* sql`INSERT OR IGNORE INTO shared_possible_duplicates(kind,first_id,second_id) SELECT 'project',min(label_id,${id}),max(label_id,${id}) FROM project_labels WHERE lower(trim(name))=lower(trim(${f.name})) AND label_id<>${id}`;
    yield* linkArrivedProject(id);
    return;
  }
  const remote = typeof fields.repositoryRemote === "string" ? fields.repositoryRemote : null;
  if (kind === "agent") {
    const decoded = yield* Effect.result(decodeAgent(fields));
    if (decoded._tag === "Failure") return;
    const f = decoded.success;
    const existing = yield* sql<{
      payload_json: string;
    }>`SELECT payload_json FROM agents WHERE agent_id=${id}`;
    const previous = existing[0] ? yield* json(existing[0].payload_json) : {};
    const checkout = yield* executionCheckout(
      remote,
      typeof previous.projectId === "string" ? previous.projectId : null,
    );
    const { repositoryRemote: _, ...profile } = f;
    const chainChanged =
      encodeJson(previous.modelSelection ?? null) !== encodeJson(f.modelSelection) ||
      encodeJson(previous.fallbackChain ?? []) !== encodeJson(f.fallbackChain);
    const payload = {
      ...previous,
      ...profile,
      id,
      projectId:
        preserveLocalBindings && previous.projectId !== undefined
          ? previous.projectId
          : (checkout?.project_id ?? previous.projectId ?? null),
      conversationThreadId: previous.conversationThreadId ?? `agent-conversation:${id}`,
      projectFolderId: null,
      updatedAt: at,
      consecutiveFailures: 0,
      backoffUntil: null,
      fallbackIndex: chainChanged ? 0 : (previous.fallbackIndex ?? 0),
      fallbackReason: chainChanged ? null : (previous.fallbackReason ?? null),
      fallbackUntil: chainChanged ? null : (previous.fallbackUntil ?? null),
    };
    const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Agent))(
      yield* Schema.decodeUnknownEffect(Agent)(payload),
    );
    yield* sql`INSERT INTO agents(agent_id,conversation_thread_id,payload_json,enabled,daily_run_cap,owner_machine) VALUES (${id},${payload.conversationThreadId},${encoded},1,${f.dailyRunCap},${f.ownerMachine}) ON CONFLICT(agent_id) DO UPDATE SET payload_json=excluded.payload_json,daily_run_cap=excluded.daily_run_cap,owner_machine=excluded.owner_machine`;
    yield* projectWaitingFacts(id);
    return;
  }
  const decoded = yield* Effect.result(decodeSchedule(fields));
  if (decoded._tag === "Failure") return;
  const f = decoded.success;
  // An agent schedule arriving before the agent remains durable; a later agent projection retries it.
  if (
    f.agentId !== null &&
    (yield* sql`SELECT 1 FROM agents a WHERE agent_id=${f.agentId} AND NOT EXISTS (SELECT 1 FROM shared_documents d WHERE d.kind='agent' AND d.id=a.agent_id AND d.tombstone_json IS NOT NULL)`)
      .length === 0
  )
    return;
  const previous = yield* sql<{
    project_id: string;
    thread_id: string | null;
    workspace_strategy_json: string;
  }>`SELECT project_id,thread_id,workspace_strategy_json FROM scheduled_tasks WHERE task_id=${id}`;
  const checkout = yield* executionCheckout(remote, previous[0]?.project_id ?? null);
  const keepStrategy =
    previous[0] &&
    (preserveLocalBindings ||
      (checkout?.project_id === previous[0].project_id &&
        !changedFields?.includes("workspaceStrategy")));
  const strategy =
    keepStrategy && previous[0]
      ? yield* json(previous[0].workspace_strategy_json)
      : f.workspaceStrategy.type === "existing_worktree"
        ? checkout
          ? {
              type: "existing_worktree",
              worktreePath: `${checkout.workspace_root}/${f.workspaceStrategy.relativePath}`,
              ...(f.workspaceStrategy.branch ? { branch: f.workspaceStrategy.branch } : {}),
            }
          : previous[0]
            ? yield* json(previous[0].workspace_strategy_json)
            : { type: "root" }
        : f.workspaceStrategy;
  const projectId =
    preserveLocalBindings && previous[0]
      ? previous[0].project_id
      : (checkout?.project_id ?? previous[0]?.project_id ?? `remote:${remote ?? id}`);
  const schedule = encodeJson(f.schedule);
  const occurrence = f.enabled
    ? nextScheduledRunAt(f.schedule, yield* DateTime.now, {
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      })
    : null;
  const next = occurrence === null ? null : DateTime.formatIso(occurrence);
  yield* sql`INSERT INTO scheduled_tasks(task_id,agent_id,title,prompt,enabled,schedule_json,project_id,thread_id,workspace_strategy_json,model_selection_json,runtime_mode,interaction_mode,created_by,creation_source,created_at,updated_at,next_run_at,last_run_status,run_count,owner_machine,target_machine,project_folder_id) VALUES (${id},${f.agentId},${f.title},${f.prompt},${f.enabled ? 1 : 0},${schedule},${projectId},${previous[0]?.thread_id ?? null},${encodeJson(strategy)},${encodeJson(f.modelSelection)},${f.runtimeMode},${f.interactionMode},'user','web',${f.createdAt},${at},${next},'never',0,${f.ownerMachine},${f.machine ?? null},${f.projectFolderId ?? null}) ON CONFLICT(task_id) DO UPDATE SET agent_id=excluded.agent_id,title=excluded.title,prompt=excluded.prompt,enabled=excluded.enabled,schedule_json=excluded.schedule_json,project_id=excluded.project_id,workspace_strategy_json=excluded.workspace_strategy_json,model_selection_json=excluded.model_selection_json,runtime_mode=excluded.runtime_mode,interaction_mode=excluded.interaction_mode,updated_at=excluded.updated_at,owner_machine=excluded.owner_machine,target_machine=excluded.target_machine,project_folder_id=excluded.project_folder_id,next_run_at=CASE WHEN scheduled_tasks.schedule_json=excluded.schedule_json AND scheduled_tasks.enabled=excluded.enabled THEN scheduled_tasks.next_run_at ELSE excluded.next_run_at END`;
}, Effect.mapError(storage));
