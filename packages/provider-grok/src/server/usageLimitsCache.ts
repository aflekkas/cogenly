import {
  ServerProviderUsageLimits as ServerProviderUsageLimitsSchema,
  type ProviderInstanceId,
  type ServerProviderUsageLimits,
} from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

const CachedLimitsJson = Schema.fromJsonString(ServerProviderUsageLimitsSchema);
const decodeCachedLimits = Schema.decodeUnknownEffect(CachedLimitsJson);
const encodeCachedLimits = Schema.encodeEffect(CachedLimitsJson);

/** `<cacheDir>/grok-usage-limits/<instanceId>.json`: the last limits Grok reported. */
export const resolveGrokUsageLimitsCachePath = Effect.fn("resolveGrokUsageLimitsCachePath")(
  function* (input: { readonly cacheDir: string; readonly instanceId: ProviderInstanceId }) {
    const path = yield* Path.Path;
    return path.join(input.cacheDir, "grok-usage-limits", `${input.instanceId}.json`);
  },
);

/** The last observed limits, or undefined; a missing or corrupt cache reads as absent. */
export const readCachedGrokUsageLimits = Effect.fn("readCachedGrokUsageLimits")(function* (
  filePath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const raw = yield* fs.readFileString(filePath).pipe(Effect.orElseSucceed(() => ""));
  if (raw.trim().length === 0) return undefined;
  const decoded = yield* decodeCachedLimits(raw).pipe(Effect.orElseSucceed(() => undefined));
  if (decoded === undefined || decoded.windows.length === 0 || decoded.unavailable) {
    return undefined;
  }
  return decoded;
});

/** Persists an observation; an empty or unavailable one is never written. */
export const writeCachedGrokUsageLimits = Effect.fn("writeCachedGrokUsageLimits")(function* (
  filePath: string,
  limits: ServerProviderUsageLimits,
) {
  if (limits.windows.length === 0 || limits.unavailable) return;
  const encoded = yield* encodeCachedLimits(limits);
  yield* writeFileStringAtomically({ filePath, contents: `${encoded}\n` });
});
