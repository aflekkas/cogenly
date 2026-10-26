import type { ModelSelection } from "./modelSelection.ts";
import type { ProviderInstanceRef } from "./providerInstance.ts";

/** Preserve stored order and indices while allowing only one account per provider. */
export function agentFallbackEntries(
  chain: ReadonlyArray<ModelSelection>,
  providers: ReadonlyArray<ProviderInstanceRef>,
) {
  const seenDrivers = new Set<string>();
  const seenInstances = new Set<string>();
  return chain.map((selection, index) => {
    const driver = providers.find(
      (provider) => provider.instanceId === selection.instanceId,
    )?.driver;
    // A partial catalog cannot prove that different instances share an account.
    // Keep stored order in that case, while still deduplicating the same instance.
    const skipReason =
      seenInstances.has(selection.instanceId) || (driver !== undefined && seenDrivers.has(driver))
        ? "same provider account"
        : null;
    seenInstances.add(selection.instanceId);
    if (driver !== undefined) seenDrivers.add(driver);
    return { index, selection, skipReason };
  });
}
