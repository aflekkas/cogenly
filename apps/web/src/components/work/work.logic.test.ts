import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  ADD_REPOSITORY,
  describeWorkStartFailure,
  deriveWorkRowStatus,
  NO_REPOSITORY,
  listWorkPickerChoices,
  listWorkRepositories,
  openWorkWhenArrived,
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

describe("listWorkPickerChoices", () => {
  const repositories = [project(envA, "api", "api"), project(envA, "web", "web")];

  it("puts the chat's own repository first, then the rest, no repository and add", () => {
    expect(
      listWorkPickerChoices({
        repositories,
        sourceProjectId: ProjectId.make("web"),
        canRunWithoutRepository: true,
      }).map((choice) => choice.value),
    ).toEqual(["web", "api", NO_REPOSITORY, ADD_REPOSITORY]);
  });

  it("offers no repository only where the machine has a scratch folder", () => {
    expect(
      listWorkPickerChoices({
        repositories,
        sourceProjectId: null,
        canRunWithoutRepository: false,
      }).map((choice) => choice.value),
    ).toEqual(["api", "web", ADD_REPOSITORY]);
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

describe("openWorkWhenArrived", () => {
  it("opens the Work thread only after it reaches this client", async () => {
    const steps: string[] = [];
    let arrive: (arrived: boolean) => void = () => {};
    const opened = openWorkWhenArrived({
      waitForThread: () =>
        new Promise<boolean>((resolve) => {
          steps.push("wait");
          arrive = resolve;
        }),
      open: () => steps.push("open"),
    });
    await Promise.resolve();
    expect(steps).toEqual(["wait"]);
    arrive(true);
    await expect(opened).resolves.toBe(true);
    expect(steps).toEqual(["wait", "open"]);
  });

  it("opens nothing when the thread never arrives, so the route cannot fall back to a draft", async () => {
    let opens = 0;
    await expect(
      openWorkWhenArrived({
        waitForThread: async () => false,
        open: () => {
          opens += 1;
        },
      }),
    ).resolves.toBe(false);
    expect(opens).toBe(0);
  });
});
