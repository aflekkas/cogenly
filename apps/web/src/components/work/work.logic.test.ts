import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import { EnvironmentId, MessageId, ProjectId, RunId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  ADD_REPOSITORY,
  anchorWorkHandoffs,
  describeWorkStartFailure,
  deriveWorkHandoffStatus,
  deriveWorkRowStatus,
  groupWorkChoicesByProject,
  NO_REPOSITORY,
  listWorkPickerChoices,
  listWorkRepositories,
  openWorkWhenArrived,
  workNotificationStatus,
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

describe("groupWorkChoicesByProject", () => {
  const choices = listWorkPickerChoices({
    repositories: [
      project(envA, "api", "api"),
      project(envA, "loose", "loose"),
      project(envA, "web", "web"),
    ],
    sourceProjectId: null,
    canRunWithoutRepository: true,
  });
  const acme = { key: "acme" };
  const blog = { key: "blog" };
  const empty = { key: "empty" };
  const projectOf = (id: ProjectId) => (id === "api" ? acme : id === "web" ? blog : null);

  it("files repositories under their projects, the chat's own project first, loose ones last", () => {
    const groups = groupWorkChoicesByProject({
      choices,
      projects: [acme, blog, empty],
      projectOf,
      sourceProjectId: ProjectId.make("web"),
    });
    expect(groups.map((group) => [group.key, group.choices.map((choice) => choice.value)])).toEqual(
      [
        ["blog", ["web"]],
        ["acme", ["api"]],
        // A project with nothing cloned yet still lists, for its GitHub repositories.
        ["empty", []],
        [null, ["loose"]],
      ],
    );
  });

  it("keeps project order without a source repository", () => {
    expect(
      groupWorkChoicesByProject({
        choices,
        projects: [acme, blog],
        projectOf,
        sourceProjectId: null,
      }).map((group) => group.key),
    ).toEqual(["acme", "blog", null]);
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
    expect(workPrefersNewWorktree({ ...base, resolvedSource: "cogenly.json" })).toBe(false);
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

describe("anchorWorkHandoffs", () => {
  const run1 = RunId.make("run-1");
  const messages = [
    { id: MessageId.make("u1"), role: "user", runId: run1, createdAt: "2026-10-01T10:00:00Z" },
    // Commentary mid-turn, then the turn's last reply.
    { id: MessageId.make("a1"), role: "assistant", runId: run1, createdAt: "2026-10-01T10:01:00Z" },
    { id: MessageId.make("a2"), role: "assistant", runId: run1, createdAt: "2026-10-01T10:05:00Z" },
    { id: MessageId.make("u2"), role: "user", runId: null, createdAt: "2026-10-01T11:00:00Z" },
  ] as const;
  const link = (id: string, createdAt: string, throughMessageId?: string) => ({
    threadId: ThreadId.make(id),
    title: id,
    createdAt,
    ...(throughMessageId === undefined
      ? {}
      : { throughMessageId: MessageId.make(throughMessageId) }),
  });

  it("puts each marker after the message its Work was started from", () => {
    const anchors = anchorWorkHandoffs(
      [link("w2", "2026-10-01T12:00:00Z", "u2"), link("w1", "2026-10-01T12:00:00Z", "u1")],
      messages,
    );
    expect(anchors.byMessageId.get(MessageId.make("u1"))?.map((l) => l.threadId)).toEqual(["w1"]);
    expect(anchors.byMessageId.get(MessageId.make("u2"))?.map((l) => l.threadId)).toEqual(["w2"]);
    expect(anchors.unanchored).toEqual([]);
  });

  it("anchors a link without its message to the end of the turn before it", () => {
    // Started while the commentary was the latest message: still after the reply.
    const anchors = anchorWorkHandoffs(
      [link("w1", "2026-10-01T10:02:00Z"), link("w2", "2026-10-01T10:30:00Z", "deleted")],
      messages,
    );
    expect(anchors.byMessageId.get(MessageId.make("a2"))?.map((l) => l.threadId)).toEqual([
      "w1",
      "w2",
    ]);
  });

  it("leaves a link from before every loaded message unanchored", () => {
    const anchors = anchorWorkHandoffs([link("w1", "2026-09-01T00:00:00Z")], messages);
    expect(anchors.byMessageId.size).toBe(0);
    expect(anchors.unanchored.map((l) => l.threadId)).toEqual(["w1"]);
  });
});

describe("workNotificationStatus", () => {
  it("reads the status a Work session reported back with", () => {
    expect(workNotificationStatus("completed")).toBe("done");
    expect(workNotificationStatus("unknown")).toBe("done");
    expect(workNotificationStatus("failed")).toBe("failed");
    expect(workNotificationStatus("cancelled")).toBe("stopped");
    expect(workNotificationStatus("updated")).toBe("waiting");
  });
});

describe("deriveWorkHandoffStatus", () => {
  const idle = {
    latestRun: null,
    runtime: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
  } as const;

  it("reads running, waiting, done, failed and stopped from the shell", () => {
    expect(deriveWorkHandoffStatus(idle)).toBeNull();
    expect(deriveWorkHandoffStatus({ ...idle, runtime: { status: "running" } })).toBe("running");
    expect(deriveWorkHandoffStatus({ ...idle, runtime: { status: "waiting" } })).toBe("running");
    expect(
      deriveWorkHandoffStatus({
        ...idle,
        runtime: { status: "waiting" },
        hasPendingApprovals: true,
      }),
    ).toBe("waiting");
    expect(
      deriveWorkHandoffStatus({
        ...idle,
        latestRun: { status: "failed" },
        hasPendingUserInput: true,
      }),
    ).toBe("waiting");
    expect(deriveWorkHandoffStatus({ ...idle, latestRun: { status: "failed" } })).toBe("failed");
    expect(
      deriveWorkHandoffStatus({
        ...idle,
        latestRun: { status: "failed" },
        settledOverride: "settled",
      }),
    ).toBe("done");
    expect(deriveWorkHandoffStatus({ ...idle, latestRun: { status: "completed" } })).toBe("done");
    expect(
      deriveWorkHandoffStatus({
        ...idle,
        latestRun: { status: "interrupted" },
        settledAt: "2026-10-01T00:00:00Z",
      }),
    ).toBe("done");
    expect(deriveWorkHandoffStatus({ ...idle, latestRun: { status: "cancelled" } })).toBe(
      "stopped",
    );
  });
});
