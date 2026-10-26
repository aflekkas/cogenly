import { assert, it } from "@effect/vitest";
import type { OrchestrationV2TurnItem, RunId } from "@cogenly/contracts";
import * as DateTime from "effect/DateTime";

import { activeProviderBackoff, providerBackoffForRun } from "./ProviderBackoff.ts";

const runId = "run-backoff" as RunId;
const startedAt = DateTime.makeUnsafe("2026-10-26T13:35:33.000Z");
const startedMs = DateTime.toEpochMillis(startedAt);

function retryItem(overrides: Record<string, unknown> = {}): OrchestrationV2TurnItem {
  return {
    type: "error",
    status: "running",
    runId,
    startedAt,
    updatedAt: startedAt,
    failure: {
      class: "usage_limit",
      limitKind: "rate_limit",
      code: "rateLimitExceeded",
      message: "429 Too Many Requests, retrying in 368.99s",
      retryable: true,
    },
    retry: { attempt: 2, maxAttempts: 5, retryDelayMs: 368_990 },
    ...overrides,
  } as unknown as OrchestrationV2TurnItem;
}

it("derives the retry time from a fixture 429 retry item", () => {
  const backoff = providerBackoffForRun({
    turnItems: [retryItem()],
    runId,
    nowMs: startedMs + 60_000,
  });
  assert.deepEqual(backoff, {
    runId,
    retryAtMs: startedMs + 368_990,
    attempt: 2,
    maxAttempts: 5,
  });
});

it("ends when the retry time passes", () => {
  assert.strictEqual(
    providerBackoffForRun({
      turnItems: [retryItem()],
      runId,
      nowMs: startedMs + 368_990,
    }),
    null,
  );
});

it("ignores a spent quota and a finished retry", () => {
  const quota = retryItem({
    failure: {
      class: "usage_limit",
      limitKind: "quota",
      code: "usageLimitExceeded",
      message: "Usage limit reached",
      retryable: false,
    },
  });
  assert.strictEqual(
    providerBackoffForRun({ turnItems: [quota], runId, nowMs: startedMs + 1_000 }),
    null,
  );
  assert.strictEqual(
    providerBackoffForRun({
      turnItems: [retryItem({ status: "completed" })],
      runId,
      nowMs: startedMs + 1_000,
    }),
    null,
  );
});

it("falls back to the failure reset time when no delay is named", () => {
  const item = retryItem({
    retry: { attempt: 1, maxAttempts: null, retryDelayMs: null },
    failure: {
      class: "usage_limit",
      limitKind: "rate_limit",
      code: null,
      message: "Rate limited",
      retryable: true,
      resetAt: "2026-10-26T13:41:33.000Z",
    },
  });
  const backoff = providerBackoffForRun({
    turnItems: [item],
    runId,
    nowMs: startedMs + 1_000,
  });
  assert.strictEqual(backoff?.retryAtMs, Date.parse("2026-10-26T13:41:33.000Z"));
});

it("finds the backoff of the latest active run only", () => {
  const runs = [
    { id: "run-old" as RunId, status: "completed" as const },
    { id: runId, status: "running" as const },
  ];
  assert.notStrictEqual(
    activeProviderBackoff({ runs, turnItems: [retryItem()], nowMs: startedMs + 1_000 }),
    null,
  );
  assert.strictEqual(
    activeProviderBackoff({
      runs: [{ id: "run-old" as RunId, status: "completed" as const }],
      turnItems: [retryItem()],
      nowMs: startedMs + 1_000,
    }),
    null,
  );
});
