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

/** Resolve live owner grants and repository links. Thread tags and caller repositories never grant access. */
export class AgentAccessScope extends Context.Service<
  AgentAccessScope,
  { readonly resolve: (agentId: AgentId) => Effect.Effect<ResolvedAgentAccess, AgentError> }
>()("t3/agents/AgentAccessScope") {}

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
        const labels = yield* sql<{
          label_id: string;
        }>`SELECT label_id FROM project_labels WHERE label_id IN ${sql.in(agent.scope.map((grant) => grant.labelId))}`;
        const existing = new Set(labels.map((row) => row.label_id));
        const grants = agent.permissions.read
          ? agent.scope.filter((grant) => grant.permissions.read && existing.has(grant.labelId))
          : [];
        const readableLabelIds = [...new Set(grants.map((grant) => grant.labelId))];
        const draftableLabelIds =
          agent.permissions.draft && agent.autonomy !== "observe"
            ? [
                ...new Set(
                  grants.filter((grant) => grant.permissions.draft).map((grant) => grant.labelId),
                ),
              ]
            : [];
        const links = yield* sql<{
          label_id: string;
          repository_id: string;
        }>`SELECT lr.label_id,lr.repository_id FROM label_repositories lr JOIN projection_projects p ON p.project_id=lr.repository_id WHERE lr.label_id IN ${sql.in(readableLabelIds)} AND p.deleted_at IS NULL`;
        const home = agent.projectId === null ? [] : [agent.projectId];
        const readableRepositoryIds = agent.permissions.read
          ? [...new Set([...home, ...links.map((link) => ProjectId.make(link.repository_id))])]
          : [];
        // Draft authorizes proposals only. Cross-repository execution requires read + execute
        // on that explicit label grant, in addition to the agent's execution ceiling.
        const executeLabels = new Set(
          grants.filter((grant) => grant.permissions.execute).map((grant) => grant.labelId),
        );
        const executableRepositoryIds =
          agent.permissions.read &&
          agent.permissions.execute &&
          (agent.autonomy === "execute_bounded" || agent.autonomy === "autonomous_within_policy")
            ? [
                ...new Set([
                  ...home,
                  ...links
                    .filter((link) => executeLabels.has(ProjectLabelId.make(link.label_id)))
                    .map((link) => ProjectId.make(link.repository_id)),
                ]),
              ]
            : [];
        return {
          agent,
          homeRepositoryId: agent.projectId,
          readableLabelIds,
          draftableLabelIds,
          readableRepositoryIds,
          executableRepositoryIds,
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
