import {
  EnvironmentId,
  ProjectId,
  ProjectLabelId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProjectLabelRepositoryLink,
} from "@cogenly/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ProviderInstanceEntry } from "../providerInstances";
import { modelOnMachine, planMachineSwitch } from "./machineSwitch.logic";

const mac = EnvironmentId.make("env:mac");
const vps = EnvironmentId.make("env:vps");
const spawn = ProjectLabelId.make("label:spawn-partners");
const remote = "github.com/spawn-partners/platform";
const macPlatform = ProjectId.make("mac-platform");
const vpsPlatform = ProjectId.make("vps-platform");

const link = (
  repositoryId: string,
  checkout?: ProjectLabelRepositoryLink["checkout"],
): ProjectLabelRepositoryLink => ({
  repositoryId: ProjectId.make(repositoryId),
  remote,
  directoryName: "platform",
  ...(checkout === undefined ? {} : { checkout }),
});

describe("planMachineSwitch", () => {
  const onMac = { repository: { id: macPlatform, remote }, projectId: spawn };

  it("keeps the project and repository when the target holds it in the project", () => {
    expect(
      planMachineSwitch(onMac, {
        environmentId: vps,
        recordId: vpsPlatform,
        project: { repositories: [link(vpsPlatform, "ready")] },
        canLaunchThere: true,
      }),
    ).toEqual({ kind: "move", repositoryId: vpsPlatform, keepProject: true });
  });

  it("keeps the draft and runs it there when the project links it but the target has not cloned it", () => {
    // The owner's case: Spawn Partners links platform; Contabo has only the placeholder.
    const target = {
      environmentId: vps,
      recordId: null,
      project: { repositories: [link(`remote:${remote}`, "not_cloned")] },
      canLaunchThere: true,
    };
    expect(planMachineSwitch(onMac, target)).toEqual({ kind: "launch-there" });
    // A checkout there outside the project is filed into it on send, not swapped in now.
    expect(planMachineSwitch(onMac, { ...target, recordId: vpsPlatform })).toEqual({
      kind: "launch-there",
    });
  });

  it("matches the repository by remote, whatever its letter case", () => {
    const upper = {
      repository: { id: macPlatform, remote: remote.toUpperCase() },
      projectId: spawn,
    };
    expect(
      planMachineSwitch(upper, {
        environmentId: vps,
        recordId: null,
        project: { repositories: [link(vpsPlatform)] },
        canLaunchThere: false,
      }),
    ).toEqual({ kind: "move", repositoryId: vpsPlatform, keepProject: true });
  });

  it("falls back to the target's checkout when it cannot run there", () => {
    expect(
      planMachineSwitch(onMac, {
        environmentId: vps,
        recordId: vpsPlatform,
        project: null,
        canLaunchThere: false,
      }),
    ).toEqual({ kind: "move", repositoryId: vpsPlatform, keepProject: false });
  });

  it("moves Work without a repository to the target's home, keeping a project it has", () => {
    const folderOnly = { repository: null, projectId: spawn };
    expect(
      planMachineSwitch(folderOnly, {
        environmentId: vps,
        recordId: null,
        project: { repositories: [] },
        canLaunchThere: true,
      }),
    ).toEqual({ kind: "move", repositoryId: null, keepProject: true });
    expect(
      planMachineSwitch(folderOnly, {
        environmentId: vps,
        recordId: null,
        project: null,
        canLaunchThere: true,
      }),
    ).toEqual({ kind: "move", repositoryId: null, keepProject: false });
  });

  it("switching back lands on the original repository in the same project", () => {
    const onVps = { repository: { id: vpsPlatform, remote }, projectId: spawn };
    expect(
      planMachineSwitch(onVps, {
        environmentId: mac,
        recordId: macPlatform,
        project: { repositories: [link(macPlatform)] },
        canLaunchThere: true,
      }),
    ).toEqual({ kind: "move", repositoryId: macPlatform, keepProject: true });
  });
});

const entry = (
  instanceId: string,
  driver: string,
  models: ReadonlyArray<string>,
  overrides: Partial<ProviderInstanceEntry> = {},
): ProviderInstanceEntry =>
  ({
    instanceId: ProviderInstanceId.make(instanceId),
    driverKind: ProviderDriverKind.make(driver),
    displayName: instanceId,
    sharesDriver: false,
    enabled: true,
    installed: true,
    status: "ready",
    isDefault: instanceId === driver,
    isAvailable: true,
    snapshot: {} as never,
    models: models.map((slug, index) => ({
      slug,
      name: slug,
      isCustom: false,
      isDefault: index === 0,
    })),
    ...overrides,
  }) as ProviderInstanceEntry;

describe("modelOnMachine", () => {
  const work = entry("claude-work", "claude", ["opus", "sonnet"]);
  const selection = {
    instanceId: ProviderInstanceId.make("claude-work"),
    model: "sonnet",
    options: [{ id: "effort", value: "high" }],
  } as never;

  it("changes nothing when the target has the same instance", () => {
    expect(modelOnMachine({ selection, here: [work], there: [work], machineName: "VPS" })).toBe(
      null,
    );
  });

  it("stands in the same kind of provider on the same model, keeping its options", () => {
    const result = modelOnMachine({
      selection,
      here: [work],
      there: [entry("codex", "codex", ["gpt"]), entry("claude", "claude", ["opus", "sonnet"])],
      machineName: "Contabo VPS",
    });
    expect(result?.selection).toEqual({
      instanceId: "claude",
      model: "sonnet",
      options: [{ id: "effort", value: "high" }],
    });
    expect(result?.note).toBe("claude-work isn't on Contabo VPS; using claude.");
  });

  it("uses the stand-in's default model when it lacks the model", () => {
    const result = modelOnMachine({
      selection,
      here: [work],
      there: [entry("claude", "claude", ["opus"])],
      machineName: "Contabo VPS",
    });
    expect(result?.selection).toEqual({ instanceId: "claude", model: "opus" });
  });

  it("leaves it to the composer when no provider of that kind is there", () => {
    expect(
      modelOnMachine({
        selection,
        here: [work],
        there: [entry("codex", "codex", ["gpt"])],
        machineName: "VPS",
      }),
    ).toBe(null);
  });
});
