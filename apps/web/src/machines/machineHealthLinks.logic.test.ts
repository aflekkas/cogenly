import type {
  EnvironmentId,
  ProviderInstanceId,
  ScheduledTaskId,
  ThreadId,
} from "@cogenly/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  healthAlertActions,
  healthFixAction,
  healthItemActions,
  machineHealthLink,
  type MachineHealthActionContext,
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
    viaEnvironmentId: HUB,
    isConnected: (id) => ids.has(id),
    ...overrides,
  };
}

describe("healthFixAction", () => {
  it("opens Storage on the machine whose disk is full", () => {
    expect(healthItemActions({ fix: null, target: { _tag: "storage" } }, context([HUB]))).toEqual({
      fix: null,
      open: { kind: "open", label: "Open Storage", link: { kind: "storage", environmentId: HUB } },
    });
  });
  it("signs in on the origin machine's provider or integration screen", () => {
    expect(
      healthFixAction("sign-in", { _tag: "provider", instanceId: provider }, context([HUB])),
    ).toEqual({
      kind: "open",
      label: "Sign in",
      link: { kind: "provider", environmentId: HUB, instanceId: provider },
    });
    expect(
      healthFixAction("sign-in", { _tag: "integration", name: "slack" }, context([HUB])),
    ).toEqual({
      kind: "open",
      label: "Sign in",
      link: { kind: "integrations", environmentId: HUB },
    });
  });

  it("runs a task only where this client can reach its machine", () => {
    const target = { _tag: "scheduledTask", taskId: task } as const;
    expect(healthFixAction("run-now", target, context([HUB]))).toEqual({
      kind: "runTask",
      label: "Run now",
      environmentId: HUB,
      taskId: task,
    });
    expect(
      healthFixAction("run-now", target, context([LAPTOP], { viaEnvironmentId: LAPTOP })),
    ).toBeNull();
  });

  it("resumes by opening the thread on its machine", () => {
    expect(healthFixAction("resume", { _tag: "thread", threadId: thread }, context([]))).toEqual({
      kind: "open",
      label: "Open thread",
      link: { kind: "thread", environmentId: HUB, threadId: thread },
    });
  });

  it("retries sync from whichever side of the pair this client reaches", () => {
    const target = { _tag: "machine", environmentId: LAPTOP } as const;
    expect(healthFixAction("retry-sync", target, context([HUB, LAPTOP]))).toMatchObject({
      kind: "retrySync",
      environmentId: HUB,
      peerEnvironmentId: LAPTOP,
    });
    expect(healthFixAction("retry-sync", target, context([LAPTOP]))).toMatchObject({
      kind: "retrySync",
      environmentId: LAPTOP,
      peerEnvironmentId: HUB,
    });
    expect(healthFixAction("retry-sync", target, context([OTHER]))).toBeNull();
  });

  it("retries sync with the server the item came through when the target names no peer", () => {
    expect(
      healthFixAction("retry-sync", null, context([LAPTOP], { viaEnvironmentId: LAPTOP })),
    ).toMatchObject({ kind: "retrySync", environmentId: LAPTOP, peerEnvironmentId: HUB });
    expect(healthFixAction("retry-sync", null, context([HUB]))).toBeNull();
  });
});

describe("healthItemActions", () => {
  it("does not repeat a target link the fix already opens", () => {
    const item = { fix: "resume", target: { _tag: "thread", threadId: thread } } as const;
    expect(healthItemActions(item, context([HUB])).open).toBeNull();
  });

  it("offers the target beside a command fix", () => {
    const item = { fix: "run-now", target: { _tag: "scheduledTask", taskId: task } } as const;
    const actions = healthItemActions(item, context([HUB]));
    expect(actions.fix?.kind).toBe("runTask");
    expect(actions.open).toMatchObject({ kind: "open", label: "Open task" });
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

describe("healthAlertActions", () => {
  const base = { viaEnvironmentId: HUB, isConnected: (id: EnvironmentId) => id === HUB };

  it("leads with the fix and keeps View health beside it", () => {
    const { primary, secondary } = healthAlertActions(
      { originEnvironmentId: HUB, fix: "run-now", target: { _tag: "scheduledTask", taskId: task } },
      base,
      () => true,
    );
    expect(primary.kind).toBe("runTask");
    expect(secondary).toMatchObject({ kind: "open", label: "View health" });
  });

  it("falls back to the target when this connection may not run the fix", () => {
    const { primary } = healthAlertActions(
      { originEnvironmentId: HUB, fix: "run-now", target: { _tag: "scheduledTask", taskId: task } },
      base,
      (action) => action.kind === "open",
    );
    expect(primary).toMatchObject({ kind: "open", label: "Open task" });
  });

  it("shows View health alone when the alert has nothing else to open", () => {
    expect(
      healthAlertActions({ originEnvironmentId: HUB, fix: null, target: null }, base, () => true),
    ).toEqual({
      primary: {
        kind: "open",
        label: "View health",
        link: { kind: "machineHealth", viewedEnvironmentId: HUB, machineEnvironmentId: HUB },
      },
      secondary: null,
    });
  });
});

it("sandbox fixes target only the connected origin machine", () => {
  const origin = env("sandbox-host");
  const via = env("viewer");
  expect(
    healthFixAction("setup-sandbox", null, {
      originEnvironmentId: origin,
      viaEnvironmentId: via,
      isConnected: (id) => id === origin,
    }),
  ).toEqual({ kind: "setupSandbox", label: "Fix", environmentId: origin });
  expect(
    healthFixAction("setup-sandbox", null, {
      originEnvironmentId: origin,
      viaEnvironmentId: via,
      isConnected: (id) => id === via,
    }),
  ).toBeNull();
});
