import { decodeAgentRow } from "./agentRecord.ts";
import {
  type Agent,
  AgentError,
  type AgentId,
  ProjectId,
  ProjectLabelId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

const isAgentError = Schema.is(AgentError);

export type ResolvedAgentAccess = {
  readonly agent: Agent;
  readonly homeRepositoryId: ProjectId | null;
  readonly readableLabelIds: ReadonlyArray<ProjectLabelId>;
  readonly draftableLabelIds: ReadonlyArray<ProjectLabelId>;
  readonly readableRepositoryIds: ReadonlyArray<ProjectId>;
  readonly executableRepositoryIds: ReadonlyArray<ProjectId>;
};

/**
 * Resolve what an agent can reach. Agents have every project and repository; the
 * agent-level permissions alone decide whether that is read, draft or execute.
 */
export class AgentAccessScope extends Context.Service<
  AgentAccessScope,
  { readonly resolve: (agentId: AgentId) => Effect.Effect<ResolvedAgentAccess, AgentError> }
>()("cogenly-server/agents/AgentAccessScope") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return AgentAccessScope.of({
    resolve: (agentId) =>
      Effect.gen(function* () {
        const rows = yield* sql<{
          payload_json: string;
          consecutive_failures: number;
          backoff_until: string | null;
          daily_run_cap: number;
        }>`SELECT * FROM agents WHERE agent_id=${agentId}`;
        if (!rows[0]) return yield* new AgentError({ message: "Agent not found." });
        const agent = yield* decodeAgentRow(rows[0]);
        const { read, draft, execute } = agent.permissions;
        const labels = yield* sql<{ label_id: string }>`SELECT label_id FROM project_labels`;
        const repositories = yield* sql<{
          project_id: string;
        }>`SELECT project_id FROM projection_projects WHERE deleted_at IS NULL`;
        const readableLabelIds = read ? labels.map((row) => ProjectLabelId.make(row.label_id)) : [];
        const home = agent.projectId === null ? [] : [agent.projectId];
        const readableRepositoryIds = read
          ? [...new Set([...home, ...repositories.map((row) => ProjectId.make(row.project_id))])]
          : [];
        return {
          agent,
          homeRepositoryId: agent.projectId,
          readableLabelIds,
          draftableLabelIds: draft ? readableLabelIds : [],
          readableRepositoryIds,
          executableRepositoryIds: execute ? readableRepositoryIds : [],
        };
      }).pipe(
        Effect.mapError((cause) =>
          isAgentError(cause)
            ? cause
            : new AgentError({ message: "Could not resolve agent access scope.", cause }),
        ),
      ),
  });
});
export const layer: Layer.Layer<AgentAccessScope, never, SqlClient.SqlClient> = Layer.effect(
  AgentAccessScope,
  make,
);
