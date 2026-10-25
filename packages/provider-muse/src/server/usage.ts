/**
 * Usage history for Muse Code: the transcript format of its
 * `<data-home>/muse/sessions/**\/session.jsonl` files and where each instance
 * keeps them.
 *
 * Every line is either a bare session record or a retained frame whose
 * `children` carry escaped `record_json` payloads. Billable model calls land
 * as `model_completed` run events carrying the call's `usage`, its `model`,
 * and a stable `source_run_record_id` the scan uses as its dedupe key. The
 * sibling `goal_usage_attribution` record repeats the same quantities without
 * a model name, so only `model_completed` is read; reading both would double
 * count every call.
 *
 * Muse reports no cost figures, so records are always unpriced: tokens count,
 * cost does not. Subagent calls report their model as `same-as-main`; that is
 * what Muse wrote, so it is kept rather than guessed.
 *
 * @module provider-muse/server/usage
 */
import * as HostProcess from "@cogenly/shared/HostProcess";
import { UsageProviderKind } from "@cogenly/contracts";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

const USAGE_PROVIDER = UsageProviderKind.make("muse");

import {
  tokenCount,
  type ProviderUsageReader,
  type TranscriptUsageFormat,
  type UsageRecord,
} from "@cogenly/provider-core/server/usage";
import type { MuseSettings } from "../settings.ts";

export type MuseUsageReaderEnv = Path.Path;

/** `recorded_at` is microseconds since the epoch; anything smaller is already millis. */
function parseMuseTimestamp(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  const millis = value >= 1e14 ? Math.floor(value / 1000) : Math.trunc(value);
  return millis > 0 ? millis : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

/**
 * Parses one Muse session record: a `model_completed` run event with its
 * usage, model, and session. Anything else is not billable usage.
 */
export function parseMuseRecord(value: unknown): UsageRecord | null {
  const record = asRecord(value);
  const payload = asRecord(record?.["payload"]);
  const event = asRecord(payload?.["event"]);
  if (event?.["kind"] !== "model_completed") return null;
  const usage = asRecord(event["usage"]);
  if (usage === null) return null;
  const model = event["model"];
  if (typeof model !== "string" || model.length === 0) return null;
  const timestampMs = parseMuseTimestamp(record?.["recorded_at"]);
  if (timestampMs === null) return null;
  const streamId = asRecord(record?.["stream"])?.["id"];
  const sourceId = payload?.["source_run_record_id"];
  const cacheRead = usage["cache_read_tokens"] ?? usage["cached_tokens"];
  return {
    provider: USAGE_PROVIDER,
    timestampMs,
    model,
    sessionId: typeof streamId === "string" ? streamId : "",
    totals: {
      uncachedInputTokens: tokenCount(usage["input_tokens"]),
      cachedInputTokens: tokenCount(cacheRead),
      cacheCreationTokens: tokenCount(usage["cache_write_tokens"]),
      outputTokens: tokenCount(usage["output_tokens"]),
      reasoningTokens: tokenCount(usage["reasoning_tokens"]),
    },
    // Muse reports token quantities only; cost stays unpriced rather than invented.
    reportedCostUsd: null,
    speed: "standard",
    dedupeKey: typeof sourceId === "string" && sourceId.length > 0 ? sourceId : null,
  };
}

/** Candidate session records in one transcript line: framed children or the bare line itself. */
function candidateRecords(line: string): readonly unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return [];
  }
  const root = asRecord(parsed);
  if (root === null) return [];
  const children = root["children"];
  if (!Array.isArray(children)) return [parsed];
  const records: unknown[] = [];
  for (const child of children) {
    const inner = asRecord(child)?.["record_json"];
    if (typeof inner !== "string") continue;
    try {
      records.push(JSON.parse(inner));
    } catch {
      // A malformed child must not hide its siblings' usage.
    }
  }
  return records;
}

const orEmpty = (record: UsageRecord | null): readonly UsageRecord[] =>
  record === null ? [] : [record];

export function parseMuseLine(line: string): readonly UsageRecord[] {
  return candidateRecords(line).flatMap((candidate) => orEmpty(parseMuseRecord(candidate)));
}

export const museUsageFormat: TranscriptUsageFormat<void> = {
  // Framed lines keep their records in `children[].record_json`, which the
  // streaming projector prunes at the array index (see `selectUsageFields`).
  // A framed line past the streaming threshold therefore projects to nothing
  // and its usage is skipped; observed Muse lines peak near 100 KB against an
  // 8 MB threshold, so this trades a negligible tail for bounded memory.
  selectFields: {
    recorded_at: true,
    stream: { id: true },
    payload: { source_run_record_id: true, event: { kind: true, model: true, usage: true } },
  },
  usageMarkers: ["model_completed"],
  parseLine: (line) => parseMuseLine(line),
  parseProjected: (projected) => orEmpty(parseMuseRecord(projected)),
};

/** Muse keeps sessions under the XDG data home, defaulting to `~/.local/share`. */
function museSessionsDir(
  environment: NodeJS.ProcessEnv,
  homeDirectory: string,
  path: Path.Path,
): string {
  const dataHome = environment.XDG_DATA_HOME?.trim() || path.join(homeDirectory, ".local", "share");
  return path.resolve(dataHome, "muse", "sessions");
}

export const museUsageReader: ProviderUsageReader<MuseSettings, MuseUsageReaderEnv> = {
  kind: "transcripts",
  provider: USAGE_PROVIDER,
  format: museUsageFormat,
  directories: Effect.fn("museUsageReader.directories")(function* ({ config, environment }) {
    // An undecodable config has no trustworthy home to read.
    if (config === undefined) return [];
    const path = yield* Path.Path;
    const homeDirectory = yield* HostProcess.HomeDirectory;
    return [{ dir: museSessionsDir(environment, homeDirectory, path) }];
  }),
};
