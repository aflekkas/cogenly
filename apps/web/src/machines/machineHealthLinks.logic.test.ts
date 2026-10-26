import type {
  EnvironmentId,
  ProviderInstanceId,
  ScheduledTaskId,
  ThreadId,
} from "@cogenly/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  healthFixAction,
  healthItemActions,
  machineHealthAgentPrompt,
  machineHealthLink,
  problemsLeftForAgent,
  type MachineHealthActionContext,
  type MachineHealthProblem,
} from "./machineHealthLinks.logic";

const env = (id: string) => id as EnvironmentId;
const HUB = env("hub");
const LAPTOP = env("laptop");
const OTHER = env("other");
const task = "task-1" as ScheduledTaskId;
const thread = "thread-1" as ThreadId;
const provider = "claude" as ProviderInstanceId;

function context(
  connected: ReadonlyArray<EnvironmentId>,
  overrides: Partial<MachineHealthActionContext> = {},
): MachineHealthActionContext {
  const ids = new Set(connected);
  return {
    originEnvironmentId: HUB,
    originMachineName: "Cloud server",
    viaEnvironmentId: HUB,
    isConnected: (id) => ids.has(id),
    ...overrides,
  };
}

function problem(overrides: Partial<MachineHealthProblem> = {}): MachineHealthProblem {
  return {
    itemKey: "stuck-runs:thread:thread-1",
    checkId: "stuck-runs",
    title: `18 subagents stuck in "Athens Racing" for 2 days`,
    detail: "They have likely lost their provider sessions.",
    fix: "stop-runs",
    target: { _tag: "thread", threadId: thread },
    ...overrides,
  };
}

describe("healthFixAction", () => {
  it("runs a direct fix on the origin when this client reaches it", () => {
    expect(healthFixAction([problem()], context([HUB, LAPTOP]))).toMatchObject({
      kind: "fix",
      label: "Fix",
      environmentId: HUB,
      originEnvironmentId: HUB,
      itemKeys: ["stuck-runs:thread:thread-1"],
    });
  });

  it("sends a direct fix through the paired machine when only it is reachable", () => {
    // The owner's case: runs stuck on the VPS, the client connected to the Mac.
    expect(
      healthFixAction([problem()], context([LAPTOP], { viaEnvironmentId: LAPTOP })),
    ).toMatchObject({ kind: "fix", environmentId: LAPTOP, originEnvironmentId: HUB });
    expect(healthFixAction([problem()], context([OTHER], { viaEnvironmentId: LAPTOP }))).toBeNull();
  });

  it("fixes a whole group at once", () => {
    const action = healthFixAction(
      [
        problem(),
        problem({ itemKey: "stuck-runs:thread:thread-2" }),
        problem({ itemKey: "integrations:linear", checkId: "integrations", fix: null }),
      ],
      context([HUB]),
    );
    expect(action).toMatchObject({
      kind: "fix",
      itemKeys: ["stuck-runs:thread:thread-1", "stuck-runs:thread:thread-2"],
    });
    if (action?.kind !== "fix") return;
    // Whatever has no direct fix, or came back manual, goes to an agent after.
    expect(problemsLeftForAgent(action, []).map((entry) => entry.itemKey)).toEqual([
      "integrations:linear",
    ]);
    expect(
      problemsLeftForAgent(action, ["stuck-runs:thread:thread-2"]).map((entry) => entry.itemKey),
    ).toEqual(["stuck-runs:thread:thread-2", "integrations:linear"]);
  });

  it("treats a pre-0.3.2 resume item as a direct fix", () => {
    expect(healthFixAction([problem({ fix: "resume" })], context([HUB]))?.kind).toBe("fix");
  });

  it("opens the sign-in for a provider or integration that needs the owner", () => {
    expect(
      healthFixAction(
        [problem({ fix: "sign-in", target: { _tag: "provider", instanceId: provider } })],
        context([HUB]),
      ),
    ).toEqual({
      kind: "open",
      label: "Fix",
      link: { kind: "provider", environmentId: HUB, instanceId: provider },
    });
  });

  it("starts an agent with the problem when there is no direct fix", () => {
    const failing = problem({
      itemKey: "integrations:linear",
      checkId: "integrations",
      title: "Linear isn't working",
      detail: "Its last connection failed.",
      fix: null,
      target: { _tag: "integration", name: "linear" },
    });
    const action = healthFixAction([failing], context([LAPTOP], { viaEnvironmentId: LAPTOP }));
    expect(action).toMatchObject({
      kind: "agent",
      label: "Fix",
      request: { environmentId: LAPTOP },
    });
    if (action?.kind !== "agent") return;
    expect(action.request.prompt).toBe(
      [
        `Machine health on "Cloud server" reports a problem with no one-click fix. Investigate and fix it.`,
        "",
        "- Linear isn't working. Its last connection failed. (check integrations, item integrations:linear, integration linear)",
        "",
        "Start with machine_health for environmentId hub, read over the peer link from this machine, and use machine_health_fix for anything that has a direct fix. Tell me what you found and what you changed.",
      ].join("\n"),
    );
  });
});

describe("machineHealthAgentPrompt", () => {
  it("names every problem of a group with the ids its tools take", () => {
    const prompt = machineHealthAgentPrompt(
      [
        problem({ fix: null }),
        problem({
          itemKey: "scheduled-tasks:nightly",
          checkId: "scheduled-tasks",
          title: `"Nightly" has been starting for 2 hours`,
          detail: "",
          fix: null,
          target: { _tag: "scheduledTask", taskId: task },
        }),
      ],
      { environmentId: HUB, name: "Cloud server", local: true },
    );
    expect(prompt).toContain("reports 2 problems with no one-click fix. Investigate and fix them.");
    expect(prompt).toContain(
      "(check stuck-runs, item stuck-runs:thread:thread-1, thread thread-1)",
    );
    expect(prompt).toContain(
      `- "Nightly" has been starting for 2 hours (check scheduled-tasks, item scheduled-tasks:nightly, scheduled task task-1)`,
    );
    expect(prompt).toContain("Start with machine_health for environmentId hub, and use");
  });
});

describe("healthItemActions", () => {
  it("offers Fix and the thing the item points at", () => {
    const actions = healthItemActions(problem(), context([HUB]));
    expect(actions.fix?.kind).toBe("fix");
    expect(actions.open).toEqual({
      kind: "open",
      label: "Open thread",
      link: { kind: "thread", environmentId: HUB, threadId: thread },
    });
  });

  it("does not repeat a link Fix already opens", () => {
    const signIn = problem({ fix: "sign-in", target: { _tag: "integration", name: "slack" } });
    expect(healthItemActions(signIn, context([HUB])).open).toBeNull();
  });

  it("opens Storage beside the agent Fix for a full disk", () => {
    const disk = problem({
      itemKey: "disk:free",
      checkId: "disk",
      fix: null,
      target: { _tag: "storage" },
    });
    const actions = healthItemActions(disk, context([HUB]));
    expect(actions.fix?.kind).toBe("agent");
    expect(actions.open).toEqual({
      kind: "open",
      label: "Open Storage",
      link: { kind: "storage", environmentId: HUB },
    });
  });
});

describe("machineHealthLink", () => {
  it("opens a machine's health on itself, or through the server that reported it", () => {
    expect(machineHealthLink(HUB, context([HUB], { viaEnvironmentId: LAPTOP }))).toEqual({
      kind: "machineHealth",
      viewedEnvironmentId: HUB,
      machineEnvironmentId: HUB,
    });
    expect(machineHealthLink(HUB, context([LAPTOP], { viaEnvironmentId: LAPTOP }))).toEqual({
      kind: "machineHealth",
      viewedEnvironmentId: LAPTOP,
      machineEnvironmentId: HUB,
    });
  });
});
