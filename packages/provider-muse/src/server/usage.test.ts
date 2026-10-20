import * as NodePath from "@effect/platform-node/NodePath";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { ProviderInstanceId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { MuseSettings } from "../settings.ts";
import { museUsageReader, parseMuseLine, parseMuseRecord } from "./usage.ts";

const sessionId = "01a1581b-bef7-7000-a56b-d94387446d90";
const recordedAtUs = 1792479578961731;

const completedEvent = {
  kind: "model_completed",
  usage: {
    input_tokens: 31739,
    output_tokens: 89,
    cached_tokens: 31604,
    cache_write_tokens: 12,
    cache_read_tokens: 31604,
    reasoning_tokens: 65,
  },
  duration_ms: 2310,
  model: "muse-wonder-1.0",
  estimated_prompt_tokens: 31888,
};

const bareRecord = {
  schema_version: 1,
  stream: { kind: "session", id: sessionId },
  sequence: 71,
  recorded_at: recordedAtUs,
  record_type: "event",
  payload_type: "runtime.session",
  payload: {
    kind: "run",
    run_id: "01a1581b-c097-7000-889c-2b8790c67814",
    event: completedEvent,
    source_run_record_id: "c550d605-9055-44b6-91ce-cf3c58761804",
    source_run_record_sequence: 30,
  },
};

const decodeMuseSettings = Schema.decodeSync(MuseSettings);

const framedLine = JSON.stringify({
  retained_frame: "session_permission_transaction",
  outer_log_ordinal: 4,
  transaction_id: "01a1581b-bf2f-7c03-8b7d-7d333038be91",
  children: [
    { child_index: 0, record_json: JSON.stringify({ ...bareRecord, sequence: 70 }) },
    {
      child_index: 1,
      record_json: JSON.stringify({
        ...bareRecord,
        sequence: 71,
        payload: {
          ...(bareRecord.payload as Record<string, unknown>),
          event: {
            kind: "goal_usage_attribution",
            record: { usage_id: "usage-51b4be3a", usage_family: "provider" },
          },
        },
      }),
    },
  ],
});

describe("Muse usage", () => {
  it("reads a bare model_completed record with its session and dedupe key", () => {
    expect(parseMuseRecord(bareRecord)).toMatchObject({
      provider: "muse",
      timestampMs: Math.floor(recordedAtUs / 1000),
      model: "muse-wonder-1.0",
      sessionId,
      totals: {
        uncachedInputTokens: 31739,
        cachedInputTokens: 31604,
        cacheCreationTokens: 12,
        outputTokens: 89,
        reasoningTokens: 65,
      },
      reportedCostUsd: null,
      speed: "standard",
      dedupeKey: "c550d605-9055-44b6-91ce-cf3c58761804",
    });
  });

  it("reads framed children once and skips the attribution twin", () => {
    // The attribution record repeats the call's quantities without a model;
    // only the model_completed child may count.
    const records = parseMuseLine(framedLine);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ provider: "muse", model: "muse-wonder-1.0" });
  });

  it("keeps the log's own model label instead of inventing one", () => {
    const record = parseMuseRecord({
      ...bareRecord,
      payload: {
        ...(bareRecord.payload as Record<string, unknown>),
        event: { ...completedEvent, model: "same-as-main" },
      },
    });
    expect(record?.model).toBe("same-as-main");
  });

  it("falls back to cached_tokens when the read split is absent", () => {
    const record = parseMuseRecord({
      ...bareRecord,
      payload: {
        ...(bareRecord.payload as Record<string, unknown>),
        event: {
          ...completedEvent,
          usage: { input_tokens: 100, output_tokens: 10, cached_tokens: 40 },
        },
      },
    });
    expect(record?.totals).toMatchObject({
      uncachedInputTokens: 100,
      cachedInputTokens: 40,
      cacheCreationTokens: 0,
    });
  });

  it("ignores lines and records without billable usage", () => {
    expect(parseMuseLine("not json")).toEqual([]);
    expect(parseMuseLine(JSON.stringify({ children: [{ record_json: "nope" }] }))).toEqual([]);
    expect(parseMuseRecord({ ...bareRecord, stream: {} })?.sessionId).toBe("");
    for (const value of [
      null,
      {},
      { ...bareRecord, recorded_at: "yesterday" },
      {
        ...bareRecord,
        payload: { ...bareRecord.payload, event: { kind: "model_started" } },
      },
      {
        ...bareRecord,
        payload: { ...bareRecord.payload, event: { ...completedEvent, model: "" } },
      },
      {
        ...bareRecord,
        payload: { ...bareRecord.payload, event: { ...completedEvent, usage: null } },
      },
    ]) {
      expect(parseMuseRecord(value)).toBeNull();
    }
  });

  it.effect("resolves the sessions directory from the data home", () =>
    Effect.gen(function* () {
      if (museUsageReader.kind !== "transcripts") {
        throw new Error("the Muse usage reader must scan transcripts");
      }
      const { directories } = museUsageReader;
      const config = decodeMuseSettings({});
      const instance = {
        instanceId: ProviderInstanceId.make("muse"),
        config,
        environment: { ...process.env, XDG_DATA_HOME: "/data" },
        configured: false,
      };
      const fromXdg = yield* directories(instance);
      expect(fromXdg).toEqual([{ dir: "/data/muse/sessions" }]);
      const fromHome = yield* directories({
        ...instance,
        environment: { ...process.env, XDG_DATA_HOME: "" },
      });
      expect(fromHome).toEqual([{ dir: "/test-home/.local/share/muse/sessions" }]);
      const undecodable = yield* directories({ ...instance, config: undefined });
      expect(undecodable).toEqual([]);
    }).pipe(
      Effect.provideService(HostProcess.HomeDirectory, "/test-home"),
      Effect.provide(NodePath.layer),
    ),
  );
});
