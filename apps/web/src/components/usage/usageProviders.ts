import type { ProviderDriverKind, UsageProviderKind } from "@cogenly/contracts";
import { usagePresentationForKind } from "@cogenly/provider-core/client";

import { providerClients } from "../settings/providerDriverMeta";

export type UsageProviderPresentation = {
  readonly label: string;
  readonly color: string;
  readonly driverKind: ProviderDriverKind | undefined;
};

/**
 * Presentation for a usage-bucket slug, from the provider registry.
 * Registered drivers supply their label and bar colour; retired or fork
 * slugs (`grok`, `cursor`, …) get a neutral row so old buckets still render.
 */
export function getUsageProviderPresentation(kind: UsageProviderKind): UsageProviderPresentation {
  return usagePresentationForKind(providerClients, kind);
}
