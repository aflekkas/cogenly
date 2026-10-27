import type { ProviderInstanceId, ServerProvider } from "@cogenly/contracts";

export function withoutWorkspaceSnapshots(
  providers: ReadonlyArray<ServerProvider>,
): ServerProvider[] {
  return providers.map(({ workspaceSnapshots: _workspaceSnapshots, ...provider }) => provider);
}

export function workspaceRefreshProviders(
  providers: ReadonlyArray<ServerProvider>,
  input: {
    readonly instanceId?: ProviderInstanceId | undefined;
    readonly cwd?: string | undefined;
  },
): ServerProvider[] {
  const { instanceId, cwd } = input;
  if (instanceId === undefined || cwd === undefined) return withoutWorkspaceSnapshots(providers);
  return providers
    .filter((provider) => provider.instanceId === instanceId)
    .map((provider) => ({
      ...provider,
      models: [],
      slashCommands: [],
      skills: [],
      workspaceSnapshots: (provider.workspaceSnapshots ?? []).filter(
        (snapshot) => snapshot.cwd === cwd,
      ),
    }));
}
