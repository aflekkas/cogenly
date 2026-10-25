import {
  ServerProviderUsageLimits as ServerProviderUsageLimitsSchema,
  type ProviderInstanceId,
  type ServerProviderUsageLimits,
} from "@cogenly/contracts";
import { writeFileStringAtomically } from "@cogenly/shared/atomicWrite";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

const CachedLimitsJson = Schema.fromJsonString(ServerProviderUsageLimitsSchema);
const decodeCachedLimits = Schema.decodeUnknownEffect(CachedLimitsJson);
const encodeCachedLimits = Schema.encodeEffect(CachedLimitsJson);

/**
 * `<cacheDir>/muse-usage-limits/<instanceId>.json`: the last subscription
 * limits a live Muse session observed, beside the per-instance status
 * snapshots but never colliding with them.
 */
export const resolveMuseUsageLimitsCachePath = Effect.fn("resolveMuseUsageLimitsCachePath")(
  function* (input: { readonly cacheDir: string; readonly instanceId: ProviderInstanceId }) {
    const path = yield* Path.Path;
    return path.join(input.cacheDir, "muse-usage-limits", `${input.instanceId}.json`);
  },
);

/**
 * The last limits a live session reported via `usage/changed`, or undefined
 * when Muse has never reported any. A missing, corrupt, or unavailable
 * snapshot is not an observation, so it reads as absent.
 */
export const readCachedMuseUsageLimits = Effect.fn("readCachedMuseUsageLimits")(function* (
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

/**
 * Persist limits from a live observation. An unavailable or windowless
 * snapshot is never written, so the cache cannot pin the empty banner.
 */
export const writeCachedMuseUsageLimits = Effect.fn("writeCachedMuseUsageLimits")(function* (
  filePath: string,
  limits: ServerProviderUsageLimits,
) {
  if (limits.windows.length === 0 || limits.unavailable) return;
  const encoded = yield* encodeCachedLimits(limits);
  yield* writeFileStringAtomically({ filePath, contents: `${encoded}\n` });
});
