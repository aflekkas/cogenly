import { describe, expect, it } from "@effect/vitest";
import { formatCliCommand } from "./invocation.ts";

describe("Cogenly package runner suggestions", () => {
  it.each([
    ["/tmp/_npx/hash/node_modules/t3/dist/bin.mjs", "0.3.0", "npx cogenly"],
    ["/tmp/_npx/hash/node_modules/cogenly/dist/bin.mjs", "0.3.1-nightly.1", "npx cogenly@nightly"],
    [
      "/tmp/pnpm/dlx/hash/node_modules/cogenly/dist/bin.mjs",
      "0.3.1-preview.2",
      "pnpm dlx cogenly@preview",
    ],
    ["/tmp/bunx-123-cogenly/bin/cogenly", "0.3.0", "bunx cogenly"],
  ])("keeps an update suggestion on Cogenly for %s", (entryPath, version, prefix) => {
    expect(formatCliCommand({ subcommand: "update 0.3.0", entryPath, version })).toBe(
      `${prefix} update 0.3.0`,
    );
  });
});
