/**
 * ServerTimeZone - The wall-clock zone fixed-time schedules run in.
 *
 * A VPS usually runs on UTC while its owner thinks in their local zone, so
 * "daily at 02:00" needs a defined zone. `COGENLY_TZ` names it; without that
 * the host's local zone is used.
 *
 * @module ServerTimeZone
 */

/** IANA name of the host's local zone, e.g. "America/New_York". */
export const systemLocalTimeZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** True when `Intl` accepts the name, which is what the scheduler needs. */
export const isValidTimeZone = (zone: string): boolean => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
};

/** Trims a configured value; blank and missing both mean "use the default". */
export const normalizeTimeZoneSetting = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};
