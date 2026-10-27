import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerConfig,
  type ServerProvider,
} from "@cogenly/contracts";
import {
  recordFetchedWorkspaceSnapshot,
  withFetchedWorkspaceSnapshots,
} from "./providerWorkspaceSnapshots.ts";

const provider: ServerProvider = {
  instanceId: ProviderInstanceId.make("claude"),
  driver: ProviderDriverKind.make("claude"),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-01-01T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
};
const config = (providers = [provider], onDemand = true): ServerConfig => ({
  providers,
  environment: {
    environmentId: EnvironmentId.make("test"),
    label: "Test",
    platform: { os: "darwin", arch: "arm64" },
    serverVersion: "0.0.0",
    capabilities: { repositoryIdentity: true, providerWorkspaceSnapshotsOnDemand: onDemand },
  },
  auth: {
    policy: "unsafe-no-auth",
    bootstrapMethods: [],
    sessionMethods: [],
    sessionCookieName: "test",
  },
  cwd: "/repo",
  keybindingsConfigPath: "/keybindings.json",
  keybindings: [],
  issues: [],
  observability: {
    logsDirectoryPath: "/logs",
    localTracingEnabled: false,
    otlpTracesEnabled: false,
    otlpMetricsEnabled: false,
    otlpLogsEnabled: false,
  },
  settings: DEFAULT_SERVER_SETTINGS,
});
const response = (cwd: string) => [
  {
    ...provider,
    workspaceSnapshots: [{ cwd, checkedAt: provider.checkedAt, skills: [], slashCommands: [] }],
  },
];

describe("fetched provider workspaces", () => {
  it("merges only requested workspaces, reuses cached answers and evicts at 32", () => {
    const first = recordFetchedWorkspaceSnapshot(
      [],
      { instanceId: provider.instanceId, cwd: "/one", fresh: false },
      response("/one"),
      provider,
    );
    expect(
      withFetchedWorkspaceSnapshots(config(), first).providers[0]?.workspaceSnapshots?.map(
        (s) => s.cwd,
      ),
    ).toEqual(["/one"]);
    expect(
      recordFetchedWorkspaceSnapshot(
        first,
        { instanceId: provider.instanceId, cwd: "/one", fresh: false },
        response("/one"),
        provider,
      ),
    ).toBe(first);
    let cache = first;
    for (let i = 0; i < 33; i++)
      cache = recordFetchedWorkspaceSnapshot(
        cache,
        { instanceId: provider.instanceId, cwd: `/${i}`, fresh: false },
        response(`/${i}`),
        provider,
      );
    expect(cache).toHaveLength(32);
    expect(cache[0]?.snapshot.cwd).toBe("/1");
  });
  it("invalidates on sign-out, disabled providers and changed catalogs, while old servers remain authoritative", () => {
    const cache = recordFetchedWorkspaceSnapshot(
      [],
      { instanceId: provider.instanceId, cwd: "/one", fresh: false },
      response("/one"),
      provider,
    );
    for (const changed of [
      { ...provider, enabled: false },
      { ...provider, auth: { status: "unauthenticated" as const } },
      { ...provider, slashCommands: [{ name: "new", description: "new", argumentHint: null }] },
    ]) {
      expect(
        withFetchedWorkspaceSnapshots(config([changed]), cache).providers[0]?.workspaceSnapshots,
      ).toBeUndefined();
    }
    const old = config(response("/server"), false);
    expect(withFetchedWorkspaceSnapshots(old, cache)).toBe(old);
    expect(withFetchedWorkspaceSnapshots(config([]), cache).providers).toEqual([]);
  });
  it("fresh scans clear other providers' snapshots for the same cwd", () => {
    const other = { ...provider, instanceId: ProviderInstanceId.make("codex") };
    const first = recordFetchedWorkspaceSnapshot(
      [],
      { instanceId: other.instanceId, cwd: "/one", fresh: false },
      [{ ...response("/one")[0]!, instanceId: other.instanceId }],
      other,
    );
    const fresh = recordFetchedWorkspaceSnapshot(
      first,
      { instanceId: provider.instanceId, cwd: "/one", fresh: true },
      response("/one"),
      provider,
    );
    expect(fresh.map((entry) => entry.instanceId)).toEqual([provider.instanceId]);
    expect(
      recordFetchedWorkspaceSnapshot(
        fresh,
        { instanceId: provider.instanceId, cwd: "/one", fresh: true },
        [],
        provider,
      ),
    ).toEqual([]);
  });
});
