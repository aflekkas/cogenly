import { describe, expect, it } from "@effect/vitest";
import * as Option from "effect/Option";

import {
  deriveInstanceId,
  matchT3Projects,
  resolveSetupPlan,
  type SetupFlags,
} from "./setupPlan.ts";

const flags = (overrides: Partial<SetupFlags> = {}): SetupFlags => ({
  yes: true,
  importT3: false,
  projects: Option.none(),
  settings: false,
  dryRun: false,
  claudeHome: [],
  codexHome: [],
  defaultModel: Option.none(),
  sessions: Option.none(),
  ...overrides,
});

const plan = (overrides: Partial<SetupFlags>, terminal = false) => {
  const result = resolveSetupPlan(flags(overrides), terminal);
  if (result._tag !== "Plan") throw new Error(result.problems.join("; "));
  return result.plan;
};

const problems = (overrides: Partial<SetupFlags>, terminal = false) => {
  const result = resolveSetupPlan(flags(overrides), terminal);
  return result._tag === "Invalid" ? result.problems : [];
};

describe("cogenly setup --yes", () => {
  it("runs the documented agent invocation without prompts", () => {
    expect(
      plan({
        importT3: true,
        projects: Option.some("a, b,,"),
        settings: true,
        claudeHome: ["claude-personal=~/.claude_personal"],
        defaultModel: Option.some("claude-personal:claude-opus-4-1"),
      }),
    ).toEqual({
      interactive: false,
      instances: [
        { instanceId: "claude-personal", driver: "claudeAgent", homePath: "~/.claude_personal" },
      ],
      defaultModel: { instanceId: "claude-personal", model: "claude-opus-4-1" },
      t3Import: { projects: ["a", "b"], includeSettings: true, dryRun: false },
      sessions: null,
    });
  });

  it("does nothing it wasn't asked to", () => {
    expect(plan({})).toEqual({
      interactive: false,
      instances: [],
      defaultModel: null,
      t3Import: null,
      sessions: null,
    });
  });

  it("names an account from its folder when no id is given", () => {
    expect(
      plan({ claudeHome: ["~/.claude_personal"], codexHome: ["/x/.codex-work/"] }).instances,
    ).toEqual([
      { instanceId: "claude-personal", driver: "claudeAgent", homePath: "~/.claude_personal" },
      { instanceId: "codex-work", driver: "codex", homePath: "/x/.codex-work/" },
    ]);
    expect(deriveInstanceId("claude", "~/.claude")).toBe("claude-extra");
    expect(deriveInstanceId("codex", "~/Work Codex")).toBe("codex-work-codex");
  });

  it("refuses to guess in a pipe without --yes", () => {
    expect(problems({ yes: false })).toEqual([
      "Not running in a terminal. Pass --yes and say what to set up with flags.",
    ]);
    expect(plan({ yes: false }, true).interactive).toBe(true);
  });

  it("rejects import options without --import-t3, and malformed values", () => {
    expect(
      problems({
        projects: Option.some("a"),
        settings: true,
        claudeHome: ["9bad=~/.claude_x", "ok="],
        defaultModel: Option.some("no-model"),
        sessions: Option.some(" , "),
      }),
    ).toEqual([
      '--claude-home 9bad=~/.claude_x: "9bad" is not a valid instance id (letters, digits, - and _, starting with a letter).',
      "--claude-home ok=: give a config folder, like id=~/.claude_work.",
      "--default-model no-model: use instance:model, like claudeAgent:claude-opus-4-1.",
      "--projects only applies to the T3 Code import; add --import-t3.",
      "--settings only applies to the T3 Code import; add --import-t3.",
      "--sessions needs `all` or a comma-separated list of folders.",
    ]);
    expect(problems({ claudeHome: ["a=/one", "a=/two"] })).toEqual([
      '--claude-home a=/two: instance "a" is given twice.',
    ]);
  });

  it("takes all or a folder list for the raw session import", () => {
    expect(plan({ sessions: Option.some("all") }).sessions).toBe("all");
    expect(plan({ sessions: Option.some("~/a,/b") }).sessions).toEqual(["~/a", "/b"]);
  });
});

describe("matchT3Projects", () => {
  const project = (sourceProjectId: string, title: string, workspaceRoot: string) => ({
    sourceProjectId,
    title,
    workspaceRoot,
    threadCount: 1,
    rootThreadCount: 1,
    existingProjectId: null,
    existingProjectTitle: null,
    isScratch: false,
    selectedByDefault: true,
  });
  const projects = [project("p1", "Cogenly", "/code/cogenly"), project("p2", "Site", "/code/site")];

  it("accepts ids, titles in any case and folders, once each", () => {
    expect(matchT3Projects(["p1", "site", "/code/cogenly/"], projects)).toEqual({
      ids: ["p1", "p2"],
      unknown: [],
    });
    expect(matchT3Projects(["nope"], projects)).toEqual({ ids: [], unknown: ["nope"] });
  });
});
