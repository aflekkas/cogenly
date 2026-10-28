import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import { museUsageFormat, museUsageReader, parseMuseLine } from "./usage.ts";

const modelCompletedLine = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    schema_version: 1,
    id: "01a1455b-22e3-70f0-9ef2-1a55f4b738d4",
    stream: { kind: "session", id: "01a1455b-111e-7000-91d1-1658cbf39e01" },
    sequence: 75,
    recorded_at: 1792164963043726,
    record_type: "event",
    durability: "durable",
    causation_id: null,
    payload_type: "runtime.session",
    payload_schema_version: 1,
    payload: {
      kind: "run",
      run_id: "01a1455b-1301-7000-b3f4-0d33e101c04c",
      event: {
        kind: "model_completed",
        usage: {
          input_tokens: 52475,
          output_tokens: 204,
          cached_tokens: 0,
          cache_write_tokens: 0,
          cache_read_tokens: 0,
          reasoning_tokens: 72,
        },
        duration_ms: 3532,
        finish_reason: "tool_calls",
        model: "muse-spark-1.3",
      },
      source_run_record_id: "c9996d7f-e1da-47b2-a58e-613f622ca13c",
      source_run_record_sequence: 27,
    },
    ...overrides,
  });

const withUsage = (usage: Record<string, unknown>) => {
  const parsed = JSON.parse(modelCompletedLine()) as {
    payload: { event: { usage: unknown } };
  };
  parsed.payload.event.usage = usage;
  return JSON.stringify(parsed);
};

describe("parseMuseLine", () => {
  it("reads a model_completed record with microsecond timestamps", () => {
    expect(parseMuseLine(modelCompletedLine())).toEqual({
      provider: "muse",
      timestampMs: 1792164963043,
      model: "muse-spark-1.3",
      sessionId: "01a1455b-111e-7000-91d1-1658cbf39e01",
      totals: {
        uncachedInputTokens: 52475,
        cachedInputTokens: 0,
        cacheCreationTokens: 0,
        outputTokens: 204,
        reasoningTokens: 72,
      },
      reportedCostUsd: null,
      speed: "standard",
      dedupeKey: "c9996d7f-e1da-47b2-a58e-613f622ca13c:27",
    });
  });

  it("treats input_tokens as the whole prompt, cache included", () => {
    const record = parseMuseLine(
      withUsage({
        input_tokens: 53737,
        output_tokens: 197,
        cached_tokens: 52465,
        cache_write_tokens: 100,
        cache_read_tokens: 52465,
        reasoning_tokens: 0,
      }),
    );
    expect(record?.totals).toEqual({
      uncachedInputTokens: 1172,
      cachedInputTokens: 52465,
      cacheCreationTokens: 100,
      outputTokens: 197,
      reasoningTokens: 0,
    });
  });

  it("clamps reasoning to output and falls back to cached_tokens", () => {
    const record = parseMuseLine(
      withUsage({ input_tokens: 100, output_tokens: 10, cached_tokens: 40, reasoning_tokens: 50 }),
    );
    expect(record?.totals).toEqual({
      uncachedInputTokens: 60,
      cachedInputTokens: 40,
      cacheCreationTokens: 0,
      outputTokens: 10,
      reasoningTokens: 10,
    });
  });

  it("ignores session machinery, zero-usage completions and malformed lines", () => {
    expect(parseMuseLine("not json")).toBeNull();
    expect(parseMuseLine(modelCompletedLine({ payload_type: "session.started" }))).toBeNull();
    expect(
      parseMuseLine(withUsage({ input_tokens: 0, output_tokens: 0, reasoning_tokens: 0 })),
    ).toBeNull();
    const otherEvent = JSON.parse(modelCompletedLine()) as {
      payload: { event: { kind: string } };
    };
    otherEvent.payload.event.kind = "assistant_message_committed";
    expect(parseMuseLine(JSON.stringify(otherEvent))).toBeNull();
  });

  it("parses the projected shape the same way", () => {
    const projected = {
      id: "01a1455b-22e3-70f0-9ef2-1a55f4b738d4",
      recorded_at: 1792164963043726,
      payload_type: "runtime.session",
      stream: { id: "01a1455b-111e-7000-91d1-1658cbf39e01" },
      payload: {
        kind: "run",
        source_run_record_id: "c9996d7f-e1da-47b2-a58e-613f622ca13c",
        source_run_record_sequence: 27,
        event: {
          kind: "model_completed",
          model: "muse-spark-1.3",
          usage: { input_tokens: 52475, output_tokens: 204, reasoning_tokens: 72 },
        },
      },
    };
    expect(museUsageFormat.parseProjected(projected, undefined)).toEqual([
      expect.objectContaining({ model: "muse-spark-1.3", timestampMs: 1792164963043 }),
    ]);
  });
});

describe("museUsageReader.directories", () => {
  const instance = (environment: NodeJS.ProcessEnv) => ({
    instanceId: ProviderInstanceId.make("muse"),
    config: undefined,
    environment,
    configured: false,
  });
  const readDirectories = (environment: NodeJS.ProcessEnv) =>
    museUsageReader.kind === "transcripts"
      ? museUsageReader.directories(instance(environment))
      : Effect.die(new Error("muse usage reader must read transcripts"));

  it.effect("honours XDG_DATA_HOME", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const directories = yield* readDirectories({ XDG_DATA_HOME: "/data/home" });
      expect(directories).toEqual([
        { dir: path.resolve("/data/home", "muse", "sessions"), fileName: "session.jsonl" },
      ]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("falls back to ~/.local/share", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const directories = yield* readDirectories({});
      expect(directories[0]?.dir.endsWith(path.join(".local", "share", "muse", "sessions"))).toBe(
        true,
      );
      expect(directories[0]?.fileName).toBe("session.jsonl");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
