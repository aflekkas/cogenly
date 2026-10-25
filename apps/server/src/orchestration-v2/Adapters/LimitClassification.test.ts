import { describe, expect, it } from "vite-plus/test";
import type { OrchestrationV2ProviderFailure } from "@cogenly/contracts";
import * as DateTime from "effect/DateTime";

import { classifyClaudeLimitFailure } from "./ClaudeAdapterV2.ts";
import { classifyCodexLimitFailure } from "./CodexAdapterV2.ts";

const completedAt = DateTime.makeUnsafe("2026-10-24T20:00:00.000Z");
const limit = (overrides: Partial<OrchestrationV2ProviderFailure> = {}) =>
  ({
    class: "usage_limit",
    message: "Claude API rate limit reached. Try again later.",
    code: "api_error_429",
    retryable: true,
    ...overrides,
  }) satisfies OrchestrationV2ProviderFailure;

describe("classifyClaudeLimitFailure", () => {
  it("reads a bare 429 as a short-term rate limit retried after the CLI's backoff", () => {
    expect(
      classifyClaudeLimitFailure({
        failure: limit(),
        windowRejected: false,
        windowResetAt: null,
        retryDelayMs: 90_000,
        completedAt,
      }),
    ).toMatchObject({ limitKind: "rate_limit", resetAt: "2026-10-24T20:01:30.000Z" });
    // Without a reported backoff it waits a minute; a tiny one is raised to 30s.
    expect(
      classifyClaudeLimitFailure({
        failure: limit(),
        windowRejected: false,
        windowResetAt: null,
        retryDelayMs: undefined,
        completedAt,
      }).resetAt,
    ).toBe("2026-10-24T20:01:00.000Z");
    expect(
      classifyClaudeLimitFailure({
        failure: limit(),
        windowRejected: false,
        windowResetAt: null,
        retryDelayMs: 500,
        completedAt,
      }).resetAt,
    ).toBe("2026-10-24T20:00:30.000Z");
  });

  it("reads a rejected usage window as an exhausted quota until that window resets", () => {
    expect(
      classifyClaudeLimitFailure({
        failure: limit({ message: "Claude usage limit reached." }),
        windowRejected: true,
        windowResetAt: "2026-10-25T01:00:00.000Z",
        retryDelayMs: 90_000,
        completedAt,
      }),
    ).toMatchObject({ limitKind: "quota", resetAt: "2026-10-25T01:00:00.000Z" });
  });

  it("keeps a gateway cooldown's own classification and reset", () => {
    const gateway = limit({ limitKind: "rate_limit", resetAt: "2026-10-24T20:00:45.000Z" });
    expect(
      classifyClaudeLimitFailure({
        failure: gateway,
        windowRejected: false,
        windowResetAt: null,
        retryDelayMs: undefined,
        completedAt,
      }),
    ).toEqual(gateway);
  });
});

describe("classifyCodexLimitFailure", () => {
  const nowMs = Date.parse("2026-10-24T20:00:00.000Z");

  it("reads rateLimitExceeded without a spent window as a short-term rate limit", () => {
    expect(
      classifyCodexLimitFailure(
        limit({ code: "rateLimitExceeded", message: "Rate limit exceeded." }),
        undefined,
        nowMs,
      ),
    ).toMatchObject({ limitKind: "rate_limit", resetAt: "2026-10-24T20:01:00.000Z" });
  });

  it("reads usageLimitExceeded as an exhausted quota", () => {
    expect(
      classifyCodexLimitFailure(
        limit({ code: "usageLimitExceeded", message: "Usage limit reached." }),
        undefined,
        nowMs,
      ),
    ).toMatchObject({ limitKind: "quota", resetAt: null });
  });
});
