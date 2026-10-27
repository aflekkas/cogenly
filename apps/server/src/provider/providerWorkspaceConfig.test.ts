import { expect, it } from "vite-plus/test";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@cogenly/contracts";
import { withoutWorkspaceSnapshots, workspaceRefreshProviders } from "./providerWorkspaceConfig.ts";

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
  workspaceSnapshots: ["/one", "/two"].map((cwd) => ({
    cwd,
    checkedAt: "2026-01-01T00:00:00.000Z",
    skills: [],
    slashCommands: [],
  })),
};
it("omits all cwd inventories from config and scopes a refresh to one provider and cwd", () => {
  const providers = [provider, { ...provider, instanceId: ProviderInstanceId.make("codex") }];
  expect(
    withoutWorkspaceSnapshots(providers).every((p) => p.workspaceSnapshots === undefined),
  ).toBe(true);
  expect(workspaceRefreshProviders(providers, {})).toEqual(withoutWorkspaceSnapshots(providers));
  const scoped = workspaceRefreshProviders(providers, {
    instanceId: provider.instanceId,
    cwd: "/one",
  });
  expect(scoped).toHaveLength(1);
  expect(scoped[0]?.workspaceSnapshots?.map((s) => s.cwd)).toEqual(["/one"]);
  expect(provider.workspaceSnapshots).toHaveLength(2);
});
