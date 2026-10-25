import { formatModelSlugName } from "@cogenly/shared/model";
import {
  ProviderDriverKind,
  type ProviderInstanceId,
  type ServerProvider,
} from "@cogenly/contracts";

import { getProviderInstanceEntry } from "../../providerInstances";
import { providerClients } from "../settings/providerDriverMeta";
import { getTriggerDisplayModelName } from "./providerIconUtils";

export interface HandoffEndpointDisplay {
  readonly label: string;
  readonly providerName: string;
  readonly driverKind: ProviderDriverKind;
  readonly accentColor: string | undefined;
}

/**
 * How a handoff row names one side: the model's display name and its
 * provider's glyph. A thread can outlive the instance that ran it (removed,
 * or another machine's account), so a missing instance borrows the driver of
 * any provider here that serves the same model, and the slug still reads as a
 * name ("claude-opus-5-5" as "Claude Opus 5.5").
 */
export function resolveHandoffEndpointDisplay(input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly instanceId: ProviderInstanceId;
  readonly model?: string | undefined;
}): HandoffEndpointDisplay {
  const entry = getProviderInstanceEntry(input.providers, input.instanceId);
  const model = input.model?.trim() || undefined;
  const servedBy =
    model === undefined
      ? undefined
      : entry !== undefined
        ? { driver: entry.driverKind, models: entry.models }
        : input.providers.find((provider) =>
            provider.models.some((candidate) => candidate.slug === model),
          );
  const providerModel = servedBy?.models.find((candidate) => candidate.slug === model);
  const driverKind =
    entry?.driverKind ?? servedBy?.driver ?? ProviderDriverKind.make(input.instanceId);
  const providerName =
    entry?.displayName ?? providerClients.get(driverKind)?.label ?? input.instanceId;
  const label =
    providerModel !== undefined
      ? getTriggerDisplayModelName(providerModel)
      : model !== undefined
        ? formatModelSlugName(model)
        : providerName;
  return { label, providerName, driverKind, accentColor: entry?.accentColor };
}
