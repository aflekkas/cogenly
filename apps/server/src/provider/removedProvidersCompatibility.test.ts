import { describe, expect, it } from "@effect/vitest";
import {
  ModelSelection,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSession,
  ScheduledTask,
  ServerSettings,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { BUILT_IN_DRIVERS } from "./builtInDrivers.ts";
import { deriveProviderInstanceConfigMap } from "./ProviderInstanceRegistryHydration.ts";
import { makeProviderInstanceRegistry } from "./ProviderInstanceRegistry.ts";

const removedDrivers = [
  "cursor",
  "grok",
  "opencode",
  "antigravity",
  "muse",
  "pi",
  "acp",
  "acpRegistry",
] as const;
const now = "2026-10-16T12:00:00.000Z";
const decodeSettings = Schema.decodeUnknownSync(ServerSettings);
const decodeSession = Schema.decodeUnknownSync(ProviderSession);
const decodeTask = Schema.decodeUnknownSync(ScheduledTask);
const decodeSelection = Schema.decodeUnknownSync(ModelSelection);

describe("retired provider history", () => {
  it("only creates implicit Claude and Codex instances", () => {
    expect(BUILT_IN_DRIVERS.map((driver) => driver.driverKind)).toEqual(["codex", "claudeAgent"]);
    expect(Object.keys(deriveProviderInstanceConfigMap(decodeSettings({})))).toEqual([
      "codex",
      "claudeAgent",
    ]);
  });

  it.each(removedDrivers)("loads stored %s sessions, settings and scheduled tasks", (driver) => {
    const instanceId = `${driver}_work`;
    expect(decodeSelection({ provider: driver, model: "old-model" }).instanceId).toBe(driver);
    const settings = decodeSettings({
      providerInstances: { [instanceId]: { driver, config: { binaryPath: "old-command" } } },
      defaultModelSelection: { instanceId, model: "old-model" },
    });
    expect(settings.providerInstances[ProviderInstanceId.make(instanceId)]?.driver).toBe(driver);
    expect(
      decodeSession({
        provider: driver,
        providerInstanceId: instanceId,
        threadId: "old-thread",
        status: "closed",
        runtimeMode: "full-access",
        createdAt: now,
        updatedAt: now,
      }).provider,
    ).toBe(driver);
    expect(
      decodeTask({
        id: "old-task",
        title: "Old task",
        prompt: "Continue",
        enabled: true,
        schedule: { type: "interval", everyMs: 60_000 },
        projectId: "project",
        threadId: null,
        workspaceStrategy: { type: "root" },
        modelSelection: { instanceId, model: "old-model" },
        runtimeMode: "full-access",
        interactionMode: "default",
        createdBy: "user",
        creationSource: "web",
        createdAt: now,
        updatedAt: now,
        nextRunAt: null,
        lastRunAt: null,
        lastRunStatus: "never",
        lastRunError: null,
        runCount: 0,
      }).modelSelection.instanceId,
    ).toBe(instanceId);
  });

  it.effect("keeps retired instances unavailable without starting a provider", () =>
    Effect.gen(function* () {
      const configMap = Object.fromEntries(
        removedDrivers.map((driver) => [
          ProviderInstanceId.make(`${driver}_work`),
          {
            driver: ProviderDriverKind.make(driver),
            enabled: true,
            config: { arbitrary: "preserved" },
          },
        ]),
      );
      const { registry } = yield* makeProviderInstanceRegistry<never>({ drivers: [], configMap });
      expect(yield* registry.listInstances).toEqual([]);
      const unavailable = yield* registry.listUnavailable;
      expect(unavailable).toHaveLength(removedDrivers.length);
      expect(
        unavailable.every(
          (instance) => instance.availability === "unavailable" && !instance.supportsTextGeneration,
        ),
      ).toBe(true);
      expect(yield* registry.getInstance(ProviderInstanceId.make("opencode_work"))).toBeUndefined();
    }),
  );
});
