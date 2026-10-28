/**
 * Usage history for Muse Code: the `model_completed` events in its
 * `<data-home>/muse/sessions/**\/session.jsonl` event logs and where each
 * instance's logs live. Subagent logs (`subagent/<id>/session.jsonl`) carry
 * their own stream id, so one recursive walk covers every session.
 *
 * @module provider-muse/server/usage
 */
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import {
  tokenCount,
  totalTokens,
  type ProviderUsageReader,
  type TranscriptUsageFormat,
  type UsageRecord,
} from "@t3tools/provider-core/server/usage";
import * as HostProcess from "@t3tools/shared/HostProcess";

import type { MuseSettings } from "../settings.ts";

/**
 * `recorded_at` is microseconds since the epoch in current logs. Accept
 * milliseconds and seconds too so a unit change degrades to the right day
 * instead of the year 56000.
 */
function recordedAtMs(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  if (value > 1e14) return Math.floor(value / 1000);
  if (value > 1e11) return Math.floor(value);
  return Math.floor(value * 1000);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

/**
 * Parses one line of a Muse session log. Only `runtime.session` records
 * whose run event is `model_completed` carry token usage; everything else
 * in the log is session machinery.
 */
export function parseMuseLine(line: string): UsageRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  return parseMuseRecord(parsed);
}

function parseMuseRecord(parsed: unknown): UsageRecord | null {
  const record = asRecord(parsed);
  if (record === null || record["payload_type"] !== "runtime.session") return null;

  const payload = asRecord(record["payload"]);
  if (payload === null || payload["kind"] !== "run") return null;

  const event = asRecord(payload["event"]);
  if (event === null || event["kind"] !== "model_completed") return null;

  const usage = asRecord(event["usage"]);
  if (usage === null) return null;

  const timestampMs = recordedAtMs(record["recorded_at"]);
  if (timestampMs === null) return null;

  const model = typeof event["model"] === "string" ? event["model"] : "";
  if (model.length === 0) return null;

  // `input_tokens` is the whole prompt, cached portion included: the first
  // call of a session reports it with zero cache reads, and the next call's
  // `cache_read_tokens` lands just under the previous call's `input_tokens`.
  const cacheReadTokens = tokenCount(usage["cache_read_tokens"] ?? usage["cached_tokens"]);
  const cacheWriteTokens = tokenCount(usage["cache_write_tokens"]);
  const outputTokens = tokenCount(usage["output_tokens"]);
  const totals = {
    uncachedInputTokens: Math.max(
      0,
      tokenCount(usage["input_tokens"]) - cacheReadTokens - cacheWriteTokens,
    ),
    cachedInputTokens: cacheReadTokens,
    cacheCreationTokens: cacheWriteTokens,
    outputTokens,
    // Reasoning is part of the output count, never on top of it.
    reasoningTokens: Math.min(outputTokens, tokenCount(usage["reasoning_tokens"])),
  };
  if (totalTokens(totals) === 0) return null;

  const stream = asRecord(record["stream"]);
  const sessionId = typeof stream?.["id"] === "string" ? stream["id"] : "";

  // A resumed or forked session copies earlier run records under new record
  // ids; the source run identity survives the copy, so key de-duplication
  // on it when present.
  const sourceId = payload["source_run_record_id"];
  const sourceSequence = payload["source_run_record_sequence"];
  const recordId = record["id"];
  const dedupeKey =
    typeof sourceId === "string" && typeof sourceSequence === "number"
      ? `${sourceId}:${sourceSequence}`
      : typeof recordId === "string"
        ? recordId
        : null;

  return {
    provider: "muse",
    timestampMs,
    model,
    sessionId,
    totals,
    // Session logs carry no cost figure; pricing comes from the rate table
    // or a user price override, and stays unpriced until one exists.
    reportedCostUsd: null,
    speed: "standard",
    dedupeKey,
  };
}

const orEmpty = (record: UsageRecord | null): readonly UsageRecord[] =>
  record === null ? [] : [record];

export const museUsageFormat: TranscriptUsageFormat<void> = {
  selectFields: {
    id: true,
    recorded_at: true,
    payload_type: true,
    stream: { id: true },
    payload: {
      kind: true,
      source_run_record_id: true,
      source_run_record_sequence: true,
      event: { kind: true, model: true, usage: true },
    },
  },
  usageMarkers: ['"model_completed"'],
  parseLine: (line) => orEmpty(parseMuseLine(line)),
  parseProjected: (projected) => orEmpty(parseMuseRecord(projected)),
};

export const museUsageReader: ProviderUsageReader<MuseSettings, Path.Path> = {
  kind: "transcripts",
  provider: "muse",
  format: museUsageFormat,
  directories: Effect.fn("museUsageReader.directories")(function* ({ environment }) {
    const path = yield* Path.Path;
    const homeDirectory = yield* HostProcess.HomeDirectory;
    // Muse keeps session logs under the XDG data home on every platform it
    // sets one for; the fallback matches its default `~/.local/share`.
    const dataHome = expandHomePath(
      environment.XDG_DATA_HOME?.trim() || path.join(homeDirectory, ".local", "share"),
      homeDirectory,
    );
    // Session directories also hold tool outputs; only `session.jsonl`
    // (top-level and per-subagent) carries usage.
    return [{ dir: path.resolve(dataHome, "muse", "sessions"), fileName: "session.jsonl" }];
  }),
};
