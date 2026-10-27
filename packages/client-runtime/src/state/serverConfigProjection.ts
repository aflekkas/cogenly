import type { ServerConfig, ServerConfigStreamEvent } from "@cogenly/contracts";
import * as Option from "effect/Option";

export interface ServerConfigProjection {
  readonly config: ServerConfig;
  readonly latestEvent: ServerConfigStreamEvent;
  readonly source: "cache" | "live";
}

/**
 * Returns `next` with every part deep-equal to `previous` replaced by the
 * previous object. A provider status push re-sends every provider even when
 * only `checkedAt` changed, and a reconnect snapshot re-sends the whole config,
 * so this keeps unchanged providers, models and skills identical and lets
 * memoized UI skip them. Only plain objects and arrays are compared.
 */
export function reuseUnchanged<T>(previous: unknown, next: T): T {
  if (Object.is(previous, next)) return next;
  if (
    typeof previous !== "object" ||
    typeof next !== "object" ||
    previous === null ||
    next === null ||
    Array.isArray(previous) !== Array.isArray(next)
  ) {
    return next;
  }
  if (Array.isArray(next)) {
    const before = previous as ReadonlyArray<unknown>;
    let same = before.length === next.length;
    const merged = next.map((item, index) => {
      const reused = reuseUnchanged(before[index], item);
      if (reused !== before[index]) same = false;
      return reused;
    });
    return (same ? previous : merged) as T;
  }
  if (
    Object.getPrototypeOf(next) !== Object.prototype ||
    Object.getPrototypeOf(previous) !== Object.prototype
  ) {
    return next;
  }
  const before = previous as Record<string, unknown>;
  const after = next as Record<string, unknown>;
  const keys = Object.keys(after);
  let same = keys.length === Object.keys(before).length;
  const merged: Record<string, unknown> = {};
  for (const key of keys) {
    const reused = reuseUnchanged(before[key], after[key]);
    if (reused !== before[key] || !(key in before)) same = false;
    merged[key] = reused;
  }
  return (same ? previous : merged) as T;
}

export function applyServerConfigProjection(
  current: Option.Option<ServerConfigProjection>,
  event: ServerConfigStreamEvent,
): Option.Option<ServerConfigProjection> {
  switch (event.type) {
    case "snapshot": {
      return Option.some({
        config: Option.isSome(current)
          ? reuseUnchanged(current.value.config, event.config)
          : event.config,
        latestEvent: event,
        source: "live" as const,
      });
    }
    case "keybindingsUpdated":
      return Option.map(current, (projection) => ({
        config: {
          ...projection.config,
          keybindings: reuseUnchanged(projection.config.keybindings, event.payload.keybindings),
          issues: reuseUnchanged(projection.config.issues, event.payload.issues),
        },
        latestEvent: event,
        source: "live",
      }));
    case "providerStatuses":
      return Option.map(current, (projection) => ({
        config: {
          ...projection.config,
          providers: reuseUnchanged(projection.config.providers, event.payload.providers),
        },
        latestEvent: event,
        source: "live",
      }));
    case "settingsUpdated":
      return Option.map(current, (projection) => ({
        config: {
          ...projection.config,
          settings: reuseUnchanged(projection.config.settings, event.payload.settings),
        },
        latestEvent: event,
        source: "live",
      }));
  }
}
