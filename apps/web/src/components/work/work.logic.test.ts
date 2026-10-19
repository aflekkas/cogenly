import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import { EnvironmentId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildThreadActionMenuItems, type ThreadActionMenuState } from "../threadActionMenu.logic";
import {
  describeWorkStartFailure,
  deriveWorkRowStatus,
  listWorkRepositories,
  resolveStartWorkFields,
  resolveStartWorkSubmission,
  type StartWorkFields,
  workPrefersNewWorktree,
  workStatusPresentation,
} from "./work.logic";

const envA = EnvironmentId.make("env-a");
const envB = EnvironmentId.make("env-b");

function project(
  environmentId: EnvironmentId,
  id: string,
  title: string,
  extra: Partial<EnvironmentProject> = {},
): EnvironmentProject {
  return {
    environmentId,
    id: ProjectId.make(id),
    title,
    workspaceRoot: `/repos/${id}`,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...extra,
  };
}

describe("listWorkRepositories", () => {
  it("lists the source environment's repositories by title, without scratch", () => {
    const repositories = listWorkRepositories(
      [
        project(envA, "web", "web"),
        project(envA, "scratch-flag", "Scratch", { isScratch: true }),
        project(envA, "scratch-root", "Old scratch", { workspaceRoot: "/home/me/.scratch" }),
        project(envB, "elsewhere", "api"),
        project(envA, "booking", "booking-audit"),
      ],
      envA,
      "/home/me/.scratch",
    );
    expect(repositories.map((repository) => repository.id)).toEqual(["booking", "web"]);
  });
});

describe("resolveStartWorkFields", () => {
  const repositories = [{ id: ProjectId.make("booking") }, { id: ProjectId.make("web") }];
  const sourceThread = { title: "Booking chat", projectId: ProjectId.make("scratch") };
  const proposal = {
    title: "Fix booking path checks",
    scopeSummary: "Make the booking path checks reject stale slots.",
    suggestedProjectId: ProjectId.make("booking"),
  };

  it("starts from the chat title while the proposal is loading", () => {
    expect(
      resolveStartWorkFields({ edits: {}, proposal: null, repositories, sourceThread }),
    ).toEqual({ title: "Booking chat", scopeSummary: "", projectId: null });
  });

  it("fills untouched fields from the proposal and keeps the user's edits", () => {
    expect(
      resolveStartWorkFields({
        edits: { title: "My title", projectId: ProjectId.make("web") },
        proposal,
        repositories,
        sourceThread,
      }),
    ).toEqual({
      title: "My title",
      scopeSummary: proposal.scopeSummary,
      projectId: ProjectId.make("web"),
    });
  });

  it("keeps an emptied field empty instead of refilling it", () => {
    expect(
      resolveStartWorkFields({ edits: { scopeSummary: "" }, proposal, repositories, sourceThread })
        .scopeSummary,
    ).toBe("");
  });

  it("ignores a suggestion outside the repository list", () => {
    const fields = resolveStartWorkFields({
      edits: {},
      proposal: { ...proposal, suggestedProjectId: ProjectId.make("scratch") },
      repositories,
      sourceThread,
    });
    expect(fields.projectId).toBeNull();
  });

  it("falls back to the thread's own repository, then the only repository", () => {
    expect(
      resolveStartWorkFields({
        edits: {},
        proposal: { ...proposal, suggestedProjectId: null },
        repositories,
        sourceThread: { ...sourceThread, projectId: ProjectId.make("web") },
      }).projectId,
    ).toBe(ProjectId.make("web"));
    expect(
      resolveStartWorkFields({
        edits: {},
        proposal: { ...proposal, suggestedProjectId: null },
        repositories: [repositories[0]!],
        sourceThread,
      }).projectId,
    ).toBe(ProjectId.make("booking"));
  });
});

describe("resolveStartWorkSubmission", () => {
  const fields: StartWorkFields = {
    title: "  Fix booking  ",
    scopeSummary: " Reject stale slots. ",
    projectId: ProjectId.make("booking"),
  };

  it("trims the fields and keeps the chat's model unless one was picked", () => {
    expect(
      resolveStartWorkSubmission({ fields, workspace: "worktree", modelSelection: null }),
    ).toEqual({
      ok: true,
      input: {
        targetProjectId: ProjectId.make("booking"),
        title: "Fix booking",
        scopeSummary: "Reject stale slots.",
        workspace: "worktree",
      },
    });
    const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6" };
    const submission = resolveStartWorkSubmission({ fields, workspace: "local", modelSelection });
    expect(submission.ok && submission.input.modelSelection).toEqual(modelSelection);
  });

  it("explains what is missing", () => {
    const reason = (overrides: Partial<typeof fields>) => {
      const submission = resolveStartWorkSubmission({
        fields: { ...fields, ...overrides },
        workspace: "worktree",
        modelSelection: null,
      });
      return submission.ok ? null : submission.reason;
    };
    expect(reason({ projectId: null })).toBe("Choose a repository.");
    expect(reason({ title: "   " })).toBe("Add a title.");
    expect(reason({ scopeSummary: "" })).toBe("Describe the scope.");
    expect(reason({ title: "x".repeat(201) })).toMatch(/title/);
    expect(reason({ scopeSummary: "x".repeat(16001) })).toMatch(/too long/);
  });
});

describe("describeWorkStartFailure", () => {
  it("reuses the command only when a session may already exist", () => {
    expect(describeWorkStartFailure("record-link").retryWithSameCommand).toBe(true);
    expect(describeWorkStartFailure(null).retryWithSameCommand).toBe(true);
    expect(describeWorkStartFailure("launch").retryWithSameCommand).toBe(false);
    expect(describeWorkStartFailure("resolve-project").retryWithSameCommand).toBe(false);
    expect(describeWorkStartFailure("read-source").retryWithSameCommand).toBe(false);
  });
});

describe("workStatusPresentation", () => {
  it("says nothing for a draft and labels every evidence-backed state", () => {
    expect(workStatusPresentation("draft")).toBeNull();
    expect(workStatusPresentation("awaiting_input")).toEqual({
      label: "Needs input",
      tone: "warning",
    });
    expect(workStatusPresentation("review_ready")?.tone).toBe("success");
    expect(workStatusPresentation("failed")?.tone).toBe("error");
  });
});

describe("deriveWorkRowStatus", () => {
  const row = (
    latestStatus: string | null,
    runtimeStatus: string | null,
    extra: Partial<Parameters<typeof deriveWorkRowStatus>[0]> = {},
  ) => ({
    latestRun: latestStatus === null ? null : { status: latestStatus },
    runtime: runtimeStatus === null ? null : { status: runtimeStatus },
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    ...extra,
  });

  it("marks a stopped run paused and a cancelled or rolled back run canceled", () => {
    expect(deriveWorkRowStatus(row("interrupted", "interrupted"))).toBe("paused");
    expect(deriveWorkRowStatus(row("cancelled", "cancelled"))).toBe("canceled");
    expect(deriveWorkRowStatus(row("rolled_back", "rolled_back"))).toBe("canceled");
  });

  it("leaves states the row pill already shows, or that ended, to the pill", () => {
    expect(deriveWorkRowStatus(row("interrupted", "running"))).toBeNull();
    expect(deriveWorkRowStatus(row("failed", "failed"))).toBeNull();
    expect(deriveWorkRowStatus(row("completed", "completed"))).toBeNull();
    expect(deriveWorkRowStatus(row(null, null))).toBeNull();
    expect(
      deriveWorkRowStatus(
        row("interrupted", "interrupted", { settledAt: "2026-10-19T00:00:00.000Z" }),
      ),
    ).toBeNull();
  });
});

describe("workPrefersNewWorktree", () => {
  const base = {
    inWorkMode: true,
    isScratch: false,
    environmentDefault: null,
    resolvedSource: "environment" as const,
  };

  it("defaults Work to a new worktree only when nothing is configured", () => {
    expect(workPrefersNewWorktree(base)).toBe(true);
    expect(workPrefersNewWorktree({ ...base, inWorkMode: false })).toBe(false);
    expect(workPrefersNewWorktree({ ...base, isScratch: true })).toBe(false);
    expect(workPrefersNewWorktree({ ...base, environmentDefault: "local" })).toBe(false);
    expect(workPrefersNewWorktree({ ...base, resolvedSource: "project" })).toBe(false);
    expect(workPrefersNewWorktree({ ...base, resolvedSource: "t3.json" })).toBe(false);
  });
});

describe("Start Work in the thread action menu", () => {
  const state: ThreadActionMenuState = {
    canOperate: true,
    branch: null,
    isSettled: false,
    autoSettleEnabled: true,
    isSnoozed: false,
    canSnoozeNow: true,
    isRegeneratingTitle: false,
    isRunning: false,
    supports: {
      settlement: false,
      autoSettleOptOut: false,
      snooze: false,
      titleRegeneration: false,
    },
    snoozePresets: [],
  };
  const startWork = (menuState: ThreadActionMenuState) =>
    buildThreadActionMenuItems(menuState).find((item) => item.id === "start-work");

  it("is offered only where the caller allows it, and disabled without operate access", () => {
    expect(startWork(state)).toBeUndefined();
    expect(startWork({ ...state, canStartWork: true })?.disabled).toBeUndefined();
    expect(startWork({ ...state, canStartWork: true, canOperate: false })?.disabled).toBe(true);
  });
});
