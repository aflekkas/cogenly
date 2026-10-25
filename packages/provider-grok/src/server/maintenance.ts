import { ProviderDriverKind, type ServerProvider } from "@cogenly/contracts";
import * as Effect from "effect/Effect";

import {
  enrichProviderSnapshotWithVersionAdvisory,
  makeManualOnlyProviderMaintenanceCapabilities,
  type ProviderMaintenanceCapabilities,
  type ProviderMaintenanceCapabilitiesResolver,
} from "@cogenly/provider-core/server/maintenanceResolver";
import { parseGenericCliVersion } from "@cogenly/provider-core/server/snapshotProbe";

const DRIVER = ProviderDriverKind.make("grok");

/** `grok --version` prints `grok 1.0.67 (2fe064390d07)`; the commit is dropped. */
export function parseGrokVersion(output: string): string | null {
  return parseGenericCliVersion(output);
}

/**
 * Grok Build installs through xAI's script and updates itself, so Cogenly
 * never runs a package manager for it.
 */
export const grokMaintenance: ProviderMaintenanceCapabilitiesResolver = {
  resolve: () =>
    Effect.succeed(
      makeManualOnlyProviderMaintenanceCapabilities({ provider: DRIVER, packageName: null }),
    ),
};

/** No published release feed, so the snapshot carries no update advisory. */
export const enrichGrokSnapshot = Effect.fn("enrichGrokSnapshot")(function* (input: {
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly enableProviderUpdateChecks: boolean;
}) {
  return yield* enrichProviderSnapshotWithVersionAdvisory(
    input.snapshot,
    { ...input.maintenanceCapabilities, latestVersion: null },
    { enableProviderUpdateChecks: input.enableProviderUpdateChecks },
  );
});
