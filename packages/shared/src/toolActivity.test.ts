import { describe, expect, it } from "vite-plus/test";

import {
  claudeSkillInvocation,
  collectToolFilePaths,
  dynamicToolTitle,
  dynamicToolSurface,
  formatReadToolLabel,
  formatSearchToolLabel,
  mergeToolActivityData,
} from "./toolActivity.ts";

describe("toolActivity", () => {
  it("formats read and search labels from structured input", () => {
    expect(formatReadToolLabel("src/env.ts")).toBe("Read src/env.ts");
    expect(formatReadToolLabel("src/env.ts", 2)).toBe("Read src/env.ts +2 more");
    expect(formatReadToolLabel("")).toBe("Read file");
    expect(
      formatSearchToolLabel({
        input: { pattern: "TODO", path: "apps/web" },
      }),
    ).toBe("Searched TODO in web");
    expect(
      formatSearchToolLabel({
        input: { glob: "*.ts", path: "/tmp/t3chat-new" },
      }),
    ).toBe("Searched files *.ts in t3chat-new");
    expect(
      formatSearchToolLabel({ rawInput: {}, input: { pattern: "TODO", path: "apps/web" } }),
    ).toBe("Searched TODO in web");
    expect(formatSearchToolLabel({ input: { globPattern: "*.tsx", path: "apps/web" } })).toBe(
      "Searched files *.tsx in web",
    );
    expect(
      formatSearchToolLabel({ input: { pattern: "TODO", glob: "*.ts", path: "apps/web" } }),
    ).toBe("Searched TODO in web");
  });

  it("keeps bare filenames from explicit path fields", () => {
    expect(collectToolFilePaths({ input: { file_path: "README" } })).toEqual(["README"]);
  });

  it("keeps the first non-empty rawInput when a later update is empty", () => {
    expect(
      mergeToolActivityData({ rawInput: { path: "src/a.ts" } }, { rawInput: {}, kind: "read" }),
    ).toEqual({
      rawInput: { path: "src/a.ts" },
      kind: "read",
    });
    expect(
      mergeToolActivityData({ rawInput: { path: "src/a.ts" } }, { rawInput: { startLine: 4 } }),
    ).toEqual({ rawInput: { path: "src/a.ts", startLine: 4 } });
  });

  it.each(["cua_repl.js", "node_repl.js", "js"])("uses the action title for %s", (toolName) => {
    expect(dynamicToolTitle(toolName, { title: " Read the current T3 desktop window " })).toBe(
      "Read the current T3 desktop window",
    );
    const fallback = toolName === "cua_repl.js" ? "Computer use" : "Run JavaScript";
    expect(dynamicToolTitle(toolName, { title: " " })).toBe(fallback);
    expect(dynamicToolTitle(toolName, { title: 123 })).toBe(fallback);
    expect(dynamicToolTitle(toolName, {})).toBe(fallback);
    expect(dynamicToolTitle(toolName, { code: "await sky.get_app_state(app);" })).toBe(
      "Computer use",
    );
  });

  it("keeps a retained action title but replaces raw REPL names", () => {
    expect(dynamicToolTitle("js", {}, "Read the window")).toBe("Read the window");
    expect(dynamicToolTitle("js", { title: "Inspect the window" }, "Read the window")).toBe(
      "Inspect the window",
    );
    expect(dynamicToolTitle("js", { code: "await sky.click(app);" }, "Js")).toBe("Computer use");
    expect(dynamicToolTitle("node_repl.js", {}, "Node_repl.js")).toBe("Run JavaScript");
  });

  it("recognizes computer-use REPL calls before result metadata exists", () => {
    expect(dynamicToolSurface("cua_repl.js", {})).toBe("computer");
    for (const name of ["node_repl.js", "js"]) {
      expect(dynamicToolSurface(name, { code: "await sky.get_app_state(app);" })).toBe("computer");
      expect(dynamicToolSurface(name, { code: "const sky = await import('@oai/sky');" })).toBe(
        "computer",
      );
      expect(dynamicToolSurface(name, { code: "await fs.readFile(path);" })).toBeUndefined();
    }
    expect(dynamicToolSurface("github.js", { code: "await sky.click(app);" })).toBeUndefined();
  });

  it("leaves ordinary tool titles in their arguments", () => {
    expect(dynamicToolTitle("github.create_issue", { title: "Issue title" })).toBeUndefined();
  });

  it("titles Claude skill calls with the skill they load", () => {
    expect(dynamicToolTitle("Skill", { skill: "full-send" })).toBe("Skill: full-send");
    expect(claudeSkillInvocation("Skill", { skill: "claude-api", args: " pricing " })).toEqual({
      name: "claude-api",
      args: "pricing",
    });
    expect(dynamicToolTitle("Skill", { skill: " " })).toBeUndefined();
    expect(dynamicToolTitle("Read", { skill: "full-send" })).toBeUndefined();
  });
});
