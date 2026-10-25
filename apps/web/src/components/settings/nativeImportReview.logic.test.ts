import type { IntegrationNativeImportServer } from "@cogenly/contracts";
import { describe, expect, it } from "vite-plus/test";

import { nativeImportReview, nativeServerIcon } from "./nativeImportReview.logic";

const server = (
  overrides: Partial<IntegrationNativeImportServer> & Pick<IntegrationNativeImportServer, "label">,
): IntegrationNativeImportServer => ({
  provider: "claude",
  scope: "user",
  file: "~/.claude.json",
  status: "ready",
  ...overrides,
});
const connector = (label: string): IntegrationNativeImportServer => ({
  label,
  provider: "claude",
  scope: "account",
  status: "needs-sign-in",
});

describe("nativeImportReview", () => {
  it("lists a server defined in many project configs once", () => {
    const review = nativeImportReview(
      ["a", "b", "c"].map((project) =>
        server({ label: "stripe", scope: "project", file: `~/code/${project}/.mcp.json` }),
      ),
    );
    expect(review.count).toBe(1);
    expect(review.groups[0]?.rows).toEqual([
      { key: "claude:stripe", label: "stripe", icon: null, source: "3 projects", status: "ready" },
    ]);
  });

  it("groups Claude before Codex and keeps same-named servers apart across providers", () => {
    const review = nativeImportReview([
      server({ label: "node_repl", provider: "codex", file: "~/.codex/config.toml" }),
      connector("Slack"),
      server({ label: "node_repl" }),
    ]);
    expect(review.groups.map((group) => group.title)).toEqual(["Claude", "Codex"]);
    expect(review.groups[0]?.rows.map((row) => row.label)).toEqual(["node_repl", "Slack"]);
    expect(review.groups[1]?.rows.map((row) => row.source)).toEqual(["~/.codex/config.toml"]);
    expect(review.count).toBe(3);
  });

  it("names every place a merged server came from and shows what its copies still need", () => {
    const [row] = nativeImportReview([
      server({ label: "Linear", file: "~/.claude.json" }),
      server({
        label: "linear",
        scope: "project",
        file: "~/code/app/.mcp.json",
        status: "needs-secret",
      }),
      connector("Linear"),
    ]).groups[0]!.rows;
    expect(row).toMatchObject({
      label: "Linear",
      icon: "linear",
      source: "~/.claude.json, ~/code/app/.mcp.json, claude.ai account",
      status: "needs-secret",
    });
  });

  it("leaves out empty groups", () => {
    expect(nativeImportReview([])).toEqual({ groups: [], count: 0 });
    expect(
      nativeImportReview([server({ label: "x", provider: "codex" })]).groups.map(
        (group) => group.provider,
      ),
    ).toEqual(["codex"]);
  });
});

describe("nativeServerIcon", () => {
  it("draws Google Workspace for any Google service and a plug for unknown servers", () => {
    expect(nativeServerIcon("Google Drive")).toBe("google-workspace");
    expect(nativeServerIcon("Gmail")).toBe("google-workspace");
    expect(nativeServerIcon("Wispr Flow")).toBe("wispr-flow");
    expect(nativeServerIcon("computer-use")).toBeNull();
  });
});
