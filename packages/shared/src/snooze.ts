/**
 * When a snoozed thread wakes: the menu presets, typed phrases such as
 * "tmrw" or "next mon 10am", and ISO times, resolved against one wall clock.
 * The web menu, the command palette and the agent's thread_snooze tool all
 * resolve through here, so "Tomorrow" means the same instant everywhere.
 *
 * Every calendar step happens in a named zone: clients pass their local zone,
 * the server passes its configured one. Days advance by calendar day, never
 * by 24 hours, so DST transitions keep the wall time.
 */
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

/** Preset keys, in menu order. */
export const SNOOZE_PRESET_KEYS = [
  "in_1h",
  "in_3h",
  "this_evening",
  "tomorrow",
  "next_week",
] as const;
export type SnoozePresetKey = (typeof SNOOZE_PRESET_KEYS)[number];

/** The instant to resolve from and the IANA zone its calendar is read in. */
export interface SnoozeClock {
  readonly nowMs: number;
  readonly timeZone: string;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const EVENING_HOUR = 18;
const MORNING_HOUR = 9;

/** The zone this process runs in, for clients resolving in local time. */
export function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function zonedNow(clock: SnoozeClock): DateTime.Zoned {
  const zone = Option.getOrElse(DateTime.zoneMakeNamed(clock.timeZone), () =>
    DateTime.zoneMakeNamedUnsafe("UTC"),
  );
  return DateTime.makeZonedUnsafe(clock.nowMs, { timeZone: zone });
}

/** `days` calendar days after `base`, at `hour:minute` local time. */
function atLocal(base: DateTime.Zoned, days: number, hour: number, minute = 0): number {
  const day = days === 0 ? base : DateTime.add(base, { days });
  return DateTime.toEpochMillis(
    DateTime.setParts(day, { hour, minute, second: 0, millisecond: 0 }),
  );
}

/** Days from today to the next `weekDay` (0 = Sunday), 1 to 7: never today. */
function daysUntilWeekday(base: DateTime.Zoned, weekDay: number): number {
  return (weekDay - DateTime.toParts(base).weekDay + 7) % 7 || 7;
}

export interface SnoozePresetTime {
  readonly key: SnoozePresetKey;
  readonly atMs: number;
}

/**
 * The menu's choices. "This evening" is offered only while 6 PM is more than
 * an hour away; after that the calendar choices start at "Tomorrow". On
 * Sundays "Tomorrow" and "Next week" are both Monday morning, so only
 * "Tomorrow" is offered.
 */
export function snoozePresetTimes(clock: SnoozeClock): ReadonlyArray<SnoozePresetTime> {
  const now = zonedNow(clock);
  const presets: SnoozePresetTime[] = [
    { key: "in_1h", atMs: clock.nowMs + HOUR_MS },
    { key: "in_3h", atMs: clock.nowMs + 3 * HOUR_MS },
  ];
  const evening = atLocal(now, 0, EVENING_HOUR);
  if (evening - clock.nowMs > HOUR_MS) presets.push({ key: "this_evening", atMs: evening });
  const tomorrow = atLocal(now, 1, MORNING_HOUR);
  presets.push({ key: "tomorrow", atMs: tomorrow });
  const nextWeek = atLocal(now, daysUntilWeekday(now, 1), MORNING_HOUR);
  if (nextWeek !== tomorrow) presets.push({ key: "next_week", atMs: nextWeek });
  return presets;
}

/**
 * One preset's wake time, or null when the menu would not offer it ("This
 * evening" late in the day). "Next week" is next Monday morning even on a
 * Sunday, where the menu folds it into "Tomorrow".
 */
export function resolveSnoozePreset(key: SnoozePresetKey, clock: SnoozeClock): number | null {
  if (key === "next_week") {
    const now = zonedNow(clock);
    return atLocal(now, daysUntilWeekday(now, 1), MORNING_HOUR);
  }
  return snoozePresetTimes(clock).find((preset) => preset.key === key)?.atMs ?? null;
}

// ---------------------------------------------------------------------------
// Typed phrases
// ---------------------------------------------------------------------------

const WEEKDAYS: Readonly<Record<string, number>> = {
  sun: 0,
  sunday: 0,
  mon: 1,
  monday: 1,
  tue: 2,
  tues: 2,
  tuesday: 2,
  wed: 3,
  weds: 3,
  wednesday: 3,
  thu: 4,
  thur: 4,
  thurs: 4,
  thursday: 4,
  fri: 5,
  friday: 5,
  sat: 6,
  saturday: 6,
};

const MONTHS: Readonly<Record<string, number>> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

const TOMORROW = new Set(["tomorrow", "tmrw", "tmr", "tmrow", "tomorow", "tommorow", "tommorrow"]);
const EVENING = new Set(["tonight", "this evening", "evening", "this_evening"]);

const NUMBER_WORDS: Readonly<Record<string, number>> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  couple: 2,
  "a couple": 2,
  "a couple of": 2,
  few: 3,
  "a few": 3,
};

const UNIT_PATTERN = "m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|wk|wks|week|weeks";
// Digits may touch their unit ("3h"); words may not, so "am" is never "a minute".
const DURATION = new RegExp(
  `^(?:in |for )?(?:(\\d+(?:\\.\\d+)?) ?|(${Object.keys(NUMBER_WORDS)
    .sort((a, b) => b.length - a.length)
    .join("|")}) )(${UNIT_PATTERN})(?: from now)?$`,
);

function durationTime(amount: number, unit: string, now: DateTime.Zoned, nowMs: number) {
  if (!(amount > 0)) return null;
  if (unit.startsWith("m")) return nowMs + amount * MINUTE_MS;
  if (unit.startsWith("h")) return nowMs + amount * HOUR_MS;
  const days = unit.startsWith("w") ? amount * 7 : amount;
  // Whole days step the calendar so "in 2 days" keeps the time of day across DST.
  return Number.isInteger(days)
    ? DateTime.toEpochMillis(DateTime.add(now, { days }))
    : nowMs + days * 24 * HOUR_MS;
}

interface TimeOfDay {
  readonly hour: number;
  readonly minute: number;
  /** Midnight belongs to the end of the named day. */
  readonly nextDay?: true;
}

const NAMED_TIMES: Readonly<Record<string, TimeOfDay>> = {
  morning: { hour: MORNING_HOUR, minute: 0 },
  noon: { hour: 12, minute: 0 },
  midday: { hour: 12, minute: 0 },
  afternoon: { hour: 14, minute: 0 },
  evening: { hour: EVENING_HOUR, minute: 0 },
  night: { hour: EVENING_HOUR, minute: 0 },
  midnight: { hour: 0, minute: 0, nextDay: true },
};

/**
 * "2pm", "2:30 pm", "14:00", "noon". A bare hour ("at 5", "mon 10") reads as
 * working hours: 1 to 6 are afternoon, 7 to 12 morning or noon.
 */
function parseTime(text: string): TimeOfDay | null {
  const named = NAMED_TIMES[text.replace(/^(?:in the|this|at)\s+/, "")];
  if (named) return named;
  const match = /^(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm|a|p|a\.m\.|p\.m\.)?$/.exec(text);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = match[2] === undefined ? 0 : Number(match[2]);
  if (minute > 59) return null;
  const meridiem = match[3]?.[0];
  if (meridiem !== undefined) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (meridiem === "p" ? 12 : 0);
  } else if (match[2] === undefined) {
    if (hour < 1 || hour > 23) return null;
    if (hour <= 6) hour += 12;
  } else if (hour > 23) {
    return null;
  }
  return { hour, minute };
}

type DayRef =
  | { readonly kind: "offset"; readonly days: number; readonly today?: true }
  | { readonly kind: "date"; readonly year?: number; readonly month: number; readonly day: number };

function parseDay(text: string, now: DateTime.Zoned): DayRef | null {
  if (text === "today") return { kind: "offset", days: 0, today: true };
  if (TOMORROW.has(text)) return { kind: "offset", days: 1 };
  const weekday = /^(?:(?:this|next|on|coming|this coming)\s+)?([a-z]+)$/.exec(text);
  if (weekday?.[1] !== undefined && WEEKDAYS[weekday[1]] !== undefined) {
    return { kind: "offset", days: daysUntilWeekday(now, WEEKDAYS[weekday[1]]!) };
  }
  if (/^(?:this |the )?weekend$/.test(text)) {
    return { kind: "offset", days: daysUntilWeekday(now, 6) };
  }
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (iso)
    return { kind: "date", year: Number(iso[1]), month: Number(iso[2]), day: Number(iso[3]) };
  const monthFirst = /^(?:on\s+)?([a-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?$/.exec(
    text,
  );
  const dayFirst =
    /^(?:on\s+)?(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?([a-z]+)\.?(?:,?\s+(\d{4}))?$/.exec(
      text,
    );
  const [monthName, dayText, yearText] = monthFirst
    ? [monthFirst[1], monthFirst[2], monthFirst[3]]
    : dayFirst
      ? [dayFirst[2], dayFirst[1], dayFirst[3]]
      : [];
  const month = monthName === undefined ? undefined : MONTHS[monthName];
  if (month === undefined || dayText === undefined) return null;
  return {
    kind: "date",
    month,
    day: Number(dayText),
    ...(yearText === undefined ? {} : { year: Number(yearText) }),
  };
}

function dayAt(ref: DayRef, time: TimeOfDay, now: DateTime.Zoned, nowMs: number): number | null {
  const extra = time.nextDay ? 1 : 0;
  if (ref.kind === "offset") return atLocal(now, ref.days + extra, time.hour, time.minute);
  const parts = DateTime.toParts(now);
  const candidate = (year: number) => {
    const date = DateTime.setParts(now, {
      year,
      month: ref.month,
      day: ref.day,
      hour: 12,
      minute: 0,
      second: 0,
      millisecond: 0,
    });
    // Feb 30 rolls into March; reject it rather than guess.
    const set = DateTime.toParts(date);
    if (set.month !== ref.month || set.day !== ref.day) return null;
    return atLocal(date, extra, time.hour, time.minute);
  };
  if (ref.year !== undefined) return candidate(ref.year);
  // A date without a year is its next occurrence.
  const thisYear = candidate(parts.year);
  return thisYear !== null && thisYear > nowMs ? thisYear : candidate(parts.year + 1);
}

/** Splits "friday at 2pm", "2pm friday" and "next mon 10am" into a day and a time. */
function parseDayAndTime(text: string, now: DateTime.Zoned, nowMs: number): number | null {
  const words = text.split(" ");
  for (let split = 1; split < words.length; split += 1) {
    const head = words.slice(0, split).join(" ");
    const tail = words.slice(split).join(" ");
    for (const [dayText, timeText] of [
      [head, tail.replace(/^at\s+/, "")],
      [tail.replace(/^on\s+/, ""), head],
    ] as const) {
      const day = parseDay(dayText, now);
      const time = day === null ? null : parseTime(timeText);
      if (day !== null && time !== null) return dayAt(day, time, now, nowMs);
    }
  }
  return null;
}

function normalizePhrase(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[!?]+$/, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(?:snooze\s+)?(?:(?:this|it)\s+)?(?:until|till|til|to)\s+/, "")
    .replace(/,/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * A typed wake time, or null when the phrase is not understood or already
 * past. Understands presets ("tomorrow", "tmrw", "this evening", "next
 * week"), durations ("in 2 days", "3h", "for 30 minutes"), days with an
 * optional time ("friday", "next mon 10am", "tomorrow at 2pm", "oct 24 3pm",
 * "2026-11-02"), and times alone ("5pm", "noon", which roll to tomorrow once
 * past). A weekday means its next occurrence after today; a day without a
 * time means 9 AM.
 */
export function parseSnoozePhrase(text: string, clock: SnoozeClock): number | null {
  const phrase = normalizePhrase(text);
  if (phrase.length === 0) return null;
  const now = zonedNow(clock);
  const future = (atMs: number | null) => (atMs !== null && atMs > clock.nowMs ? atMs : null);

  if ((SNOOZE_PRESET_KEYS as ReadonlyArray<string>).includes(phrase))
    return resolveSnoozePreset(phrase as SnoozePresetKey, clock);
  if (EVENING.has(phrase)) return resolveSnoozePreset("this_evening", clock);
  if (phrase === "next week") return resolveSnoozePreset("next_week", clock);
  if (/^(?:in )?half an? hour$/.test(phrase)) return clock.nowMs + 30 * MINUTE_MS;

  const duration = DURATION.exec(phrase);
  if (duration?.[3] !== undefined) {
    const amount =
      duration[1] === undefined ? (NUMBER_WORDS[duration[2] ?? ""] ?? 0) : Number(duration[1]);
    return future(durationTime(amount, duration[3], now, clock.nowMs));
  }

  const day = parseDay(phrase, now);
  if (day !== null) {
    return day.kind === "offset" && day.today
      ? null
      : future(dayAt(day, { hour: MORNING_HOUR, minute: 0 }, now, clock.nowMs));
  }

  // "tonight at 8", "this evening 7pm" and "tomorrow night" name a day and a time.
  const evening = /^(?:tonight|this evening)(?: at)? (.+)$/.exec(phrase);
  if (evening?.[1] !== undefined) {
    const time = parseTime(evening[1]);
    // In the evening "8" is 8 PM.
    const hour = time !== null && time.hour < 12 && !time.nextDay ? time.hour + 12 : time?.hour;
    return time === null || hour === undefined ? null : future(atLocal(now, 0, hour, time.minute));
  }

  const time = parseTime(phrase);
  if (time !== null) {
    const today = atLocal(now, time.nextDay ? 1 : 0, time.hour, time.minute);
    return today > clock.nowMs ? today : atLocal(now, time.nextDay ? 2 : 1, time.hour, time.minute);
  }

  return future(parseDayAndTime(phrase, now, clock.nowMs));
}

// ---------------------------------------------------------------------------
// Any accepted form
// ---------------------------------------------------------------------------

export type SnoozeUntilResolution =
  | { readonly ok: true; readonly atMs: number }
  | { readonly ok: false; readonly message: string };

const ISO_WITH_OFFSET =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/i;
const ISO_LOCAL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

/**
 * Resolves what an agent or a person passed as "until": a preset key, an ISO
 * time (without an offset it is wall time in the clock's zone), or a typed
 * phrase. The result is always in the future.
 */
export function resolveSnoozeUntil(until: string, clock: SnoozeClock): SnoozeUntilResolution {
  const text = until.trim();
  let atMs: number | null;
  if (ISO_WITH_OFFSET.test(text)) {
    atMs = Option.match(DateTime.make(text), {
      onNone: () => null,
      onSome: DateTime.toEpochMillis,
    });
  } else {
    const local = ISO_LOCAL.exec(text);
    atMs = local
      ? Option.match(
          DateTime.makeZoned(
            {
              year: Number(local[1]),
              month: Number(local[2]),
              day: Number(local[3]),
              hour: Number(local[4]),
              minute: Number(local[5]),
              second: Number(local[6] ?? 0),
            },
            { timeZone: zonedNow(clock).zone, adjustForTimeZone: true },
          ),
          { onNone: () => null, onSome: DateTime.toEpochMillis },
        )
      : parseSnoozePhrase(text, clock);
    if (local === null && atMs === null) {
      if (EVENING.has(normalizePhrase(text))) {
        return { ok: false, message: "This evening is under an hour away or past." };
      }
      return {
        ok: false,
        message: `Could not read "${text}" as a time. Use a preset (${SNOOZE_PRESET_KEYS.join(", ")}), an ISO time, or a phrase like "friday 2pm" or "in 2 days".`,
      };
    }
  }
  if (atMs === null || !Number.isFinite(atMs)) {
    return { ok: false, message: `"${text}" is not a valid time.` };
  }
  if (atMs <= clock.nowMs) return { ok: false, message: `${text} is not in the future.` };
  return { ok: true, atMs };
}

/**
 * A wake time as people say it, stable as the day moves on: "Fri 9:00 AM"
 * within the coming week, "Mon, Nov 2, 9:00 AM" beyond it or once past.
 */
export function formatSnoozeTime(
  atMs: number,
  clock: SnoozeClock,
  options?: { readonly locale?: string | undefined; readonly hour12?: boolean | undefined },
): string {
  const now = zonedNow(clock);
  const wake = DateTime.makeZonedUnsafe(atMs, { timeZone: now.zone });
  const startOfToday = DateTime.toEpochMillis(DateTime.startOf(now, "day"));
  const weekOut = DateTime.toEpochMillis(DateTime.add(DateTime.startOf(now, "day"), { days: 7 }));
  const soon = atMs >= startOfToday && atMs < weekOut;
  const hourOptions = options?.hour12 === undefined ? {} : { hour12: options.hour12 };
  const time = DateTime.format(wake, {
    locale: options?.locale,
    hour: "numeric",
    minute: "2-digit",
    ...hourOptions,
  });
  const date = DateTime.format(wake, {
    locale: options?.locale,
    weekday: "short",
    ...(soon ? {} : { month: "short", day: "numeric" }),
    ...(DateTime.toParts(wake).year === DateTime.toParts(now).year ? {} : { year: "numeric" }),
  });
  return soon ? `${date} ${time}` : `${date}, ${time}`;
}
