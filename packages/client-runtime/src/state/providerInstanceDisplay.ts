/**
 * How a configured provider instance presents itself in a client: its label,
 * its accent color, and whether its icon carries the account badge. Shared by
 * web and mobile so both clients name and badge the same instance identically.
 *
 * @module providerInstanceDisplay
 */
import {
  defaultInstanceIdForDriver,
  PROVIDER_DISPLAY_NAMES,
  type ProviderDriverKind,
  type ServerProvider,
} from "@cogenly/contracts";

/**
 * Title-case a slug: splits on `_` / `-` and camelCase boundaries, so
 * `codex_personal` becomes "Codex Personal" and `myCustomInstance` becomes
 * "My Custom Instance".
 */
function humanizeSlug(slug: string): string {
  return slug
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

/**
 * Resolve an instance's label with a tiered priority:
 *
 *   1. A snapshot `displayName` that differs from the driver's brand label —
 *      the server has explicitly named this instance, trust it.
 *   2. For non-default instances, a humanized `instanceId` — the server fell
 *      back to the driver-level label (the same for every instance of that
 *      kind), so the slug is what keeps "Codex" and "Codex Personal" apart.
 *   3. The snapshot's `displayName`, or the brand label from contracts.
 */
export function resolveProviderInstanceDisplayName(
  snapshot: Pick<ServerProvider, "instanceId" | "driver" | "displayName">,
): string {
  const trimmedSnapshotName = snapshot.displayName?.trim();
  const kindLabel = PROVIDER_DISPLAY_NAMES[snapshot.driver] ?? humanizeSlug(snapshot.driver);
  if (trimmedSnapshotName && trimmedSnapshotName !== kindLabel) return trimmedSnapshotName;
  if (snapshot.instanceId !== defaultInstanceIdForDriver(snapshot.driver)) {
    const humanized = humanizeSlug(snapshot.instanceId);
    if (humanized.length > 0) return humanized;
  }
  return trimmedSnapshotName || kindLabel;
}

/**
 * Turn a display name into up to two initials for the badge: the first two
 * characters of a single word, or the first character of each of the first
 * two words. Iterates by code point so an emoji never splits into surrogates.
 */
export function providerInstanceInitials(label: string): string {
  const words = label.replace(/[_-]+/g, " ").split(/\s+/u).filter(Boolean);
  if (words.length === 0) return "";
  if (words.length === 1) return Array.from(words[0]!).slice(0, 2).join("").toUpperCase();
  return words
    .slice(0, 2)
    .map((word) => Array.from(word)[0]?.toUpperCase() ?? "")
    .join("");
}

/** Only `#rrggbb` accent colors render; anything else is treated as unset. */
export function normalizeProviderAccentColor(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return /^#[0-9a-fA-F]{6}$/u.test(trimmed) ? trimmed : undefined;
}

/**
 * Whether an instance's icon carries the account badge: accent color set, or
 * several instances sharing a provider so the brand glyph alone is ambiguous.
 * Shared by the composer trigger, the picker rail, and sidebar/thread rows.
 */
export function shouldShowInstanceBadge(
  entry: {
    readonly driverKind: ProviderDriverKind;
    readonly accentColor?: string | undefined;
  },
  entries: Iterable<{
    readonly driverKind: ProviderDriverKind;
  }>,
): boolean {
  if (entry.accentColor) return true;
  let sharedProviderCount = 0;
  for (const candidate of entries) {
    if (candidate.driverKind !== entry.driverKind) continue;
    if (++sharedProviderCount > 1) return true;
  }
  return false;
}

/**
 * Marks for instances that share a driver and have no accent color of their
 * own. Mid-tone hues that read on light and dark surfaces and stay clear of
 * each other at dot size.
 */
export const PROVIDER_INSTANCE_AUTO_ACCENT_COLORS = [
  "#3b82f6",
  "#10b981",
  "#a855f7",
  "#f43f5e",
  "#f59e0b",
  "#06b6d4",
] as const;

interface AccentColorInstance {
  readonly instanceId: string;
  readonly driver: ProviderDriverKind;
  readonly accentColor?: string | undefined;
}

/** A driver's instances in mark order: the default instance first, then the rest as given. */
function instancesByDriverInMarkOrder<T extends AccentColorInstance>(
  instances: ReadonlyArray<T>,
): ReadonlyMap<ProviderDriverKind, ReadonlyArray<T>> {
  const byDriver = new Map<ProviderDriverKind, T[]>();
  for (const instance of instances) {
    const bucket = byDriver.get(instance.driver);
    if (bucket) bucket.push(instance);
    else byDriver.set(instance.driver, [instance]);
  }
  for (const [driver, bucket] of byDriver) {
    const defaultId = defaultInstanceIdForDriver(driver);
    byDriver.set(driver, [
      ...bucket.filter((instance) => instance.instanceId === defaultId),
      ...bucket.filter((instance) => instance.instanceId !== defaultId),
    ]);
  }
  return byDriver;
}

/**
 * The accent color each instance shows, keyed by instance id. An explicit,
 * valid `accentColor` always wins. Instances that share their driver with
 * another instance and have none get a palette color by position (default
 * instance first, then settings order), so colors stay put across renders and
 * the instances of one provider never look alike. A lone instance without an
 * accent color is left out: it needs no mark.
 */
export function resolveProviderInstanceAccentColors(
  instances: ReadonlyArray<AccentColorInstance>,
): ReadonlyMap<string, string> {
  const colors = new Map<string, string>();
  for (const bucket of instancesByDriverInMarkOrder(instances).values()) {
    bucket.forEach((instance, index) => {
      const explicit = normalizeProviderAccentColor(instance.accentColor);
      const color =
        explicit ??
        (bucket.length > 1
          ? PROVIDER_INSTANCE_AUTO_ACCENT_COLORS[
              index % PROVIDER_INSTANCE_AUTO_ACCENT_COLORS.length
            ]
          : undefined);
      if (color) colors.set(instance.instanceId, color);
    });
  }
  return colors;
}

/**
 * The color a new instance of `driver` would be given automatically, so the
 * add-instance flow can preselect it: its palette slot once it joins its
 * siblings, or the first palette color none of them shows when that slot is taken.
 */
export function nextProviderInstanceAccentColor(
  instances: ReadonlyArray<AccentColorInstance>,
  driver: ProviderDriverKind,
): string {
  const newInstanceId = "\u0000new";
  const colors = new Map(
    resolveProviderInstanceAccentColors([
      ...instances.filter((instance) => instance.driver === driver),
      { instanceId: newInstanceId, driver },
    ]),
  );
  const slot = colors.get(newInstanceId)!;
  colors.delete(newInstanceId);
  const used = new Set([...colors.values()].map((color) => color.toLowerCase()));
  if (!used.has(slot)) return slot;
  return PROVIDER_INSTANCE_AUTO_ACCENT_COLORS.find((color) => !used.has(color)) ?? slot;
}

/**
 * The part of an instance name that tells it apart from its provider:
 * "Claude (Personal)" gives "Personal", "Codex Work" gives "Work". A name that
 * is just the provider's gives null; an unrelated name is returned whole.
 */
export function providerInstanceQualifier(displayName: string, driverLabel: string): string | null {
  const name = displayName.trim();
  const parenthetical = /\(([^()]+)\)\s*$/u.exec(name)?.[1]?.trim();
  if (parenthetical) return parenthetical;
  if (name.toLowerCase() === driverLabel.trim().toLowerCase()) return null;
  if (name.toLowerCase().startsWith(`${driverLabel.trim().toLowerCase()} `)) {
    const rest = name
      .slice(driverLabel.trim().length)
      .replace(/^[\s·:–—-]+/u, "")
      .trim();
    if (rest) return rest;
  }
  return name || null;
}

/**
 * How a model row names its instance: the provider alone, or "Claude · Personal"
 * when the provider has several instances.
 */
export function providerInstanceRowLabel(input: {
  readonly displayName: string;
  readonly driverLabel: string;
  readonly sharesDriver: boolean;
}): string {
  if (!input.sharesDriver) return input.displayName;
  const qualifier = providerInstanceQualifier(input.displayName, input.driverLabel);
  return qualifier ? `${input.driverLabel} · ${qualifier}` : input.driverLabel;
}
