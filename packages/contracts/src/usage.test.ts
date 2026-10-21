import { describe, expect, it } from "@effect/vitest";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { UsageBucket, UsageProviderKind } from "./usage.ts";

const decodeKind = Schema.decodeUnknownOption(UsageProviderKind);
const decodeBucket = Schema.decodeUnknownOption(UsageBucket);

describe("UsageProviderKind", () => {
  it("still decodes every historical bucket slug", () => {
    for (const slug of [
      "claude",
      "codex",
      "muse",
      "grok",
      "cursor",
      "opencode",
      "antigravity",
      "pi",
    ]) {
      expect(Option.isSome(decodeKind(slug)), slug).toBe(true);
    }
  });

  it("decodes a new driver's slug without a contract change", () => {
    const decoded = decodeKind("fourth");
    expect(Option.isSome(decoded)).toBe(true);
  });

  it("rejects non-slugs", () => {
    expect(Option.isSome(decodeKind(""))).toBe(false);
    expect(Option.isSome(decodeKind("9lives"))).toBe(false);
    expect(Option.isSome(decodeKind("has space"))).toBe(false);
  });

  it("keeps buckets with unknown providers readable", () => {
    const decoded = decodeBucket({
      day: "2026-08-07",
      provider: "fourth",
      model: "fourth-default",
      totals: {
        uncachedInputTokens: 1,
        cachedInputTokens: 0,
        cacheCreationTokens: 0,
        outputTokens: 1,
        reasoningTokens: 0,
      },
      costUsd: 0,
      cacheSavingsUsd: 0,
      costSource: "unpriced",
      records: 1,
      unpricedRecords: 1,
      sessions: 1,
    });
    expect(Option.isSome(decoded)).toBe(true);
  });
});
