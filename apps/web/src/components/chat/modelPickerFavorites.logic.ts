import type { ProviderInstanceId } from "@cogenly/contracts";

import { modelPickerModelKey } from "./modelPickerKeys";

/**
 * Starred models in the picker's Favorites list: grouped by the provider
 * rail's order (`instanceOrder`, the same instance entries the rail renders),
 * then by each provider's own model list order. When a model was starred
 * plays no part, so reordering providers reorders Favorites and its ⌘N keys.
 */
export function orderModelPickerFavorites<
  Model extends { readonly instanceId: ProviderInstanceId; readonly slug: string },
>(input: {
  /** Every offered model, each provider's models in that provider's own order. */
  readonly models: ReadonlyArray<Model>;
  readonly favoriteKeys: ReadonlySet<string>;
  readonly instanceOrder: ReadonlyArray<{ readonly instanceId: ProviderInstanceId }>;
}): Model[] {
  const rank = new Map(input.instanceOrder.map((entry, index) => [entry.instanceId, index]));
  const favorites = input.models
    .map((model, index) => ({ model, index }))
    .filter(({ model }) =>
      input.favoriteKeys.has(modelPickerModelKey(model.instanceId, model.slug)),
    );
  // Providers missing from the rail go last; the stable index keeps catalog order.
  favorites.sort(
    (a, b) =>
      (rank.get(a.model.instanceId) ?? Number.MAX_SAFE_INTEGER) -
        (rank.get(b.model.instanceId) ?? Number.MAX_SAFE_INTEGER) || a.index - b.index,
  );
  return favorites.map(({ model }) => model);
}
