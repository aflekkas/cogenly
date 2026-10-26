import type { ModelSelection } from "./modelSelection.ts";
import type { ProviderInstanceRef } from "./providerInstance.ts";

/** Preserve stored order and indices while allowing only one account per provider. */
export function agentFallbackEntries(
  chain: ReadonlyArray<ModelSelection>,
  providers: ReadonlyArray<ProviderInstanceRef>,
) {
  const primaryDriver = providers.find(
    (provider) => provider.instanceId === chain[0]?.instanceId,
  )?.driver;
  const seen = new Set<string>();
  return chain.map((selection, index) => {
    const driver = providers.find(
      (provider) => provider.instanceId === selection.instanceId,
    )?.driver;
    const skipReason =
      primaryDriver === undefined || driver === undefined
        ? "provider unavailable"
        : seen.has(driver)
          ? "same provider account"
          : null;
    if (driver !== undefined) seen.add(driver);
    return { index, selection, skipReason };
  });
}
