/**
 * The line above the composer on a new chat. It depends only on the local
 * date and time-of-day bucket, so it holds still while the user types or the
 * component re-renders, and changes only when the day or the bucket does.
 */

export type GreetingBucket = "morning" | "afternoon" | "evening" | "lateNight";

export function greetingBucket(now: Date): GreetingBucket {
  const hour = now.getHours();
  if (hour >= 5 && hour < 12) return "morning";
  if (hour >= 12 && hour < 17) return "afternoon";
  if (hour >= 17 && hour < 22) return "evening";
  return "lateNight";
}

// `{, name}` becomes ", Alex" when the user's first name is known and nothing otherwise.
const NAME_SLOT = "{, name}";

const BY_BUCKET: Record<GreetingBucket, ReadonlyArray<string>> = {
  morning: [
    `Good morning${NAME_SLOT}`,
    `Morning${NAME_SLOT}. What are we starting with?`,
    "Fresh day. What's first?",
    `Coffee in hand${NAME_SLOT}? What's on your mind?`,
    "Up early. What shall we figure out?",
    "What's the first thing today?",
  ],
  afternoon: [
    `Good afternoon${NAME_SLOT}`,
    `Afternoon${NAME_SLOT}. What are we working through?`,
    "Halfway through the day. What's up?",
    "What can I help you think through?",
    `How's the day going${NAME_SLOT}?`,
    "Got a question brewing?",
  ],
  evening: [
    `Good evening${NAME_SLOT}`,
    `Evening${NAME_SLOT}. What's on your mind?`,
    "Winding down, or just getting started?",
    "What are we getting into tonight?",
    "Anything left on your mind today?",
    "Settle in. What's up?",
  ],
  lateNight: [
    `Still up${NAME_SLOT}?`,
    "Late night thinking. What is it?",
    "The quiet hours. What's on your mind?",
    `Burning the midnight oil${NAME_SLOT}?`,
    "Can't sleep, or can't stop thinking?",
  ],
};

const BY_WEEKDAY: Partial<Record<number, ReadonlyArray<string>>> = {
  // Date#getDay: 0 is Sunday.
  1: [`Happy Monday${NAME_SLOT}. Where do we start?`, "New week. What's the plan?"],
  5: [`Happy Friday${NAME_SLOT}`, "Friday. What are we wrapping up?"],
  6: [`Happy Saturday${NAME_SLOT}`, "Weekend project, or just curious?"],
  0: [`Happy Sunday${NAME_SLOT}`, "A slow Sunday. What's on your mind?"],
};

/** `"month-day"` (1-based month) to the line shown all day. */
const SPECIAL_DATES: Readonly<Record<string, string>> = {
  "1-1": `Happy New Year${NAME_SLOT}`,
  "2-14": `Happy Valentine's Day${NAME_SLOT}`,
  "10-31": `Happy Halloween${NAME_SLOT}`,
  "12-24": `Happy holidays${NAME_SLOT}`,
  "12-25": `Merry Christmas${NAME_SLOT}`,
  "12-31": `Last day of the year${NAME_SLOT}. What's on your mind?`,
};

/** A small stable string hash (FNV-1a), so the same day and bucket always pick the same line. */
function hash(value: string): number {
  let result = 2166136261;
  for (const char of value) {
    result ^= char.charCodeAt(0);
    result = Math.imul(result, 16777619) >>> 0;
  }
  return result;
}

function fillName(line: string, firstName: string | null | undefined): string {
  const name = firstName?.trim();
  return line.replace(NAME_SLOT, name ? `, ${name}` : "");
}

export function chatGreeting(now: Date, firstName?: string | null): string {
  const special = SPECIAL_DATES[`${now.getMonth() + 1}-${now.getDate()}`];
  if (special) return fillName(special, firstName);
  const bucket = greetingBucket(now);
  const candidates = [...BY_BUCKET[bucket], ...(BY_WEEKDAY[now.getDay()] ?? [])];
  const day = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
  const line = candidates[hash(`${day}:${bucket}`) % candidates.length]!;
  return fillName(line, firstName);
}
