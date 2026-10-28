import { expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { MachineResourcesSnapshot } from "./resourceTelemetry.ts";
import { ThreadMachineCatalog } from "./threadReplication.ts";

const isResources = Schema.is(MachineResourcesSnapshot);

it("accepts old peer catalogs and preserves optional resource and transfer hints", () => {
  const decode = Schema.decodeUnknownSync(ThreadMachineCatalog.success);
  expect(decode({ providers: [] })).toEqual({ providers: [] });
  const resources = {
    sampledAt: 42,
    cpuCores: 12,
    loadAverage1m: 2,
    loadAverage5m: 1,
    availableMemoryBytes: 1024,
    totalMemoryBytes: 4096,
    freeDiskBytes: 9000,
    activeAgentRuns: 20,
    activeAgentTerminals: 3,
  };
  expect(decode({ providers: [], resources, repositoryTransfer: "remote-delta-v1" })).toEqual({
    providers: [],
    resources,
    repositoryTransfer: "remote-delta-v1",
  });
  expect(isResources({ ...resources, activeAgentRuns: -1 })).toBe(false);
  const {
    freeDiskBytes: _disk,
    activeAgentRuns: _runs,
    activeAgentTerminals: _terminals,
    ...partial
  } = resources;
  expect(isResources(partial)).toBe(true);
});
