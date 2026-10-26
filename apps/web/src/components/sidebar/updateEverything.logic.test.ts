import { EnvironmentId } from "@cogenly/contracts";
import { expect, it } from "vite-plus/test";
import { runUpdateEverything, updateServersInOrder } from "./updateEverything.logic";

it("finishes providers, each spoke, then hub, before the local install", async () => {
  const calls: string[] = [];
  const hub = EnvironmentId.make("hub");
  const spoke = EnvironmentId.make("spoke");
  const versions = new Map([
    [hub, "0.3.2"],
    [spoke, "0.3.2"],
  ]);
  const spokeStarted = Promise.withResolvers<void>();
  const spokeFinished = Promise.withResolvers<void>();
  const run = runUpdateEverything({
    updateProviders: async () => {
      calls.push("providers");
    },
    updateServers: () =>
      updateServersInOrder({
        servers: [hub, spoke].map((environmentId) => ({
          environmentId,
          serverLabel: environmentId,
          targetVersion: "0.3.3",
          selfUpdate: "boot-service",
        })),
        hubEnvironmentIds: new Set([hub]),
        update: async (server) => {
          calls.push(server.environmentId);
          if (server.environmentId === spoke) {
            spokeStarted.resolve();
            await spokeFinished.promise;
          }
          versions.set(server.environmentId, "0.3.3");
          return { status: "updated" };
        },
        readVersion: (id) => {
          calls.push(`verify:${id}`);
          return versions.get(id) ?? null;
        },
      }),
  });
  await spokeStarted.promise;
  expect(calls).toEqual(["providers", "spoke"]);
  spokeFinished.resolve();
  const result = await run;
  calls.push("local install");
  expect(calls).toEqual([
    "providers",
    "spoke",
    "hub",
    "verify:spoke",
    "verify:hub",
    "local install",
  ]);
  expect(result.servers.every((entry) => entry.outcome.status === "updated")).toBe(true);
});

it("reports a machine that rolled back or installed another version", async () => {
  const environmentId = EnvironmentId.make("spoke");
  const result = await updateServersInOrder({
    servers: [
      {
        environmentId,
        serverLabel: "MacBook",
        targetVersion: "0.3.3",
        selfUpdate: "desktop-managed",
      },
    ],
    hubEnvironmentIds: new Set(),
    update: async () => ({ status: "updated" }),
    readVersion: () => "0.3.2",
  });
  expect(result[0]?.outcome).toEqual({
    status: "failed",
    message: "MacBook is on 0.3.2; expected 0.3.3.",
  });
});
