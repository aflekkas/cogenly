import * as Arr from "effect/Array";
import * as Order from "effect/Order";

export interface ModelSlugItem {
  readonly slug: string;
}

function rankByValue(values: ReadonlyArray<string>): ReadonlyMap<string, number> {
  return new Map(Arr.map(values, (value, index) => [value, index] as const));
}

function byOptionalRank<T>(rank: (item: T) => number | undefined): Order.Order<T> {
  return Order.mapInput(Order.Number, (item: T) => rank(item) ?? Number.POSITIVE_INFINITY);
}

/** Sort models by the user's saved `modelOrder`; unlisted models keep their reported order after it. */
export function sortModelsForProviderInstance<T extends ModelSlugItem>(
  models: ReadonlyArray<T>,
  options?: { readonly modelOrder?: ReadonlyArray<string> },
): T[] {
  const orderBySlug = rankByValue(options?.modelOrder ?? []);
  const originalOrder = rankByValue(Arr.map(models, (model) => model.slug));
  return Arr.sort(
    models,
    Order.combineAll([
      byOptionalRank<T>((model) => orderBySlug.get(model.slug)),
      byOptionalRank<T>((model) => originalOrder.get(model.slug)),
    ]),
  );
}
