import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json = json_set(
    payload_json, '$.workOrigin', CASE WHEN json_extract(payload_json, '$.agent.role') = 'work' THEN 'agent' ELSE 'direct' END
  ) WHERE json_extract(payload_json, '$.workOrigin') IS NULL`;
  yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json = json_set(
    payload_json, '$.sourceAgentId', json_extract(payload_json, '$.agent.id')
  ) WHERE json_extract(payload_json, '$.agent.role') = 'work' AND json_extract(payload_json, '$.sourceAgentId') IS NULL`;
  yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json = json_set(
    payload_json, '$.sourceAgentRunId', (SELECT run_id FROM agent_work_runs WHERE work_thread_id = thread_id)
  ) WHERE json_extract(payload_json, '$.sourceAgentRunId') IS NULL AND EXISTS (
    SELECT 1 FROM agent_work_runs WHERE work_thread_id = thread_id
  )`;
});
