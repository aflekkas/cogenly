import type { OrchestrationV2ThreadProjection } from "@cogenly/contracts";
import { latestExecutedRun } from "@cogenly/shared/orchestrationV2ThreadError";

// SQLite trim's default is narrower than String.trim. Keep its character set
// identical to ECMAScript WhiteSpace + LineTerminator for the title witness.
export const maintenanceMessageOrder = `CASE WHEN
  json_array_length(payload_json, '$.attachments') = 0
  AND lower(trim(json_extract(payload_json, '$.text'),
    char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279)))
    IN ('/compact', '/logout') THEN 1 ELSE 0 END`;

export function messageDispatchRuns(runs: OrchestrationV2ThreadProjection["runs"]) {
  const latest = runs.at(-1);
  const executed = latestExecutedRun(runs);
  const completed = runs.findLast((run) => run.status === "completed");
  return runs.filter(
    (run) =>
      run === latest ||
      run === executed ||
      run === completed ||
      ["queued", "preparing", "starting", "running", "waiting"].includes(run.status),
  );
}
