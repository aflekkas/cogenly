import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { it as effectIt } from "@effect/vitest";
import { readClaudeLaunchSettings } from "./ClaudeCommitAttribution.ts";
import { describe, expect, it } from "@effect/vitest";
import { claudeManagedAttributionConflict } from "./ClaudeCommitAttribution.ts";

describe("Claude managed attribution", () => {
  it("detects managed bylines and session links that override session settings", () => {
    expect(claudeManagedAttributionConflict({ attribution: { commit: "Managed author" } })).toBe(
      true,
    );
    expect(claudeManagedAttributionConflict({ attribution: { pr: "Managed byline" } })).toBe(true);
    expect(claudeManagedAttributionConflict({ attribution: { sessionUrl: true } })).toBe(true);
  });
  it("accepts absent, partially disabled, and fully disabled managed settings", () => {
    expect(claudeManagedAttributionConflict({})).toBe(false);
    expect(claudeManagedAttributionConflict({ attribution: { commit: "" } })).toBe(false);
    expect(
      claudeManagedAttributionConflict({ attribution: { commit: "", pr: "", sessionUrl: false } }),
    ).toBe(false);
    expect(claudeManagedAttributionConflict({ attribution: false })).toBe(false);
  });
});

effectIt.live("reads session settings without changing the provider's user files", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "cogenly-claude-attribution-test-" });
    const content = JSON.stringify({
      env: { EXAMPLE: "kept" },
      attribution: { commit: "User byline" },
    });
    yield* fs.writeFileString(`${dir}/settings.json`, content);
    expect(yield* readClaudeLaunchSettings("--settings settings.json", dir)).toEqual(
      JSON.parse(content),
    );
    expect(yield* fs.readFileString(`${dir}/settings.json`)).toBe(content);
    expect(
      yield* readClaudeLaunchSettings('--settings \'{"env":{"EXAMPLE":"kept"}}\'', dir),
    ).toEqual({ env: { EXAMPLE: "kept" } });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
